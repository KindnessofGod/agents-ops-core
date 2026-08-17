import { BaselineRefused } from "./errors.js";
import type { ModelBackend } from "./clients.js";
import type { EvalRecorder } from "./recorder.js";
import { recorderInternals } from "./recorder.js";
import type { AccuracyCaseStatus, AccuracyReport } from "./report.js";
import type { CaseDigest, CaseRef, EvalNodeId, RunId, SourceDigest, SubjectVersion } from "./types.js";

/**
 * The continuous-integration regression gate.
 *
 * **It accepts only an `AccuracyReport`.** An `AgreementReport` is not
 * assignable here in either direction, so there is no way to turn "94.12%
 * agreement with our reviewers" into a passing build — not by accident and not
 * on purpose. The baseline of a shadow run is human behaviour including human
 * error; every disagreement in it is a case for adjudication, and adjudication
 * is not something a gate can do.
 *
 * `GateOutcome` has exactly two kinds: `passed` and `blocked`. **There is no
 * `warned`.** A gate with a warning level is a gate that is off.
 */

export interface BaselineCase {
  readonly ref: CaseRef;
  readonly digest: CaseDigest;
  readonly status: AccuracyCaseStatus;
  readonly scoreBasisPoints: number;
}

/**
 * The standard everything else is measured against.
 *
 * It carries `acceptedBy` and `acceptedAt` because the question an auditor asks
 * is not "what is the baseline" but "who decided that these numbers are the
 * standard, and when". A default cannot answer that; a committed file with a
 * name on it can.
 */
export interface Baseline {
  readonly schema: "baseline/1";
  readonly acceptedBy: string;
  readonly acceptedAt: number;
  readonly fromRun: RunId;
  readonly suiteDigest: SourceDigest;
  readonly subjectVersion: SubjectVersion;
  readonly cases: readonly BaselineCase[];
}

/**
 * Turn a report into a baseline. Pure — it executes nothing, records nothing and
 * reads nothing, which is why it is not counted as an entry point.
 *
 * It refuses a partial report and an unattributed one, because accepting either
 * as the standard bakes the failure in: everything measured afterwards would be
 * measured against a run that did not finish, or against a run whose thinking
 * happened somewhere nobody can see.
 */
export const accept = (input: {
  readonly report: AccuracyReport;
  readonly by: string;
  readonly at: number;
}): Baseline => {
  if (input.report.partial) {
    throw new BaselineRefused(`the run was partial (${input.report.partialReason ?? "unknown"})`);
  }
  if (input.report.attribution === "partial") {
    throw new BaselineRefused(
      `${input.report.unattributedCases.length} decision(s) were unattributed`,
    );
  }
  return {
    schema: "baseline/1",
    acceptedBy: input.by,
    acceptedAt: input.at,
    fromRun: input.report.runId,
    suiteDigest: input.report.suiteDigest,
    subjectVersion: input.report.subjectVersion,
    cases: input.report.cases.map((c) => ({
      ref: c.ref,
      digest: c.digest,
      status: c.status,
      scoreBasisPoints: c.scoreBasisPoints,
    })),
  };
};

/**
 * The two numeric bounds and the coverage floor. Nothing else about the gate is
 * configurable: there is no `continueOnError`, because that is precisely the
 * flag that turns a gate into decoration.
 */
export interface GateFloors {
  /**
   * How much of the run must have attributed decisions. `10000` — every one —
   * is the only value that makes `UnattributedDecision` a hard failure, and it
   * is what `DEFAULT_FLOORS` uses.
   */
  readonly attributionFloorBasisPoints: number;
  readonly maxUnscoredBasisPoints: number;
  readonly maxContestedBasisPoints: number;
}

export const DEFAULT_FLOORS: GateFloors = {
  attributionFloorBasisPoints: 10_000,
  maxUnscoredBasisPoints: 0,
  maxContestedBasisPoints: 500,
};

export type GateBlockReason =
  /** First run. Explicit, non-passing, and it says what to do next. */
  | "baseline-missing"
  /** The run stopped early. A biased sample must not be read as complete. */
  | "partial-run"
  /** A decision subtree recorded no model call from a subject that calls models. */
  | "unattributed-decisions"
  /** The cheapest way to make a gate green is to delete the failing evidence. */
  | "dropped-cases"
  | "regression"
  | "unscored-rate"
  | "contested-rate";

