import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { start, tempDir } from "./harness";

describe("concurrent emits", () => {
  it("never interleave partial lines and all frames arrive", async () => {
    const file = join(tempDir(), "out.ndjson");
    const adapterFrames = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "x", pad: "a".repeat(20000), i } } }),
    );
    writeFileSync(file, adapterFrames.join("\n") + "\n");
    // A tiny highWaterMark and a slow reader force the writer to wait for drain.
    const h = start(["emit", file, "0"], {}, { highWaterMark: 1024 });
    const sources = 50;
    const perSource = 10;
    await Promise.all(
      Array.from({ length: sources }, async (_, s) => {
        for (let n = 0; n < perSource; n += 1) {
          await new Promise((r) => setImmediate(r));
          h.proxy.emit({
            sessionId: "s",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${s}:${n}:${"b".repeat(30000)}` } },
            aoe: { ephemeral: true },
          });
        }
      }),
    );
    h.input.end();
    expect(await h.done).toBe(0);
    const frames = h.frames();
    expect(frames).toHaveLength(adapterFrames.length + sources * perSource);
    const texts = new Set(
      frames.flatMap((f) => {
        const update = (f.params as { update: { content?: { text: string } } }).update;
        return update.content ? [update.content.text.split(":").slice(0, 2).join(":")] : [];
      }),
    );
    expect(texts.size).toBe(sources * perSource);
    expect(h.output().toString("utf8").endsWith("\n")).toBe(true);
  }, 30000);
});
