import { EvalStoreUnavailable, LimitOutOfRange } from "./errors.js";
import { mintEvalNodeStore } from "./store-brand.js";
import { readStoredNode } from "./upcast.js";
import type {
  EvalNode,
  EvalNodeId,
  EvalNodeKind,
  EvalNodeStore,
  EvalPayload,
  NodeOutcome,
  RunId,
  SourceDigest,
  SourceKind,
  StoredEvalRun,
  StoredRunHeader,
  SubjectVersion,
  Seed,
} from "./types.js";

/**
 * The SQL eval node store — the second real adapter of the `EvalNodeStore` seam,
 * and the one that carries the 90-day retention.
 *
 * ## This store is allowed to delete. `audit`'s is not.
 *
 * That sentence is the whole reason this file exists rather than reusing
 * `audit`'s `TraceStore`. Eval runs generate on the order of 10M nodes a day
 * across nineteen applications; keeping seven years of records of tests is not a
 * defensible use of a regulated archive. Expiring them needs a `DELETE` grant —
 * and `audit`'s headline invariant is that its writer role holds `SELECT,
 * INSERT` and nothing else, so the append-only guarantee holds even against
 * someone with a psql prompt.
 *
 * A grant that exists is a grant that gets used, so the two stores get two
 * roles, two schemas and two retention regimes. **A trace never spans both.** An
 * eval run that reads recorded production cases *reads* the audit store through
 * `audit`'s own interface and *writes* here.
 *
 * The other consequence, stated because it is a real weakening and not an
 * accident: **eval node graphs are not seven-year evidence.** The reports are;
 * the node-level graph behind them expires. An eval run's evidentiary value
 * decays with the code it evaluated, whereas a case's does not.
 *
 * ## No database driver is imported here, deliberately
 *
 * The adapter takes an injected `SqlExecutor` — structurally the same one
 * `audit`'s Postgres store takes, so an application wires its existing pool once
 * and both modules use it. This module does not `require("pg")`, does not read a
 * connection string and does not open a socket, which is what makes hermetic
 * tests structural: there is no code path in this package that can reach a
 * network, whatever credentials are in the environment.
 *
 * ## Ordering under concurrent writers
 *
 * With concurrency 8, eight case subtrees interleave their writes into one
 * graph. Every append takes a transaction-scoped advisory lock keyed by run
 * before reading `MAX(sequence)`; without it two writers under READ COMMITTED
 * read the same maximum and one insert loses to the primary key. Writers to
 * different runs never contend.
 *
 * ## Bounded retries: zero
 *
 * This adapter never retries. A failed write raises `EvalStoreUnavailable`
 * immediately, which is fail-closed and aborts the run — there is no tier at
 * which an unrecorded eval run is the right answer. "No unbounded retries" is
 * most simply satisfied by having none.
 *
 * ## Required schema
 *
 * `EVAL_STORE_SCHEMA_SQL`, below, is the data definition this adapter requires,
 * shipped **as a value** rather than described in prose. It used to be described
 * in prose, and there was no migration creating `agent_ops.eval_run` or
 * `agent_ops.eval_node` anywhere in the repository — so the second adapter of
 * this seam was unrunnable as shipped and nobody could tell from reading it.
 *
 * It belongs in `migrations/` as `0003_eval_store.sql`, applied by the same
 * migration role that applies the audit tables. Shipping it here as well means
 * the adapter and the schema it assumes cannot drift apart silently: a test in
 * this module asserts that every table and column this file writes appears in
 * that text.
 */

export interface SqlRow {
  readonly [column: string]: unknown;
}

export interface SqlExecutor {
  query(text: string, params: readonly unknown[]): Promise<{ readonly rows: readonly SqlRow[] }>;
  /** Runs `fn` on one connection inside a transaction, rolling back on throw. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface SqlEvalStoreLimits {
  /** Ceiling on nodes in one run. A runaway retry loop is a bug, not a trace. */
  readonly maxNodesPerRun: number;
}

const DEFAULTS: SqlEvalStoreLimits = { maxNodesPerRun: 1_000_000 };

const RUN = "agent_ops.eval_run";
const NODE = "agent_ops.eval_node";

