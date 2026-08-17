import { BaselineRefused } from "./errors.js";
import type { ModelBackend } from "./clients.js";
import type { EvalRecorder } from "./recorder.js";
import { recorderInternals } from "./recorder.js";
import type { AccuracyCaseStatus, AccuracyReport } from "./report.js";
import { reopenAccuracyReport } from "./report.js";
import type {
  CaseDigest,
  CaseRef,
  EvalNodeId,
  RunId,
  SourceDigest,
  SubjectVersion,
} from "./types.js";

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
  if (input.report.selection !== null) {
    // **A subset run never advances the baseline.** A pre-merge subset is
    // deliberately cheap and deliberately incomplete; accepting one as the
    // standard would silently shrink what every later run is measured against,
    // and the cases it never selected would stop being compared at all. The
    // nightly full-suite run is what sets the standard.
    throw new BaselineRefused(
      `this report covers the subset "${input.report.selection.label}" (${String(input.report.casesRun)} of ${String(input.report.selection.fromSize)} cases); a subset never advances the baseline`,
    );
  }
  if (input.report.couldNotEvaluateBasisPoints > 0) {
    // A provider outage is not a standard. Baking one in means every later run
    // is compared against a run that partly did not happen.
    throw new BaselineRefused(
      `${String(input.report.couldNotEvaluateBasisPoints)}bp of cases could not be evaluated (the provider, not the subject)`,
    );
  }
  reopenAccuracyReport(input.report);
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
  /**
   * The **second** cheapest way, and until now the cheaper of the two: keep the
   * reference, rewrite the golden case's expected verdict to match whatever the
   * subject now says, and the gate compares like for like and passes.
   *
   * `BaselineCase.digest` and `Baseline.suiteDigest` were recorded by `accept`
   * and read by nothing. A regression to `not-duplicate` plus an in-place edit
   * of the expected verdict, same reference, moved the case digest from
   * `5c8d2040…` to `1e69fa57…` and the gate passed. Rewriting a failing golden
   * case was strictly cheaper than deleting one, which is precisely what
   * `dropped-cases` exists to prevent.
   */
  | "edited-cases"
  | "regression"
  | "unscored-rate"
  | "contested-rate"
  /**
   * The provider would not serve some of this run. **Not a regression**, and it
   * is its own reason so it can carry its own exit code: a rate-limit storm that
   * arrives on the same red line as "your change made something worse" teaches
   * people to ignore that line.
   */
  | "could-not-evaluate"
  /**
   * The subject answered differently on re-execution under the same seed.
   *
   * Blocking on it is not pedantry. Every other number this module produces —
   * the baseline, the regression comparison, the replay — assumes that running
   * the same thing twice gives the same answer. When it does not, the gate is
   * not measuring the change; it is measuring the weather.
   */
  | "non-deterministic-subject";

/**
 * What the gate actually covered, on the outcome so a green build states it.
 *
 * A pre-merge subset that passes is not the same claim as a full suite that
 * passes, and until this existed there was no way to tell the two apart from a
 * `GateOutcome`. `notCovered` is enumerated because "these four baseline cases
 * were not run" is a different sentence from "these four baseline cases were
 * deleted", and a gate that cannot say which one it means is a gate that will be
 * argued with.
 */
export interface GateCoverage {
  readonly kind: "full" | "subset";
  /** The subset's label, or `null` for a full run. */
  readonly label: string | null;
  readonly casesRun: number;
  /** The size of the source this was selected from; equals `casesRun` when full. */
  readonly suiteSize: number;
  /** Baseline cases the subset deliberately did not select. Never `dropped`. */
  readonly notCovered: readonly CaseRef[];
}

export interface GateCounts {
  readonly regressed: readonly CaseRef[];
  readonly improved: readonly CaseRef[];
  readonly unchanged: number;
  /** Reported, never gated. New golden cases are not regressions. */
  readonly newCases: readonly CaseRef[];
  readonly dropped: readonly CaseRef[];
  /** Same reference, different content address: the case itself was rewritten. */
  readonly edited: readonly CaseRef[];
}

