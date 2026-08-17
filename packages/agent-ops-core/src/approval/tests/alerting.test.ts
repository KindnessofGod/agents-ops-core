import { describe, expect, it } from "vitest";
import {
  createAlerts,
  recordingAlertSink,
  type AlertCondition,
  type AlertConditionKind,
  type Alerts,
  type ComponentId,
  type Heartbeat,
  type HeartbeatRun,
} from "../../alerts/index.js";
import {
  DEFAULT_SWEEPER_COMPONENT,
  EXTERNAL_WATCHDOG_REQUIREMENT,
  defineDecisionPoint,
} from "../index.js";
import { CASE, POOL, alwaysReserved, directory, harness, ladder, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, delegatedDisbursement, disburse, gatedDisbursement } from "./fixtures/points.js";

/**
 * Five of `docs/CONTEXT.md`'s eight silent conditions are visible **only from
 * inside this module**, and until this file existed not one of them reached an
 * operator. Each returns success or returns nothing at all; none is reachable by
 * catching an exception. These tests prove they are raised.
 *
 * ## Why a test here cannot page anybody, structurally
 *
 * `alertsFor` below builds an `Alerts` over `recordingAlertSink` and an inert
 * timer. That is not the thing that makes this hermetic — it is a convenience.
 * What makes it hermetic is that `alerts` constructs no HTTP client and reads no
 * URL, token or routing key from the environment: every transport is a
 * constructor parameter. There is no code path from this package to a network to
 * be disabled, so live credentials in the environment change nothing, and no
 * `SKIP_NETWORK` flag exists to be forgotten.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An `Alerts` a test holds. Records; reaches nothing. */
const alertsFor = () => {
  const sink = recordingAlertSink();
  const alerts: Alerts = createAlerts({
    sinks: [sink],
    clock: { now: () => 1_700_000_000_000 },
    // Deadlines that never fire: delivery is bounded by the recording sink,
    // which answers synchronously. No `setTimeout` is armed by these tests.
    timers: { deadline: () => () => undefined },
    // Suppression collapses repeats by fingerprint, and several of these tests
    // sweep the same case twice. Zero means every occurrence is delivered, so an
    // assertion counts what was raised rather than what survived a window.
    limits: { suppressionWindowMs: 0 },
  });
  const conditions = (): readonly AlertCondition[] => sink.delivered.map((a) => a.condition);
  const kinds = (): readonly AlertConditionKind[] => conditions().map((c) => c.kind);
  const only = <K extends AlertConditionKind>(kind: K) =>
    conditions().filter((c): c is Extract<AlertCondition, { kind: K }> => c.kind === kind);
  return { alerts, sink, kinds, only };
};

/**
 * A gated decision point that concludes and **proposes no effect**.
 *
 * This is the path that makes silent condition 1 reachable at all. A reserved
 * gated point normally suspends and can only be settled by `answer`, which
 * transfers authority — but a decision that proposes nothing never reaches the
 * gate. The system concluded, decided there was nothing to do, and ended a case
 * the law reserved to a human, returning an ordinary `no-effect` that every
 * caller reads as success. No money moved, so nothing downstream notices.
 */
const concludesNothing = (id = "invoices.close_without_payment") =>
  defineDecisionPoint({
    id,
    schemaVersion: 1,
    gate: "human" as const,
    maxTier: "high" as const,
    pool: POOL,
    dualControlAtOrAbove: "never" as const,
    licenceValidFor: DAY,
    tierFacts: () => ({ kind: "disburse", moneyAtRiskMinor: 4_720_000 }),
    reservedFacts: () => ({ kind: "disburse", supplier: "acme-ltd" }),
    decide: async () => ({
      kind: "concluded" as const,
      verdict: { close: true },
      confidenceBasisPoints: 9_900,
      evidence: [{ kind: "document", ref: "inv_88213" }],
      spend: {
        costTenthCents: 12,
        tokensIn: 100,
        tokensOut: 10,
        priceTableVersion: "prices-2026-08",
      },
      // The whole point of this fixture.
      proposes: null,
    }),
    // A real effect declaration, never reached: this point proposes nothing, so
    // the gate is never crossed and `execute` is never called. Declaring one is
    // still required, because a gated point without an effect is not a gate.
    effect: disburse(),
    doNothing: { ladder: ladder() },
    brief: () => ({
      effectInConcreteTerms: "Nothing leaves the account.",
      concluded: {
        statement: "No payment is due.",
        evidence: [{ kind: "document", ref: "inv_88213" }],
      },
      unsureAbout: [{ kind: "nothing-material" as const, because: "The invoice was withdrawn." }],
      contrary: { searchedAndFoundNone: { searched: "later re-submissions of this invoice" } },
      couldNotCheck: {
        everythingRequiredWasChecked: { checklist: "invoice-withdrawal-2026-08" },
      },
    }),
  });

