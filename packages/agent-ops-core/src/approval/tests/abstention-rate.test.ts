import { describe, expect, it } from "vitest";
import {
  createAlerts,
  recordingAlertSink,
  type AlertCondition,
  type Alerts,
} from "../../alerts/index.js";
import {
  defineDecisionPoint,
  type AbstentionRateTerms,
  type NoEffectPayload,
} from "../index.js";
import { CASE, harness, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, type Invoice } from "./fixtures/points.js";

/**
 * `README.md` item 11, the other half — **nothing watched the abstention rate.**
 *
 * `docs/CONTEXT.md`'s eighth silent condition is *"abstention rate, **or**
 * fail-closed screening rate, moves sharply — every individual case behaved
 * exactly as designed"*. `AlertCondition.measure` has always declared both arms.
 * `guardrails` produced `fail-closed-screening`. Nothing produced `abstention`,
 * so half of a named condition was a type with no writer.
 *
 * `approval` is what sees verdicts — `spec.decide` returns its `Determination`
 * here and nowhere else — so this is the only module in the library that can
 * count abstentions at all.
 *
 * ## Why a test here cannot page anybody, structurally
 *
 * The `Alerts` below is built over `recordingAlertSink` and an inert timer, and
 * that is a convenience rather than the guarantee. The guarantee is that
 * `alerts` constructs no HTTP client and reads no URL, token or routing key from
 * the environment: there is no code path from this package to a network to be
 * disabled, so live credentials in the environment change nothing and no
 * `SKIP_NETWORK` flag exists to be forgotten.
 */

const HOUR = 3_600_000;

const alertsFor = () => {
  const sink = recordingAlertSink();
  const alerts: Alerts = createAlerts({
    sinks: [sink],
    clock: { now: () => 1_700_000_000_000 },
    timers: { deadline: () => () => undefined },
    limits: { suppressionWindowMs: 0 },
  });
  const rates = (): readonly Extract<AlertCondition, { kind: "rate-moved-sharply" }>[] =>
    sink.delivered
      .map((a) => a.condition)
      .filter(
        (c): c is Extract<AlertCondition, { kind: "rate-moved-sharply" }> =>
          c.kind === "rate-moved-sharply",
      );
  return { alerts, sink, rates };
};

/**
 * A decision point that abstains when told to.
 *
 * Ungated and effect-free on purpose: an abstention is a **verdict**, a
 * successful outcome of a working system, and this fixture keeps everything else
 * out of the way so the only thing the window can be measuring is the verdict.
 */
const abstaining = (decideFor: (invoice: Invoice) => boolean) =>
  defineDecisionPoint<Invoice, string, NoEffectPayload>({
    id: "invoices.triage",
    schemaVersion: 1,
    gate: "never" as const,
    maxTier: "low" as const,
    effect: { kind: "no-effect" as const },
    tierFacts: () => ({ kind: "triage", moneyAtRiskMinor: 0 }),
    reservedFacts: () => ({ kind: "triage" }),
    decide: async (_client, invoice) =>
      decideFor(invoice)
        ? {
            kind: "concluded" as const,
            verdict: invoice.supplier,
            confidenceBasisPoints: 9_600,
            evidence: [{ kind: "document", ref: invoice.id }],
            spend: {
              costTenthCents: 12,
              tokensIn: 800,
              tokensOut: 40,
              priceTableVersion: "prices-2026-08",
            },
            proposes: null,
          }
        : {
            kind: "abstained" as const,
            reason: "classifier returned 503 twice; refusing to guess",
            evidence: [],
            spend: {
              costTenthCents: 12,
              tokensIn: 800,
              tokensOut: 0,
              priceTableVersion: "prices-2026-08",
            },
          },
  });

const TERMS: AbstentionRateTerms = {
  windowMs: HOUR,
  moveBasisPoints: 2_000,
  minSample: 4,
};

/**
 * Drive `count` cases through the point, abstaining on the first `abstentions`
 * of them, then advance the clock past the window's end so the next arrival
 * closes it.
 */
const setup = (terms: AbstentionRateTerms | undefined) => {
  let abstainNext = false;
  const point = abstaining(() => !abstainNext);
  const alerting = alertsFor();
  const h = harness({
    points: [point],
    tierPolicy: tierBy({ triage: "low" }),
    reservedPolicy: neverReserved(),
    alerting: alerting.alerts,
    ...(terms === undefined ? {} : { abstentionRate: terms }),
  });
  let seq = 0;
  const drive = async (count: number, abstentions: number) => {
    for (let i = 0; i < count; i += 1) {
      abstainNext = i < abstentions;
      seq += 1;
      await h.approval.run(point, { ...INVOICE, id: `inv_${seq}` }, {
        correlationId: CASE(`ab-${seq}`),
      });
    }
  };
  return { h, drive, ...alerting, lastCase: () => CASE(`ab-${seq}`) };
};

