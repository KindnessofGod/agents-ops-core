import { canonicalNodeForm } from "./canonical.js";
import {
  CaseAlreadyClosed,
  ParentNotOfThisCase,
  ProvenanceConflict,
  ReservedNodeKind,
  TraceUnavailable,
} from "./errors.js";
import { assertSameAppend, assertUsableKey } from "./idempotency.js";
import { SEAL_REDACTION, SEAL_TIER, isReservedKind, sealPayload } from "./seal.js";
import { closedCaseDigest } from "./witness.js";
import type {
  AppendAck,
  AppendInput,
  CorrelationId,
  ExpiredCase,
  NodeId,
  NodeTelemetry,
  RecordedNode,
  RetentionPage,
  RetentionQuery,
  RetentionRegister,
  StoredCase,
  TracePage,
  TracePageRequest,
  TraceProvenance,
  TraceStore,
  UnassistedContainment,
} from "./types.js";
import { asTraceStore } from "./types.js";

/**
 * In-memory trace store.
 *
 * A shipped deliverable, not a test mock. It is the second adapter that makes
 * `TraceStore` a real seam rather than a hypothetical one, and it is what lets
 * a test be unable to reach a network even with live credentials present in the
 * environment: there is no socket in this file to reach one with.
 *
 * ## What "the same invariants as the Postgres adapter" means here
 *
 * It means the six listed on `TraceStore`, and it means them *identically* —
 * which is the correction. A previous release claimed parity and did not have
 * it: a parent from another case orphaned here and bricked there, and a
 * caller-authored `case.closed` produced three seal nodes and a false `closed`
 * here while refusing every subsequent write there. Same call, two different
 * disasters, is worse than either. Both adapters now refuse both calls, with
 * the same named errors, and the tests exercise them through the same
 * interface.
 *
 * ## Bounded in both directions, and this time in both
 *
 * Nodes per case are bounded, writes in flight are bounded, and **cases are
 * bounded**. The last one was the missing half: 200,000 opened-and-closed cases
 * retained 281MB with no ceiling, no eviction and no expiry, in a process the
 * brief says runs for weeks. There is no silent eviction — dropping a case
 * nobody asked to drop is losing evidence — so the ceiling refuses new cases
 * with `TraceUnavailable("capacity")` and `releaseClosed` lets an operator
 * reclaim sealed cases explicitly.
 *
 * This adapter is therefore **not an archive**. It holds a bounded working set;
 * the seven-year retention lives in Postgres.
 */

export interface InMemoryStoreLimits {
  /**
   * Ceiling on nodes in one case. A runaway retry loop is a bug; letting it
   * consume the heap turns one bad case into an outage for every other case in
   * the process.
   */
  readonly maxNodesPerCase: number;
  /**
   * Ceiling on writes queued behind the per-store critical section. Shedding
   * with a named error beats an unbounded queue that hides the backlog until
   * the process dies with the trace still in it.
   */
  readonly maxPendingWrites: number;
  /**
   * Ceiling on cases retained. Reached, `openCase` refuses with `capacity`
   * rather than evicting something — an evicted case is lost evidence, and a
   * store that silently forgets is worse than one that says it is full.
   */
  readonly maxCases: number;
}

const DEFAULT_LIMITS: InMemoryStoreLimits = {
  maxNodesPerCase: 100_000,
  maxPendingWrites: 1_024,
  maxCases: 10_000,
};

/**
 * The in-memory adapter's own interface, wider than `TraceStore` by exactly one
 * verb. `releaseClosed` drops **sealed** cases from this process's working set;
 * it cannot touch a node, cannot touch an open case, and has no counterpart in
 * Postgres because Postgres is the archive and this is not.
 */
export interface InMemoryTraceStore extends TraceStore, RetentionRegister {
  /** How many cases are currently retained. */
  readonly size: number;
  /**
   * Drop up to `max` closed cases, oldest first. Returns how many were dropped.
   * Explicit by design: a long-running process reclaims deliberately rather
   * than discovering an eviction policy it did not choose.
   */
  releaseClosed(max: number): number;
}

interface CaseState {
  readonly provenance: TraceProvenance;
  readonly nodes: RecordedNode[];
  /**
   * Idempotency key to the node written under it, for this case only.
   *
   * Per case rather than per store, matching the partial unique index in
   * `migrations/0007_audit_idempotency.sql`: nineteen applications mint keys in
   * nineteen namespaces, and a store-wide map would let one application's
   * `"attempt-1"` return another application's node from another case. It is
   * bounded by `maxNodesPerCase` for free, because it holds at most one entry
   * per node.
   */
  readonly byIdempotencyKey: Map<string, RecordedNode>;
  /**
   * The sequence of the seal, once one exists. Not a status flag anybody can
   * flip: it is set inside the same critical section that appends the seal, and
   * `case.`-prefixed kinds are refused on the ordinary append path, so the
   * derived answer (`nodes.some(isSealNode)`) and this one cannot disagree.
   */
  sealedAt: number | undefined;
}

