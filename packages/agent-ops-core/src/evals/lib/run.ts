import { raiseAndRecord } from "../../alerts/index.js";
import type { CorrelationId as AlertCorrelationId } from "../../alerts/index.js";
import { basisPoints, canonicalPayloadForm, digestOf, seededRank } from "./canonical.js";
import {
  DuplicateCaseRef,
  EvalsError,
  LedgerCorrupt,
  LimitOutOfRange,
  MemoisedCaseMismatch,
  ProviderUnavailable,
  RunBudgetExhausted,
  RunNotMemoisable,
  SubjectAttemptedWrite,
  SuiteUnversioned,
} from "./errors.js";
import { mintCompletedRun, reopenMemoisedReport } from "./ledger.js";
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
  DeterminismCheck,
  Disagreement,
  Memoisation,
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
  MemoisedStatus,
  PriceTable,
  RecordedProvenance,
  RunKey,
  ScoreOutcome,
  Scorer,
  Seed,
  SourceKind,
  StoredCaseMemo,
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
 *
 * ## Idempotent, and resumable, which is a C2 requirement and was not built
 *
 * `run` is content-addressed by `runKeyOf(spec)`. Three behaviours follow, and
 * none of them is a flag:
 *
 *  1. **A completed key returns its original report and executes nothing.** Not
 *     a re-run that happens to agree — the original artefact, including the
 *     original `runId`, `startedAt` and `traceDigest`. That is the C2 idempotency
 *     rule ("a repeat returns the original outcome rather than re-executing or
 *     erroring") applied to the one thing in this module that costs real money.
 *  2. **An interrupted run resumes.** A 200-case run that died at case 180 pays
 *     for 20 cases, not 200. The 180 arrive as recorded `case` nodes stamped
 *     with the run and node they were carried forward from, so the trace says
 *     they were not observed today rather than implying they were.
 *  3. **A partial run is never memoised as complete.** `mintCompletedRun` is the
 *     only producer of the ledger's write type and it refuses one, so a
 *     budget-exceeded run cannot become a permanent, free, biased pass.
 *
 * To force a fresh execution, change something the key is made of. There is no
 * `force: true`, because a flag that defeats content addressing is a flag that
 * gets left on in a configuration file.
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
   *
   * An adapter raises `ProviderUnavailable` for a 429, a 503 or a reset, and
   * anything else it throws is an ordinary model failure. That distinction is
   * the whole of the difference between a build that says "you broke something"
   * and one that says "we could not tell".
   */
  readonly models: ModelBackend;
  /**
   * Branded, and supplied here by the composition root — **not** by the subject.
   * The thing being measured does not choose its own witness. It also carries
   * the run ledger, which is why idempotency is not a per-call decision.
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
  // 2 of 200. About 1% of the run's spend to find out whether the other 99%
  // means anything — and the report says `not-checked` rather than falling back
  // to a claim if this is set to 0.
  determinismSampleCases: 2,
};

const RANGES: Readonly<Record<keyof Limits, readonly [number, number]>> = {
  concurrency: [1, 32],
  perCaseMillis: [1, 600_000],
  runMillis: [1, 7_200_000],
  maxCaseFailures: [0, 1_000],
  retries: [0, 5],
  costCeilingTenthCents: [1, 10_000_000],
  determinismSampleCases: [0, 32],
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

/**
 * The content address of *what would be run*.
 *
 * Exported, and pure: it evaluates nothing, opens no node and reaches no store,
 * so it joins `accept`, `goldenSuite` and `defineSubject` rather than becoming a
 * third executing entry point. A caller asks the ledger
 * `findCompleted(runKeyOf(spec))` to find out whether a run will cost anything
 * before starting it — which is what a continuous-integration job wants to print
 * at the top of its log.
 *
 * Everything that could change the answer is in it: the source's digest (which
 * is why a subset has its own key), the subject's version *and* its purity
 * declaration, every scorer digest, the seed, the price-table version and every
 * limit. The **limits are canonicalised**, not `JSON.stringify`d, because
 * `JSON.stringify` is key-order dependent — two callers building the same limits
 * in a different field order used to get two different keys, so idempotency
 * would have depended on how somebody typed an object literal.
 *
 * The label is deliberately absent: `"pre-merge"` and `"nightly"` over the same
 * cases are one question asked twice.
 */
export const runKeyOf = <K extends SourceKind>(
  spec: Pick<RunSpec<K>, "cases" | "subject" | "scorers" | "seed" | "priceTable" | "limits">,
): RunKey =>
  digestOf([
    "runkey/1",
    spec.cases.digest,
    spec.subject.version,
    spec.subject.purity,
    ...spec.scorers.map((s) => s.descriptor.digest),
    spec.seed,
    spec.priceTable.version,
    // Every limit, sorted, integer-checked. A limit added to `Limits` enters the
    // key automatically rather than being forgotten here.
    canonicalPayloadForm(
      Object.fromEntries(Object.entries(spec.limits).map(([k, v]) => [k, v as number])),
    ),
  ]) as RunKey;

interface CaseRun {
  readonly ref: CaseRef;
  readonly node: EvalNodeId;
  readonly observed: Verdict | null;
  readonly matched: boolean;
  readonly status:
    | "matched"
    | "mismatched"
    | "unscored"
    | "contested"
    | "unattributed"
    | "could-not-evaluate";
  readonly scoreBasisPoints: number;
  readonly detail: string | null;
  readonly failed: boolean;
  readonly modelCalls: number;
  readonly costTenthCents: number;
  /** Carried forward from an earlier run of this key rather than observed today. */
  readonly memoised: boolean;
  /** The case ran out of clock. Never memoised: that is a fact about the budget. */
  readonly timedOut: boolean;
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
  // Attached **first**, before any path that can leave. The caller has already
  // invoked the work by the time this function is entered, so an early throw
  // that skipped this would abandon a live promise with no handler — an
  // unhandled rejection surfacing minutes later, in a process that has moved on,
  // pointing at a run that finished.
  void work.catch(() => undefined);
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
  }
};

