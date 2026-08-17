import { basisPoints, digestOf } from "./canonical.js";
import {
  DuplicateCaseRef,
  EvalsError,
  LimitOutOfRange,
  RunBudgetExhausted,
  SubjectAttemptedWrite,
  SuiteUnversioned,
} from "./errors.js";
import type { EvalRecorder, RunScope } from "./recorder.js";
import { recorderInternals } from "./recorder.js";
import type {
  AccuracyCaseResult,
  AccuracyCaseStatus,
  AccuracyReport,
  AgreementCaseResult,
  AgreementCaseStatus,
  AgreementReport,
  Attribution,
  Determinism,
  Disagreement,
  RunFacts,
} from "./report.js";
import { mintAccuracyReport, mintAgreementReport } from "./report.js";
import type { ModelBackend } from "./clients.js";
import type {
  CaseRef,
  CaseSource,
  EvalCase,
  EvalNodeId,
  Limits,
  PriceTable,
  ScoreOutcome,
  Scorer,
  Seed,
  SourceKind,
  Subject,
  Timers,
  Verdict,
} from "./types.js";

/**
 * The runner. One entry point, two case sources, two report types.
 *
 * The report type is derived from the **case source**, never from which function
 * the caller reached for. There is no `runShadow` and no `mode: "shadow"` flag:
 * a shadow run is a run whose cases came from production, and the type system
 * knows that because `CaseSource<"recorded">` produces `AgreementReport`.
 *
 * The shadow path gets exactly the same interface as the gate path, which is a
 * deliberate reversal of the design exercise's winning shape. Per ADR 0001,
 * trigger 3, shadow evaluation is the only thing that could ever falsify this
 * library's workflows-not-agents stance — and a trigger nobody can afford to
 * measure is a decision nobody can falsify.
 */

export type ReportOf<K extends SourceKind> = K extends "golden"
  ? AccuracyReport
  : K extends "recorded"
    ? AgreementReport
    : never;

export interface RunSpec<K extends SourceKind> {
  /** Human-readable, recorded on the run node. "pre-merge", "nightly-shadow". */
  readonly label: string;
  readonly cases: CaseSource<K>;
  readonly subject: Subject;
  /** At least one, in the type. A run with no scorer measures nothing. */
  readonly scorers: readonly [Scorer, ...Scorer[]];
  /**
   * The only thing in this module that can dial out, and it is injected. There
   * is no default and no internally-constructed client, which is what makes a
   * test structurally unable to reach a live model with real credentials
   * present in the environment.
   */
  readonly models: ModelBackend;
  /**
   * Branded, and supplied here by the composition root — **not** by the subject.
   * The thing being measured does not choose its own witness.
   */
  readonly recorder: EvalRecorder;
  /** Required. No default seed: a default makes a run look reproducible. */
  readonly seed: Seed;
  /** Required. Pass `DEFAULT_LIMITS` explicitly; see the note on `Limits`. */
  readonly limits: Limits;
  /** Required. A default price table silently rewrites historical cost figures. */
  readonly priceTable: PriceTable;
}

/**
 * The shipped bounds. Concurrency 8 with a 12-second per-case budget is the
 * 200-cases-in-5-minutes target: 200/8 = 25 waves × 12 s = 300 s.
 */
export const DEFAULT_LIMITS: Limits = {
  concurrency: 8,
  perCaseMillis: 12_000,
  runMillis: 300_000,
  maxCaseFailures: 20,
  retries: 3,
  costCeilingTenthCents: 15_000,
};

const RANGES: Readonly<Record<keyof Limits, readonly [number, number]>> = {
  concurrency: [1, 32],
  perCaseMillis: [1, 600_000],
  runMillis: [1, 7_200_000],
  maxCaseFailures: [0, 1_000],
  retries: [0, 5],
  costCeilingTenthCents: [1, 10_000_000],
};

