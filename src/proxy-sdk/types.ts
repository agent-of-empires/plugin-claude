// Public types of the ACP proxy SDK.

import type { Readable, Writable } from "node:stream";

export type LeaseKind = "busy" | "task" | "compaction";
export type LeaseVerb = "acquire" | "renew" | "release";

interface LeaseBase {
  id: string;
  kind: LeaseKind;
}

/** acquire and renew need a ttl; release must omit it. */
export type LeaseOp =
  | (LeaseBase & { op: "acquire" | "renew"; ttl_ms: number })
  | (LeaseBase & { op: "release"; ttl_ms?: undefined });

/** The `_meta.aoe` primitives an interpreter may set. The SDK adds v, key and after_adapter_sequence. */
export interface AoePrimitives {
  parent_tool_call?: string;
  ephemeral?: boolean;
  memory_recall?: { mode: string; paths?: string[]; synthesized_text?: string | null };
  plan_proposal?: { markdown: string };
  tool_presentation?: { icon?: string | null; label?: string | null; primary?: string | null; chips?: string[] };
  option_preview?: { option_id: string; markdown: string };
  lease?: LeaseOp;
}

/** A frame the proxy emits itself, as a `session/update`. */
export interface Emission {
  sessionId: string;
  /** The ACP update body, for example `{sessionUpdate: "tool_call", ...}`. */
  update: Record<string, unknown>;
  aoe: AoePrimitives;
}

/** An agent-to-client line. `raw` is the line without its delimiter, as a copy. */
export interface Frame {
  value: Record<string, unknown>;
  raw: Buffer;
}

/** Sync and pure: emissions are queued after the source frame, in registration order. */
export type Interpreter = (frame: Frame) => Emission[];

export interface ProxyOptions {
  pluginId: string;
  command: string;
  args?: string[];
  interpreters?: Interpreter[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Milliseconds between a forwarded signal and SIGKILL. Default 5000. */
  killGraceMs?: number;
  /** Trace path. Default: env AOE_ACP_PROXY_TRACE. */
  tracePath?: string;
  /** The worker side. Default: process.stdin. */
  input?: Readable;
  /** The worker side. Default: process.stdout. */
  output?: Writable;
}
