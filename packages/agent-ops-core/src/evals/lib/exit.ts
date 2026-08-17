import {
  BaselineRefused,
  EvalsError,
  ProviderUnavailable,
  RunBudgetExhausted,
  RunNotMemoisable,
} from "./errors.js";
import type { GateBlockReason, GateOutcome } from "./gate.js";

/**
 * The exit code a command-line adapter returns, decided **here** rather than in
 * a shell script.
 *
 * Four codes, and the two in the middle are the point:
 *
 * | Code | Meaning | Why it is its own code |
 * |---|---|---|
 * | `0` | Passed on evidence. | |
 * | `1` | **Evidence failure.** The change made something worse, or removed the evidence that would have shown it. | |
 * | `2` | **Could not be evaluated.** No baseline, a partial run, an indeterminate score, a provider that would not serve, a subject that will not answer the same way twice. | Conflating this with `0` is the silent pass this whole module exists to prevent. Conflating it with `1` teaches people to ignore `1`. |
 * | `3` | **Integrity failure.** The machinery is wrong: the store is unavailable, the recorder or ledger was not minted, a subject attempted an effect, a suite or an artefact cannot be read. | Not a quality signal at all, and never retried automatically. |
 *
 * ## Why this is a library function and not fifteen lines of `bash`
 *
 * The mapping is a **decision about what a failure means**, and decisions about
 * meaning belong where they can be tested. A `bin` wrapper over this is four
 * lines and can be whatever each of the nineteen applications wants; what none
 * of them should be doing is re-deriving, in shell, whether a rate-limit storm
 * is a regression. `exitCodeFor` is callable from a test with no process to
 * spawn, which is the only way this stays honest as reasons are added.
 *
 * ## Two rules that hold for every unrecognised input
 *
 * **Could-not-evaluate never looks like a pass.** There is no path through this
 * function that returns `0` for anything other than a gate that passed.
 *
 * **An unrecognised failure is `3`, never `1`.** A thrown value this module does
 * not name is a fault in the machinery until proven otherwise; reporting it as
 * an ordinary regression would put it in the queue of things engineers triage by
 * re-running.
 */
export type EvalExitCode = 0 | 1 | 2 | 3;

export type ExitKind = "pass" | "evidence-failure" | "could-not-evaluate" | "integrity-failure";

export interface ExitDecision {
  readonly code: EvalExitCode;
  readonly kind: ExitKind;
  /** A stable slug for a dashboard. Never prose. */
  readonly reason: string;
  /** One line for the top of a continuous-integration log. */
  readonly line: string;
}

export type ExitInput =
  | { readonly kind: "gate"; readonly outcome: GateOutcome }
  /** Whatever `run`, `gate` or `accept` threw. `unknown`, because it is. */
  | { readonly kind: "threw"; readonly error: unknown };

/**
 * Which of the two non-passing gate outcomes a block reason is.
 *
 * A `switch` with no `default`, over the `GateBlockReason` union, returning a
 * non-optional type: **adding a block reason without classifying it does not
 * compile.** That is deliberate and it is the only part of this file that has to
 * stay true as the gate grows — an unclassified reason silently defaulting to
 * `1` is precisely how "could not evaluate" starts looking like "you broke it".
 */
const classifyBlock = (reason: GateBlockReason): "evidence-failure" | "could-not-evaluate" => {
  switch (reason) {
    // The change made something worse, or removed the evidence that would have
    // shown it. Deleting a golden case and rewriting one in place are both the
    // author acting on the evidence, so they are evidence failures rather than
    // machinery faults.
    case "regression":
    case "dropped-cases":
    case "edited-cases":
      return "evidence-failure";
    // Nothing was established, in either direction. A first run with no
    // baseline, a run that stopped early, cases nobody could score, a panel
    // that disagreed with itself, decisions whose thinking cannot be located, a
    // provider that would not serve, and a subject that will not answer the
    // same way twice.
    case "baseline-missing":
    case "partial-run":
    case "unattributed-decisions":
    case "unscored-rate":
    case "contested-rate":
    case "could-not-evaluate":
    case "non-deterministic-subject":
      return "could-not-evaluate";
  }
};

const CODES: Readonly<Record<ExitKind, EvalExitCode>> = {
  pass: 0,
  "evidence-failure": 1,
  "could-not-evaluate": 2,
  "integrity-failure": 3,
};

/**
 * Which kind a thrown `EvalsError` is.
 *
 * `EvalsError.incident` already answers most of it — the module classifies its
 * own error modes as incident or not, and an incident is by definition the
 * machinery being wrong. The named exceptions below are the non-incident errors
 * that are still not *quality* signals: an unreadable suite, a misdeclared
 * panel, a limit out of range. Those are configuration and artefact faults, and
 * a build that reports them as regressions sends somebody to read a diff that
 * contains nothing.
 */
const classifyError = (error: unknown): { readonly kind: ExitKind; readonly reason: string } => {
  if (error instanceof EvalsError) {
    if (error.incident) return { kind: "integrity-failure", reason: error.name };
    // Nothing was established, and nothing is wrong with the machinery.
    if (
      error instanceof ProviderUnavailable ||
      error instanceof RunBudgetExhausted ||
      error instanceof BaselineRefused ||
      error instanceof RunNotMemoisable
    ) {
      return { kind: "could-not-evaluate", reason: error.name };
    }
    // Everything else `EvalsError` names is a fault in the inputs or the
    // artefacts: an unversioned or empty suite, a duplicate reference, a
    // payload that will not serialise, a report that is not one, a misdeclared
    // panel, a limit out of range. All machinery, none of it a regression.
    return { kind: "integrity-failure", reason: error.name };
  }
  // Not ours. `3`, never `1`, never `0`.
  return {
    kind: "integrity-failure",
    reason: error instanceof Error ? error.name : "UnknownThrow",
  };
};

export const exitCodeFor = (input: ExitInput): ExitDecision => {
  if (input.kind === "gate") {
    const outcome = input.outcome;
    const covered =
      outcome.coverage.kind === "full"
        ? `${String(outcome.coverage.casesRun)} case(s), full suite`
        : `${String(outcome.coverage.casesRun)} of ${String(outcome.coverage.suiteSize)} case(s), subset "${String(outcome.coverage.label)}"`;
    if (outcome.kind === "passed") {
      return {
        code: CODES.pass,
        kind: "pass",
        reason: "passed",
        // The coverage is on the **pass** line, not only the failure line. A
        // green build that covered 61 of 214 cases should say so where somebody
        // merging at 07:40 will read it.
        line: `PASS run ${outcome.runId} — covered ${covered}`,
      };
    }
    const kind = classifyBlock(outcome.reason);
    return {
      code: CODES[kind],
      kind,
      reason: outcome.reason,
      line: `${kind === "evidence-failure" ? "FAIL" : "INDETERMINATE"} run ${outcome.runId} — ${outcome.reason}: ${outcome.detail} — covered ${covered}`,
    };
  }
  const { kind, reason } = classifyError(input.error);
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return {
    code: CODES[kind],
    kind,
    reason,
    line: `${kind === "integrity-failure" ? "INTEGRITY" : "INDETERMINATE"} — ${reason}: ${message}`,
  };
};
