#!/usr/bin/env node
/**
 * Run every live-Postgres suite against a real database, and refuse to exit
 * zero unless they actually ran.
 *
 * ## The false green this exists to remove
 *
 * The live suites gate themselves on `AGENT_OPS_LIVE_DATABASE_URL` and use
 * `describe.skip` when it is unset. That is correct and must not change: it is
 * what keeps `npm test` hermetic, and what lets a machine with no database run
 * the whole suite and exit zero honestly.
 *
 * It is also the exact shape of a build that passes for a year while proving
 * nothing. A skipped grant test and a passing grant test look identical in a
 * summary line, and only one of them is evidence that append-only holds in the
 * database. So `vitest` keeps its clean skip and this runner does the opposite
 * job: it is the caller that has decided a database is present, and for it a
 * skip is a failure.
 *
 * ## Suites are discovered, not listed
 *
 * The list of live suites is a `readdir`, not a constant, so a suite added
 * tomorrow is picked up by an unchanged workflow. Two rules make discovery
 * safe:
 *
 *   - a live suite is `<module>/tests/live-*.test.ts`;
 *   - a test file that READS the gate variable but is not named that way is a
 *     hard error, not a warning, because discovery would never find it and it
 *     would silently never run.
 *
 * If no live suite exists at all, that is also a hard error: the runner's whole
 * purpose is to run them, and "there were none" is how a deletion looks.
 *
 * ## Why the suites run one file at a time
 *
 * Every live suite applies all of `./migrations` in its own `beforeAll`,
 * against one shared database. Vitest runs test FILES in parallel by default,
 * so three suites racing `CREATE`/`DROP TRIGGER` on the same tables deadlock —
 * observed, not theorised: `error: deadlock detected` out of `pg-pool`, in
 * whichever suite lost. `--no-file-parallelism` is therefore load-bearing, not
 * caution. It is also why `npm run check` must NOT be given the live
 * connection string: `check` runs all 86 files in parallel.
 *
 * ## Error modes, each named, each fail-closed, and why
 *
 * - `LiveDatabaseUrlMissing` — **fail-closed.** The one place in this
 *   repository where a missing database is an error rather than a skip.
 *   Anything else makes the continuous-integration job that exists to exercise
 *   the schema pass without touching it.
 * - `NoLiveSuitesDiscovered` — **fail-closed.** Zero suites run is not zero
 *   failures.
 * - `UngatedLiveSuiteNaming` — **fail-closed.** A gated file outside the naming
 *   convention is a suite nothing will ever run.
 * - `LiveSuiteSkipped` — **fail-closed.** Includes a whole file that reported no
 *   test at all: that is what the gate produces when the variable is set but
 *   the child process did not inherit it.
 * - `LiveSuiteFailed` — **fail-closed.** Vitest's own exit code, surfaced.
 * - `ReportUnreadable` — **fail-closed.** No report means no evidence, and a
 *   runner that cannot read its own evidence must not vouch for it.
 *
 * ## Bounds
 *
 * One child process, one file at a time, one wall-clock ceiling
 * (`AGENT_OPS_LIVE_TIMEOUT_MS`, default 600000). The database connections are
 * bounded inside the suites themselves (`max: 8`, `max: 4`).
 *
 * ## Usage
 *
 *   AGENT_OPS_LIVE_DATABASE_URL=postgres://agent_ops:agent_ops@localhost:5433/agent_ops \
 *     npm run test:live
 *
 * The connection must OWN the tables (or be a superuser) and be a member of
 * `agent_ops_writer`; two audit cases deliberately step out of the grants so
 * that the TRIGGER is the only thing left to refuse a write. See
 * `docs/RUNBOOK.md` §0A.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "packages", "agent-ops-core", "src");
const TIMEOUT_MS = Number(process.env["AGENT_OPS_LIVE_TIMEOUT_MS"] ?? "600000");

const fail = (mode, detail) => {
  process.stderr.write(`\nrun-live-postgres: ${mode}\n  ${detail}\n\n`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 1. The gate, inverted on purpose
// ---------------------------------------------------------------------------

const LIVE_URL = process.env["AGENT_OPS_LIVE_DATABASE_URL"];
if (LIVE_URL === undefined || LIVE_URL.trim() === "") {
  fail(
    "LiveDatabaseUrlMissing",
    "AGENT_OPS_LIVE_DATABASE_URL is unset. `npm test` skips the live suites " +
      "cleanly and that is correct; this runner does not, because it exists to " +
      "prove they ran. Point it at a THROWAWAY database — the suites apply " +
      "every migration and commit rows to an INSERT-only table.",
  );
}

// ---------------------------------------------------------------------------
// 2. Discovery
// ---------------------------------------------------------------------------

/** A read of the gate variable, as opposed to a mention of it in prose. */
const READS_GATE = /=\s*process\.env\[\s*"AGENT_OPS_LIVE_DATABASE_URL"\s*\]/;

