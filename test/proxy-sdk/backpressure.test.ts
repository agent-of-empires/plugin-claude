import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createProxy } from "../../src/proxy-sdk/index";
import { ADAPTER, isolatingSigterm, tempDir, until } from "./harness";

const TOTAL = 16 * 1024 * 1024;

describe("backpressure", () => {
  it("pauses the adapter while the worker sink is stalled and resumes on drain", async () => {
    const progress = join(tempDir(), "progress");
    const held: (() => void)[] = [];
    let open = false;
    let received = 0;
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (open) {
          cb();
        } else {
          held.push(() => cb());
        }
      },
    });
    const input = new PassThrough();
    const proxy = createProxy({
      pluginId: "p",
      command: process.execPath,
      args: [ADAPTER, "flood", String(TOTAL), progress],
      input,
      output: sink,
    });
    const done = proxy.run();
    await new Promise((r) => setTimeout(r, 400));
    const stalled = Number(readFileSync(progress, "utf8"));
    expect(stalled).toBeGreaterThan(0);
    expect(stalled).toBeLessThan(TOTAL / 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(Number(readFileSync(progress, "utf8"))).toBe(stalled);

    open = true;
    held.splice(0).forEach((cb) => cb());
    input.end();
    expect(await done).toBe(0);
    expect(Number(readFileSync(progress, "utf8"))).toBeGreaterThanOrEqual(TOTAL);
    expect(received).toBeGreaterThanOrEqual(TOTAL);
  }, 30000);

  it("pauses the worker input while the adapter does not read", async () => {
    await isolatingSigterm(async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let ready = false;
      output.on("data", () => (ready = true));
      const proxy = createProxy({
        pluginId: "p",
        command: process.execPath,
        args: [ADAPTER, "ignore-term"],
        input,
        output,
        killGraceMs: 100,
      });
      const done = proxy.run();
      await until(() => ready);
      const chunk = Buffer.from(JSON.stringify({ pad: "a".repeat(60000) }) + "\n");
      for (let i = 0; i < 100; i += 1) {
        input.write(chunk);
        await new Promise((r) => setImmediate(r));
      }
      await until(() => input.isPaused());
      process.emit("SIGTERM");
      expect(await done).toBe(137);
    });
  }, 30000);

  describe("an output that never drains", () => {
    const stuckProxy = (extra: { interpreters?: (() => never)[] }) => {
      const file = join(tempDir(), "out.ndjson");
      writeFileSync(file, '{"jsonrpc":"2.0","method":"x"}\n{"jsonrpc":"2.0","method":"y"}\n');
      const input = new PassThrough();
      const proxy = createProxy({
        pluginId: "p",
        command: process.execPath,
        args: [ADAPTER, "emit", file, "0"],
        tracePath: join(tempDir(), "trace"),
        killGraceMs: 150,
        input,
        output: new Writable({ write: () => undefined }),
        ...extra,
      });
      input.end();
      return proxy;
    };
    const openFds = () => readdirSync("/dev/fd").length;

    it("still lets run() resolve within the grace period", async () => {
      const before = openFds();
      const started = Date.now();
      expect(await stuckProxy({}).run()).toBe(0);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(openFds()).toBe(before);
    }, 10000);

    it("still lets run() reject within the grace period", async () => {
      const before = openFds();
      const started = Date.now();
      const boom = () => {
        throw new Error("boom");
      };
      await expect(stuckProxy({ interpreters: [boom] }).run()).rejects.toThrow(/boom/);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(openFds()).toBe(before);
    }, 10000);

    it("drops queued output after the grace period, even when the sink unblocks later", async () => {
      const file = join(tempDir(), "out.ndjson");
      writeFileSync(file, Array.from({ length: 5 }, () => '{"jsonrpc":"2.0","method":"x"}\n').join(""));
      const input = new PassThrough();
      const chunks: Buffer[] = [];
      const held: (() => void)[] = [];
      const proxy = createProxy({
        pluginId: "p",
        command: process.execPath,
        args: [ADAPTER, "emit", file, "0"],
        killGraceMs: 100,
        input,
        output: new Writable({
          write(chunk: Buffer, _enc, cb) {
            chunks.push(chunk);
            held.push(() => cb());
          },
        }),
      });
      input.end();
      expect(await proxy.run()).toBe(0);
      expect(chunks).toHaveLength(1);
      held.splice(0).forEach((cb) => cb());
      await new Promise((r) => setTimeout(r, 100));
      expect(chunks).toHaveLength(1);
    }, 10000);
  });
});
