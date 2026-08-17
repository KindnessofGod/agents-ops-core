import { describe, expect, it } from "vitest";
import {
  accept,
  createEvalRecorder,
  DEFAULT_FLOORS,
  defineSubject,
  determine,
  EvalStoreUnavailable,
  exactVerdict,
  exitCodeFor,
  gate,
  goldenSuite,
  inMemoryEvalNodeStore,
  inMemoryRunLedger,
  LedgerNotMinted,
  LimitOutOfRange,
  ProviderUnavailable,
  RecorderNotMinted,
  ReportRefused,
  run,
  scriptedModelBackend,
  RunBudgetExhausted,
  StoreNotMinted,
  SubjectAttemptedWrite,
  SuiteEmpty,
  SuiteUnversioned,
  SuiteVersionMismatch,
  systemTimers,
} from "../index.js";
import type { GateBlockReason, GateOutcome, RunSpec, Subject } from "../index.js";
import {
  echoBackend,
  harness,
  manualClock,
  passthroughRedactor,
  priceTable,
  PROMPT_V1,
  smallLimits,
  TEST_MODEL,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/**
 * Exit codes for the command-line adapter, decided in the library so the
 * decision is testable without spawning a process.
 *
 *   `0` passed on evidence
 *   `1` **evidence failure** — the change made something worse, or removed the
 *       evidence that would have shown it
 *   `2` **could not be evaluated** — nothing was established, in either
 *       direction
 *   `3` **integrity failure** — the machinery is wrong
 *
 * The two in the middle are the point. Conflating `2` with `0` is the silent
 * pass this module exists to prevent; conflating it with `1` teaches people to
 * ignore `1`, and then a real regression goes past unread.
 */

const subject: Subject = defineSubject({
  version: testSubjectVersion,
  purity: "pure",
  decide: async () => determine("duplicate", 9_000),
});

const specFor = (): Omit<RunSpec<"golden">, "recorder"> => ({
  label: "pre-merge",
  cases: threeInvoices(),
  subject,
  scorers: [exactVerdict],
  models: echoBackend(),
  seed: testSeed,
  limits: smallLimits,
  priceTable,
});

describe("the passing code", () => {
  it("exits 0 and says on the pass line what it covered", async () => {
    const { recorder } = harness();
    const report = await run({ ...specFor(), recorder });
    const baseline = accept({ report, by: "a.engineer", at: 1_700_000_000_000 });
    const outcome = await gate({ report, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(outcome.kind).toBe("passed");

    const decision = exitCodeFor({ kind: "gate", outcome });
    expect(decision.code).toBe(0);
    expect(decision.kind).toBe("pass");
    // Coverage on the **pass** line, not only the failure line — a green build
    // that covered 61 of 214 cases should say so where somebody merging at 07:40
    // will read it.
    expect(decision.line).toContain("PASS");
    expect(decision.line).toContain("full suite");
  });
});

describe("every gate block reason is classified, and adding one without classifying it does not compile", () => {
  /**
   * The exhaustive table. `classifyBlock` is a `switch` with no `default` over
   * `GateBlockReason`, so a new reason is a compile error until somebody decides
   * what it means — which is the only part of this that has to stay true as the
   * gate grows.
   */
  const expected: Readonly<Record<GateBlockReason, 1 | 2>> = {
    // The change made something worse, or removed the evidence.
    regression: 1,
    "dropped-cases": 1,
    "edited-cases": 1,
    // Nothing was established, in either direction.
    "baseline-missing": 2,
    "partial-run": 2,
    "unattributed-decisions": 2,
    "unscored-rate": 2,
    "contested-rate": 2,
    "could-not-evaluate": 2,
    "non-deterministic-subject": 2,
  };

  const blocked = (reason: GateBlockReason): GateOutcome => ({
    kind: "blocked",
    reason,
    detail: "detail",
    remedy: "remedy",
    runId: "run-1" as GateOutcome["runId"],
    gateRun: "gate-1" as GateOutcome["gateRun"],
    node: "node-1" as GateOutcome["node"],
    counts: { regressed: [], improved: [], unchanged: 0, newCases: [], dropped: [], edited: [] },
    coverage: { kind: "full", label: null, casesRun: 3, suiteSize: 3, notCovered: [] },
  });

  for (const [reason, code] of Object.entries(expected) as [GateBlockReason, 1 | 2][]) {
    it(`maps ${reason} to ${String(code)}`, () => {
      const decision = exitCodeFor({ kind: "gate", outcome: blocked(reason) });
      expect(decision.code).toBe(code);
      expect(decision.reason).toBe(reason);
      expect(decision.kind).toBe(code === 1 ? "evidence-failure" : "could-not-evaluate");
    });
  }

  it("never returns 0 for a blocked gate, whatever the reason", () => {
    for (const reason of Object.keys(expected) as GateBlockReason[]) {
      expect(exitCodeFor({ kind: "gate", outcome: blocked(reason) }).code).not.toBe(0);
    }
  });
});

describe("a thrown failure", () => {
  it("exits 3 for every incident — the machinery, not the change", () => {
    // Every `EvalsError` whose `incident` is true. The module already classifies
    // its own error modes; this reads that classification rather than
    // maintaining a second list that could drift from it.
    const incidents: readonly unknown[] = [
      new EvalStoreUnavailable("append", "connection reset"),
      new RecorderNotMinted(),
      new StoreNotMinted(),
      new LedgerNotMinted(),
      new SubjectAttemptedWrite("INV-0001", "decide"),
    ];
    for (const error of incidents) {
      const decision = exitCodeFor({ kind: "threw", error });
      expect(decision.code).toBe(3);
      expect(decision.kind).toBe("integrity-failure");
      expect(decision.line).toContain("INTEGRITY");
    }
  });

  it("exits 3 for an unreadable suite or artefact — machinery, never a regression", () => {
    const faults: readonly unknown[] = [
      new SuiteUnversioned("digest is empty"),
      new SuiteVersionMismatch("a", "b"),
      new SuiteEmpty(),
      new ReportRefused("schema is wrong"),
      new LimitOutOfRange("concurrency", 99, "1..32"),
    ];
    for (const error of faults) {
      expect(exitCodeFor({ kind: "threw", error }).code).toBe(3);
    }
  });

  it("exits 2 when nothing was established and nothing is broken", () => {
    expect(
      exitCodeFor({ kind: "threw", error: new ProviderUnavailable("m", "429", null) }).code,
    ).toBe(2);
    expect(
      exitCodeFor({ kind: "threw", error: new RunBudgetExhausted("wall-clock", "spent") }).code,
    ).toBe(2);
  });

  it("exits 3 for anything it does not recognise — 3, never 1, and never 0", () => {
    // An unnamed failure is a fault in the machinery until proven otherwise.
    // Reporting it as an ordinary regression would put it in the queue of things
    // engineers triage by re-running.
    for (const error of [new TypeError("cannot read properties of undefined"), "a string", 42]) {
      const decision = exitCodeFor({ kind: "threw", error });
      expect(decision.code).toBe(3);
      expect(decision.kind).toBe("integrity-failure");
    }
  });
});

describe("end to end, on a real gate", () => {
  it("exits 2 on the first run of a suite, where a silent pass is most tempting", async () => {
    const { recorder } = harness();
    const report = await run({ ...specFor(), recorder });
    const outcome = await gate({ report, baseline: undefined, floors: DEFAULT_FLOORS, recorder });
    const decision = exitCodeFor({ kind: "gate", outcome });
    // Not 0. A gate that quietly succeeds because it had nothing to compare
    // against is worse than no gate — and not 1 either, because nothing has
    // gone wrong with the change.
    expect(decision.code).toBe(2);
    expect(decision.reason).toBe("baseline-missing");
  });

  it("exits 1 when a golden case that used to pass now fails", async () => {
    const { recorder } = harness();
    const good = await run({ ...specFor(), recorder });
    const baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });

    const worse = await run({
      ...specFor(),
      subject: defineSubject({
        version: testSubjectVersion,
        purity: "pure",
        decide: async () => determine("not-duplicate", 9_000),
      }),
      recorder: harness().recorder,
    });
    const outcome = await gate({ report: worse, baseline, floors: DEFAULT_FLOORS, recorder });
    const decision = exitCodeFor({ kind: "gate", outcome });
    expect(decision.code).toBe(1);
    expect(decision.kind).toBe("evidence-failure");
    expect(decision.line).toContain("FAIL");
  });

  it("exits 1 when the failing golden case is deleted instead of adjudicated", async () => {
    const { recorder } = harness();
    const good = await run({ ...specFor(), recorder });
    const baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });

    const shrunk = await run({
      ...specFor(),
      cases: goldenSuite({
        cases: [
          {
            ref: "INV-0001",
            tier: "high",
            input: { supplier: "acme", amountMinorUnits: 4_720_000 },
            expected: determine("duplicate", 9_000),
            adjudicatedBy: "a.reviewer",
            adjudicatedAt: 1_690_000_000_000,
          },
        ],
      }),
      recorder: harness().recorder,
    });
    const outcome = await gate({ report: shrunk, baseline, floors: DEFAULT_FLOORS, recorder });
    // Deleting evidence is the author acting on the evidence, so it is an
    // evidence failure rather than a machinery fault.
    expect(exitCodeFor({ kind: "gate", outcome }).code).toBe(1);
  });
});

