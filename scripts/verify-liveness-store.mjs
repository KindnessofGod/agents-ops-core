/**
 * Verify `postgresLivenessStore` against a live Postgres 16.
 *
 * ## Why this is a script and not a test
 *
 * Every other module with a Postgres schema proves it from a gated
 * `tests/live-postgres.test.ts`. `alerts` deliberately does not, and the reason
 * is a guarantee rather than an oversight: `alerts/tests/production.test.ts`
 * asserts **structurally** that no file under `alerts/tests/` reads
 * `process.env` at all — "needs no flag and no environment variable to be
 * safe". `alerts` is the one module that can page a real engineer at 03:00, so
 * it holds the strongest hermetic guarantee in the repository, and an
 * env-gated live suite inside it would require deleting that assertion.
 *
 * The coverage lives here instead. `scripts/` is outside the package, may
 * resolve `pg` from the workspace root, and is never collected by vitest — so
 * `alerts` keeps its assertion and the schema still gets attacked.
 *
 * ## Named error modes, all fail-closed
 *
 *   LiveDatabaseUrlMissing   no connection string: refuse rather than guess a
 *                            host. A default of localhost is how a verification
 *                            script eventually runs against production.
 *   MigrationsNotApplied     the liveness table is absent. Refuse rather than
 *                            create it here: the migration is the artefact
 *                            under test, and a script that creates its own
 *                            table proves the script, not the schema.
 *   NotAThrowawayDatabase    the table holds components this script did not
 *                            write. Refuse: it TRUNCATEs between groups.
 *   VerificationFailed       any obligation, restart check, schema attack or
 *                            concurrency check failed. Exit 1.
 *
 * ## Usage
 *
 *   npm run db:migrate -- --to postgres://…      (0008 must be applied)
 *   AGENT_OPS_LIVE_DATABASE_URL=postgres://… node scripts/verify-liveness-store.mjs
 *
 * The connection must be the table OWNER or a superuser: group 3 steps out of
 * the writer grants to prove the CHECK constraints, and group 1 TRUNCATEs.
 * A connection string is never echoed on any path — it carries a password.
 */
import pg from "pg";
import {
  postgresLivenessStore,
  runLivenessStoreContract,
  createHeartbeat,
  livenessQuery,
  livenessFindings,
  LivenessTermsConflict,
} from "../packages/agent-ops-core/dist/alerts/index.js";

const URL_VAR = "AGENT_OPS_LIVE_DATABASE_URL";
const connectionString = process.env[URL_VAR];
if (!connectionString) {
  console.error(
    `verify-liveness-store: LiveDatabaseUrlMissing\n` +
      `  set ${URL_VAR} to a THROWAWAY database with ./migrations applied.\n` +
      `  This script TRUNCATEs agent_ops.alerts_liveness_component. It never guesses a host.`,
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 8 });

/** The fifteen lines a composition root writes. Nothing more. */
const executorOver = (client) => ({
  query: async (text, params) => {
    const result = await client.query(text, [...params]);
    return { rows: result.rows };
  },
  transaction: async (fn) => {
    const conn = await pool.connect();
    try {
      await conn.query("BEGIN");
      const value = await fn(executorOver(conn));
      await conn.query("COMMIT");
      return value;
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    } finally {
      conn.release();
    }
  },
});

const sql = executorOver(pool);

const die = (mode, detail) => {
  console.error(`verify-liveness-store: ${mode}\n  ${detail}`);
  return pool.end().then(() => process.exit(1));
};

// Preflight. The migration is the artefact under test, so its absence is a
// refusal rather than something this script quietly repairs.
{
  const { rows } = await pool.query(
    `SELECT to_regclass('agent_ops.alerts_liveness_component') AS t`,
  );
  if (!rows[0]?.t) {
    await die(
      "MigrationsNotApplied",
      "agent_ops.alerts_liveness_component does not exist. Apply ./migrations (0008_alerts_liveness.sql) first: npm run db:migrate.",
    );
  }
}

// This script TRUNCATEs. Refuse any database holding rows it did not write.
{
  const KNOWN = ["sweeper", "reconciler", "hot", "zero-cadence"];
  const { rows } = await pool.query(
    `SELECT component FROM agent_ops.alerts_liveness_component WHERE NOT (component = ANY($1))`,
    [KNOWN],
  );
  if (rows.length > 0) {
    await die(
      "NotAThrowawayDatabase",
      `the liveness table holds ${rows.length} component(s) this script did not write ` +
        `(e.g. ${JSON.stringify(rows[0].component)}). It TRUNCATEs between groups; point ${URL_VAR} at a throwaway database.`,
    );
  }
}

const truncate = async () => {
  // TRUNCATE needs the owner; the writer role deliberately has no DELETE, which
  // is the guarantee group 3 asserts. Resetting between groups is a harness
  // concern, not the adapter's, and the adapter is never given this verb.
  await pool.query("TRUNCATE agent_ops.alerts_liveness_component");
};