/**
 * The schema this adapter requires, and the grants that make it different from
 * `audit`'s. Copy into `migrations/0003_eval_store.sql`.
 *
 * Read the grants against `0002_audit_trace.sql` side by side. That file gives
 * its writer `SELECT, INSERT` and nothing else, and adds triggers that raise on
 * `UPDATE` and `DELETE`, so append-only holds against someone with a psql
 * prompt. This file gives its writer `UPDATE` — to settle an open node — and
 * `DELETE`, for the 90-day retention. Those grants are why these tables are in
 * their own role rather than sharing audit's: a grant that exists is a grant
 * that gets used, and 10M rows a day of records of tests is not a defensible
 * use of a regulated archive.
 *
 * The consequence, stated because it is a real weakening: **eval node graphs are
 * not seven-year evidence.** The reports are; the graph behind them expires.
 */
export const EVAL_STORE_SCHEMA_SQL = `-- 0003_eval_store.sql
-- The eval node store. A SEPARATE physical store from the audit trace, per
-- docs/design/OPEN-ITEMS-RESOLVED.md item 4: its own role, its own grants, its
-- own 90-day retention. A trace never spans both.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops_eval_writer') THEN
    CREATE ROLE agent_ops_eval_writer NOLOGIN;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS agent_ops.eval_run (
  run_id          text        PRIMARY KEY,
  label           text        NOT NULL,
  opened_at       bigint      NOT NULL,
  source_kind     text        NOT NULL CHECK (source_kind IN ('golden', 'recorded')),
  source_digest   text        NOT NULL,
  subject_version text        NOT NULL,
  seed            text        NOT NULL,
  envelope        text        NOT NULL,
  redaction       text        NOT NULL,
  captured_via    text        NOT NULL CHECK (captured_via IN ('injected-client-only')),
  inserted_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_run_opened_at ON agent_ops.eval_run (opened_at);

CREATE TABLE IF NOT EXISTS agent_ops.eval_node (
  id                     text    PRIMARY KEY,
  run_id                 text    NOT NULL REFERENCES agent_ops.eval_run (run_id),
  -- Assigned by the store inside a per-run advisory lock. The unique index is
  -- what makes a duplicate impossible when two writers race; the lock is what
  -- stops them racing into one.
  sequence               int     NOT NULL CHECK (sequence >= 0),
  parent                 text    NULL REFERENCES agent_ops.eval_node (id),
  kind                   text    NOT NULL,
  name                   text    NOT NULL,
  opened_at              bigint  NOT NULL,
  closed_at              bigint  NULL,
  elapsed_micros         bigint  NOT NULL DEFAULT 0,
  outcome                text    NOT NULL,
  cost_tenth_cents       bigint  NOT NULL DEFAULT 0,
  tokens_in              bigint  NOT NULL DEFAULT 0,
  tokens_out             bigint  NOT NULL DEFAULT 0,
  price_table_version    text    NOT NULL DEFAULT '',
  payload_schema_version int     NOT NULL,
  redaction              text    NOT NULL,
  envelope               text    NOT NULL,
  payload                jsonb   NOT NULL,
  -- text, never jsonb: jsonb reorders keys and normalises numbers, which would
  -- destroy the byte-stable serialisation the trace digest stands on.
  canonical              text    NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS eval_node_run_sequence
  ON agent_ops.eval_node (run_id, sequence);

CREATE INDEX IF NOT EXISTS eval_node_run ON agent_ops.eval_node (run_id);

REVOKE ALL ON agent_ops.eval_run FROM PUBLIC;
REVOKE ALL ON agent_ops.eval_node FROM PUBLIC;

GRANT USAGE ON SCHEMA agent_ops TO agent_ops_eval_writer;

-- UPDATE settles an open node; DELETE expires a run. Neither grant exists on
-- agent_ops.audit_trace_case or agent_ops.audit_trace_node, and neither ever may.
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_ops.eval_run TO agent_ops_eval_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_ops.eval_node TO agent_ops_eval_writer;

GRANT EXECUTE ON FUNCTION pg_advisory_xact_lock(bigint) TO agent_ops_eval_writer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops') THEN
    GRANT agent_ops_eval_writer TO agent_ops;
  END IF;
END
$$;

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0003_eval_store')
ON CONFLICT (version) DO NOTHING;

COMMIT;
`;

