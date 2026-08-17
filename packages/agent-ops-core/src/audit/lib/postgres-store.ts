import { canonicalNodeForm, canonicalPayloadForm, decodeNode } from "./canonical.js";
import {
  AuditError,
  CaseAlreadyClosed,
  ParentNotOfThisCase,
  ProvenanceConflict,
  ReservedNodeKind,
  StoreContractViolated,
  TraceCorrupt,
  TraceTampered,
  TraceUnavailable,
} from "./errors.js";
import { assertSameAppend, assertUsableKey } from "./idempotency.js";
import {
  SEAL_REDACTION,
  SEAL_TIER,
  isReservedKind,
  isSealNode,
  sealPayload,
} from "./seal.js";
import type { SqlExecutor, SqlRow } from "./sql.js";
import type {
  AppendAck,
  AppendInput,
  CorrelationId,
  NodeId,
  NodePayload,
  NodeTelemetry,
  RecordedNode,
  RedactionId,
  RiskTier,
  StoredCase,
  TracePage,
  TracePageRequest,
  TraceProvenance,
  TraceStore,
  UnassistedContainment,
} from "./types.js";
import { asTraceStore } from "./types.js";

/**
 * Postgres trace store — the second real adapter of the `TraceStore` seam, and
 * the one that carries the seven-year retention.
 *
 * ## No database driver is imported here, deliberately
 *
 * The module takes an injected `SqlExecutor`. It does not `require("pg")`, does
 * not read a connection string and does not open a socket, which means two
 * things at once:
 *
 *   - **Hermetic tests stay structural.** There is no code path in this package
 *     — shipped *or test* — that can reach a network, so a test cannot reach a
 *     live database even with real credentials in the environment. That
 *     guarantee comes from the absence of a driver, never from a flag or an
 *     `if (process.env.CI)`. A previous release qualified this sentence with
 *     "shipped" and then kept a test that read two environment variables,
 *     dynamically imported a driver and opened a pool at collection time. That
 *     test is gone; C3 says dependency injection, not convention, and an
 *     environment variable is convention with a longer name.
 *   - **Nineteen applications do not inherit a dependency.** Each composition
 *     root already has a pool. `SqlExecutor` is shaped so that wiring `pg`'s
 *     `Pool` to it is about fifteen lines, and an application on a different
 *     driver is not blocked.
 *
 * ## The bytes are the record; the columns are the index
 *
 * `rowToNode` reconstructs each node from `node_canonical` and then proves the
 * indexed columns agree with what the bytes decode to. That is the inversion of
 * what a previous release did — reconstruct from columns, recompute the bytes,
 * hope they match — and it has three consequences worth stating:
 *
 *   1. `index.ts` claims a 2033 reader needs only the envelope version, the
 *      payload version and the bytes. This is the code that makes it true.
 *   2. A new envelope field reaches a reader without a migration per field.
 *   3. Tamper detection is unchanged in strength and clearer in direction: an
 *      edit to either side raises `TraceTampered`, because the two sides are
 *      compared rather than one being derived from the other.
 *
 * ## Ordering under concurrent writers
 *
 * Every write takes a per-case transaction-scoped advisory lock before reading
 * `MAX(sequence)`. Without it, two concurrent writers under READ COMMITTED both
 * read the same maximum and one insert loses to the primary key — a retry loop
 * where a lock costs one round trip. The lock is keyed by correlation
 * identifier, so writers to different cases never contend.
 *
 * ## Bounded retries: zero. Bounded concurrency: `maxPendingWrites`
 *
 * This adapter never retries. A failed append raises `TraceUnavailable`
 * immediately and the tiered fail policy in `audit` decides what happens next.
 *
 * It also refuses to hold more than `maxPendingWrites` writes in flight. Each
 * append holds a per-case advisory lock *and* a pool connection for the length
 * of its transaction, so N concurrent writers to one hot case queue on
 * connections. Without a ceiling the queue is the pool's, the pool's queue is
 * unbounded in most drivers, and nothing sheds — the backlog surfaces as
 * latency until the process dies with the trace still in it. Over the ceiling,
 * writes are shed with `TraceUnavailable("backpressure")`, which is the reason
 * `types.ts` documents that value.
 *
 * Reads are deliberately **not** shed: a read cannot corrupt anything, replay
 * is an operator action rather than a hot path, and refusing an auditor is a
 * worse failure than a slow answer.
 *
 * ## Append-only, in the schema and in the grants
 *
 * See `migrations/0002_audit_trace.sql`. Both tables are INSERT-only: the
 * writer role is granted `SELECT, INSERT` and nothing else, a trigger raises on
 * `UPDATE`/`DELETE`, closure is the existence of a seal row rather than a
 * mutable flag, and a partial unique index makes a second close impossible even
 * from a `psql` prompt. Eval nodes go to a **separate** store with its own
 * grants and its own retention, per `OPEN-ITEMS-RESOLVED.md` item 4, so nothing
 * ever needs a `DELETE` grant on these tables.
 *
 * What the grants do *not* stop, and the seal does: an ordinary INSERT after
 * the seal row. The partial unique index blocks a second `is_seal` row only.
 * Replay's seal check is what catches it.
 */

