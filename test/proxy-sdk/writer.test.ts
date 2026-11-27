import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { FrameWriter } from "../../src/proxy-sdk/writer";

/** A sink whose write callbacks are held until the test fires them. */
function heldSink() {
  const callbacks: ((err?: Error | null) => void)[] = [];
  const stream = new Writable({
    highWaterMark: 1 << 20,
    write(_chunk, _enc, cb) {
      callbacks.push(cb);
    },
  });
  return { stream, callbacks };
}

const settled = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((r) => setTimeout(r, 20));
  return done;
};

describe("FrameWriter", () => {
  it("flush and close wait for the write callback", async () => {
    const { stream, callbacks } = heldSink();
    const writer = new FrameWriter(stream);
    const write = writer.write(Buffer.from("a\n"));
    const flush = writer.flush();
    const close = writer.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(callbacks).toHaveLength(1);
    expect(await settled(write)).toBe(false);
    expect(await settled(flush)).toBe(false);
    expect(await settled(close)).toBe(false);
    callbacks[0]();
    await Promise.all([write, flush, close]);
  });

  it("rejects when the callback reports an error late", async () => {
    const { stream, callbacks } = heldSink();
    const writer = new FrameWriter(stream);
    const write = writer.write(Buffer.from("a\n"));
    const outcome = expect(write).rejects.toThrow(/late/);
    await new Promise((r) => setTimeout(r, 20));
    callbacks[0](new Error("late"));
    await outcome;
  });
});
