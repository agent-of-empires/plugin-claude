import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { start, tempDir } from "./harness";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInput(rand: () => number): Buffer {
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const parts: Buffer[] = [];
  const count = 1 + Math.floor(rand() * 30);
  for (let i = 0; i < count; i += 1) {
    const kind = pick(["update", "anchored", "array", "number", "broken", "empty", "space", "unicode", "binary", "big"]);
    let body: Buffer;
    switch (kind) {
      case "update":
        body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { n: i } } }));
        break;
      case "anchored":
        body = Buffer.from(
          `{"method":"session/update","params":{"update":{"_meta":{"aoe":{"v":1,"key":"k${i}","after_adapter_sequence":1}}}}}`,
        );
        break;
      case "array":
        body = Buffer.from("[1,2,3]");
        break;
      case "number":
        body = Buffer.from(String(Math.floor(rand() * 1000)));
        break;
      case "broken":
        body = Buffer.from('{"jsonrpc":"2.0","method":');
        break;
      case "empty":
        body = Buffer.alloc(0);
        break;
      case "space":
        body = Buffer.from("   \t ");
        break;
      case "unicode":
        body = Buffer.from(JSON.stringify({ text: "héllo \u{1f600}  " }));
        break;
      case "binary":
        body = Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x80]);
        break;
      default:
        body = Buffer.from(JSON.stringify({ blob: "x".repeat(70000) }));
    }
    parts.push(body, Buffer.from(pick(["\n", "\r\n", "\n"])));
  }
  if (rand() < 0.5) {
    parts.push(Buffer.from('{"unterminated":tru'));
  }
  return Buffer.concat(parts);
}

function chunked(data: Buffer, rand: () => number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; ) {
    const size = 1 + Math.floor(rand() * rand() * 5000);
    out.push(data.subarray(i, i + size));
    i += size;
  }
  return out;
}

describe("passthrough identity", () => {
  it("forwards random input byte for byte in both directions", async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rand = mulberry32(seed);
      const data = randomInput(rand);
      const trace = join(tempDir(), "trace");
      const h = start(["echo"], { tracePath: trace });
      for (const chunk of chunked(data, rand)) {
        h.input.write(chunk);
        if (rand() < 0.2) {
          await new Promise((r) => setImmediate(r));
        }
      }
      h.input.end();
      expect(await h.done).toBe(0);
      expect(h.output().equals(data), `seed ${seed}`).toBe(true);
      expect(readFileSync(trace).equals(data), `trace seed ${seed}`).toBe(true);
      expect(readFileSync(`${trace}.client`).equals(data), `client trace seed ${seed}`).toBe(true);
    }
  }, 60000);

  it("rewrites only the initialize result and merges the hello", async () => {
    const h = start(["acp"]);
    h.input.write('{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}\r\n');
    h.input.write('{"jsonrpc":"2.0","id":8,"method":"session/new","params":{}}\n');
    h.input.end();
    await h.done;
    const out = h.output().toString("utf8").split("\n");
    const hello = JSON.parse(out[0]);
    expect(hello.result.agent_info).toEqual({ name: "fixture" });
    expect(hello.result._meta).toEqual({
      vendor: { x: 1 },
      aoe: { other: true, proxy: { plugin_id: "test-plugin", protocol_version: 1, primitive_schema_version: 1 } },
    });
    expect(out[1]).toBe('{"jsonrpc":"2.0","id":8,"result":{"sessionId":"s1"}}');
  });

  it("does not rewrite on an id type mismatch, an error response or a non-initialize result", async () => {
    const dir = tempDir();
    const file = join(dir, "out.ndjson");
    const lines = [
      '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}',
      '{"jsonrpc":"2.0","id":"2","error":{"code":-1,"message":"no"}}',
      '{"jsonrpc":"2.0","id":3,"result":{"x":1}}',
    ];
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, lines.join("\n") + "\n");
    const h = start(["emit", file, "0"]);
    h.input.write('{"jsonrpc":"2.0","id":"1","method":"initialize"}\n');
    h.input.write('{"jsonrpc":"2.0","id":"2","method":"initialize"}\n');
    h.input.end();
    await h.done;
    expect(h.output().toString("utf8")).toBe(lines.join("\n") + "\n");
  });
});
