import { canonicalJson } from "./canonical.js";
import { ApprovalStoreUnavailable } from "./errors.js";
import type {
  ApprovalStore,
  AuthorityId,
  EffectOutcome,
  IdempotencyClaim,
  IdempotencyKey,
  IdempotencyState,
  Instant,
  RedactedPayload,
  ReservedStatus,
  SealedAnswer,
  SuspensionId,
  SuspensionRecord,
  SuspensionState,
  Tier,
} from "./types.js";
import type { CorrelationId, NodeId } from "../../audit/index.js";

/**
 * Postgres approval store — the **second real adapter** of the `ApprovalStore`
 * seam, and the one that carries a suspension across process death.
 *
 * Until this file existed the seam had one shipped adapter and was, by this
 * project's own rule, hypothetical. `index.ts` said so rather than dressing it
 * up. This closes it: two adapters, one interface, and a test that builds a
 * suspension, throws the entire runtime away *including the store object*, and
 * answers the case from bytes.
 *
 * ## No database driver is imported here, deliberately
 *
 * The adapter takes an injected `SqlExecutor`. It does not `require("pg")`,
 * does not read a connection string and does not open a socket. Two
 * consequences, and they are the same two `audit`'s Postgres store states:
 *
 *   - **Hermetic tests stay structural.** There is no code path in this module
 *     — shipped or test — that can reach a network, so a test cannot reach a
 *     live database even with real credentials in the environment. That comes
 *     from the absence of a driver, never from a flag or an `if (process.env.CI)`.
 *   - **Nineteen applications do not inherit a dependency.** `SqlExecutor` is
 *     shaped so that wiring an existing `pg` `Pool` to it is about fifteen
 *     lines, and an application on a different driver is not blocked.
 *
 * The shape is **structurally identical** to `audit`'s `SqlExecutor` and
 * `evals`'s, on purpose: one pool object, wired once at the composition root,
 * satisfies all three. It is declared here rather than imported so that a
 * caller who needs `approval` learns `approval`'s interface and nothing else.
 *
 * ## Correct under concurrent writers, in one statement each
 *
 * Every conditional write is a **single** statement whose `WHERE` clause is the
 * condition. There is no read-then-write anywhere in this file, and that is not
 * a style preference: under READ COMMITTED a read followed by a write is two
 * moments, and two sweepers during a deploy are exactly the traffic that finds
 * the gap between them.
 *
 *   `swapSuspension`   `UPDATE … WHERE id = $ AND revision = $expected`. The
 *                      loser updates zero rows and is told so.
 *   `acquireLease`     `UPDATE … WHERE lease_until IS NULL OR lease_until <= now`.
 *                      It deliberately does **not** touch `revision`: a lease is
 *                      not a write to the case, and bumping the revision would
 *                      make a sweeper's own lease lose it the compare-and-set it
 *                      took the lease in order to make.
 *   `saveSuspension`   `INSERT … ON CONFLICT (id) DO NOTHING`. First write wins;
 *                      an overwrite would reset `revision` and turn a lost
 *                      compare-and-set into a silent clobber.
 *   `claimIdempotency` insert-or-take-over-expired, then read back — each step a
 *                      single statement, all three inside one transaction, so
 *                      exactly one concurrent caller per key is told `claimed`.
 *
 * ## Bounded concurrency: `maxPendingWrites`. Bounded retries: zero
 *
 * This adapter never retries. A failed write raises `ApprovalStoreUnavailable`
 * immediately and the module records it and fails closed — there is no tier at
 * which an unrecorded suspension is the right answer, because the thing on the
 * other side of it is money.
 *
 * It also refuses to hold more than `maxPendingWrites` writes in flight, shed
 * with `backpressure` rather than queued behind pool connections. Reads are
 * deliberately not shed: a read cannot corrupt anything, and refusing a
 * reconciliation pass is a worse failure than a slow one.
 *
 * ## What this store is allowed to do that `audit`'s is not, and what it is not
 *
 * It holds **mutable operational state** — a suspension moves through
 * `awaiting → answered → executed` — so its writer role has `UPDATE`. It does
 * **not** have `DELETE`: an approver's own words live in this table, under the
 * application's own retention, and a lawful erasure is a separately authorised
 * operation rather than a grant this role carries around. And it grants nothing
 * whatsoever on an audit table: those stay `INSERT`-only forever, and a grant
 * that exists is a grant that gets used.
 *
 * ## Required schema
 *
 * `APPROVAL_STORE_SCHEMA_SQL`, below, is the data definition this adapter
 * requires, shipped **as a value** rather than described in prose, exactly as
 * `evals` ships `EVAL_STORE_SCHEMA_SQL`. It belongs in
 * `migrations/0006_approval_store.sql`. A test in `tests/` parses the column
 * lists out of the statements this file actually issues and asserts every one
 * of them appears in that text, so the adapter and the schema it assumes cannot
 * drift apart silently.
 */