export type GateOutcome =
  | {
      readonly kind: "passed";
      readonly runId: RunId;
      /** The run this gate decision was recorded under. Replayable on its own. */
      readonly gateRun: RunId;
      readonly node: EvalNodeId;
      readonly counts: GateCounts;
      /** What this pass covered. A green subset build says so on the outcome. */
      readonly coverage: GateCoverage;
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
      readonly coverage: GateCoverage;
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
  // Validated at runtime, not only at compile time. The report brands are
  // phantom `unique symbol`s and do not survive a process boundary, so the
  // continuous-integration flow this gate exists for — run in job A, JSON, gate
  // in job B — could only re-enter through a cast, and this function checked
  // nothing. `reopenAccuracyReport` checks the literal schema, checks every
  // figure is a safe integer, and recomputes the rates from the cases.
  const report = reopenAccuracyReport(input.report);
  const internals = recorderInternals(input.recorder);
  // A distinct run per gate decision. Gating the same report twice — a
  // re-triggered continuous-integration job — records two decisions rather than
  // colliding, and each is replayable on its own. The suffix comes from the
  // recorder's injected clock and counter; it used to be `Math.random()`.
  const scope = await internals.beginRun({
    idPrefix: `gate-${report.runId}`,
    costCeilingTenthCents: 0,
    onCostCeiling: () => undefined,
    header: {
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
  const gateRun = scope.runId;

  const coverage = coverageOf(report, input.baseline);
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
      edited: counts.edited.length,
      coverageKind: coverage.kind,
      coverageLabel: coverage.label,
      coverageCasesRun: coverage.casesRun,
      coverageSuiteSize: coverage.suiteSize,
      coverageNotCovered: coverage.notCovered.join(","),
      determinismChecked: report.determinism.check.kind === "checked",
      determinismUnstable:
        report.determinism.check.kind === "checked"
          ? report.determinism.check.unstable.length
          : null,
      couldNotEvaluateBasisPoints: report.couldNotEvaluateBasisPoints,
      memoisation: report.memoisation.kind,
      baselineSuiteDigest: input.baseline?.suiteDigest ?? null,
      runSuiteDigest: report.suiteDigest,
      attribution: report.attribution,
      subjectPurity: report.subjectPurity,
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
    ? { kind: "passed", runId: report.runId, gateRun, node: gateNode.id, counts, coverage }
    : {
        kind: "blocked",
        reason: decision.reason,
        detail: decision.detail,
        remedy: decision.remedy,
        runId: report.runId,
        gateRun,
        node: gateNode.id,
        counts,
        coverage,
      };
};

/**
 * What this gate decision covered.
 *
 * `notCovered` is the intersection of the baseline's cases with the subset's
 * `notSelected` list — the baseline cases this run deliberately skipped. It is
 * the reason `dropped-cases` does not fire on every pre-merge run: deleting a
 * failing golden case and not selecting it are the same absence, and only the
 * selection record can tell them apart.
 */
const coverageOf = (report: AccuracyReport, baseline: Baseline | undefined): GateCoverage => {
  const selection = report.selection;
  if (selection === null) {
    return {
      kind: "full",
      label: null,
      casesRun: report.casesRun,
      suiteSize: report.casesRun,
      notCovered: [],
    };
  }
  const skipped = new Set<string>(selection.notSelected);
  return {
    kind: "subset",
    label: selection.label,
    casesRun: report.casesRun,
    suiteSize: selection.fromSize,
    notCovered: (baseline?.cases ?? []).map((c) => c.ref).filter((ref) => skipped.has(ref)),
  };
};

const passing = (status: AccuracyCaseStatus): boolean => status === "correct";

/**
 * Baseline matching is on the **intersection of case references**, not on the
 * suite hash. Adding a golden case therefore does not invalidate the baseline
 * and does not read as a suite-wide regression; the new case is reported as new.
 * Removing one is a different matter — see `dropped-cases`.
 *
 * **And a reference alone is not a match.** `accept` records a content address
 * per case and a digest for the whole suite, and this function used to read
 * neither: matching was on `CaseRef` and nothing else, so editing a failing
 * golden case's expected verdict in place — same reference, new content — made
 * the gate compare a case against a baseline for a *different* case and pass.
 * A reference is an identity; the digest is what makes two things with the same
 * identity the same thing.
 */
const compare = (report: AccuracyReport, baseline: Baseline | undefined): GateCounts => {
  if (baseline === undefined) {
    return {
      regressed: [],
      improved: [],
      unchanged: 0,
      newCases: report.cases.map((c) => c.ref),
      dropped: [],
      edited: [],
    };
  }
  const before = new Map(baseline.cases.map((c) => [c.ref, c]));
  const now = new Map(report.cases.map((c) => [c.ref, c]));
  const regressed: CaseRef[] = [];
  const improved: CaseRef[] = [];
  const newCases: CaseRef[] = [];
  const dropped: CaseRef[] = [];
  const edited: CaseRef[] = [];
  let unchanged = 0;
  for (const current of report.cases) {
    const previous = before.get(current.ref);
    if (previous === undefined) {
      newCases.push(current.ref);
      continue;
    }
    if (previous.digest !== current.digest) {
      // Same name, different case. Comparing their statuses would be comparing
      // two different questions, so it is not done: the edit is reported and
      // the gate blocks on it.
      edited.push(current.ref);
      continue;
    }
    if (passing(previous.status) && !passing(current.status)) regressed.push(current.ref);
    else if (!passing(previous.status) && passing(current.status)) improved.push(current.ref);
    else unchanged += 1;
  }
  // A case absent from the run is `dropped` **unless the subset said so**.
  // Deleting a failing golden case and not selecting it produce the same
  // absence, and only the recorded selection distinguishes them — which is why
  // `notSelected` is enumerated on the report rather than counted.
  const deliberatelySkipped = new Set<string>(report.selection?.notSelected ?? []);
  for (const previous of baseline.cases) {
    if (!now.has(previous.ref) && !deliberatelySkipped.has(previous.ref)) dropped.push(previous.ref);
  }
  return { regressed, improved, unchanged, newCases, dropped, edited };
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
  // Second on purpose, ahead of every quality signal. If the provider would not
  // serve part of this run, nothing downstream of it is a statement about the
  // subject, and reporting one of those first would be reporting the weather as
  // a regression.
  if (report.couldNotEvaluateBasisPoints > 0) {
    return {
      kind: "blocked",
      reason: "could-not-evaluate",
      detail: `${report.couldNotEvaluateBasisPoints}bp of cases could not be evaluated: the provider refused or could not be reached`,
      remedy:
        "re-run when the provider is serving again — this is not a regression, it exits 2 rather than 1, and nothing about the change under test has been established either way",
    };
  }
  // Third. Every number below this line — the baseline, the comparison, the
  // replay — assumes running the same thing twice gives the same answer.
  if (report.determinism.check.kind === "checked" && report.determinism.check.unstable.length > 0) {
    return {
      kind: "blocked",
      reason: "non-deterministic-subject",
      detail: `re-executed under the same seed, the subject answered differently on ${String(report.determinism.check.unstable.length)} of ${String(report.determinism.check.sampled.length)} sampled case(s): ${report.determinism.check.unstable.join(", ")}`,
      remedy:
        "pin the subject's own sources of variation — temperature, iteration order, ambient time, an unseeded shuffle — and use ctx.seed; until then a regression figure over this subject is measuring the weather",
    };
  }
  // `declared-pure` is exempt from the coverage floor and from nothing else. A
  // genuine rules engine records no model call and is a legitimate, common
  // subject; blocking it by default would be wrong. What is *not* done is
  // presenting it as coverage: the report says `declared-pure` with coverage 0,
  // the gate node records the purity declaration, and a reader can see that the
  // run rests on an assertion by the subject's author rather than on evidence.
  if (
    report.attribution === "partial" ||
    (report.attribution === "complete" &&
      report.attributionCoverageBasisPoints < floors.attributionFloorBasisPoints)
  ) {
    return {
      kind: "blocked",
      reason: "unattributed-decisions",
      detail: `${report.unattributedCases.length} decision subtree(s) contradicted the subject's declared purity "${report.subjectPurity}": ${report.unattributedCases.join(", ")}`,
      remedy:
        'route the subject\'s model calls through ctx.client so they are recorded, or declare the subject purity: "pure" if it genuinely calls no model — and note that "pure" is a declaration this module cannot verify, so it is reported as declared-pure rather than as coverage',
    };
  }
  if (counts.edited.length > 0) {
    return {
      kind: "blocked",
      reason: "edited-cases",
      detail: `${counts.edited.length} case(s) kept their reference but changed content address since the baseline: ${counts.edited.join(", ")}`,
      remedy:
        "restore the cases, or re-accept the baseline in a reviewed commit — rewriting a failing golden case to match the subject is cheaper than deleting one and hides more",
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