const line = (s) => console.log(s);

// ---------------------------------------------------------------------------
// 1. The contract, against a real pool.
// ---------------------------------------------------------------------------
line("=== livenessStoreContract against live Postgres 16 ===");
const outcomes = await runLivenessStoreContract({
  open: () => postgresLivenessStore(sql),
  reset: truncate,
  durable: true,
});
let failures = 0;
for (const o of outcomes) {
  line(`${o.passed ? "PASS" : "FAIL"}  ${o.name}`);
  if (!o.passed) {
    failures += 1;
    line(`      ${o.error?.stack ?? String(o.error)}`);
  }
}

// ---------------------------------------------------------------------------
// 2. README item 2, exactly: write beats, DISCARD the store object entirely,
//    rebuild it, and confirm a watcher sees a real gap rather than never-seen.
// ---------------------------------------------------------------------------
line("");
line("=== README item 2: the restart ===");
await truncate();

const t0 = 1_700_000_000_000;
let now = t0;
const clock = { now: () => now };

// --- process 1 ---
{
  const store = postgresLivenessStore(sql);
  await store.watch("sweeper", 60_000, now);
  const heartbeat = createHeartbeat({ store, clock });
  await heartbeat.beat({ component: "sweeper", run: { ran: "nothing-was-due" } });
  now += 60_000;
  await heartbeat.beat({ component: "sweeper", run: { ran: "did-work", itemsProcessed: 9 } });
  now += 60_000;
  await heartbeat.beat({ component: "sweeper", run: { ran: "nothing-was-due" } });
  // A second component that was watched and NEVER beat, so the two statuses can
  // be told apart in the same snapshot.
  await store.watch("reconciler", 60_000, t0);
}
const lastBeatAt = now;

// --- the process dies. Every reference to the store is gone. ---
globalThis.gc?.();

// --- process 2, one hour later ---
now += 3_600_000;
const revived = postgresLivenessStore(sql);
const query = livenessQuery({ store: revived });
const records = await query.records();
const findings = livenessFindings(records, now, { graceMs: 30_000 });

for (const f of findings) {
  line(`  ${f.component.padEnd(12)} ${f.status}`);
}
const sweeper = findings.find((f) => f.component === "sweeper");
const reconciler = findings.find((f) => f.component === "reconciler");

