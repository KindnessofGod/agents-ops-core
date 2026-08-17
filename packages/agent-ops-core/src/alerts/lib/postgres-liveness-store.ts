/**
 * The durable liveness store — the **second real adapter** of the
 * `LivenessStore` seam, and the one that makes the heartbeat mean anything
 * across a restart.
 *
 * ## The hole this closes, stated as the failure it was
 *
 * With only `inMemoryLivenessStore`, beat history died with the process. That
 * defeats the mechanism at exactly the moment it is needed: restart the process
 * and a watcher polling across the restart reads `never-seen`, which is the
 * *same* thing it reads for a component that was deployed and never started.
 * `livenessFindings` keeps three statuses precisely because "it stopped" and "it
 * never started" are different problems with different fixes — and an in-memory
 * store collapsed the first into the second on every deploy. The safe direction,
 * and still wrong: an operator learns to read `never-seen` as "we just deployed"
 * and then reads a genuine death that way too.
 *
 * With this adapter the record outlives the process, so a component that beat
 * yesterday and died overnight reads `overdue` with a real `lastSeenAt` and a
 * real beat count, and a component that has genuinely never beaten still reads
 * `never-seen`. That distinction is the entire product of this file.
 *
 * ## No database driver is imported here
 *
 * The adapter takes an injected `SqlExecutor` (see `sql.ts`). It does not
 * `require` a driver, does not read a connection string and does not open a
 * socket, so there is no code path in this package — shipped **or test** — that
 * can reach a database even with real credentials in the environment. The
 * hermetic guarantee comes from the absence of a driver, never from a flag.
 *
 * The cost of that is honest and is paid elsewhere: no test in this package can
 * exercise the schema's own guarantees — the primary key, the `CHECK`
 * constraints that keep the `HeartbeatRun` union from being spelled two ways in
 * one row, the grants. Those are properties of Postgres. `livenessStoreContract`
 * is the executable half: it holds *both* adapters to the same obligations and
 * is runnable against a live pool from an operational script, which is the run
 * that proves this file rather than the fake.
 *
 * ## One statement per verb, and why there is no transaction anywhere
 *
 * `audit`'s trace store takes a per-case advisory lock because an append must
 * read `MAX(sequence)` and then insert against it — two statements, one
 * invariant. Nothing here needs that. A beat is a single `UPDATE ... RETURNING`
 * against one row, so the row lock Postgres takes for the update *is* the
 * critical section: the sequence increments inside it, the monotonic clamp on
 * `last_seen_at` is computed inside it, and two beats landing in the same
 * millisecond serialise on the row rather than racing. No lock is held across
 * anything a human waits for, and no verb here can deadlock with another.
 *
 * Under `SERIALIZABLE` an update contending on one row can still fail with a
 * serialisation error; that arrives as `store-failure`, and the caller's next
 * beat writes the same facts. This adapter never retries — see below.
 *
 * ## Bounded: writes shed, reads refuse
 *
 * `maxPendingWrites` caps `watch` and `beat` in flight. Each holds a pool
 * connection for the length of its statement, and without a ceiling the queue is
 * the pool's, which is unbounded in most drivers — the backlog then surfaces as
 * latency until the process dies. Over the ceiling, writes are shed with
 * `LivenessStoreUnavailable("backpressure")`.
 *
 * `maxComponents` caps a snapshot. It does **not** truncate: the adapter asks
 * for one row more than the ceiling and rejects with
 * `LivenessStoreUnavailable("capacity")` if it comes back, because a truncated
 * snapshot silently removes watched components from a watcher's view. A refused
 * read is an alert; a short read is a blind spot.
 *
 * Retries: **zero**, on any verb. A beat is emitted on a cadence, so the retry
 * is the next beat, and a retry loop inside a store is how a struggling database
 * gets a thundering herd from nineteen applications.
 */

