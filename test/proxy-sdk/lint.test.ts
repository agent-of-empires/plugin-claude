import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Interpreter, Proxy } from "../../src/proxy-sdk/index";
import { start, tempDir, until } from "./harness";

const hasAoe = spawnSync("aoe", ["--version"]).status === 0;

describe.skipIf(!hasAoe)("aoe acp lint-stream", () => {
  it("accepts the recorded agent-to-client trace", async () => {
    const trace = join(tempDir(), "trace");
    const ref: { proxy?: Proxy } = {};
    const interpreter: Interpreter = ({ value }) => {
      const update = (value.params as { update?: { sessionUpdate?: string } } | undefined)?.update;
      if (update?.sessionUpdate !== "tool_call") {
        return [];
      }
      ref.proxy?.leases.acquire({ sessionId: "s1", kind: "busy", ttlMs: 60000 });
      return [
        { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "c2", title: "Child" }, aoe: { parent_tool_call: "t1" } },
      ];
    };
    const h = start(["acp"], { interpreters: [interpreter], tracePath: trace });
    ref.proxy = h.proxy;
    h.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    h.input.write('{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}\n');
    await until(() => h.lines().length >= 6); // hello, session/new, 3 updates, 1 emission, 1 lease acquire
    h.input.end();
    expect(await h.done).toBe(0);

    const lint = spawnSync("aoe", ["acp", "lint-stream", trace, "--require-hello"], { encoding: "utf8" });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
  });
});
