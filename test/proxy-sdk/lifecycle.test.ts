import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProxy } from "../../src/proxy-sdk/index";
import { ADAPTER, start, tempDir, until } from "./harness";

/** Runs fn with the process's own SIGTERM listeners removed, so a synthetic emit reaches only the proxy. */
async function isolatingSigterm(fn: () => Promise<void>): Promise<void> {
  const saved = process.listeners("SIGTERM");
  process.removeAllListeners("SIGTERM");
  try {
    await fn();
    expect(process.listenerCount("SIGTERM")).toBe(0);
  } finally {
    for (const l of saved) {
      process.on("SIGTERM", l);
    }
  }
}

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
});
