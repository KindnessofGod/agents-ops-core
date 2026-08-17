import { describe, expect, it } from "vitest";
import { CASE_A, degradeBelowHigh, harness, strictPolicy } from "./fixtures.js";
import { TraceUnavailable, inMemoryTraceStore, type StoredCase, type TraceStore } from "../index.js";
import { createAlerts, recordingAlertSink, type Alerts } from "../../alerts/index.js";

/**
 * The seventh silent condition, and the strangest one: **trace unavailable at
 * high tier**.
 *
 * `docs/CONTEXT.md`: *"Fail-closed is correct **and** means work has stopped.
 * Correct behaviour is still an incident."* Nothing here is malfunctioning. The
 * module is doing precisely what it exists to do — refusing to let a £2M
 * disbursement proceed unrecorded — and the only outward sign is a well-named
 * error, which is exactly the shape of thing a retry loop catches. Nineteen
 * applications quietly stop making high-tier decisions, and every dashboard
 * stays green.
 */

/** A store that is up for `openCase` and `read`, and down for every write. */
const brokenOnWrite = (inner: TraceStore): TraceStore => ({
  ...inner,
  async append() {
    throw new Error("connection reset by peer");
  },
  async closeCase() {
    throw new Error("connection reset by peer");
  },
  read: (correlationId): Promise<StoredCase | undefined> => inner.read(correlationId),
});

const alertsFor = () => {
  const sink = recordingAlertSink();
  const alerts: Alerts = createAlerts({
    sinks: [sink],
    clock: { now: () => 1_700_000_000_000 },
    timers: { deadline: () => () => undefined },
    limits: { suppressionWindowMs: 0 },
  });
  return { alerts, sink };
};

const failedWrite = async (
  tier: "low" | "medium" | "high",
  alerting?: Alerts,
  policy = degradeBelowHigh,
): Promise<TraceUnavailable> => {
  const { audit } = harness({
    store: brokenOnWrite(inMemoryTraceStore()),
    onTraceUnavailable: policy,
    ...(alerting === undefined ? {} : { alerting }),
  });
  const trace = await audit.open(CASE_A);
  const failure = await trace.record({ kind: "payment.authorised", v: 1 }, { tier }).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(failure instanceof TraceUnavailable)) throw new Error("expected TraceUnavailable");
  return failure;
};

describe("trace unavailable at high tier", () => {
  it("raises, and the record travels on the error because there is no trace to write it to", async () => {
    const a = alertsFor();
    const failure = await failedWrite("high", a.alerts);

    expect(a.sink.delivered).toHaveLength(1);
    const condition = a.sink.delivered[0]?.condition;
    expect(condition?.kind).toBe("trace-unavailable-at-high-tier");
    expect(condition).toMatchObject({ correlationId: CASE_A, reason: "store-failure" });

    // Every other alert in this library is recorded as a node on the case's own
    // trace. This is the one condition where that is impossible by definition —
    // the trace is the thing that just failed — so the record lives on the
    // exception, and a caller holding it is holding the whole story.
    expect(failure.alerting).toMatchObject({
      alert: true,
      alerted: "delivered",
      alertCondition: "trace-unavailable-at-high-tier",
      alertSeverity: "incident",
    });
  });

  it("says `not-configured` rather than silently nothing when no alerting was wired", async () => {
    const failure = await failedWrite("high");
    expect(failure.alerting).toMatchObject({ alerted: "not-configured" });
  });

  it("does not raise at medium tier, where the fail policy is the application's own choice", async () => {
    const a = alertsFor();
    // Under `strictPolicy` a medium-tier write fails closed too, so this throws
    // exactly as the high-tier case does — and it is still not an incident.
    // Paging an operator because an application declared a strict policy and the
    // policy held is how the channel that carries the other seven conditions
    // gets muted. The tier is the whole of the difference.
    const failure = await failedWrite("medium", a.alerts, strictPolicy);
    expect(failure.alerting).toBeUndefined();
    expect(a.sink.delivered).toHaveLength(0);
  });

  it("does not raise when a low-tier write is degraded, because nothing stopped", async () => {
    const a = alertsFor();
    const { audit } = harness({
      store: brokenOnWrite(inMemoryTraceStore()),
      onTraceUnavailable: degradeBelowHigh,
      alerting: a.alerts,
    });
    const trace = await audit.open(CASE_A);
    const outcome = await trace.record({ kind: "note", v: 1 }, { tier: "low" });

    expect(outcome.recorded).toBe(false);
    // The decision proceeded and the gap was recorded. That is the policy
    // working as the application declared it, not an incident.
    expect(a.sink.delivered).toHaveLength(0);
  });

  it("a broken alert chain does not change what the caller receives", async () => {
    const brokenChain = createAlerts({
      sinks: [
        {
          ...recordingAlertSink({ id: "sink_broken" as never }),
          deliver: () => Promise.reject(new Error("pager unreachable")),
        } as never,
      ],
      clock: { now: () => 0 },
      timers: { deadline: () => () => undefined },
    });
    const failure = await failedWrite("high", brokenChain);

    // Fail-closed is still fail-closed. The alerting failing is a second fact,
    // recorded as one, and it does not soften the first.
    expect(failure).toBeInstanceOf(TraceUnavailable);
    expect(failure.alerting).toMatchObject({
      alerted: "undelivered",
      alertReason: "every-sink-failed",
    });
    expect(brokenChain.health().undelivered).toBe(1);
  });
});
