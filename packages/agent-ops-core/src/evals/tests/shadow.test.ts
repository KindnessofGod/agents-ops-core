import { describe, expect, it } from "vitest";
import { createAudit, inMemoryTraceStore, redactFields, systemClock } from "../../audit/index.js";
import type { CorrelationId } from "../../audit/index.js";
import {
  abstain,
  defineSubject,
  determine,
  exactVerdict,
  humanDecisionsFromAuditTrace,
  INTERPRETATION,
  legacyReviewerExport,
  recordedCases,
  run,
  SubjectAttemptedWrite,
} from "../index.js";
import {
  echoBackend,
  harness,
  PROMPT_V1,
  priceTable,
  smallLimits,
  TEST_MODEL,
  testSeed,
  testSubjectVersion,
} from "./fixtures.js";

/**
 * Slice 4 — the shadow path, given the same care as the gate path.
 *
 * Per ADR 0001 trigger 3, a shadow evaluation is the only thing that could ever
 * falsify this library's workflows-not-agents stance, and the ADR says outright
 * that it "is the one nobody will measure unless `evals` makes it cheap". So the
 * shadow caller uses the same `run` with the same shape as the gate caller, and
 * the only difference is where the cases came from.
 */

const window = { fromInclusive: 0, toExclusive: 4_102_444_800_000 };

/**
 * A production case trace, written through `audit` exactly as an application
 * would. The shadow run **reads** this store and **writes** its own: a trace
 * never spans both.
 */
const productionTraces = async () => {
  const audit = createAudit({
    store: inMemoryTraceStore(),
    clock: systemClock(),
    redact: redactFields([]),
    onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
  });
  const humanVerdicts: Record<string, string> = {
    "case-a": "duplicate",
    "case-b": "duplicate",
    "case-c": "not-duplicate",
  };
  for (const [id, conclusion] of Object.entries(humanVerdicts)) {
    const trace = await audit.open(id as CorrelationId);
    await trace.record(
      {
        kind: "approval.answered",
        v: 1,
        disposition: "determine",
        conclusion,
        confidenceBasisPoints: 10_000,
        authority: "u.underwriter",
      },
      { tier: "high" },
    );
    await trace.close({ unassistedContainment: false });
  }
  return audit;
};

