import { CaseAlreadyClosed } from "./errors.js";
import type {
  Containment,
  CorrelationId,
  NodeId,
  NodePayload,
  RecordedNode,
  TraceStore,
} from "./types.js";

/**
 * In-memory trace store.
 *
 * A shipped deliverable, not a test mock. It is the second adapter that makes
 * `TraceStore` a real seam rather than a hypothetical one, and it is what lets
 * a test be unable to reach a network even with live credentials present.
 *
 * It holds the same invariants as the Postgres adapter: the store assigns the
 * sequence, nodes are frozen once accepted, and there is no path that mutates
 * or removes one.
 */
export const inMemoryTraceStore = (): TraceStore => {
  const nodes = new Map<CorrelationId, RecordedNode[]>();
  const closed = new Set<CorrelationId>();
  let nodeCounter = 0;

  const requireOpen = (correlationId: CorrelationId): void => {
    if (closed.has(correlationId)) throw new CaseAlreadyClosed(correlationId);
  };

  return {
    async openCase(correlationId) {
      if (!nodes.has(correlationId)) nodes.set(correlationId, []);
    },

    async append(correlationId, at, payload, parent) {
      requireOpen(correlationId);
      const forCase = nodes.get(correlationId) ?? [];
      if (!nodes.has(correlationId)) nodes.set(correlationId, forCase);

      const node: RecordedNode = Object.freeze({
        id: `node_${(nodeCounter += 1)}` as NodeId,
        correlationId,
        // The store assigns the sequence. A caller-supplied one would be a lie
        // the moment two writers touch the same case.
        sequence: forCase.length,
        at,
        ...(parent === undefined ? {} : { parent }),
        payload: Object.freeze({ ...payload }) as NodePayload,
      });

      forCase.push(node);
      return node;
    },

    async closeCase(correlationId, _at, _outcome: Containment) {
      requireOpen(correlationId);
      closed.add(correlationId);
    },

    async isClosed(correlationId) {
      return closed.has(correlationId);
    },

    async read(correlationId) {
      const forCase = nodes.get(correlationId);
      return forCase === undefined ? undefined : [...forCase];
    },
  };
};