export interface GateCounts {
  readonly regressed: readonly CaseRef[];
  readonly improved: readonly CaseRef[];
  readonly unchanged: number;
  /** Reported, never gated. New golden cases are not regressions. */
  readonly newCases: readonly CaseRef[];
  readonly dropped: readonly CaseRef[];
}

export type GateOutcome =
  | {
      readonly kind: "passed";
      readonly runId: RunId;
      /** The run this gate decision was recorded under. Replayable on its own. */
      readonly gateRun: RunId;
      readonly node: EvalNodeId;
      readonly counts: GateCounts;
    }
  | {
      readonly kind: "blocked";
      readonly reason: GateBlockReason;
      readonly detail: string;
      readonly runId: RunId;
      /** The run this gate decision was recorded under. Replayable on its own. */
      readonly gateRun: RunId;
      readonly node: EvalNodeId;
      readonly counts: GateCounts;
      /** What to do about it, on the failure line rather than in a wiki. */
      readonly remedy: string;
    };

export interface GateInput {
  /** Only an accuracy report. An agreement report does not typecheck here. */
  readonly report: AccuracyReport;
  /**
   * `undefined` is a value you have to supply, not a parameter you can omit.
   * The first continuous-integration run of any of the nineteen applications is
   * exactly the run where a silent pass is most tempting and most damaging.
   */
  readonly baseline: Baseline | undefined;
  readonly floors: GateFloors;
  /**
   * The gate decision is itself a recorded node. "The build was gated and this
   * is what it decided" is evidence, not an assertion, and it is written to the
   * eval store like everything else this module does.
   */
  readonly recorder: EvalRecorder;
}

/** The gate makes no model calls. There is nothing here that can dial out. */
const noModels: ModelBackend = {
  id: "none",
  complete: () => {
    throw new Error("the gate makes no model calls");
  },
};

export const gate = async (input: GateInput): Promise<GateOutcome> => {
  const { report } = input;
  const internals = recorderInternals(input.recorder);
  // A distinct run per gate decision. Gating the same report twice — a
  // re-triggered continuous-integration job — records two decisions rather than
  // colliding, and each is replayable on its own.
  const gateRun = `gate-${report.runId}-${Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")}` as RunId;
  const scope = await internals.beginRun({
    header: {
      runId: gateRun,
      label: `gate:${report.label}`,
      sourceKind: "golden",
      sourceDigest: report.suiteDigest,
      subjectVersion: report.subjectVersion,
      seed: report.seed,
    },
    models: noModels,
    priceTable: { version: report.priceTableVersion, perModel: {} },
    retries: 0,
    signal: new AbortController().signal,
    runPayload: {
      gatedRun: report.runId,
      suiteDigest: report.suiteDigest,
      subjectVersion: report.subjectVersion,
      traceDigest: report.traceDigest,
    },
  });

  const counts = compare(report, input.baseline);
  const decision = decide(report, input.baseline, input.floors, counts);

  const gateNode = await scope.runNode.open({
    kind: "gate",
    name: "gate",
    v: 1,
    payload: {
      gatedRun: report.runId,
      outcome: decision.kind,
      reason: decision.kind === "blocked" ? decision.reason : null,
      detail: decision.kind === "blocked" ? decision.detail : null,
      regressed: counts.regressed.length,
      improved: counts.improved.length,
      unchanged: counts.unchanged,
      newCases: counts.newCases.length,
      dropped: counts.dropped.length,
      correctBasisPoints: report.correctBasisPoints,
      unscoredBasisPoints: report.unscoredBasisPoints,
      contestedBasisPoints: report.contestedBasisPoints,
      attributionCoverageBasisPoints: report.attributionCoverageBasisPoints,
      baselinePresent: input.baseline !== undefined,
    },
    signal: scope.runNode.context.signal,
  });
  await gateNode.settle({ outcome: decision.kind === "passed" ? "ok" : "indeterminate", closing: {} });
  await scope.finish({ outcome: "ok", closing: {} });

  return decision.kind === "passed"
    ? { kind: "passed", runId: report.runId, gateRun, node: gateNode.id, counts }
    : {
        kind: "blocked",
        reason: decision.reason,
        detail: decision.detail,
        remedy: decision.remedy,
        runId: report.runId,
        gateRun,
        node: gateNode.id,
        counts,
      };
};

const passing = (status: AccuracyCaseStatus): boolean => status === "correct";

/**
 * Baseline matching is on the **intersection of case references**, not on the
 * suite hash. Adding a golden case therefore does not invalidate the baseline
 * and does not read as a suite-wide regression; the new case is reported as new.
 * Removing one is a different matter — see `dropped-cases`.
 */