import {
  AlertError,
  ComponentNotWatched,
  LivenessRecordCorrupt,
  LivenessStoreUnavailable,
  LivenessTermsConflict,
} from "./errors.js";
import type { SqlExecutor, SqlRow } from "./sql.js";
import { assertRecordableBeat, assertRecordableWatch } from "./validate.js";
import { asLivenessStore } from "./types.js";
import type { HeartbeatRun, LivenessRecord, LivenessStore } from "./types.js";
import type { ComponentId } from "./primitives.js";

/** The table this adapter owns. See the migration named in `index.ts`. */
const TABLE = "agent_ops.alerts_liveness_component";

const COLUMNS =
  "component, expected_every_ms, watching_since, beats, empty_beats, working_beats, " +
  "items_processed, last_seen_at, last_run_kind, last_run_items, sequence";

/**
 * Every statement is tagged, so a recording executor in a test can assert
 * exactly which statements this adapter is allowed to issue — and so that a
 * `pg_stat_statements` reader can tell an alerting write from an audit write.
 */
const SQL = {
  /**
   * Idempotent on identical terms, loud on contradictory ones.
   *
   * `DO UPDATE` rather than `DO NOTHING` on purpose. `DO NOTHING` returns no row
   * when another writer's insert is in flight and uncommitted, which would leave
   * this adapter unable to tell "already watched at the same cadence" from
   * "watched at a cadence I disagree with". `DO UPDATE` blocks on that writer,
   * re-reads, and always returns the **stored** cadence — so the first writer's
   * terms win and a second writer offering different terms is told so.
   *
   * The assignment is deliberately a no-op: the stored cadence is never
   * overwritten, because silently taking a later value is how a deploy widens a
   * two-minute detection window to an hour with nobody asked.
   */
  watch: `-- alerts:watch
INSERT INTO ${TABLE} (component, expected_every_ms, watching_since)
VALUES ($1, $2, $3)
ON CONFLICT (component) DO UPDATE
  SET expected_every_ms = ${TABLE}.expected_every_ms
RETURNING expected_every_ms`,

  /**
   * One statement, so the row lock is the critical section.
   *
   * `GREATEST(COALESCE(last_seen_at, $2), $2)` is the monotonic clamp: a beat
   * arriving late, or from a host whose clock has jumped backwards, can never
   * move a component's last-seen backwards and make a live component look
   * overdue. `COALESCE` is what makes the first beat set it at all.
   *
   * `$4` is 1 for a working run and 0 for an empty one, so the two counters move
   * without a second statement and without a `CASE` the planner has to read.
   */
  beat: `-- alerts:beat
UPDATE ${TABLE}
   SET beats           = beats + 1,
       sequence        = sequence + 1,
       working_beats   = working_beats + $4,
       empty_beats     = empty_beats + (1 - $4),
       items_processed = items_processed + $5,
       last_seen_at    = GREATEST(COALESCE(last_seen_at, $2), $2),
       last_run_kind   = $3,
       last_run_items  = $6
 WHERE component = $1
RETURNING ${COLUMNS}`,

  /** `LIMIT $1` is `maxComponents + 1`: the extra row is how `capacity` is detected. */
  snapshot: `-- alerts:snapshot
SELECT ${COLUMNS}
  FROM ${TABLE}
 ORDER BY component
 LIMIT $1`,
} as const;

export interface PostgresLivenessLimits {
  /**
   * Ceiling on `watch` and `beat` calls in flight against this store. Over it,
   * writes are shed with `backpressure` rather than queued behind pool
   * connections.
   */
  readonly maxPendingWrites: number;
  /**
   * Ceiling on components one snapshot may return. Exceeded, the read **fails**
   * rather than truncating — see the note above.
   */
  readonly maxComponents: number;
}

/**
 * Deliberately small. A deployment watches components, not cases: a sweeper, a
 * reconciler, a shadow runner. Nineteen applications at ten components each is
 * one hundred and ninety, and a store holding ten thousand watched components is
 * a composition root registering something per case — which is a defect this
 * ceiling surfaces on the first snapshot rather than at the first incident.
 */
