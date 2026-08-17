import { describe, expect, it } from "vitest";
import {
  AlertLimitsUnusable,
  AlertPayloadInvalid,
  DEFAULT_LIMITS,
  createAlerts,
  recordingAlertSink,
  type AlertCondition,
} from "../index.js";
import {
  CASE,
  SINK,
  conditions,
  hangingSink,
  harness,
  inertTimers,
  manualTimers,
  testClock,
} from "./fixtures.js";

/** Let every pending microtask run. */
const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Bounded concurrency, bounded queues, bounded retries — nothing unbounded.
 *
 * The alerting path is the last place to make an exception: a storm of
 * conditions is exactly when the process is already in trouble, and an unbounded
 * fan-out at that moment turns an incident into an outage caused by the incident
 * reporting. Every bound below **publishes what it shed**, because a bound that
 * discards quietly is a silent failure in the machinery built to find them.
 */

describe("concurrent deliveries are bounded, and the bound holds", () => {
  it("never exceeds maxInFlightDeliveries under a burst", async () => {
    const timers = manualTimers();
    const h = harness({
      timers,
      limits: { maxInFlightDeliveries: 3, maxQueuedRaises: 64, suppressionWindowMs: 0 },
    });

    await Promise.all(
      Array.from({ length: 40 }, (_, i) => h.alerts.raise(conditions.buried(`c_${i}`))),
    );

    expect(h.alerts.health().inFlightHighWater).toBeLessThanOrEqual(3);
    expect(h.recorder.delivered).toHaveLength(40);
  });

  it("queues rather than dropping while the queue has room", async () => {
    const timers = manualTimers();
    const slow = hangingSink("sink_slow");
    const h = harness({
      timers,
      sinks: [slow, recordingAlertSink({ id: SINK("sink_recorder") })],
      limits: { maxInFlightDeliveries: 1, maxQueuedRaises: 4, deliveryTimeoutMs: 1_000 },
    });

    const pending = [
      h.alerts.raise(conditions.buried("c_1")),
      h.alerts.raise(conditions.buried("c_2")),
      h.alerts.raise(conditions.buried("c_3")),
    ];
    await settle();
    expect(h.alerts.health().queueDepth).toBe(2);

    for (let i = 0; i < 3; i += 1) {
      timers.advance(1_000);
      await settle();
    }
    const results = await Promise.all(pending);
    expect(results.every((r) => r.outcome === "delivered")).toBe(true);
  });

  it("sheds LOUDLY when the queue is full, never silently", async () => {
    const timers = manualTimers();
    const h = harness({
      timers,
      sinks: [hangingSink("sink_slow")],
      limits: { maxInFlightDeliveries: 1, maxQueuedRaises: 1, deliveryTimeoutMs: 1_000 },
    });

    const first = h.alerts.raise(conditions.buried("c_1"));
    await settle();
    const queued = h.alerts.raise(conditions.buried("c_2"));
    await settle();
    const shed = await h.alerts.raise(conditions.buried("c_3"));

    expect(shed.outcome).toBe("undelivered");
    if (shed.outcome !== "undelivered") return;
    expect(shed.reason).toBe("delivery-queue-full");
    // Shedding is counted, ledgered and returned. A shed alert nobody could find
    // out about would be the module failing at its own subject.
    const health = h.alerts.health();
    expect(health.undelivered).toBe(1);
    expect(health.ledger[0]?.reason).toBe("delivery-queue-full");

    timers.advance(1_000);
    await settle();
    timers.advance(1_000);
    await settle();
    await Promise.all([first, queued]);
  });
});

describe("the last-resort ledger is bounded and says what fell off it", () => {
  it("keeps the most recent, counts the rest", async () => {
    const h = harness({
      sinks: [
        recordingAlertSink({ id: SINK("sink_none"), accepts: ["liveness-lost"] }),
      ],
      limits: { ledgerSize: 3, suppressionWindowMs: 0 },
    });

    for (let i = 0; i < 10; i += 1) await h.alerts.raise(conditions.buried(`c_${i}`));

    const health = h.alerts.health();
    expect(health.undelivered).toBe(10); // the monotonic total is never trimmed
    expect(health.ledger).toHaveLength(3);
    expect(health.ledger[0]?.correlationId).toBe(CASE("c_9"));
    expect(health.ledgerDropped).toBe(7);
  });
});

