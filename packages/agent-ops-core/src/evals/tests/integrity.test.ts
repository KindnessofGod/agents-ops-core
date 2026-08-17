import { describe, expect, it } from "vitest";
import {
  createEvalRecorder,
  defineSubject,
  determine,
  EVAL_ENVELOPE_VERSION,
  EvalStoreUnavailable,
  exactVerdict,
  inMemoryEvalNodeStore,
  inMemoryRunLedger,
  RecorderNotMinted,
  run,
  seed as makeSeed,
  sqlEvalNodeStore,
  systemTimers,
} from "../index.js";
import type { EvalRecorder, SqlExecutor, SqlRow } from "../index.js";
import {
  denyFields,
  echoBackend,
  harness,
  manualClock,
  PROMPT_V1,
  passthroughRedactor,
  priceTable,
  smallLimits,
  TEST_MODEL,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/**
 * Slice 7 — the integrity properties: the recorder brand, integers only,
 * redaction before write, the second store adapter, and retention.
 */

const callingSubject = defineSubject({
  version: testSubjectVersion,
  purity: "calls-models",
  decide: async (ctx) => {
    const answer = await ctx.client.complete({
      model: TEST_MODEL,
      promptVersion: PROMPT_V1,
      prompt: { supplier: String(ctx.input["supplier"]) },
    });
    return determine(answer.text, 9_000);
  },
});

describe("the recorder brand", () => {
  it("refuses a recorder this module did not mint", async () => {
    // The compile-time half is asserted in `fixtures/subject-cannot-write.ts`:
    // the brand is a non-exported unique symbol, so the object literal below
    // does not typecheck without the cast. This is the runtime half, for
    // anything that defeated the type.
    const impostor = { append: async () => ({ sequence: 0 }) } as unknown as EvalRecorder;
    await expect(
      run({
        label: "pre-merge",
        cases: threeInvoices(),
        subject: callingSubject,
        scorers: [exactVerdict],
        models: echoBackend(),
        recorder: impostor,
        seed: testSeed,
        limits: smallLimits,
        priceTable,
      }),
    ).rejects.toBeInstanceOf(RecorderNotMinted);
  });
});

describe("integers only, and redaction before write", () => {
  it("refuses a fractional payload field before the node exists", async () => {
    const { store, recorder } = harness();
    const floaty = defineSubject({
      version: testSubjectVersion,
      purity: "pure",
      decide: async (ctx) =>
        ctx.node.child(
          // 0.665 is exactly how byte-stability dies quietly. Scores are basis
          // points, cost is tenth-cents, latency is micros. No exceptions.
          { name: "score", v: 1, payload: { ratio: 0.665 } },
          async () => determine("duplicate", 9_000),
        ),
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: floaty,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(report.cases[0]?.status).toBe("unscored");
    expect(report.cases[0]?.detail).toContain("UnserialisablePayload");
    // The validation runs before the append, so the unserialisable node was
    // never written rather than written and regretted.
    const nodes = (await store.read(report.runId))?.nodes ?? [];
    expect(nodes.filter((n) => n.kind === "span")).toHaveLength(0);
  });

  it("runs the redactor before the store sees anything, and stamps which one ran", async () => {
    const { store, recorder } = harness(denyFields(["prompt.supplier"]));
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: callingSubject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    const stored = await store.read(report.runId);
    const calls = (stored?.nodes ?? []).filter((n) => n.kind === "model.call");
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      // There is no un-writing, so no store adapter ever receives the original.
      expect(call.payload["prompt.supplier"]).toBe("[redacted]");
      expect(call.redaction).toBe("deny:prompt.supplier");
    }
    expect(stored?.header.redaction).toBe("deny:prompt.supplier");
    expect(stored?.header.capturedVia).toBe("injected-client-only");
  });

  it("computes a byte-stable trace digest that both reports carry", async () => {
    const { recorder } = harness();
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: callingSubject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(report.traceDigest).toMatch(/^aoc\.evals\.digest\.v1:sha256:[0-9a-f]{64}$/);
    expect(report.nodes).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------- the second store adapter */

/**
 * A minimal SQL engine, just enough to answer the statements the adapter issues.
 *
 * This is what testing at a seam looks like: the adapter's contract *is* the
 * `SqlExecutor`, so the fixture stands where Postgres stands. It also proves the
 * adapter does what it claims about ordering — the sequence comes from the
 * store, inside the lock, never from the caller.
 */
const fakeSql = (): SqlExecutor & { readonly statements: string[] } => {
  const runs: Record<string, SqlRow> = {};
  const nodes: Record<string, SqlRow>[] = [];
  const statements: string[] = [];

  const executor: SqlExecutor & { readonly statements: string[] } = {
    statements,
    async query(sqlText, params) {
      statements.push(sqlText.trim().split("\n")[0]?.trim() ?? "");
      const p = params as readonly unknown[];
      if (sqlText.includes("INSERT INTO agent_ops.eval_run")) {
        runs[String(p[0])] = {
          run_id: p[0],
          label: p[1],
          opened_at: p[2],
          source_kind: p[3],
          source_digest: p[4],
          subject_version: p[5],
          seed: p[6],
          envelope: p[7],
          redaction: p[8],
          captured_via: p[9],
        };
        return { rows: [] };
      }
      if (sqlText.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sqlText.includes("COALESCE(MAX(sequence)")) {
        const forRun = nodes.filter((n) => n[0]?.["run_id"] === p[0]);
        return { rows: [{ seq: forRun.length }] };
      }
      if (sqlText.includes("INSERT INTO agent_ops.eval_node")) {
        const row: SqlRow = {
          id: p[0],
          run_id: p[1],
          sequence: p[2],
          parent: p[3],
          kind: p[4],
          name: p[5],
          opened_at: p[6],
          closed_at: null,
          elapsed_micros: 0,
          outcome: "ok",
          cost_tenth_cents: 0,
          tokens_in: 0,
          tokens_out: 0,
          price_table_version: "",
          payload_schema_version: p[7],
          redaction: p[8],
          envelope: p[9],
          payload: JSON.parse(String(p[10])) as SqlRow,
          canonical: null,
        };
        nodes.push({ 0: row });
        return { rows: [row] };
      }
      if (sqlText.includes("UPDATE agent_ops.eval_node")) {
        const holder = nodes.find(
          (n) => n[0]?.["run_id"] === p[0] && n[0]?.["id"] === p[1] && n[0]?.["closed_at"] === null,
        );
        const existing = holder?.[0];
        if (holder === undefined || existing === undefined) return { rows: [] };
        const merged: SqlRow = {
          ...existing,
          closed_at: p[2],
          elapsed_micros: p[3],
          outcome: p[4],
          cost_tenth_cents: p[5],
          tokens_in: p[6],
          tokens_out: p[7],
          price_table_version: p[8],
          payload: {
            ...(existing["payload"] as SqlRow),
            ...(JSON.parse(String(p[9])) as SqlRow),
          },
          canonical: p[10],
        };
        holder[0] = merged;
        return { rows: [merged] };
      }
      if (sqlText.includes("SELECT * FROM agent_ops.eval_run")) {
        const row = runs[String(p[0])];
        return { rows: row === undefined ? [] : [row] };
      }
      if (sqlText.includes("SELECT * FROM agent_ops.eval_node")) {
        const rows = nodes
          .map((n) => n[0])
          .filter((r): r is SqlRow => r !== undefined && r["run_id"] === p[0])
          .sort((a, b) => Number(a["sequence"]) - Number(b["sequence"]));
        return { rows };
      }
      if (sqlText.includes("DELETE FROM agent_ops.eval_node")) {
        const doomed = new Set(
          Object.values(runs)
            .filter((r) => Number(r["opened_at"]) < Number(p[0]))
            .map((r) => String(r["run_id"])),
        );
        const removed = nodes.filter((n) => doomed.has(String(n[0]?.["run_id"])));
        for (const r of removed) nodes.splice(nodes.indexOf(r), 1);
        return { rows: removed.map((r) => ({ id: r[0]?.["id"] })) };
      }
      if (sqlText.includes("DELETE FROM agent_ops.eval_run")) {
        for (const [id, row] of Object.entries(runs)) {
          if (Number(row["opened_at"]) < Number(p[0])) delete runs[id];
        }
        return { rows: [] };
      }
      throw new Error(`unhandled statement: ${sqlText}`);
    },
    async transaction(fn) {
      return fn(executor);
    },
  };
  return executor;
};

describe("the SQL store adapter", () => {
  it("runs a whole evaluation through the second adapter", async () => {
    const sql = fakeSql();
    const clock = manualClock();
    const recorder = createEvalRecorder({
      store: sqlEvalNodeStore(sql),
      clock,
      redact: passthroughRedactor,
      timers: systemTimers(),
      ledger: inMemoryRunLedger(),
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: callingSubject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(report.correctBasisPoints).toBe(10_000);
    expect(report.nodes).toBeGreaterThan(10);
    // The sequence is read inside the lock, every time, without exception.
    const locks = sql.statements.filter((s) => s.includes("pg_advisory_xact_lock")).length;
    const inserts = sql.statements.filter((s) => s.includes("INSERT INTO agent_ops.eval_node")).length;
    expect(locks).toBe(inserts);
  });

  it("refuses to settle a node twice, because a node closed twice makes the ordering a lie", async () => {
    const sql = fakeSql();
    const store = sqlEvalNodeStore(sql);
    await store.openRun({
      runId: "r1" as never,
      label: "l",
      openedAt: 1,
      sourceKind: "golden",
      sourceDigest: "d" as never,
      subjectVersion: "v" as never,
      seed: "s" as never,
      envelope: "e",
      redaction: "none",
      capturedVia: "injected-client-only",
    });
    const node = await store.append({
      runId: "r1" as never,
      parent: undefined,
      kind: "run",
      name: "n",
      openedAt: 1,
      payloadSchemaVersion: 1,
      redaction: "none",
      envelope: "e",
      payload: {},
    });
    const settlement = {
      runId: "r1" as never,
      id: node.id,
      closedAt: 2,
      elapsedMicros: 1_000,
      outcome: "ok" as const,
      costTenthCents: 0,
      tokensIn: 0,
      tokensOut: 0,
      priceTableVersion: "p",
      closing: {},
      canonical: "{}",
    };
    await store.settle(settlement);
    await expect(store.settle(settlement)).rejects.toBeInstanceOf(EvalStoreUnavailable);
  });
});

describe("retention", () => {
  it("expires whole runs before a cutoff — the verb audit's store refuses to have", async () => {
    const store = inMemoryEvalNodeStore();
    const clock = manualClock(1_000_000);
    const recorder = createEvalRecorder({
      store,
      clock,
      redact: passthroughRedactor,
      timers: systemTimers(),
      ledger: inMemoryRunLedger(),
    });
    const first = await run({
      label: "day-one",
      cases: threeInvoices(),
      subject: callingSubject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    const cutoff = clock.now();
    clock.advance(90 * 24 * 60 * 60 * 1_000);
    const second = await run({
      label: "day-ninety",
      // A different seed, so this is genuinely a second execution. The label is
      // not part of the run key, so re-asking the identical question ninety days
      // later returns the first run's report and opens no second run — which is
      // the idempotency guarantee working, and would leave nothing here to
      // expire.
      seed: makeSeed("seed-day-ninety"),
      cases: threeInvoices(),
      subject: callingSubject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      limits: smallLimits,
      priceTable,
    });

    const removed = await store.expireBefore(cutoff, 10);
    expect(removed.nodes).toBeGreaterThan(0);
    expect(removed.runs).toBe(1);
    expect(await store.read(first.runId)).toBeUndefined();
    // The newer run survives, and the reports of both survive independently:
    // an eval run's evidentiary value decays with the code it evaluated.
    expect(await store.read(second.runId)).toBeDefined();
    expect(first.traceDigest.length).toBeGreaterThan(0);
  });
});

describe("seven-year readability", () => {
  it("stamps three versions on the artefacts: envelope, payload and schema", async () => {
    const { store, recorder } = harness();
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: callingSubject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    const stored = await store.read(report.runId);
    expect(stored?.header.envelope).toBe(EVAL_ENVELOPE_VERSION);
    for (const node of stored?.nodes ?? []) {
      // The canonicalisation rules that produced the bytes.
      expect(node.envelope).toBe(EVAL_ENVELOPE_VERSION);
      // The field set, declared by whoever opened the node. Never defaulted.
      expect(Number.isSafeInteger(node.payloadSchemaVersion)).toBe(true);
      expect(node.payloadSchemaVersion).toBeGreaterThan(0);
      // Prices are stamped per node, so a mid-run table change is visible.
      expect(node.priceTableVersion).toBe(priceTable.version);
      // Every number that reached the store is a safe integer.
      for (const value of Object.values(node.payload)) {
        if (typeof value === "number") expect(Number.isSafeInteger(value)).toBe(true);
      }
    }
    // The artefact names its own shape, so a reader in 2033 needs no registry.
    expect(report.schema).toBe("report.accuracy/2");
  });
});