export const DEFAULT_POSTGRES_LIVENESS_LIMITS: PostgresLivenessLimits = {
  maxPendingWrites: 32,
  maxComponents: 4_096,
};

// --- decoding ----------------------------------------------------------------

/**
 * `bigint` arrives as a **string** from most drivers, because a 64-bit integer
 * does not fit an IEEE-754 double. Accepting both and proving the result is a
 * safe integer is the only honest decode: a silent `Number("9007199254740993")`
 * is how a beat count starts lying.
 */
const integerAt = (row: SqlRow, column: string, component: string): number => {
  const raw = row[column];
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new LivenessRecordCorrupt(component, column, `not a safe integer: ${String(raw)}`);
  }
  return value;
};

const optionalIntegerAt = (row: SqlRow, column: string, component: string): number | undefined => {
  const raw = row[column];
  if (raw === null || raw === undefined) return undefined;
  return integerAt(row, column, component);
};

const textAt = (row: SqlRow, column: string, component: string): string => {
  const raw = row[column];
  if (typeof raw !== "string") {
    throw new LivenessRecordCorrupt(component, column, `not text: ${String(raw)}`);
  }
  return raw;
};

/**
 * Rebuild the `HeartbeatRun` union from two columns.
 *
 * The union's shape is the whole design — `nothing-was-due` has **no**
 * `itemsProcessed` field, so "I did nothing" cannot be spelled as "I did zero
 * things" — and two nullable columns are the only way to spell that in a row.
 * The pairing is checked here *and* in the schema (`CHECK` constraint), so a row
 * that says `nothing-was-due` with an item count beside it is refused by
 * Postgres on the way in and refused by this decoder on the way out. Two
 * independent checks, because this is the one place a durable store could
 * quietly reintroduce the distinction the union exists to prevent.
 */
const runAt = (row: SqlRow, component: string): HeartbeatRun | undefined => {
  const raw = row["last_run_kind"];
  if (raw === null || raw === undefined) {
    if (row["last_run_items"] !== null && row["last_run_items"] !== undefined) {
      throw new LivenessRecordCorrupt(component, "last_run_items", "item count with no run kind");
    }
    return undefined;
  }
  const kind = textAt(row, "last_run_kind", component);
  if (kind === "did-work") {
    const items = optionalIntegerAt(row, "last_run_items", component);
    if (items === undefined) {
      throw new LivenessRecordCorrupt(component, "last_run_items", "did-work with no item count");
    }
    return { ran: "did-work", itemsProcessed: items };
  }
  if (kind === "nothing-was-due") {
    if (row["last_run_items"] !== null && row["last_run_items"] !== undefined) {
      throw new LivenessRecordCorrupt(
        component,
        "last_run_items",
        "nothing-was-due carries an item count",
      );
    }
    return { ran: "nothing-was-due" };
  }
  throw new LivenessRecordCorrupt(component, "last_run_kind", `outside the union: ${kind}`);
};

const rowToRecord = (row: SqlRow): LivenessRecord => {
  const component = textAt(row, "component", "(unknown)");
  const watchingSince = integerAt(row, "watching_since", component);
  const lastSeenAt = optionalIntegerAt(row, "last_seen_at", component);
  const beats = integerAt(row, "beats", component);
  if (lastSeenAt === undefined && beats !== 0) {
    throw new LivenessRecordCorrupt(component, "last_seen_at", `${beats} beats and no last seen`);
  }
  return {
    component: component as ComponentId,
    expectedEveryMs: integerAt(row, "expected_every_ms", component),
    watchingSince,
    beats,
    emptyBeats: integerAt(row, "empty_beats", component),
    workingBeats: integerAt(row, "working_beats", component),
    itemsProcessed: integerAt(row, "items_processed", component),
    lastSeen:
      lastSeenAt === undefined ? { seen: "never", watchingSince } : { seen: "beat", at: lastSeenAt },
    lastRun: runAt(row, component),
    sequence: integerAt(row, "sequence", component),
  };
};

// --- the adapter -------------------------------------------------------------