export interface PostgresStoreLimits {
  /** Ceiling on nodes in one case. A runaway retry loop is a bug, not a trace. */
  readonly maxNodesPerCase: number;
  /**
   * Ceiling on writes in flight against this store. Over it, writes are shed
   * with `backpressure` rather than queued behind pool connections.
   */
  readonly maxPendingWrites: number;
}

/**
 * `maxNodesPerCase` matches the in-memory adapter deliberately. Sealing reads
 * every node of the case and hashes it inside the close transaction, under the
 * per-case lock, so the ceiling is also the cost of a close — a million rows
 * was a million hashes with the case locked.
 */
const DEFAULT_LIMITS: PostgresStoreLimits = {
  maxNodesPerCase: 100_000,
  maxPendingWrites: 64,
};

const CASE = "agent_ops.audit_trace_case";
const NODE = "agent_ops.audit_trace_node";

/**
 * Statements are tagged so they are identifiable in `pg_stat_statements` and in
 * a test that asserts what this adapter is allowed to issue.
 */
const SQL = {
  openCase: `-- audit:open-case
INSERT INTO ${CASE}
  (correlation_id, captured_via, canonical_form, redaction, opened_at_ms)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (correlation_id) DO NOTHING`,

  lock: `-- audit:lock
SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,

  nextSequence: `-- audit:next-sequence
SELECT COALESCE(MAX(sequence) + 1, 0)::int AS next_sequence,
       COALESCE(bool_or(is_seal), false) AS sealed
FROM ${NODE}
WHERE correlation_id = $1`,

  append: `-- audit:append
INSERT INTO ${NODE}
  (correlation_id, sequence, node_id, at_ms, tier, parent_sequence,
   payload_schema_version, redaction, kind, payload_canonical, node_canonical,
   is_seal, idempotency_key)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,

  /**
   * The deduplication lookup. Run under the per-case advisory lock, so it and
   * the insert that may follow it are one critical section — a lookup outside
   * the lock is a race, not a check, and two concurrent retries would both miss
   * and both append.
   *
   * It is an index-only probe of `audit_trace_node_idempotency`, the partial
   * unique index from `migrations/0007_audit_idempotency.sql`, so a case with a
   * hundred thousand keyless nodes costs nothing here.
   */
  readByIdempotencyKey: `-- audit:read-by-idempotency-key
SELECT sequence, node_id, at_ms, tier, parent_sequence,
       payload_schema_version, redaction, kind, payload_canonical, node_canonical, is_seal
FROM ${NODE}
WHERE correlation_id = $1 AND idempotency_key = $2`,

  readCase: `-- audit:read-case
SELECT captured_via, canonical_form, redaction, opened_at_ms
FROM ${CASE}
WHERE correlation_id = $1`,

  /**
   * Bounded. The limit is `maxNodesPerCase + 1` so an over-full case is
   * detected rather than silently truncated into a trace with a hole in it.
   */
  readNodes: `-- audit:read-nodes
SELECT sequence, node_id, at_ms, tier, parent_sequence,
       payload_schema_version, redaction, kind, payload_canonical, node_canonical, is_seal
FROM ${NODE}
WHERE correlation_id = $1
ORDER BY sequence
LIMIT $2`,

  /**
   * One page. `sequence > $2` is an index range scan on the primary key, so the
   * cost of the nth page does not grow with n — which `OFFSET` would, and which
   * is why the cursor is a sequence rather than an offset. `LIMIT $3` is fetched
   * as `limit + 1` by the caller so `more` is a fact rather than an inference
   * from a full page.
   */
  readPage: `-- audit:read-page
SELECT sequence, node_id, at_ms, tier, parent_sequence,
       payload_schema_version, redaction, kind, payload_canonical, node_canonical, is_seal
FROM ${NODE}
WHERE correlation_id = $1 AND sequence > $2
ORDER BY sequence
LIMIT $3`,
} as const;

