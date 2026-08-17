import type {
  Audit,
  CorrelationId,
  NodeId,
  NodePayload,
  RecordedNode,
  RiskTier,
} from "../../audit/index.js";
import { canonicalJson } from "./canonical.js";
import { TraceNodeNotRecorded } from "./errors.js";

/**
 * Recording, against the `audit` module's interface.
 *
 * Three jobs, each of which would otherwise be a caller's discipline.
 *
 * 1. **Every number is asserted to be a safe integer before the write.** Money
 *    in minor units, latency in microseconds, confidence in basis points. A
 *    float reaching the trace throws `NonIntegerPayload` rather than being
 *    written and discovered in 2033.
 *
 * 2. **Parentage survives process death, at a bounded cost.**
 *    `audit.CaseTrace.record` takes a parent as a `RecordedNode`, not a
 *    `NodeId`. A case resumed in a different process holds only identifiers, so
 *    the first write that needs a parent it has not seen replays that case once
 *    and indexes it.
 *
 *    That replay is shared and bounded — see `ParentIndexes` below. It used to
 *    be neither: every sweep visit built a fresh recorder, parented on the
 *    suspension's node, missed, and replayed the whole case. For a batch of two
 *    hundred suspensions that is two hundred full traces materialised in memory
 *    **per sweep**, forever, for cases that may wait months.
 *
 *    Worth flagging upward, still: `record(payload, { parent: RecordedNode |
 *    NodeId })` on `audit` would delete the replay entirely. That is `audit`'s
 *    interface to change, not this module's.
 *
 * 3. **A degraded write is an error here, at every tier.** `audit` lets a
 *    low- or medium-tier node be dropped when the store is unavailable, and for
 *    a module whose nodes are informational that is a reasonable trade. This
 *    module has no informational nodes: every one of them is part of the chain
 *    of evidence that an effect was licensed, and a licence with no node behind
 *    it is an assertion rather than evidence. So `approval` narrows `audit`'s
 *    tiered policy to fail-closed for its own writes and says so, rather than
 *    inheriting a policy that was written for a different question.
 */
export interface Recorder {
  readonly record: (payload: NodePayload, parent?: NodeId) => Promise<RecordedNode>;
  /** A recorder for the same case, stamping a different tier. Shares the index. */
  readonly at: (tier: RiskTier) => Recorder;
}

interface CaseIndex {
  readonly nodes: Map<NodeId, RecordedNode>;
  hydrated: boolean;
}

/**
 * Parent indexes for many cases, bounded in the only dimension that can grow
 * without limit: the number of cases held at once.
 *
 * Least-recently-used eviction, `capacity` entries. One case's index is bounded
 * by the trace store's own per-case node ceiling, which `audit` enforces and
 * reports as `capacity`. Evicting a case costs one replay the next time it is
 * touched, never a lost parent: a miss re-hydrates.
 */
export interface ParentIndexes {
  readonly for: (correlationId: CorrelationId) => CaseIndex;
  /** Cases currently held. Exposed so the bound is testable, not inferred. */
  readonly size: () => number;
}

export const parentIndexes = (capacity: number): ParentIndexes => {
  const bound = Math.max(1, capacity);
  const cases = new Map<CorrelationId, CaseIndex>();
  return {
    for(correlationId) {
      const existing = cases.get(correlationId);
      if (existing !== undefined) {
        // Re-insert to mark it most-recently-used.
        cases.delete(correlationId);
        cases.set(correlationId, existing);
        return existing;
      }
      const fresh: CaseIndex = { nodes: new Map(), hydrated: false };
      cases.set(correlationId, fresh);
      while (cases.size > bound) {
        const oldest = cases.keys().next();
        if (oldest.done === true) break;
        cases.delete(oldest.value);
      }
      return fresh;
    },
    size: () => cases.size,
  };
};

export const recorderFor = async (
  audit: Audit,
  correlationId: CorrelationId,
  tier: RiskTier,
  indexes: ParentIndexes,
): Promise<Recorder> => {
  const trace = await audit.open(correlationId);
  const shared = indexes.for(correlationId);

  const hydrate = async (): Promise<void> => {
    if (shared.hydrated) return;
    const replayed = await audit.replay(correlationId);
    for (const node of replayed.nodes) shared.nodes.set(node.id, node);
    shared.hydrated = true;
  };

  const build = (stamp: RiskTier): Recorder => ({
    async record(payload, parent) {
      // Throws NonIntegerPayload before anything crosses the seam. There is no
      // un-writing, so the check has to be on this side of it.
      canonicalJson(payload);

      let parentNode: RecordedNode | undefined;
      if (parent !== undefined) {
        parentNode = shared.nodes.get(parent);
        if (parentNode === undefined) {
          await hydrate();
          parentNode = shared.nodes.get(parent);
        }
      }
      const result =
        parentNode === undefined
          ? await trace.record(payload, { tier: stamp })
          : await trace.record(payload, { tier: stamp, parent: parentNode });
      if (!result.recorded) {
        throw new TraceNodeNotRecorded(correlationId, payload.kind, result.reason);
      }
      shared.nodes.set(result.node.id, result.node);
      return result.node;
    },
    at: (next: RiskTier) => build(next),
  });

  return build(tier);
};
