import type { Limits } from "./types.js";

/**
 * Bounded resources: bounded fan-out across detectors, a bounded wait on one, a
 * bounded payload, a bounded finding list, and **no retries at all**. Every
 * field below is range-checked at construction — see `createGuardrails` — because
 * `maxFindingsPerScreening: 0` used to turn a `block` into an `allow`.
 *
 * The absent bound is the interesting one. A detector that failed is not
 * retried, at any tier. Retrying a fail-closed screening spends the budget
 * twice to reach the same answer, and — worse — a hidden retry is a node that
 * has to be invented or lost. A caller who wants a second attempt calls
 * `screenInput` again with the first `Screening` as `under`, and the second
 * attempt is a visible node with a recorded parent. Retries are a caller
 * decision, taken in the open.
 *
 * ## What these bounds do not reach, counted honestly
 *
 * "No unbounded anything" was too strong, and three things escaped it. All three
 * are now bounded, and the first is bounded in a smaller way than the sentence
 * that replaced it might suggest:
 *
 *   - **A detector's work, not only its answer.** `detectorBudgetMicros` bounds
 *     the answer — an overrun is measured against the injected clock and
 *     recorded `unavailable/timed-out`, so the screening fails closed
 *     deterministically. It now also bounds the work, on two further axes:
 *     `Pattern` cannot be built from a regular expression capable of exponential
 *     backtracking, and every detector is handed a `deadline` over the same
 *     injected clock which both shipped adapters check between units of work.
 *     What is left is a **polynomial** worst case for one accepted pattern over
 *     one field — on the order of `maxFieldChars²` character comparisons, which
 *     is the term to halve if a stall is ever measured. `lib/safe-pattern.ts`
 *     gives the full accounting; `lib/detectors.ts` gives the mechanism.
 *   - **A judge's model calls.** `maxClaims` bounds the count and the budget is
 *     now divided across them rather than discarded, so each call is asked for a
 *     bound. A classifier that ignores its `budgetMicros` is bounded by nothing
 *     here.
 *   - **Replaying a case to resolve a parent.** `checkOutput` used to replay the
 *     whole case on every call, growing for the life of the case on the hot path
 *     before every effect. A `Screening` now carries its own settled node, so
 *     that read happens only for a bare `NodeId` this process did not mint, and
 *     once per case for the witness proof.
 */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  /**
   * Eight. Enough to hide the latency of a model detector behind the
   * deterministic ones; small enough that nineteen applications screening
   * concurrently do not become the classifier's rate-limit incident.
   */
  detectorConcurrency: 8,
  /**
   * Two seconds. A deterministic detector is sub-millisecond; this is sized for
   * a model detector, and a screening that has taken two seconds has already
   * cost more than the decision it guards.
   */
  detectorBudgetMicros: 2_000_000,
  /** A screened payload is a decision's inputs, not a document store. */
  maxFields: 64,
  /** 32k characters per field. Past this the caller is screening a corpus. */
  maxFieldChars: 32_768,
  /**
   * How much of a *redacted* field reaches the trace. The remainder is
   * represented by a digest, so a 2033 reader can still prove which text was
   * screened without the trace holding all of it.
   */
  maxRecordedFieldChars: 512,
  /**
   * A screening reports at most this many findings. A payload producing more
   * has already earned its recommendation; the count of what was truncated is
   * recorded, so the trace never claims the list is complete when it is not.
   */
  maxFindingsPerScreening: 64,
  /** Groundedness is O(claims x sources). Both sides are bounded. */
  maxClaims: 128,
  maxSources: 32,
});