export interface SqlRow {
  readonly [column: string]: unknown;
}

/**
 * The driver-injection point, and **not a seam** — see the seam accounting in
 * `index.ts`. It exists because hermeticity forbids this package from importing
 * a driver, not because two implementations of database access are wanted.
 * There is exactly one shape: wire your existing pool to it.
 */
export interface SqlExecutor {
  query(
    text: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: readonly SqlRow[] }>;
  /** Runs `fn` on one connection inside a transaction, rolling back on throw. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface PostgresApprovalStoreLimits {
  /**
   * Ceiling on writes in flight against this store. Over it, writes are shed
   * with `backpressure` rather than queued behind pool connections.
   */
  readonly maxPendingWrites: number;
  /**
   * Hard ceiling on rows any read of this store may return, whatever limit the
   * caller passed. The module's own limits are the first bound; this is the one
   * that holds when a caller passes `Number.MAX_SAFE_INTEGER`.
   */
  readonly maxRowsPerRead: number;
}

const DEFAULT_LIMITS: PostgresApprovalStoreLimits = {
  maxPendingWrites: 64,
  maxRowsPerRead: 1_000,
};

const SUSPENSION = "agent_ops.approval_suspension";
const CLAIM = "agent_ops.approval_idempotency";

/**
 * The columns of one suspension, in the order every statement below binds them.
 *
 * One list, used to build the `INSERT`, the `UPDATE` and the projection, so a
 * field added to `SuspensionRecord` cannot reach one statement and miss
 * another — the failure mode that leaves a case answerable in the writer and
 * unanswerable after a restart.
 */
const COLUMNS = [
  "correlation_id",
  "point_id",
  "point_schema_version",
  "effect_kind",
  "effect_schema_version",
  "tier",
  "seat",
  "state",
  "reserved_json",
  "verdict_json",
  "effect_payload_json",
  "redacted_effect_json",
  "brief_body_json",
  "do_nothing_json",
  "idempotency_key",
  "pool",
  "dual_control_required",
  "licence_valid_for_ms",
  "awaiting_since_ms",
  "presented_at_ms",
  "offered_to_json",
  "last_reminded_at_ms",
  "next_due_at_ms",
  "expires_at_ms",
  "first_answer_json",
  "final_answer_json",
  "steps_fired",
  "cycles_fired",
  "lease_until_ms",
  "lease_owner",
  "suspend_node",
  "run_node",
] as const;

/** The record's fields in `COLUMNS` order. Text columns are canonical bytes. */
const valuesOf = (record: SuspensionRecord): readonly unknown[] => [
  record.correlationId,
  record.pointId,
  record.pointSchemaVersion,
  record.effectKind,
  record.effectSchemaVersion,
  record.tier,
  record.seat,
  record.state,
  canonicalJson(record.reserved),
  record.verdictJson,
  record.effectPayloadJson,
  canonicalJson(record.redactedEffect),
  record.briefBodyJson,
  record.doNothingJson,
  record.idempotencyKey,
  record.pool,
  record.dualControlRequired,
  record.licenceValidFor,
  record.awaitingSince,
  record.presentedAt,
  canonicalJson(record.offeredTo),
  record.lastRemindedAt,
  record.nextDueAt,
  record.expiresAt,
  record.firstAnswer === null ? null : canonicalJson(record.firstAnswer),
  record.finalAnswer === null ? null : canonicalJson(record.finalAnswer),
  record.stepsFired,
  record.cyclesFired,
  record.leaseUntil,
  record.leaseOwner,
  record.suspendNode,
  record.runNode,
];