export const inMemoryTraceStore = (
  limits: Partial<InMemoryStoreLimits> = {},
): InMemoryTraceStore => {
  const { maxNodesPerCase, maxPendingWrites, maxCases } = {
    ...DEFAULT_LIMITS,
    ...limits,
  };
  const cases = new Map<CorrelationId, CaseState>();

  // A promise-chain mutex. Every write runs to completion before the next one
  // starts, so the sequence a writer reads is the sequence it gets. This is the
  // in-memory equivalent of the Postgres adapter's per-case advisory lock, and
  // it is the reason concurrent appends produce 0..n-1 with no gap and no
  // duplicate rather than n writers all reading length 0.
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  const critical = async <T>(
    correlationId: CorrelationId,
    body: () => T,
  ): Promise<T> => {
    if (pending >= maxPendingWrites) {
      throw new TraceUnavailable("backpressure", correlationId);
    }
    pending += 1;
    const run = tail.then(async () => {
      // A deliberate await point inside the section. It costs a microtask and
      // it means a test that fires fifty concurrent appends genuinely
      // interleaves here — so the mutex is load-bearing in test rather than
      // correctness resting on single-threaded luck.
      await Promise.resolve();
      return body();
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      pending -= 1;
    }
  };

  const requireCase = (correlationId: CorrelationId): CaseState => {
    const state = cases.get(correlationId);
    if (state === undefined) {
      throw new TraceUnavailable("store-failure", correlationId);
    }
    return state;
  };

  const appendNode = (
    state: CaseState,
    correlationId: CorrelationId,
    at: number,
    tier: RecordedNode["tier"],
    payload: RecordedNode["payload"],
    redaction: RecordedNode["redaction"],
    parent: NodeId | undefined,
    telemetry: NodeTelemetry | undefined,
  ): RecordedNode => {
    if (state.sealedAt !== undefined) throw new CaseAlreadyClosed(correlationId);
    if (state.nodes.length >= maxNodesPerCase) {
      throw new TraceUnavailable("capacity", correlationId);
    }
    if (parent !== undefined && !state.nodes.some((n) => n.id === parent)) {
      // Invariant 5, held here and not merely upstream: a parent is a node of
      // *this* case. Rebinding a foreign identifier to whichever local node
      // happens to share a sequence is what bricked a case in the other
      // adapter, and orphaning it silently is what happened in this one.
      throw new ParentNotOfThisCase(correlationId, parent);
    }

    // The store assigns the sequence. A caller-supplied one would be a lie the
    // moment two writers touch the same case.
    const sequence = state.nodes.length;
    const skeleton = {
      // Derived from the store-assigned sequence, so identity is reproducible
      // from the trace itself rather than from a counter nobody can replay.
      id: `${correlationId}#${sequence}` as NodeId,
      correlationId,
      sequence,
      at,
      tier,
      ...(parent === undefined ? {} : { parent }),
      payloadSchemaVersion: payload.v,
      redaction,
      payload: Object.freeze({ ...payload }) as RecordedNode["payload"],
      ...(telemetry === undefined ? {} : { telemetry: Object.freeze({ ...telemetry }) }),
    };
    const node: RecordedNode = Object.freeze({
      ...skeleton,
      canonical: canonicalNodeForm(skeleton),
    });

    state.nodes.push(node);
    return node;
  };

  const store = asTraceStore({
    async openCase(correlationId: CorrelationId, provenance: TraceProvenance) {
      await critical(correlationId, () => {
        const existing = cases.get(correlationId);
        if (existing === undefined) {
          if (cases.size >= maxCases) {
            throw new TraceUnavailable("capacity", correlationId);
          }
          cases.set(correlationId, {
            provenance,
            nodes: [],
            byIdempotencyKey: new Map(),
            sealedAt: undefined,
          });
          return;
        }
        // Reopening is idempotent only on an identical scope statement.
        // `canonicalForm` is deliberately excluded: nodes carry their own
        // envelope, so appending v2 nodes to a case opened under v1 is correct.
        if (existing.provenance.redaction !== provenance.redaction) {
          throw new ProvenanceConflict(
            correlationId,
            "redaction",
            String(existing.provenance.redaction),
            String(provenance.redaction),
          );
        }
        if (existing.provenance.capturedVia !== provenance.capturedVia) {
          throw new ProvenanceConflict(
            correlationId,
            "capturedVia",
            existing.provenance.capturedVia,
            provenance.capturedVia,
          );
        }
      });
    },

    async append(input: AppendInput): Promise<AppendAck> {
      if (isReservedKind(input.payload.kind)) {
        throw new ReservedNodeKind(input.correlationId, input.payload.kind);
      }
      assertUsableKey(input.correlationId, input.idempotencyKey);
      // Invariant 8, and the lookup is **inside** the critical section on
      // purpose. Checking the map before taking the mutex is a race, not a
      // check: eight concurrent retries of one crashed append would all miss,
      // all append, and produce the eight nodes deduplication exists to
      // prevent. This is the in-memory equivalent of the Postgres adapter
      // taking the per-case advisory lock before it looks.
      return critical(input.correlationId, () => {
        const state = requireCase(input.correlationId);
        const key = input.idempotencyKey;
        if (key !== undefined) {
          const already = state.byIdempotencyKey.get(key);
          if (already !== undefined) {
            assertSameAppend(already, input, key);
            return { node: already, deduplicated: true };
          }
        }
        const node = appendNode(
          state,
          input.correlationId,
          input.at,
          input.tier,
          input.payload,
          input.redaction,
          input.parent,
          input.telemetry,
        );
        if (key !== undefined) state.byIdempotencyKey.set(key, node);
        return { node, deduplicated: false };
      });
    },

    async closeCase(
      correlationId: CorrelationId,
      at: number,
      outcome: UnassistedContainment,
    ) {
      // Seal and close inside one critical section. Computing the digest and
      // then closing in two steps would let a node land between them, and the
      // seal would then attest to a trace that is not the trace.
      return critical(correlationId, () => {
        const state = requireCase(correlationId);
        if (state.sealedAt !== undefined) throw new CaseAlreadyClosed(correlationId);
        const seal = appendNode(
          state,
          correlationId,
          at,
          SEAL_TIER,
          sealPayload(outcome, state.nodes, state.provenance),
          SEAL_REDACTION,
          undefined,
          undefined,
        );
        state.sealedAt = seal.sequence;
        return seal;
      });
    },

    async read(correlationId: CorrelationId): Promise<StoredCase | undefined> {
      const state = cases.get(correlationId);
      if (state === undefined) return undefined;
      return { provenance: state.provenance, nodes: [...state.nodes] };
    },

    async readPage(request: TracePageRequest): Promise<TracePage | undefined> {
      const state = cases.get(request.correlationId);
      if (state === undefined) return undefined;

      // Sequences are dense and assigned by position here, so the cursor is an
      // index rather than a scan. That is a property of this adapter, not of
      // the seam: the Postgres adapter uses `sequence > $2` and gets the same
      // answer from an index range scan.
      const from = request.afterSequence === undefined ? 0 : request.afterSequence + 1;
      const limit = Math.max(request.limit, 0);
      const start = Math.min(Math.max(from, 0), state.nodes.length);
      const end = Math.min(start + limit, state.nodes.length);
      return {
        provenance: state.provenance,
        nodes: state.nodes.slice(start, end),
        // Stated, not inferred from `nodes.length === limit`: that inference is
        // wrong exactly when a case ends on a page boundary.
        more: end < state.nodes.length,
      };
    },
  });

  return {
    ...store,
    get size() {
      return cases.size;
    },

    /**
     * The retention register, implemented here rather than in a separate
     * adapter because the data it reads is the data this object already holds.
     *
     * It is the second adapter of `RetentionRegister`, which is what makes that
     * a real seam — and it is a deliverable rather than a convenience: it is
     * what lets an application test its own expiry procedure, including the
     * clearance step, without a database. Note what it still does not do:
     * nothing here removes a case either. `releaseClosed` drops a case from
     * *this process's working set*, which is a different act with a different
     * name, and it exists because this adapter is a working set and not an
     * archive.
     */
    async dueForRemoval(query: RetentionQuery): Promise<RetentionPage> {
      const limit = Math.max(query.limit, 0);
      const after = query.afterCorrelationId;
      const due: ExpiredCase[] = [];

      const ordered = [...cases.entries()].sort(([a], [b]) =>
        String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
      );
      for (const [correlationId, state] of ordered) {
        if (after !== undefined && String(correlationId) <= String(after)) continue;
        if (state.sealedAt === undefined) continue;
        const seal = state.nodes[state.sealedAt];
        if (seal === undefined || seal.at >= query.closedBefore) continue;
        const closed = closedCaseDigest(seal);
        if (closed === undefined) continue;
        // limit + 1 so `more` is stated from a fact rather than inferred from a
        // full page — the inference is wrong exactly on a page boundary.
        if (due.length === limit) return { cases: due, more: true };
        due.push({
          correlationId,
          closedAt: seal.at,
          nodes: closed.nodes,
          digest: closed.digest,
        });
      }
      return { cases: due, more: false };
    },

    releaseClosed(max: number): number {
      let released = 0;
      for (const [correlationId, state] of cases) {
        if (released >= max) break;
        if (state.sealedAt === undefined) continue;
        cases.delete(correlationId);
        released += 1;
      }
      return released;
    },
  };
};
