import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildFrame, injectHello, validateEmission } from "../../src/proxy-sdk/envelope";
import type { Emission } from "../../src/proxy-sdk/index";
import { SCHEMA_PATH } from "./harness";

const ajv = new Ajv2020({ strict: false });
// The schema's integer ranges are already enforced by minimum and maximum.
ajv.addFormat("uint32", () => true);
ajv.addFormat("uint64", () => true);
ajv.addSchema(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")), "aoe");
const envelope = ajv.getSchema("aoe#/$defs/Envelope")!;
const hello = ajv.getSchema("aoe#/$defs/ProxyHello")!;

const body = { sessionUpdate: "tool_call", toolCallId: "c1", title: "T" };
const emissions: Emission[] = [
  { sessionId: "s", update: body, aoe: { parent_tool_call: "p1" } },
  { sessionId: "s", update: body, aoe: { ephemeral: true } },
  { sessionId: "s", update: body, aoe: { memory_recall: { mode: "select", paths: ["a"], synthesized_text: null } } },
  { sessionId: "s", update: body, aoe: { plan_proposal: { markdown: "- a\n- b" } } },
  { sessionId: "s", update: body, aoe: { tool_presentation: { icon: "i", label: "l", primary: null, chips: ["c"] } } },
  { sessionId: "s", update: body, aoe: { option_preview: { option_id: "o", markdown: "m" } } },
  { sessionId: "s", update: body, aoe: { lease: { id: "l", kind: "busy", op: "acquire", ttl_ms: 5000 } } },
  { sessionId: "s", update: body, aoe: { lease: { id: "l", kind: "task", op: "renew", ttl_ms: 1 } } },
  { sessionId: "s", update: body, aoe: { lease: { id: "l", kind: "compaction", op: "release" } } },
];

function aoeOf(frame: Buffer): Record<string, unknown> {
  return JSON.parse(frame.toString("utf8")).params.update._meta.aoe;
}

describe("schema conformance", () => {
  it("validates every emitted envelope, and every lease carries op", () => {
    emissions.forEach((e, i) => {
      const aoe = aoeOf(buildFrame(e, `k:${i}`, 3));
      expect(envelope(aoe), JSON.stringify(envelope.errors)).toBe(true);
      expect(aoe).toMatchObject({ v: 1, key: `k:${i}`, after_adapter_sequence: 3 });
      const lease = aoe.lease as { op?: string } | undefined;
      if (lease) {
        // The schema leaves `op` optional but the contract requires it.
        expect(["acquire", "renew", "release"]).toContain(lease.op);
      }
    });
  });

  it("emits frames as a single complete line", () => {
    const frame = buildFrame(emissions[0], "k:1", 0).toString("utf8");
    expect(frame.endsWith("\n")).toBe(true);
    expect(frame.slice(0, -1)).not.toContain("\n");
  });

  it("validates the injected hello", () => {
    const line = Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n');
    const out = JSON.parse(injectHello(line, "my-plugin").toString("utf8"));
    expect(hello(out.result._meta.aoe.proxy), JSON.stringify(hello.errors)).toBe(true);
    expect(hello({ plugin_id: " ", protocol_version: 1, primitive_schema_version: 1 })).toBe(false);
  });

  it("rejects what the contract forbids", () => {
    const bad = (aoe: object) => () => validateEmission({ sessionId: "s", update: body, aoe } as Emission);
    expect(bad({ key: "mine" })).toThrow(/key/);
    expect(bad({ after_adapter_sequence: 1 })).toThrow(/after_adapter_sequence/);
    expect(bad({ lease: { id: "l", kind: "busy", ttl_ms: 5 } })).toThrow(/op/);
    expect(bad({ lease: { id: "l", kind: "busy", op: "acquire" } })).toThrow(/ttl/);
    expect(bad({ lease: { id: "l", kind: "busy", op: "renew", ttl_ms: 3_600_001 } })).toThrow(/ttl/);
    expect(bad({ lease: { id: "l", kind: "busy", op: "release", ttl_ms: 5 } })).toThrow(/ttl/);
    expect(bad({ lease: { id: "", kind: "busy", op: "release" } })).toThrow(/id/);
    expect(() => validateEmission({ sessionId: "", update: body, aoe: {} })).toThrow(/sessionId/);
  });
});