const placeholders = (count: number, from = 1): string =>
  Array.from({ length: count }, (_, i) => `$${i + from}`).join(", ");

const assignments = (from: number): string =>
  COLUMNS.map((column, i) => `${column} = $${i + from}`).join(",\n       ");

const PROJECTION = ["id", "revision", ...COLUMNS].join(", ");

/**
 * Statements are tagged so they are identifiable in `pg_stat_statements`, and so
 * a test can assert exactly what this adapter is allowed to issue.
 */
const SQL = {
  save: `-- approval:save-suspension
INSERT INTO ${SUSPENSION} (id, revision, ${COLUMNS.join(", ")})
VALUES ($1, 0, ${placeholders(COLUMNS.length, 2)})
ON CONFLICT (id) DO NOTHING`,

  load: `-- approval:load-suspension
SELECT ${PROJECTION} FROM ${SUSPENSION} WHERE id = $1`,

  ofCase: `-- approval:suspensions-of-case
SELECT ${PROJECTION} FROM ${SUSPENSION}
WHERE correlation_id = $1
ORDER BY awaiting_since_ms ASC, id ASC
LIMIT $2`,

  /**
   * The compare-and-set. One statement: the condition is the `WHERE` clause, so
   * there is no window between deciding and writing.
   */
  swap: `-- approval:swap-suspension
UPDATE ${SUSPENSION}
   SET revision = $2 + 1,
       ${assignments(3)}
 WHERE id = $1 AND revision = $2
RETURNING id`,

  /**
   * Due work. `awaiting` records that are due or past their expiry, and `held`
   * records that are due — a kill-switch hold is resumable.
   */
  due: `-- approval:due-suspensions
SELECT ${PROJECTION} FROM ${SUSPENSION}
 WHERE (state = 'awaiting' AND (next_due_at_ms <= $1
                                OR (expires_at_ms IS NOT NULL AND expires_at_ms <= $1)))
    OR (state = 'held' AND next_due_at_ms <= $1)
 ORDER BY next_due_at_ms ASC, id ASC
 LIMIT $2`,

  /** Compare-and-set on the lease. Deliberately does not touch `revision`. */
  lease: `-- approval:acquire-lease
UPDATE ${SUSPENSION}
   SET lease_owner = $2, lease_until_ms = $4
 WHERE id = $1 AND (lease_until_ms IS NULL OR lease_until_ms <= $3)
RETURNING id`,

  claimInsert: `-- approval:claim-insert
INSERT INTO ${CLAIM} (key, correlation_id, state, claimed_at_ms, lease_until_ms, outcome_json, reason)
VALUES ($1, $2, 'not-attempted', $3, $4, NULL, NULL)
ON CONFLICT (key) DO NOTHING
RETURNING key, correlation_id, state, claimed_at_ms, lease_until_ms, outcome_json, reason`,

  /**
   * Take over a claim whose lease has expired — **only** from `not-attempted`,
   * where no outbound call was made and re-executing is therefore safe. An
   * `unknown` claim is never reclaimed for execution, at any age, whatever its
   * lease says. Ambiguity resolves toward not paying twice.
   */
  claimReclaim: `-- approval:claim-reclaim
UPDATE ${CLAIM}
   SET correlation_id = $2, claimed_at_ms = $3, lease_until_ms = $4,
       outcome_json = NULL, reason = NULL
 WHERE key = $1 AND state = 'not-attempted' AND lease_until_ms <= $3
RETURNING key, correlation_id, state, claimed_at_ms, lease_until_ms, outcome_json, reason`,

  claimRead: `-- approval:claim-read
SELECT key, correlation_id, state, claimed_at_ms, lease_until_ms, outcome_json, reason
  FROM ${CLAIM} WHERE key = $1`,

  claimSettle: `-- approval:claim-settle
INSERT INTO ${CLAIM} (key, correlation_id, state, claimed_at_ms, lease_until_ms, outcome_json, reason)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (key) DO UPDATE
   SET correlation_id = EXCLUDED.correlation_id,
       state = EXCLUDED.state,
       claimed_at_ms = EXCLUDED.claimed_at_ms,
       lease_until_ms = EXCLUDED.lease_until_ms,
       outcome_json = EXCLUDED.outcome_json,
       reason = EXCLUDED.reason`,

  inDoubt: `-- approval:in-doubt
SELECT key, correlation_id, state, claimed_at_ms, lease_until_ms, outcome_json, reason
  FROM ${CLAIM}
 WHERE state = 'unknown'
 ORDER BY claimed_at_ms ASC, key ASC
 LIMIT $1`,
} as const;