/**
 * Build the durable store over an injected executor.
 *
 * Every method is `async` on purpose, exactly as the in-memory adapter is: a
 * promise-returning method that throws *synchronously* escapes `.catch()` and
 * breaks `await Promise.all([...])` in a way that is very hard to see. Every
 * rejection out of this store is a rejection.
 */
export const postgresLivenessStore = (
  sql: SqlExecutor,
  limits: Partial<PostgresLivenessLimits> = {},
): LivenessStore => {
  const bounds: PostgresLivenessLimits = { ...DEFAULT_POSTGRES_LIVENESS_LIMITS, ...limits };
  let pendingWrites = 0;

  const write = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    if (pendingWrites >= bounds.maxPendingWrites) {
      throw new LivenessStoreUnavailable(
        "backpressure",
        `${what}: ${pendingWrites} writes already in flight (max ${bounds.maxPendingWrites})`,
      );
    }
    pendingWrites += 1;
    try {
      return await run();
    } finally {
      pendingWrites -= 1;
    }
  };

  /**
   * Anything raised by this module keeps its own identity —
   * `ComponentNotWatched` and `LivenessTermsConflict` are caller defects and a
   * caller must be able to `instanceof` them. Everything else is the store
   * failing, and is named as such with the driver's error preserved as `cause`
   * so a SQLSTATE is still reachable without this module parsing one.
   */
  const asStoreFailure = (what: string, error: unknown): never => {
    if (error instanceof AlertError) throw error;
    throw new LivenessStoreUnavailable("store-failure", what, { cause: error });
  };

  return asLivenessStore({
    async watch(component, expectedEveryMs, since) {
      assertRecordableWatch(component, expectedEveryMs, since);
      const rows = await write("watch", async () => {
        try {
          const result = await sql.query(SQL.watch, [component, expectedEveryMs, since]);
          return result.rows;
        } catch (error) {
          return asStoreFailure(`watch(${component})`, error);
        }
      });
      const row = rows[0];
      if (row === undefined) {
        // Obligation 3: a refused statement rejects. An upsert that resolves
        // with no row is an executor that is lying about a write, and guessing
        // which way would either invent agreement on a cadence or invent a
        // conflict. Neither is safe.
        throw new LivenessStoreUnavailable(
          "store-failure",
          `watch(${component}) returned no row; the executor does not honour RETURNING`,
        );
      }
      const stored = integerAt(row, "expected_every_ms", component);
      if (stored !== expectedEveryMs) {
        throw new LivenessTermsConflict(component, stored, expectedEveryMs);
      }
    },

    async beat(component, at, run) {
      assertRecordableBeat(component, at, run);
      const didWork = run.ran === "did-work";
      const rows = await write("beat", async () => {
        try {
          const result = await sql.query(SQL.beat, [
            component,
            at,
            run.ran,
            didWork ? 1 : 0,
            didWork ? run.itemsProcessed : 0,
            didWork ? run.itemsProcessed : null,
          ]);
          return result.rows;
        } catch (error) {
          return asStoreFailure(`beat(${component})`, error);
        }
      });
      const row = rows[0];
      // Zero rows updated means no row matched, which means nobody is watching.
      // This is the one place the difference between "the statement was refused"
      // and "the statement ran and matched nothing" carries a distinct meaning,
      // and it is why obligation 3 exists.
      if (row === undefined) throw new ComponentNotWatched(component);
      return rowToRecord(row);
    },

    async snapshot() {
      const rows = await (async () => {
        try {
          const result = await sql.query(SQL.snapshot, [bounds.maxComponents + 1]);
          return result.rows;
        } catch (error) {
          return asStoreFailure("snapshot", error);
        }
      })();
      if (rows.length > bounds.maxComponents) {
        throw new LivenessStoreUnavailable(
          "capacity",
          `more than ${bounds.maxComponents} watched components; a truncated snapshot would ` +
            `silently unmonitor the remainder`,
        );
      }
      return rows.map(rowToRecord);
    },
  });
};
