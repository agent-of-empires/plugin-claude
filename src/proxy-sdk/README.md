# ACP proxy SDK

An inline stdio proxy between the aoe worker (the proxy's own stdin/stdout, NDJSON) and a spawned ACP adapter (stderr inherited). It relays both directions byte for byte. It only does three things: add the `_meta.aoe.proxy` hello to the initialize result, run interpreters over agent-to-client frames, and manage leases. Contract: core `docs/development/internals/acp-primitive-contract.md`. The vendored schema (`schema/aoe-meta-v1.schema.json`) is pinned to core commit 08a743b86.

```ts
import { createProxy } from "./proxy-sdk/index.js";

const proxy = createProxy({
  pluginId: "claude",
  command: "claude-agent-acp",
  interpreters: [
    // Sync and pure. Runs on agent-to-client frames only; emissions are queued
    // after the source frame, in registration order.
    ({ value, raw }) => [
      { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "c2", title: "T" }, aoe: { parent_tool_call: "c1" } },
    ],
  ],
});
// run() starts the adapter and sets up the output writer synchronously, so emit
// and lease calls are valid right after it. A Proxy is single-use. If run() fails
// at startup (for example a bad trace path), emit and lease calls throw "proxy is
// not running", so attach the catch before using them.
const done = proxy.run();
done.catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
const id = proxy.leases.acquire({ sessionId: "s1", kind: "busy", ttlMs: 60_000 }); // renewed at ttl/2
proxy.leases.release(id);
process.exitCode = await done; // the adapter's exit status, after output is flushed
```

- The SDK adds `v`, `key` (`<process-random>:<counter>`) and `after_adapter_sequence` (the adapter `session/update` count so far). Emissions must not set `key` or `after_adapter_sequence`.
- Adapter frames are counted only if they are `session/update` without `after_adapter_sequence`. Proxy-emitted frames never take a number.
- `proxy.emit(emission)` and the lease calls are valid only once `run()` has started successfully; before that, or if `run()` rejected at startup, they throw "proxy is not running". After the run ends, emits are ignored and `leases.acquire` throws. `emit` may be called from any async source. Relayed traffic is flow-controlled: a source is paused while more than 1 MiB is queued for its sink. Interpreter, `emit` and lease frames are not throttled, so their volume is the caller's to bound. Writes go through one FIFO queue of whole lines.
- Lease frames carry an empty `agent_message_chunk` marked `ephemeral`, so core applies the lease and drops the frame.
- `SIGINT`, `SIGTERM` and `SIGHUP` are forwarded to the adapter once, then SIGKILL after `killGraceMs` (default 5000). Client EOF ends the adapter's stdin.
- `run()` resolves with the adapter's exit status after all output is flushed to the worker. `killGraceMs` bounds both the SIGKILL escalation and the shutdown flush: once the adapter has exited, the worker has `killGraceMs` to drain what is queued. If it stalls longer, the queued output is dropped, the adapter's pipes are destroyed and `run()` rejects with an "output abandoned after killGraceMs" error instead of resolving.
- A trailing line without a delimiter is forwarded untouched and nothing is emitted after it.

## Trace

With env `AOE_ACP_PROXY_TRACE=<path>` (or the `tracePath` option):

- `<path>`: the exact bytes written to the worker, in write order. Replay with `aoe acp lint-stream <path> --require-hello`.
- `<path>.client`: the bytes received from the worker.

Both files are mode 0600. A trace failure is fatal: `run()` rejects and the adapter is killed.
