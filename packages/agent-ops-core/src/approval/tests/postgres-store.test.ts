import { describe, expect, it } from "vitest";
import {
  inMemoryTraceStore,
  postgresTraceStore,
  type CorrelationId,
} from "../../audit/index.js";
import {
  APPROVAL_STORE_SCHEMA_SQL,
  inMemoryApprovalStore,
  postgresApprovalStore,
  type IdempotencyKey,
  type SuspensionRecord,
} from "../index.js";
import { CASE, harness, human, neverReserved, tierBy } from "./fixtures/harness.js";
import { emptyDatabase, fakeSql, tagOf, type FakeDatabase } from "./fixtures/fake-sql.js";
import { INVOICE, gatedDisbursement } from "./fixtures/points.js";

/**
 * The second adapter of the `ApprovalStore` seam.
 *
 * The module's own honest report said this seam had one shipped adapter and was
 * therefore hypothetical by the project's own rule — "two adapters or it is not
 * a seam". This file is the other adapter, and the test that gives it teeth is
 * not "does state round-trip" but the one this module exists for:
 *
 *   **Build a suspension. Destroy every object in the process, including the
 *   store and the executor. Rebuild from bytes. Answer the case.**
 *
 * Everything else here is in service of trusting that one.
 */

const point = gatedDisbursement({ dualControlAtOrAbove: "never" });

const options = {
  points: [point],
  tierPolicy: tierBy({ disburse: "high" }),
  reservedPolicy: neverReserved(),
  evidence: { [INVOICE.id]: { matched: true } },
  members: [human("auth_jane"), human("auth_ravi")],
};

/** A whole runtime over one database. Nothing is shared but the rows. */
const runtimeOver = (db: FakeDatabase, startAt: number) => {
  const { executor, statements } = fakeSql(db);
  const h = harness({
    ...options,
    store: postgresApprovalStore(executor),
    traceStore: postgresTraceStore(executor),
    startAt,
  });
  return { ...h, statements };
};

const START = 1_700_000_000_000;

describe("postgres approval store — statement discipline", () => {
  it("never issues a DELETE or a TRUNCATE across the whole lifecycle", async () => {
    const db = emptyDatabase();
    const runtime = runtimeOver(db, START);
    const suspended = await runtime.approval.run(point, INVOICE, { correlationId: CASE("pg1") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");
    runtime.clock.advance(5 * 3_600_000);
    await runtime.approval.sweep({ limit: 10 });
    await runtime.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "purchase order checked" },
      { authority: human("auth_jane") },
    );
    await runtime.approval.inDoubt();

    const approvalStatements = runtime.statements.filter((s) =>
      tagOf(s).startsWith("approval:"),
    );
    expect(approvalStatements.length).toBeGreaterThan(0);
    // No DELETE grant exists on either table, so a DELETE would fail in
    // production rather than here. The point is that none is ever attempted:
    // an approver's own words live in this table.
    for (const statement of approvalStatements) {
      expect(statement).not.toMatch(/\b(delete|truncate)\b/i);
    }
  });

  it("parameterises everything, so a case identifier cannot be SQL", async () => {
    const db = emptyDatabase();
    const runtime = runtimeOver(db, START);
    await runtime.approval.run(point, INVOICE, {
      correlationId: CASE("pg2'; drop table agent_ops.approval_suspension --"),
    });

    for (const statement of runtime.statements) {
      expect(statement).not.toContain("drop table");
      expect(statement).not.toContain("pg2'");
    }
  });

  it("tags every statement it issues, so it is identifiable in pg_stat_statements", async () => {
    const db = emptyDatabase();
    const runtime = runtimeOver(db, START);
    await runtime.approval.run(point, INVOICE, { correlationId: CASE("pg3") });
    for (const statement of runtime.statements) {
      expect(tagOf(statement)).not.toBe("untagged");
    }
  });
});