const modules = (await readdir(SRC, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const discovered = [];
const misnamed = [];

for (const moduleName of modules) {
  const testsDir = join(SRC, moduleName, "tests");
  let entries;
  try {
    entries = await readdir(testsDir);
  } catch {
    continue; // A module with no tests is another lint's problem, not this one's.
  }
  for (const entry of entries.filter((e) => e.endsWith(".test.ts")).sort()) {
    const path = join(testsDir, entry);
    const isNamedLive = entry.startsWith("live-");
    if (isNamedLive) {
      discovered.push(path);
      continue;
    }
    if (READS_GATE.test(await readFile(path, "utf8"))) misnamed.push(path);
  }
}

if (misnamed.length > 0) {
  fail(
    "UngatedLiveSuiteNaming",
    `these files read AGENT_OPS_LIVE_DATABASE_URL but are not named live-*.test.ts, ` +
      `so discovery would never run them:\n    ${misnamed
        .map((p) => relative(REPO_ROOT, p))
        .join("\n    ")}`,
  );
}
if (discovered.length === 0) {
  fail(
    "NoLiveSuitesDiscovered",
    `no <module>/tests/live-*.test.ts under ${relative(REPO_ROOT, SRC)}. Zero suites ` +
      "run is not zero failures; the schema's own guarantees would be unproven.",
  );
}

process.stdout.write(
  `run-live-postgres: ${discovered.length} suite(s), one file at a time\n` +
    discovered.map((p) => `  ${relative(REPO_ROOT, p)}\n`).join(""),
);

// ---------------------------------------------------------------------------
// 3. Run
// ---------------------------------------------------------------------------

const scratch = await mkdtemp(join(tmpdir(), "agent-ops-live-"));
const reportPath = join(scratch, "live-report.json");

const exitCode = await new Promise((resolveExit) => {
  const child = spawn(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"),
      "run",
      // Load-bearing: see the header. Shared database, concurrent DDL, deadlock.
      "--no-file-parallelism",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
      ...discovered.map((p) => relative(REPO_ROOT, p)),
    ],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env },
  );
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    fail(
      "LiveSuiteFailed",
      `the live suites did not finish within ${TIMEOUT_MS}ms. Killed. A live suite ` +
        "that hangs is usually a database that accepted the connection and then " +
        "blocked on a lock held by another run.",
    );
  }, TIMEOUT_MS);
  timer.unref?.();
  child.on("exit", (code) => {
    clearTimeout(timer);
    resolveExit(code ?? 1);
  });
});

// ---------------------------------------------------------------------------
// 4. The assertion the exit code cannot make: they were not skipped
// ---------------------------------------------------------------------------

let report;
try {
  report = JSON.parse(await readFile(reportPath, "utf8"));
} catch (error) {
  await rm(scratch, { recursive: true, force: true });
  fail(
    "ReportUnreadable",
    `could not read the vitest JSON report at ${reportPath} ` +
      `(${error instanceof Error ? error.name : "unknown"}). vitest exited ${exitCode}. ` +
      "No report means no evidence that the suites ran.",
  );
}
await rm(scratch, { recursive: true, force: true });

// Failure first, then silence. A suite whose `beforeAll` threw reports no
// assertion at all, which is indistinguishable from a skip in the report and is
// not the same thing at all in the output the operator has to read.
if (exitCode !== 0 || report.success !== true) {
  fail(
    "LiveSuiteFailed",
    `vitest exited ${exitCode}; ${report.numFailedTests ?? "?"} test(s) failed, ` +
      `${report.numFailedTestSuites ?? "?"} suite(s) failed to start. The output above ` +
      "names which guarantee the database did not hold, or which preflight refused.",
  );
}

const ran = new Map(
  (report.testResults ?? []).map((file) => [resolve(REPO_ROOT, file.name), file]),
);

const silent = discovered.filter((p) => {
  const file = ran.get(resolve(p));
  return file === undefined || (file.assertionResults ?? []).length === 0;
});
const skippedIn = discovered.filter((p) => {
  const file = ran.get(resolve(p));
  return (file?.assertionResults ?? []).some(
    (a) => a.status === "pending" || a.status === "skipped" || a.status === "todo",
  );
});

if (silent.length > 0 || skippedIn.length > 0) {
  fail(
    "LiveSuiteSkipped",
    [
      silent.length > 0
        ? `reported no test at all: ${silent.map((p) => relative(REPO_ROOT, p)).join(", ")}`
        : undefined,
      skippedIn.length > 0
        ? `reported skipped tests: ${skippedIn.map((p) => relative(REPO_ROOT, p)).join(", ")}`
        : undefined,
      "AGENT_OPS_LIVE_DATABASE_URL was set for this runner, so the suites' own gate " +
        "should have opened. A whole file reporting nothing means the child process " +
        "did not inherit the variable.",
    ]
      .filter((line) => line !== undefined)
      .join("\n  "),
  );
}

process.stdout.write(
  `run-live-postgres: ${report.numPassedTests} test(s) passed against a live database, ` +
    `0 skipped, across ${discovered.length} suite(s)\n`,
);
