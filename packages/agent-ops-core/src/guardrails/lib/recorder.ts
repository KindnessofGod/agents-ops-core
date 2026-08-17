import type {
  Audit,
  CorrelationId,
  NodeId,
  NodePayload,
  NodeTelemetry,
  RecordedNode,
  RiskTier,
} from "../../audit/index.js";
import {
  AuditWitnessUnsound,
  ScreeningNotRecorded,
  ScreeningParentUnknown,
} from "./errors.js";

/**
 * Recording, against the `audit` module's interface.
 *
 * Three jobs, all of which would otherwise be a caller's discipline.
 *
 * 1. **A degraded write is an error here, at every tier.** `audit` lets a low-
 *    or medium-tier node be dropped when the store is unavailable, and for a
 *    module whose nodes are informational that is a reasonable trade. This
 *    module has no informational nodes: every one is the evidence that a search
 *    was performed, and a screening with no node behind it is an assertion
 *    rather than evidence. So `guardrails` narrows `audit`'s tiered policy to
 *    fail-closed for its own writes and says so, rather than inheriting a policy
 *    written for a different question. See `errors.ts` for the full asymmetry.
 *
 * 2. **Parentage is refused, never dropped.** `audit`'s `record` takes a parent
 *    as a `RecordedNode`, not a `NodeId`. A screening may hang under a node
 *    recorded elsewhere in the same case, so the first time a parent is not in
 *    the local index the case is replayed once and indexed — and if it is still
 *    not there, `ScreeningParentUnknown` is raised. Writing the node as a root
 *    instead would silently detach the screening from the graph, and C1 requires
 *    parent/child recorded rather than inferred.
 *
 *    Worth flagging upward, as `approval` already has:
 *    `record(payload, { parent: RecordedNode | NodeId })` on `audit` would
 *    delete the replay entirely. That is `audit`'s interface to change.
 *
 * 3. **An acknowledgement is checked, and the first write of a case is proven.**
 *    See `proveWrite` below. This is the residue of the hole
 *    `docs/design/OPEN-ITEMS-RESOLVED.md` §1 declared closed. `Audit` is now
 *    branded too, so the structural half of that residue is gone — a caller
 *    cannot hand-build a witness. What remains is behavioural: a genuine
 *    `Audit` over a `TraceStore` that persists nothing still acknowledges
 *    writes, and only replay catches that.
 */
export interface Recorder {
  readonly correlationId: CorrelationId;
  record(
    payload: NodePayload,
    tier: RiskTier,
    parent?: NodeId,
    telemetry?: NodeTelemetry,
  ): Promise<RecordedNode>;
  /**
   * Prove that the witness persisted `node`, by replaying the case and finding
   * it. Called once per case per process, on the **opened** node, before any
   * detector runs.
   *
   * Returns how the proof was obtained, which is stamped onto the settled node
   * so a reader in 2033 learns the strength of the evidence from the evidence.
   */
  proveWrite(node: RecordedNode): Promise<WitnessProofKind>;
  /** Seed the index with a node this process recorded under another recorder. */
  index(node: RecordedNode): void;
}

export type WitnessProofKind = "replay" | "proven-earlier-in-process";

/**
 * Which cases have had their witness proven, bounded.
 *
 * Bounded on purpose: an unbounded set of correlation identifiers is a leak in a
 * long-running process, and evicting one costs a single extra replay rather than
 * a wrong answer. Held by `createGuardrails`, so the proof is per constructed
 * `Guardrails` and does not leak across composition roots.
 */
export interface WitnessLedger {
  proven(correlationId: CorrelationId): boolean;
  mark(correlationId: CorrelationId): void;
}

export const witnessLedger = (max = 1_024): WitnessLedger => {
  const seen = new Map<CorrelationId, true>();
  return {
    proven: (correlationId) => seen.has(correlationId),
    mark(correlationId) {
      if (seen.has(correlationId)) return;
      seen.set(correlationId, true);
      while (seen.size > max) {
        const oldest = seen.keys().next();
        if (oldest.done === true) break;
        seen.delete(oldest.value);
      }
    },
  };
};

