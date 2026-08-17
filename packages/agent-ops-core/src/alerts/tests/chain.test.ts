import { describe, expect, it } from "vitest";
import {
  operationalStreamAlertSink,
  pagingAlertSink,
  recordingAlertSink,
  type AlertSink,
} from "../index.js";
import {
  ROTA,
  SINK,
  conditions,
  hangingSink,
  harness,
  manualTimers,
  testPageTransport,
  testStream,
  throwingSink,
} from "./fixtures.js";

/** Let every pending microtask run, so a raise reaches its first sink. */
const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Requirement (f): failure to alert is itself alertable.
 *
 * Three obligations, and the third is the one usually skipped:
 *
 *   1. A sink that throws **must not take the case down with it**. `raise` does
 *      not reject for a delivery problem, ever.
 *   2. It **must not fail silently**. The failure degrades to the next sink and
 *      the degradation is recorded — on the outcome, in the journal, and in
 *      `health()`.
 *   3. When the whole chain is gone, the fact is still recorded and still
 *      published, rather than an alert about the alerting being raised through
 *      the alerting that is down.
 */

describe("a sink that throws degrades to the next, loudly", () => {
  it("delivers through the second sink and records the first's failure", async () => {
    const stream = testStream();
    const h = harness({
      sinks: [
        throwingSink("sink_pager", () => new TypeError("pager exploded")),
        operationalStreamAlertSink({ id: SINK("sink_stream"), stream }),
      ],
    });

    const result = await h.alerts.raise(conditions.effectUnknown("c_deg"));

    expect(result.outcome).toBe("delivered");
    if (result.outcome !== "delivered") return;
    expect(result.by).toBe("sink_stream");
    expect(result.degradations).toHaveLength(1);
    expect(result.degradations[0]).toMatchObject({ sink: "sink_pager", reason: "threw" });
    expect(stream.written).toHaveLength(1);
    expect(h.alerts.health().degradations).toBe(1);
  });

  it("never rejects, so an alert about a stalled case cannot stall the case", async () => {
    const h = harness({ sinks: [throwingSink("sink_only", () => new Error("gone"))] });
    // The alerting is completely broken and the caller still gets a value back.
    await expect(h.alerts.raise(conditions.buried("c_never_throws"))).resolves.toMatchObject({
      outcome: "undelivered",
    });
  });

  it("records the exception's NAME and never its message", async () => {
    // A transport's message routinely echoes the request it failed on, and that
    // request carries identifiers at best and a payload at worst. No personal
    // data in traces is not a rule that survives hoping a third party's error
    // text is clean.
    const h = harness({
      sinks: [
        throwingSink("sink_pager", () => new Error("failed to page jane.doe@example.com about £47,200")),
        recordingAlertSink({ id: SINK("sink_recorder") }),
      ],
    });
    const result = await h.alerts.raise(conditions.reservedUnassisted("c_pii"));
    if (result.outcome !== "delivered") throw new Error("expected delivery");
    expect(result.degradations[0]?.detail).toBe("Error");
    expect(JSON.stringify(result.degradations)).not.toContain("jane.doe");
  });
});

describe("a sink that hangs is bounded by a deadline, not by hope", () => {
  it("times out, degrades, and names the timeout as the reason", async () => {
    const timers = manualTimers();
    const stream = testStream();
    const h = harness({
      timers,
      sinks: [
        hangingSink("sink_pager"),
        operationalStreamAlertSink({ id: SINK("sink_stream"), stream }),
      ],
      limits: { deliveryTimeoutMs: 5_000 },
    });

    const pending = h.alerts.raise(conditions.heartbeatMissed("sweeper"));
    await settle();
    expect(stream.written).toHaveLength(0); // still stuck on the first sink

    timers.advance(5_000);
    const result = await pending;

    expect(result.outcome).toBe("delivered");
    if (result.outcome !== "delivered") return;
    expect(result.by).toBe("sink_stream");
    expect(result.degradations[0]).toMatchObject({
      sink: "sink_pager",
      reason: "timed-out",
      detail: "no answer in 5000ms",
    });
  });

  it("cancels the deadline once a sink answers, so nothing is left pending", async () => {
    const timers = manualTimers();
    const h = harness({ timers });
    await h.alerts.raise(conditions.buried("c_cancel"));
    expect(timers.pending()).toBe(0);
  });
});

