// Inline stdio ACP proxy: relays NDJSON between the worker (this process's
// stdin/stdout) and a spawned adapter, byte for byte, except for the proxy hello
// on the initialize result and the frames interpreters and leases emit.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { constants } from "node:os";
import { KeyGenerator, buildFrame, idKey, injectHello, isAnchored, isObject } from "./envelope.js";
import { LeaseManager } from "./leases.js";
import { LineSplitter, splitDelimiter } from "./lines.js";
import { TRACE_ENV, openTrace, type Trace } from "./trace.js";
import type { Emission, ProxyOptions } from "./types.js";
import { FrameWriter } from "./writer.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const DEFAULT_KILL_GRACE_MS = 5000;
const HIGH_WATER_BYTES = 1024 * 1024;

/** Pauses a source while its sink holds too many queued bytes. */
function applyBackpressure(source: Readable, sink: FrameWriter, alive: () => boolean): void {
  if (sink.pending <= HIGH_WATER_BYTES || source.isPaused()) {
    return;
  }
  source.pause();
  void sink.flush().then(() => {
    if (alive()) {
      source.resume();
    }
  });
}

function parse(line: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(splitDelimiter(line).body.toString("utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export class Proxy {
  readonly leases = new LeaseManager((emission) => this.emit(emission));

  private readonly opts: ProxyOptions;
  private readonly keys = new KeyGenerator();
  private readonly pendingInitialize = new Set<string>();
  private readonly input;
  private readonly output;
  private adapterCount = 0;
  private sealed = false;
  private failure: Error | null = null;
  private outWriter: FrameWriter | null = null;
  private fail: (err: Error) => void = () => undefined;

  constructor(opts: ProxyOptions) {
    this.opts = opts;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
  }

  /**
   * Queues a proxy-emitted `session/update`, anchored to the adapter frames
   * queued so far. Safe to call from any async source.
   */
  emit(emission: Emission): void {
    const frame = buildFrame(emission, this.keys.next(), this.adapterCount);
    this.writeToWorker(frame);
  }

  /** Runs until the adapter exits. Resolves with its exit status once all output is flushed. */
  run(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const tracePath = this.opts.tracePath ?? process.env[TRACE_ENV];
      let trace: Trace | null = null;
      try {
        trace = tracePath ? openTrace(tracePath) : null;
      } catch (err) {
        reject(err);
        return;
      }
      let child: ChildProcessByStdio<Writable, Readable, null>;
      try {
        child = spawn(this.opts.command, this.opts.args ?? [], {
          stdio: ["pipe", "pipe", "inherit"],
          env: this.opts.env,
          cwd: this.opts.cwd,
          shell: false,
        });
      } catch (err) {
        trace?.close();
        this.leases.dispose();
        reject(err);
        return;
      }
      const outWriter = new FrameWriter(this.output, trace ? (buf) => trace.agent(buf) : undefined);
      const childWriter = new FrameWriter(child.stdin, trace ? (buf) => trace.client(buf) : undefined);
      this.outWriter = outWriter;

      let childExited = false;
      let signaled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const signalHandlers = SIGNALS.map((sig) => {
        const handler = () => {
          if (signaled) {
            return;
          }
          signaled = true;
          child.kill(sig);
          killTimer = setTimeout(() => child.kill("SIGKILL"), this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        };
        process.on(sig, handler);
        return [sig, handler] as const;
      });

      // The trace closes only after both writers have drained, since their queued
      // buffers still write to it.
      const cleanup = async () => {
        try {
          for (const [sig, handler] of signalHandlers) {
            process.off(sig, handler);
          }
          if (killTimer) {
            clearTimeout(killTimer);
          }
          this.input.off("data", onClientData);
          this.input.off("end", onClientEnd);
          this.input.pause();
        } finally {
          try {
            await Promise.allSettled([outWriter.flush(), childWriter.flush()]);
          } finally {
            trace?.close();
          }
        }
      };
      // The single end path: leases are disposed and run() always settles.
      const finish = async (outcome: { code: number } | { err: Error }) => {
        settled = true;
        this.leases.dispose();
        let result = outcome;
        try {
          await cleanup();
        } catch (err) {
          if ("code" in result) {
            result = { err: err instanceof Error ? err : new Error(String(err)) };
          }
        }
        if ("err" in result) {
          reject(result.err);
        } else {
          resolve(result.code);
        }
      };
      this.fail = (err) => {
        if (settled) {
          return;
        }
        this.failure = err;
        child.kill("SIGKILL");
        void finish({ err });
      };

      const toChild = (buf: Buffer) => {
        childWriter.write(buf).catch((err: NodeJS.ErrnoException) => {
          // EPIPE: the adapter closed its stdin or died; its exit is handled on close.
          if (!childExited && err.code !== "EPIPE") {
            this.fail(err);
          }
        });
      };

      const clientSplitter = new LineSplitter();
      const onClientData = (chunk: Buffer) => {
        for (const line of clientSplitter.push(chunk)) {
          this.trackInitialize(line);
          toChild(line);
        }
        applyBackpressure(this.input, childWriter, () => !settled);
      };
      const onClientEnd = () => {
        const rest = clientSplitter.end();
        if (rest) {
          toChild(rest);
        }
        childWriter.end().catch(() => undefined);
      };
      this.input.on("data", onClientData);
      this.input.on("end", onClientEnd);

      const agentSplitter = new LineSplitter();
      child.stdout.on("data", (chunk: Buffer) => {
        for (const line of agentSplitter.push(chunk)) {
          this.agentLine(line);
        }
        applyBackpressure(child.stdout, outWriter, () => !settled);
      });
      child.stdout.on("end", () => {
        const rest = agentSplitter.end();
        if (rest) {
          // Not a complete frame: forward it untouched and emit nothing after it.
          this.writeToWorker(rest);
          this.sealed = true;
        }
      });

      child.on("error", (err) => this.fail(err));
      child.on("close", (code, signal) => {
        childExited = true;
        if (settled) {
          return;
        }
        this.leases.dispose();
        outWriter
          .close()
          .then(() => {
            if (!settled) {
              void finish({ code: code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0) });
            }
          })
          .catch((err: Error) => this.fail(err));
      });
    });
  }

  private writeToWorker(buf: Buffer): void {
    if (!this.outWriter) {
      throw new Error("proxy is not running");
    }
    if (this.sealed || this.failure) {
      return;
    }
    this.outWriter.write(buf).catch((err: Error) => this.fail(err));
  }

  private trackInitialize(line: Buffer): void {
    const value = parse(line);
    const key = value && value.method === "initialize" ? idKey(value.id) : null;
    if (key) {
      this.pendingInitialize.add(key);
    }
  }

  private agentLine(line: Buffer): void {
    const value = parse(line);
    let out = line;
    if (value) {
      if (value.method === "session/update") {
        if (!isAnchored(value)) {
          this.adapterCount += 1;
        }
      } else if (!("method" in value)) {
        const key = idKey(value.id);
        if (key && this.pendingInitialize.delete(key) && isObject(value.result) && !("error" in value)) {
          out = injectHello(line, this.opts.pluginId);
        }
      }
    }
    this.writeToWorker(out);
    if (!value) {
      return;
    }
    const raw = Buffer.from(splitDelimiter(line).body);
    try {
      for (const interpret of this.opts.interpreters ?? []) {
        for (const emission of interpret({ value, raw })) {
          this.emit(emission);
        }
      }
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export function createProxy(opts: ProxyOptions): Proxy {
  return new Proxy(opts);
}