describe("postgres approval store — the process dies and the case does not", () => {
  it("answers from a database restored out of bytes, by a runtime that never saw the run", async () => {
    const db = emptyDatabase();
    const first = runtimeOver(db, START);

    const suspended = await first.approval.run(point, INVOICE, { correlationId: CASE("pg4") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    // ---- the process dies here -------------------------------------------
    //
    // Not a rebuilt runtime over the same store object — that is the in-memory
    // adapter's demonstration and it is a weaker one. Everything is serialised
    // to text and every object is dropped: the approval instance, the audit
    // instance, the recorder's parent index, the store, the executor and the
    // database itself. What crosses the gap is a string.
    const bytes = JSON.stringify(db);
    const restored = JSON.parse(bytes) as FakeDatabase;
    expect(restored).not.toBe(db);

    const reborn = runtimeOver(restored, START + 9 * 24 * 3_600_000); // nine days later

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

    // One trace, both halves, and the later nodes parented on nodes written by
    // a process that no longer exists.
    const replayed = await reborn.audit.replay(CASE("pg4"));
    const kinds = replayed.nodes.map((n) => String(n.payload["kind"]));
    expect(kinds).toContain("approval.suspend.durable");
    expect(kinds).toContain("approval.answered");
    expect(kinds).toContain("effect.done");
    const answered = replayed.nodes.find((n) => n.payload["kind"] === "approval.answered");
    expect(answered?.parent).toBe(suspended.node);
  });

  it("survives the gap with time-to-decision measured across it, not invented", async () => {
    const db = emptyDatabase();
    const first = runtimeOver(db, START);
    const suspended = await first.approval.run(point, INVOICE, { correlationId: CASE("pg5") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    const reborn = runtimeOver(
      JSON.parse(JSON.stringify(db)) as FakeDatabase,
      START + 3 * 24 * 3_600_000,
    );
    await reborn.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    const record = await reborn.store.loadSuspension(suspended.suspension);
    // Three days, measured from a presentation that really happened, in a
    // process that did not exist when it happened.
    expect(record?.finalAnswer?.timeToDecisionMs).toBe(3 * 24 * 3_600_000);
    expect(record?.state).toBe("executed");
  });

  it("refuses an authority the restored record never offered the brief to", async () => {
    const db = emptyDatabase();
    const first = runtimeOver(db, START);
    const suspended = await first.approval.run(point, INVOICE, { correlationId: CASE("pg6") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    const reborn = runtimeOver(JSON.parse(JSON.stringify(db)) as FakeDatabase, START + 60_000);
    // `offeredTo` is durable, so authorisation across process death is checked
    // against what the directory actually offered, not against what the calling
    // surface asserts after a restart.
    await expect(
      reborn.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "I say I am allowed" },
        { authority: human("auth_stranger") },
      ),
    ).rejects.toThrow(/was not offered/);
    expect(reborn.writes).toEqual([]);
  });
});

describe("postgres approval store — two adapters, one seam", () => {
  it("produces the same durable record as the in-memory adapter for the same case", async () => {
    const db = emptyDatabase();
    const { executor } = fakeSql(db);

    const pg = harness({
      ...options,
      store: postgresApprovalStore(executor),
      traceStore: postgresTraceStore(executor),
      startAt: START,
    });
    const mem = harness({
      ...options,
      store: inMemoryApprovalStore(),
      traceStore: inMemoryTraceStore(),
      startAt: START,
    });

    const records: SuspensionRecord[] = [];
    for (const runtime of [pg, mem]) {
      const suspended = await runtime.approval.run(point, INVOICE, {
        correlationId: CASE("pg7"),
      });
      if (suspended.kind !== "suspended") throw new Error("expected a suspension");
      runtime.clock.advance(2 * 3_600_000);
      await runtime.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "checked" },
        { authority: human("auth_jane") },
      );
      const record = await runtime.store.loadSuspension(suspended.suspension);
      if (record === undefined) throw new Error("expected a record");
      records.push(record);
    }

    // Field for field. If these ever diverge, a case migrated between stores
    // stops meaning the same thing, and the seam is two interfaces wearing one
    // name.
    expect(records[0]).toEqual(records[1]);
  });
});

describe("postgres approval store — correct under concurrent writers", () => {
  const suspensionFor = async (db: FakeDatabase, id: string) => {
    const runtime = runtimeOver(db, START);
    const suspended = await runtime.approval.run(point, INVOICE, { correlationId: CASE(id) });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");
    return { runtime, id: suspended.suspension };
  };

  it("lets exactly one of two concurrent compare-and-sets win", async () => {
    const db = emptyDatabase();
    const { runtime, id } = await suspensionFor(db, "pg8");
    const store = postgresApprovalStore(fakeSql(db).executor);
    const record = await store.loadSuspension(id);
    if (record === undefined) throw new Error("expected a record");

    // Both writers read the same revision, then race. The adapter's write is
    // one statement whose WHERE clause is the condition, so the loser updates
    // no rows — an adapter that read and then wrote would let both through.
    const results = await Promise.all([
      store.swapSuspension(id, record.revision, { ...record, stepsFired: 1 }),
      store.swapSuspension(id, record.revision, { ...record, stepsFired: 2 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.loadSuspension(id))?.revision).toBe(record.revision + 1);
    void runtime;
  });

  it("lets exactly one of two concurrent sweepers take the lease", async () => {
    const db = emptyDatabase();
    const { id } = await suspensionFor(db, "pg9");
    const store = postgresApprovalStore(fakeSql(db).executor);
    const before = (await store.loadSuspension(id))?.revision;

    const taken = await Promise.all([
      store.acquireLease(id, "sweeper-a", START, START + 60_000),
      store.acquireLease(id, "sweeper-b", START, START + 60_000),
    ]);
    expect(taken.filter(Boolean)).toHaveLength(1);

    // And a lease does NOT bump the revision: a sweeper that took the lease
    // must still be able to make the compare-and-set it took the lease for.
    const record = await store.loadSuspension(id);
    expect(record?.revision).toBe(before);
  });

  it("tells exactly one of two concurrent claimants of a key that it claimed it", async () => {
    const db = emptyDatabase();
    const store = postgresApprovalStore(fakeSql(db).executor);
    const key = "idm_concurrent" as IdempotencyKey;
    const caseId = "pg10" as CorrelationId;

    const claims = await Promise.all([
      store.claimIdempotency(key, caseId, START, 600_000),
      store.claimIdempotency(key, caseId, START, 600_000),
    ]);
    expect(claims.filter((c) => c.claimed)).toHaveLength(1);
    expect(claims.filter((c) => !c.claimed)).toHaveLength(1);
    expect(claims.every((c) => c.claim.state === "not-attempted")).toBe(true);
  });

  it("reclaims an expired lease in not-attempted and never one in unknown", async () => {
    const db = emptyDatabase();
    const store = postgresApprovalStore(fakeSql(db).executor);
    const key = "idm_lease" as IdempotencyKey;
    const caseId = "pg11" as CorrelationId;

    const first = await store.claimIdempotency(key, caseId, START, 600_000);
    expect(first.claimed).toBe(true);

    // Lease expired, still `not-attempted`: no outbound call was made, so
    // re-executing is safe and leaving it stuck is a payment nobody makes.
    const retaken = await store.claimIdempotency(key, caseId, START + 900_000, 600_000);
    expect(retaken).toMatchObject({ claimed: true, reclaimed: true });

    await store.settleIdempotency(key, {
      ...retaken.claim,
      state: "unknown",
      leaseUntil: START + 900_000,
      reason: "gateway timed out after the debit was sent",
    });

    // A year later. Ambiguity resolves toward not paying twice, and no lease
    // TTL, configuration key or elapsed time changes that.
    const never = await store.claimIdempotency(
      key,
      caseId,
      START + 365 * 24 * 3_600_000,
      600_000,
    );
    expect(never.claimed).toBe(false);
    expect(never.claim.state).toBe("unknown");
    expect(await store.inDoubt(10)).toHaveLength(1);
  });

  it("does not overwrite a durable suspension when the same case is saved twice", async () => {
    const db = emptyDatabase();
    const { id } = await suspensionFor(db, "pg12");
    const store = postgresApprovalStore(fakeSql(db).executor);
    const original = await store.loadSuspension(id);
    if (original === undefined) throw new Error("expected a record");

    await store.swapSuspension(id, original.revision, { ...original, stepsFired: 3 });
    // A retried `run` racing a save. Insert-if-absent: the second save is a
    // no-op, because an overwrite resets `revision` and a reset revision turns
    // a lost compare-and-set into a silent clobber of somebody's answer.
    await store.saveSuspension({ ...original, stepsFired: 0 });

    const after = await store.loadSuspension(id);
    expect(after?.stepsFired).toBe(3);
    expect(after?.revision).toBe(original.revision + 1);
  });

  it("bounds every read, whatever limit the caller passes", async () => {
    const db = emptyDatabase();
    await suspensionFor(db, "pg13");
    const { executor, statements } = fakeSql(db);
    const store = postgresApprovalStore(executor, { maxRowsPerRead: 2 });

    await store.dueSuspensions(START + 10 * 3_600_000, Number.MAX_SAFE_INTEGER);
    await store.inDoubt(Number.MAX_SAFE_INTEGER);

    for (const statement of statements) expect(statement).toContain("LIMIT");
  });

  it("sheds a write rather than queueing it behind the pool, and says which", async () => {
    const db = emptyDatabase();
    const { executor } = fakeSql(db);
    const store = postgresApprovalStore(executor, { maxPendingWrites: 1 });
    const key = "idm_shed" as IdempotencyKey;
    const caseId = "pg14" as CorrelationId;

    const [ok, shed] = await Promise.allSettled([
      store.claimIdempotency(key, caseId, START, 600_000),
      store.claimIdempotency(`${key}b` as IdempotencyKey, caseId, START, 600_000),
    ]);
    expect(ok?.status).toBe("fulfilled");
    expect(shed?.status).toBe("rejected");
    if (shed?.status !== "rejected") return;
    expect(shed.reason).toMatchObject({
      name: "ApprovalStoreUnavailable",
      reason: "backpressure",
    });
  });
});

describe("postgres approval store — runnable as shipped", () => {
  it("ships a schema covering every table and column the adapter writes", async () => {
    // The failure this catches is the one `evals` caught: an adapter describing
    // its schema in prose, with no migration anywhere in the repository, so the
    // second adapter of the seam was unrunnable as shipped and nobody could
    // tell from reading it.
    const db = emptyDatabase();
    const runtime = runtimeOver(db, START);
    const suspended = await runtime.approval.run(point, INVOICE, { correlationId: CASE("pg15") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");
    runtime.clock.advance(5 * 3_600_000);
    await runtime.approval.sweep({ limit: 10 });
    await runtime.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );
    await runtime.approval.inDoubt();

    // Every column named in an INSERT list or an UPDATE SET clause the adapter
    // actually issued, taken from the statements rather than from a list
    // somebody remembered to keep in step.
    const columns = new Set<string>();
    for (const statement of runtime.statements) {
      if (!tagOf(statement).startsWith("approval:")) continue;
      const inserted = /INSERT INTO \S+\s*\(([^)]*)\)/.exec(statement);
      for (const column of String(inserted?.[1] ?? "").split(",")) {
        if (column.trim() !== "") columns.add(column.trim());
      }
      const set = /SET([\s\S]*?)\n\s*WHERE/.exec(statement);
      for (const assignment of String(set?.[1] ?? "").split(",")) {
        const name = /^\s*([a-z_]+)\s*=/.exec(assignment);
        if (name !== null) columns.add(String(name[1]));
      }
    }

    expect(columns.size).toBeGreaterThan(30);
    for (const column of columns) {
      expect(APPROVAL_STORE_SCHEMA_SQL).toContain(column);
    }
    for (const table of ["agent_ops.approval_suspension", "agent_ops.approval_idempotency"]) {
      expect(APPROVAL_STORE_SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("grants UPDATE because a suspension is a state machine, and never DELETE", () => {
    expect(APPROVAL_STORE_SCHEMA_SQL).toContain(
      "GRANT SELECT, INSERT, UPDATE ON agent_ops.approval_suspension",
    );
    expect(APPROVAL_STORE_SCHEMA_SQL).toContain(
      "GRANT SELECT, INSERT, UPDATE ON agent_ops.approval_idempotency",
    );
    // An approver's own words are in this table. A lawful erasure is a
    // separately authorised operation, not a standing grant.
    expect(APPROVAL_STORE_SCHEMA_SQL).not.toMatch(/GRANT[^;]*DELETE/);
    // And nothing whatsoever on an audit table: those are INSERT-only forever,
    // and a grant that exists is a grant that gets used.
    expect(APPROVAL_STORE_SCHEMA_SQL).not.toMatch(/GRANT[^;]*ON agent_ops\.audit/);
  });

  it("records itself in the migration ledger, like every other migration", () => {
    expect(APPROVAL_STORE_SCHEMA_SQL).toContain("agent_ops.schema_migrations");
    expect(APPROVAL_STORE_SCHEMA_SQL).toContain("'0006_approval_store'");
    expect(APPROVAL_STORE_SCHEMA_SQL.startsWith("-- 0006_approval_store.sql")).toBe(true);
  });

  it("keeps canonical bytes in text columns, never jsonb", () => {
    // jsonb reorders keys and normalises numbers, which would destroy the
    // byte-stable serialisation replay stands on.
    for (const column of [
      "verdict_json",
      "effect_payload_json",
      "brief_body_json",
      "do_nothing_json",
      "redacted_effect_json",
    ]) {
      expect(APPROVAL_STORE_SCHEMA_SQL).toMatch(new RegExp(`${column}\\s+text`));
    }
    // No column is declared jsonb anywhere in the file. (The word appears in a
    // comment saying exactly why, which is the point of the comment.)
    expect(APPROVAL_STORE_SCHEMA_SQL).not.toMatch(/^\s+[a-z_]+\s+jsonb/m);
  });
});
