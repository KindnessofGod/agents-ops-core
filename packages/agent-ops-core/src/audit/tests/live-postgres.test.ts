import { readdir, readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  IdempotencyKeyConflict,
  createAudit,
  inMemoryTraceStore,
  postgresTraceStore,
  redactFields,
  runSqlExecutorContract,
  type CorrelationId,
  type SqlExecutor,
} from "../index.js";
import { mustRecord, testClock } from "./fixtures.js";

/**
 * The schema's own guarantees, attacked against a real Postgres — `README.md`
 * item 5.
 *
 * ## What was missing, exactly
 *
 * Everything else in this folder proves what the *adapters* do. The primary
 * key, the one-seal partial unique index, the parent foreign key, the DAG check,
 * the immutability triggers, the `INSERT`-only grants and — since 0007 — the
 * idempotency index are properties of **Postgres**, and no test here opened a
 * socket, so a green run was evidence about TypeScript and was not evidence that
 * append-only holds in the database. `postgres-store.test.ts` says so at its
 * foot, honestly, and that note is what this file exists to retire.
 *
 * It does not retire it by asserting that the constraints exist. It **attacks
 * them**: it issues the `UPDATE`, the `DELETE`, the second seal, the duplicate
 * sequence and the foreign parent, and asserts that Postgres refused each one,
 * with which SQLSTATE and by which named constraint. A test that reads
 * `pg_indexes` proves a migration ran. A test that loses to the index proves the
 * guarantee.
 *
 * ## The hermetic rule, and exactly what this file does and does not change
 *
 * `CLAUDE.md`: hermeticity is structural, through dependency injection, "not by
 * convention and not by an environment variable". That rule is about the
 * **library**, and the library is untouched: no module in
 * `packages/agent-ops-core/src` imports a driver, `postgresTraceStore` still
 * takes an injected `SqlExecutor`, and `pg` is a devDependency of the workspace
 * ROOT — it is absent from `packages/agent-ops-core/package.json`, so it is not
 * a dependency any of the nineteen applications inherits.
 *
 * What this file changes is narrower and is stated plainly rather than argued
 * away: **with `AGENT_OPS_LIVE_DATABASE_URL` set, this one file opens a socket
 * to a database.** Three things bound that:
 *
 *   1. **It is a database and nothing else.** No model client, no pager, no
 *      transport of any kind is constructible from anything imported here. The
 *      guarantee that matters most — a test cannot reach a live model or a real
 *      pager with real credentials present — is untouched, because there is
 *      still no code path in this package that reaches either.
 *   2. **The driver is not loaded at all unless the variable is set.** The
 *      import is dynamic and lives inside the gate. Unset — which is every
 *      default run, every `npm run check`, and every continuous-integration run
 *      that has not been given a database — `pg` is never imported, no pool is
 *      constructed and nothing is opened. The in-memory path in every other file
 *      in this folder is not weakened by a line.
 *   3. **The variable is a connection string, supplied deliberately.** It is not
 *      a `SKIP_NETWORK` flag inverted; there is no default, no fallback to
 *      `localhost`, and no reading of `AGENT_OPS_DATABASE_URL` — the development
 *      compose file's variable — precisely so that a developer with a `.env`
 *      sourced does not silently start opening sockets from `npm test`.
 *
 * The alternative was to leave item 5 open, which is what the previous release
 * chose, and it left the single most load-bearing guarantee in the library —
 * append-only, on seven years of regulated evidence — proven by nothing at all.
 *
 * ## Skipping and failing are different answers, and the line between them
 *
 * **No variable — skip, cleanly, exit zero.** That is every default run, and it
 * is the "no database is reachable" case in practice.
 *
 * **A variable that does not work — fail, loudly.** A connection string that
 * cannot connect, a database holding somebody's real cases, a connection that
 * does not own the tables: each of those is a misconfiguration, and each of them
 * skipped silently would be a continuous-integration job that passed green for a
 * year while proving nothing about the append-only guarantee. That is the exact
 * false green this file exists to remove, so it is the one thing the gate will
 * not do.
 *
 * ## Point it at a database you can throw away
 *
 * The suite APPLIES EVERY MIGRATION in `./migrations` to the database it is
 * given, and its round-trip cases COMMIT rows to `agent_ops.audit_trace_node`,
 * which is a table nothing in this library can ever delete from. It refuses to
 * start against a database holding cases it did not write — see
 * `refuseIfNotThrowaway` — but that guard is a courtesy and not a permission
 * system.
 *
 *   docker compose up -d
 *   AGENT_OPS_LIVE_DATABASE_URL=postgres://agent_ops:agent_ops@localhost:5433/agent_ops \
 *     npx vitest run packages/agent-ops-core/src/audit/tests/live-postgres.test.ts
 *
 * The connection must be the one that applied the migrations — the OWNER of the
 * tables, or a superuser. That is not a convenience: two of the cases below turn
 * the grants off (by running as the owner, whom grants do not bind) so that the
 * TRIGGER is the only thing left to refuse the write. Without an owner
 * connection those two cases would pass for the wrong reason, which is worse
 * than skipping them.
 */

