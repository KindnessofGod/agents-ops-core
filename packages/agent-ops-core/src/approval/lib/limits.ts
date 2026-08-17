import type { Limits } from "./types.js";

/**
 * Bounded resources. There is no unbounded anything in this module: no
 * unbounded batch, no unbounded fan-out, no unbounded retry, and no unbounded
 * queue read.
 *
 * These are defaults for the bounds that are about *shape*. Note what is not
 * defaulted anywhere: retries on an effect. There are none, at any tier, ever.
 * An effect whose outcome is unknown goes to a human — see
 * `IdempotencyIndeterminate`.
 */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  /** One sweep never touches more than this many suspensions. */
  sweepBatch: 200,
  /** A sweeper dying mid-batch must not freeze what it claimed. Five minutes. */
  sweepLeaseMs: 5 * 60 * 1000,
  /**
   * One hour. A recurrence tighter than this is a flooded channel, and a muted
   * channel makes a case *less* likely to be answered than silence would.
   */
  minRecurrenceIntervalMs: 60 * 60 * 1000,
  /** Ten minutes. Long enough for a payment channel, short enough to reconcile. */
  idempotencyLeaseMs: 10 * 60 * 1000,
  /** Widening the audience is the point; widening it to the whole company is not. */
  maxRecipientsPerReminder: 12,
  /** The reconciliation queue is read in pages, never whole. */
  inDoubtBatch: 100,
  /**
   * Reconciliation reads a whole trace per case, so it is bounded harder than
   * the sweep is. Fifty cases per pass, run as often as the operator likes.
   */
  reconcileBatch: 50,
  /**
   * Sixty-four entry-point invocations in flight. Matches `audit`'s Postgres
   * adapter deliberately: each `run` holds trace writes and store round trips
   * open, and the two ceilings bounding the same connection pool from two
   * directions should not disagree by an order of magnitude.
   */
  maxInFlight: 64,
  /**
   * Parent indexes for at most this many cases are held at once, least
   * recently used evicted first. A sweep of 200 suspensions therefore replays
   * at most 200 traces the first time it sees them and none thereafter,
   * instead of replaying every case on every pass forever.
   */
  parentIndexCases: 512,
});