/** The comparable form of a verdict. Integer-only and byte-stable, like a node. */
const verdictForm = (verdict: Verdict): string =>
  canonicalPayloadForm({
    disposition: verdict.disposition,
    conclusion: verdict.conclusion,
    confidenceBasisPoints: verdict.confidenceBasisPoints,
    because: verdict.because,
  });

const parseMemoisedVerdict = (runKey: RunKey, ref: string, json: string): Verdict | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new LedgerCorrupt(runKey, `memoised verdict for ${ref} is not JSON`);
  }
  if (parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const disposition = record["disposition"];
  if (
    (disposition !== "determine" && disposition !== "abstain") ||
    typeof record["conclusion"] !== "string" ||
    typeof record["confidenceBasisPoints"] !== "number" ||
    !Number.isSafeInteger(record["confidenceBasisPoints"])
  ) {
    throw new LedgerCorrupt(runKey, `memoised verdict for ${ref} is not a verdict`);
  }
  const because = record["because"];
  return {
    disposition,
    conclusion: record["conclusion"],
    confidenceBasisPoints: record["confidenceBasisPoints"],
    because: typeof because === "string" ? because : null,
  };
};

/**
 * The floor the `under-recording-detected` alert is measured against: **every**
 * decision attributed, or it is under-recording.
 *
 * Ten thousand basis points and not a configured value, deliberately. It is the
 * same number `DEFAULT_FLOORS.attributionFloorBasisPoints` uses and it is not
 * read from there, because the gate's floors are supplied per invocation by
 * whoever calls `gate` — a caller who lowers their own floor to get a build
 * through has changed what blocks their merge, and must not thereby also change
 * what an operator is told about a subject doing unrecorded work. The gate is a
 * policy; this is a measurement.
 */
