import { readdir, readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { postgresTraceStore, type CorrelationId } from "../../audit/index.js";
import {
  LicenceExpired,
  postgresApprovalStore,
  type IdempotencyKey,
  type KillSwitchState,
  type SqlExecutor,
  type SuspensionId,
  type SuspensionRecord,
} from "../index.js";
import { CASE, harness, human, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, gatedDisbursement } from "./fixtures/points.js";

/**
 * The durable-suspension path, against a **real Postgres**.
 *
 * ## What was missing, exactly
 *
 * `tests/postgres-store.test.ts` proves a great deal and it proves it against
 * `fakeSql`: a hand-written interpreter of this adapter's own statements. That
 * is evidence about the adapter's *logic*. It is not evidence that the
 * statements parse, that `ON CONFLICT (id) DO NOTHING` does what the adapter
 * believes, that `UPDATE … WHERE revision = $n` is atomic under a second
 * connection, that the `CHECK` constraints in `migrations/0006_approval_store.sql`
 * accept every value the adapter writes, or that a `bigint` comes back in a form
 * the adapter can read. Every one of those is a property of **Postgres**, and
 * nothing in this package opened a socket, so the single most consequential
 * surface in the module — a case that must survive process death because the
 * thing on the other side of it is money — was proven by a mock of the database
 * it depends on.
 *
 * This file runs the real thing: suspend, **throw the runtime away, including
 * the pool**, rebuild from the database alone, and answer the case.
 *
 * ## The hermetic rule, and exactly what this file does and does not change
 *
 * `CLAUDE.md`: hermeticity is structural, through dependency injection, "not by
 * convention and not by an environment variable". That rule is about the
 * **library**, and the library is untouched: no module in
 * `packages/agent-ops-core/src` imports a driver, `postgresApprovalStore` still
 * takes an injected `SqlExecutor`, and `pg` is a devDependency of the workspace
 * ROOT — absent from `packages/agent-ops-core/package.json`, so it is not a
 * dependency any of the nineteen applications inherits.
 *
 * What this file changes is narrower, and is stated plainly rather than argued
 * away: **with `AGENT_OPS_LIVE_DATABASE_URL` set, this one file opens a socket
 * to a database.** Three things bound that:
 *
 *   1. **It is a database and nothing else.** The model is
 *      `spec.decide` over an in-memory client factory; the approver is a
 *      `HumanAuthority` in an array; the effect is an in-memory write; the pager
 *      is absent. No model client, no transport and no pager is constructible
 *      from anything imported here, so the guarantee that matters most — a test
 *      cannot reach a live model or a real pager with real credentials present —
 *      is untouched.
 *   2. **The driver is not loaded at all unless the variable is set.** The
 *      import is dynamic and lives inside the gate. Unset — every default run,
 *      every `npm run check` — `pg` is never imported, no pool is constructed
 *      and nothing is opened. **The in-memory path in every other file in this
 *      folder is not weakened by a line**, and `inMemoryApprovalStore` remains
 *      the adapter those files prove.
 *   3. **The variable is a connection string, supplied deliberately.** It is not
 *      a `SKIP_NETWORK` flag inverted; there is no default, no fallback to
 *      `localhost`, and no reading of the development compose file's own
 *      variable, precisely so that a developer with a `.env` sourced does not
 *      silently start opening sockets from `npm test`.
 *
 * ## Skipping and failing are different answers
 *
 * **No variable — skip, cleanly, exit zero.** That is the "no database is
 * reachable" case, and `describe.skip` registers the cases so they are reported
 * as skipped: visible and countable, rather than a file that quietly does not
 * exist.
 *
 * **A variable that does not work — fail, loudly.** A string that cannot
 * connect, or a database holding somebody's real cases, is a misconfiguration,
 * and a misconfiguration that skipped silently would be a job passing green for
 * a year while proving nothing. That is the exact false green this file exists
 * to remove.
 *
 * ## Point it at a database you can throw away
 *
 * This suite APPLIES EVERY MIGRATION in `./migrations` and COMMITS rows to
 * `agent_ops.audit_trace_node`, which nothing in this library can ever delete
 * from. It refuses to start against a database holding cases it did not write.
 *
 *   docker compose up -d
 *   AGENT_OPS_LIVE_DATABASE_URL=postgres://agent_ops:agent_ops@localhost:5433/agent_ops \
 *     npx vitest run packages/agent-ops-core/src/approval/tests/live-postgres.test.ts
 */

const LIVE_URL = process.env["AGENT_OPS_LIVE_DATABASE_URL"];
const live = LIVE_URL === undefined ? describe.skip : describe;

/** Everything this run writes is prefixed with this, so it is identifiable. */
const RUN = `live-test:${randomUUID()}`;
const liveCase = (name: string): CorrelationId => CASE(`${RUN}:${name}`);

const DAY = 24 * 3_600_000;
const START = 1_700_000_000_000;

const point = gatedDisbursement({ dualControlAtOrAbove: "never" });
/** The same point under dual control, for the licence-freshness case. */
const dual = gatedDisbursement({
  id: "invoices.disburse_payment_dual",
  dualControlAtOrAbove: "high",
});
const options = {
  points: [point, dual],
  tierPolicy: tierBy({ disburse: "high" }),
  reservedPolicy: neverReserved(),
  evidence: { [INVOICE.id]: { matched: true } },
  members: [human("auth_jane"), human("auth_ravi")],
};

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

live("approval — a suspension survives against a real Postgres", () => {
  /** Pools, so a runtime can be destroyed together with its connections. */
  let PgPool: typeof import("pg").Pool;
  const openPools: Pool[] = [];

  /**
   * A pool, and the `SqlExecutor` over it. Fifteen lines, which is the claim
   * `postgres-store.ts` makes about wiring an existing driver to this seam —
   * made here against the real driver rather than asserted in a comment.
   */
  const openPool = (): { pool: Pool; executor: SqlExecutor } => {
    const pool = new PgPool({
      connectionString: LIVE_URL,
      // Bounded, like everything else. A test suite that can open an unbounded
      // number of connections is a test suite that can take a database down.
      max: 8,
      connectionTimeoutMillis: 5_000,
    });
    openPools.push(pool);
    const over = (run: (t: string, p: readonly unknown[]) => Promise<{ rows: unknown[] }>) => {
      const executor: SqlExecutor = {
        query: async (text, params) => ({ rows: (await run(text, params)).rows as never }),
        transaction: async (fn) => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const out = await fn(
              over(async (t, p) => client.query(t, p as unknown[]) as never),
            );
            await client.query("COMMIT");
            return out;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        },
      };
      return executor;
    };
    return { pool, executor: over(async (t, p) => pool.query(t, p as unknown[]) as never) };
  };

  /**
   * A whole runtime over the live database. Nothing is shared with any other
   * runtime but the rows: its own pool, its own executor, its own store, its own
   * audit instance, its own parent index.
   */
  const runtimeAt = (startAt: number, killSwitch?: () => Promise<KillSwitchState>) => {
    const { pool, executor } = openPool();
    const h = harness({
      ...options,
      store: postgresApprovalStore(executor),
      traceStore: postgresTraceStore(executor),
      startAt,
      ...(killSwitch === undefined ? {} : { killSwitch }),
    });
    return { ...h, pool, executor };
  };

  let preflight: Pool;

  beforeAll(async () => {
    // The driver import, dynamic and inside the gate. With the variable unset
    // this line is never reached and `pg` is never loaded.
    ({ Pool: PgPool } = await import("pg"));
    preflight = new PgPool({ connectionString: LIVE_URL, max: 4, connectionTimeoutMillis: 5_000 });
    openPools.push(preflight);

    const dir = await migrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      await preflight.query(await readFile(join(dir, file), "utf8"));
    }

    // Not a permission system — anyone determined can point this anywhere — but
    // it is the difference between a mistyped connection string costing nothing
    // and costing a migration applied to a live archive.
    for (const [table, column] of [
      ["agent_ops.audit_trace_case", "correlation_id"],
      ["agent_ops.approval_suspension", "correlation_id"],
    ] as const) {
      const { rows } = await preflight.query<{ readonly id: string }>(
        `SELECT ${column} AS id FROM ${table} WHERE ${column} NOT LIKE 'live-test:%' LIMIT 1`,
      );
      if (rows.length > 0) {
        throw new Error(
          `AGENT_OPS_LIVE_DATABASE_URL points at a database holding real cases (for example ` +
            `${String(rows[0]?.id)} in ${table}). This suite applies migrations and commits rows ` +
            "to an INSERT-only table. Point it at a throwaway database.",
        );
      }
    }

    // Retire what earlier runs of THIS suite left waiting.
    //
    // `sweep` is a query over the whole table by design — a sweeper serves every
    // case in the deployment, not the one a test just wrote — so suspensions
    // this file left `awaiting` or `held` on a previous run are genuinely due
    // and genuinely swept, and a count assertion would drift upward run over
    // run. Retiring them is `UPDATE`, which is a grant this table really carries
    // (a suspension is a state machine); no `DELETE` is issued here or anywhere,
    // because an approver's own words live in this table. The `LIKE` is belt and
    // braces over the throwaway guard above.
    await preflight.query(
      // `next_due_at_ms` is left alone: it is NOT NULL in the migration, and the
      // due index is partial on `state IN ('awaiting','held')`, so a retired row
      // is out of the sweep's query whatever its due time says.
      `UPDATE agent_ops.approval_suspension
          SET state = 'refused'
        WHERE state IN ('awaiting', 'held') AND correlation_id LIKE 'live-test:%'`,
    );
  }, 120_000);

  afterAll(async () => {
    for (const pool of openPools) await pool.end().catch(() => undefined);
  });

  const rowOf = async (id: SuspensionId) => {
    const { rows } = await preflight.query<{
      readonly state: string;
      readonly revision: number;
      readonly seat: string;
      readonly final_answer_json: string | null;
      readonly suspend_node: string;
      readonly next_due_at_ms: string | null;
    }>(`SELECT state, revision, seat, final_answer_json, suspend_node, next_due_at_ms
        FROM agent_ops.approval_suspension WHERE id = $1`, [id]);
    return rows[0];
  };

  // -------------------------------------------------------------------------
  // 1. The one this module exists for
  // -------------------------------------------------------------------------

  it("answers a case from the database alone, after the runtime that suspended it is gone", async () => {
    const correlationId = liveCase("resume");
    const first = runtimeAt(START);
    const suspended = await first.approval.run(point, INVOICE, { correlationId });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    // ---- the process dies here -------------------------------------------
    //
    // Every object goes: the approval instance, the audit instance, the
    // recorder's parent index, the store, the executor — and the POOL, so not
    // one socket is shared with what comes next. What crosses the gap is rows
    // in Postgres and a suspension identifier a human's approval surface held.
    await first.pool.end();

    const reborn = runtimeAt(START + 9 * DAY);
    const settled = await reborn.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "purchase order checked with the buyer" },
      { authority: human("auth_jane") },
    );

    expect(settled.kind).toBe("executed");
    if (settled.kind !== "executed") return;
    expect(settled.effect).toEqual({ kind: "done", reference: "pay_4720000" });
    expect(settled.authorityTransferred).toBe(true);
    expect(reborn.writes).toHaveLength(1);

    // The database agrees, and the revision moved: these were real conditional
    // UPDATEs, not a mock returning `true`.
    const row = await rowOf(suspended.suspension);
    expect(row?.state).toBe("executed");
    expect(row?.revision).toBeGreaterThan(0);

    // Nine days of waiting, measured across a gap in which no process existed,
    // from a presentation that really happened.
    const record = await reborn.store.loadSuspension(suspended.suspension);
    expect(record?.finalAnswer?.timeToDecisionMs).toBe(9 * DAY);

    // One trace, both halves, later nodes parented on nodes written by a process
    // that no longer exists — read back through a connection it never used.
    const replayed = await reborn.audit.replay(correlationId);
    const kinds = replayed.nodes.map((n) => String(n.payload["kind"]));
    expect(kinds).toContain("approval.suspend.durable");
    expect(kinds).toContain("approval.answered");
    expect(kinds).toContain("effect.done");
    const answered = replayed.nodes.find((n) => n.payload["kind"] === "approval.answered");
    expect(answered?.parent).toBe(suspended.node);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 2. The kill switch, its scope, and a hold that is not a grave
  // -------------------------------------------------------------------------

  it("holds durably under a scoped switch and resumes from the database once the scope lifts", async () => {
    const correlationId = liveCase("hold");
    let state: KillSwitchState = {
      engaged: true,
      scope: { kind: "tiers", tiers: ["high"] },
      by: "auth_ops_lead",
      at: START,
    };
    const during = runtimeAt(START, async () => state);
    const suspended = await during.approval.run(point, INVOICE, { correlationId });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    const held = await during.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked, during the incident" },
      { authority: human("auth_jane") },
    );
    expect(held.kind).toBe("held");
    expect(during.writes).toEqual([]);

    // `held` is durable AND still has a due time. A terminal hold would be a
    // row no sweeper ever looks at again — the dangerous quadrant reached by a
    // path nobody designed.
    const duringRow = await rowOf(suspended.suspension);
    expect(duringRow?.state).toBe("held");
    expect(Number(duringRow?.next_due_at_ms)).toBe(START + DAY);

    await during.pool.end();

    // The incident narrows to nothing. A DIFFERENT process, a different pool,
    // sweeps a case it has never seen.
    state = { engaged: false };
    const after = runtimeAt(START + 2 * DAY, async () => state);
    const report = await after.approval.sweep({ limit: 10 });
    expect(report.holdsReleased).toBe(1);

    const releasedRow = await rowOf(suspended.suspension);
    expect(releasedRow?.state).toBe("awaiting");
    expect(releasedRow?.seat).toBe("first");
    // The pre-incident approval is void: it was given against pre-incident
    // evidence, and the switch clearing is not a lawful basis for moving money.
    expect(releasedRow?.final_answer_json).toBeNull();
    expect(after.writes).toEqual([]);

    // Answered again, after the incident, it pays exactly once.
    const settled = await after.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "re-checked after the incident" },
      { authority: human("auth_jane") },
    );
    expect(settled.kind).toBe("executed");
    expect(after.writes).toHaveLength(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 3. The licence, enforced at the instant of use
  // -------------------------------------------------------------------------

  it("returns a dual-controlled case to the first seat when the first approval aged out, across a restart", async () => {
    const correlationId = liveCase("licence-answer");
    const first = runtimeAt(START);
    const suspended = await first.approval.run(dual, INVOICE, { correlationId });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    // Monday: the first seat signs, against Monday's evidence.
    await first.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "purchase order checked" },
      { authority: human("auth_jane") },
    );
    const record = await first.store.loadSuspension(suspended.suspension);
    expect(record?.seat).toBe("second");
    await first.pool.end();

    // Wednesday, in another process: the second seat signs. `licenceValidFor` is
    // a day and the licence runs from the EARLIEST approval in hand, so a second
    // seat cannot resurrect a first approval that has aged past it.
    const late = runtimeAt(START + 30 * 3_600_000);
    await expect(
      late.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "countersigned, sorry for the delay" },
        { authority: human("auth_ravi") },
      ),
    ).rejects.toThrow(LicenceExpired);
    expect(late.writes).toEqual([]);

    // Not closed, not expired, not lost: back at the first seat with the sealed
    // first answer cleared, which is what "a stale approval is not approval"
    // means. Checked in the real table, after a real conditional UPDATE.
    const row = await rowOf(suspended.suspension);
    expect(row?.state).toBe("awaiting");
    expect(row?.seat).toBe("first");
    // No claim was taken, so there is nothing in doubt and nothing to release.
    const { rows } = await preflight.query(
      `SELECT key FROM agent_ops.approval_idempotency WHERE key = $1`,
      [record?.idempotencyKey],
    );
    expect(rows).toHaveLength(0);
  }, 60_000);

  it("withholds the effect when the licence went stale between the check and the call", async () => {
    const correlationId = liveCase("licence-execute");
    const runtime = runtimeAt(START);
    const suspended = await runtime.approval.run(point, INVOICE, { correlationId });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    // The second enforcement: at the instant of execution, against the clock,
    // before a claim is taken. `answer` checks the licence, then commits the
    // settlement, then reads the kill switch, then claims the key — and every
    // one of those is a round trip to something that can stall. Here the stall
    // is on a real Postgres round trip, so what outlives the licence is a real
    // conditional UPDATE and not a mock.
    let armed = true;
    const slow = {
      ...runtime.store,
      swapSuspension: async (
        id: SuspensionId,
        revision: number,
        next: SuspensionRecord,
      ) => {
        const out = await runtime.store.swapSuspension(id, revision, next);
        if (armed) {
          armed = false;
          runtime.clock.advance(25 * 3_600_000); // licenceValidFor is 24 hours
        }
        return out;
      },
    };
    const stalling = runtime.restart({ store: slow });

    const settled = await stalling.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    // Withheld, not paid, and not thrown: `held` is resumable, so a stale
    // licence returns the case to an approver rather than ending it.
    expect(settled.kind).toBe("held");
    if (settled.kind !== "held") return;
    expect(settled.reason).toBe("licence-expired");
    expect(stalling.writes).toEqual([]);

    const expiry = (await stalling.audit.replay(correlationId)).nodes.find(
      (n) => n.payload["kind"] === "approval.licence-expired",
    );
    expect(expiry?.payload["checkedAt"]).toBe("execute");
    expect(expiry?.payload["effectAttempted"]).toBe(false);
    // No claim was taken, so there is nothing in doubt and nothing to reconcile.
    const record = await stalling.store.loadSuspension(suspended.suspension);
    const { rows } = await preflight.query(
      `SELECT key FROM agent_ops.approval_idempotency WHERE key = $1`,
      [record?.idempotencyKey],
    );
    expect(rows).toHaveLength(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 4. Reconciliation: a suspension whose trace node is missing
  // -------------------------------------------------------------------------

  it("finds and repairs a suspension pointing at a trace node the archive does not contain", async () => {
    const correlationId = liveCase("divergence");
    const runtime = runtimeAt(START);
    const suspended = await runtime.approval.run(point, INVOICE, { correlationId });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    // A suspension and its trace node do not share a transaction and cannot —
    // `audit` exposes none, and one spanning `decide` would hold a pooled
    // connection open across a model call. So a crash between the two writes is
    // reachable, and this is what it leaves behind. Forged with a real UPDATE
    // against the real table, which is a grant this role genuinely has.
    await preflight.query(
      `UPDATE agent_ops.approval_suspension SET suspend_node = $1 WHERE id = $2`,
      [`${correlationId}#9999`, suspended.suspension],
    );

    const report = await runtime.approval.reconcile({ cases: [correlationId] });
    expect(report.examined).toBe(1);
    expect(report.compared).toBe(1);
    expect(report.unreadable).toEqual([]);
    expect(report.divergences).toHaveLength(1);
    const divergence = report.divergences[0];
    expect(divergence?.kind).toBe("suspension-without-trace");
    expect(divergence?.suspension).toBe(suspended.suspension);
    expect(divergence?.recovery).toBe("repaired");

    // Repair, not rewrite: nothing in the trace is edited, a node is added —
    // the only edit an append-only archive permits — and the row is re-pointed
    // at it, so later nodes are parented again instead of hanging at the root.
    const repaired = await rowOf(suspended.suspension);
    expect(repaired?.suspend_node).not.toBe(`${correlationId}#9999`);
    const replayed = await runtime.audit.replay(correlationId);
    const ids = new Set(replayed.nodes.map((n) => String(n.id)));
    expect(ids.has(String(repaired?.suspend_node))).toBe(true);
    const written = replayed.nodes.find(
      (n) => n.payload["kind"] === "approval.link-divergence",
    );
    expect(written?.payload["divergence"]).toBe("suspension-without-trace");
    expect(written?.payload["incident"]).toBe(true);

    // And the case is still answerable, which is the whole point of repairing
    // parentage rather than declaring the case broken.
    const settled = await runtime.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );
    expect(settled.kind).toBe("executed");
  }, 60_000);

  // -------------------------------------------------------------------------
  // 5. The claim, contended by real connections
  // -------------------------------------------------------------------------

  it("hands `claimed` to exactly one of eight concurrent callers, on separate connections", async () => {
    // The interesting part of the `ApprovalStore` seam is not storage, it is
    // this: "claimed is true for exactly ONE concurrent caller per key". Against
    // `fakeSql` that is a property of an interpreter written by the same hand as
    // the adapter. Against Postgres it is a property of the database, decided by
    // eight real connections racing an INSERT.
    const correlationId = liveCase("claim");
    const key = `idm_live_${randomUUID()}` as IdempotencyKey;
    const stores = Array.from({ length: 8 }, () => postgresApprovalStore(openPool().executor));

    const results = await Promise.all(
      stores.map((store) => store.claimIdempotency(key, correlationId, START, 600_000)),
    );
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    // The seven losers are told the truth about the state they lost to, rather
    // than an error: `not-attempted` means no outbound call has been made yet.
    for (const loser of results.filter((r) => !r.claimed)) {
      expect(loser.claim.state).toBe("not-attempted");
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // 6. Bounded, and shed rather than queued
  // -------------------------------------------------------------------------

  it("sheds writes over `maxPendingWrites` rather than queueing them behind connections", async () => {
    const { executor } = openPool();
    const store = postgresApprovalStore(executor, { maxPendingWrites: 2, maxRowsPerRead: 10 });
    const correlationId = liveCase("shed");
    const claim = () =>
      store.claimIdempotency(
        `idm_live_${randomUUID()}` as IdempotencyKey,
        correlationId,
        START,
        600_000,
      );
    const outcomes = await Promise.allSettled([claim(), claim(), claim(), claim(), claim()]);
    const shed = outcomes.filter(
      (o) => o.status === "rejected" && String(o.reason?.reason) === "backpressure",
    );
    // Bounded means refused, not buffered: a queue in front of a pool is an
    // unbounded queue wearing a bound's clothes, and it fails by running the
    // process out of memory instead of by telling the caller to retry.
    expect(shed.length).toBeGreaterThan(0);
  }, 60_000);
});
