import { CaseAlreadyClosed, NoSuchCase } from "./errors.js";
import type {
  Audit,
  AuditDeps,
  CaseTrace,
  CorrelationId,
  NodeId,
  RecordedNode,
  ReplayedCase,
} from "./types.js";

const replayedCase = (
  correlationId: CorrelationId,
  nodes: readonly RecordedNode[],
): ReplayedCase => ({
  correlationId,
  nodes,
  roots: () => nodes.filter((n) => n.parent === undefined),
  childrenOf: (id: NodeId) => nodes.filter((n) => n.parent === id),
});

/**
 * Every dependency is a parameter. Nothing is constructed in here — no clock,
 * no store, no client — which is what makes hermetic tests structural rather
 * than a convention someone remembers to follow.
 */
export const createAudit = ({ store, clock }: AuditDeps): Audit => ({
  async open(correlationId) {
    await store.openCase(correlationId, clock.now());

    const trace: CaseTrace = {
      correlationId,

      async record(payload, parent) {
        if (await store.isClosed(correlationId)) {
          throw new CaseAlreadyClosed(correlationId);
        }
        return store.append(correlationId, clock.now(), payload, parent?.id);
      },

      async close(outcome) {
        if (await store.isClosed(correlationId)) {
          throw new CaseAlreadyClosed(correlationId);
        }
        await store.closeCase(correlationId, clock.now(), outcome);
      },
    };

    return trace;
  },

  async replay(correlationId) {
    const nodes = await store.read(correlationId);
    // Fail-closed: an absent case throws rather than returning an empty one.
    // "We have no record" must never be able to masquerade as "nothing
    // happened" — those are very different answers to give an auditor.
    if (nodes === undefined) throw new NoSuchCase(correlationId);
    return replayedCase(correlationId, nodes);
  },
});
