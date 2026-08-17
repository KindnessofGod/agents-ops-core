#!/usr/bin/env node
/**
 * Apply `./migrations` to a database, in filename order, once.
 *
 * ## Why this exists when `docker compose` already applies them
 *
 * `docker-compose.yml` mounts `./migrations` at
 * `/docker-entrypoint-initdb.d`, which Postgres runs **only the first time the
 * volume is created**. That is right for a laptop and useless everywhere else:
 * a continuous-integration Postgres container is a plain `postgres:16` with an
 * empty database and no mount, and a production database is applied to by an
 * operator holding a role the application does not have. Both need a runner.
 *
 * This is that runner, and it is deliberately the smallest one that can be
 * correct: read the directory, sort, execute each file whole, stop at the first
 * refusal, then prove the ledger agrees. It is not a migration framework. It
 * does not branch, roll back, or rewrite; each file in `./migrations` opens its
 * own `BEGIN` and records its own row in `agent_ops.schema_migrations`, so the
 * ledger is the migration's own claim about itself and this script only checks
 * that the claim was made.
 *
 * ## Re-running is expected, not tolerated
 *
 * Every migration in this repository is written to be applied twice — `CREATE
 * ... IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`, `INSERT
 * ... ON CONFLICT DO NOTHING`. Every live test suite re-applies all of them in
 * its own `beforeAll`, so a continuous-integration run applies every file once
 * per suite over again. If a migration ever stops being re-runnable, this is
 * where it will be noticed, on the second run, rather than in a deployment.
 *
 * ## Error modes, each named, each fail-closed, and why
 *
 * Every one of these exits non-zero. A migration runner has no degraded mode
 * worth having: a schema that is half-applied and reported green is how an
 * append-only guarantee turns out never to have existed.
 *
 * - `MigrationTargetUnspecified` — no connection string was given. **Fail-closed.**
 *   There is deliberately no default and no fallback to `localhost`: a runner
 *   that guesses its target applies data-definition language to whatever
 *   happens to be listening on port 5432.
 * - `MigrationDirectoryEmpty` — the directory holds no `.sql` file.
 *   **Fail-closed.** Zero migrations applied is indistinguishable from success
 *   at the exit code, and it is the shape a broken checkout takes.
 * - `MigrationFailed` — a file was refused by the database. **Fail-closed, and
 *   stops immediately.** Later files assume earlier ones; continuing past a
 *   refusal produces a schema no test in this repository has ever seen.
 * - `MigrationLedgerIncomplete` — a file ran without recording its version in
 *   `agent_ops.schema_migrations`. **Fail-closed.** The ledger is what an
 *   operator reads to answer "is this database current"; a file that does not
 *   record itself makes that answer a guess.
 * - `DriverUnavailable` — `pg` could not be imported. **Fail-closed.** `pg` is a
 *   devDependency of the workspace ROOT and is absent from the published
 *   package, exactly so that nineteen applications do not inherit a driver.
 *   Its absence means this was run outside the workspace, which is not
 *   supported and must not look like a clean database.
 *
 * ## Bounds
 *
 * One connection, not a pool. `statement_timeout` and `lock_timeout` are both
 * set, so a migration blocked behind somebody else's lock fails in seconds with
 * a named error rather than holding a build agent until it is killed.
 *
 * ## Usage
 *
 *   node scripts/apply-migrations.mjs postgres://user:pw@host:5432/db
 *   AGENT_OPS_MIGRATE_DATABASE_URL=postgres://… node scripts/apply-migrations.mjs
 *
 * The connection must be the role that OWNS (or may create) the tables — see
 * `docs/RUNBOOK.md` §0A. A member of `agent_ops_writer` cannot apply these
 * files and is not supposed to be able to.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");

/** Bounds. Milliseconds, integers. */
const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 120_000;
const LOCK_TIMEOUT_MS = 30_000;

/** Named, fail-closed exit. The name is the first word an operator reads. */
const fail = (mode, detail) => {
  process.stderr.write(`\napply-migrations: ${mode}\n  ${detail}\n\n`);
  process.exit(1);
};

const target = process.argv[2] ?? process.env["AGENT_OPS_MIGRATE_DATABASE_URL"];
if (target === undefined || target.trim() === "") {
  fail(
    "MigrationTargetUnspecified",
    "pass a connection string as the first argument, or set " +
      "AGENT_OPS_MIGRATE_DATABASE_URL. There is no default: a runner that " +
      "guesses applies DDL to whatever is listening.",
  );
}

let Client;
try {
  ({ Client } = await import("pg"));
} catch (error) {
  fail(
    "DriverUnavailable",
    `could not import "pg" (${error instanceof Error ? error.name : "unknown"}). ` +
      "It is a devDependency of the workspace root; run this from a checkout with " +
      "`npm ci` completed.",
  );
}

let files;
try {
  files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
} catch (error) {
  fail(
    "MigrationDirectoryEmpty",
    `could not read ${MIGRATIONS_DIR} (${error instanceof Error ? error.name : "unknown"})`,
  );
}
if (files.length === 0) fail("MigrationDirectoryEmpty", `no .sql file in ${MIGRATIONS_DIR}`);

const client = new Client({
  connectionString: target,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  statement_timeout: STATEMENT_TIMEOUT_MS,
  lock_timeout: LOCK_TIMEOUT_MS,
});

try {
  await client.connect();
} catch (error) {
  // The connection string is NOT echoed. It carries a password.
  fail(
    "MigrationFailed",
    `could not connect (${error instanceof Error ? error.name : "unknown"}: ` +
      `${error instanceof Error ? error.message : ""}). The connection string is not ` +
      "printed here because it carries a password.",
  );
}

const { rows: whoRows } = await client.query(
  "SELECT current_user AS who, current_database() AS db",
);
process.stdout.write(
  `apply-migrations: ${String(whoRows[0]?.who)}@${String(whoRows[0]?.db)}, ` +
    `${files.length} file(s), in filename order\n`,
);

for (const file of files) {
  const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
  const startedAt = Date.now();
  try {
    await client.query(sql);
  } catch (error) {
    await client.end().catch(() => undefined);
    fail(
      "MigrationFailed",
      `${file} was refused: ${error instanceof Error ? error.message : String(error)}\n` +
        "  Nothing after this file was attempted. Later migrations assume earlier ones.",
    );
  }
  process.stdout.write(`  applied ${file} (${Date.now() - startedAt}ms)\n`);
}

// The ledger check. Each migration inserts its own version; this asserts that
// every file we ran left the row it claims to leave.
const { rows: ledger } = await client.query(
  "SELECT version FROM agent_ops.schema_migrations",
);
const recorded = new Set(ledger.map((r) => String(r.version)));
const missing = files.map((f) => f.replace(/\.sql$/, "")).filter((v) => !recorded.has(v));
await client.end().catch(() => undefined);

if (missing.length > 0) {
  fail(
    "MigrationLedgerIncomplete",
    `applied without recording themselves in agent_ops.schema_migrations: ${missing.join(", ")}. ` +
      "Every migration must INSERT its own version, or `SELECT version FROM " +
      "agent_ops.schema_migrations` stops being an answer to \"is this database current\".",
  );
}

process.stdout.write(
  `apply-migrations: ledger agrees — ${recorded.size} version(s) recorded\n`,
);