const text = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));
const int = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const rowToNode = (row: SqlRow): EvalNode => ({
  id: text(row["id"]) as EvalNodeId,
  runId: text(row["run_id"]) as RunId,
  sequence: int(row["sequence"]),
  parent: row["parent"] === null || row["parent"] === undefined
    ? undefined
    : (text(row["parent"]) as EvalNodeId),
  kind: text(row["kind"]) as EvalNodeKind,
  name: text(row["name"]),
  openedAt: int(row["opened_at"]),
  closedAt: row["closed_at"] === null || row["closed_at"] === undefined ? null : int(row["closed_at"]),
  elapsedMicros: int(row["elapsed_micros"]),
  outcome: text(row["outcome"]) as NodeOutcome,
  costTenthCents: int(row["cost_tenth_cents"]),
  tokensIn: int(row["tokens_in"]),
  tokensOut: int(row["tokens_out"]),
  priceTableVersion: text(row["price_table_version"]),
  payloadSchemaVersion: int(row["payload_schema_version"]),
  redaction: text(row["redaction"]),
  envelope: text(row["envelope"]),
  payload: (row["payload"] ?? {}) as EvalPayload,
  canonical: row["canonical"] === null || row["canonical"] === undefined ? null : text(row["canonical"]),
});

export const sqlEvalNodeStore = (
  sql: SqlExecutor,
  limits: Partial<SqlEvalStoreLimits> = {},
): EvalNodeStore => {
  const bounds: SqlEvalStoreLimits = { ...DEFAULTS, ...limits };

  const fail = (operation: string, cause: unknown): never => {
    throw cause instanceof EvalStoreUnavailable
      ? cause
      : new EvalStoreUnavailable(operation, cause);
  };

  return mintEvalNodeStore({
    async openRun(header: StoredRunHeader) {
      try {
        await sql.query(
          `INSERT INTO ${RUN}
             (run_id, label, opened_at, source_kind, source_digest, subject_version,
              seed, envelope, redaction, captured_via)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            header.runId,
            header.label,
            header.openedAt,
            header.sourceKind,
            header.sourceDigest,
            header.subjectVersion,
            header.seed,
            header.envelope,
            header.redaction,
            header.capturedVia,
          ],
        );
      } catch (cause) {
        fail("openRun", cause);
      }
    },

    async append(input) {
      try {
        return await sql.transaction(async (tx) => {
          // Transaction-scoped, keyed by run. Writers to different runs never
          // contend; writers to the same run serialise exactly here, which is
          // what makes the sequence a real total order rather than a race.
          await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.runId]);
          const next = await tx.query(
            `SELECT COALESCE(MAX(sequence) + 1, 0) AS seq FROM ${NODE} WHERE run_id = $1`,
            [input.runId],
          );
          const sequence = int(next.rows[0]?.["seq"]);
          if (sequence >= bounds.maxNodesPerRun) {
            throw new EvalStoreUnavailable(
              "append",
              `node ceiling ${bounds.maxNodesPerRun} reached for run ${input.runId}`,
            );
          }
          const id = `${input.runId}/${String(sequence).padStart(8, "0")}`;
          const inserted = await tx.query(
            `INSERT INTO ${NODE}
               (id, run_id, sequence, parent, kind, name, opened_at, closed_at,
                elapsed_micros, outcome, cost_tenth_cents, tokens_in, tokens_out,
                price_table_version, payload_schema_version, redaction, envelope,
                payload, canonical)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,0,'ok',0,0,0,'',$8,$9,$10,$11,NULL)
             RETURNING *`,
            [
              id,
              input.runId,
              sequence,
              input.parent ?? null,
              input.kind,
              input.name,
              input.openedAt,
              input.payloadSchemaVersion,
              input.redaction,
              input.envelope,
              JSON.stringify(input.payload),
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) {
            throw new EvalStoreUnavailable("append", "insert returned no row");
          }
          return rowToNode({ ...row, payload: input.payload });
        });
      } catch (cause) {
        return fail("append", cause);
      }
    },

    async settle(input) {
      try {
        const updated = await sql.query(
          `UPDATE ${NODE}
              SET closed_at = $3, elapsed_micros = $4, outcome = $5,
                  cost_tenth_cents = $6, tokens_in = $7, tokens_out = $8,
                  price_table_version = $9, payload = payload || $10::jsonb,
                  canonical = $11
            WHERE run_id = $1 AND id = $2 AND closed_at IS NULL
        RETURNING *`,
          [
            input.runId,
            input.id,
            input.closedAt,
            input.elapsedMicros,
            input.outcome,
            input.costTenthCents,
            input.tokensIn,
            input.tokensOut,
            input.priceTableVersion,
            JSON.stringify(input.closing),
            input.canonical,
          ],
        );
        const row = updated.rows[0];
        if (row === undefined) {
          // Settling twice, or settling a node this store never opened. Both are
          // errors rather than no-ops: a node closed twice makes the ordering of
          // the trace a lie.
          throw new EvalStoreUnavailable(
            "settle",
            `node ${input.id} is unknown or already settled`,
          );
        }
        return rowToNode(row);
      } catch (cause) {
        return fail("settle", cause);
      }
    },

    async read(runId): Promise<StoredEvalRun | undefined> {
      try {
        const runRows = await sql.query(`SELECT * FROM ${RUN} WHERE run_id = $1`, [runId]);
        const runRow = runRows.rows[0];
        if (runRow === undefined) return undefined;
        const nodeRows = await sql.query(
          `SELECT * FROM ${NODE} WHERE run_id = $1 ORDER BY sequence ASC`,
          [runId],
        );
        const header: StoredRunHeader = {
          runId: text(runRow["run_id"]) as RunId,
          label: text(runRow["label"]),
          openedAt: int(runRow["opened_at"]),
          sourceKind: text(runRow["source_kind"]) as SourceKind,
          sourceDigest: text(runRow["source_digest"]) as SourceDigest,
          subjectVersion: text(runRow["subject_version"]) as SubjectVersion,
          seed: text(runRow["seed"]) as Seed,
          envelope: text(runRow["envelope"]),
          redaction: text(runRow["redaction"]),
          capturedVia: "injected-client-only",
        };
        // Decoded, never cast. An envelope, kind or outcome this build does not
        // know is `UnreadableEnvelope` rather than a plausible-looking node.
        return { header, nodes: nodeRows.rows.map((row) => readStoredNode(rowToNode(row))) };
      } catch (cause) {
        return fail("read", cause);
      }
    },

    /**
     * Bounded, and atomic in one statement.
     *
     * What this replaced was neither. `DELETE … RETURNING id` materialised every
     * deleted identifier — 10M nodes a day against a 90-day retention — purely
     * to return `rows.length` as a count, and the two `DELETE`s were separate
     * statements outside a transaction, so a failure between them left
     * `eval_run` rows with no nodes: a run that reads as empty rather than as
     * expired, which is the one thing an expired trace must not look like.
     *
     * One statement, so it is atomic without a transaction block; `LIMIT` on the
     * run selection, so the batch is bounded; `count(*)` over the CTEs, so
     * nothing is materialised to be counted.
     */
    async expireBefore(cutoff, batchLimit) {
      if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 10_000) {
        throw new LimitOutOfRange("expireBefore.batchLimit", batchLimit, "1..10000 (integer)");
      }
      try {
        const result = await sql.query(
          `WITH doomed AS (
             SELECT run_id FROM ${RUN}
              WHERE opened_at < $1
              ORDER BY opened_at ASC
              LIMIT $2
           ), gone_nodes AS (
             DELETE FROM ${NODE} WHERE run_id IN (SELECT run_id FROM doomed) RETURNING 1
           ), gone_runs AS (
             DELETE FROM ${RUN} WHERE run_id IN (SELECT run_id FROM doomed) RETURNING 1
           )
           SELECT (SELECT count(*) FROM gone_runs) AS runs,
                  (SELECT count(*) FROM gone_nodes) AS nodes`,
          [cutoff, batchLimit],
        );
        const row = result.rows[0];
        return { runs: int(row?.["runs"]), nodes: int(row?.["nodes"]) };
      } catch (cause) {
        return fail("expireBefore", cause);
      }
    },
  });
};
