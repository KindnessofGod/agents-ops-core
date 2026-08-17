import { readdir, readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createEvalRecorder,
  defineSubject,
  determine,
  exactVerdict,
  ProviderUnavailable,
  run,
  runKeyOf,
  scriptedModelBackend,
  seed as makeSeed,
  sqlEvalNodeStore,
  sqlRunLedger,
  systemTimers,
} from "../index.js";
import type {
  Clock,
  EvalNodeStore,
  EvalRecorder,
  ModelBackend,
  RunLedger,
  RunSpec,
  SqlExecutor,
  SqlRow,
} from "../index.js";
import {
  passthroughRedactor,
  priceTable,
  PROMPT_V1,
  smallLimits,
  TEST_MODEL,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/**
 * `evals` against a real Postgres — the second half of `README.md` item 5, for
 * this module's own store.
 *
 * ## What was missing, exactly
 *
 * `sqlEvalNodeStore` and `sqlRunLedger` are the second adapters of two seams,
 * and every test that exercised them stood a hand-written fake where Postgres
 * stands. A fake answers the statements it was written to answer. It does not
 * hold a primary key, does not take an advisory lock, does not enforce a check
 * constraint, does not refuse a grant it was never given, and — the one that
 * matters most here — does not tell you whether `migrations/0004_eval_store.sql`
 * and `migrations/0005_eval_ledger.sql` describe the tables the adapters
 * actually write. Both migrations existed and **nothing had ever run against
 * them**, so "the module reads and writes its own eval store" was a claim about
 * TypeScript.
 *
 * This file makes it a claim about a database. It applies the migrations, runs a
 * whole evaluation end to end through the SQL adapters, reads the graph back,
 * then **throws the store away and builds a new one over a new connection pool**
 * and proves the interrupted run resumes from the ledger instead of paying for
 * the cases that already finished.
 *
 * ## It runs as the least-privileged role, not as the owner
 *
 * The adapter's pool connects with `-c role=agent_ops_eval_writer`, so every
 * statement in every case below is executed by the role
 * `migrations/0004_eval_store.sql` creates, with exactly the grants that file
 * gives it. A run that completes is therefore evidence that those grants are
 * sufficient, and `the two stores are two roles` is checked rather than asserted:
 * one case has this role attempt a write to `audit`'s trace and lose.
 *
 * ## The hermetic rule, and exactly what this file does and does not change
 *
 * `CLAUDE.md`: hermeticity is structural, through dependency injection, "not by
 * convention and not by an environment variable". The **library** is untouched
 * by this file: no module under `packages/agent-ops-core/src` imports a driver,
 * `sqlEvalNodeStore` and `sqlRunLedger` still take an injected `SqlExecutor`,
 * and `pg` is a devDependency of the workspace ROOT — absent from
 * `packages/agent-ops-core/package.json`, so it is not a dependency any of the
 * nineteen applications inherits.
 *
 * What this file changes is narrower, and is stated plainly rather than argued
 * away: **with `AGENT_OPS_LIVE_DATABASE_URL` set, this one file opens a socket
 * to a database.** Three things bound that, and they are the same three that
 * bound `audit/tests/live-postgres.test.ts`:
 *
 *   1. **It is a database and nothing else.** No model client and no pager is
 *      constructible from anything imported here. The guarantee that matters
 *      most — a test cannot reach a live model or a real pager with real
 *      credentials present — is untouched, because there is still no code path
 *      in this package that reaches either. The subject below is a
 *      `scriptedModelBackend`, which is the only `ModelBackend` this package
 *      ships and cannot dial anything.
 *   2. **The driver is not loaded at all unless the variable is set.** The
 *      import is dynamic and lives inside the gate. Unset — every default run,
 *      every `npm run check` — `pg` is never imported, no pool is constructed
 *      and nothing is opened. The in-memory path in every other file in this
 *      folder is not weakened by a line: `idempotency.test.ts` proves the same
 *      resume behaviour with `inMemoryEvalNodeStore` and `inMemoryRunLedger` and
 *      is unchanged.
 *   3. **The variable is a connection string, supplied deliberately.** There is
 *      no default, no fallback to `localhost`, and no reading of
 *      `AGENT_OPS_DATABASE_URL` — the compose file's variable — so a developer
 *      with a `.env` sourced does not silently start opening sockets from
 *      `npm test`.
 *
 * ## Skipping and failing are different answers
 *
 * **No variable — skip, cleanly.** That is the "no database is reachable" case.
 * **A variable that does not work — fail, loudly.** A string that cannot
 * connect, or a database holding eval runs this suite did not write, is a
 * misconfiguration; skipped silently it would be a job that passed green for a
 * year while proving nothing.
 *
 * ## Point it at a database you can throw away
 *
 * This suite APPLIES EVERY MIGRATION in `./migrations` to the database it is
 * given, and it **expires every eval run and every ledger memo it finds** before
 * it starts, through the module's own bounded retention verb. It refuses to
 * start if it finds a run it did not write.
 *
 *   docker compose up -d
 *   AGENT_OPS_LIVE_DATABASE_URL=postgres://postgres:postgres@localhost:5433/agent_ops \
 *     npx vitest run packages/agent-ops-core/src/evals/tests/live-postgres.test.ts
 *
 * The connection must be one that can apply migrations and can assume
 * `agent_ops_eval_writer` — the owner of the tables, or a superuser. Without it
 * the grant cases would pass for the wrong reason, which is worse than skipping.
 */

const LIVE_URL = process.env["AGENT_OPS_LIVE_DATABASE_URL"];

/**
 * The gate. `describe.skip` registers the suite and runs none of it, so an
 * ordinary run reports these cases as skipped — visible and countable, rather
 * than a file that quietly does not exist. Nothing inside the body executes,
 * which is why the driver import lives in `beforeAll`.
 */
const live = LIVE_URL === undefined ? describe.skip : describe;

/** Everything this run writes carries this label, so it is identifiable. */
const RUN_LABEL = `live-test:${randomUUID()}`;

/** Walk up from this file until a directory holding `migrations/` turns up. */
const migrationsDir = async (): Promise<string> => {
  let here = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 12; up += 1) {
    const candidate = join(here, "migrations");
    try {
      await access(candidate);
      return candidate;
    } catch {
      here = resolve(here, "..");
    }
  }
  throw new Error("could not find the migrations directory above this test file");
};

