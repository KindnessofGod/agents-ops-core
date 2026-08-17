import type {
  ApprovalStore,
  IdempotencyClaim,
  IdempotencyKey,
  Instant,
  SuspensionId,
  SuspensionRecord,
} from "./types.js";

/**
 * In-memory approval store.
 *
 * A shipped deliverable, not a test mock. It is what makes hermetic tests
 * structural rather than conventional: with this adapter wired in, there is no
 * code path from a decision point to a socket, whatever credentials are present
 * in the environment.
 *
 * It holds the same invariants the Postgres adapter must hold, and they are the
 * interesting part of the seam rather than the storage:
 *
 *   - **Records are frozen on write.** A caller holding a returned record
 *     cannot mutate the store through it.
 *   - **Updates are compare-and-swap on `revision`.** Two writers to one
 *     suspension — a `sweep` and an `answer` arriving in the same second — are
 *     correct without a lock. No lock is ever held across the human gate,
 *     because a lock held for three days is not a lock, it is an outage.
 *   - **Leases are compare-and-set.** Two sweepers running during a deploy is
 *     the normal case, not the exceptional one.
 *   - **An idempotency claim is written before the outbound call**, and its
 *     three states never collapse into two.
 *   - **Claiming is an atomic transition, not a read.** Exactly one concurrent
 *     caller per key gets `claimed: true`. The lease is load-bearing rather
 *     than decorative: an expired lease on `not-attempted` is reclaimable
 *     because no outbound call was made, and an expired lease on `unknown` is
 *     never reclaimed for execution, whatever its age.
 *
 * A second adapter is named and not built here: `postgresApprovalStore`,
 * alongside `audit`'s Postgres trace store, sharing one connection so that a
 * suspension and its trace node can commit together. Until it exists this seam
 * has one adapter and is, by the project's own rule, hypothetical. Reported as
 * such rather than dressed up.
 */
export const inMemoryApprovalStore = (): ApprovalStore => {
  const suspensions = new Map<SuspensionId, SuspensionRecord>();
  const claims = new Map<IdempotencyKey, IdempotencyClaim>();

  const freeze = (record: SuspensionRecord): SuspensionRecord =>
    Object.freeze({ ...record }) as SuspensionRecord;

  return {
    async saveSuspension(record) {
      suspensions.set(record.id, freeze(record));
    },

    async loadSuspension(id) {
      return suspensions.get(id);
    },

    async swapSuspension(id, expectedRevision, next) {
      const current = suspensions.get(id);
      if (current === undefined || current.revision !== expectedRevision) return false;
      suspensions.set(id, freeze({ ...next, revision: expectedRevision + 1 }));
      return true;
    },

    async dueSuspensions(now: Instant, limit: number) {
      const due: SuspensionRecord[] = [];
      for (const record of suspensions.values()) {
        if (record.state !== "awaiting") continue;
        const expired = record.expiresAt !== null && record.expiresAt <= now;
        if (!expired && record.nextDueAt > now) continue;
        due.push(record);
      }
      // Oldest first: a case that has waited eleven days is served before one
      // that has waited eleven minutes, so a busy queue cannot starve the case
      // most in need of an answer.
      due.sort((a, b) => a.nextDueAt - b.nextDueAt);
      return due.slice(0, Math.max(0, limit));
    },

    async acquireLease(id, owner, now, until) {
      const current = suspensions.get(id);
      if (current === undefined) return false;
      if (current.leaseUntil !== null && current.leaseUntil > now) return false;
      suspensions.set(id, freeze({ ...current, leaseOwner: owner, leaseUntil: until }));
      return true;
    },

    async claimIdempotency(key, correlationId, now, leaseMs) {
      const take = (reclaimed: boolean) => {
        const claim: IdempotencyClaim = Object.freeze({
          key,
          correlationId,
          state: "not-attempted" as const,
          claimedAt: now,
          leaseUntil: now + leaseMs,
          outcome: null,
          reason: null,
        });
        claims.set(key, claim);
        return { claim, claimed: true, reclaimed };
      };

      const existing = claims.get(key);
      if (existing === undefined) return take(false);

      // An expired lease on `not-attempted` is reclaimable: the claim was
      // taken and no outbound call was made, so re-executing is safe and
      // leaving it stuck is a payment nobody makes.
      if (existing.state === "not-attempted" && existing.leaseUntil <= now) return take(true);

      // Everything else is somebody else's. In particular an expired lease on
      // `unknown` is NEVER reclaimed for execution, whatever its age — the
      // outbound call was made and nobody knows what happened. It goes to
      // `inDoubt` and a human resolves it.
      return { claim: existing, claimed: false, reclaimed: false };
    },

    async readIdempotency(key) {
      return claims.get(key);
    },

    async settleIdempotency(key, next) {
      claims.set(key, Object.freeze({ ...next }));
    },

    async inDoubt(limit) {
      const out: IdempotencyClaim[] = [];
      for (const claim of claims.values()) {
        if (claim.state === "unknown") out.push(claim);
        if (out.length >= limit) break;
      }
      return out;
    },
  };
};
