import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaseManager } from "../../src/proxy-sdk/index";
import type { Emission, LeaseOp } from "../../src/proxy-sdk/index";

describe("LeaseManager", () => {
  let emitted: Emission[];
  let leases: LeaseManager;
  const ops = (): LeaseOp[] => emitted.map((e) => e.aoe.lease as LeaseOp);

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    leases = new LeaseManager((e) => emitted.push(e));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquires immediately and renews at ttl/2 while held", () => {
    const id = leases.acquire({ sessionId: "s", kind: "busy", ttlMs: 1000 });
    expect(ops()).toEqual([{ id, kind: "busy", op: "acquire", ttl_ms: 1000 }]);
    vi.advanceTimersByTime(499);
    expect(emitted).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ops().map((o) => o.op)).toEqual(["acquire", "renew"]);
    vi.advanceTimersByTime(2000);
    expect(ops().map((o) => o.op)).toEqual(["acquire", "renew", "renew", "renew", "renew", "renew"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops renewing after release and omits ttl_ms", () => {
    const id = leases.acquire({ sessionId: "s", kind: "task", ttlMs: 1000 });
    leases.release(id);
    expect(ops()[1]).toEqual({ id, kind: "task", op: "release" });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10000);
    expect(emitted).toHaveLength(2);
  });

  it("releases every lease on dispose", () => {
    leases.acquire({ sessionId: "s", kind: "busy", ttlMs: 1000 });
    leases.acquire({ sessionId: "s", kind: "compaction", ttlMs: 2000 });
    leases.dispose();
    expect(ops().filter((o) => o.op === "release")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a ttl out of range", () => {
    for (const ttlMs of [0, -1, 3_600_001, 1.5, Number.NaN]) {
      expect(() => leases.acquire({ sessionId: "s", kind: "busy", ttlMs })).toThrow();
    }
    expect(emitted).toHaveLength(0);
    expect(() => leases.acquire({ sessionId: "s", kind: "busy", ttlMs: 3_600_000 })).not.toThrow();
  });

  it("rejects renew and release of an unknown id, and of a released id", () => {
    expect(() => leases.renew("nope")).toThrow(/unknown lease/);
    expect(() => leases.release("nope")).toThrow(/unknown lease/);
    const id = leases.acquire({ sessionId: "s", kind: "busy", ttlMs: 1000 });
    leases.release(id);
    expect(() => leases.release(id)).toThrow(/unknown lease/);
    expect(() => leases.renew(id)).toThrow(/unknown lease/);
  });

  it("restarts the timer on a manual renew", () => {
    const id = leases.acquire({ sessionId: "s", kind: "busy", ttlMs: 1000 });
    vi.advanceTimersByTime(400);
    leases.renew(id, 2000);
    expect(ops()[1]).toEqual({ id, kind: "busy", op: "renew", ttl_ms: 2000 });
    vi.advanceTimersByTime(999);
    expect(emitted).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(emitted).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(1);
  });
});