const checkLimits = (limits: Limits): void => {
  for (const key of Object.keys(RANGES) as (keyof Limits)[]) {
    const range = RANGES[key];
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < range[0] || value > range[1]) {
      throw new LimitOutOfRange(key, value, `${range[0]}..${range[1]} (integer)`);
    }
  }
};

interface CaseRun {
  readonly ref: CaseRef;
  readonly node: EvalNodeId;
  readonly observed: Verdict | null;
  readonly matched: boolean;
  readonly status: "matched" | "mismatched" | "unscored" | "contested" | "unattributed";
  readonly scoreBasisPoints: number;
  readonly detail: string | null;
  readonly failed: boolean;
  readonly modelCalls: number;
  readonly costTenthCents: number;
}

/**
 * Race a promise against an abort signal.
 *
 * This is what makes a wall clock a wall clock. `run` set two
 * `AbortController`s and then `await`ed `spec.subject.decide` directly, so a
 * subject that ignores `ctx.signal` — application code, holding its own closure,
 * which is the whole population this module measures — hung the case, the
 * worker, the pool and the run, for ever. With `runMillis: 100` and
 * `perCaseMillis: 50` the run was still hanging at 1503ms.
 *
 * The honest limit, stated because it is a real one: **nothing here kills the
 * subject.** JavaScript cannot. The subject's promise keeps running and its
 * rejection, if it ever produces one, is swallowed here rather than left to
 * become an unhandled rejection in a process that has moved on. What the race
 * guarantees is that the *run* terminates, the node is settled `timeout`, and
 * the report is `partial` — which is the difference between a bounded system
 * and a hung one.
 */
const raceAbort = async <T>(work: Promise<T>, signal: AbortSignal, what: string): Promise<T> => {
  if (signal.aborted) throw new DOMException(what, "AbortError");
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DOMException(what, "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    // The loser of the race is unreachable but still live. Swallow its rejection
    // here rather than leave an unhandled one behind a run that has finished.
    void work.catch(() => undefined);
  }
};