const LIVE_URL = process.env["AGENT_OPS_LIVE_DATABASE_URL"];

/**
 * The gate. `describe.skip` registers the suite and runs none of it, so an
 * ordinary run reports these cases as skipped — visible and countable, rather
 * than a file that quietly does not exist. Nothing inside the body executes,
 * which is why the driver import lives in `beforeAll` and not at the top.
 */
const live = LIVE_URL === undefined ? describe.skip : describe;

/** Everything this run writes is prefixed with this, so it is identifiable. */
const RUN = `live-test:${randomUUID()}`;
const caseId = (name: string): CorrelationId => `${RUN}:${name}` as CorrelationId;

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

interface Refusal {
  /** The SQLSTATE the database returned. */
  readonly code: string;
  readonly message: string;
  /** The constraint or index that did the refusing, where Postgres names one. */
  readonly constraint: string | undefined;
}

live("audit — the Postgres schema refuses what it promises to refuse", () => {
  let pool: Pool;
  /** Filled in by the round-trip cases; reported so a reader sees what ran. */
  const evidence: string[] = [];

  beforeAll(async () => {
    // The driver import, dynamic and inside the gate. With the variable unset
    // this line is never reached and `pg` is never loaded.
    const { Pool: PgPool } = await import("pg");
    pool = new PgPool({
      connectionString: LIVE_URL,
      // Bounded, like everything else here. A test suite that can open an
      // unbounded number of connections is a test suite that can take a
      // database down, and two of the cases below deliberately race.
      max: 8,
      connectionTimeoutMillis: 5_000,
    });

    const dir = await migrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      await pool.query(await readFile(join(dir, file), "utf8"));
    }

    await refuseIfNotThrowaway(pool);
    await requireOwnerAndWriterMembership(pool);
  }, 60_000);

  afterAll(async () => {
    if (evidence.length > 0) {
      console.log(`live-postgres: ${evidence.length} attacks refused\n  ${evidence.join("\n  ")}`);
    }
    await pool?.end();
  });

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  /**
   * Refuse a database holding cases this run did not write.
   *
   * Not a permission system — anyone determined can point this anywhere — but it
   * is the difference between "I mistyped a connection string" costing nothing
   * and costing a migration applied to a live archive.
   */
  async function refuseIfNotThrowaway(p: Pool): Promise<void> {
    const { rows } = await p.query<{ readonly correlation_id: string }>(
      `SELECT correlation_id FROM agent_ops.audit_trace_case
       WHERE correlation_id NOT LIKE 'live-test:%' LIMIT 1`,
    );
    if (rows.length > 0) {
      throw new Error(
        "AGENT_OPS_LIVE_DATABASE_URL points at a database holding real cases " +
          `(for example ${String(rows[0]?.correlation_id)}). This suite applies migrations and ` +
          "commits rows to an INSERT-only table. Point it at a throwaway database.",
      );
    }
  }

  /**
   * Two of the cases below need the grants OUT of the way so the trigger is the
   * only thing that can refuse; the rest need the grants IN the way. Both need
   * this connection to be the table owner (or a superuser) and a member of
   * `agent_ops_writer`. A misconfigured connection is a loud failure rather than
   * a skip: a skipped grant test and a passing one look identical in a summary,
   * and only one of them is evidence.
   */
  async function requireOwnerAndWriterMembership(p: Pool): Promise<void> {
    const { rows } = await p.query<{
      readonly owns: boolean;
      readonly member: boolean;
    }>(
      `SELECT pg_has_role(current_user, (SELECT relowner FROM pg_class
                WHERE oid = 'agent_ops.audit_trace_node'::regclass), 'USAGE') AS owns,
              pg_has_role(current_user, 'agent_ops_writer', 'USAGE')          AS member`,
    );
    const row = rows[0];
    if (row?.owns !== true) {
      throw new Error(
        "the live connection does not own agent_ops.audit_trace_node. The trigger " +
          "cases need a connection the grants do not bind; connect as the role that " +
          "applied the migrations.",
      );
    }
    if (row.member !== true) {
      throw new Error(
        "the live connection is not a member of agent_ops_writer, so `SET LOCAL ROLE " +
          "agent_ops_writer` will fail and the grant cases cannot run. Run " +
          "`GRANT agent_ops_writer TO <role>` first.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // The attack harness
  // -------------------------------------------------------------------------

  const SEED_CASE = `INSERT INTO agent_ops.audit_trace_case
      (correlation_id, captured_via, canonical_form, redaction, opened_at_ms)
    VALUES ($1, 'injected-trace-store-only', 'aoc.audit.node.v2', 'seed', 1700000000000)`;

  const SEED_NODE = `INSERT INTO agent_ops.audit_trace_node
      (correlation_id, sequence, node_id, at_ms, tier, parent_sequence,
       payload_schema_version, redaction, kind, payload_canonical, node_canonical,
       is_seal, idempotency_key)
    VALUES ($1, $2, $3, 1700000000001, 'high', $4, 1, 'seed', $5, '{}', '{}', $6, $7)`;

  /**
   * One attack, in one transaction, rolled back.
   *
   * Rollback rather than cleanup, because there is no cleanup available: these
   * tables carry no DELETE grant for any role this library's migrations create,
   * which is the guarantee under test. A transaction that is never committed
   * leaves nothing behind and is re-runnable forever.
   */
  const attack = async (
    as: "writer" | "owner",
    body: (client: PoolClient) => Promise<void>,
  ): Promise<Refusal> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Two cases, so a parent can be borrowed from the wrong one.
      await client.query(SEED_CASE, [caseId("a")]);
      await client.query(SEED_CASE, [caseId("b")]);
      await client.query(SEED_NODE, [caseId("a"), 0, `${caseId("a")}#0`, null, "{}", false, null]);
      await client.query(SEED_NODE, [caseId("a"), 1, `${caseId("a")}#1`, 0, "{}", true, null]);
      await client.query(SEED_NODE, [caseId("b"), 0, `${caseId("b")}#0`, null, "{}", false, "key-1"]);
      if (as === "writer") await client.query("SET LOCAL ROLE agent_ops_writer");

      let refusal: Refusal | undefined;
      try {
        await body(client);
      } catch (error) {
        const e = error as { code?: unknown; message?: unknown; constraint?: unknown };
        refusal = {
          code: typeof e.code === "string" ? e.code : "(none)",
          message: typeof e.message === "string" ? e.message : String(error),
          constraint: typeof e.constraint === "string" ? e.constraint : undefined,
        };
      }
      if (refusal === undefined) {
        throw new Error("the database ACCEPTED a statement the schema promises to refuse");
      }
      evidence.push(`${refusal.code} ${refusal.constraint ?? ""} — ${refusal.message}`);
      return refusal;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  };

  // -------------------------------------------------------------------------
  // 1. The grants
  // -------------------------------------------------------------------------

  describe("the INSERT-only grants", () => {
    it("refuses UPDATE on a trace node for the writer role", async () => {
      const refusal = await attack("writer", async (client) => {
        await client.query(
          `UPDATE agent_ops.audit_trace_node SET tier = 'low'
           WHERE correlation_id = $1 AND sequence = 0`,
          [caseId("a")],
        );
      });
      // 42501 is insufficient_privilege. Not 23xxx, not P0001: the point of
      // this case is that the write is refused before any trigger runs, so a
      // dropped trigger would not silently open the door for the application's
      // own everyday credential.
      expect(refusal.code).toBe("42501");
      expect(refusal.message).toMatch(/permission denied/i);
    });

    it("refuses DELETE on a trace node for the writer role", async () => {
      const refusal = await attack("writer", async (client) => {
        await client.query(
          `DELETE FROM agent_ops.audit_trace_node WHERE correlation_id = $1`,
          [caseId("a")],
        );
      });
      expect(refusal.code).toBe("42501");
    });

    it("refuses TRUNCATE for the writer role", async () => {
      const refusal = await attack("writer", async (client) => {
        await client.query("TRUNCATE agent_ops.audit_trace_node");
      });
      expect(refusal.code).toBe("42501");
    });

    it("refuses UPDATE and DELETE on the case table too", async () => {
      const onUpdate = await attack("writer", async (client) => {
        await client.query(
          `UPDATE agent_ops.audit_trace_case SET redaction = 'none' WHERE correlation_id = $1`,
          [caseId("a")],
        );
      });
      const onDelete = await attack("writer", async (client) => {
        await client.query(`DELETE FROM agent_ops.audit_trace_case WHERE correlation_id = $1`, [
          caseId("a"),
        ]);
      });
      expect(onUpdate.code).toBe("42501");
      expect(onDelete.code).toBe("42501");
    });

    it("refuses the writer role write access to the witness, which is the whole mechanism", async () => {
      // `migrations/0003` grants INSERT on the witness to `agent_ops_witness`
      // and deliberately not to `agent_ops_writer`. A composition root that
      // wires the trace pool into `postgresWitness` must fail on the first
      // close rather than produce a witness nobody should believe.
      const refusal = await attack("writer", async (client) => {
        await client.query(
          `INSERT INTO agent_ops.audit_witness
             (correlation_id, digest, nodes_witnessed, witnessed_at_ms, witness_id)
           VALUES ($1, 'v1:sha256:00', 1, 1700000000000, 'nobody')`,
          [caseId("a")],
        );
      });
      expect(refusal.code).toBe("42501");
    });
  });

  // -------------------------------------------------------------------------
  // 2. The triggers — with the grants deliberately out of the way
  // -------------------------------------------------------------------------

  describe("the immutability triggers", () => {
    it("fires on UPDATE even for a role the grants do not stop", async () => {
      // Run as the OWNER. A table owner is not bound by the grants, which is
      // exactly the reader the trace exists for: somebody at a psql prompt with
      // more authority than the application has. The trigger is what is left.
      const refusal = await attack("owner", async (client) => {
        await client.query(
          `UPDATE agent_ops.audit_trace_node SET tier = 'low'
           WHERE correlation_id = $1 AND sequence = 0`,
          [caseId("a")],
        );
      });
      // P0001 is raise_exception — the trigger's own RAISE, not a privilege
      // check and not a constraint.
      expect(refusal.code).toBe("P0001");
      expect(refusal.message).toBe(
        "agent_ops audit trace is append-only: UPDATE on audit_trace_node is not permitted",
      );
    });

    it("fires on DELETE, on both trace tables and on the witness", async () => {
      const nodeDelete = await attack("owner", async (client) => {
        await client.query(`DELETE FROM agent_ops.audit_trace_node WHERE correlation_id = $1`, [
          caseId("a"),
        ]);
      });
      // The case table's own trigger. It fires BEFORE DELETE, so it raises
      // before the foreign key from the node table is ever consulted — which is
      // the point: closure is the existence of a seal row, so neither table
      // needs an UPDATE grant and neither may be deleted from.
      const caseDelete = await attack("owner", async (client) => {
        await client.query(`DELETE FROM agent_ops.audit_trace_case WHERE correlation_id = $1`, [
          caseId("a"),
        ]);
      });
      const witnessUpdate = await attack("owner", async (client) => {
        await client.query(
          `INSERT INTO agent_ops.audit_witness
             (correlation_id, digest, nodes_witnessed, witnessed_at_ms, witness_id)
           VALUES ($1, 'v1:sha256:00', 1, 1700000000000, 'nobody')`,
          [caseId("a")],
        );
        await client.query(
          `UPDATE agent_ops.audit_witness SET digest = 'v1:sha256:ff' WHERE correlation_id = $1`,
          [caseId("a")],
        );
      });

      expect(nodeDelete.code).toBe("P0001");
      expect(nodeDelete.message).toMatch(/append-only: DELETE on audit_trace_node/);
      expect(caseDelete.code).toBe("P0001");
      expect(witnessUpdate.code).toBe("P0001");
      expect(witnessUpdate.message).toMatch(/append-only: UPDATE on audit_witness/);
    });
  });

  // -------------------------------------------------------------------------
  // 3. The constraints
  // -------------------------------------------------------------------------

  describe("the constraints", () => {
    it("refuses a second seal on one case, by the partial unique index", async () => {
      const refusal = await attack("writer", async (client) => {
        await client.query(SEED_NODE, [
          caseId("a"),
          2,
          `${caseId("a")}#2`,
          null,
          "{}",
          true,
          null,
        ]);
      });
      expect(refusal.code).toBe("23505");
      expect(refusal.constraint).toBe("audit_trace_node_one_seal");
    });

    it("permits a non-seal node after the seal, which is what replay is for", async () => {
      // The honest half of the previous case, and the reason the seal check on
      // the read path exists. The partial unique index blocks a second
      // `is_seal` row and nothing else; an ordinary INSERT after the seal is
      // accepted by the database and caught by `TraceIncoherent` on replay.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(SEED_CASE, [caseId("after-seal")]);
        await client.query(SEED_NODE, [
          caseId("after-seal"), 0, `${caseId("after-seal")}#0`, null, "{}", true, null,
        ]);
        await client.query("SET LOCAL ROLE agent_ops_writer");
        await client.query(SEED_NODE, [
          caseId("after-seal"), 1, `${caseId("after-seal")}#1`, null, "{}", false, null,
        ]);
        const { rows } = await client.query<{ readonly n: string }>(
          `SELECT count(*)::text AS n FROM agent_ops.audit_trace_node WHERE correlation_id = $1`,
          [caseId("after-seal")],
        );
        expect(rows[0]?.n).toBe("2");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    });

    it("refuses a duplicate (correlation_id, sequence), by the primary key", async () => {
      const refusal = await attack("writer", async (client) => {
        await client.query(SEED_NODE, [
          caseId("a"),
          0,
          `${caseId("a")}#0-again`,
          null,
          "{}",
          false,
          null,
        ]);
      });
      expect(refusal.code).toBe("23505");
      expect(refusal.constraint).toBe("audit_trace_node_pkey");
    });

    it("refuses a parent that is a node of another case, by the foreign key", async () => {
      // Sequence 1 exists — on case A. It does not exist on case B, and it is
      // earlier than the row being written, so the `parent_sequence < sequence`
      // check passes and the FOREIGN KEY is the thing that has to refuse it.
      // This is the defect that used to brick a row permanently: the adapter
      // kept only the sequence half of the parent identifier, so a parent from
      // case A rebound to whichever node of case B held that sequence.
      const refusal = await attack("writer", async (client) => {
        await client.query(SEED_NODE, [
          caseId("b"),
          2,
          `${caseId("b")}#2`,
          1,
          "{}",
          false,
          null,
        ]);
      });
      expect(refusal.code).toBe("23503");
      expect(refusal.constraint).toBe("audit_trace_node_parent_fk");
    });

    it("refuses a parent that is not earlier, so the graph is acyclic in the database", async () => {
      const refusal = await attack("writer", async (client) => {
        await client.query(SEED_NODE, [caseId("b"), 1, `${caseId("b")}#1`, 1, "{}", false, null]);
      });
      expect(refusal.code).toBe("23514");
      expect(refusal.constraint).toBe("audit_trace_node_parent_is_earlier");
    });

    it("refuses a node for a case that was never opened, by the case foreign key", async () => {
      const refusal = await attack("writer", async (client) => {
        await client.query(SEED_NODE, [
          caseId("never-opened"), 0, "x#0", null, "{}", false, null,
        ]);
      });
      expect(refusal.code).toBe("23503");
    });

    it("refuses a tier outside the three, and a negative sequence", async () => {
      const badTier = await attack("writer", async (client) => {
        await client.query(
          `INSERT INTO agent_ops.audit_trace_node
             (correlation_id, sequence, node_id, at_ms, tier, parent_sequence,
              payload_schema_version, redaction, kind, payload_canonical,
              node_canonical, is_seal)
           VALUES ($1, 9, 'x', 1, 'catastrophic', NULL, 1, 'seed', 'k', '{}', '{}', false)`,
          [caseId("a")],
        );
      });
      const badSequence = await attack("writer", async (client) => {
        await client.query(SEED_NODE, [caseId("a"), -1, "x", null, "{}", false, null]);
      });
      expect(badTier.code).toBe("23514");
      expect(badSequence.code).toBe("23514");
    });

    it("refuses a second node under one idempotency key, by the 0007 partial unique index", async () => {
      const refusal = await attack("writer", async (client) => {
        await client.query(SEED_NODE, [
          caseId("b"),
          1,
          `${caseId("b")}#1`,
          0,
          "{}",
          false,
          "key-1",
        ]);
      });
      expect(refusal.code).toBe("23505");
      expect(refusal.constraint).toBe("audit_trace_node_idempotency");
    });

    it("permits the same idempotency key on a different case, because the scope is one case", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(SEED_CASE, [caseId("b")]);
        await client.query(SEED_CASE, [caseId("c")]);
        await client.query("SET LOCAL ROLE agent_ops_writer");
        await client.query(SEED_NODE, [caseId("b"), 0, "b#0", null, "{}", false, "key-1"]);
        await client.query(SEED_NODE, [caseId("c"), 0, "c#0", null, "{}", false, "key-1"]);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    });

    it("refuses an empty idempotency key, by the 0007 check constraint", async () => {
      const refusal = await attack("writer", async (client) => {
        await client.query(SEED_NODE, [caseId("b"), 1, "b#1", 0, "{}", false, ""]);
      });
      expect(refusal.code).toBe("23514");
      expect(refusal.constraint).toBe("audit_trace_node_idempotency_key_bounded");
    });
  });

  // -------------------------------------------------------------------------
  // 4. The adapter, against the real thing
  // -------------------------------------------------------------------------

  /**
   * The fifteen lines every composition root writes, written once here.
   *
   * This is the only implementation of `SqlExecutor` in the repository that
   * meets a driver, and it is deliberately in `tests/` rather than in `lib/`:
   * shipping it would mean `pg` becoming a dependency nineteen applications
   * inherit, which is the thing `SqlExecutor` exists to avoid.
   */
  const poolExecutor = (): SqlExecutor => {
    const executor: SqlExecutor = {
      query: async (text, params) => {
        const { rows } = await pool.query(text, [...params]);
        return { rows };
      },
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const onClient: SqlExecutor = {
            query: async (text, params) => {
              const { rows } = await client.query(text, [...params]);
              return { rows };
            },
            // Nested transactions are not what this contract describes; the
            // trace store never nests, so this is a defect rather than a shape
            // to support quietly.
            transaction: () => {
              throw new Error("SqlExecutor.transaction does not nest");
            },
          };
          const result = await fn(onClient);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          // Rethrown unchanged: `postgres-store.ts` classifies by SQLSTATE, and
          // wrapping it loses `code` and turns an integrity violation into a
          // reported outage.
          throw error;
        } finally {
          client.release();
        }
      },
    };
    return executor;
  };

  describe("the adapter, driving real SQL", () => {
    it("round-trips a case through Postgres and digests it identically to the in-memory adapter", async () => {
      // Nothing else in this package ever sends this adapter's SQL to a parser.
      // A column count that drifted, a function that is not installed, a type
      // that does not coerce — all of it passes the recording executor in
      // `postgres-store.test.ts` and fails here.
      const correlationId = caseId("round-trip");
      const audit = createAudit({
        store: postgresTraceStore(poolExecutor()),
        clock: testClock(1_700_000_000_000),
        redact: redactFields(["supplierAccount"]),
        onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
      });
      const memory = createAudit({
        store: inMemoryTraceStore(),
        clock: testClock(1_700_000_000_000),
        redact: redactFields(["supplierAccount"]),
        onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
      });

      for (const [subject, id] of [
        [audit, correlationId],
        [memory, correlationId],
      ] as const) {
        const trace = await subject.open(id);
        const parent = mustRecord(
          await trace.record({ kind: "invoice.extracted", v: 1, lines: 14 }, { tier: "low" }),
        ).node;
        await trace.record(
          {
            kind: "invoice.determined",
            v: 1,
            verdict: "pay",
            confidenceBasisPoints: 9_700,
            supplierAccount: "60-16-13 41234567",
          },
          {
            tier: "high",
            parent,
            telemetry: {
              costTenthCents: 412,
              tokensIn: 3_180,
              tokensOut: 240,
              latencyMicros: 1_284_000,
              priceTableVersion: "prices-2026-08",
            },
          },
        );
        await trace.close({ unassistedContainment: false });
      }

      const fromPostgres = await audit.replay(correlationId);
      const fromMemory = await memory.replay(correlationId);

      expect(fromPostgres.nodes).toHaveLength(3);
      expect(fromPostgres.closed).toBe(true);
      expect(fromPostgres.verify(fromPostgres.digest())).toBe(true);
      // Byte-identical evidence from two adapters. If these ever diverge, a case
      // migrated between stores stops verifying against its own digest.
      expect(String(fromPostgres.digest())).toBe(String(fromMemory.digest()));
      // Redaction ran before write, so the account number is not in the row.
      const { rows } = await pool.query<{ readonly payload_canonical: string }>(
        `SELECT payload_canonical FROM agent_ops.audit_trace_node
         WHERE correlation_id = $1 ORDER BY sequence`,
        [correlationId],
      );
      expect(rows.map((r) => r.payload_canonical).join("")).not.toContain("41234567");
    });

    it("refuses a second close through the adapter, and the index is what refuses it", async () => {
      const correlationId = caseId("second-close");
      const audit = createAudit({
        store: postgresTraceStore(poolExecutor()),
        clock: testClock(1_700_000_000_000),
        redact: redactFields([]),
        onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
      });
      const trace = await audit.open(correlationId);
      await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });
      await trace.close({ unassistedContainment: true });

      await expect(trace.close({ unassistedContainment: true })).rejects.toThrow(/closed/i);
      const { rows } = await pool.query<{ readonly n: string }>(
        `SELECT count(*)::text AS n FROM agent_ops.audit_trace_node
         WHERE correlation_id = $1 AND is_seal`,
        [correlationId],
      );
      expect(rows[0]?.n).toBe("1");
    });

    it("deduplicates a crash-retry against the real index, and writes no second row", async () => {
      const correlationId = caseId("dedupe");
      const clock = testClock(1_700_000_000_000);
      const audit = createAudit({
        store: postgresTraceStore(poolExecutor()),
        clock,
        redact: redactFields([]),
        onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
      });
      const trace = await audit.open(correlationId);
      const first = mustRecord(
        await trace.record(
          { kind: "invoice.determined", v: 1, verdict: "pay" },
          { tier: "high", idempotencyKey: "attempt-1" },
        ),
      );
      expect(first.deduplicated).toBe(false);

      // The restarted process. Later clock, same key, same append.
      clock.advance(5_000);
      const retry = mustRecord(
        await trace.record(
          { kind: "invoice.determined", v: 1, verdict: "pay" },
          { tier: "high", idempotencyKey: "attempt-1" },
        ),
      );
      expect(retry.deduplicated).toBe(true);
      expect(retry.node.at).toBe(first.node.at);
      expect((await audit.replay(correlationId)).nodes).toHaveLength(1);

      // And the key still names one append: a different payload under it is
      // refused rather than silently answered with the first node.
      await expect(
        trace.record(
          { kind: "invoice.determined", v: 1, verdict: "refuse" },
          { tier: "high", idempotencyKey: "attempt-1" },
        ),
      ).rejects.toBeInstanceOf(IdempotencyKeyConflict);
    });

    it("assigns sequences without a gap or a duplicate under real concurrent writers", async () => {
      // The per-case advisory lock, against a real one. Sixteen appends on
      // separate pooled connections: without the lock two writers read the same
      // MAX(sequence) under READ COMMITTED and one loses to the primary key.
      const correlationId = caseId("concurrent");
      const audit = createAudit({
        store: postgresTraceStore(poolExecutor()),
        clock: testClock(1_700_000_000_000),
        redact: redactFields([]),
        onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
      });
      const trace = await audit.open(correlationId);
      const results = await Promise.all(
        Array.from({ length: 16 }, (_unused, i) =>
          trace.record({ kind: "model.call", v: 1, step: i }, { tier: "low" }),
        ),
      );

      const sequences = results.map((r) => mustRecord(r).node.sequence).sort((a, b) => a - b);
      expect(sequences).toEqual(Array.from({ length: 16 }, (_unused, i) => i));
    }, 30_000);

    it("deduplicates a real concurrent retry storm into exactly one row", async () => {
      const correlationId = caseId("race");
      const audit = createAudit({
        store: postgresTraceStore(poolExecutor()),
        clock: testClock(1_700_000_000_000),
        redact: redactFields([]),
        onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
      });
      const trace = await audit.open(correlationId);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          trace.record({ kind: "k", v: 1 }, { tier: "low", idempotencyKey: "one" }),
        ),
      );

      const nodes = results.map((r) => mustRecord(r).node);
      expect(new Set(nodes.map((n) => n.sequence)).size).toBe(1);
      expect((await audit.replay(correlationId)).nodes).toHaveLength(1);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // 5. The SqlExecutor contract, against a live pool
  // -------------------------------------------------------------------------

  it("satisfies sqlExecutorContract against a live pool", async () => {
    // `README.md` item 5: "`sqlExecutorContract` is runnable against a live pool
    // from an operational script; nothing runs it in continuous integration
    // today." This is the run. It holds the fifteen lines above — the ones every
    // composition root writes for itself — to every obligation in `lib/sql.ts`,
    // including the two a fake cannot check: a class-23 SQLSTATE surviving the
    // rethrow, and two concurrent transactions not sharing a connection.
    const scratch = `agent_ops.sql_contract_scratch_${RUN.slice(-12).replace(/-/g, "")}`;
    await pool.query(`CREATE TABLE IF NOT EXISTS ${scratch} (v text)`);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${scratch.split(".")[1]}_v ON ${scratch} (v)`,
    );
    try {
      const outcomes = await runSqlExecutorContract({
        executor: poolExecutor(),
        statements: {
          insert: `INSERT INTO ${scratch} (v) VALUES ($1)`,
          countAll: `SELECT count(*)::int AS n FROM ${scratch}`,
          selectByValue: `SELECT v FROM ${scratch} WHERE v = $1`,
          invalid: "SELECT this is not sql",
          duplicate: `INSERT INTO ${scratch} (v) VALUES ($1)`,
        },
        reset: async () => {
          await pool.query(`DELETE FROM ${scratch}`);
        },
      });

      const failed = outcomes.filter((o) => !o.passed);
      expect(
        failed.map((o) => `${o.name}: ${String(o.error)}`),
        "the live SqlExecutor broke its contract",
      ).toEqual([]);
      expect(outcomes.length).toBeGreaterThanOrEqual(9);
    } finally {
      // A scratch table, not a trace table. This DROP is the reason the trace
      // tables are in a different schema-level arrangement entirely: nothing
      // here can reach them.
      await pool.query(`DROP TABLE IF EXISTS ${scratch}`);
    }
  }, 30_000);
});
