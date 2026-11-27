import { describe, expect, it } from "vitest";
import { processLine } from "../src/index";

describe("worker", () => {
  it("returns -32601 for any method", () => {
    const response = processLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "claude.nope" }));
    expect(response?.error?.code).toBe(-32601);
  });

  it("does not respond to a notification", () => {
    const response = processLine(JSON.stringify({ jsonrpc: "2.0", method: "claude.ping" }));
    expect(response).toBeNull();
  });

  it("ignores malformed input", () => {
    expect(processLine("not json")).toBeNull();
  });
});
