/**
 * Dedupe, bounded, and never a mute button.
 *
 * Requirement (f) is precise about the shape of this: *"dedupe/suppression so
 * one flapping condition cannot itself become the outage — but suppression must
 * NEVER silence a condition entirely, only collapse repeats, and the suppression
 * count is reported when it finally fires."*
 *
 * So three rules, and the third is the one that is usually missed:
 *
 *   1. **The first occurrence of a fingerprint always fires.** There is no warm-
 *      up, no threshold, no "three in five minutes". A condition that happens
 *      once and never again is delivered once.
 *   2. **Repeats inside the window are counted, not delivered**, and every
 *      window ends. There is no state in which a fingerprint stays suppressed
 *      forever, and no configuration that can produce one — `suppressionWindowMs`
 *      is a duration, not a switch.
 *   3. **The count rides on the next delivery.** An alert that fires after four
 *      hundred collapsed repeats says four hundred. Collapsing repeats without
 *      reporting the count would turn a flapping condition into an occasional
 *      one, which is a lie of exactly the kind this module exists to prevent.
 *
 * And one bound, because the table is memory: at `maxTrackedFingerprints` the
 * least-recently-fired entry is evicted. **Eviction makes an alert louder, never
 * quieter** — an evicted fingerprint has no window, so its next occurrence fires
 * immediately. What eviction does cost is any pending repeat count, so those are
 * counted separately and published in `health()` rather than quietly discarded.
 *
 * **One honest limit, stated rather than discovered.** The window opens when the
 * slot is *claimed*, not when a sink confirms delivery — the claim has to be
 * synchronous, and delivery is not. So a fingerprint whose delivery then fails
 * stays collapsed for the rest of its window rather than being retried at every
 * occurrence. That is deliberate: flooding a chain that is already failing helps
 * nobody, and the failure is not lost — it is on the returned outcome, in the
 * journal, and in the `health()` ledger the external watcher reads.
 *
 * Every method here is **synchronous on purpose**. The decision to fire or
 * suppress, and the write that records it, happen in one block with no `await`
 * between them, so two concurrent raises of the same fingerprint cannot both
 * decide to fire. That is what "correct under concurrent writers" means in a
 * single-threaded runtime, and it is a property of where the awaits are, not of
 * a lock.
 */

import type { AlertFingerprint, DurationMs, Instant } from "./primitives.js";

export interface SuppressionDecision {
  readonly fire: boolean;
  /** Collapsed repeats since this fingerprint last fired. Reported on delivery. */
  readonly suppressedSinceLastDelivery: number;
  /** When the window ends. On `fire`, when the *next* window ends. */
  readonly nextEligibleAt: Instant;
}

export interface SuppressionTable {
  /**
   * Decide and record in one synchronous step. Calling this **is** claiming the
   * delivery slot: there is no separate commit, because a commit after an await
   * is a race.
   */
  decide(fingerprint: AlertFingerprint, now: Instant): SuppressionDecision;
  /** Fingerprints currently held. Bounded by `maxTrackedFingerprints`. */
  tracked(): number;
  /** How many entries the bound has evicted since construction. */
  evictions(): number;
  /** Repeat counts lost to eviction. Small, and never invisible. */
  lostRepeats(): number;
}

interface Entry {
  lastFiredAt: Instant;
  pending: number;
}

export const suppressionTable = (limits: {
  readonly suppressionWindowMs: DurationMs;
  readonly maxTrackedFingerprints: number;
}): SuppressionTable => {
  const entries = new Map<AlertFingerprint, Entry>();
  let evictions = 0;
  let lostRepeats = 0;

  const evictOldest = (): void => {
    let oldestKey: AlertFingerprint | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      if (entry.lastFiredAt < oldestAt) {
        oldestAt = entry.lastFiredAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) return;
    const evicted = entries.get(oldestKey);
    entries.delete(oldestKey);
    evictions += 1;
    lostRepeats += evicted?.pending ?? 0;
  };

  return {
    decide(fingerprint, now) {
      const existing = entries.get(fingerprint);

      if (existing === undefined) {
        // Rule 1: the first occurrence always fires.
        while (entries.size >= limits.maxTrackedFingerprints) evictOldest();
        entries.set(fingerprint, { lastFiredAt: now, pending: 0 });
        return {
          fire: true,
          suppressedSinceLastDelivery: 0,
          nextEligibleAt: now + limits.suppressionWindowMs,
        };
      }

      const windowEndsAt = existing.lastFiredAt + limits.suppressionWindowMs;
      if (now < windowEndsAt) {
        // Rule 2: collapse, count, do not deliver.
        existing.pending += 1;
        return {
          fire: false,
          suppressedSinceLastDelivery: existing.pending,
          nextEligibleAt: windowEndsAt,
        };
      }

      // Rule 3: the window ended. Fire, carrying what was collapsed.
      const collapsed = existing.pending;
      existing.pending = 0;
      existing.lastFiredAt = now;
      return {
        fire: true,
        suppressedSinceLastDelivery: collapsed,
        nextEligibleAt: now + limits.suppressionWindowMs,
      };
    },
    tracked: () => entries.size,
    evictions: () => evictions,
    lostRepeats: () => lostRepeats,
  };
};