describe("there is no retry, and no timer this module owns", () => {
  it("bounds a hanging sink by an injected deadline, not by a wall clock", async () => {
    // With timers that never fire, a hanging sink hangs forever — which is the
    // proof that the deadline is injected rather than ambient. No test in this
    // suite waits on real time.
    const h = harness({
      timers: inertTimers(),
      sinks: [hangingSink("sink_slow"), recordingAlertSink({ id: SINK("sink_recorder") })],
    });
    let settled = false;
    void h.alerts.raise(conditions.buried("c_hang")).then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    expect(h.recorder.delivered).toHaveLength(0);
  });
});

describe("limits are validated at construction, not discovered during an incident", () => {
  const build = (limits: Record<string, number>) =>
    createAlerts({
      sinks: [recordingAlertSink()],
      clock: testClock(),
      timers: manualTimers(),
      limits,
    });

  it("refuses a queue of zero, a timeout of zero and a ledger of zero", () => {
    for (const [limit, value] of [
      ["maxQueuedRaises", 0],
      ["deliveryTimeoutMs", 0],
      ["ledgerSize", 0],
      ["maxInFlightDeliveries", 0],
      ["maxTrackedFingerprints", 0],
    ] as const) {
      try {
        build({ [limit]: value });
        expect.unreachable(`${limit}=${value} must not build`);
      } catch (error) {
        expect(error).toBeInstanceOf(AlertLimitsUnusable);
        expect((error as AlertLimitsUnusable).limit).toBe(limit);
      }
    }
  });

  it("refuses a fractional bound", () => {
    expect(() => build({ suppressionWindowMs: 1.5 })).toThrow(AlertLimitsUnusable);
  });

  it("ships defaults that are all bounds rather than policies", () => {
    for (const value of Object.values(DEFAULT_LIMITS)) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(DEFAULT_LIMITS.suppressionWindowMs).toBe(300_000);
  });
});

describe("payloads are refused before they become evidence", () => {
  it("refuses a float, because byte-stable serialisation dies quietly on one", async () => {
    const h = harness();
    const fractional = { ...conditions.remindersStopped("c_f"), overdueByMs: 1.5 };
    await expect(h.alerts.raise(fractional)).rejects.toBeInstanceOf(AlertPayloadInvalid);
  });

  it("refuses an unsafe integer and a NaN", async () => {
    const h = harness();
    await expect(
      h.alerts.raise({ ...conditions.remindersStopped("c_u"), remindersSent: 2 ** 60 }),
    ).rejects.toBeInstanceOf(AlertPayloadInvalid);
    await expect(
      h.alerts.raise({ ...conditions.remindersStopped("c_n"), overdueByMs: Number.NaN }),
    ).rejects.toBeInstanceOf(AlertPayloadInvalid);
  });

  it("refuses an identifier over the ceiling, so a page stays readable", async () => {
    const h = harness({ limits: { maxIdentifierChars: 32 } });
    const huge = conditions.buried("c".repeat(64)) as AlertCondition;
    await expect(h.alerts.raise(huge)).rejects.toBeInstanceOf(AlertPayloadInvalid);
  });

  it("refuses a clock that reports fractional milliseconds", async () => {
    const clock = testClock();
    clock.set(1_700_000_000_000.5);
    const alerts = createAlerts({
      sinks: [recordingAlertSink()],
      clock,
      timers: manualTimers(),
    });
    await expect(alerts.raise(conditions.buried("c_clock"))).rejects.toBeInstanceOf(
      AlertPayloadInvalid,
    );
  });

  it("throws for a caller defect and returns for a delivery failure", async () => {
    // The distinction the module's failure policy turns on: a defect is loud on
    // the first run; a delivery failure must never take the case down with it.
    const h = harness();
    await expect(
      h.alerts.raise({ ...conditions.buried("c_defect"), recurrenceCycles: 0.5 }),
    ).rejects.toThrow(AlertPayloadInvalid);
    await expect(h.alerts.raise(conditions.buried("c_ok"))).resolves.toMatchObject({
      outcome: "delivered",
    });
  });
});