describe("a sink that breaks the acknowledgement contract", () => {
  it("is a recorded degradation, not a silent success", async () => {
    // A sink that resolves with something that is not an acknowledgement has
    // told us nothing. Treating that as delivery would be exactly the
    // "acknowledged but never written" hole audit closes on its own seam.
    const liar = {
      id: SINK("sink_liar"),
      delivery: "operational-stream",
      accepts: ["notice", "degraded", "incident", "liveness-lost"],
      deliver: () => Promise.resolve(undefined),
    } as unknown as AlertSink;
    const recorder = recordingAlertSink({ id: SINK("sink_recorder") });
    const h = harness({ sinks: [liar, recorder] });

    const result = await h.alerts.raise(conditions.underRecording("c_liar"));

    if (result.outcome !== "delivered") throw new Error("expected delivery");
    expect(result.by).toBe("sink_recorder");
    expect(result.degradations[0]).toMatchObject({
      sink: "sink_liar",
      reason: "contract-violated",
    });
  });
});

describe("when the whole chain is gone", () => {
  it("returns undelivered, ledgers it, and publishes it in health()", async () => {
    const h = harness({
      sinks: [
        throwingSink("sink_a", () => new Error("a")),
        throwingSink("sink_b", () => new Error("b")),
      ],
    });

    const result = await h.alerts.raise(conditions.effectUnknown("c_gone"));

    expect(result.outcome).toBe("undelivered");
    if (result.outcome !== "undelivered") return;
    expect(result.reason).toBe("every-sink-failed");
    expect(result.degradations.map((d) => d.sink)).toEqual(["sink_a", "sink_b"]);

    const health = h.alerts.health();
    expect(health.undelivered).toBe(1);
    expect(health.degradations).toBe(2);
    // The external watcher reads this. It is where the regress stops: an alert
    // about the alerting cannot be delivered by the alerting that is down.
    expect(health.ledger[0]).toMatchObject({
      condition: "effect-outcome-unknown",
      reason: "every-sink-failed",
      correlationId: "c_gone",
    });
  });

  it("distinguishes a chain that FAILED from one that merely DECLINED", async () => {
    // A misconfiguration and an outage are different sentences to say to an
    // operator, and only one of them is fixed by restarting something.
    const pager = pagingAlertSink({
      id: SINK("sink_pager"),
      rota: ROTA("rota_oncall"),
      transport: testPageTransport(),
    });
    const h = harness({ sinks: [pager] });

    const result = await h.alerts.raise(conditions.rateMoved());

    expect(result.outcome).toBe("undelivered");
    if (result.outcome !== "undelivered") return;
    expect(result.reason).toBe("declined-by-every-sink");
    expect(result.degradations).toHaveLength(0);
  });

  it("still journals the undelivered alert, so the failure is evidence", async () => {
    const h = harness({ sinks: [throwingSink("sink_a", () => new Error("a"))] });
    await h.alerts.raise(conditions.traceUnavailableHigh("c_evidence"));
    expect(h.journal?.entries).toHaveLength(1);
    expect(h.journal?.entries[0]).toMatchObject({
      outcome: "undelivered",
      deliveredBy: undefined,
      correlationId: "c_evidence",
    });
  });
});

describe("the chain is ordered, and the order is honoured", () => {
  it("stops at the first sink that accepts", async () => {
    const first = recordingAlertSink({ id: SINK("sink_first") });
    const second = recordingAlertSink({ id: SINK("sink_second") });
    const h = harness({ sinks: [first, second] });

    await h.alerts.raise(conditions.buried("c_order"));

    expect(first.delivered).toHaveLength(1);
    expect(second.delivered).toHaveLength(0);
  });

  it("does not retry a sink — the chain is the redundancy", async () => {
    let attempts = 0;
    const counting = pagingAlertSink({
      id: SINK("sink_count"),
      rota: ROTA("rota_oncall"),
      accepts: ["notice", "degraded", "incident", "liveness-lost"],
      transport: {
        send() {
          attempts += 1;
          return Promise.reject(new Error("down"));
        },
      },
    });
    const h = harness({ sinks: [counting, recordingAlertSink({ id: SINK("sink_recorder") })] });

    await h.alerts.raise(conditions.heartbeatMissed());

    // One attempt. A retry loop in the alerting path is a queue that grows while
    // the thing being alerted about gets worse.
    expect(attempts).toBe(1);
  });
});
