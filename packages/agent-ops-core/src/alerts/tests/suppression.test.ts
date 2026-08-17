import { describe, expect, it } from "vitest";
import { conditions, harness } from "./fixtures.js";

/**
 * Requirement (f), the second half: dedupe so one flapping condition cannot
 * itself become the outage — **but suppression must never silence a condition
 * entirely, only collapse repeats, and the count is reported when it fires.**
 *
 * The failure this guards against is subtle and common: a suppression scheme
 * that collapses repeats *without reporting the count* turns a condition
 * flapping four hundred times an hour into one that looks like it happened
 * once. That is a quieter lie than not alerting at all, because it comes with
 * evidence attached.
 */

describe("the first occurrence always fires", () => {
  it("has no warm-up, no threshold and no 'three in five minutes'", async () => {
    const h = harness();
    const result = await h.alerts.raise(conditions.buried("c_first"));
    expect(result.outcome).toBe("delivered");
    expect(h.recorder.delivered).toHaveLength(1);
    expect(h.recorder.delivered[0]?.suppressedSinceLastDelivery).toBe(0);
  });
});

describe("repeats inside the window are collapsed, counted, and never lost", () => {
  it("delivers once and counts the rest", async () => {
    const h = harness({ limits: { suppressionWindowMs: 300_000 } });
    for (let i = 0; i < 50; i += 1) await h.alerts.raise(conditions.buried("c_flap"));

    expect(h.recorder.delivered).toHaveLength(1);
    const health = h.alerts.health();
    expect(health.delivered).toBe(1);
    expect(health.suppressed).toBe(49);
  });

  it("reports the collapsed count on the next delivery", async () => {
    const h = harness({ limits: { suppressionWindowMs: 300_000 } });
    await h.alerts.raise(conditions.buried("c_count"));
    for (let i = 0; i < 400; i += 1) await h.alerts.raise(conditions.buried("c_count"));

    h.clock.advance(300_000);
    await h.alerts.raise(conditions.buried("c_count"));

    expect(h.recorder.delivered).toHaveLength(2);
    // Four hundred is the difference between "it happened" and "it is happening".
    expect(h.recorder.delivered[1]?.suppressedSinceLastDelivery).toBe(400);
  });

  it("tells the caller when the window ends, rather than just refusing", async () => {
    const h = harness({ limits: { suppressionWindowMs: 60_000 } });
    await h.alerts.raise(conditions.buried("c_when"));
    const suppressed = await h.alerts.raise(conditions.buried("c_when"));

    expect(suppressed.outcome).toBe("suppressed");
    if (suppressed.outcome !== "suppressed") return;
    expect(suppressed.suppressedSinceLastDelivery).toBe(1);
    expect(suppressed.nextEligibleAt).toBe(h.clock.now() + 60_000);
    expect(suppressed.severity).toBe("degraded");
  });

  it("resets the count after each delivery, so counts are per window", async () => {
    const h = harness({ limits: { suppressionWindowMs: 60_000 } });
    await h.alerts.raise(conditions.buried("c_reset"));
    await h.alerts.raise(conditions.buried("c_reset"));
    h.clock.advance(60_000);
    await h.alerts.raise(conditions.buried("c_reset"));
    h.clock.advance(60_000);
    await h.alerts.raise(conditions.buried("c_reset"));

    expect(h.recorder.delivered.map((a) => a.suppressedSinceLastDelivery)).toEqual([0, 1, 0]);
  });
});

describe("suppression never silences a condition entirely", () => {
  it("every window ends: a condition flapping for a day still fires all day", async () => {
    const h = harness({ limits: { suppressionWindowMs: 300_000 } });
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      await h.alerts.raise(conditions.heartbeatMissed("sweeper"));
      h.clock.advance(60_000);
    }
    // 1440 minutes at a five-minute window: it keeps saying so, all day.
    expect(h.recorder.delivered.length).toBeGreaterThanOrEqual(287);
    expect(h.recorder.delivered.length).toBeLessThanOrEqual(289);
  });

  it("collapses only identical fingerprints, never two different cases", async () => {
    const h = harness();
    await h.alerts.raise(conditions.buried("c_one"));
    await h.alerts.raise(conditions.buried("c_two"));
    await h.alerts.raise(conditions.remindersStopped("c_one"));

    expect(h.recorder.delivered).toHaveLength(3);
  });

  it("can be switched off entirely by a zero window, and then fires every time", async () => {
    const h = harness({ limits: { suppressionWindowMs: 0 } });
    for (let i = 0; i < 5; i += 1) await h.alerts.raise(conditions.buried("c_zero"));
    expect(h.recorder.delivered).toHaveLength(5);
  });
});

describe("the suppression table is bounded, and eviction is louder rather than quieter", () => {
  it("evicts the least-recently-fired fingerprint and stays at its ceiling", async () => {
    const h = harness({ limits: { maxTrackedFingerprints: 4, suppressionWindowMs: 300_000 } });
    for (let i = 0; i < 20; i += 1) {
      await h.alerts.raise(conditions.buried(`c_${i}`));
      h.clock.advance(1_000);
    }
    const health = h.alerts.health();
    expect(health.suppressedFingerprints).toBe(4);
    expect(health.suppressionEvictions).toBe(16);
  });

  it("makes the next occurrence of an evicted fingerprint fire IMMEDIATELY", async () => {
    const h = harness({ limits: { maxTrackedFingerprints: 2, suppressionWindowMs: 3_600_000 } });
    await h.alerts.raise(conditions.buried("c_evicted"));
    await h.alerts.raise(conditions.buried("c_b"));
    await h.alerts.raise(conditions.buried("c_c")); // evicts c_evicted

    // Well inside the suppression window, and it fires anyway. A bound that made
    // an alert quieter would be a bound that hides the storm it exists for.
    const again = await h.alerts.raise(conditions.buried("c_evicted"));
    expect(again.outcome).toBe("delivered");
  });

  it("publishes the repeat counts eviction cost, rather than discarding them", async () => {
    const h = harness({ limits: { maxTrackedFingerprints: 1, suppressionWindowMs: 3_600_000 } });
    await h.alerts.raise(conditions.buried("c_x"));
    await h.alerts.raise(conditions.buried("c_x")); // collapsed: pending = 1
    await h.alerts.raise(conditions.buried("c_y")); // evicts c_x, losing the 1

    expect(h.alerts.health().suppressionRepeatsLost).toBe(1);
  });
});

describe("suppression is correct under concurrent raises", () => {
  it("collapses a burst arriving in one tick to exactly one delivery", async () => {
    const h = harness({ limits: { suppressionWindowMs: 300_000, maxInFlightDeliveries: 16 } });

    // The decision to fire and the record of it happen in one synchronous block
    // with no await between them. Without that, two of these both fire.
    await Promise.all(
      Array.from({ length: 32 }, () => h.alerts.raise(conditions.heartbeatMissed("sweeper"))),
    );

    expect(h.recorder.delivered).toHaveLength(1);
    expect(h.alerts.health().suppressed).toBe(31);
  });
});
