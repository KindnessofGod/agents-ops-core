import { describe, expect, it } from "vitest";
import { CASE_A, degradeBelowHigh, harness, strictPolicy } from "./fixtures.js";
import {
  TraceUnavailable,
  inMemoryTraceStore,
  type StoredCase,
  type TraceStore,
  type UnavailabilityPolicy,
} from "../index.js";

/**
 * Slice 5 — the tiered fail policy for `TraceUnavailable`.
 *
 * At high tier an unrecordable decision must not proceed: no trace, no effect.
 * At low tier the caller may degrade. The policy is required configuration with
 * no default, and `high` is pinned to `"fail-closed"` two ways: in the type,
 * asserted against the compiler by `lib/invariants.ts` on every `tsc --build`,
 * and again at runtime, because a policy parsed from configuration does not go
 * through the compiler at all.
 */

/** A store that is up for `openCase` and `read`, and down for every write. */
const brokenOnWrite = (inner: TraceStore): TraceStore => ({
  // Spread rather than a fresh literal: `TraceStore` is branded with a symbol
  // this module does not export, so a decorator wraps a real store and an
  // impostor cannot be written at all. See `lib/invariants.ts`.
  ...inner,
  async append() {
    throw new Error("connection reset by peer");
  },
  async closeCase() {
    throw new Error("connection reset by peer");
  },
  read: (correlationId): Promise<StoredCase | undefined> => inner.read(correlationId),
});

describe("audit — high tier cannot proceed unrecorded", () => {
  it("throws rather than returning, whatever the rest of the policy says", async () => {
    const { audit } = harness({
      store: brokenOnWrite(inMemoryTraceStore()),
      onTraceUnavailable: degradeBelowHigh,
    });
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record({ kind: "payment.authorised", v: 1 }, { tier: "high" }),
    ).rejects.toThrow(TraceUnavailable);
  });

  it("wraps an unknown driver failure as a named error mode with a reason", async () => {
    const { audit } = harness({
      store: brokenOnWrite(inMemoryTraceStore()),
      onTraceUnavailable: degradeBelowHigh,
    });
    const trace = await audit.open(CASE_A);

    const failure = await trace
      .record({ kind: "payment.authorised", v: 1 }, { tier: "high" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(TraceUnavailable);
    expect((failure as TraceUnavailable).reason).toBe("store-failure");
    expect((failure as TraceUnavailable).correlationId).toBe(CASE_A);
  });

  it("ignores a policy object that says otherwise, because types do not reach JavaScript", async () => {
    // What a policy parsed from a configuration file — or written by a caller
    // who is not using TypeScript — can actually look like at runtime.
    const smuggled = {
      high: "degrade",
      medium: "degrade",
      low: "degrade",
    } as unknown as UnavailabilityPolicy;

    const { audit } = harness({
      store: brokenOnWrite(inMemoryTraceStore()),
      onTraceUnavailable: smuggled,
    });
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record({ kind: "payment.authorised", v: 1 }, { tier: "high" }),
    ).rejects.toThrow(TraceUnavailable);
  });

  it("leaves nothing behind: no node, so nothing an effect could be parented to", async () => {
    const inner = inMemoryTraceStore();
    const { audit } = harness({
      store: brokenOnWrite(inner),
      onTraceUnavailable: degradeBelowHigh,
    });
    const trace = await audit.open(CASE_A);

    await trace
      .record({ kind: "payment.authorised", v: 1 }, { tier: "high" })
      .catch(() => undefined);

    expect((await inner.read(CASE_A))?.nodes).toHaveLength(0);
  });
});

describe("audit — configured degradation below high tier", () => {
  it("hands back a degraded result the caller has to look at, with no node in it", async () => {
    const { audit, clock } = harness({
      store: brokenOnWrite(inMemoryTraceStore()),
      onTraceUnavailable: degradeBelowHigh,
    });
    const trace = await audit.open(CASE_A);

    const result = await trace.record(
      { kind: "ticket.routed", v: 1 },
      { tier: "low" },
    );

    expect(result.recorded).toBe(false);
    if (result.recorded) throw new Error("unreachable");
    expect(result.reason).toBe("store-failure");
    expect(result.at).toBe(clock.now());
    // Deliberately no `node`. Nothing was written, so nothing can be parented
    // to it — the degradation cannot be laundered into a graph edge.
    expect("node" in result).toBe(false);
  });

  it("fails closed at low tier too when the application configured it that way", async () => {
    const { audit } = harness({
      store: brokenOnWrite(inMemoryTraceStore()),
      onTraceUnavailable: strictPolicy,
    });
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record({ kind: "ticket.routed", v: 1 }, { tier: "low" }),
    ).rejects.toThrow(TraceUnavailable);
  });
});

describe("audit — close is fail-closed at every tier", () => {
  it("refuses to report a case closed when the closure was not recorded", async () => {
    const { audit } = harness({
      store: brokenOnWrite(inMemoryTraceStore()),
      onTraceUnavailable: degradeBelowHigh,
    });
    const trace = await audit.open(CASE_A);

    // An unassisted-containment figure with no node behind it is an assertion,
    // not evidence, so no policy makes close degradable. The matcher is
    // specific on purpose: a bare `rejects.toThrow()` passed while `close` was
    // letting raw driver errors escape un-named, which is the one verb that
    // writes the unassisted-containment figure.
    const failure = await trace.close({ unassistedContainment: true }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TraceUnavailable);
    expect((failure as TraceUnavailable).reason).toBe("store-failure");
    expect((failure as TraceUnavailable).degradable).toBe(true);
  });

  it("still refuses to degrade it, whatever the policy says", async () => {
    const { audit } = harness({
      store: brokenOnWrite(inMemoryTraceStore()),
      onTraceUnavailable: degradeBelowHigh,
    });
    const trace = await audit.open(CASE_A);

    // `close` has no degraded shape to return. The error is degradable in
    // principle; close does not consult the policy at all.
    await expect(trace.close({ unassistedContainment: false })).rejects.toThrow(
      TraceUnavailable,
    );
  });
});