/**
 * The schema this adapter requires. Copy into
 * `migrations/0006_approval_store.sql`.
 *
 * Read the grants against `0002_audit_trace.sql`. That file gives its writer
 * `SELECT, INSERT` and nothing else, plus triggers that raise on `UPDATE` and
 * `DELETE`, so append-only holds against someone with a psql prompt. This file
 * gives its writer `UPDATE` — a suspension is operational state and moves
 * through a state machine — and **no `DELETE`**, because an approver's own
 * words are in `first_answer_json` and `final_answer_json` and a lawful erasure
 * is a separately authorised operation rather than a standing grant.
 *
 * Two columns carry the link this store cannot commit atomically with the
 * trace: `suspend_node` and `run_node`. They are the durable half of a link
 * that is deliberately written on **both** sides — see `LinkDivergenceKind` —
 * which is what makes a crash between the two writes findable rather than
 * silent.
 */
export const APPROVAL_STORE_SCHEMA_SQL = `-- 0006_approval_store.sql
-- The approval store: durable suspensions and idempotency claims.
--
-- This is the state that lets a process die between the question and the
-- answer. Everything needed to resume a case is a column here or a node in the
-- audit trace; nothing lives in a closure, which is the property that makes a
-- human gate measured in days survivable at all.
--
-- ## Why this table has UPDATE and audit's does not
--
-- A suspension is operational state: awaiting -> answered -> executed, a lease
-- taken and released, a ladder position advanced. That is a state machine and
-- it needs UPDATE. The audit trace is evidence and it does not.
--
-- ## Why this table does not have DELETE
--
-- first_answer_json and final_answer_json hold an approver's own words, kept
-- here rather than in the trace precisely because the trace has no un-writing.
-- Erasing them lawfully is a deliberate, separately authorised operation, not a
-- grant this role carries around waiting to be used by a retention job nobody
-- reviewed.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops_approval_writer') THEN
    CREATE ROLE agent_ops_approval_writer NOLOGIN;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS agent_ops.approval_suspension (
  id                     text        PRIMARY KEY,
  -- The compare-and-set column. Every conditional write in the adapter is
  -- "UPDATE ... WHERE id = $ AND revision = $expected" in ONE statement, so two
  -- writers to one case are correct without a lock -- and no lock is ever held
  -- across the human gate, because a lock held for three days is an outage.
  revision               int         NOT NULL CHECK (revision >= 0),
  correlation_id         text        NOT NULL,
  point_id               text        NOT NULL,
  point_schema_version   int         NOT NULL,
  effect_kind            text        NOT NULL,
  effect_schema_version  int         NOT NULL,
  tier                   text        NOT NULL CHECK (tier IN ('low', 'medium', 'high')),
  seat                   text        NOT NULL CHECK (seat IN ('first', 'second')),
  -- 'held' is NOT terminal: the kill switch stops effects during an incident and
  -- is disengaged after it, so a held case keeps a next_due_at and the sweep
  -- keeps visiting it.
  state                  text        NOT NULL CHECK (state IN
                                       ('awaiting', 'answered', 'refused',
                                        'expired', 'executed', 'held')),
  reserved_json          text        NOT NULL,
  -- text, never jsonb: jsonb reorders keys and normalises numbers, which would
  -- destroy the byte-stable serialisation replay stands on.
  verdict_json           text        NOT NULL,
  effect_payload_json    text        NOT NULL,
  redacted_effect_json   text        NOT NULL,
  brief_body_json        text        NOT NULL,
  do_nothing_json        text        NOT NULL,
  idempotency_key        text        NOT NULL,
  pool                   text        NOT NULL,
  dual_control_required  boolean     NOT NULL,
  licence_valid_for_ms   bigint      NOT NULL CHECK (licence_valid_for_ms > 0),
  awaiting_since_ms      bigint      NOT NULL,
  -- NULL means the brief was never delivered. It is not a formality: measuring
  -- time-to-decision from a presentation that did not happen corrupts the only
  -- anti-rubber-stamping signal this library records.
  presented_at_ms        bigint      NULL,
  offered_to_json        text        NOT NULL,
  last_reminded_at_ms    bigint      NULL,
  -- Never NULL and never a sentinel: the ladder has no position from which
  -- nothing more is owed.
  next_due_at_ms         bigint      NOT NULL,
  -- NULL means indefinite hold. ALWAYS NULL for a reserved decision -- the
  -- expiry branch is deleted, not disabled.
  expires_at_ms          bigint      NULL,
  first_answer_json      text        NULL,
  final_answer_json      text        NULL,
  steps_fired            int         NOT NULL CHECK (steps_fired >= 0),
  cycles_fired           int         NOT NULL CHECK (cycles_fired >= 0),
  lease_until_ms         bigint      NULL,
  lease_owner            text        NULL,
  -- The durable half of a link that is written on both sides. The matching
  -- approval.suspend.begin node in the audit trace carries this suspension's
  -- id, so a crash between the two writes loses a row and never the link.
  suspend_node           text        NOT NULL,
  run_node               text        NOT NULL,
  inserted_at            timestamptz NOT NULL DEFAULT now()
);

-- The sweep's only query. Partial, because settled suspensions are the
-- overwhelming majority of the table after a month and none of them is ever due.
CREATE INDEX IF NOT EXISTS approval_suspension_due
  ON agent_ops.approval_suspension (next_due_at_ms)
  WHERE state IN ('awaiting', 'held');

-- Reconciliation reads by case.
CREATE INDEX IF NOT EXISTS approval_suspension_case
  ON agent_ops.approval_suspension (correlation_id);

CREATE TABLE IF NOT EXISTS agent_ops.approval_idempotency (
  key             text        PRIMARY KEY,
  correlation_id  text        NOT NULL,
  -- Three states, not two. 'not-attempted' means the key was claimed and no
  -- outbound call was made, so a retry is safe. 'unknown' means the call was
  -- made and the outcome is unrecorded, so a retry is NEVER safe -- it goes to a
  -- human. Collapsing them is how one payment becomes two.
  state           text        NOT NULL CHECK (state IN ('not-attempted', 'unknown', 'settled')),
  claimed_at_ms   bigint      NOT NULL,
  lease_until_ms  bigint      NOT NULL,
  outcome_json    text        NULL,
  reason          text        NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The reconciliation queue: effects whose outcome nobody knows. Partial,
-- because it is read on a schedule and is empty on a good day.
CREATE INDEX IF NOT EXISTS approval_idempotency_in_doubt
  ON agent_ops.approval_idempotency (claimed_at_ms)
  WHERE state = 'unknown';

REVOKE ALL ON agent_ops.approval_suspension FROM PUBLIC;
REVOKE ALL ON agent_ops.approval_idempotency FROM PUBLIC;

GRANT USAGE ON SCHEMA agent_ops TO agent_ops_approval_writer;

-- UPDATE, because a suspension is a state machine. No DELETE, on either table:
-- an approver's own words live in this table and a lawful erasure is a
-- separately authorised operation. Nothing here is granted on an audit table.
GRANT SELECT, INSERT, UPDATE ON agent_ops.approval_suspension TO agent_ops_approval_writer;
GRANT SELECT, INSERT, UPDATE ON agent_ops.approval_idempotency TO agent_ops_approval_writer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops') THEN
    GRANT agent_ops_approval_writer TO agent_ops;
  END IF;
END
$$;

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0006_approval_store')
ON CONFLICT (version) DO NOTHING;

COMMIT;
`;

