import { spawn } from "node:child_process";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createProxy } from "../../src/proxy-sdk/index";
import { ADAPTER, tempDir } from "./harness";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe("stdio release", () => {
  it("destroys the adapter's pipes when it fails while the relay is paused", async () => {
    const callbacks: ((err?: Error) => void)[] = [];
    const proxy = createProxy({
      pluginId: "p",
      command: process.execPath,
      args: [ADAPTER, "flood", String(16 * 1024 * 1024), join(tempDir(), "progress")],
      input: new PassThrough(),
      output: new Writable({
        write(_chunk: Buffer, _enc, cb) {
          callbacks.push(cb);
        },
      }),
    });
    const outcome = expect(proxy.run()).rejects.toThrow(/sink broke/);
    await new Promise((r) => setTimeout(r, 400)); // the relay is paused by now
    const child = vi.mocked(spawn).mock.results[0].value as ReturnType<typeof spawn>;
    expect(child.stdout?.isPaused()).toBe(true);
    callbacks[0](new Error("sink broke"));
    await outcome;
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stdin?.destroyed).toBe(true);
  }, 30000);
});