describe("the abstention rate is watched, and a sharp move is raised", () => {
  it("raises `rate-moved-sharply` with measure `abstention` when the rate jumps between windows", async () => {
    const s = setup(TERMS);

    // Window 1 — the baseline. Eight cases, none abstained. No alert can be
    // raised from it: there is nothing yet for a rate to have moved FROM.
    await s.drive(8, 0);
    s.h.clock.advance(HOUR + 1);
    expect(s.rates()).toHaveLength(0);

    // Window 2 — the first arrival closes window 1 and makes it the baseline.
    // The classifier starts failing: six of eight abstain.
    await s.drive(8, 6);
    expect(s.rates()).toHaveLength(0);
    s.h.clock.advance(HOUR + 1);

    // Window 3's first arrival closes window 2 and judges it against window 1.
    await s.drive(1, 0);

    const raised = s.rates();
    expect(raised).toHaveLength(1);
    const moved = raised[0];
    expect(moved?.measure).toBe("abstention");
    // A REAL decision point, not the finest truthful approximation of one —
    // `guardrails` can only name `input:high` because a screening does not know
    // which decision point it guards. This module does.
    expect(moved?.decisionPoint).toBe("invoices.triage");
    expect(moved?.baselineBasisPoints).toBe(0);
    expect(moved?.observedBasisPoints).toBe(7_500);
    expect(moved?.sampleSize).toBe(8);
    expect(moved?.windowMs).toBe(HOUR);
    // A window over a population is not a case, so the condition carries no
    // correlation identifier at all.
    expect("correlationId" in (moved ?? {})).toBe(false);

    // And it is a fact on a trace, not only a page. The node says outright that
    // it is about a window, so a reader in 2033 who finds it on one invoice does
    // not conclude the invoice was the problem.
    const nodes = (await s.h.audit.replay(s.lastCase())).nodes;
    const node = nodes.find((n) => n.payload["kind"] === "approval.abstention-rate-moved");
    expect(node).toBeDefined();
    expect(node?.payload["aboutThisCase"]).toBe(false);
    expect(node?.payload["pointId"]).toBe("invoices.triage");
    expect(node?.payload["alerted"]).toBe("delivered");
    expect(node?.payload["alertSeverity"]).toBe("notice");
  });

  it("raises on a collapse as well as a spike, because a rate that stops moving is also a change", async () => {
    const s = setup(TERMS);
    await s.drive(8, 8);
    s.h.clock.advance(HOUR + 1);
    await s.drive(8, 0);
    s.h.clock.advance(HOUR + 1);
    await s.drive(1, 0);

    const moved = s.rates()[0];
    expect(moved?.baselineBasisPoints).toBe(10_000);
    expect(moved?.observedBasisPoints).toBe(0);
  });

  it("believes neither window until both reach the minimum sample", async () => {
    const s = setup(TERMS);
    // Three cases, all abstaining: a 100% rate over a sample nobody should act
    // on. An alert built from noise is an alert that gets muted.
    await s.drive(3, 3);
    s.h.clock.advance(HOUR + 1);
    await s.drive(8, 0);
    s.h.clock.advance(HOUR + 1);
    await s.drive(1, 0);
    expect(s.rates()).toHaveLength(0);
  });

  it("stays silent for a move smaller than the declared sharpness", async () => {
    const s = setup(TERMS);
    await s.drive(8, 1); // 1,250 bp
    s.h.clock.advance(HOUR + 1);
    await s.drive(8, 2); // 2,500 bp — a move of 1,250, under the 2,000 declared
    s.h.clock.advance(HOUR + 1);
    await s.drive(1, 0);
    expect(s.rates()).toHaveLength(0);
  });

  it("never closes a window at all when the deployment stops deciding", async () => {
    const s = setup(TERMS);
    await s.drive(8, 0);
    // A fortnight of silence. Windows close lazily, on arrival, because this
    // module owns no timer — and **no decisions at all is not a rate movement**,
    // it is a stopped component. The sweeper's heartbeat and its external
    // watcher are what detect that. Two mechanisms for two different failures.
    s.h.clock.advance(14 * 24 * HOUR);
    expect(s.rates()).toHaveLength(0);
  });

  it("counts nothing and raises nothing where a deployment declared no terms", async () => {
    const s = setup(undefined);
    await s.drive(8, 0);
    s.h.clock.advance(HOUR + 1);
    await s.drive(8, 8);
    s.h.clock.advance(HOUR + 1);
    await s.drive(1, 0);
    expect(s.rates()).toHaveLength(0);
    const nodes = (await s.h.audit.replay(s.lastCase())).nodes;
    expect(nodes.map((n) => n.payload["kind"])).not.toContain("approval.abstention-rate-moved");
  });
});

describe("a window that moved with nowhere to raise is visibly unmonitored", () => {
  it("still writes the node, saying `not-configured` rather than looking monitored", async () => {
    let abstainNext = false;
    const point = abstaining(() => !abstainNext);
    // No `alerting` at all. The detection still happens and still writes.
    const h = harness({
      points: [point],
      tierPolicy: tierBy({ triage: "low" }),
      reservedPolicy: neverReserved(),
      abstentionRate: TERMS,
    });
    let seq = 0;
    const drive = async (count: number, abstentions: number) => {
      for (let i = 0; i < count; i += 1) {
        abstainNext = i < abstentions;
        seq += 1;
        await h.approval.run(point, { ...INVOICE, id: `inv_${seq}` }, {
          correlationId: CASE(`nc-${seq}`),
        });
      }
    };
    await drive(8, 0);
    h.clock.advance(HOUR + 1);
    await drive(8, 6);
    h.clock.advance(HOUR + 1);
    await drive(1, 0);

    const node = (await h.audit.replay(CASE(`nc-${seq}`))).nodes.find(
      (n) => n.payload["kind"] === "approval.abstention-rate-moved",
    );
    expect(node?.payload["alerted"]).toBe("not-configured");
    expect(node?.payload["alert"]).toBe(true);
  });
});
