// Envelope helpers: idempotency keys, anchors, the hello and frame building.

import { randomBytes } from "node:crypto";
import { splitDelimiter } from "./lines.js";
import type { Emission, LeaseOp } from "./types.js";

export const PROTOCOL_VERSION = 1;
export const PRIMITIVE_SCHEMA_VERSION = 1;
export const LEASE_TTL_MIN_MS = 1;
export const LEASE_TTL_MAX_MS = 3_600_000;

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `<process-random>:<counter>`: unique per process, never reused. */
export class KeyGenerator {
  private readonly prefix = randomBytes(8).toString("hex");
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `${this.prefix}:${this.counter}`;
  }
}

/** The contract requires `op`, though the published schema omits it from `required`. */
export function validateLease(lease: LeaseOp): void {
  if (typeof lease.id !== "string" || lease.id === "") {
    throw new Error("lease.id must be a non-empty string");
  }
  if (!["busy", "task", "compaction"].includes(lease.kind)) {
    throw new Error(`invalid lease kind ${String(lease.kind)}`);
  }
  if (!["acquire", "renew", "release"].includes(lease.op)) {
    throw new Error(`invalid lease op ${String(lease.op)}`);
  }
  if (lease.op === "release") {
    if (lease.ttl_ms !== undefined) {
      throw new Error("lease release must omit ttl_ms");
    }
    return;
  }
  validateTtl(lease.ttl_ms);
}

export function validateTtl(ttl: unknown): asserts ttl is number {
  if (!Number.isInteger(ttl) || (ttl as number) < LEASE_TTL_MIN_MS || (ttl as number) > LEASE_TTL_MAX_MS) {
    throw new Error(`lease ttl_ms must be an integer in ${LEASE_TTL_MIN_MS}..${LEASE_TTL_MAX_MS}`);
  }
}

export function validateEmission(emission: Emission): void {
  if (typeof emission.sessionId !== "string" || emission.sessionId === "") {
    throw new Error("emission.sessionId must be a non-empty string");
  }
  if (!isObject(emission.update)) {
    throw new Error("emission.update must be an object");
  }
  const aoe: unknown = emission.aoe;
  if (!isObject(aoe)) {
    throw new Error("emission.aoe must be an object");
  }
  for (const reserved of ["v", "key", "after_adapter_sequence"]) {
    if (reserved in aoe) {
      throw new Error(`emission.aoe must not set ${reserved}: the SDK owns it`);
    }
  }
  if (emission.aoe.lease) {
    validateLease(emission.aoe.lease);
  }
}

/** Builds one framed `session/update` line for an emission. */
export function buildFrame(emission: Emission, key: string, anchor: number): Buffer {
  validateEmission(emission);
  const meta = isObject(emission.update._meta) ? emission.update._meta : {};
  const frame = {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: emission.sessionId,
      update: {
        ...emission.update,
        _meta: { ...meta, aoe: { ...emission.aoe, v: PRIMITIVE_SCHEMA_VERSION, key, after_adapter_sequence: anchor } },
      },
    },
  };
  return Buffer.from(JSON.stringify(frame) + "\n");
}

/** True when an agent frame carries `after_adapter_sequence`, so it takes no adapter number. */
export function isAnchored(frame: Record<string, unknown>): boolean {
  const params = frame.params;
  const update = isObject(params) ? params.update : undefined;
  const meta = isObject(update) ? update._meta : undefined;
  const aoe = isObject(meta) ? meta.aoe : undefined;
  return isObject(aoe) && aoe.after_adapter_sequence != null;
}

/** Type-sensitive id key: 1 and "1" differ. */
export function idKey(id: unknown): string | null {
  return typeof id === "string" || typeof id === "number" ? `${typeof id}:${String(id)}` : null;
}

/**
 * Merges the proxy hello into an initialize result line, keeping the line's
 * delimiter and every other key. Returns the line untouched when it is not an
 * object with an object result.
 */
export function injectHello(line: Buffer, pluginId: string): Buffer {
  const { body, delimiter } = splitDelimiter(line);
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return line;
  }
  if (!isObject(value) || !isObject(value.result)) {
    return line;
  }
  const result = value.result;
  const meta = isObject(result._meta) ? result._meta : (result._meta = {});
  const aoe = isObject(meta.aoe) ? meta.aoe : (meta.aoe = {});
  aoe.proxy = { plugin_id: pluginId, protocol_version: PROTOCOL_VERSION, primitive_schema_version: PRIMITIVE_SCHEMA_VERSION };
  return Buffer.concat([Buffer.from(JSON.stringify(value)), delimiter]);
}