/* ------------------------------------------------------------------ decoding */

/**
 * SQLSTATE classes this adapter refuses to call an outage.
 *
 * 22 is a data exception, 23 an integrity constraint violation, 42 a syntax or
 * access-rule violation. Every one means the writer asked for something
 * impossible or the schema has drifted from `APPROVAL_STORE_SCHEMA_SQL` — a
 * defect, never a connection reset. Reporting them as transient would let a
 * check constraint be retried forever by an operator reading a dashboard that
 * says "the database was briefly away".
 */
const DEFECT_CLASSES = new Set(["22", "23", "42"]);

const sqlState = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/** `bigint` arrives as a string from most drivers. Both shapes are accepted. */
const asInteger = (value: unknown, column: string): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new ApprovalStoreUnavailable(
      "contract",
      `decode ${column}`,
      new Error(`column ${column} is not a safe integer: ${String(value)}`),
    );
  }
  return parsed;
};

const asNullableInteger = (value: unknown, column: string): number | null =>
  value === null || value === undefined ? null : asInteger(value, column);

const asText = (value: unknown, column: string): string => {
  if (typeof value !== "string") {
    throw new ApprovalStoreUnavailable(
      "contract",
      `decode ${column}`,
      new Error(`column ${column} is not text`),
    );
  }
  return value;
};