describe("the shadow path", () => {
  it("reads the audit store, writes its own, and yields an agreement report", async () => {
    const audit = await productionTraces();
    const { store, recorder } = harness();

    const cohort = await recordedCases({
      cases: [
        { correlationId: "case-a", tier: "high", input: { supplier: "acme" } },
        { correlationId: "case-b", tier: "high", input: { supplier: "beta" } },
        { correlationId: "case-c", tier: "high", input: { supplier: "gamma" } },
      ],
      humanDecisions: humanDecisionsFromAuditTrace({
        replay: (id) => audit.replay(id),
        payloadKind: "approval.answered",
      }),
      window,
      maxCases: 1_000,
    });

    expect(cohort.kind).toBe("recorded");
    expect(cohort.size).toBe(3);
    expect(cohort.provenance.withoutHumanDecision).toBe(0);

    const subject = defineSubject({
      version: testSubjectVersion,
      purity: "calls-models",
      decide: async (ctx) => {
        const answer = await ctx.client.complete({
          model: TEST_MODEL,
          promptVersion: PROMPT_V1,
          prompt: { supplier: String(ctx.input["supplier"]) },
        });
        return determine(answer.text, 9_000);
      },
    });

    const report = await run({
      label: "nightly-shadow",
      cases: cohort,
      subject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });

    expect(report.schema).toBe("report.agreement/2");
    expect(report.against).toBe("recorded-human-decisions");
    // The provenance travels with the number, because a figure whose provenance
    // is unknown is not evidence of anything.
    expect(report.humanDecisionSource).toBe("audit-trace:approval.answered");
    expect(report.window).toEqual(window);
    // The system says "duplicate" everywhere; the humans said so on two of three.
    expect(report.agreementBasisPoints).toBe(6_667);
    expect(report.disagreedBasisPoints).toBe(3_333);
    expect(report.disagreements).toHaveLength(1);
    expect(report.disagreements[0]?.correlationId).toBe("case-c");
    expect(report.disagreements[0]?.humanVerdict.conclusion).toBe("not-duplicate");
    expect(report.disagreements[0]?.systemVerdict.conclusion).toBe("duplicate");
    expect(report.disagreements[0]?.authority).toBe("u.underwriter");
    // The trap is carried on the artefact, so it survives into every dashboard
    // that renders the object naively.
    expect(report.interpretation).toBe(INTERPRETATION);

    // The eval nodes went to the eval store. Nothing was appended to `audit`.
    const evalRun = await store.read(report.runId);
    expect(evalRun?.nodes.length).toBeGreaterThan(0);
    const productionCase = await audit.replay("case-a" as CorrelationId);
    // open + answered + seal: exactly what the application wrote, untouched.
    expect(productionCase.nodes).toHaveLength(2);
  });

  it("drops cases with no human decision in the window rather than scoring against nothing", async () => {
    const cohort = await recordedCases({
      cases: [
        { correlationId: "row-1", tier: "medium", input: {} },
        { correlationId: "row-2", tier: "medium", input: {} },
      ],
      // The second shipped adapter: reviewers whose decisions were never in
      // `audit`, because the system did not exist yet. Every one of the nineteen
      // applications has a first shadow run.
      humanDecisions: legacyReviewerExport({
        id: "underwriting-2025-export",
        rows: [
          {
            correlationId: "row-1",
            verdict: abstain("evidence-missing"),
            authority: "j.reviewer",
            at: 1_690_000_000_000,
          },
        ],
      }),
      window,
      maxCases: 1_000,
    });
    expect(cohort.size).toBe(1);
    // Visible rather than flattering: an agreement figure computed over a
    // quietly shrinking cohort is exactly the number nobody can audit. It lives
    // on `provenance`, so `run` reads it and puts it on the report — it used to
    // be an extra property on this object that nothing downstream ever looked at.
    expect(cohort.provenance.withoutHumanDecision).toBe(1);
    expect(cohort.provenance.considered).toBe(2);
    expect(cohort.provenance.humanDecisionSource).toBe("legacy-export:underwriting-2025-export");
  });

  it("aborts the whole run when a subject reaches for a write", async () => {
    const audit = await productionTraces();
    const { store, recorder } = harness();
    const cohort = await recordedCases({
      cases: [
        { correlationId: "case-a", tier: "high", input: {} },
        { correlationId: "case-b", tier: "high", input: {} },
        { correlationId: "case-c", tier: "high", input: {} },
      ],
      humanDecisions: humanDecisionsFromAuditTrace({
        replay: (id) => audit.replay(id),
        payloadKind: "approval.answered",
      }),
      window,
      maxCases: 1_000,
    });

    // The compile-time guarantee is primary and is asserted in
    // `fixtures/subject-cannot-write.ts`. This is the runtime backstop for a
    // subject that defeated the type through `any`.
    const cheating = defineSubject({
      version: testSubjectVersion,
      purity: "calls-models",
      decide: async (ctx) => {
        await (ctx.client as unknown as { write: (c: unknown) => Promise<void> }).write({
          kind: "pay",
        });
        return determine("paid", 10_000);
      },
    });

    await expect(
      run({
        label: "nightly-shadow",
        cases: cohort,
        subject: cheating,
        scorers: [exactVerdict],
        models: echoBackend(),
        recorder,
        seed: testSeed,
        limits: { ...smallLimits, concurrency: 1 },
        priceTable,
      }),
    ).rejects.toBeInstanceOf(SubjectAttemptedWrite);

    // Aborting suppresses the *report*, never the *record*: the nodes for what
    // did run are written, parented and replayable. `expireBefore` is the eval
    // store's retention verb — the one `audit`'s store refuses to have — and
    // here it doubles as proof that the nodes existed.
    const expired = await store.expireBefore(Number.MAX_SAFE_INTEGER, 10);
    expect(expired.nodes).toBeGreaterThan(0);
  });
});
