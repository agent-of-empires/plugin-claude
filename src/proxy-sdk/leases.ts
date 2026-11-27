// Lease manager: SDK-generated ids, an immediate acquire, renewal at ttl/2.

import { randomUUID } from "node:crypto";
import { validateTtl } from "./envelope.js";
import type { Emission, LeaseKind, LeaseOp } from "./types.js";

interface Held {
  sessionId: string;
  kind: LeaseKind;
  ttlMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class LeaseManager {
  private readonly held = new Map<string, Held>();
  private closed = false;

  constructor(private readonly emit: (emission: Emission) => void) {}

  /** Acquires a lease and keeps it renewed until released. Returns its id. */
  acquire(opts: { sessionId: string; kind: LeaseKind; ttlMs: number }): string {
    if (this.closed) {
      throw new Error("lease manager is closed");
    }
    validateTtl(opts.ttlMs);
    const id = randomUUID();
    const lease: Held = { sessionId: opts.sessionId, kind: opts.kind, ttlMs: opts.ttlMs, timer: null };
    this.send(lease, { id, kind: lease.kind, op: "acquire", ttl_ms: lease.ttlMs });
    this.held.set(id, lease);
    this.schedule(id, lease);
    return id;
  }

  /** Renews now, optionally with a new ttl, and restarts the renewal timer. */
  renew(id: string, ttlMs?: number): void {
    const lease = this.get(id);
    if (ttlMs !== undefined) {
      validateTtl(ttlMs);
    }
    this.cancel(lease);
    lease.ttlMs = ttlMs ?? lease.ttlMs;
    this.send(lease, { id, kind: lease.kind, op: "renew", ttl_ms: lease.ttlMs });
    this.schedule(id, lease);
  }

  release(id: string): void {
    const lease = this.get(id);
    this.cancel(lease);
    this.held.delete(id);
    this.send(lease, { id, kind: lease.kind, op: "release" });
  }

  /** Best-effort release of every lease, then refuses new ones. Never throws. */
  dispose(): void {
    this.closed = true;
    for (const id of [...this.held.keys()]) {
      try {
        this.release(id);
      } catch {
        this.held.delete(id);
      }
    }
  }

  private get(id: string): Held {
    const lease = this.held.get(id);
    if (!lease) {
      throw new Error(`unknown lease ${id}`);
    }
    return lease;
  }

  private cancel(lease: Held): void {
    if (lease.timer) {
      clearTimeout(lease.timer);
      lease.timer = null;
    }
  }

  // A chain of single timeouts, so renewals never overlap.
  private schedule(id: string, lease: Held): void {
    lease.timer = setTimeout(() => {
      lease.timer = null;
      try {
        this.renew(id);
      } catch {
        this.cancel(lease);
        this.held.delete(id);
      }
    }, Math.max(1, Math.floor(lease.ttlMs / 2)));
    lease.timer.unref?.();
  }

  // The update body is an empty message chunk; `ephemeral` drops it before the
  // reducer, and core applies the lease first.
  private send(lease: Held, op: LeaseOp): void {
    this.emit({
      sessionId: lease.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
      aoe: { ephemeral: true, lease: op },
    });
  }
}
