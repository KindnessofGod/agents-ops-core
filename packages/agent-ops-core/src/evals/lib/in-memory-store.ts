import { EvalStoreUnavailable, LimitOutOfRange, NoSuchRun } from "./errors.js";
import { mintEvalNodeStore } from "./store-brand.js";
import { readStoredNode } from "./upcast.js";
import type {
  AppendEvalNode,
  EvalNode,
  EvalNodeId,
  EvalNodeStore,
  RunId,
  SettleEvalNode,
  StoredEvalRun,
  StoredRunHeader,
} from "./types.js";

/**
 * The in-memory eval node store.
 *
 * A **shipped deliverable, not a mock.** It is what makes hermeticity
 * structural rather than conventional: a test wires this and there is no code
 * path from `run` to a socket or a database handle, credentials in the
 * environment or not. It is also the second adapter that makes `EvalNodeStore` a
 * real seam rather than a hypothetical one.
 *
 * Bounded, like everything else here. `maxNodesPerRun` and `maxRuns` are hard
 * ceilings, and hitting one is `EvalStoreUnavailable` — fail-closed — rather
 * than a heap that grows until the process dies with no evidence of why.
 */
export interface InMemoryStoreLimits {
  readonly maxNodesPerRun: number;
  readonly maxRuns: number;
}

const DEFAULTS: InMemoryStoreLimits = { maxNodesPerRun: 500_000, maxRuns: 256 };

interface RunState {
  readonly header: StoredRunHeader;
  readonly nodes: Map<EvalNodeId, EvalNode>;
  readonly order: EvalNodeId[];
  sequence: number;
}

export const inMemoryEvalNodeStore = (
  limits: Partial<InMemoryStoreLimits> = {},
): EvalNodeStore => {
  const bounds: InMemoryStoreLimits = { ...DEFAULTS, ...limits };
  const runs = new Map<RunId, RunState>();

  const stateOf = (runId: RunId): RunState => {
    const state = runs.get(runId);
    if (state === undefined) throw new NoSuchRun(runId);
    return state;
  };

  return mintEvalNodeStore({
    async openRun(header) {
      if (runs.has(header.runId)) {
        throw new EvalStoreUnavailable("openRun", `run ${header.runId} already open`);
      }
      if (runs.size >= bounds.maxRuns) {
        throw new EvalStoreUnavailable("openRun", `run ceiling ${bounds.maxRuns} reached`);
      }
      runs.set(header.runId, { header, nodes: new Map(), order: [], sequence: 0 });
    },

    async append(input: AppendEvalNode) {
      const state = stateOf(input.runId);
      if (state.order.length >= bounds.maxNodesPerRun) {
        throw new EvalStoreUnavailable(
          "append",
          `node ceiling ${bounds.maxNodesPerRun} reached for run ${input.runId}`,
        );
      }
      // The store assigns identity and sequence, inside the same critical
      // section that writes. A caller-assigned sequence is a caller-assigned lie
      // under concurrency, and concurrency 8 is the default.
      const sequence = state.sequence++;
      const id = `${input.runId}/${String(sequence).padStart(8, "0")}` as EvalNodeId;
      const node: EvalNode = {
        id,
        runId: input.runId,
        sequence,
        parent: input.parent,
        kind: input.kind,
        name: input.name,
        openedAt: input.openedAt,
        closedAt: null,
        elapsedMicros: 0,
        outcome: "ok",
        costTenthCents: 0,
        tokensIn: 0,
        tokensOut: 0,
        priceTableVersion: "",
        payloadSchemaVersion: input.payloadSchemaVersion,
        redaction: input.redaction,
        envelope: input.envelope,
        payload: input.payload,
        canonical: null,
      };
      state.nodes.set(id, node);
      state.order.push(id);
      return node;
    },

    async settle(input: SettleEvalNode) {
      const state = stateOf(input.runId);
      const open = state.nodes.get(input.id);
      if (open === undefined) {
        throw new EvalStoreUnavailable("settle", `unknown node ${input.id}`);
      }
      if (open.closedAt !== null) {
        throw new EvalStoreUnavailable("settle", `node ${input.id} is already settled`);
      }
      const settled: EvalNode = {
        ...open,
        closedAt: input.closedAt,
        elapsedMicros: input.elapsedMicros,
        outcome: input.outcome,
        costTenthCents: input.costTenthCents,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        priceTableVersion: input.priceTableVersion,
        payload: { ...open.payload, ...input.closing },
        canonical: input.canonical,
      };
      state.nodes.set(input.id, settled);
      return settled;
    },

    async read(runId): Promise<StoredEvalRun | undefined> {
      const state = runs.get(runId);
      if (state === undefined) return undefined;
      const nodes: EvalNode[] = [];
      for (const id of state.order) {
        const node = state.nodes.get(id);
        // Decoded through the same reader the SQL adapter uses, so an
        // unreadable envelope is a property of the seam and not of one adapter.
        if (node !== undefined) nodes.push(readStoredNode(node));
      }
      return { header: state.header, nodes };
    },

    async expireBefore(cutoff, batchLimit) {
      if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 10_000) {
        throw new LimitOutOfRange("expireBefore.batchLimit", batchLimit, "1..10000 (integer)");
      }
      // Bounded per call. The caller loops on `runs > 0`; there is no verb here
      // that says "delete everything older than 90 days" in one breath.
      let nodes = 0;
      let removed = 0;
      for (const [runId, state] of runs) {
        if (removed >= batchLimit) break;
        if (state.header.openedAt < cutoff) {
          nodes += state.order.length;
          removed += 1;
          runs.delete(runId);
        }
      }
      return { runs: removed, nodes };
    },
  });
};