/** `bigint` arrives as a string from most drivers. Both shapes are accepted. */
const asInteger = (
  value: unknown,
  column: string,
  correlationId: CorrelationId,
): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new TraceCorrupt(
      correlationId,
      `column ${column} is not a safe integer: ${String(value)}`,
    );
  }
  return parsed;
};

const asString = (
  value: unknown,
  column: string,
  correlationId: CorrelationId,
): string => {
  if (typeof value !== "string") {
    throw new TraceCorrupt(correlationId, `column ${column} is not text`);
  }
  return value;
};

/**
 * A node identifier is `${correlationId}#${sequence}`. Splitting on the **last**
 * `#` and checking the prefix is what keeps a correlation identifier containing
 * `#` from being mis-parsed, and what stops a parent from another case being
 * rebound to a local sequence — the defect that used to write
 * `parent_sequence = 0` against case B while the canonical bytes named case A,
 * bricking the row forever on a table with no UPDATE grant.
 */
const parentSequenceOf = (parent: NodeId, correlationId: CorrelationId): number => {
  const id = String(parent);
  const prefix = `${String(correlationId)}#`;
  if (!id.startsWith(prefix)) {
    throw new ParentNotOfThisCase(correlationId, id);
  }
  const tail = id.slice(prefix.length);
  const sequence = Number(tail);
  if (!/^\d+$/.test(tail) || !Number.isSafeInteger(sequence)) {
    throw new ParentNotOfThisCase(correlationId, id);
  }
  return sequence;
};

/**
 * Rebuild a node from its own bytes, then prove every indexed column agrees
 * with it. A disagreement in either direction is a row edited in place.
 */
const rowToNode = (row: SqlRow, correlationId: CorrelationId): RecordedNode => {
  const node = decodeNode(
    asString(row["node_canonical"], "node_canonical", correlationId),
    correlationId,
  );

  /** Bytes on one side, indexed column on the other. Either edit is tampering. */
  const agree = (fromBytes: unknown, fromColumn: unknown): void => {
    if (fromBytes !== fromColumn) {
      throw new TraceTampered(correlationId, node.sequence);
    }
  };

  if (node.correlationId !== correlationId) {
    throw new TraceTampered(correlationId, node.sequence);
  }
  agree(
    node.sequence, asInteger(row["sequence"], "sequence", correlationId));
  agree(
    String(node.id), asString(row["node_id"], "node_id", correlationId));
  agree(
    node.at, asInteger(row["at_ms"], "at_ms", correlationId));
  agree(
    node.tier, asString(row["tier"], "tier", correlationId));
  agree(
    node.payloadSchemaVersion,
    asInteger(row["payload_schema_version"], "payload_schema_version", correlationId),
  );
  agree(
    String(node.redaction),
    asString(row["redaction"], "redaction", correlationId),
  );
  agree(
    node.payload.kind, asString(row["kind"], "kind", correlationId));
  agree(
    canonicalPayloadForm(node.payload),
    asString(row["payload_canonical"], "payload_canonical", correlationId),
  );
  agree(
    isSealNode(node), row["is_seal"] === true);

  const parentColumn = row["parent_sequence"];
  const parentFromColumn =
    parentColumn === null || parentColumn === undefined
      ? undefined
      : (`${String(correlationId)}#${asInteger(parentColumn, "parent_sequence", correlationId)}` as NodeId);
  agree(
    node.parent, parentFromColumn);

  return node;
};

/**
 * SQLSTATE classes this adapter refuses to call an outage.
 *
 * Class 22 is a data exception, class 23 an integrity constraint violation,
 * class 42 a syntax or access-rule violation. Every one of them means the
 * writer asked for something impossible or the schema has drifted — a defect,
 * not a connection reset. Reporting them as `TraceUnavailable` let a
 * foreign-key violation be degraded into a silently missing node at low tier,
 * which is exactly the failure mode `errors.ts` now inverts.
 */