const checks = [
  ["a restarted watcher sees a GAP, not never-seen", sweeper?.status === "overdue"],
  ["the gap carries the real last-seen instant", sweeper?.lastSeenAt === lastBeatAt],
  ["the gap carries the real beat count", sweeper?.beats === 3],
  [
    "overdueByMs is measured from the last beat",
    sweeper?.overdueByMs === 3_600_000 - 60_000 - 30_000,
  ],
  ["a never-beaten component still reads never-seen", reconciler?.status === "never-seen"],
  [
    "the run union survived the round trip as nothing-was-due",
    records.find((r) => r.component === "sweeper")?.lastRun?.ran === "nothing-was-due" &&
      !Object.prototype.hasOwnProperty.call(
        records.find((r) => r.component === "sweeper").lastRun,
        "itemsProcessed",
      ),
  ],
  [
    "the counters survived: 2 empty, 1 working, 9 items",
    records.find((r) => r.component === "sweeper")?.emptyBeats === 2 &&
      records.find((r) => r.component === "sweeper")?.workingBeats === 1 &&
      records.find((r) => r.component === "sweeper")?.itemsProcessed === 9,
  ],
];
for (const [name, ok] of checks) {
  line(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// 3. The schema's own guarantees, which only a real cluster can show.
// ---------------------------------------------------------------------------
line("");
line("=== schema guarantees (only a real cluster can show these) ===");


const schemaChecks = [];

/**
 * Run one attack in its own transaction and always roll it back.
 *
 * Two things this fixes, both learned by watching the first version fail:
 *
 *  1. **Each attack must not mutate state for the next one.** The DELETE attack
 *     below succeeds when this script connects as the table owner — grants do
 *     not bind an owner — and the row it removed was the row the next two
 *     attacks targeted. An UPDATE matching zero rows succeeds, and an INSERT of
 *     a since-deleted key succeeds, so one genuine finding became three, two of
 *     them false. Rolling back means an attack can only ever report on itself.
 *
 *  2. **A grant is only refused for a role that holds the grant.** `SET LOCAL
 *     ROLE` steps out of the owner for exactly the attacks that are about
 *     grants; the CHECK constraints bind everyone including the owner, so those
 *     run as-is. Asserting a grant while connected as the owner tests nothing
 *     and passes for the wrong reason.
 */
const attack = async (name, statement, params, expect) => {
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    if (expect.asRole) await conn.query(`SET LOCAL ROLE ${expect.asRole}`);
    await conn.query(statement, params);
    schemaChecks.push([name, false, "the database ACCEPTED it"]);
  } catch (error) {
    schemaChecks.push([
      name,
      error.code === expect.sqlstate,
      `${error.code}${error.constraint ? " " + error.constraint : ""}`,
    ]);
  } finally {
    await conn.query("ROLLBACK").catch(() => {});
    conn.release();
  }
};

// A row to attack, written through the adapter so the attacks run against a
// real record rather than one hand-built for them.
await truncate();
{
  const seed = postgresLivenessStore(sql);
  await seed.watch("sweeper", 60_000, 0);
  await seed.beat("sweeper", 1_000, { ran: "did-work", itemsProcessed: 3 });
}

// The writer role has no DELETE, ever. Un-watching a component is a deployment
// change, not a verb this library holds all day.
await attack(
  "the writer role cannot DELETE a liveness row",
  "DELETE FROM agent_ops.alerts_liveness_component WHERE component = $1",
  ["sweeper"],
  { sqlstate: "42501", asRole: "agent_ops_alerts_writer" },
);

// The HeartbeatRun union, enforced by the database and not by the adapter
// alone: "I did nothing" must not be spellable as "I did zero things".
await attack(
  "'nothing-was-due' cannot carry an item count",
  "UPDATE agent_ops.alerts_liveness_component SET last_run_kind = 'nothing-was-due', last_run_items = 0 WHERE component = $1",
  ["sweeper"],
  { sqlstate: "23514" },
);

await attack(
  "a cadence of zero is refused",
  "INSERT INTO agent_ops.alerts_liveness_component (component, expected_every_ms, watching_since) VALUES ($1, 0, 0)",
  ["zero-cadence"],
  { sqlstate: "23514" },
);

// The primary key is what makes `watch` idempotent rather than duplicating.
await attack(
  "a component cannot be watched twice as two rows",
  "INSERT INTO agent_ops.alerts_liveness_component (component, expected_every_ms, watching_since) VALUES ($1, 60000, 0)",
  ["sweeper"],
  { sqlstate: "23505" },
);

// Beats must add up: a hand-edited counter is refused.
await attack(
  "a hand-edited beat count is refused",
  "UPDATE agent_ops.alerts_liveness_component SET beats = beats + 5 WHERE component = $1",
  ["sweeper"],
  { sqlstate: "23514" },
);

// A row with beats and no last-seen instant is not decodable, and cannot be
// written from a psql prompt either.
await attack(
  "beats without a last-seen instant are refused",
  "UPDATE agent_ops.alerts_liveness_component SET last_seen_at = NULL WHERE component = $1",
  ["sweeper"],
  { sqlstate: "23514" },
);

for (const [name, ok, detail] of schemaChecks) {
  line(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// 4. Concurrency: the row lock IS the critical section.
// ---------------------------------------------------------------------------
line("");
line("=== concurrent writers against one row ===");
await truncate();
const concurrent = postgresLivenessStore(sql, { maxPendingWrites: 64 });
await concurrent.watch("hot", 1_000, 0);
const results = await Promise.all(
  Array.from({ length: 50 }, (_, i) =>
    concurrent.beat("hot", 1_000 + i, i % 2 === 0 ? { ran: "nothing-was-due" } : { ran: "did-work", itemsProcessed: 1 }),
  ),
);
const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
const final = (await concurrent.snapshot()).find((r) => r.component === "hot");
const concurrencyChecks = [
  ["50 concurrent beats produced 50 distinct sequences", new Set(sequences).size === 50],
  ["the sequences are exactly 1..50 with no gap and no repeat", sequences.every((s, i) => s === i + 1)],
  ["every beat was counted", final?.beats === 50],
  ["the counters agree with the beats", final?.emptyBeats + final?.workingBeats === 50],
  ["last-seen is the highest instant, never the last writer's", final?.lastSeen.at === 1_049],
];
for (const [name, ok] of concurrencyChecks) {
  line(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures += 1;
}

// A backwards beat from a skewed host, against the live server's GREATEST.
await concurrent.beat("hot", 1, { ran: "nothing-was-due" });
const clamped = (await concurrent.snapshot()).find((r) => r.component === "hot");
const clampOk = clamped?.lastSeen.at === 1_049 && clamped?.beats === 51;
line(`${clampOk ? "PASS" : "FAIL"}  a beat from a host with a skewed clock does not move last-seen backwards`);
if (!clampOk) failures += 1;

// Two composition roots disagreeing about a cadence, through the live upsert.
let conflictOk = false;
try {
  await concurrent.watch("hot", 9_999, 0);
} catch (error) {
  conflictOk = error instanceof LivenessTermsConflict && error.watching === 1_000 && error.offered === 9_999;
}
line(`${conflictOk ? "PASS" : "FAIL"}  a second composition root offering a different cadence is refused, and the stored one wins`);
if (!conflictOk) failures += 1;

line("");
line(failures === 0 ? "ALL GREEN" : `${failures} FAILURE(S)`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