/**
 * The injected clock. Distinct per simulated process and monotonic within one,
 * because a run identifier is minted from the clock and the store's primary key
 * is what stops two runs sharing one.
 */
const clockFrom = (start: number): Clock => {
  let now = start;
  return {
    now: () => {
      now += 1;
      return now;
    },
  };
};

/** The suite, with each case's reference in its input so the fake can see it. */
const suite = () => {
  const base = threeInvoices();
  return { ...base, cases: base.cases.map((c) => ({ ...c, input: { ...c.input, ref: c.ref } })) };
};

const subject = defineSubject({
  version: testSubjectVersion,
  purity: "calls-models",
  decide: async (ctx) => {
    const answer = await ctx.client.complete({
      model: TEST_MODEL,
      promptVersion: PROMPT_V1,
      prompt: { ref: String(ctx.input["ref"] ?? "") },
    });
    return determine(answer.text, 9_000);
  },
});

/** A provider that refuses the third case until it is told to stop. */
const flakyProvider = (): {
  readonly state: { calls: number; refuse: boolean };
  readonly backend: ModelBackend;
} => {
  const state = { calls: 0, refuse: true };
  const backend = scriptedModelBackend({
    id: "flaky",
    answer: (request) => {
      state.calls += 1;
      if (state.refuse && request.prompt["ref"] === "INV-0003") {
        throw new ProviderUnavailable("test-model", "429 Too Many Requests", null);
      }
      return { text: "duplicate", tokensIn: 10, tokensOut: 2 };
    },
  });
  return { state, backend };
};