const asNullableText = (value: unknown, column: string): string | null =>
  value === null || value === undefined ? null : asText(value, column);

const parse = <T>(value: unknown, column: string): T => {
  try {
    return JSON.parse(asText(value, column)) as T;
  } catch (cause) {
    if (cause instanceof ApprovalStoreUnavailable) throw cause;
    throw new ApprovalStoreUnavailable("contract", `decode ${column}`, cause);
  }
};

const rowToSuspension = (row: SqlRow): SuspensionRecord => ({
  id: asText(row["id"], "id") as SuspensionId,
  revision: asInteger(row["revision"], "revision"),
  correlationId: asText(row["correlation_id"], "correlation_id") as CorrelationId,
  pointId: asText(row["point_id"], "point_id"),
  pointSchemaVersion: asInteger(row["point_schema_version"], "point_schema_version"),
  effectKind: asText(row["effect_kind"], "effect_kind"),
  effectSchemaVersion: asInteger(row["effect_schema_version"], "effect_schema_version"),
  tier: asText(row["tier"], "tier") as Tier,
  reserved: parse<ReservedStatus>(row["reserved_json"], "reserved_json"),
  seat: asText(row["seat"], "seat") as "first" | "second",
  verdictJson: asText(row["verdict_json"], "verdict_json"),
  effectPayloadJson: asText(row["effect_payload_json"], "effect_payload_json"),
  redactedEffect: parse<RedactedPayload>(row["redacted_effect_json"], "redacted_effect_json"),
  briefBodyJson: asText(row["brief_body_json"], "brief_body_json"),
  doNothingJson: asText(row["do_nothing_json"], "do_nothing_json"),
  idempotencyKey: asText(row["idempotency_key"], "idempotency_key") as IdempotencyKey,
  pool: asText(row["pool"], "pool") as SuspensionRecord["pool"],
  dualControlRequired: row["dual_control_required"] === true,
  licenceValidFor: asInteger(row["licence_valid_for_ms"], "licence_valid_for_ms"),
  awaitingSince: asInteger(row["awaiting_since_ms"], "awaiting_since_ms"),
  presentedAt: asNullableInteger(row["presented_at_ms"], "presented_at_ms"),
  offeredTo: parse<readonly AuthorityId[]>(row["offered_to_json"], "offered_to_json"),
  lastRemindedAt: asNullableInteger(row["last_reminded_at_ms"], "last_reminded_at_ms"),
  nextDueAt: asInteger(row["next_due_at_ms"], "next_due_at_ms"),
  expiresAt: asNullableInteger(row["expires_at_ms"], "expires_at_ms"),
  firstAnswer:
    row["first_answer_json"] === null || row["first_answer_json"] === undefined
      ? null
      : parse<SealedAnswer>(row["first_answer_json"], "first_answer_json"),
  finalAnswer:
    row["final_answer_json"] === null || row["final_answer_json"] === undefined
      ? null
      : parse<SealedAnswer>(row["final_answer_json"], "final_answer_json"),
  stepsFired: asInteger(row["steps_fired"], "steps_fired"),
  cyclesFired: asInteger(row["cycles_fired"], "cycles_fired"),
  leaseUntil: asNullableInteger(row["lease_until_ms"], "lease_until_ms"),
  leaseOwner: asNullableText(row["lease_owner"], "lease_owner"),
  state: asText(row["state"], "state") as SuspensionState,
  suspendNode: asText(row["suspend_node"], "suspend_node") as NodeId,
  runNode: asText(row["run_node"], "run_node") as NodeId,
});