/** A heartbeat a test holds, recording every beat in order. */
const heartbeatFor = (failing = false) => {
  const beats: { component: ComponentId; run: HeartbeatRun }[] = [];
  const heartbeat: Heartbeat = {
    beat: async (input) => {
      if (failing) throw new Error("liveness store unavailable");
      beats.push(input);
      return { component: input.component, at: 0, run: input.run, sequence: beats.length };
    },
  };
  return { heartbeat, beats };
};

describe("silent condition 1 — a reserved decision completed unassisted", () => {
  /**
   * The quietest breach available. The system concluded, proposed nothing, and
   * ended a case the law reserved to a human — returning a perfectly ordinary
   * `no-effect` that every caller's state machine reads as success.
   */
  it("raises when a reserved decision settles with no authority involved", async () => {
    const a = alertsFor();
    const point = concludesNothing();
    const h = harness({
      points: [point],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: alwaysReserved(),
      evidence: { [INVOICE.id]: { matched: true } },
      alerting: a.alerts,
    });

    const settled = await h.approval.run(point, INVOICE, {
      correlationId: CASE("reserved-unassisted"),
    });
    expect(settled.kind).toBe("no-effect");

    const raised = a.only("reserved-decision-completed-unassisted");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.reservedRule).toBe("PSR-2017-reg-90");
    expect(raised[0]?.tier).toBe("high");
  });

  it("stays silent when the same decision is not reserved", async () => {
    const a = alertsFor();
    const point = concludesNothing("invoices.quiet");
    const h = harness({
      points: [point],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
      evidence: { [INVOICE.id]: { matched: true } },
      alerting: a.alerts,
    });

    await h.approval.run(point, INVOICE, { correlationId: CASE("not-reserved") });
    // The alert is about a legal obligation, not about automation. A
    // non-reserved decision completing unassisted is the intended path.
    expect(a.kinds()).toHaveLength(0);
  });
});

describe("silent condition 2 — an effect whose outcome is unrecorded", () => {
  it("raises when the executor reports `unknown`", async () => {
    const a = alertsFor();
    const point = delegatedDisbursement(async () => ({
      kind: "unknown",
      reason: "provider timed out after the request was accepted",
    }));
    const h = harness({
      points: [point],
      tierPolicy: tierBy({ small: "low" }),
      reservedPolicy: neverReserved(),
      alerting: a.alerts,
    });

    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("in-doubt") }),
    ).rejects.toThrow(/in doubt/);

    const raised = a.only("effect-outcome-unknown");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.effectKind).toBe("disburse");
    expect(raised[0]?.tier).toBe("low");
  });

  it("raises when the executor throws, which is the same fact by a different route", async () => {
    const a = alertsFor();
    const point = delegatedDisbursement(async () => {
      throw new Error("socket hung up mid-request");
    });
    const h = harness({
      points: [point],
      tierPolicy: tierBy({ small: "low" }),
      reservedPolicy: neverReserved(),
      alerting: a.alerts,
    });

    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("in-doubt-threw") }),
    ).rejects.toThrow(/in doubt/);
    expect(a.only("effect-outcome-unknown")).toHaveLength(1);
  });

  it("stays silent for `not-attempted`, which is safe to retry and is not in doubt", async () => {
    const a = alertsFor();
    const point = delegatedDisbursement(async () => ({
      kind: "not-attempted",
      reason: "the provider refused the request before sending it",
    }));
    const h = harness({
      points: [point],
      tierPolicy: tierBy({ small: "low" }),
      reservedPolicy: neverReserved(),
      alerting: a.alerts,
    });

    await h.approval.run(point, INVOICE, { correlationId: CASE("not-attempted") });
    // Three idempotency states, and only one of them is a possible double
    // payment. Collapsing them here would page somebody for a clean refusal.
    expect(a.kinds()).toHaveLength(0);
  });
});

