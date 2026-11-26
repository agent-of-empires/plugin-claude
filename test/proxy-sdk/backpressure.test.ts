import { readFileSync } from "node:fs";
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
});