const DEFECT_CLASSES = new Set(["22", "23", "42"]);

const sqlState = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

export const postgresTraceStore = (
  sql: SqlExecutor,
  limits: Partial<PostgresStoreLimits> = {},
): TraceStore => {
  const { maxNodesPerCase, maxPendingWrites } = { ...DEFAULT_LIMITS, ...limits };
  let inFlightWrites = 0;

  /**
   * Classify, never swallow. Our own named errors pass through; a constraint or
   * data-type violation becomes `StoreContractViolated`, which is never
   * degradable; everything else becomes `TraceUnavailable("store-failure")`,
   * which is — because a connection reset and a full disk are the same fact to
   * a caller: the trace did not take the write.
   */
  const asStoreError = (error: unknown, correlationId: CorrelationId): never => {
    if (error instanceof AuditError) throw error;
    const state = sqlState(error);
    if (state !== undefined && DEFECT_CLASSES.has(state.slice(0, 2))) {
      throw new StoreContractViolated(
        correlationId,
        `database refused the statement (SQLSTATE ${state})`,
        { cause: error },
      );
    }
    throw new TraceUnavailable("store-failure", correlationId, { cause: error });
  };

  const bounded = async <T>(
    correlationId: CorrelationId,
    body: () => Promise<T>,
  ): Promise<T> => {
    if (inFlightWrites >= maxPendingWrites) {
      throw new TraceUnavailable("backpressure", correlationId);
    }
    inFlightWrites += 1;
    try {
      return await body();
    } finally {
      inFlightWrites -= 1;
    }
  };

  const insertNode = async (
    tx: SqlExecutor,
    correlationId: CorrelationId,
    sequence: number,
    at: number,
    tier: RiskTier,
    payload: NodePayload,
    redaction: RedactionId,
    parent: NodeId | undefined,
    telemetry: NodeTelemetry | undefined,
    idempotencyKey: string | undefined,
  ): Promise<RecordedNode> => {
    const skeleton = {
      id: `${correlationId}#${sequence}` as NodeId,
      correlationId,
      sequence,
      at,
      tier,
      ...(parent === undefined ? {} : { parent }),
      payloadSchemaVersion: payload.v,
      redaction,
      payload,
      ...(telemetry === undefined ? {} : { telemetry }),
    };
    const node: RecordedNode = {
      ...skeleton,
      canonical: canonicalNodeForm(skeleton),
    };

    // The parent is stored as a sequence rather than a string identifier so the
    // schema's own foreign key and `parent_sequence < sequence` check enforce
    // "a parent is a node of this case that already exists". The database can
    // enforce the DAG; it cannot enforce that the edge means what the writer
    // meant, which is why the correlation half is checked here first rather
    // than discarded.
    const parentSequence =
      parent === undefined ? null : parentSequenceOf(parent, correlationId);

    await tx.query(SQL.append, [
      correlationId,
      sequence,
      node.id,
      at,
      tier,
      parentSequence,
      node.payloadSchemaVersion,
      redaction,
      payload.kind,
      canonicalPayloadForm(payload),
      node.canonical,
      isSealNode(node),
      // NULL rather than an empty string where there is no key: the partial
      // unique index covers `idempotency_key IS NOT NULL` only, so a keyless
      // node is not in the index at all and collides with nothing.
      idempotencyKey ?? null,
    ]);

    return node;
  };

  /**
   * The per-case advisory lock, taken on its own.
   *
   * Split out from `claimSequence` because the idempotency lookup must happen
   * under the same lock as the insert that may follow it, and **before** the
   * closure check: a retry of an append that already succeeded must return the
   * first node even if the case has since been sealed. Raising
   * `CaseAlreadyClosed` there would refuse work that is already done and already
   * in the trace, and would put this adapter at odds with the in-memory one.
   */
  const lockCase = async (
    tx: SqlExecutor,
    correlationId: CorrelationId,
  ): Promise<void> => {
    await tx.query(SQL.lock, [correlationId]);
  };

  /** Callers take `lockCase` first. Split so the lock is taken exactly once. */
  const claimSequence = async (
    tx: SqlExecutor,
    correlationId: CorrelationId,
  ): Promise<number> => {
    const { rows } = await tx.query(SQL.nextSequence, [correlationId]);
    const row = rows[0];
    if (row === undefined) {
      throw new TraceUnavailable("store-failure", correlationId);
    }
    if (row["sealed"] === true) throw new CaseAlreadyClosed(correlationId);
    const next = asInteger(row["next_sequence"], "next_sequence", correlationId);
    if (next >= maxNodesPerCase) {
      throw new TraceUnavailable("capacity", correlationId);
    }
    return next;
  };

  /**
   * The node already written under this key on this case, if any.
   *
   * At most one row: the partial unique index makes a second impossible. A
   * second row here would mean the index is missing — migration 0007 not
   * applied — and that is reported as a broken contract rather than silently
   * picking one, because "the deduplication index is not there" and "your retry
   * was deduplicated" must never be the same answer.
   */
  const readByIdempotencyKey = async (
    tx: SqlExecutor,
    correlationId: CorrelationId,
    key: string,
  ): Promise<RecordedNode | undefined> => {
    const { rows } = await tx.query(SQL.readByIdempotencyKey, [correlationId, key]);
    if (rows.length === 0) return undefined;
    if (rows.length > 1) {
      throw new StoreContractViolated(
        correlationId,
        `idempotency key matched ${rows.length} nodes, so the partial unique index from migrations/0007_audit_idempotency.sql is not in place`,
      );
    }
    return rowToNode(rows[0] as SqlRow, correlationId);
  };

  const readNodes = async (
    tx: SqlExecutor,
    correlationId: CorrelationId,
  ): Promise<RecordedNode[]> => {
    const { rows } = await tx.query(SQL.readNodes, [correlationId, maxNodesPerCase + 1]);
    if (rows.length > maxNodesPerCase) {
      throw new TraceUnavailable("capacity", correlationId);
    }
    return rows.map((row) => rowToNode(row, correlationId));
  };

  const readProvenance = async (
    tx: SqlExecutor,
    correlationId: CorrelationId,
  ): Promise<TraceProvenance | undefined> => {
    const { rows } = await tx.query(SQL.readCase, [correlationId]);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      capturedVia: asString(
        row["captured_via"],
        "captured_via",
        correlationId,
      ) as TraceProvenance["capturedVia"],
      canonicalForm: asString(row["canonical_form"], "canonical_form", correlationId),
      redaction: asString(row["redaction"], "redaction", correlationId) as RedactionId,
      openedAt: asInteger(row["opened_at_ms"], "opened_at_ms", correlationId),
    };
  };

  return asTraceStore({
    async openCase(correlationId: CorrelationId, provenance: TraceProvenance) {
      try {
        await sql.transaction(async (tx) => {
          await tx.query(SQL.openCase, [
            correlationId,
            provenance.capturedVia,
            provenance.canonicalForm,
            provenance.redaction,
            provenance.openedAt,
          ]);
          // `ON CONFLICT DO NOTHING` makes reopening a no-op, which used to mean
          // a redactor change between deploys left the case row asserting
          // something false about every node written afterwards. Read it back
          // and refuse the contradiction instead.
          const recorded = await readProvenance(tx, correlationId);
          if (recorded === undefined) return;
          if (recorded.redaction !== provenance.redaction) {
            throw new ProvenanceConflict(
              correlationId,
              "redaction",
              String(recorded.redaction),
              String(provenance.redaction),
            );
          }
          if (recorded.capturedVia !== provenance.capturedVia) {
            throw new ProvenanceConflict(
              correlationId,
              "capturedVia",
              recorded.capturedVia,
              provenance.capturedVia,
            );
          }
        });
      } catch (error) {
        asStoreError(error, correlationId);
      }
    },

    async append(input: AppendInput): Promise<AppendAck> {
      if (isReservedKind(input.payload.kind)) {
        // Invariant 6. `is_seal` is written from this string, so an unreserved
        // kind let a caller set the column and brick the case at its first node.
        throw new ReservedNodeKind(input.correlationId, input.payload.kind);
      }
      if (input.parent !== undefined) {
        parentSequenceOf(input.parent, input.correlationId);
      }
      assertUsableKey(input.correlationId, input.idempotencyKey);
      return bounded(input.correlationId, async () => {
        try {
          return await sql.transaction(async (tx) => {
            // The lock first, then the deduplication lookup, then the sequence.
            // All three inside one transaction, which is what makes eight
            // concurrent retries of one crashed append produce one node: the
            // seven that lose the lock find the winner's row when they get it.
            await lockCase(tx, input.correlationId);

            const key = input.idempotencyKey;
            if (key !== undefined) {
              const already = await readByIdempotencyKey(tx, input.correlationId, key);
              if (already !== undefined) {
                assertSameAppend(already, input, key);
                return { node: already, deduplicated: true };
              }
            }

            const sequence = await claimSequence(tx, input.correlationId);
            const node = await insertNode(
              tx,
              input.correlationId,
              sequence,
              input.at,
              input.tier,
              input.payload,
              input.redaction,
              input.parent,
              input.telemetry,
              key,
            );
            return { node, deduplicated: false };
          });
        } catch (error) {
          return asStoreError(error, input.correlationId);
        }
      });
    },

    async closeCase(
      correlationId: CorrelationId,
      at: number,
      outcome: UnassistedContainment,
    ) {
      return bounded(correlationId, async () => {
        try {
          return await sql.transaction(async (tx) => {
            // Seal and close in one transaction under the same advisory lock, so
            // no node can land between computing the digest and writing it. A
            // seal that attests to a trace which is not the trace is worse than
            // no seal at all.
            await lockCase(tx, correlationId);
            const sequence = await claimSequence(tx, correlationId);
            const existing = await readNodes(tx, correlationId);
            const provenance = await readProvenance(tx, correlationId);
            if (provenance === undefined) {
              throw new TraceUnavailable("store-failure", correlationId);
            }

            return insertNode(
              tx,
              correlationId,
              sequence,
              at,
              SEAL_TIER,
              sealPayload(outcome, existing, provenance),
              SEAL_REDACTION,
              undefined,
              undefined,
              // A seal never carries an idempotency key. Closing twice is
              // refused by the one-seal partial unique index and by the sealed
              // check above; making it idempotent instead would let a second
              // close report success for a seal it did not write.
              undefined,
            );
          });
        } catch (error) {
          return asStoreError(error, correlationId);
        }
      });
    },

    async read(correlationId: CorrelationId): Promise<StoredCase | undefined> {
      try {
        return await sql.transaction(async (tx) => {
          const provenance = await readProvenance(tx, correlationId);
          if (provenance === undefined) return undefined;
          return { provenance, nodes: await readNodes(tx, correlationId) };
        });
      } catch (error) {
        return asStoreError(error, correlationId);
      }
    },

    /**
     * One bounded window.
     *
     * Each page is its own transaction rather than one long-lived snapshot
     * across the whole walk, and that is a deliberate trade with a real cost on
     * each side. A repeatable-read snapshot held over 100 pages would pin a
     * connection and hold back vacuum for the length of an operator's walk; a
     * page-per-transaction walk can, in principle, see nodes appended to an
     * *open* case between pages. The second is harmless here and the first is
     * not, because the case being walked at the node ceiling is overwhelmingly a
     * closed one — nothing can be appended to a sealed case at all — and a walk
     * that observes a live case growing observes exactly what happened.
     *
     * The provenance read is inside the same transaction as the node read, so a
     * page's scope statement and its nodes are from one instant.
     */
    async readPage(request: TracePageRequest): Promise<TracePage | undefined> {
      const { correlationId } = request;
      const limit = Math.max(request.limit, 0);
      try {
        return await sql.transaction(async (tx) => {
          const provenance = await readProvenance(tx, correlationId);
          if (provenance === undefined) return undefined;

          // `limit + 1` rows, so "is there more" is answered by the database
          // rather than guessed from a full page.
          const { rows } = await tx.query(SQL.readPage, [
            correlationId,
            request.afterSequence ?? -1,
            limit + 1,
          ]);
          const more = rows.length > limit;
          const page = more ? rows.slice(0, limit) : rows;
          return {
            provenance,
            nodes: page.map((row) => rowToNode(row, correlationId)),
            more,
          };
        });
      } catch (error) {
        return asStoreError(error, correlationId);
      }
    },
  });
};