export const recorderFor = async (
  audit: Audit,
  correlationId: CorrelationId,
  ledger: WitnessLedger,
): Promise<Recorder> => {
  const trace = await audit.open(correlationId);
  const index = new Map<NodeId, RecordedNode>();
  const sequences = new Set<number>();
  let hydrated = false;

  const hydrate = async (): Promise<void> => {
    if (hydrated) return;
    const replayed = await audit.replay(correlationId);
    for (const node of replayed.nodes) index.set(node.id, node);
    hydrated = true;
  };

  return {
    correlationId,

    index(node) {
      index.set(node.id, node);
    },

    async record(payload, tier, parent, telemetry) {
      let parentNode: RecordedNode | undefined;
      if (parent !== undefined) {
        parentNode = index.get(parent);
        if (parentNode === undefined) {
          await hydrate();
          parentNode = index.get(parent);
        }
        if (parentNode === undefined) {
          throw new ScreeningParentUnknown(correlationId, parent, payload.kind);
        }
      }
      const options =
        parentNode === undefined
          ? telemetry === undefined
            ? { tier }
            : { tier, telemetry }
          : telemetry === undefined
            ? { tier, parent: parentNode }
            : { tier, parent: parentNode, telemetry };
      const result = await trace.record(payload, options);
      if (!result.recorded) {
        throw new ScreeningNotRecorded(correlationId, payload.kind, result.reason);
      }
      checkAcknowledgement(correlationId, payload, tier, parent, result.node, sequences);
      index.set(result.node.id, result.node);
      return result.node;
    },

    /**
     * **Replay is the proof of a write** — `audit`'s own words, in its
     * `index.ts`: a store that forms a node correctly and discards it is
     * indistinguishable from one that writes it, until you replay.
     *
     * So the opened node of a case is replayed and matched before any detector
     * runs. A witness that acknowledges and persists nothing fails here, with no
     * detector having been asked to search and no `Screening` minted.
     *
     * **Bounded, and where the bound is.** One replay per case per process, not
     * one per screening: a replay is linear in the nodes already recorded, and a
     * read on the hot path that grows with the case is exactly the unbounded
     * thing this module forbids. The second screening on a case therefore
     * records `witnessProof: "proven-earlier-in-process"` and reads nothing.
     *
     * **What this does not prove, stated rather than implied.** It proves the
     * witness returns a coherent trace containing the node it acknowledged. A
     * witness that maintains a coherent in-memory trace and never writes a byte
     * still passes, exactly as `audit` says of its own store contract check.
     *
     * `Audit` now carries a brand minted only by `createAudit`, which this
     * comment once named as the airtight fix and reported upward. It landed,
     * and it is narrower than that sentence promised: it rules out a *forged*
     * witness, not a *forgetful* one. `createAudit` over `inMemoryTraceStore`
     * is branded, legitimate, and persists nothing past the process — which is
     * the right call for a library that must not decide where evidence lives,
     * and exactly why this replay stays.
     */
    async proveWrite(node) {
      if (ledger.proven(correlationId)) return "proven-earlier-in-process";
      const replayed = await audit.replay(correlationId);
      const found = replayed.nodes.find((n) => n.id === node.id);
      if (found === undefined) {
        throw new AuditWitnessUnsound(
          correlationId,
          `the witness acknowledged node ${node.id} and replay does not contain it`,
        );
      }
      if (
        found.correlationId !== correlationId ||
        found.sequence !== node.sequence ||
        found.canonical !== node.canonical ||
        found.payload.kind !== node.payload.kind ||
        found.payload.v !== node.payload.v
      ) {
        throw new AuditWitnessUnsound(
          correlationId,
          `the witness replayed node ${node.id} as something other than what it acknowledged`,
        );
      }
      // The replay is already in hand; index it rather than reading twice.
      for (const n of replayed.nodes) index.set(n.id, n);
      hydrated = true;
      ledger.mark(correlationId);
      return "replay";
    },
  };
};

/**
 * Cheap structural checks on every acknowledgement.
 *
 * `audit`'s `createAudit` checks its **store's** acknowledgements against the
 * same kind of contract. This is the same check one layer up, because the
 * witness this module is handed may not be `createAudit` at all.
 *
 * Note what is *not* checked: that sequences increase. Detector nodes are
 * written from a bounded fan-out, so acknowledgements legitimately arrive out of
 * order within one screening, and other writers on the same case interleave.
 * Uniqueness is the invariant a store owes; monotonicity is not.
 */
const checkAcknowledgement = (
  correlationId: CorrelationId,
  payload: NodePayload,
  tier: RiskTier,
  parent: NodeId | undefined,
  node: RecordedNode,
  sequences: Set<number>,
): void => {
  const unsound = (why: string): never => {
    throw new AuditWitnessUnsound(correlationId, why);
  };
  if (typeof node.id !== "string" || node.id.length === 0) unsound("acknowledged a node with no identity");
  if (node.correlationId !== correlationId) {
    unsound(`acknowledged node ${node.id} against case ${node.correlationId}`);
  }
  if (!Number.isSafeInteger(node.sequence) || node.sequence < 0) {
    unsound(`acknowledged node ${node.id} with sequence ${String(node.sequence)}`);
  }
  if (sequences.has(node.sequence)) {
    unsound(`acknowledged sequence ${node.sequence} twice; the store assigns it once`);
  }
  sequences.add(node.sequence);
  if (node.tier !== tier) unsound(`acknowledged node ${node.id} at tier ${node.tier}, not ${tier}`);
  if (node.payload.kind !== payload.kind || node.payload.v !== payload.v) {
    unsound(`acknowledged node ${node.id} carrying a payload this module did not send`);
  }
  if (node.payloadSchemaVersion !== payload.v) {
    unsound(`acknowledged node ${node.id} stamped with payload version ${node.payloadSchemaVersion}`);
  }
  if (parent !== undefined && node.parent !== parent) {
    unsound(`acknowledged node ${node.id} under parent ${String(node.parent)}, not ${parent}`);
  }
  if (parent === undefined && node.parent !== undefined) {
    unsound(`acknowledged node ${node.id} under a parent this module did not name`);
  }
};