describe("silent condition 5 — nobody to escalate to", () => {
  it("raises when the directory offers no candidates, and the case still suspends", async () => {
    const a = alertsFor();
    const h = harness({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
      // "Looks like a queue with nothing in it."
      authorities: directory([]),
      evidence: { [INVOICE.id]: { matched: true } },
      alerting: a.alerts,
    });

    const result = await h.approval.run(gatedDisbursement(), INVOICE, {
      correlationId: CASE("no-authority"),
    });
    // Never fail-open: the case is suspended and the ladder keeps running.
    // Nothing threw, which is precisely why this needed an alert.
    expect(result.kind).toBe("suspended");

    const raised = a.only("authority-unavailable");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.pool).toBe(POOL);
    expect(raised[0]?.reserved).toBe("not-reserved");
  });

  it("says `reserved` when it is, because that is the case with no lawful terminal state", async () => {
    const a = alertsFor();
    const h = harness({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: alwaysReserved(),
      authorities: directory([]),
      evidence: { [INVOICE.id]: { matched: true } },
      alerting: a.alerts,
    });

    await h.approval.run(gatedDisbursement(), INVOICE, {
      correlationId: CASE("no-authority-reserved"),
    });
    expect(a.only("authority-unavailable")[0]?.reserved).toBe("reserved");
  });
});

describe("silent conditions 3 and 4 — reminders stopped, and a buried case", () => {
  const buriedSetup = (alerts: Alerts) =>
    harness({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
      evidence: { [INVOICE.id]: { matched: true } },
      alerting: alerts,
    });

  it("raises `case-buried` once the scheduled ladder is spent and nobody has answered", async () => {
    const a = alertsFor();
    const h = buriedSetup(a.alerts);
    const suspended = await h.approval.run(gatedDisbursement(), INVOICE, {
      correlationId: CASE("buried"),
    });
    expect(suspended.kind).toBe("suspended");

    // The default ladder has two scheduled steps at 4h and 24h; past those it is
    // in recurrence, which is the definition of buried.
    for (const wait of [5 * HOUR, DAY, DAY]) {
      h.clock.advance(wait);
      await h.approval.sweep({ limit: 10 });
    }

    const raised = a.only("case-buried");
    expect(raised.length).toBeGreaterThanOrEqual(1);
    expect(raised[0]?.pool).toBe(POOL);
    // Buried does not mean the chasing stopped. The reminders kept going.
    expect(h.renderer.reminders.length).toBeGreaterThanOrEqual(3);
  });

  it("raises `reminders-stopped` when a case arrives a whole recurrence interval late", async () => {
    const a = alertsFor();
    const h = buriedSetup(a.alerts);
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("unchased") });

    // One healthy pass, so the case is presented and the ladder has a position.
    h.clock.advance(5 * HOUR);
    await h.approval.sweep({ limit: 10 });
    expect(a.kinds()).not.toContain("reminders-stopped");

    // Now nothing sweeps for a fortnight. Nothing errors; the case simply stops
    // being chased, which is the whole of the condition.
    h.clock.advance(14 * DAY);
    await h.approval.sweep({ limit: 10 });

    const raised = a.only("reminders-stopped");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.expectedEveryMs).toBe(ladder().recurrence.every);
    expect(raised[0]?.overdueByMs).toBeGreaterThan(ladder().recurrence.every);
  });

  it("stays silent while the sweeper is keeping up", async () => {
    const a = alertsFor();
    const h = buriedSetup(a.alerts);
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("chased") });

    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(5 * HOUR);
      await h.approval.sweep({ limit: 10 });
    }
    expect(a.kinds()).not.toContain("reminders-stopped");
  });
});