const compare = (report: AccuracyReport, baseline: Baseline | undefined): GateCounts => {
  if (baseline === undefined) {
    return {
      regressed: [],
      improved: [],
      unchanged: 0,
      newCases: report.cases.map((c) => c.ref),
      dropped: [],
    };
  }
  const before = new Map(baseline.cases.map((c) => [c.ref, c]));
  const now = new Map(report.cases.map((c) => [c.ref, c]));
  const regressed: CaseRef[] = [];
  const improved: CaseRef[] = [];
  const newCases: CaseRef[] = [];
  const dropped: CaseRef[] = [];
  let unchanged = 0;
  for (const current of report.cases) {
    const previous = before.get(current.ref);
    if (previous === undefined) {
      newCases.push(current.ref);
      continue;
    }
    if (passing(previous.status) && !passing(current.status)) regressed.push(current.ref);
    else if (!passing(previous.status) && passing(current.status)) improved.push(current.ref);
    else unchanged += 1;
  }
  for (const previous of baseline.cases) {
    if (!now.has(previous.ref)) dropped.push(previous.ref);
  }
  return { regressed, improved, unchanged, newCases, dropped };
};

type Decision =
  | { readonly kind: "passed" }
  | {
      readonly kind: "blocked";
      readonly reason: GateBlockReason;
      readonly detail: string;
      readonly remedy: string;
    };

const decide = (
  report: AccuracyReport,
  baseline: Baseline | undefined,
  floors: GateFloors,
  counts: GateCounts,
): Decision => {
  // Order matters, and this one is first on purpose. A gate that silently
  // passes because it had nothing to compare against is worse than no gate.
  if (baseline === undefined) {
    return {
      kind: "blocked",
      reason: "baseline-missing",
      detail: `no accepted baseline for suite ${report.suiteDigest}; this run scored ${report.correctBasisPoints}bp over ${report.casesRun} cases`,
      remedy:
        "accept({ report, by, at }) and commit the baseline in this pull request, so the numbers becoming the standard are reviewed by a human first",
    };
  }
  if (report.partial) {
    return {
      kind: "blocked",
      reason: "partial-run",
      detail: report.partialReason ?? "run stopped early",
      remedy: "raise the run budget or reduce the suite, then re-run; a partial run is a biased sample",
    };
  }
  if (
    report.attribution === "partial" ||
    report.attributionCoverageBasisPoints < floors.attributionFloorBasisPoints
  ) {
    return {
      kind: "blocked",
      reason: "unattributed-decisions",
      detail: `${report.unattributedCases.length} decision subtree(s) recorded no model call while the subject declared purity "calls-models": ${report.unattributedCases.join(", ")}`,
      remedy:
        'route the subject\'s model calls through ctx.client so they are recorded, or declare the subject purity: "pure" if it genuinely calls no model',
    };
  }
  if (counts.dropped.length > 0) {
    return {
      kind: "blocked",
      reason: "dropped-cases",
      detail: `${counts.dropped.length} case(s) present in the baseline are absent from this run: ${counts.dropped.join(", ")}`,
      remedy:
        "restore the cases, or re-accept the baseline in a reviewed commit — deleting a failing golden case is the cheapest way to make a gate green",
    };
  }
  if (counts.regressed.length > 0) {
    return {
      kind: "blocked",
      reason: "regression",
      detail: `${counts.regressed.length} case(s) went from correct to not correct: ${counts.regressed.join(", ")}`,
      remedy: "replay the run by its correlation identifier and adjudicate each regressed case",
    };
  }
  if (report.unscoredBasisPoints > floors.maxUnscoredBasisPoints) {
    return {
      kind: "blocked",
      reason: "unscored-rate",
      detail: `${report.unscoredBasisPoints}bp unscored exceeds ${floors.maxUnscoredBasisPoints}bp`,
      remedy: "an unscored case is never a passed case; find out why it could not be measured",
    };
  }
  if (report.contestedBasisPoints > floors.maxContestedBasisPoints) {
    return {
      kind: "blocked",
      reason: "contested-rate",
      detail: `${report.contestedBasisPoints}bp contested exceeds ${floors.maxContestedBasisPoints}bp`,
      remedy:
        "these are adjudication candidates, not defects: the panel disagreed with itself and the disagreement is on the report",
    };
  }
  return { kind: "passed" };
};
