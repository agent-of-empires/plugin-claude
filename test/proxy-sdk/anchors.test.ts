import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Interpreter, Proxy } from "../../src/proxy-sdk/index";
import { start, tempDir } from "./harness";

type Aoe = { key: string; after_adapter_sequence?: number; lease?: { op: string }; parent_tool_call?: string };
const aoeOf = (f: Record<string, unknown>): Aoe | undefined =>
  (f as { params?: { update?: { _meta?: { aoe?: Aoe } } } }).params?.update?._meta?.aoe;

const update = (kind: string, meta?: object) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: kind, ...(meta ? { _meta: { aoe: meta } } : {}) } },
  });

describe("anchors", () => {
  it("anchors emissions and leases to the adapter count, counting only unanchored adapter updates", async () => {
    const file = join(tempDir(), "out.ndjson");
    writeFileSync(
      file,
      [
        update("agent_message_chunk"), // 1
        '{"jsonrpc":"2.0","id":5,"result":{}}', // a response takes no number
        update("agent_message_chunk", { v: 1, key: "adapter-anchored", after_adapter_sequence: 1 }), // takes none
        update("tool_call"), // 2
        "not json",
        update("agent_message_chunk", { v: 1, key: "plain" }), // 3 (no anchor)
      ].join("\n") + "\n",
    );
    const ref: { proxy?: Proxy } = {};
    const interpreter: Interpreter = ({ value }) => {
      const kind = (value.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate;
      if (kind !== "tool_call") {
        return [];
      }
      ref.proxy?.leases.acquire({ sessionId: "s1", kind: "busy", ttlMs: 60000 });
      return [
        { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "c", title: "T" }, aoe: { parent_tool_call: "p" } },
      ];
    };
    const h = start(["emit", file, "0"], { interpreters: [interpreter] });
    ref.proxy = h.proxy;
    h.input.end();
    await h.done;

    const synthetic = h
      .lines()
      .flatMap((l) => (l.startsWith("{") ? [JSON.parse(l) as Record<string, unknown>] : []))
      .map(aoeOf)
      .filter((a) => a?.key && a.key.includes(":"));
    // Lease acquire and the emission at count 2, then the release at the final count 3.
    expect(synthetic.map((a) => [a?.lease?.op ?? "emission", a?.after_adapter_sequence])).toEqual([
      ["acquire", 2],
      ["emission", 2],
      ["release", 3],
    ]);
    const keys = synthetic.map((a) => a?.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(h.lines()).toHaveLength(6 + 3);
  });

  it("rejects an interpreter that supplies key or after_adapter_sequence", async () => {
    const file = join(tempDir(), "out.ndjson");
    writeFileSync(file, update("tool_call") + "\n");
    const bad: Interpreter = () => [{ sessionId: "s1", update: {}, aoe: { key: "mine" } as never }];
    const h = start(["emit", file, "0"], { interpreters: [bad] });
    h.input.end();
    await expect(h.done).rejects.toThrow(/key/);
  });
});