export const run = async <K extends SourceKind>(spec: RunSpec<K>): Promise<ReportOf<K>> => {
  checkLimits(spec.limits);

  // Refused before the first model call and before any money is spent. A report
  // against an unversioned source is a number with no referent.
  if (spec.cases.digest.length === 0) {
    throw new SuiteUnversioned("digest is empty");
  }
  if (spec.cases.size !== spec.cases.cases.length) {
    throw new SuiteUnversioned(
      `declared size ${spec.cases.size} but carries ${spec.cases.cases.length} cases`,
    );
  }
  // Refused before any spend, for the same reason `goldenSuite` refuses it at
  // construction: results are keyed by reference, so a duplicate means the
  // report and the trace disagree about what ran. The shipped adapters make this
  // unreachable; a hand-rolled `CaseSource` is the only way here.
  const refs = new Set<string>();
  for (const evalCase of spec.cases.cases) {
    if (refs.has(evalCase.ref)) throw new DuplicateCaseRef(evalCase.ref);
    refs.add(evalCase.ref);
  }

  const internals = recorderInternals(spec.recorder);
  const timers: Timers = internals.timers;
  const runKey = digestOf([
    spec.cases.digest,
    spec.subject.version,
    ...spec.scorers.map((s) => s.descriptor.digest),
    spec.seed,
    spec.priceTable.version,
    JSON.stringify(spec.limits),
  ]);

  const runController = new AbortController();
  let partialReason: string | null = null;
  const budgetSpent = (which: "wall-clock" | "case-failures" | "cost", detail: string): void => {
    if (partialReason === null) partialReason = new RunBudgetExhausted(which, detail).message;
    runController.abort();
  };
  // Driven by the injected timers, not by ambient `setTimeout`, so a test can
  // advance the run's wall clock without spending it.
  const cancelRunTimer = timers.deadline(spec.limits.runMillis, () => {
    budgetSpent("wall-clock", `runMillis=${spec.limits.runMillis} spent`);
  });

  let scope: RunScope;
  try {
    scope = await internals.beginRun({
      idPrefix: runKey.slice(-16),
      costCeilingTenthCents: spec.limits.costCeilingTenthCents,
      onCostCeiling: (spent) => {
        budgetSpent(
          "cost",
          `${spent} tenth-cents exceeds costCeilingTenthCents=${spec.limits.costCeilingTenthCents}`,
        );
      },
      header: {
        label: spec.label,
        sourceKind: spec.cases.kind,
        sourceDigest: spec.cases.digest,
        subjectVersion: spec.subject.version,
        seed: spec.seed,
      },
      models: spec.models,
      priceTable: spec.priceTable,
      retries: spec.limits.retries,
      signal: runController.signal,
      runPayload: {
        runKey,
        label: spec.label,
        sourceKind: spec.cases.kind,
        sourceDigest: spec.cases.digest,
        subjectVersion: spec.subject.version,
        subjectPurity: spec.subject.purity,
        seed: spec.seed,
        scorers: spec.scorers.map((s) => s.descriptor.id).join(","),
        concurrency: spec.limits.concurrency,
        perCaseMillis: spec.limits.perCaseMillis,
        runMillis: spec.limits.runMillis,
        retries: spec.limits.retries,
        costCeilingTenthCents: spec.limits.costCeilingTenthCents,
        priceTableVersion: spec.priceTable.version,
        declaredCases: spec.cases.size,
        capturedVia: "injected-client-only",
      },
    });
  } catch (cause) {
    cancelRunTimer();
    throw cause;
  }
  const runId = scope.runId;

  const startedAt = scope.runNode.context.now();
  const results = new Map<CaseRef, CaseRun>();
  let failures = 0;
  let attemptedWrite: SubjectAttemptedWrite | undefined;

  // The cohort's own assembly, recorded. `recordedCases` reaches the audit store
  // before a run exists and can record nothing itself, so the facts it produced
  // are stamped here: which adapter named the human decisions, over what window,
  // how many cases were considered and how many were dropped for having none.
  const provenance = spec.cases.provenance as RecordedProvenance | null;
  const sourceNode = await scope.runNode.open({
    kind: "source",
    name: spec.cases.kind,
    v: 1,
    payload: {
      sourceKind: spec.cases.kind,
      sourceDigest: spec.cases.digest,
      declared: spec.cases.size,
      humanDecisionSource: provenance?.humanDecisionSource ?? null,
      windowFromInclusive: provenance?.window.fromInclusive ?? null,
      windowToExclusive: provenance?.window.toExclusive ?? null,
      considered: provenance?.considered ?? spec.cases.size,
      withoutHumanDecision: provenance?.withoutHumanDecision ?? 0,
    },
    signal: runController.signal,
  });
  await sourceNode.settle({ outcome: "ok", closing: {} });

  const queue = [...spec.cases.cases];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (partialReason !== null || attemptedWrite !== undefined) return;
      const index = next;
      next += 1;
      const evalCase = queue[index];
      if (evalCase === undefined) return;

      try {
        const result = await runCase(scope, spec, evalCase, runController.signal, timers);
        results.set(result.ref, result);
        if (result.failed) failures += 1;
      } catch (cause) {
        if (cause instanceof SubjectAttemptedWrite) {
          attemptedWrite = cause;
          runController.abort();
          return;
        }
        // Everything else — `EvalStoreUnavailable` above all — aborts the run
        // and propagates. There is no tier and no configuration key at which an
        // unrecorded eval run is the right answer: it produces a number nobody
        // can check, and being checkable is this module's only purpose.
        runController.abort();
        throw cause;
      }

      if (failures > spec.limits.maxCaseFailures) {
        budgetSpent(
          "case-failures",
          `${failures} case failures exceeds maxCaseFailures=${spec.limits.maxCaseFailures}`,
        );
        return;
      }
      if (runController.signal.aborted) return;
    }
  };

  // Bounded concurrency. A fixed pool of workers pulling from one cursor: no
  // unbounded `Promise.all` over the suite, no unbounded queue, and never more
  // than `concurrency` cases in flight — which is what stops an eval run
  // rate-limiting the provider and producing failures that read as regressions.
  const pool = Array.from(
    { length: Math.min(spec.limits.concurrency, queue.length) },
    () => worker(),
  );
  try {
    await Promise.all(pool);
  } finally {
    cancelRunTimer();
  }

  // Safety net. Any path that left cases unrun — the wall clock, an abort that
  // raced the last case off the queue — marks the report partial. A run that did
  // not cover its declared suite must never present itself as one that did,
  // because a partial report cannot pass a gate and that is the whole point.
  if (partialReason === null && results.size < spec.cases.cases.length) {
    partialReason = new RunBudgetExhausted(
      "wall-clock",
      `runMillis=${spec.limits.runMillis} spent; ${results.size} of ${spec.cases.size} declared cases ran`,
    ).message;
  }

  const ordered = spec.cases.cases
    .map((c) => results.get(c.ref))
    .filter((r): r is CaseRun => r !== undefined);

  const attributedCases = ordered.filter((r) => r.status !== "unattributed").length;
  const unattributedCases = ordered.filter((r) => r.status === "unattributed").map((r) => r.ref);
  const attribution: Attribution = unattributedCases.length === 0 ? "complete" : "partial";

  const aggregate = await scope.runNode.open({
    kind: "aggregate",
    name: "aggregate",
    v: 1,
    payload: {
      casesRun: ordered.length,
      matched: ordered.filter((r) => r.status === "matched").length,
      mismatched: ordered.filter((r) => r.status === "mismatched").length,
      unscored: ordered.filter((r) => r.status === "unscored").length,
      contested: ordered.filter((r) => r.status === "contested").length,
      unattributed: unattributedCases.length,
      attribution,
    },
    signal: runController.signal,
  });
  await aggregate.settle({ outcome: "ok", closing: {} });

  const finishedAt = scope.runNode.context.now();
  const trace = await scope.finish({
    outcome: attemptedWrite !== undefined ? "aborted" : partialReason === null ? "ok" : "timeout",
    closing: { partial: partialReason !== null, casesRun: ordered.length },
  });

  if (attemptedWrite !== undefined) {
    // Fail-closed, whole run, no report. A subject that reached for an effect
    // may have completed one through a channel this module does not own, so the
    // no-effect guarantee is void for every remaining case. The nodes stay
    // written and stay replayable; only the report is suppressed.
    throw attemptedWrite;
  }

  const stored = await scope.read();
  const costComplete = !stored.nodes.some(
    (n) => n.kind === "model.call" && n.payload["price.known"] === false,
  );

  const nonDeterminismReasons = spec.scorers
    .filter((s) => s.descriptor.determinism === "non-deterministic")
    .map((s) => `scorer ${s.descriptor.id} is non-deterministic`);
  const determinism: Determinism =
    nonDeterminismReasons.length === 0
      ? { declared: "deterministic" }
      : { declared: "non-deterministic", reasons: nonDeterminismReasons };

  const facts: RunFacts = {
    runId,
    runNode: scope.runNode.id,
    label: spec.label,
    runKey,
    subjectVersion: spec.subject.version,
    subjectPurity: spec.subject.purity,
    seed: spec.seed,
    scorers: spec.scorers.map((s) => s.descriptor),
    determinism,
    attribution,
    attributionCoverageBasisPoints: basisPoints(attributedCases, ordered.length),
    unattributedCases,
    partial: partialReason !== null,
    partialReason,
    casesRun: ordered.length,
    casesDeclared: spec.cases.size,
    costTenthCents: scope.runNode.costTenthCents(),
    costComplete,
    tokensIn: sumTokens(stored.nodes, "tokensIn"),
    tokensOut: sumTokens(stored.nodes, "tokensOut"),
    priceTableVersion: spec.priceTable.version,
    startedAt,
    finishedAt,
    traceDigest: trace.digest,
    nodes: trace.nodes,
    capturedVia: "injected-client-only",
  };

  // The denominator is every case that ran, so `unscored`, `contested` and
  // `unattributed` cannot flatter the number by leaving it.
  const denominator = ordered.length;
  const rate = (predicate: (r: CaseRun) => boolean): number =>
    basisPoints(ordered.filter(predicate).length, denominator);

  if (spec.cases.kind === "golden") {
    const source = spec.cases as CaseSource<"golden">;
    const byRef = new Map(source.cases.map((c) => [c.ref, c]));
    const cases: AccuracyCaseResult[] = ordered.map((r) => {
      const evalCase = byRef.get(r.ref);
      return {
        ref: r.ref,
        digest: evalCase?.digest ?? ("" as never),
        tier: evalCase?.tier ?? "low",
        status: accuracyStatus(r.status),
        scoreBasisPoints: r.scoreBasisPoints,
        observed: r.observed,
        expected: evalCase?.expectation.verdict ?? {
          disposition: "abstain",
          conclusion: "",
          confidenceBasisPoints: 0,
          because: "case vanished",
        },
        node: r.node,
        detail: r.detail,
      };
    });
    return mintAccuracyReport(
      facts,
      source.digest,
      {
        correctBasisPoints: rate((r) => r.status === "matched"),
        incorrectBasisPoints: rate((r) => r.status === "mismatched"),
        unscoredBasisPoints: rate((r) => r.status === "unscored" || r.status === "unattributed"),
        contestedBasisPoints: rate((r) => r.status === "contested"),
      },
      cases,
    ) as ReportOf<K>;
  }

  const source = spec.cases as CaseSource<"recorded">;
  const byRef = new Map(source.cases.map((c) => [c.ref, c]));
  const cases: AgreementCaseResult[] = ordered.map((r) => {
    const evalCase = byRef.get(r.ref);
    const expectation = evalCase?.expectation;
    return {
      ref: r.ref,
      digest: evalCase?.digest ?? ("" as never),
      tier: evalCase?.tier ?? "low",
      status: agreementStatus(r.status),
      scoreBasisPoints: r.scoreBasisPoints,
      observed: r.observed,
      humanVerdict: expectation?.verdict ?? {
        disposition: "abstain",
        conclusion: "",
        confidenceBasisPoints: 0,
        because: "case vanished",
      },
      authority: expectation?.authority ?? "unknown",
      correlationId: expectation?.correlationId ?? "",
      node: r.node,
      detail: r.detail,
    };
  });
  const disagreements: Disagreement[] = cases
    .filter((c) => c.status === "disagreed" && c.observed !== null)
    .map((c) => ({
      ref: c.ref,
      correlationId: c.correlationId,
      tier: c.tier,
      humanVerdict: c.humanVerdict,
      systemVerdict: c.observed as Verdict,
      authority: c.authority,
      node: c.node,
    }));
  return mintAgreementReport(
    facts,
    source.digest,
    source.provenance,
    {
      agreementBasisPoints: rate((r) => r.status === "matched"),
      disagreedBasisPoints: rate((r) => r.status === "mismatched"),
      unscoredBasisPoints: rate((r) => r.status === "unscored" || r.status === "unattributed"),
      contestedBasisPoints: rate((r) => r.status === "contested"),
    },
    disagreements,
    cases,
  ) as ReportOf<K>;
};