describe("the alert path is injected, and its absence is recorded rather than assumed", () => {
  it("a deployment that wired no alerting still detects, still suspends, and says so on the node", async () => {
    const h = harness({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
      authorities: directory([]),
      evidence: { [INVOICE.id]: { matched: true } },
      // No `alerting`.
    });

    const result = await h.approval.run(gatedDisbursement(), INVOICE, {
      correlationId: CASE("unwired"),
    });
    expect(result.kind).toBe("suspended");

    const replayed = await h.audit.replay(CASE("unwired"));
    const node = replayed.nodes.find((n) => n.payload["kind"] === "approval.authority-unavailable");
    expect(node).toBeDefined();
    // The point of the whole exercise: "nobody was told" and "somebody was told"
    // are different rows in the archive, seven years from now.
    expect(node?.payload["alerted"]).toBe("not-configured");
    expect(node?.payload["alert"]).toBe(true);
  });

  it("records the delivery on the node when alerting IS wired", async () => {
    const a = alertsFor();
    const h = harness({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
      authorities: directory([]),
      evidence: { [INVOICE.id]: { matched: true } },
      alerting: a.alerts,
    });

    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("wired") });
    const replayed = await h.audit.replay(CASE("wired"));
    const node = replayed.nodes.find((n) => n.payload["kind"] === "approval.authority-unavailable");
    expect(node?.payload["alerted"]).toBe("delivered");
    expect(node?.payload["alertSeverity"]).toBe("incident");
    expect(node?.payload["alertDegradations"]).toBe(0);
  });

  it("a chain that reaches nobody does not take the case down, and the node says undelivered", async () => {
    // Every sink throws. `raise` must not reject, the case must still suspend,
    // and the failure must be a recorded fact rather than an exception that
    // replaces the condition it was reporting.
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
    const h = harness({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
      authorities: directory([]),
      evidence: { [INVOICE.id]: { matched: true } },
      alerting: brokenChain,
    });

    const result = await h.approval.run(gatedDisbursement(), INVOICE, {
      correlationId: CASE("chain-gone"),
    });
    expect(result.kind).toBe("suspended");

    const replayed = await h.audit.replay(CASE("chain-gone"));
    const node = replayed.nodes.find((n) => n.payload["kind"] === "approval.authority-unavailable");
    expect(node?.payload["alerted"]).toBe("undelivered");
    expect(node?.payload["alertReason"]).toBe("every-sink-failed");
    expect(node?.payload["alertDegradations"]).toBe(1);
    // And the fact is published where an external watcher reads it.
    expect(brokenChain.health().undelivered).toBe(1);
  });
});

describe("⚠ the sweeper's heartbeat, and the watcher that is not in this library", () => {
  const swept = (over: Parameters<typeof harness>[0]) => harness(over);

  it("beats on a run that found nothing to do — the whole reason it exists", async () => {
    const { heartbeat, beats } = heartbeatFor();
    const h = swept({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
      heartbeat,
    });

    const report = await h.approval.sweep({ limit: 10 });
    expect(report.examined).toBe(0);
    expect(report.heartbeat).toBe("nothing-was-due");
    expect(beats).toHaveLength(1);
    expect(beats[0]?.run).toEqual({ ran: "nothing-was-due" });
    expect(beats[0]?.component).toBe(DEFAULT_SWEEPER_COMPONENT);
  });

  it("`nothing was due` and `I did work` are different sentences, and neither can spell `I did not run`", async () => {
    const { heartbeat, beats } = heartbeatFor();
    const h = swept({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
      evidence: { [INVOICE.id]: { matched: true } },
      heartbeat,
    });
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("beat") });
    h.clock.advance(5 * HOUR);

    const report = await h.approval.sweep({ limit: 10 });
    expect(report.heartbeat).toBe("did-work");
    expect(beats[0]?.run).toEqual({ ran: "did-work", itemsProcessed: 1 });
    // The empty arm carries no `itemsProcessed` at all, so "I did nothing"
    // cannot be written as "I did zero things" and later be read as a batch of
    // zero. "I did not run" is the ABSENCE of a beat and is unspellable here.
    expect(Object.keys({ ran: "nothing-was-due" })).toEqual(["ran"]);
  });

  it("a sweep with no heartbeat wired completes and says nothing is watching it", async () => {
    const h = swept({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
    });
    expect((await h.approval.sweep({ limit: 10 })).heartbeat).toBe("not-configured");
  });

  it("a beat that cannot be stored does not discard a completed sweep", async () => {
    const { heartbeat } = heartbeatFor(true);
    const h = swept({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
      evidence: { [INVOICE.id]: { matched: true } },
      heartbeat,
    });
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("beat-fails") });
    h.clock.advance(5 * HOUR);

    const report = await h.approval.sweep({ limit: 10 });
    // The reminder was sent and the ladder advanced. Throwing that away because
    // a liveness row would not write is strictly worse than reporting it.
    expect(report.remindersSent).toBe(1);
    expect(report.heartbeat).toBe("failed");
  });

  it("names the component the same way the emitter and an external watcher must", () => {
    // A watcher pointed at a name nothing emits reports `never-seen` forever,
    // which reads as a dead sweeper and trains an operator to ignore the alert
    // that outranks every other alert in the system.
    expect(DEFAULT_SWEEPER_COMPONENT).toBe("approval.sweeper");
  });

  it("re-exports the external-watchdog requirement rather than restating it", () => {
    // A sentence this important that exists in two places will eventually exist
    // in two versions. `docs/RUNBOOK.md` must carry this verbatim.
    expect(EXTERNAL_WATCHDOG_REQUIREMENT.length).toBeGreaterThan(0);
    expect(EXTERNAL_WATCHDOG_REQUIREMENT.toLowerCase()).toContain("outside");
  });
});