const ATTRIBUTION_FLOOR_BASIS_POINTS = 10_000;

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
  const ledger = internals.ledger;
  const runKey = runKeyOf(spec);

  /**
   * The ledger's fail policy, held in one variable and stamped on the report.
   *
   * Non-null means the ledger failed at some point and this run proceeded
   * without it. That is **fail-open**, and it is the only fail-open policy in
   * the module — see `LedgerUnavailable`. It is recorded rather than swallowed,
   * because a fail-open policy nobody can see is indistinguishable from a bug.
   */
  let ledgerDown: string | null = null;

  // ---------------------------------------------------------------- idempotent
  // Before the run node, before the source node, before any spend at all.
  let completed;
  try {
    completed = await ledger.findCompleted(runKey);
  } catch (cause) {
    ledgerDown = describe(cause);
  }
  if (completed !== undefined) {
    if (completed.sourceKind !== spec.cases.kind) {
      // Fail-closed. A golden report memoised under a key this run computed for
      // a recorded cohort means the key derivation and the ledger disagree, and
      // returning it would hand back an artefact of the wrong kind.
      throw new LedgerCorrupt(
        runKey,
        `the memo is a ${completed.sourceKind} run and this source is ${spec.cases.kind}`,
      );
    }
    // The original artefact, unmodified: the original `runId`, `startedAt` and
    // `traceDigest`. Not a fresh run that happens to agree — nothing executed.
    return reopenMemoisedReport(completed) as unknown as ReportOf<K>;
  }

  // ------------------------------------------------------------------- resume
  let memos: readonly StoredCaseMemo[] = [];
  if (ledgerDown === null) {
    try {
      memos = await ledger.findCases(runKey);
    } catch (cause) {
      ledgerDown = describe(cause);
    }
  }
  const memoByRef = new Map(memos.map((m) => [m.ref, m]));

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
        determinismSampleCases: spec.limits.determinismSampleCases,
        priceTableVersion: spec.priceTable.version,
        declaredCases: spec.cases.size,
        memoisedCases: memoByRef.size,
        ledgerAvailable: ledgerDown === null,
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
  //
  // A subset's selection lands here too, and for the same reason: it is decided
  // before a run exists. `notSelected` is enumerated rather than counted,
  // because `gate` has to tell "the author deleted this golden case" from "the
  // pre-merge subset did not run it" and a count cannot answer that.
  const provenance = spec.cases.provenance as RecordedProvenance | null;
  const selection = spec.cases.selection;
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
      subsetLabel: selection?.label ?? null,
      subsetOfDigest: selection?.fromDigest ?? null,
      subsetOfSize: selection?.fromSize ?? null,
      subsetSeed: selection?.seed ?? null,
      subsetMaxCases: selection?.maxCases ?? null,
      subsetPinnedHighTier: selection?.pinnedHighTier.join(",") ?? null,
      subsetPinnedQuarantined: selection?.pinnedQuarantined.join(",") ?? null,
      subsetSampled: selection?.sampled.join(",") ?? null,
      subsetNotSelected: selection?.notSelected.join(",") ?? null,
      subsetOverBudget: selection?.overBudget ?? null,
    },
    signal: runController.signal,
  });
  await sourceNode.settle({ outcome: "ok", closing: {} });

  if (memoByRef.size > 0) {
    // "These results were not observed today" is a recorded fact rather than
    // something a reader has to infer from a suspiciously low cost figure.
    const resumeNode = await scope.runNode.open({
      kind: "resume",
      name: "resume",
      v: 1,
      payload: {
        runKey,
        memoisedCases: memoByRef.size,
        declaredCases: spec.cases.size,
        fromRuns: [...new Set(memos.map((m) => m.fromRunId))].sort().join(","),
      },
      signal: runController.signal,
    });
    await resumeNode.settle({ outcome: "ok", closing: {} });
  }

  const queue = [...spec.cases.cases];
  let next = 0;

  const recordMemo = async (result: CaseRun, evalCase: EvalCase<K>): Promise<void> => {
    if (ledgerDown !== null) return;
    // Never memoised: a case carried forward (already recorded), one the clock
    // ended, and one the provider refused. The first would duplicate; the second
    // and third are facts about the budget and about a Tuesday, not about the
    // case, and freezing either would make a flake permanent for this run key.
    if (result.memoised || result.timedOut || result.status === "could-not-evaluate") return;
    try {
      await ledger.recordCase({
        runKey,
        ref: result.ref,
        caseDigest: evalCase.digest,
        fromRunId: runId,
        fromNode: result.node,
        recordedAt: internals.clock.now(),
        status: result.status as MemoisedStatus,
        scoreBasisPoints: result.scoreBasisPoints,
        observedJson: JSON.stringify(result.observed),
        detail: result.detail,
        modelCalls: result.modelCalls,
        costTenthCents: result.costTenthCents,
      });
    } catch (cause) {
      ledgerDown = describe(cause);
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (partialReason !== null || attemptedWrite !== undefined) return;
      const index = next;
      next += 1;
      const evalCase = queue[index];
      if (evalCase === undefined) return;

      try {
        const memo = memoByRef.get(evalCase.ref);
        const result =
          memo === undefined
            ? await runCase(scope, spec, evalCase, runController.signal, timers)
            : await carryForward(scope, runKey, memo, evalCase, runController.signal);
        results.set(result.ref, result);
        if (result.failed) failures += 1;
        await recordMemo(result, evalCase);
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
  // `allSettled`, not `all`: one worker failing must not leave the other seven
  // rejecting into nothing. The first failure is rethrown once every worker has
  // stopped, so the run aborts with one named error and no stray rejections.
  const settled = await Promise.allSettled(pool);
  const firstFailure = settled.find((r) => r.status === "rejected");
  if (firstFailure !== undefined && firstFailure.status === "rejected") {
    cancelRunTimer();
    throw firstFailure.reason as Error;
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

  // The determinism CHECK, not the determinism claim. It runs inside the run's
  // budget and against the same wall clock, so it cannot outlive it — and the
  // `finally` is what stops an incident raised inside it leaving that wall clock
  // armed against a run that has already stopped.
  let determinismCheck: DeterminismCheck;
  try {
    determinismCheck =
      attemptedWrite === undefined
        ? await checkDeterminism(scope, spec, ordered, partialReason, runController.signal, timers)
        : { kind: "not-checked", why: "the run was aborted by an attempted effect" };
  } finally {
    cancelRunTimer();
  }

  const couldNotEvaluate = ordered.filter((r) => r.status === "could-not-evaluate");
  // A provider outage does not move the attribution figure. It is excluded from
  // the denominator entirely: those cases produced no decision subtree to
  // attribute, and counting them either way would make a 429 storm read as a
  // statement about where the subject does its thinking.
  const attributable = ordered.filter((r) => r.status !== "could-not-evaluate");
  const attributedCases = attributable.filter((r) => r.status !== "unattributed").length;
  const unattributedCases = ordered.filter((r) => r.status === "unattributed").map((r) => r.ref);
  // Three values, and the third is the correction. A `"pure"` subject with no
  // recorded model calls is `declared-pure`, not `complete`, and its coverage is
  // 0 rather than 10000: nothing was attributed by evidence. A genuine rules
  // engine and a subject that did its thinking through a provider SDK look
  // identical from here, so the report says which claim it is resting on rather
  // than presenting an assertion as a measurement.
  const attribution: Attribution =
    unattributedCases.length > 0
      ? "partial"
      : spec.subject.purity === "pure"
        ? "declared-pure"
        : "complete";
  const coverageBasisPoints =
    attribution === "declared-pure" ? 0 : basisPoints(attributedCases, attributable.length);

  /**
   * The sixth silent condition: **decisions with no recorded model call.**
   *
   * `docs/CONTEXT.md`: *"The build stays green unless something counts what is
   * missing."* This module does count it — `UnattributedDecision` blocks the
   * gate — and that is the right consequence for a change a developer is
   * watching land. It is the wrong consequence for a nightly run, where a red
   * build is a line in a report nobody opens until Monday while the subject has
   * been doing its thinking somewhere unrecorded since Thursday.
   *
   * Raised **once per run, not once per case**, and the reason is a property of
   * the failure rather than a concern about volume: a subject that routes its
   * model calls around `ctx.client` does it on every case, so 200 alerts would
   * be 200 pages about one defect. `alerts` would collapse them by fingerprint
   * anyway; sending one is the honest shape of the finding.
   *
   * ## What the correlation identifier is here, said plainly
   *
   * It is the **run** identifier, not a case identifier, and it is the only
   * honest choice available. `docs/CONTEXT.md` binds a correlation identifier to
   * a case — a claim, an invoice — and an eval run has none: it is a measurement
   * of a subject against golden cases, and its evidence lives in the eval node
   * store rather than in the seven-year archive (see `OPEN-ITEMS-RESOLVED.md`
   * item 4, which put the two stores deliberately apart). What the field is
   * *for* is leading a reader from the alert to the evidence, and the run
   * identifier is what does that. Anything else here would be a fabrication.
   */
  if (unattributedCases.length > 0) {
    const underRecording = await scope.runNode.open({
      kind: "under-recording",
      name: "under-recording",
      v: 1,
      payload: {
        decisionsExamined: attributable.length,
        decisionsWithoutModelCall: unattributedCases.length,
        coverageFloorBasisPoints: ATTRIBUTION_FLOOR_BASIS_POINTS,
        observedCoverageBasisPoints: coverageBasisPoints,
        declaredPurity: spec.subject.purity,
        ...(await raiseAndRecord(internals.alerting, {
          kind: "under-recording-detected",
          correlationId: runId as unknown as AlertCorrelationId,
          decisionsExamined: attributable.length,
          decisionsWithoutModelCall: unattributedCases.length,
          coverageFloorBasisPoints: ATTRIBUTION_FLOOR_BASIS_POINTS,
          observedCoverageBasisPoints: coverageBasisPoints,
        })),
      },
      signal: runController.signal,
    });
    await underRecording.settle({ outcome: "unattributed", closing: {} });
  }

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
      couldNotEvaluate: couldNotEvaluate.length,
      memoised: ordered.filter((r) => r.memoised).length,
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
  if (determinismCheck.kind === "checked" && determinismCheck.unstable.length > 0) {
    nonDeterminismReasons.push(
      `the subject answered differently on re-execution under the same seed: ${determinismCheck.unstable.join(", ")}`,
    );
  }
  // Declared *and* checked. The declaration comes from the scorer adapters; the
  // check comes from re-executing the subject. Neither substitutes for the other
  // and the report carries both.
  const determinism: Determinism = {
    declared: nonDeterminismReasons.length === 0 ? "deterministic" : "non-deterministic",
    reasons: nonDeterminismReasons,
    check: determinismCheck,
  };

  const resumed = ordered.filter((r) => r.memoised).map((r) => r.ref);
  const memoisationOf = (down: string | null): Memoisation =>
    down !== null
      ? {
          kind: "ledger-unavailable",
          detail:
            resumed.length === 0
              ? down
              : `${down} (after ${String(resumed.length)} case(s) had already been carried forward)`,
        }
      : resumed.length > 0
        ? {
            kind: "resumed",
            cases: resumed,
            fromRuns: [...new Set(memos.map((m) => m.fromRunId as string))].sort(),
          }
        : { kind: "fresh" };

  const factsWith = (memoisation: Memoisation): RunFacts => ({
    runId,
    runNode: scope.runNode.id,
    label: spec.label,
    runKey,
    subjectVersion: spec.subject.version,
    subjectPurity: spec.subject.purity,
    seed: spec.seed,
    scorers: spec.scorers.map((s) => s.descriptor),
    determinism,
    memoisation,
    attribution,
    attributionCoverageBasisPoints: coverageBasisPoints,
    unattributedCases,
    partial: partialReason !== null,
    partialReason,
    casesRun: ordered.length,
    casesDeclared: spec.cases.size,
    // What **this** run spent. A resumed run's figure is lower than a fresh
    // one's by exactly what it did not have to pay again, which is the point;
    // the per-case figures carry what each case cost when it was observed.
    costTenthCents: scope.runNode.costTenthCents(),
    costComplete,
    tokensIn: sumTokens(stored.nodes, "tokensIn"),
    tokensOut: sumTokens(stored.nodes, "tokensOut"),
    priceTableVersion: spec.priceTable.version,
    startedAt,
    finishedAt,
    traceDigest: trace.digest,
    nodes: trace.nodes,
    redaction: internals.redact.id,
    capturedVia: "injected-client-only",
  });

  // The denominator is every case that ran, so `unscored`, `contested`,
  // `unattributed` and `could-not-evaluate` cannot flatter the number by leaving
  // it.
  const denominator = ordered.length;
  const rate = (predicate: (r: CaseRun) => boolean): number =>
    basisPoints(ordered.filter(predicate).length, denominator);

  const mint = (memoisation: Memoisation): ReportOf<K> => {
    const facts = factsWith(memoisation);
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
          modelCalls: r.modelCalls,
          costTenthCents: r.costTenthCents,
        };
      });
      return mintAccuracyReport(
        facts,
        source.digest,
        source.selection,
        {
          correctBasisPoints: rate((r) => r.status === "matched"),
          incorrectBasisPoints: rate((r) => r.status === "mismatched"),
          unscoredBasisPoints: rate((r) => r.status === "unscored" || r.status === "unattributed"),
          contestedBasisPoints: rate((r) => r.status === "contested"),
          couldNotEvaluateBasisPoints: rate((r) => r.status === "could-not-evaluate"),
        },
        cases,
        internals.redact,
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
        modelCalls: r.modelCalls,
        costTenthCents: r.costTenthCents,
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
      source.selection,
      source.provenance,
      {
        agreementBasisPoints: rate((r) => r.status === "matched"),
        disagreedBasisPoints: rate((r) => r.status === "mismatched"),
        unscoredBasisPoints: rate((r) => r.status === "unscored" || r.status === "unattributed"),
        contestedBasisPoints: rate((r) => r.status === "contested"),
        couldNotEvaluateBasisPoints: rate((r) => r.status === "could-not-evaluate"),
      },
      disagreements,
      cases,
      internals.redact,
    ) as ReportOf<K>;
  };

  let report = mint(memoisationOf(ledgerDown));

  // Memoised only if the ledger will have it and the mint will allow it.
  // `mintCompletedRun` is the single authority on what "complete" means — it
  // refuses a partial run, an unattributed one and one that could not evaluate
  // cases — so this call site does not restate the rules and cannot drift from
  // them.
  if (ledgerDown === null) {
    try {
      await ledger.recordCompleted(
        mintCompletedRun({ report, runKey, completedAt: internals.clock.now() }),
      );
    } catch (cause) {
      if (!(cause instanceof RunNotMemoisable)) {
        // The write failed. Nothing was recorded, so the next run of this key
        // re-executes — a bill, not a false number. Re-minted so the artefact
        // says so rather than claiming a clean fresh run.
        ledgerDown = describe(cause);
        report = mint(memoisationOf(ledgerDown));
      }
    }
  }
  return report;
};