/**
 * The four codes, each produced by a real pipeline rather than by a
 * hand-constructed outcome, and asserted to be four rather than three.
 *
 * Every case above proves one mapping. What none of them proves is the property
 * the whole scheme rests on: that a build script branching on `$?` sees four
 * distinguishable answers. A table where two entries quietly agree is a table
 * that reads correctly and routes a rate-limit storm into the queue of things
 * engineers triage by re-reading a diff.
 */
describe("the four codes are four, end to end", () => {
  const callingSubject: Subject = defineSubject({
    version: testSubjectVersion,
    purity: "calls-models",
    decide: async (ctx) => {
      const answer = await ctx.client.complete({
        model: TEST_MODEL,
        promptVersion: PROMPT_V1,
        prompt: { ref: String(ctx.input["ref"] ?? "") },
      });
      return determine(answer.text, 9_000);
    },
  });

  const callingSuite = () => {
    const base = threeInvoices();
    return { ...base, cases: base.cases.map((c) => ({ ...c, input: { ...c.input, ref: c.ref } })) };
  };

  // `RunSpec.scorers` is a non-empty tuple — a run with no scorer measures
  // nothing and the type says so — and a bare array literal infers as
  // `Scorer[]`, which does not satisfy it. Annotating rather than casting keeps
  // the emptiness check live.
  const callingScorers: RunSpec<"golden">["scorers"] = [exactVerdict];

  const callingSpec = (models: RunSpec<"golden">["models"]) => ({
    label: "pre-merge" as const,
    cases: callingSuite(),
    subject: callingSubject,
    scorers: callingScorers,
    models,
    seed: testSeed,
    limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 5 },
    priceTable,
  });

  it("produces 0, 1, 2 and 3 from four real runs, and they are pairwise distinct", async () => {
    // 0 — passed on evidence.
    const { recorder } = harness();
    const good = await run({ ...callingSpec(echoBackend()), recorder });
    const baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });
    const passed = exitCodeFor({
      kind: "gate",
      outcome: await gate({ report: good, baseline, floors: DEFAULT_FLOORS, recorder }),
    });

    // 1 — evidence failure. The subject got worse; nothing is broken.
    const worse = await run({
      ...callingSpec(echoBackend(() => ({ text: "not-duplicate", tokensIn: 10, tokensOut: 2 }))),
      recorder: harness().recorder,
    });
    const regressed = exitCodeFor({
      kind: "gate",
      outcome: await gate({ report: worse, baseline, floors: DEFAULT_FLOORS, recorder }),
    });

    // 2 — could not be evaluated. The provider would not serve one case.
    const throttled = await run({
      ...callingSpec(
        scriptedModelBackend({
          id: "throttled",
          answer: (request) => {
            if (request.prompt["ref"] === "INV-0002") {
              throw new ProviderUnavailable("test-model", "429 Too Many Requests", null);
            }
            return { text: "duplicate", tokensIn: 10, tokensOut: 2 };
          },
        }),
      ),
      recorder: harness().recorder,
    });
    const indeterminate = exitCodeFor({
      kind: "gate",
      outcome: await gate({ report: throttled, baseline, floors: DEFAULT_FLOORS, recorder }),
    });

    // 3 — integrity failure. The store went away mid-run, which is fail-closed
    // at every tier: there is no tier at which an unrecorded eval run is the
    // right answer, so `run` throws rather than returning a report.
    const brokenStore = inMemoryEvalNodeStore();
    let appends = 0;
    Object.assign(brokenStore, {
      append: async () => {
        appends += 1;
        throw new EvalStoreUnavailable("append", "connection reset by peer");
      },
    });
    const brokenRecorder = createEvalRecorder({
      store: brokenStore,
      clock: manualClock(),
      redact: passthroughRedactor,
      timers: systemTimers(),
      ledger: inMemoryRunLedger(),
    });
    const thrown = await run({ ...callingSpec(echoBackend()), recorder: brokenRecorder }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(appends).toBeGreaterThan(0);
    expect(thrown).toBeInstanceOf(EvalStoreUnavailable);
    const integrity = exitCodeFor({ kind: "threw", error: thrown });

    expect(passed.code).toBe(0);
    expect(regressed.code).toBe(1);
    expect(indeterminate.code).toBe(2);
    expect(integrity.code).toBe(3);

    // Four, not three. This is the assertion a build script depends on.
    const codes = [passed.code, regressed.code, indeterminate.code, integrity.code];
    expect(new Set(codes).size).toBe(4);
    const kinds = [passed.kind, regressed.kind, indeterminate.kind, integrity.kind];
    expect(kinds).toEqual([
      "pass",
      "evidence-failure",
      "could-not-evaluate",
      "integrity-failure",
    ]);
    // And the four log lines are told apart by their first word, which is what
    // an engineer actually reads.
    expect(passed.line.startsWith("PASS")).toBe(true);
    expect(regressed.line.startsWith("FAIL")).toBe(true);
    expect(indeterminate.line.startsWith("INDETERMINATE")).toBe(true);
    expect(integrity.line.startsWith("INTEGRITY")).toBe(true);
  });
});