/* ------------------------------------------------------------------ one case */

const runCase = async <K extends SourceKind>(
  scope: RunScope,
  spec: RunSpec<K>,
  evalCase: EvalCase<K>,
  runSignal: AbortSignal,
): Promise<CaseRun> => {
  const caseNode = await scope.runNode.open({
    kind: "case",
    name: evalCase.ref,
    v: 1,
    payload: {
      ref: evalCase.ref,
      digest: evalCase.digest,
      tier: evalCase.tier,
      expectationKind: evalCase.expectation.kind,
    },
    signal: runSignal,
  });

  const controller = new AbortController();
  const onRunAbort = (): void => controller.abort();
  runSignal.addEventListener("abort", onRunAbort, { once: true });
  const caseTimer = setTimeout(() => controller.abort(), spec.limits.perCaseMillis);
  caseTimer.unref?.();

  const caseSeed = `${spec.seed}:${evalCase.ref}` as Seed;

  try {
    const decisionNode = await caseNode.open({
      kind: "decision",
      name: "decide",
      v: 1,
      payload: { ref: evalCase.ref, tier: evalCase.tier, seed: caseSeed },
      signal: controller.signal,
    });

    let observed: Verdict | null = null;
    let failed = false;
    let detail: string | null = null;

    try {
      observed = await spec.subject.decide({
        node: decisionNode.context.node,
        client: decisionNode.context.client,
        input: evalCase.input,
        tier: evalCase.tier,
        seed: caseSeed,
        now: decisionNode.context.now,
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause instanceof SubjectAttemptedWrite) {
        await decisionNode.settle({ outcome: "error", closing: { attemptedWrite: true } });
        await caseNode.settle({ outcome: "error", closing: { attemptedWrite: true } });
        throw cause;
      }
      failed = true;
      detail = controller.signal.aborted ? "case budget spent" : describe(cause);
      // Fail-closed per case, fail-open per run. One crashing case must not
      // destroy the evidence from the other 199, and must not be quietly
      // excluded either: a subject that throws *is* a regression.
      await decisionNode.settle({
        outcome: controller.signal.aborted ? "timeout" : "error",
        closing: { detail },
      });
    }

    const modelCalls = decisionNode.modelCalls();
    const unattributed = spec.subject.purity === "calls-models" && modelCalls === 0 && !failed;

    if (observed !== null) {
      await decisionNode.settle({
        outcome: unattributed
          ? "unattributed"
          : observed.disposition === "abstain"
            ? "abstained"
            : "ok",
        closing: {
          disposition: observed.disposition,
          conclusion: observed.conclusion,
          confidenceBasisPoints: observed.confidenceBasisPoints,
          because: observed.because,
          modelCalls,
          purity: spec.subject.purity,
        },
      });
    }

    if (failed || observed === null) {
      await caseNode.settle({ outcome: "error", closing: { status: "unscored", detail } });
      return {
        ref: evalCase.ref,
        node: caseNode.id,
        observed: null,
        matched: false,
        status: "unscored",
        scoreBasisPoints: 0,
        detail,
        failed: true,
      };
    }

    if (unattributed) {
      // An `UnattributedDecision`. The subject said it calls models and then
      // recorded none: it thought somewhere this module cannot see. Unscored,
      // counted against the coverage floor, and it fails the build — silent
      // under-recording becomes a red build rather than a quiet green one.
      await caseNode.settle({
        outcome: "unattributed",
        closing: { status: "unattributed", modelCalls: 0, purity: spec.subject.purity },
      });
      return {
        ref: evalCase.ref,
        node: caseNode.id,
        observed,
        matched: false,
        status: "unattributed",
        scoreBasisPoints: 0,
        detail: "decision subtree recorded no model call and the subject is not declared pure",
        failed: false,
      };
    }

    const outcomes: ScoreOutcome[] = [];
    for (const scorer of spec.scorers) {
      const scoringNode = await caseNode.open({
        kind: "scoring",
        name: scorer.descriptor.id,
        v: 1,
        payload: {
          scorer: scorer.descriptor.id,
          scorerDigest: scorer.descriptor.digest,
          determinism: scorer.descriptor.determinism,
          judgeModel: scorer.descriptor.judge?.model ?? null,
          judgePromptVersion: scorer.descriptor.judge?.promptVersion ?? null,
          panelSize: scorer.descriptor.judge?.panelSize ?? null,
        },
        signal: controller.signal,
      });
      let outcome: ScoreOutcome;
      try {
        outcome = await scorer.score({
          node: scoringNode.context.node,
          judge: scoringNode.context.client,
          observed,
          expected: evalCase.expectation.verdict,
          seed: caseSeed,
          signal: controller.signal,
        });
      } catch (cause) {
        outcome = { kind: "unscored", reason: describe(cause) };
      }
      await scoringNode.settle({
        outcome:
          outcome.kind === "scored"
            ? "ok"
            : outcome.kind === "contested"
              ? "indeterminate"
              : "indeterminate",
        closing: scoreClosing(outcome),
      });
      outcomes.push(outcome);
    }

    const combined = combine(outcomes);
    await caseNode.settle({
      outcome: combined.status === "unscored" || combined.status === "contested" ? "indeterminate" : "ok",
      closing: {
        status: combined.status,
        scoreBasisPoints: combined.scoreBasisPoints,
        modelCalls,
      },
    });
    return {
      ref: evalCase.ref,
      node: caseNode.id,
      observed,
      matched: combined.status === "matched",
      status: combined.status,
      scoreBasisPoints: combined.scoreBasisPoints,
      detail: combined.detail,
      failed: false,
    };
  } finally {
    clearTimeout(caseTimer);
    runSignal.removeEventListener("abort", onRunAbort);
  }
};

const combine = (
  outcomes: readonly ScoreOutcome[],
): {
  readonly status: "matched" | "mismatched" | "contested" | "unscored";
  readonly scoreBasisPoints: number;
  readonly detail: string | null;
} => {
  const unscored = outcomes.find((o) => o.kind === "unscored");
  if (unscored !== undefined && unscored.kind === "unscored") {
    return { status: "unscored", scoreBasisPoints: 0, detail: unscored.reason };
  }
  const contested = outcomes.find((o) => o.kind === "contested");
  if (contested !== undefined && contested.kind === "contested") {
    return {
      status: "contested",
      scoreBasisPoints: 0,
      detail: `panel spread ${contested.spreadBasisPoints}bp: ${contested.samplesBasisPoints.join("/")}`,
    };
  }
  const values = outcomes.map((o) => (o.kind === "scored" ? o.valueBasisPoints : 0));
  // The strictest scorer wins. A case that one scorer calls wrong is not a case
  // that went well, whatever the others thought.
  const score = values.length === 0 ? 0 : Math.min(...values);
  return { status: score === 10_000 ? "matched" : "mismatched", scoreBasisPoints: score, detail: null };
};

const scoreClosing = (
  outcome: ScoreOutcome,
): Readonly<Record<string, string | number | boolean | null>> => {
  switch (outcome.kind) {
    case "scored":
      return { kind: "scored", valueBasisPoints: outcome.valueBasisPoints };
    case "contested":
      // Surfaced, never averaged. Every sample is on the node.
      return {
        kind: "contested",
        spreadBasisPoints: outcome.spreadBasisPoints,
        samples: outcome.samplesBasisPoints.join("/"),
      };
    case "unscored":
      return { kind: "unscored", reason: outcome.reason };
  }
};

const accuracyStatus = (status: CaseRun["status"]): AccuracyCaseStatus =>
  status === "matched"
    ? "correct"
    : status === "mismatched"
      ? "incorrect"
      : status === "contested"
        ? "contested"
        : status === "unattributed"
          ? "unattributed"
          : "unscored";

const agreementStatus = (status: CaseRun["status"]): AgreementCaseStatus =>
  status === "matched"
    ? "agreed"
    : status === "mismatched"
      ? "disagreed"
      : status === "contested"
        ? "contested"
        : status === "unattributed"
          ? "unattributed"
          : "unscored";

const sumTokens = (
  nodes: readonly { readonly kind: string; readonly tokensIn: number; readonly tokensOut: number }[],
  field: "tokensIn" | "tokensOut",
): number => nodes.filter((n) => n.kind === "model.call").reduce((total, n) => total + n[field], 0);

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

/**
 * Run identity is random, node identity is store-assigned, and neither is
 * caller-assigned. The *content* address of what was run is the `runKey`, which
 * is recorded on the run node — so two runs of the same suite, subject, scorers,
 * seed, price table and limits are recognisable as repeats without pretending
 * they are the same execution.
 */
const randomSuffix = (): string => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