/* ------------------------------------------------------- a memoised case */

/**
 * Carry a case forward from an earlier run of the same key.
 *
 * It writes a real `case` node stamped with the run and node the result came
 * from, so the trace says "this was not observed today" rather than implying it
 * was. That is the difference between resuming and quietly reporting stale
 * numbers as fresh ones.
 *
 * The digest check is fail-closed and is not expected to fire: the run key
 * content-addresses the source, so a case whose content changed changes the key
 * and cannot reach its old memo. Reaching `MemoisedCaseMismatch` means the
 * ledger and the source disagree under one key — a hand-rolled `CaseSource`, a
 * ledger shared across two suites, or a row edited by hand.
 */
const carryForward = async <K extends SourceKind>(
  scope: RunScope,
  runKey: RunKey,
  memo: StoredCaseMemo,
  evalCase: EvalCase<K>,
  runSignal: AbortSignal,
): Promise<CaseRun> => {
  if (memo.caseDigest !== evalCase.digest) {
    throw new MemoisedCaseMismatch(evalCase.ref, evalCase.digest, memo.caseDigest);
  }
  const observed = parseMemoisedVerdict(runKey, evalCase.ref, memo.observedJson);
  const caseNode = await scope.runNode.open({
    kind: "case",
    name: evalCase.ref,
    v: 1,
    caseRef: evalCase.ref,
    payload: {
      ref: evalCase.ref,
      digest: evalCase.digest,
      tier: evalCase.tier,
      expectationKind: evalCase.expectation.kind,
      memoised: true,
      memoisedFromRun: memo.fromRunId,
      memoisedFromNode: memo.fromNode,
      memoisedAt: memo.recordedAt,
      status: memo.status,
      scoreBasisPoints: memo.scoreBasisPoints,
      modelCalls: memo.modelCalls,
      costTenthCents: memo.costTenthCents,
    },
    signal: runSignal,
  });
  await caseNode.settle({
    outcome:
      memo.status === "unattributed"
        ? "unattributed"
        : memo.status === "unscored" || memo.status === "contested"
          ? "indeterminate"
          : "ok",
    closing: {},
  });
  return {
    ref: evalCase.ref,
    node: caseNode.id,
    observed,
    matched: memo.status === "matched",
    status: memo.status,
    scoreBasisPoints: memo.scoreBasisPoints,
    detail: memo.detail,
    // A memoised failure is not a *new* failure and must not consume this run's
    // failure budget a second time; it was already counted by the run that
    // observed it.
    failed: false,
    modelCalls: memo.modelCalls,
    // What the case cost when it was observed, not what it cost today (nothing).
    // The run-level figure is this run's spend; these are the case's.
    costTenthCents: memo.costTenthCents,
    memoised: true,
    timedOut: false,
  };
};

