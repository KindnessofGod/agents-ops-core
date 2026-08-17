import { describe, expect, it } from "vitest";
import { CASE, POINT, RULE, SINK, harness, inertTimers, testClock } from "./fixtures.js";
import {
  AlertPayloadInvalid,
  createAlerts,
  raiseAndRecord,
  recordingAlertSink,
  type AlertCondition,
  type AlertRaiser,
} from "../index.js";

/**
 * `raiseAndRecord` — the one call `approval`, `audit`, `evals` and `guardrails`
 * make.
 *
 * It exists so there is exactly one answer to the three questions a detection
 * site would otherwise each answer differently: what happens when nobody wired
 * an `Alerts`, what happens when the chain is gone, and what the trace says
 * afterwards. Four modules writing their own try/catch around `raise` is four
 * different answers, and the one that matters — "nobody was told" — is the one
 * somebody would leave out.
 */

const condition: AlertCondition = {
  kind: "reserved-decision-completed-unassisted",
  correlationId: CASE("case-1"),
  decisionPoint: POINT("invoices.disburse"),
  reservedRule: RULE("PSR-2017-reg-90"),
  tier: "high",
};

describe("raiseAndRecord — node-shaped, and never throws", () => {
  it("reports a delivery, with the sink that took it", async () => {
    const h = harness();
    const record = await raiseAndRecord(h.alerts, condition);

    expect(record).toMatchObject({
      alert: true,
      alerted: "delivered",
      alertCondition: "reserved-decision-completed-unassisted",
      // Derived from the condition inside `alerts`. There is no parameter a
      // detection site could get wrong at 4pm on a Friday.
      alertSeverity: "incident",
      alertBy: "sink_recorder",
      alertDegradations: 0,
    });
  });

  it("says `not-configured` rather than nothing when no alerting was wired", async () => {
    const record = await raiseAndRecord(undefined, condition);

    // The whole reason every module's `alerting` is optional rather than
    // required: nineteen applications cannot be recompiled at once, and a
    // required parameter would have been satisfied everywhere with a sink that
    // swallows — which is worse than absence, because it looks wired.
    expect(record).toMatchObject({ alert: true, alerted: "not-configured" });
    expect(record.alertBy).toBeUndefined();
  });

  it("reports an undelivered alert rather than throwing one", async () => {
    const broken = createAlerts({
      sinks: [
        {
          ...recordingAlertSink({ id: SINK("sink_broken") }),
          deliver: () => Promise.reject(new Error("pager unreachable")),
        } as never,
      ],
      clock: testClock(),
      timers: inertTimers(),
    });

    const record = await raiseAndRecord(broken, condition);
    // An alert about a stalled case must never be the thing that takes the case
    // down. The failure is a fact, recorded as one.
    expect(record).toMatchObject({
      alerted: "undelivered",
      alertReason: "every-sink-failed",
      alertDegradations: 1,
    });
  });

  it("reports a suppressed repeat, carrying the collapsed count", async () => {
    const h = harness({ limits: { suppressionWindowMs: 60_000 } });
    const first = await raiseAndRecord(h.alerts, condition);
    const second = await raiseAndRecord(h.alerts, condition);

    expect(first.alerted).toBe("delivered");
    // Suppression collapses repeats; it never silences a condition. The window
    // ends, and the count rides on the next delivery.
    expect(second).toMatchObject({ alerted: "suppressed", alertSuppressedSince: 1 });
  });

  it("catches a caller defect instead of letting it replace the condition it was reporting", async () => {
    // A raiser that rejects the way `raise` does for a malformed payload. Inside
    // `alerts` that is correctly fail-closed, because the caller there is a
    // composition root that can fix it. Here the caller is a case that has just
    // been found to be in trouble, and converting "we detected a silent failure"
    // into "the case threw" loses the case AND the finding.
    const defective: AlertRaiser = {
      raise: () => Promise.reject(new AlertPayloadInvalid("unknownForMs", "1.5 is not an integer")),
    };

    const record = await raiseAndRecord(defective, condition);
    expect(record).toMatchObject({ alerted: "refused", alertError: "AlertPayloadInvalid" });
  });

  it("records an exception's NAME and never its message", async () => {
    const leaky: AlertRaiser = {
      raise: () => Promise.reject(new Error("failed for case of Jane Okafor, NI QQ123456C")),
    };

    const record = await raiseAndRecord(leaky, condition);
    // This record is spread onto a node in a seven-year append-only archive with
    // no un-writing. An exception message routinely echoes the input that
    // produced it, and no deny-list redactor catches a name in free prose.
    expect(record.alertError).toBe("Error");
    expect(JSON.stringify(record)).not.toContain("Okafor");
  });

  it("produces only flat payload-safe values, so a detection site can spread it onto a node", async () => {
    const h = harness();
    const record = await raiseAndRecord(h.alerts, condition);

    for (const [key, value] of Object.entries(record)) {
      const type = typeof value;
      expect(
        type === "string" || type === "number" || type === "boolean" || value === null,
        `${key} is ${type}`,
      ).toBe(true);
      // Integers only. Byte-stable serialisation is what makes replay possible
      // seven years later, and IEEE-754 is how it dies quietly.
      if (type === "number") expect(Number.isSafeInteger(value)).toBe(true);
    }
  });
});
