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
 *   - **`saveSuspension` is insert-if-absent.** A second save for an id that
 *     already exists is a no-op rather than an overwrite: an overwrite resets
 *     `revision`, and a reset revision turns a lost compare-and-set into a
 *     silent clobber of somebody else's answer.
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
 * The second adapter is `postgresApprovalStore`, in `postgres-store.ts`. That
 * one carries a suspension across **process death**; this one carries it across
 * a runtime restart over the same object. Both are deliverables and the
 * difference between them is stated rather than blurred: an in-process `Map`
 * survives a rebuilt runtime and does not survive a killed process.
 */
export const inMemoryApprovalStore = (): ApprovalStore => {
  const suspensions = new Map<SuspensionId, SuspensionRecord>();
  const claims = new Map<IdempotencyKey, IdempotencyClaim>();

  const freeze = (record: SuspensionRecord): SuspensionRecord =>
    Object.freeze({ ...record }) as SuspensionRecord;

  return {
    async saveSuspension(record) {
      // Insert-if-absent, matching the Postgres adapter's
      // `ON CONFLICT (id) DO NOTHING`. First write wins.
      if (suspensions.has(record.id)) return;
      suspensions.set(record.id, freeze(record));
    },

    async loadSuspension(id) {
      return suspensions.get(id);
    },

    async suspensionsOf(correlationId, limit) {
      const out: SuspensionRecord[] = [];
      for (const record of suspensions.values()) {
        if (record.correlationId !== correlationId) continue;
        out.push(record);
        if (out.length >= limit) break;
      }
      return out;
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
        // `held` is due as well as `awaiting`. A kill-switch hold is resumable,
        // and a case the sweep stopped visiting when the switch went on is a
        // case nobody comes back to after the incident.
        if (record.state !== "awaiting" && record.state !== "held") continue;
        const expired =
          record.state === "awaiting" && record.expiresAt !== null && record.expiresAt <= now;
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