const rowToClaim = (row: SqlRow): IdempotencyClaim => ({
  key: asText(row["key"], "key") as IdempotencyKey,
  correlationId: asText(row["correlation_id"], "correlation_id") as CorrelationId,
  state: asText(row["state"], "state") as IdempotencyState,
  claimedAt: asInteger(row["claimed_at_ms"], "claimed_at_ms"),
  leaseUntil: asInteger(row["lease_until_ms"], "lease_until_ms"),
  outcome:
    row["outcome_json"] === null || row["outcome_json"] === undefined
      ? null
      : parse<EffectOutcome>(row["outcome_json"], "outcome_json"),
  reason: asNullableText(row["reason"], "reason"),
});

/* ------------------------------------------------------------------- adapter */

export const postgresApprovalStore = (
  sql: SqlExecutor,
  limits: Partial<PostgresApprovalStoreLimits> = {},
): ApprovalStore => {
  const { maxPendingWrites, maxRowsPerRead } = { ...DEFAULT_LIMITS, ...limits };
  let inFlightWrites = 0;

  /**
   * Classify, never swallow. Our own named error passes through; a constraint
   * or data-type violation is `contract` and is never retryable; everything
   * else is `store-failure`, because a connection reset and a full disk are the
   * same fact to a caller: the store did not take the write.
   */
  const asStoreError = (operation: string, cause: unknown): never => {
    if (cause instanceof ApprovalStoreUnavailable) throw cause;
    const state = sqlState(cause);
    if (state !== undefined && DEFECT_CLASSES.has(state.slice(0, 2))) {
      throw new ApprovalStoreUnavailable("contract", operation, cause);
    }
    throw new ApprovalStoreUnavailable("store-failure", operation, cause);
  };

  /** Writes are bounded and shed. Reads are bounded and never shed. */
  const write = async <T>(operation: string, body: () => Promise<T>): Promise<T> => {
    if (inFlightWrites >= maxPendingWrites) {
      throw new ApprovalStoreUnavailable("backpressure", operation);
    }
    inFlightWrites += 1;
    try {
      return await body();
    } catch (cause) {
      return asStoreError(operation, cause);
    } finally {
      inFlightWrites -= 1;
    }
  };

  const read = async <T>(operation: string, body: () => Promise<T>): Promise<T> => {
    try {
      return await body();
    } catch (cause) {
      return asStoreError(operation, cause);
    }
  };

  const rows = (limit: number): number =>
    Math.max(0, Math.min(Number.isSafeInteger(limit) ? limit : 0, maxRowsPerRead));

  return {
    async saveSuspension(record) {
      await write("saveSuspension", async () => {
        await sql.query(SQL.save, [record.id, ...valuesOf(record)]);
      });
    },

    async loadSuspension(id) {
      return read("loadSuspension", async () => {
        const { rows: found } = await sql.query(SQL.load, [id]);
        const row = found[0];
        return row === undefined ? undefined : rowToSuspension(row);
      });
    },

    async suspensionsOf(correlationId, limit) {
      return read("suspensionsOf", async () => {
        const { rows: found } = await sql.query(SQL.ofCase, [correlationId, rows(limit)]);
        return found.map(rowToSuspension);
      });
    },

    async swapSuspension(id, expectedRevision, next) {
      return write("swapSuspension", async () => {
        const { rows: updated } = await sql.query(SQL.swap, [
          id,
          expectedRevision,
          ...valuesOf(next),
        ]);
        // Zero rows means the revision moved under us. Not an error: it is the
        // compare-and-set doing its job, and the caller decides what that means.
        return updated.length === 1;
      });
    },

    async dueSuspensions(now: Instant, limit: number) {
      return read("dueSuspensions", async () => {
        const { rows: found } = await sql.query(SQL.due, [now, rows(limit)]);
        return found.map(rowToSuspension);
      });
    },

    async acquireLease(id, owner, now, until) {
      return write("acquireLease", async () => {
        const { rows: leased } = await sql.query(SQL.lease, [id, owner, now, until]);
        return leased.length === 1;
      });
    },

    async claimIdempotency(key, correlationId, now, leaseMs) {
      return write("claimIdempotency", async () =>
        // One transaction, three single-statement steps. Exactly one concurrent
        // caller per key comes out of it with `claimed: true`; the losers get
        // the existing claim and decide from its state, never from its age.
        sql.transaction(async (tx) => {
          const inserted = await tx.query(SQL.claimInsert, [
            key,
            correlationId,
            now,
            now + leaseMs,
          ]);
          const fresh = inserted.rows[0];
          if (fresh !== undefined) {
            return { claim: rowToClaim(fresh), claimed: true, reclaimed: false };
          }

          const taken = await tx.query(SQL.claimReclaim, [
            key,
            correlationId,
            now,
            now + leaseMs,
          ]);
          const reclaimed = taken.rows[0];
          if (reclaimed !== undefined) {
            return { claim: rowToClaim(reclaimed), claimed: true, reclaimed: true };
          }

          const existing = await tx.query(SQL.claimRead, [key]);
          const row = existing.rows[0];
          if (row === undefined) {
            // Somebody deleted the row between the two statements. There is no
            // DELETE grant on this table, so this is a schema that has drifted
            // from the migration rather than a race, and it fails closed.
            throw new ApprovalStoreUnavailable(
              "contract",
              "claimIdempotency",
              new Error(`claim ${key} vanished between statements`),
            );
          }
          return { claim: rowToClaim(row), claimed: false, reclaimed: false };
        }),
      );
    },

    async readIdempotency(key) {
      return read("readIdempotency", async () => {
        const { rows: found } = await sql.query(SQL.claimRead, [key]);
        const row = found[0];
        return row === undefined ? undefined : rowToClaim(row);
      });
    },

    async settleIdempotency(key, next) {
      await write("settleIdempotency", async () => {
        await sql.query(SQL.claimSettle, [
          key,
          next.correlationId,
          next.state,
          next.claimedAt,
          next.leaseUntil,
          next.outcome === null ? null : canonicalJson(next.outcome),
          next.reason,
        ]);
      });
    },

    async inDoubt(limit) {
      return read("inDoubt", async () => {
        const { rows: found } = await sql.query(SQL.inDoubt, [rows(limit)]);
        return found.map(rowToClaim);
      });
    },
  };
};
