import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createProxy } from "../../src/proxy-sdk/index";
import { ADAPTER, start, isolatingSigterm, tempDir, until } from "./harness";

describe("child lifecycle", () => {
  it("ends the child's stdin on client EOF and exits with its status", async () => {
    const h = start(["eof"]);
    h.input.end();
    expect(await h.done).toBe(3);
    expect(h.lines()).toEqual(['{"eof":true}']);
  });

  it("forwards a signal once and exits with the child's status", async () => {
    await isolatingSigterm(async () => {
      const h = start(["term"]);
      await until(() => h.lines().length === 1);
      process.emit("SIGTERM");
      process.emit("SIGTERM");
      expect(await h.done).toBe(5);
      expect(h.lines()).toEqual(['{"ready":true}', '{"term":1}']);
    });
  });

  it("escalates to SIGKILL after the grace period", async () => {
    await isolatingSigterm(async () => {
      const h = start(["ignore-term"], { killGraceMs: 100 });
      await until(() => h.lines().length === 1);
      process.emit("SIGTERM");
      expect(await h.done).toBe(137);
    });
  });

  it("rejects when the command cannot be spawned", async () => {
    const proxy = createProxy({ pluginId: "p", command: "/nonexistent/adapter", input: new (await import("node:stream")).PassThrough() });
    await expect(proxy.run()).rejects.toThrow(/ENOENT/);
  });

  it("fails closed when the trace cannot be written", async () => {
    const proxy = createProxy({
      pluginId: "p",
      command: process.execPath,
      args: [ADAPTER, "echo"],
      tracePath: join(tempDir(), "missing", "trace"),
      input: new (await import("node:stream")).PassThrough(),
    });
    await expect(proxy.run()).rejects.toThrow(/ENOENT/);
  });

  it("writes trace files with mode 0600", async () => {
    const trace = join(tempDir(), "trace");
    const h = start(["eof"], { tracePath: trace });
    h.input.write('{"a":1}\n');
    h.input.end();
    await h.done;
    expect(statSync(trace).mode & 0o777).toBe(0o600);
    expect(statSync(`${trace}.client`).mode & 0o777).toBe(0o600);
  });

  it("releases leases when the child exits", async () => {
    const h = start(["eof"]);
    h.proxy.leases.acquire({ sessionId: "s", kind: "busy", ttlMs: 60000 });
    h.input.end();
    await h.done;
    const ops = h.frames().flatMap((f) => {
      const lease = (f as { params?: { update?: { _meta?: { aoe?: { lease?: { op: string } } } } } }).params?.update?._meta?.aoe?.lease;
      return lease ? [lease.op] : [];
    });
    expect(ops).toEqual(["acquire", "release"]);
  });

  it("disposes leases and rejects acquire after a failure", async () => {
    const file = join(tempDir(), "out.ndjson");
    writeFileSync(file, '{"jsonrpc":"2.0","method":"x"}\n');
    const boom = () => {
      throw new Error("boom");
    };
    const h = start(["emit", file, "0"], { interpreters: [boom] });
    const emit = vi.spyOn(h.proxy, "emit");
    h.proxy.leases.acquire({ sessionId: "s", kind: "busy", ttlMs: 20 });
    h.input.end();
    await expect(h.done).rejects.toThrow(/boom/);
    const calls = emit.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(emit.mock.calls.length).toBe(calls);
    expect(() => h.proxy.leases.acquire({ sessionId: "s", kind: "busy", ttlMs: 1000 })).toThrow(/closed/);
  });

  it("rejects acquire after run() has resolved", async () => {
    const h = start(["eof"]);
    h.input.end();
    await h.done;
    expect(() => h.proxy.leases.acquire({ sessionId: "s", kind: "busy", ttlMs: 1000 })).toThrow(/closed/);
  });

  it("keeps the trace open until queued writes drain after a failure", async () => {
    const dir = tempDir();
    const file = join(dir, "out.ndjson");
    const frames = Array.from({ length: 30 }, (_, i) => JSON.stringify({ jsonrpc: "2.0", method: "x", params: { i, pad: "a".repeat(2000) } }));
    writeFileSync(file, frames.join("\n") + "\n");
    const trace = join(dir, "trace");
    const output = new PassThrough({ highWaterMark: 16 });
    const seen: Buffer[] = [];
    let count = 0;
    const proxy = createProxy({
      pluginId: "p",
      command: process.execPath,
      args: [ADAPTER, "emit", file, "0"],
      tracePath: trace,
      input: new PassThrough(),
      output,
      interpreters: [
        () => {
          count += 1;
          if (count === frames.length) {
            throw new Error("boom");
          }
          return [];
        },
      ],
    });
    const input = (proxy as unknown as { input: PassThrough }).input;
    const done = proxy.run().then(
      () => "resolved",
      (err: Error) => err.message,
    );
    input.end();
    // The output stalls until a reader attaches, after the failure.
    await new Promise((r) => setTimeout(r, 300));
    output.on("data", (chunk: Buffer) => seen.push(chunk));
    expect(await done).toBe("boom");
    await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(trace).equals(Buffer.concat(seen))).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("closes trace fds when spawn throws", async () => {
    const open = () => readdirSync("/dev/fd").length;
    const before = open();
    const proxy = createProxy({
      pluginId: "p",
      command: "bad\0command",
      tracePath: join(tempDir(), "trace"),
      input: new PassThrough(),
    });
    await expect(proxy.run()).rejects.toThrow();
    expect(open()).toBe(before);
  });

  it("injects the hello when the method name is JSON-escaped", async () => {
    const h = start(["acp"]);
    h.input.write('{"jsonrpc":"2.0","id":1,"method":"\\u0069nitialize","params":{}}\n');
    h.input.end();
    await h.done;
    expect(h.frames()[0]).toMatchObject({ result: { _meta: { aoe: { proxy: { plugin_id: "test-plugin" } } } } });
  });

  it("is single-use: a second run() rejects, overlapping or after the first ended", async () => {
    const h = start(["eof"]);
    await expect(h.proxy.run()).rejects.toThrow("run() already called");
    h.input.end();
    expect(await h.done).toBe(3);
    await expect(h.proxy.run()).rejects.toThrow("run() already called");
  });

  it("fails and kills an adapter that closes its stdin but stays alive", async () => {
    const h = start(["close-stdin"], { killGraceMs: 150 });
    await until(() => h.lines().length === 1);
    const { pid } = JSON.parse(h.lines()[0]) as { pid: number };
    h.input.write('{"jsonrpc":"2.0","id":1,"method":"x"}\n');
    await expect(h.done).rejects.toThrow(/EPIPE/);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it("rejects as abandoned when the deadline force-closes a stdout a subprocess holds open", async () => {
    const pidFile = join(tempDir(), "pid");
    const h = start(["grandchild", pidFile], { killGraceMs: 200 });
    try {
      await expect(h.done).rejects.toThrow(/output abandoned after killGraceMs/);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});
