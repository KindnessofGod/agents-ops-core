import type { Limits } from "./types.js";

/**
 * Bounded resources. There is no unbounded anything in this module: no
 * unbounded fan-out across detectors, no unbounded wait on one, no unbounded
 * payload, no unbounded finding list, and **no retries at all**.
 *
 * The absent bound is the interesting one. A detector that failed is not
 * retried, at any tier. Retrying a fail-closed screening spends the budget
 * twice to reach the same answer, and — worse — a hidden retry is a node that
 * has to be invented or lost. A caller who wants a second attempt calls
 * `screenInput` again with the first screening's node as `under`, and the
 * second attempt is a visible node with a recorded parent. Retries are a caller
 * decision, taken in the open.
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
