// Inline stdio ACP proxy: relays NDJSON between the worker (this process's
// stdin/stdout) and a spawned adapter, byte for byte, except for the proxy hello
// on the initialize result and the frames interpreters and leases emit.

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { KeyGenerator, buildFrame, idKey, injectHello, isAnchored, isObject } from "./envelope.js";
import { LeaseManager } from "./leases.js";
import { LineSplitter, splitDelimiter } from "./lines.js";
import { TRACE_ENV, openTrace, type Trace } from "./trace.js";
import type { Emission, ProxyOptions } from "./types.js";
import { FrameWriter } from "./writer.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const DEFAULT_KILL_GRACE_MS = 5000;

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
      const child = spawn(this.opts.command, this.opts.args ?? [], {
        stdio: ["pipe", "pipe", "inherit"],
        env: this.opts.env,
        cwd: this.opts.cwd,
        shell: false,
      });
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

      const cleanup = () => {
        for (const [sig, handler] of signalHandlers) {
          process.off(sig, handler);
        }
        if (killTimer) {
          clearTimeout(killTimer);
        }
        this.input.off("data", onClientData);
        this.input.off("end", onClientEnd);
        this.input.pause();
        trace?.close();
      };
      this.fail = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        this.failure = err;
        child.kill("SIGKILL");
        cleanup();
        reject(err);
      };

      const toChild = (buf: Buffer) => {
        childWriter.write(buf).catch((err: Error) => {
          if (!childExited) {
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
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
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
    if (!line.includes("initialize")) {
      return;
    }
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