/**
 * One spec per case, keyed by a distinct seed.
 *
 * The run key content-addresses the seed, so this is what keeps the cases below
 * independent of each other in a way an in-memory ledger gets for free by being
 * a fresh object: they share one database, and two cases sharing a run key would
 * mean the second one silently returning the first one's memo.
 */
const specFor = (models: ModelBackend, forCase: string): Omit<RunSpec<"golden">, "recorder"> => ({
  label: RUN_LABEL,
  cases: suite(),
  subject,
  scorers: [exactVerdict],
  models,
  seed: makeSeed(`live-${forCase}`),
  // `maxCaseFailures: 0`, so the first refusal ends the run — a rate-limit storm
  // at scale, only sooner.
  limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 0 },
  priceTable,
});

live("evals — the SQL adapters against a real Postgres", () => {
  let admin: Pool;
  let PgPool: typeof import("pg").Pool;
  /** Every pool this suite opened, so `afterAll` can close all of them. */
  const pools: Pool[] = [];

  /**
   * One simulated process: its own connection pool, its own node store, its own
   * ledger handle, its own recorder. `end()` is the process dying.
   */
  interface Process {
    readonly pool: Pool;
    readonly store: EvalNodeStore;
    readonly ledger: RunLedger;
    readonly recorder: EvalRecorder;
    kill(): Promise<void>;
  }

  /**
   * The injected `SqlExecutor`, over a real pool. This is the whole of the
   * driver-facing code: the library supplies none, because a database driver is
   * a dependency nineteen applications would inherit.
   */
  const executorFor = (pool: Pool): SqlExecutor => ({
    async query(text, params) {
      const result = await pool.query(text, params as unknown[]);
      return { rows: result.rows as readonly SqlRow[] };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({
          async query(text, params) {
            const result = await client.query(text, params as unknown[]);
            return { rows: result.rows as readonly SqlRow[] };
          },
          transaction: async (inner) => inner(this as unknown as SqlExecutor),
        });
        await client.query("COMMIT");
        return out;
      } catch (cause) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw cause;
      } finally {
        client.release();
      }
    },
  });

  let processes = 0;
  const newProcess = (): Process => {
    processes += 1;
    const pool = new PgPool({
      connectionString: LIVE_URL,
      // Every statement below runs as the role 0004 creates, with exactly the
      // grants that file gives it — not as the owner, whom grants do not bind.
      options: "-c role=agent_ops_eval_writer",
      // Bounded, like everything else here. A test suite that can open an
      // unbounded number of connections can take a database down, and the
      // concurrency case below deliberately races.
      max: 8,
      connectionTimeoutMillis: 5_000,
    });
    pools.push(pool);
    const sql = executorFor(pool);
    const store = sqlEvalNodeStore(sql);
    const ledger = sqlRunLedger(sql);
    return {
      pool,
      store,
      ledger,
      recorder: createEvalRecorder({
        store,
        // A later process starts later. Two runs of one key opened in the same
        // millisecond would mint the same run identifier and collide on the
        // store's primary key — which is a real property of the identifier
        // scheme, not something to paper over with a random clock here.
        clock: clockFrom(1_700_000_000_000 + processes * 1_000_000),
        redact: passthroughRedactor,
        timers: systemTimers(),
        ledger,
      }),
      kill: async () => {
        await pool.end();
      },
    };
  };

  beforeAll(async () => {
    // The driver import, dynamic and inside the gate. With the variable unset
    // this line is never reached and `pg` is never loaded.
    const pg = await import("pg");
    PgPool = pg.Pool;
    admin = new PgPool({ connectionString: LIVE_URL, max: 4, connectionTimeoutMillis: 5_000 });
    pools.push(admin);

    const dir = await migrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain("0004_eval_store.sql");
    expect(files).toContain("0005_eval_ledger.sql");
    for (const file of files) {
      await admin.query(await readFile(join(dir, file), "utf8"));
    }

    await refuseIfNotThrowaway(admin);
    await requireWriterRole(admin);
    await clearPreviousRuns();
  }, 60_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end().catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  /** Refuse a database holding eval runs this suite did not write. */
  async function refuseIfNotThrowaway(p: Pool): Promise<void> {
    const { rows } = await p.query<{ readonly label: string }>(
      `SELECT label FROM agent_ops.eval_run WHERE label NOT LIKE 'live-test:%' LIMIT 1`,
    );
    if (rows.length > 0) {
      throw new Error(
        "AGENT_OPS_LIVE_DATABASE_URL points at a database holding eval runs this suite " +
          `did not write (for example ${String(rows[0]?.label)}). It expires every run it ` +
          "finds. Point it at a throwaway database.",
      );
    }
  }

  /**
   * The adapter pools connect as `agent_ops_eval_writer`. A connection that
   * cannot assume that role is a misconfiguration and is a loud failure rather
   * than a skip: running the cases as the owner would prove the grants are
   * sufficient without ever consulting them.
   */
  async function requireWriterRole(p: Pool): Promise<void> {
    const { rows } = await p.query<{ readonly member: boolean }>(
      `SELECT pg_has_role(current_user, 'agent_ops_eval_writer', 'USAGE') AS member`,
    );
    if (rows[0]?.member !== true) {
      throw new Error(
        "the live connection cannot assume agent_ops_eval_writer, so the adapter pools " +
          "would connect as the owner and the grants in 0004_eval_store.sql would never " +
          "be consulted. Run `GRANT agent_ops_eval_writer TO <role>` first.",
      );
    }
  }

  /**
   * Clear anything a previous invocation left, through the module's own bounded
   * retention verbs rather than by hand — which is also the first live exercise
   * of the two `expireBefore` statements, neither of which had ever been parsed
   * by Postgres.
   */
  async function clearPreviousRuns(): Promise<void> {
    const sql = executorFor(admin);
    const store = sqlEvalNodeStore(sql);
    const ledger = sqlRunLedger(sql);
    // Bounded: at most 100 batches of 1000. A cleanup loop with no ceiling is
    // the same bug as an unbounded retry.
    for (let batch = 0; batch < 100; batch += 1) {
      const runs = await store.expireBefore(Number.MAX_SAFE_INTEGER, 1_000);
      const memos = await ledger.expireBefore(Number.MAX_SAFE_INTEGER, 1_000);
      if (runs.runs === 0 && memos.runKeys === 0) return;
    }
    throw new Error("could not clear the eval tables in 100 bounded batches");
  }

  // -------------------------------------------------------------------------
  // 1. A whole evaluation, end to end, in Postgres
  // -------------------------------------------------------------------------

  describe("a whole evaluation, written to and read back from Postgres", () => {
    it("runs, records a graph, and returns the same graph through the store", async () => {
      const process1 = newProcess();
      const { state, backend } = flakyProvider();
      state.refuse = false;

      const report = await run({ ...specFor(backend, "end-to-end"), recorder: process1.recorder });

      expect(report.partial).toBe(false);
      expect(report.casesRun).toBe(3);
      expect(report.correctBasisPoints).toBe(10_000);
      expect(report.memoisation.kind).toBe("fresh");
      expect(state.calls).toBe(3);

      // Read back through the interface. Every node is decoded rather than cast:
      // a row this build cannot read is `UnreadableEnvelope`, not a
      // plausible-looking node.
      const stored = await process1.store.read(report.runId);
      expect(stored).toBeDefined();
      if (stored === undefined) throw new Error("unreachable");
      expect(stored.header.label).toBe(RUN_LABEL);
      expect(stored.header.sourceKind).toBe("golden");
      expect(stored.header.capturedVia).toBe("injected-client-only");
      expect(stored.nodes.length).toBeGreaterThan(3);
      // Every node settled: `closed_at` written by the `UPDATE` grant that
      // `audit`'s writer deliberately does not have.
      expect(stored.nodes.every((n) => n.closedAt !== null)).toBe(true);
      expect(stored.nodes.map((n) => n.sequence)).toEqual(
        stored.nodes.map((_, index) => index),
      );

      // And the same figures, read as rows rather than through the adapter that
      // wrote them — so this is evidence about the database and not about a
      // round trip through one object.
      const rows = await admin.query<{ readonly n: string }>(
        `SELECT count(*) AS n FROM agent_ops.eval_node WHERE run_id = $1`,
        [report.runId],
      );
      expect(Number(rows.rows[0]?.n)).toBe(stored.nodes.length);

      const header = await admin.query<{ readonly source_digest: string }>(
        `SELECT source_digest FROM agent_ops.eval_run WHERE run_id = $1`,
        [report.runId],
      );
      expect(header.rows[0]?.source_digest).toBe(report.suiteDigest);

      // The memo the ledger wrote for the completed run, as a row.
      const memo = await admin.query<{ readonly n: string }>(
        `SELECT count(*) AS n FROM agent_ops.eval_run_memo WHERE run_key = $1`,
        [report.runKey],
      );
      expect(Number(memo.rows[0]?.n)).toBe(1);

      await process1.kill();
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // 2. Kill the store, rebuild it, resume
  // -------------------------------------------------------------------------

  describe("an interrupted run, resumed by a process that has never seen the first", () => {
    it("resumes from the ledger rather than re-executing, after the store is thrown away", async () => {
      const { state, backend } = flakyProvider();

      // Attempt one. Two cases finish; the provider refuses the third; the
      // failure budget ends the run. Then the process dies.
      const first = newProcess();
      const crashed = await run({ ...specFor(backend, "resume"), recorder: first.recorder });
      expect(crashed.partial).toBe(true);
      expect(crashed.couldNotEvaluateBasisPoints).toBeGreaterThan(0);
      expect(state.calls).toBe(3);
      await first.kill();
      // The pool is closed. Nothing this process held survives.
      await expect(first.store.read(crashed.runId)).rejects.toThrow();

      const key = runKeyOf(specFor(backend, "resume"));

      // What survived is in the database, and it is exactly the right amount.
      // **The partial report was not memoised as complete** — memoised, a biased
      // sample would be returned by every later run of this key, instantly,
      // looking exactly like a finished run because it is the same type.
      const completed = await admin.query<SqlRow>(
        `SELECT * FROM agent_ops.eval_run_memo WHERE run_key = $1`,
        [key],
      );
      expect(completed.rows).toHaveLength(0);
      // The two cases that genuinely finished were memoised; the one the
      // provider refused was not — that is a fact about ten minutes on a
      // Tuesday, and freezing it would make it permanent for this key.
      const cases = await admin.query<{ readonly case_ref: string }>(
        `SELECT case_ref FROM agent_ops.eval_case_memo WHERE run_key = $1 ORDER BY case_ref`,
        [key],
      );
      expect(cases.rows.map((r) => r.case_ref)).toEqual(["INV-0001", "INV-0002"]);

      // Attempt two: a new pool, a new store, a new ledger handle, a new
      // recorder. It has never seen the first run's objects — only its rows.
      state.refuse = false;
      const second = newProcess();
      const resumed = await run({ ...specFor(backend, "resume"), recorder: second.recorder });

      expect(resumed.partial).toBe(false);
      expect(resumed.correctBasisPoints).toBe(10_000);
      // One model call, not three. At 200 cases this is the difference between a
      // re-triggered build costing nothing extra and costing twice.
      expect(state.calls).toBe(4);
      expect(resumed.memoisation.kind).toBe("resumed");
      if (resumed.memoisation.kind !== "resumed") throw new Error("unreachable");
      expect(resumed.memoisation.cases).toEqual(["INV-0001", "INV-0002"]);

      // The trace says so, in Postgres. A carried-forward case is a real `case`
      // node stamped with the run and node it came from, so "this was not
      // observed today" is recorded rather than inferred from a suspiciously low
      // cost figure.
      const carried = await admin.query<{ readonly payload: Record<string, unknown> }>(
        `SELECT payload FROM agent_ops.eval_node
          WHERE run_id = $1 AND kind = 'case' AND payload->>'memoised' = 'true'
          ORDER BY sequence`,
        [resumed.runId],
      );
      expect(carried.rows).toHaveLength(2);
      expect(carried.rows[0]?.payload["memoisedFromRun"]).toBe(crashed.runId);

      // Attempt three: a third process, executing nothing at all. This is the
      // idempotent repeat — same artefact, not a fresh run that happens to
      // agree.
      const third = newProcess();
      const repeated = await run({ ...specFor(backend, "resume"), recorder: third.recorder });
      expect(repeated.runId).toBe(resumed.runId);
      expect(repeated.traceDigest).toBe(resumed.traceDigest);
      expect(repeated.startedAt).toBe(resumed.startedAt);
      expect(state.calls).toBe(4);

      await second.kill();
      await third.kill();
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // 3. What only a real database can be asked
  // -------------------------------------------------------------------------

  describe("the guarantees that belong to Postgres, not to the adapter", () => {
    it("keeps the sequence a dense total order under eight concurrent writers", async () => {
      // The advisory lock, against a real lock manager. Without it two writers
      // under READ COMMITTED read the same `MAX(sequence)` and one insert loses
      // to the unique index — which is the failure the lock exists to prevent
      // and which no in-process fake can reproduce.
      const process1 = newProcess();
      const { state, backend } = flakyProvider();
      state.refuse = false;
      const report = await run({
        ...specFor(backend, "concurrency"),
        limits: { ...smallLimits, concurrency: 8, maxCaseFailures: 0 },
        recorder: process1.recorder,
      });
      const rows = await admin.query<{ readonly sequence: number; readonly n: string }>(
        `SELECT sequence, count(*) AS n FROM agent_ops.eval_node
          WHERE run_id = $1 GROUP BY sequence ORDER BY sequence`,
        [report.runId],
      );
      expect(rows.rows.map((r) => Number(r.sequence))).toEqual(
        rows.rows.map((_, index) => index),
      );
      expect(rows.rows.every((r) => Number(r.n) === 1)).toBe(true);
      await process1.kill();
    }, 60_000);

    it("refuses a second run under one identifier, rather than interleaving two", async () => {
      // The `eval_run` primary key. Two runs sharing an identifier would produce
      // one graph containing two runs' nodes, and every figure computed from it
      // would be wrong in a way nothing downstream could detect.
      const refused = await admin
        .query(
          `INSERT INTO agent_ops.eval_run
             (run_id, label, opened_at, source_kind, source_digest, subject_version,
              seed, envelope, redaction, captured_via)
           SELECT run_id, label, opened_at, source_kind, source_digest, subject_version,
                  seed, envelope, redaction, captured_via
             FROM agent_ops.eval_run LIMIT 1`,
        )
        .then(() => undefined)
        .catch((error: { code?: unknown }) => error);
      expect(refused).toBeDefined();
      expect((refused as { code?: unknown })?.code).toBe("23505");
    });

    it("refuses a source kind outside the union, so an unreadable row cannot be written", async () => {
      const refused = await admin
        .query(
          `INSERT INTO agent_ops.eval_run
             (run_id, label, opened_at, source_kind, source_digest, subject_version,
              seed, envelope, redaction, captured_via)
           VALUES ('check-1', $1, 1, 'invented', 'd', 'sv', 's', 'e', 'r', 'injected-client-only')`,
          [RUN_LABEL],
        )
        .then(() => undefined)
        .catch((error: { code?: unknown }) => error);
      // 23514 is check_violation. `source_kind` and `captured_via` are the two
      // columns a later build reads back as a union, and a row outside it would
      // be `UnreadableEnvelope` at read time rather than refused at write time.
      expect((refused as { code?: unknown })?.code).toBe("23514");
    });

    it("gives the eval writer the UPDATE and DELETE that audit's writer must never have", async () => {
      // The whole reason these tables are a separate role. `settle` needs
      // UPDATE, the 90-day retention needs DELETE, and `audit`'s writer holds
      // neither — a grant that exists is a grant that gets used, so 10M rows a
      // day of records of tests do not share a regulated archive's role.
      const writer = new PgPool({
        connectionString: LIVE_URL,
        options: "-c role=agent_ops_eval_writer",
        max: 2,
        connectionTimeoutMillis: 5_000,
      });
      pools.push(writer);

      const who = await writer.query<{ readonly u: string }>(`SELECT current_user AS u`);
      expect(who.rows[0]?.u).toBe("agent_ops_eval_writer");

      await writer.query(
        `INSERT INTO agent_ops.eval_run
           (run_id, label, opened_at, source_kind, source_digest, subject_version,
            seed, envelope, redaction, captured_via)
         VALUES ('grant-probe', $1, 1, 'golden', 'd', 'sv', 's', 'e', 'r', 'injected-client-only')`,
        [RUN_LABEL],
      );
      await writer.query(`UPDATE agent_ops.eval_run SET label = $1 WHERE run_id = 'grant-probe'`, [
        RUN_LABEL,
      ]);
      await writer.query(`DELETE FROM agent_ops.eval_run WHERE run_id = 'grant-probe'`);

      // And the same role cannot touch the audit trace. A trace never spans both.
      const refused = await writer
        .query(
          `INSERT INTO agent_ops.audit_trace_case
             (correlation_id, captured_via, canonical_form, redaction, opened_at_ms)
           VALUES ('eval-writer-probe', 'injected-trace-store-only', 'aoc.audit.node.v2', 'r', 1)`,
        )
        .then(() => undefined)
        .catch((error: { code?: unknown }) => error);
      // 42501 is insufficient_privilege.
      expect((refused as { code?: unknown })?.code).toBe("42501");
    }, 30_000);

    it("expires runs and their nodes in one bounded, atomic statement", async () => {
      // `expireBefore` is one statement with three common table expressions and
      // a `LIMIT`. Neither of its two implementations had ever been parsed by
      // Postgres, and a CTE that Postgres rejects is a 90-day retention that
      // silently never runs.
      const process1 = newProcess();
      const { state, backend } = flakyProvider();
      state.refuse = false;
      const report = await run({ ...specFor(backend, "expire"), recorder: process1.recorder });

      const before = await admin.query<{ readonly n: string }>(
        `SELECT count(*) AS n FROM agent_ops.eval_node WHERE run_id = $1`,
        [report.runId],
      );
      expect(Number(before.rows[0]?.n)).toBeGreaterThan(0);

      // The `LIMIT` is respected against a real planner: one run per batch, not
      // "everything older than the cutoff".
      const firstBatch = await process1.store.expireBefore(Number.MAX_SAFE_INTEGER, 1);
      expect(firstBatch.runs).toBe(1);
      expect(firstBatch.nodes).toBeGreaterThan(0);

      // Then drain, bounded, until this run is gone.
      let drained = 0;
      for (let batch = 0; batch < 50; batch += 1) {
        const removed = await process1.store.expireBefore(Number.MAX_SAFE_INTEGER, 1_000);
        drained += removed.runs;
        if (removed.runs === 0) break;
      }
      expect(drained).toBeGreaterThanOrEqual(0);
      expect(await process1.store.read(report.runId)).toBeUndefined();

      // Neither can outlive the other: a run row with no nodes reads as empty
      // rather than as expired, which is the one thing an expired trace must
      // not look like.
      const orphans = await admin.query<{ readonly n: string }>(
        `SELECT count(*) AS n FROM agent_ops.eval_node
          WHERE run_id NOT IN (SELECT run_id FROM agent_ops.eval_run)`,
      );
      expect(Number(orphans.rows[0]?.n)).toBe(0);
      const nodesLeft = await admin.query<{ readonly n: string }>(
        `SELECT count(*) AS n FROM agent_ops.eval_node WHERE run_id = $1`,
        [report.runId],
      );
      expect(Number(nodesLeft.rows[0]?.n)).toBe(0);

      await expect(process1.store.expireBefore(1, 0)).rejects.toThrow();
      await process1.kill();
    }, 60_000);
  });
});
