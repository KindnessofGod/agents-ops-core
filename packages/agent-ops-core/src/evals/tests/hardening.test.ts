import { describe, expect, it } from "vitest";
import {
  accept,
  createEvalRecorder,
  DEFAULT_FLOORS,
  defineSubject,
  determine,
  DuplicateCaseRef,
  EVAL_STORE_SCHEMA_SQL,
  EvalStoreUnavailable,
  exactVerdict,
  gate,
  goldenSuite,
  inMemoryEvalNodeStore,
  inMemoryRunLedger,
  judgePanel,
  legacyReviewerExport,
  LimitOutOfRange,
  manualTimers,
  READABLE_ENVELOPES,
  recordedCases,
  reopenAccuracyReport,
  ReportRefused,
  run,
  seed as makeSeed,
  scriptedModelBackend,
  sqlEvalNodeStore,
  StoreNotMinted,
  SubjectAttemptedWrite,
  systemTimers,
  UnreadableEnvelope,
} from "../index.js";
import type {
  AccuracyReport,
  AgreementReport,
  EvalNodeStore,
  ScoreOutcome,
  Scorer,
  ScorerDigest,
  ScorerId,
  SqlExecutor,
  SqlRow,
} from "../index.js";
import {
  denyFields,
  echoBackend,
  harness,
  manualClock,
  passthroughRedactor,
  priceTable,
  PROMPT_V1,
  smallLimits,
  TEST_JUDGE,
  TEST_MODEL,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/**
 * Slice 8 — the adversarial review, reproduced and closed.
 *
 * Every test in this file failed before the change it names. They are ordered
 * the way the review demanded: claims the interface made and the code did not
 * deliver, then paths that permitted an unrecorded or unbounded execution, then
 * the rest.
 *
 * It crosses the same seam every other caller crosses — `../index.js` — and
 * reaches no network. Fault injection goes through `sqlEvalNodeStore`'s injected
 * `SqlExecutor`, which is that adapter's real extension point, rather than
 * through a hand-rolled store: the store is branded now, and a hand-rolled one
 * is refused, which is itself one of the properties under test.
 */

const callingSubject = defineSubject({
  version: testSubjectVersion,
  purity: "calls-models",
  decide: async (ctx) => {
    const answer = await ctx.client.complete({
      model: TEST_MODEL,
      promptVersion: PROMPT_V1,
      prompt: { supplier: String(ctx.input["supplier"] ?? "") },
    });
    return determine(answer.text, 9_000);
  },
});

const oneInvoice = (conclusion: string) =>
  goldenSuite({
    cases: [
      {
        ref: "INV-0001",
        tier: "high",
        input: { supplier: "acme" },
        expected: determine(conclusion, 9_000),
        adjudicatedBy: "a.reviewer",
        adjudicatedAt: 1_690_000_000_000,
      },
    ],
  });

const subjectSaying = (text: string) =>
  defineSubject({
    version: testSubjectVersion,
    purity: "calls-models",
    decide: async (ctx) => {
      await ctx.client.complete({ model: TEST_MODEL, promptVersion: PROMPT_V1, prompt: {} });
      return determine(text, 9_000);
    },
  });

/* ================================================================== group 1
 * Claims the interface made that the code did not deliver.
 * ======================================================================== */

describe("a forged store beneath a genuine recorder", () => {
  it("refuses a store this module did not mint", () => {
    // Verbatim the review's repro: echo the header, fabricate nodes, return an
    // empty read. It produced correctBasisPoints 10000, attribution complete, a
    // valid-looking trace digest, nodes 0 and a passing gate — with no cast, no
    // `any` and no `@ts-expect-error`, because `EvalNodeStore` was an unbranded
    // structural interface exported from `index.ts`. The recorder's brand had
    // only relocated the forgery one layer down.
    const forged = {
      openRun: async () => undefined,
      append: async (input: unknown) => ({ ...(input as object), id: "x", sequence: 0 }),
      settle: async (input: unknown) => ({ ...(input as object), id: "x", sequence: 0 }),
      read: async () => ({ header: {}, nodes: [] }),
      expireBefore: async () => ({ runs: 0, nodes: 0 }),
    } as unknown as EvalNodeStore;
    expect(() =>
      createEvalRecorder({
        store: forged,
        clock: manualClock(),
        redact: passthroughRedactor,
        timers: systemTimers(),
        ledger: inMemoryRunLedger(),
      }),
    ).toThrow(StoreNotMinted);
  });

  it("still mints the two shipped adapters", () => {
    expect(() =>
      createEvalRecorder({
        store: inMemoryEvalNodeStore(),
        clock: manualClock(),
        redact: passthroughRedactor,
        timers: systemTimers(),
        ledger: inMemoryRunLedger(),
      }),
    ).not.toThrow();
  });
});

describe("a golden case rewritten in place under the same reference", () => {
  it("blocks: a reference is an identity, a digest is what makes it the same case", async () => {
    const { recorder } = harness();
    const good = await run({
      label: "pre-merge",
      cases: oneInvoice("duplicate"),
      subject: subjectSaying("duplicate"),
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    const baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });

    // The subject regresses to "not-duplicate". Rather than adjudicate it,
    // somebody edits the golden case's expected verdict to match — same ref, new
    // content. The gate matched on `CaseRef` alone and passed, so rewriting a
    // failing golden case was strictly cheaper than deleting one, which is
    // exactly what `dropped-cases` exists to prevent.
    const { recorder: r2 } = harness();
    const after = await run({
      label: "pre-merge",
      cases: oneInvoice("not-duplicate"),
      subject: subjectSaying("not-duplicate"),
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder: r2,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(after.correctBasisPoints).toBe(10_000);
    expect(after.suiteDigest).not.toBe(baseline.suiteDigest);

    const outcome = await gate({ report: after, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("edited-cases");
    expect(outcome.counts.edited).toEqual(["INV-0001"]);
    expect(outcome.remedy).toContain("re-accept the baseline");
  });

  it("still passes an unedited case, so the check has an off state", async () => {
    const { recorder } = harness();
    const good = await run({
      label: "pre-merge",
      cases: oneInvoice("duplicate"),
      subject: subjectSaying("duplicate"),
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    const baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });
    const outcome = await gate({ report: good, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(outcome.kind).toBe("passed");
    expect(outcome.counts.edited).toEqual([]);
  });
});

describe("purity is a declaration, and the report says which claim it rests on", () => {
  it("does not present a declared-pure run as measured coverage", async () => {
    const { recorder } = harness();
    // Declares itself pure and does all of its thinking through an out-of-band
    // SDK. It produced attribution `complete`, coverage 10000, cost 0, tokens 0
    // and a passing gate — a number that reads as "we verified where the
    // thinking happened" when nothing had been verified.
    const outOfBand = defineSubject({
      version: testSubjectVersion,
      purity: "pure",
      decide: async () => determine("duplicate", 9_000),
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: outOfBand,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(report.attribution).toBe("declared-pure");
    expect(report.attributionCoverageBasisPoints).toBe(0);
    // It is not blocked — a genuine rules engine is a legitimate subject and
    // blocking it by default would be wrong — but nobody reading this artefact
    // can mistake the declaration for evidence.
    const baseline = accept({ report, by: "a.engineer", at: 1_700_000_000_000 });
    const outcome = await gate({ report, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(outcome.kind).toBe("passed");
  });

  it("blocks a subject that declared pure and then called a model", async () => {
    // The one thing about a purity declaration that *is* checkable, and it was
    // not checked: the check ran in one direction only.
    const { recorder } = harness();
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: defineSubject({
        version: testSubjectVersion,
        purity: "pure",
        decide: async (ctx) => {
          const answer = await ctx.client.complete({
            model: TEST_MODEL,
            promptVersion: PROMPT_V1,
            prompt: {},
          });
          return determine(answer.text, 9_000);
        },
      }),
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(report.attribution).toBe("partial");
    expect(report.cases.every((c) => c.status === "unattributed")).toBe(true);
    expect(report.cases[0]?.detail).toContain('declared purity "pure"');
  });

  it("puts the per-case call count on the artefact, because the check is a floor of one", async () => {
    const { recorder } = harness();
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: callingSubject,
      scorers: [exactVerdict],
      models: scriptedModelBackend({
        id: "cheap",
        answer: () => ({ text: "duplicate", tokensIn: 3, tokensOut: 1 }),
      }),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    // One three-token call satisfies the attribution check. That is not
    // detectable, so it is made visible instead: a reviewer sees the shape.
    expect(report.attribution).toBe("complete");
    expect(report.cases[0]?.modelCalls).toBe(1);
    expect(report.cases[0]?.costTenthCents).toBeLessThan(5);
  });
});

describe("reports crossing a process boundary", () => {
  it("round-trips a real report through JSON and gates it", async () => {
    const { recorder } = harness();
    const report = await run({
      label: "pre-merge",
      cases: oneInvoice("duplicate"),
      subject: subjectSaying("duplicate"),
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    const baseline = accept({ report, by: "a.engineer", at: 1_700_000_000_000 });
    // Job A wrote this; job B reads it. The brand did not survive the wire, and
    // the flow could previously only re-enter through a cast that checked
    // nothing at all.
    const overTheWire: unknown = JSON.parse(JSON.stringify(report));
    const reopened = reopenAccuracyReport(overTheWire);
    const outcome = await gate({ report: reopened, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(outcome.kind).toBe("passed");
  });

  it("refuses an agreement report's JSON by schema, not by type", () => {
    const agreement = {
      schema: "report.agreement/1",
      against: "recorded-human-decisions",
      capturedVia: "injected-client-only",
      cases: [{ status: "agreed" }],
    };
    expect(() => reopenAccuracyReport(agreement)).toThrow(ReportRefused);
  });

  it("refuses a report whose headline numbers do not follow from its own cases", async () => {
    const { recorder } = harness();
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: subjectSaying("not-duplicate"),
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(report.correctBasisPoints).toBe(0);
    // The cheapest possible forgery: keep the cases, rewrite the number.
    const tampered = {
      ...(JSON.parse(JSON.stringify(report)) as Record<string, unknown>),
      correctBasisPoints: 10_000,
    };
    expect(() => reopenAccuracyReport(tampered)).toThrow(ReportRefused);
    // The gate runs the same validation on whatever it is handed, so a cast-in
    // report is refused at runtime as well as at compile time.
    await expect(
      gate({
        report: tampered as unknown as AccuracyReport,
        baseline: undefined,
        floors: DEFAULT_FLOORS,
        recorder,
      }),
    ).rejects.toBeInstanceOf(ReportRefused);
  });
});

describe("the redactor reaches the report, not only the nodes", () => {
  it("redacts a named authority and correlation identifier out of an agreement report", async () => {
    // Reports outlive the node graph: the graph expires at 90 days, the report
    // does not. `authority` is a named person, and it travelled unredacted into
    // the long-lived artefact while the short-lived nodes were scrubbed.
    const { recorder } = harness(denyFields(["authority", "correlationId"]));
    const cohort = await recordedCases({
      cases: [{ correlationId: "case-a", tier: "high", input: { supplier: "acme" } }],
      humanDecisions: legacyReviewerExport({
        id: "underwriting-2025-export",
        rows: [
          {
            correlationId: "case-a",
            verdict: determine("not-duplicate", 10_000),
            authority: "u.underwriter",
            at: 1_690_000_000_000,
          },
        ],
      }),
      window: { fromInclusive: 0, toExclusive: 4_102_444_800_000 },
      maxCases: 1_000,
    });
    const report: AgreementReport = await run({
      label: "nightly-shadow",
      cases: cohort,
      subject: subjectSaying("duplicate"),
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(report.cases[0]?.authority).toBe("[redacted]");
    expect(report.cases[0]?.correlationId).toBe("[redacted]");
    expect(report.disagreements[0]?.authority).toBe("[redacted]");
    expect(report.disagreements[0]?.correlationId).toBe("[redacted]");
    // And the artefact names the policy that produced its strings.
    expect(report.redaction).toBe("deny:authority,correlationId");
  });
});

describe("the cohort's own assembly is recorded", () => {
  it("puts the dropped-case count on the report and on a source node", async () => {
    const { store, recorder } = harness();
    const cohort = await recordedCases({
      cases: [
        { correlationId: "row-1", tier: "medium", input: {} },
        { correlationId: "row-2", tier: "medium", input: {} },
        { correlationId: "row-3", tier: "medium", input: {} },
      ],
      humanDecisions: legacyReviewerExport({
        id: "underwriting-2025-export",
        rows: [
          {
            correlationId: "row-1",
            verdict: determine("duplicate", 10_000),
            authority: "j.reviewer",
            at: 1_690_000_000_000,
          },
        ],
      }),
      window: { fromInclusive: 0, toExclusive: 4_102_444_800_000 },
      maxCases: 1_000,
    });
    const report: AgreementReport = await run({
      label: "nightly-shadow",
      cases: cohort,
      subject: subjectSaying("duplicate"),
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    // 100% agreement over a cohort that started at three and finished at one
    // reads very differently once the denominator's history is next to it.
    expect(report.agreementBasisPoints).toBe(10_000);
    expect(report.withoutHumanDecision).toBe(2);

    const nodes = (await store.read(report.runId))?.nodes ?? [];
    const source = nodes.filter((n) => n.kind === "source");
    expect(source).toHaveLength(1);
    expect(source[0]?.payload["humanDecisionSource"]).toBe("legacy-export:underwriting-2025-export");
    expect(source[0]?.payload["considered"]).toBe(3);
    expect(source[0]?.payload["withoutHumanDecision"]).toBe(2);
    expect(source[0]?.payload["windowToExclusive"]).toBe(4_102_444_800_000);
  });

  it("bounds its own input", async () => {
    await expect(
      recordedCases({
        cases: [],
        humanDecisions: legacyReviewerExport({ id: "x", rows: [] }),
        window: { fromInclusive: 0, toExclusive: 1 },
        maxCases: 0,
      }),
    ).rejects.toBeInstanceOf(LimitOutOfRange);
  });
});

/* ================================================================== group 2
 * Unrecorded, unbounded, or both.
 * ======================================================================== */

describe("the wall clocks terminate something", () => {
  it("bounds a subject that ignores ctx.signal instead of hanging on it", async () => {
    // `run` set two AbortControllers and then awaited `decide` directly. With
    // runMillis 100 and perCaseMillis 50 against a subject that ignores the
    // signal, the run was still hanging at 1503ms — for ever, in fact.
    const { store, recorder } = harness();
    const hung = defineSubject({
      version: testSubjectVersion,
      purity: "pure",
      decide: () => new Promise(() => undefined),
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: hung,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: { ...smallLimits, concurrency: 3, perCaseMillis: 20, runMillis: 5_000 },
      priceTable,
    });
    expect(report.casesRun).toBe(3);
    expect(report.cases.every((c) => c.status === "unscored")).toBe(true);
    expect(report.cases[0]?.detail).toBe("case budget spent");
    // The node is settled `timeout`, not left dangling: the process did not die
    // inside it, the budget ran out around it, and those are different facts.
    const decisions = ((await store.read(report.runId))?.nodes ?? []).filter(
      (n) => n.kind === "decision",
    );
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) expect(decision.outcome).toBe("timeout");
  }, 15_000);

  it("marks the run partial when the run wall clock is what ran out", async () => {
    const { recorder } = harness();
    const hung = defineSubject({
      version: testSubjectVersion,
      purity: "pure",
      decide: () => new Promise(() => undefined),
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: hung,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      // The run budget expires long before three 5-second cases could.
      limits: { ...smallLimits, concurrency: 1, perCaseMillis: 5_000, runMillis: 30 },
      priceTable,
    });
    expect(report.partial).toBe(true);
    expect(report.partialReason).toContain("wall-clock");
    expect(report.casesRun).toBeLessThan(3);
  }, 15_000);
});

describe("the cost ceiling inside one case", () => {
  it("stops a chatty case at the ceiling rather than at the end of the case", async () => {
    // The ceiling was checked between cases only. One chatty case spent
    // 40,000,000,000 tenth-cents against a ceiling of 1 before the check was
    // reached, because a budget only bounds what it is checked against.
    const { recorder } = harness();
    const chatty = defineSubject({
      version: testSubjectVersion,
      purity: "calls-models",
      decide: async (ctx) => {
        for (let i = 0; i < 10_000; i += 1) {
          await ctx.client.complete({ model: TEST_MODEL, promptVersion: PROMPT_V1, prompt: { i } });
        }
        return determine("duplicate", 9_000);
      },
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: chatty,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: { ...smallLimits, concurrency: 1, costCeilingTenthCents: 100 },
      priceTable,
    });
    // 33 tenth-cents a call, so the ceiling is crossed on the fourth. A handful
    // of tenth-cents of overshoot is the width of one in-flight call; ten
    // thousand calls is a runaway.
    expect(report.costTenthCents).toBeGreaterThan(100);
    expect(report.costTenthCents).toBeLessThan(200);
    expect(report.partial).toBe(true);
    expect(report.partialReason).toContain("cost");
  }, 20_000);
});

describe("an incident is never downgraded to an outcome", () => {
  it("aborts the run when the store fails inside a judge sample", async () => {
    // `judgePanel`'s bare `catch {}` and the runner's scorer catch both swallowed
    // `EvalStoreUnavailable`, so a store failing only on `judge.sample` appended
    // `unscored: judge-unavailable` and `run` returned a report — an unrecorded
    // eval run presented as a measured one, against a documented fail-closed
    // policy with no configuration key.
    const sql = fakeSql({
      failOn: (text, params) =>
        text.includes("INSERT INTO agent_ops.eval_node") && params[5] === "judge.sample",
    });
    const recorder = createEvalRecorder({
      store: sqlEvalNodeStore(sql),
      clock: manualClock(),
      redact: passthroughRedactor,
      timers: systemTimers(),
      ledger: inMemoryRunLedger(),
    });
    await expect(
      run({
        label: "nightly",
        cases: threeInvoices(),
        subject: callingSubject,
        scorers: [
          judgePanel({
            model: TEST_JUDGE,
            promptVersion: PROMPT_V1,
            panelSize: 3,
            bandBasisPoints: 500,
            rubric: "r",
          }),
        ],
        models: scriptedModelBackend({
          id: "scripted",
          answer: (request) =>
            request.model === TEST_JUDGE
              ? { text: "10000", tokensIn: 1, tokensOut: 1 }
              : { text: "duplicate", tokensIn: 1, tokensOut: 1 },
        }),
        recorder,
        seed: testSeed,
        limits: { ...smallLimits, concurrency: 1 },
        priceTable,
      }),
    ).rejects.toBeInstanceOf(EvalStoreUnavailable);
  });

  it("aborts the run when a scorer reaches for a write", async () => {
    // Documented as "fail-closed, abort the entire run, not just the case". True
    // for the subject; false for a scorer, where the write attempt — an effect
    // possibly already committed through a channel this module does not own —
    // became an ordinary `unscored` outcome and the run completed normally.
    const rogue: Scorer = {
      descriptor: {
        id: "rogue" as ScorerId,
        digest: "rogue/1" as ScorerDigest,
        determinism: "deterministic",
        judge: null,
      },
      score: async (ctx): Promise<ScoreOutcome> => {
        await (ctx.judge as unknown as { write: (c: unknown) => Promise<void> }).write({
          kind: "pay",
        });
        return { kind: "scored", valueBasisPoints: 10_000 };
      },
    };
    const { recorder } = harness();
    await expect(
      run({
        label: "pre-merge",
        cases: threeInvoices(),
        subject: callingSubject,
        scorers: [rogue],
        models: echoBackend(),
        recorder,
        seed: testSeed,
        limits: { ...smallLimits, concurrency: 1 },
        priceTable,
      }),
    ).rejects.toBeInstanceOf(SubjectAttemptedWrite);
  });

  it("names the case an incident happened in, not the node", async () => {
    // The error was constructed with the NODE name while the field was declared
    // `caseRef`, so it read "decide" or "exactVerdict" — the one identifier an
    // incident responder cannot use.
    const { recorder } = harness();
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
    const failure: unknown = await run({
      label: "pre-merge",
      cases: oneInvoice("duplicate"),
      subject: cheating,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: { ...smallLimits, concurrency: 1 },
      priceTable,
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(SubjectAttemptedWrite);
    const incident = failure as SubjectAttemptedWrite;
    expect(incident.caseRef).toBe("INV-0001");
    expect(incident.at).toBe("decide");
  });
});

describe("duplicate case references", () => {
  it("refuses a suite carrying one reference twice", () => {
    // Both copies executed, both opened a `case` node, and the runner keyed
    // results by reference — so the report showed casesRun 2 with the same node
    // id listed twice and one execution's outcome silently discarded. The trace
    // and the report disagreed about what happened.
    const draft = {
      ref: "INV-0001",
      tier: "high" as const,
      input: { supplier: "acme" },
      expected: determine("duplicate", 9_000),
      adjudicatedBy: "a.reviewer",
      adjudicatedAt: 1_690_000_000_000,
    };
    expect(() => goldenSuite({ cases: [draft, draft] })).toThrow(DuplicateCaseRef);
  });

  it("refuses a hand-rolled source with duplicates before any spend", async () => {
    const { recorder } = harness();
    const one = oneInvoice("duplicate");
    const doubled = { ...one, size: 2, cases: [...one.cases, ...one.cases] };
    let dialled = false;
    await expect(
      run({
        label: "pre-merge",
        cases: doubled,
        subject: callingSubject,
        scorers: [exactVerdict],
        models: scriptedModelBackend({
          id: "should-not-be-called",
          answer: () => {
            dialled = true;
            return { text: "duplicate", tokensIn: 1, tokensOut: 1 };
          },
        }),
        recorder,
        seed: testSeed,
        limits: smallLimits,
        priceTable,
      }),
    ).rejects.toBeInstanceOf(DuplicateCaseRef);
    expect(dialled).toBe(false);
  });
});

describe("retention is bounded and atomic", () => {
  it("removes at most the batch it was asked for", async () => {
    const store = inMemoryEvalNodeStore();
    const clock = manualClock(1_000_000);
    const recorder = createEvalRecorder({
      store,
      clock,
      redact: passthroughRedactor,
      timers: systemTimers(),
      ledger: inMemoryRunLedger(),
    });
    for (let i = 0; i < 3; i += 1) {
      await run({
        label: `day-${i}`,
        // A different **seed** per day, not just a different label. The label is
        // deliberately not in the run key — "pre-merge" and "nightly" over the
        // same cases are one question asked twice — so three runs that differed
        // only by label would be one execution and two memo hits, and this test
        // would have one run to expire rather than three.
        seed: makeSeed(`seed-day-${i}`),
        cases: oneInvoice("duplicate"),
        subject: subjectSaying("duplicate"),
        scorers: [exactVerdict],
        models: echoBackend(),
        recorder,
        limits: smallLimits,
        priceTable,
      });
    }
    // `expireBefore(cutoff)` had no batch limit at all, and its SQL form
    // materialised every deleted node id — 10M a day against 90 days — purely to
    // return a count.
    const first = await store.expireBefore(Number.MAX_SAFE_INTEGER, 1);
    expect(first.runs).toBe(1);
    expect(first.nodes).toBeGreaterThan(0);
    const rest = await store.expireBefore(Number.MAX_SAFE_INTEGER, 10);
    expect(rest.runs).toBe(2);
    expect(await store.expireBefore(Number.MAX_SAFE_INTEGER, 10)).toEqual({ runs: 0, nodes: 0 });
  }, 20_000);

  it("refuses an out-of-range batch limit", async () => {
    const store = inMemoryEvalNodeStore();
    await expect(store.expireBefore(1, 0)).rejects.toBeInstanceOf(LimitOutOfRange);
    await expect(store.expireBefore(1, 10_001)).rejects.toBeInstanceOf(LimitOutOfRange);
  });

  it("expires nodes and runs in one statement, so neither can outlive the other", async () => {
    const sql = fakeSql();
    const store = sqlEvalNodeStore(sql);
    await store.expireBefore(1_000, 5);
    // One statement, not two. The old form issued two unwrapped DELETEs, so a
    // failure between them left eval_run rows with no nodes — a run that reads
    // as empty rather than as expired, which is the one thing an expired trace
    // must not look like.
    expect(sql.statements.filter((s) => s.startsWith("DELETE"))).toHaveLength(0);
    expect(sql.statements.filter((s) => s.startsWith("WITH doomed"))).toHaveLength(1);
  });
});

/* ================================================================== group 3
 * The SQL adapter: isolation, schema, and reading rows back.
 * ======================================================================== */

interface FakeSql extends SqlExecutor {
  readonly statements: string[];
}

/**
 * A fake that models the two things the previous one did not: **transaction
 * isolation** and **the primary key**.
 *
 * The old fixture's `transaction` was `fn => fn(executor)` — no isolation at
 * all — so `pg_advisory_xact_lock` was never exercised and the ordering test
 * asserted only that the number of locks equalled the number of inserts. With a
 * fake in this style but the lock made a no-op, concurrency 8 produced 42 id
 * collisions and `run` reported no error, because the fake had no primary key
 * either.
 *
 * `isolate` makes every statement yield, so writers genuinely interleave.
 * `deaf` makes the advisory lock a no-op — the control that gives the ordering
 * test its teeth.
 */
const fakeSql = (
  options: {
    readonly failOn?: (text: string, params: readonly unknown[]) => boolean;
    readonly isolate?: boolean;
    readonly deaf?: boolean;
  } = {},
): FakeSql => {
  const runs: Record<string, SqlRow> = {};
  const nodes: SqlRow[] = [];
  const statements: string[] = [];
  const held = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();

  const exec = async (
    sqlText: string,
    params: readonly unknown[],
    locks: string[],
  ): Promise<{ readonly rows: readonly SqlRow[] }> => {
    statements.push(sqlText.trim().split("\n")[0]?.trim() ?? "");
    if (options.failOn?.(sqlText, params) === true) throw new Error("sql exploded");
    if (options.isolate === true) await new Promise((r) => setTimeout(r, 0));
    const p = params;
    if (sqlText.includes("INSERT INTO agent_ops.eval_run")) {
      runs[String(p[0])] = {
        run_id: p[0],
        label: p[1],
        opened_at: p[2],
        source_kind: p[3],
        source_digest: p[4],
        subject_version: p[5],
        seed: p[6],
        envelope: p[7],
        redaction: p[8],
        captured_via: p[9],
      };
      return { rows: [] };
    }
    if (sqlText.includes("pg_advisory_xact_lock")) {
      if (options.deaf === true) return { rows: [] };
      const key = String(p[0]);
      for (;;) {
        const current = held.get(key);
        if (current === undefined) break;
        await current;
      }
      let release = (): void => undefined;
      held.set(
        key,
        new Promise<void>((resolve) => {
          release = () => {
            held.delete(key);
            resolve();
          };
        }),
      );
      locks.push(key);
      releases.set(key, release);
      return { rows: [] };
    }
    if (sqlText.includes("COALESCE(MAX(sequence)")) {
      return { rows: [{ seq: nodes.filter((n) => n["run_id"] === p[0]).length }] };
    }
    if (sqlText.includes("INSERT INTO agent_ops.eval_node")) {
      const id = String(p[0]);
      // The primary key, modelled. Two writers that read the same MAX collide
      // here rather than silently overwriting, which is what Postgres does.
      if (nodes.some((n) => n["id"] === id)) {
        throw new Error(`duplicate key value violates unique constraint: ${id}`);
      }
      nodes.push({
        id: p[0],
        run_id: p[1],
        sequence: p[2],
        parent: p[3],
        kind: p[4],
        name: p[5],
        opened_at: p[6],
        closed_at: null,
        elapsed_micros: 0,
        outcome: "ok",
        cost_tenth_cents: 0,
        tokens_in: 0,
        tokens_out: 0,
        price_table_version: "",
        payload_schema_version: p[7],
        redaction: p[8],
        envelope: p[9],
        payload: JSON.parse(String(p[10])) as SqlRow,
        canonical: null,
      });
      return { rows: [nodes[nodes.length - 1] as SqlRow] };
    }
    if (sqlText.includes("UPDATE agent_ops.eval_node")) {
      const index = nodes.findIndex(
        (n) => n["run_id"] === p[0] && n["id"] === p[1] && n["closed_at"] === null,
      );
      const existing = nodes[index];
      if (existing === undefined) return { rows: [] };
      nodes[index] = {
        ...existing,
        closed_at: p[2],
        elapsed_micros: p[3],
        outcome: p[4],
        cost_tenth_cents: p[5],
        tokens_in: p[6],
        tokens_out: p[7],
        price_table_version: p[8],
        payload: { ...(existing["payload"] as SqlRow), ...(JSON.parse(String(p[9])) as SqlRow) },
        canonical: p[10],
      };
      return { rows: [nodes[index] as SqlRow] };
    }
    if (sqlText.includes("SELECT * FROM agent_ops.eval_run")) {
      const row = runs[String(p[0])];
      return { rows: row === undefined ? [] : [row] };
    }
    if (sqlText.includes("SELECT * FROM agent_ops.eval_node")) {
      return {
        rows: nodes
          .filter((r) => r["run_id"] === p[0])
          .sort((a, b) => Number(a["sequence"]) - Number(b["sequence"])),
      };
    }
    if (sqlText.trim().startsWith("WITH doomed")) {
      const doomed = Object.values(runs)
        .filter((r) => Number(r["opened_at"]) < Number(p[0]))
        .slice(0, Number(p[1]))
        .map((r) => String(r["run_id"]));
      const gone = nodes.filter((n) => doomed.includes(String(n["run_id"])));
      for (const row of gone) nodes.splice(nodes.indexOf(row), 1);
      for (const id of doomed) delete runs[id];
      return { rows: [{ runs: doomed.length, nodes: gone.length }] };
    }
    throw new Error(`unhandled statement: ${sqlText}`);
  };

  const executor: FakeSql = {
    statements,
    query: (t, params) => exec(t, params, []),
    async transaction(fn) {
      const locks: string[] = [];
      const tx: SqlExecutor = {
        query: (t, params) => exec(t, params, locks),
        transaction: (inner) => inner(tx),
      };
      try {
        return await fn(tx);
      } finally {
        // Transaction-scoped, like `pg_advisory_xact_lock`. Released here and
        // nowhere else, which is what makes the fake model the real thing.
        for (const key of locks) releases.get(key)?.();
      }
    },
  };
  return executor;
};

describe("the SQL adapter under concurrent writers", () => {
  const suite24 = () =>
    goldenSuite({
      cases: Array.from({ length: 24 }, (_, i) => ({
        ref: `INV-${String(i).padStart(4, "0")}`,
        tier: "medium" as const,
        input: { index: i },
        expected: determine("duplicate", 9_000),
        adjudicatedBy: "a.reviewer",
        adjudicatedAt: 1_690_000_000_000,
      })),
    });

  const runAgainst = (sql: FakeSql) =>
    run({
      label: "pre-merge",
      cases: suite24(),
      subject: callingSubject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder: createEvalRecorder({
        store: sqlEvalNodeStore(sql),
        clock: manualClock(),
        redact: passthroughRedactor,
        timers: systemTimers(),
        ledger: inMemoryRunLedger(),
      }),
      seed: testSeed,
      limits: { ...smallLimits, concurrency: 8 },
      priceTable,
    });

  it("assigns unique ids and a dense sequence at concurrency 8", async () => {
    const sql = fakeSql({ isolate: true });
    const report = await runAgainst(sql);
    expect(report.casesRun).toBe(24);
    const stored = await sqlEvalNodeStore(sql).read(report.runId);
    const nodes = stored?.nodes ?? [];
    expect(nodes.length).toBeGreaterThan(24);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    // A total order over writes, with no gaps and no collisions.
    expect(nodes.map((n) => n.sequence)).toEqual(nodes.map((_, i) => i));
  }, 30_000);

  it("collides without the advisory lock — which is what gives the test above teeth", async () => {
    // The control. Same fake, same interleaving, lock made deaf. Two writers read
    // the same MAX(sequence) and the second insert loses to the primary key.
    // Without this the ordering claim is asserted against a fixture that models
    // no isolation and could not fail.
    await expect(runAgainst(fakeSql({ isolate: true, deaf: true }))).rejects.toBeInstanceOf(
      EvalStoreUnavailable,
    );
  }, 30_000);
});

describe("the SQL adapter is runnable as shipped", () => {
  it("ships the schema it requires, covering every table and column it writes", () => {
    // There was no migration creating agent_ops.eval_run or agent_ops.eval_node
    // anywhere in the repository, and the adapter described its schema in prose.
    // Copy this into migrations/0004_eval_store.sql.
    for (const needle of [
      "agent_ops.eval_run",
      "agent_ops.eval_node",
      "captured_via",
      "payload_schema_version",
      "price_table_version",
      "canonical",
      "eval_node_run_sequence",
      "pg_advisory_xact_lock",
    ]) {
      expect(EVAL_STORE_SCHEMA_SQL).toContain(needle);
    }
    // The grants that make this store different from audit's, and the reason the
    // two stores are two stores.
    expect(EVAL_STORE_SCHEMA_SQL).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON agent_ops.eval_node",
    );
    // And it grants nothing on an audit table. The audit tables are INSERT-only
    // forever; a grant that exists is a grant that gets used.
    expect(EVAL_STORE_SCHEMA_SQL).not.toMatch(/GRANT[^;]*ON agent_ops\.audit/);
  });
});

/** A one-row executor, for exercising the decode path with hostile columns. */
const rowsReturning = (overrides: SqlRow): SqlExecutor => {
  const base: SqlRow = {
    id: "r1/00000000",
    run_id: "r1",
    sequence: 0,
    parent: null,
    kind: "run",
    name: "n",
    opened_at: 1,
    closed_at: 2,
    elapsed_micros: 1_000,
    outcome: "ok",
    cost_tenth_cents: 0,
    tokens_in: 0,
    tokens_out: 0,
    price_table_version: "p",
    payload_schema_version: 1,
    redaction: "none",
    envelope: "aoc.evals.node.v1",
    payload: {},
    canonical: "{}",
  };
  const executor: SqlExecutor = {
    async query(text) {
      if (text.includes("SELECT * FROM agent_ops.eval_run")) {
        return {
          rows: [
            {
              run_id: "r1",
              label: "l",
              opened_at: 1,
              source_kind: "golden",
              source_digest: "d",
              subject_version: "v",
              seed: "s",
              envelope: "aoc.evals.node.v1",
              redaction: "none",
              captured_via: "injected-client-only",
            },
          ],
        };
      }
      return { rows: [{ ...base, ...overrides }] };
    },
    transaction: (fn) => fn(executor),
  };
  return executor;
};

describe("the read half of the seven-year story", () => {
  it("refuses a row written under an envelope this build does not know", async () => {
    // `rowToNode` cast its columns straight through, so a row from a future
    // build, another application, or a corrupted table became a
    // plausible-looking node. Three version stamps, written by everything and
    // read by nothing.
    const store = sqlEvalNodeStore(rowsReturning({ envelope: "aoc.evals.node.v0" }));
    await expect(store.read("r1" as never)).rejects.toBeInstanceOf(UnreadableEnvelope);
  });

  it("refuses an outcome and a kind outside their unions", async () => {
    await expect(
      sqlEvalNodeStore(rowsReturning({ outcome: "probably-fine" })).read("r1" as never),
    ).rejects.toBeInstanceOf(UnreadableEnvelope);
    await expect(
      sqlEvalNodeStore(rowsReturning({ kind: "log" })).read("r1" as never),
    ).rejects.toBeInstanceOf(UnreadableEnvelope);
  });

  it("names the envelopes it can decode", () => {
    expect(READABLE_ENVELOPES).toContain("aoc.evals.node.v1");
  });
});

/* ================================================================== group 4
 * Timers: the injected passage of time.
 * ======================================================================== */

describe("backoff is bounded, jittered and driven by the injected timers", () => {
  const flakyRun = async (timers: ReturnType<typeof manualTimers>) => {
    const { recorder } = harness(passthroughRedactor, timers);
    let calls = 0;
    // Virtual time moves because this pump moves it, not because anything waits
    // for it. The module's backoff, its per-case wall clock and its run wall
    // clock all read these timers; nothing in this test sleeps for 2 seconds.
    const pump = setInterval(() => {
      timers.advance(3_000);
    }, 1);
    try {
      const report = await run({
        label: "pre-merge",
        cases: oneInvoice("duplicate"),
        subject: callingSubject,
        scorers: [exactVerdict],
        models: scriptedModelBackend({
          id: "flaky",
          answer: () => {
            calls += 1;
            throw new Error("provider unavailable");
          },
        }),
        recorder,
        seed: testSeed,
        // The wall clocks are driven by these same manual timers, so they are
        // set wide: this test is about the backoff, and a case budget expiring
        // mid-sequence would be measuring something else.
        limits: {
          ...smallLimits,
          concurrency: 1,
          retries: 3,
          perCaseMillis: 600_000,
          runMillis: 7_200_000,
        },
        priceTable,
      });
      return { calls, report };
    } finally {
      clearInterval(pump);
    }
  };

  it("produces a bounded, deterministic sequence without spending wall time", async () => {
    // `sleep` used ambient `setTimeout`, so the one part of this module with real
    // timing behaviour was the one part no test could reach: `bounds.test.ts` was
    // reduced to comparing `Date.now()` against a limit.
    const first = manualTimers();
    const a = await flakyRun(first);
    // Bounded: retries 3 means four attempts and three backoffs, never more.
    expect(a.calls).toBe(4);
    const slept = first.slept();
    expect(slept).toHaveLength(3);
    for (const interval of slept) {
      expect(interval).toBeGreaterThanOrEqual(1);
      // 20 * 2^attempt, capped at 2000, times a jitter in [0,1).
      expect(interval).toBeLessThanOrEqual(2_000);
    }
    expect(a.report.cases[0]?.status).toBe("unscored");

    // Deterministic given the run seed: same seed, same backoff sequence, same
    // trace. Asserted here rather than asserted in prose.
    const second = manualTimers();
    await flakyRun(second);
    expect(second.slept()).toEqual(slept);
  }, 20_000);
});

describe("run identity comes from the injected clock, not Math.random", () => {
  it("is reproducible under a manual clock", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { recorder } = harness();
      const report = await run({
        label: "pre-merge",
        cases: oneInvoice("duplicate"),
        subject: subjectSaying("duplicate"),
        scorers: [exactVerdict],
        models: echoBackend(),
        recorder,
        seed: testSeed,
        limits: smallLimits,
        priceTable,
      });
      ids.push(report.runId);
    }
    // Two recorders over two manual clocks starting at the same instant produce
    // the same identifier for the same content — which is the point of an
    // injected clock, and was unreachable while the suffix was Math.random().
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toContain("NaN");
  });
});

/* ================================================================== group 5
 * Settling exactly once.
 * ======================================================================== */

describe("every node is settled on exactly one path", () => {
  it("settles a child span opened after the case budget was spent exactly once", async () => {
    // `EvalNodeStore` says settling twice is an error, not a no-op, and the
    // recorder swallowed the second call before the store ever saw it. The abort
    // branch of `child` settled and then threw *inside* its own try, so its catch
    // settled the same node again — invisible only because of that silencer.
    // Both are fixed together: the guard now throws `NodeSettledTwice`, and the
    // flow no longer reaches it. Reaching this store through the SQL adapter is
    // what makes the count observable at all.
    const sql = fakeSql();
    const recorder = createEvalRecorder({
      store: sqlEvalNodeStore(sql),
      clock: manualClock(),
      redact: passthroughRedactor,
      timers: systemTimers(),
      ledger: inMemoryRunLedger(),
    });
    const opensAfterAbort = defineSubject({
      version: testSubjectVersion,
      purity: "pure",
      decide: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        // The case budget is spent by now, so `child` takes the abort branch.
        return ctx.node.child({ name: "too-late", v: 1, payload: {} }, async () =>
          determine("duplicate", 9_000),
        );
      },
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: opensAfterAbort,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: { ...smallLimits, concurrency: 1, perCaseMillis: 5 },
      priceTable,
    });
    expect(report.casesRun).toBe(3);
    // Never more settles than nodes: no node was offered to the store twice, and
    // none was silently swallowed on the way there either.
    const updates = sql.statements.filter((s) => s.includes("UPDATE agent_ops.eval_node")).length;
    const inserts = sql.statements.filter((s) =>
      s.includes("INSERT INTO agent_ops.eval_node"),
    ).length;
    expect(updates).toBeLessThanOrEqual(inserts);
    expect(updates).toBeGreaterThan(0);
  }, 20_000);
});