/* --------------------------------------------------------- determinism check */

/**
 * Re-execute a seeded sample of this run's cases under the identical seed and
 * compare the verdicts byte for byte.
 *
 * Interface fact 5 said a run is deterministic given (suite, subject, scorer,
 * seed) *or the report declares that it is not*, and the report's declaration
 * came entirely from what the scorer adapters said about themselves. The half
 * that actually varies is the **subject**, and no scorer descriptor knows
 * anything about it: a temperature setting, an unseeded shuffle, iteration over
 * host-ordered keys, a cache warm on the second call.
 *
 * What it does not check is written onto the artefact rather than left here:
 * `compared: "subject-verdict"`. The scorers are not re-run — a judge panel is
 * non-deterministic by construction, says so, and re-running it would measure
 * the judge's variance at n times the cost. Memoised cases are not candidates
 * either; they were not executed today and there is nothing to compare.
 */
const checkDeterminism = async <K extends SourceKind>(
  scope: RunScope,
  spec: RunSpec<K>,
  ordered: readonly CaseRun[],
  partialReason: string | null,
  runSignal: AbortSignal,
  timers: Timers,
): Promise<DeterminismCheck> => {
  if (spec.limits.determinismSampleCases === 0) {
    return { kind: "not-checked", why: "limits.determinismSampleCases is 0" };
  }
  if (partialReason !== null) {
    return {
      kind: "not-checked",
      why: "the run stopped early; re-executing under a spent budget measures the budget",
    };
  }
  const byRef = new Map(spec.cases.cases.map((c) => [c.ref as string, c]));
  const candidates = ordered.filter(
    (r) => !r.memoised && r.observed !== null && r.status !== "could-not-evaluate",
  );
  if (candidates.length === 0) {
    return {
      kind: "not-checked",
      why: "no case executed in this run produced a verdict to compare against",
    };
  }
  const chosen = [...candidates]
    .sort((a, b) => {
      const ra = seededRank(`${spec.seed}:determinism`, a.ref);
      const rb = seededRank(`${spec.seed}:determinism`, b.ref);
      return ra !== rb ? ra - rb : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
    })
    .slice(0, Math.min(spec.limits.determinismSampleCases, candidates.length));

  const node = await scope.runNode.open({
    kind: "determinism",
    name: "determinism",
    v: 1,
    payload: {
      compared: "subject-verdict",
      sampleSize: chosen.length,
      candidates: candidates.length,
      sampled: chosen.map((c) => c.ref).join(","),
      seed: spec.seed,
    },
    signal: runSignal,
  });

  const unstable: CaseRef[] = [];
  for (const candidate of chosen) {
    const evalCase = byRef.get(candidate.ref);
    if (evalCase === undefined) continue;
    const controller = new AbortController();
    const onRunAbort = (): void => controller.abort();
    runSignal.addEventListener("abort", onRunAbort, { once: true });
    const cancel = timers.deadline(spec.limits.perCaseMillis, () => controller.abort());
    const caseSeed = `${spec.seed}:${evalCase.ref}` as Seed;
    // A span, not a `case` node: this is not a case of the run and must never be
    // counted as one. `casesRun` stays what it was.
    const child = await node.open({
      kind: "span",
      name: `recheck:${evalCase.ref}`,
      v: 1,
      caseRef: evalCase.ref,
      payload: { ref: evalCase.ref, tier: evalCase.tier, seed: caseSeed },
      signal: controller.signal,
    });
    let again: Verdict | null = null;
    let why: string | null = null;
    try {
      again = await raceAbort(
        spec.subject.decide({
          node: child.context.node,
          client: child.context.client,
          input: evalCase.input,
          tier: evalCase.tier,
          seed: caseSeed,
          now: child.context.now,
          signal: controller.signal,
        }),
        controller.signal,
        `determinism recheck budget spent (perCaseMillis=${spec.limits.perCaseMillis})`,
      );
    } catch (cause) {
      // An incident is an incident here too: a store that cannot write, or a
      // subject reaching for an effect, aborts the run rather than being
      // recorded as instability.
      if (cause instanceof EvalsError && cause.incident) {
        await child.settle({ outcome: "error", closing: { incident: cause.name } });
        await node.settle({ outcome: "error", closing: { incident: cause.name } });
        cancel();
        runSignal.removeEventListener("abort", onRunAbort);
        throw cause;
      }
      // A subject that answered once and threw the second time is not
      // deterministic. That is the finding, not an error.
      why = describe(cause);
    } finally {
      cancel();
      runSignal.removeEventListener("abort", onRunAbort);
    }

    const first = candidate.observed === null ? null : verdictForm(candidate.observed);
    const second = again === null ? null : verdictForm(again);
    const stable = first !== null && second !== null && first === second;
    if (!stable) unstable.push(candidate.ref);
    // **Digests, not the forms themselves.** The canonical form embeds the
    // verdict's conclusion, and a payload key called `first` is not something a
    // deny-list redactor keyed on `conclusion` would ever strip. A digest
    // compares exactly as well and carries no personal data into the trace.
    await child.settle({
      outcome: stable ? "ok" : "indeterminate",
      closing: {
        stable,
        firstDigest: first === null ? null : digestOf([first]),
        secondDigest: second === null ? null : digestOf([second]),
        why,
      },
    });
  }

  await node.settle({
    outcome: unstable.length === 0 ? "ok" : "indeterminate",
    closing: {
      stable: chosen.length - unstable.length,
      unstable: unstable.join(","),
    },
  });

  return {
    kind: "checked",
    compared: "subject-verdict",
    sampled: chosen.map((c) => c.ref),
    stable: chosen.length - unstable.length,
    unstable,
  };
};

