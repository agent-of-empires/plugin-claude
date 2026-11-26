// Shared test helpers: run a proxy against the fixture adapter with in-memory streams.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { expect } from "vitest";
import { createProxy, type Proxy, type ProxyOptions } from "../../src/proxy-sdk/index";

export const ADAPTER = fileURLToPath(new URL("./fixtures/adapter.mjs", import.meta.url));
export const SCHEMA_PATH = fileURLToPath(new URL("../../src/proxy-sdk/schema/aoe-meta-v1.schema.json", import.meta.url));

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "proxy-sdk-"));
}

export interface Harness {
  proxy: Proxy;
  input: PassThrough;
  output(): Buffer;
  lines(): string[];
  frames(): Record<string, unknown>[];
  /** Resolves with the adapter's exit status. */
  done: Promise<number>;
}

export function start(
  adapterArgs: string[],
  extra: Partial<ProxyOptions> = {},
  outputOptions: { highWaterMark?: number } = {},
): Harness {
  const input = new PassThrough();
  const output = new PassThrough(outputOptions);
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const proxy = createProxy({
    pluginId: "test-plugin",
    command: process.execPath,
    args: [ADAPTER, ...adapterArgs],
    input,
    output,
    ...extra,
  });
  // Let the output stream deliver its last 'data' events before callers read it.
  const done = proxy.run().then(async (code) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return code;
  });
  const all = () => Buffer.concat(chunks);
  const lines = () =>
    all()
      .toString("utf8")
      .split("\n")
      .filter((l) => l !== "");
  return { proxy, input, output: all, lines, frames: () => lines().map((l) => JSON.parse(l)), done };
}

export function readTrace(path: string): Buffer {
  return readFileSync(path);
}

export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!check()) {
    throw new Error("condition not met in time");
  }
}

/** Runs fn with the process's own SIGTERM listeners removed, so a synthetic emit reaches only the proxy. */
export async function isolatingSigterm(fn: () => Promise<void>): Promise<void> {
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