/* ------------------------------------------------------------------ one case */

const runCase = async <K extends SourceKind>(
  scope: RunScope,
  spec: RunSpec<K>,
  evalCase: EvalCase<K>,
  runSignal: AbortSignal,
  timers: Timers,
): Promise<CaseRun> => {
  const caseNode = await scope.runNode.open({
    kind: "case",
    name: evalCase.ref,
    v: 1,
    // Set here and inherited by every node beneath, so an incident raised in a
    // scorer's judge sample names the case, not the node it happened at.
    caseRef: evalCase.ref,
    payload: {
      ref: evalCase.ref,
      digest: evalCase.digest,
      tier: evalCase.tier,
      expectationKind: evalCase.expectation.kind,
      memoised: false,
    },
    signal: runSignal,
  });

  const controller = new AbortController();
  const onRunAbort = (): void => controller.abort();
  runSignal.addEventListener("abort", onRunAbort, { once: true });
  const cancelCaseTimer = timers.deadline(spec.limits.perCaseMillis, () => controller.abort());

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
    /**
     * Set when the provider — not the subject, not a scorer — is why this case
     * has no measurement. It makes the case `could-not-evaluate` rather than
     * `unscored`, which is what stops a 429 storm arriving on the same red line
     * a genuine regression uses.
     */
    let providerDown: ProviderUnavailable | undefined;

    try {
      // Raced against the case budget. A subject that ignores `ctx.signal` — and
      // application code routinely does — used to hang the case, the worker and
      // the whole run for ever, with both wall clocks set and neither able to
      // stop anything.
      observed = await raceAbort(
        spec.subject.decide({
          node: decisionNode.context.node,
          client: decisionNode.context.client,
          input: evalCase.input,
          tier: evalCase.tier,
          seed: caseSeed,
          now: decisionNode.context.now,
          signal: controller.signal,
        }),
        controller.signal,
        `case budget spent (perCaseMillis=${spec.limits.perCaseMillis})`,
      );
    } catch (cause) {
      if (cause instanceof SubjectAttemptedWrite) {
        await decisionNode.settle({ outcome: "error", closing: { attemptedWrite: true } });
        await caseNode.settle({ outcome: "error", closing: { attemptedWrite: true } });
        throw cause;
      }
      // An incident is never a case-level failure. `EvalStoreUnavailable` is
      // fail-closed at every tier with no configuration key: the run aborts and
      // no report is produced, because an unrecorded eval run is a number nobody
      // can check.
      if (cause instanceof EvalsError && cause.incident) throw cause;
      if (cause instanceof ProviderUnavailable) providerDown = cause;
      failed = true;
      detail = controller.signal.aborted ? "case budget spent" : describe(cause);
      // Fail-closed per case, fail-open per run. One crashing case must not
      // destroy the evidence from the other 199, and must not be quietly
      // excluded either: a subject that throws *is* a regression.
      await decisionNode.settle({
        outcome:
          providerDown !== undefined
            ? "indeterminate"
            : controller.signal.aborted
              ? "timeout"
              : "error",
        closing: { detail, providerUnavailable: providerDown !== undefined },
      });
    }

    const modelCalls = decisionNode.modelCalls();
    // The declaration is checked in **both** directions. It used to be checked
    // in one: `"calls-models"` with no recorded call was caught, and `"pure"`
    // with recorded calls was not — so the one thing the purity declaration can
    // actually be falsified against went unchecked. A subject that says it calls
    // no model and then calls one has misdeclared itself, and a misdeclared
    // subject's other claim ("the thinking you cannot see does not exist") is
    // worth nothing.
    const misdeclared =
      !failed &&
      ((spec.subject.purity === "calls-models" && modelCalls === 0) ||
        (spec.subject.purity === "pure" && modelCalls > 0));
    const unattributed = misdeclared;

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
      const timedOut = controller.signal.aborted && providerDown === undefined;
      const status = providerDown === undefined ? "unscored" : "could-not-evaluate";
      await caseNode.settle({
        outcome: providerDown === undefined ? "error" : "indeterminate",
        closing: { status, detail },
      });
      return {
        ref: evalCase.ref,
        node: caseNode.id,
        observed: null,
        matched: false,
        status,
        scoreBasisPoints: 0,
        detail,
        // Counted against `maxCaseFailures` either way, so a 429 storm stops the
        // run rather than hammering the provider for the remaining 199 cases.
        // The run then ends `partial`, which also cannot pass a gate.
        failed: true,
        modelCalls,
        costTenthCents: caseNode.costTenthCents(),
        memoised: false,
        timedOut,
      };
    }

    if (unattributed) {
      // An `UnattributedDecision`: the subject contradicted its own purity
      // declaration in one direction or the other. Unscored, counted against the
      // coverage floor, and it fails the build — silent under-recording becomes
      // a red build rather than a quiet green one.
      await caseNode.settle({
        outcome: "unattributed",
        closing: { status: "unattributed", modelCalls, purity: spec.subject.purity },
      });
      return {
        ref: evalCase.ref,
        node: caseNode.id,
        observed,
        matched: false,
        status: "unattributed",
        scoreBasisPoints: 0,
        detail:
          spec.subject.purity === "pure"
            ? `the subject declared purity "pure" and recorded ${String(modelCalls)} model call(s)`
            : "decision subtree recorded no model call and the subject is not declared pure",
        failed: false,
        modelCalls,
        costTenthCents: caseNode.costTenthCents(),
        memoised: false,
        timedOut: false,
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
        // Raced, like the subject. A scorer is application code too, and a judge
        // panel that never returns bounded nothing.
        outcome = await raceAbort(
          scorer.score({
            node: scoringNode.context.node,
            judge: scoringNode.context.client,
            observed,
            expected: evalCase.expectation.verdict,
            seed: caseSeed,
            signal: controller.signal,
          }),
          controller.signal,
          `case budget spent (perCaseMillis=${spec.limits.perCaseMillis})`,
        );
      } catch (cause) {
        // The scoring path's blanket catch was the second place an incident got
        // downgraded to an outcome: `EvalStoreUnavailable` became `unscored` and
        // the run completed, and a rogue scorer's `SubjectAttemptedWrite` — an
        // effect possibly already committed through a channel this module does
        // not own — became a detail string. Both abort the run.
        if (cause instanceof EvalsError && cause.incident) {
          await scoringNode.settle({
            outcome: "error",
            closing: { kind: "incident", reason: cause.name },
          });
          throw cause;
        }
        // A judge the provider would not serve is the same condition as a
        // subject the provider would not serve, and gets the same status. It is
        // recorded here so a rate-limited judge panel does not read as a scoring
        // regression.
        if (cause instanceof ProviderUnavailable) providerDown = cause;
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
    // A scorer that could not be served by the provider makes the case
    // could-not-evaluate rather than unscored, exactly as it would if the
    // subject had been the one refused.
    const status =
      providerDown !== undefined && combined.status === "unscored"
        ? ("could-not-evaluate" as const)
        : combined.status;
    await caseNode.settle({
      outcome: status === "matched" || status === "mismatched" ? "ok" : "indeterminate",
      closing: {
        status,
        scoreBasisPoints: combined.scoreBasisPoints,
        modelCalls,
      },
    });
    return {
      ref: evalCase.ref,
      node: caseNode.id,
      observed,
      matched: status === "matched",
      status,
      scoreBasisPoints: combined.scoreBasisPoints,
      detail: combined.detail,
      failed: status === "could-not-evaluate",
      modelCalls,
      costTenthCents: caseNode.costTenthCents(),
      memoised: false,
      timedOut: false,
    };
  } finally {
    cancelCaseTimer();
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
          : status === "could-not-evaluate"
            ? "could-not-evaluate"
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
          : status === "could-not-evaluate"
            ? "could-not-evaluate"
            : "unscored";

const sumTokens = (
  nodes: readonly { readonly kind: string; readonly tokensIn: number; readonly tokensOut: number }[],
  field: "tokensIn" | "tokensOut",
): number => nodes.filter((n) => n.kind === "model.call").reduce((total, n) => total + n[field], 0);

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
