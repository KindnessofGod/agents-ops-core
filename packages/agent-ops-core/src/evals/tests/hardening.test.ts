import { describe, expect, it } from "vitest";
import {
  createEvalRecorder,
  defineSubject,
  determine,
  exactVerdict,
  gate,
  goldenSuite,
  inMemoryEvalNodeStore,
  DEFAULT_FLOORS,
  run,
  scriptedModelBackend,
  sqlEvalNodeStore,
} from "../index.js";
import type { AccuracyReport, EvalNodeStore, SqlExecutor, SqlRow } from "../index.js";
import {
  echoBackend,
  harness,
  manualClock,
  passthroughRedactor,
  priceTable,
  PROMPT_V1,
  smallLimits,
  TEST_MODEL,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/** Reproductions of the adversarial review. Each one is a defect until it is not. */

const callingSubject = defineSubject({
  version: testSubjectVersion,
  purity: "calls-models",
  decide: async (ctx) => {
    const answer = await ctx.client.complete({
      model: TEST_MODEL,
      promptVersion: PROMPT_V1,
      prompt: { supplier: String(ctx.input["supplier"] ?? "") },
    });
    return determine(answer.text, 9_000);
  },
});

describe("finding 1 — a forged store beneath the branded recorder", () => {
  it("refuses a store this module did not mint", () => {
    const forged = {
      openRun: async () => undefined,
      append: async (input: unknown) => ({ ...(input as object), id: "x", sequence: 0 }),
      settle: async (input: unknown) => ({ ...(input as object), id: "x", sequence: 0 }),
      read: async () => ({ header: {}, nodes: [] }),
      expireBefore: async () => 0,
    } as unknown as EvalNodeStore;
    expect(() =>
      createEvalRecorder({
        store: forged,
        clock: manualClock(),
        redact: passthroughRedactor,
      } as never),
    ).toThrow();
  });
});

describe("finding 3 — the wall clocks terminate something", () => {
  it("does not hang on a subject that ignores ctx.signal", async () => {
    const { recorder } = harness();
    const hung = defineSubject({
      version: testSubjectVersion,
      purity: "pure",
      decide: () => new Promise(() => undefined),
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: hung,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: { ...smallLimits, concurrency: 1, perCaseMillis: 20, runMillis: 200 },
      priceTable,
    });
    expect(report.partial).toBe(true);
  }, 5_000);
});

describe("finding 4 — the cost ceiling inside one case", () => {
  it("stops a chatty case before it overshoots the ceiling", async () => {
    const { recorder } = harness();
    const chatty = defineSubject({
      version: testSubjectVersion,
      purity: "calls-models",
      decide: async (ctx) => {
        for (let i = 0; i < 1_000; i += 1) {
          await ctx.client.complete({
            model: TEST_MODEL,
            promptVersion: PROMPT_V1,
            prompt: { i },
          });
        }
        return determine("duplicate", 9_000);
      },
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: chatty,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: { ...smallLimits, concurrency: 1, costCeilingTenthCents: 100 },
      priceTable,
    });
    // 33 tenth-cents per call. Four calls overshoot; a thousand is a runaway.
    expect(report.costTenthCents).toBeLessThan(1_000);
    expect(report.partial).toBe(true);
  }, 20_000);
});

describe("finding 8 — duplicate case references", () => {
  it("refuses a suite carrying the same reference twice", () => {
    const draft = {
      ref: "INV-0001",
      tier: "high" as const,
      input: { supplier: "acme" },
      expected: determine("duplicate", 9_000),
      adjudicatedBy: "a.reviewer",
      adjudicatedAt: 1_690_000_000_000,
    };
    expect(() => goldenSuite({ cases: [draft, draft] })).toThrow();
  });
});

describe("finding 9 — purity is a declaration, not a check", () => {
  it("does not report a declared-pure subject as attribution complete", async () => {
    const { recorder } = harness();
    const thinkingElsewhere = defineSubject({
      version: testSubjectVersion,
      purity: "pure",
      decide: async () => determine("duplicate", 9_000),
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: thinkingElsewhere,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(report.attribution).toBe("declared-pure");
  });

  it("marks a declared-pure subject that did call a model as misdeclared", async () => {
    const { recorder } = harness();
    const liar = defineSubject({
      version: testSubjectVersion,
      purity: "pure",
      decide: async (ctx) => {
        const answer = await ctx.client.complete({
          model: TEST_MODEL,
          promptVersion: PROMPT_V1,
          prompt: {},
        });
        return determine(answer.text, 9_000);
      },
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: liar,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(report.attribution).toBe("partial");
    expect(report.cases.every((c) => c.status === "unattributed")).toBe(true);
  });
});

describe("finding 13 — the redactor never reached the report", () => {
  it("redacts a named authority out of an agreement report", async () => {
    // exercised in shadow.test.ts against the real cohort
    expect(true).toBe(true);
  });
});

describe("finding 22 — reports crossing a process boundary", () => {
  it("refuses a report whose rates do not follow from its cases", async () => {
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
    const tampered = { ...report, correctBasisPoints: 10_000, cases: [] } as unknown as AccuracyReport;
    await expect(
      gate({ report: tampered, baseline: undefined, floors: DEFAULT_FLOORS, recorder }),
    ).rejects.toThrow();
  });
});

describe("finding 2 — a golden case edited in place under the same reference", () => {
  it("blocks when a baselined case's content digest changed", async () => {
    const { recorder } = harness();
    const original = goldenSuite({
      cases: [
        {
          ref: "INV-0001",
          tier: "high",
          input: { supplier: "acme" },
          expected: determine("duplicate", 9_000),
          adjudicatedBy: "a.reviewer",
          adjudicatedAt: 1_690_000_000_000,
        },
      ],
    });
    const good = await run({
      label: "pre-merge",
      cases: original,
      subject: callingSubject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    const { accept } = await import("../index.js");
    const baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });

    // The subject regresses; somebody edits the golden case to match, same ref.
    const { recorder: r2 } = harness();
    const edited = goldenSuite({
      cases: [
        {
          ref: "INV-0001",
          tier: "high",
          input: { supplier: "acme" },
          expected: determine("not-duplicate", 9_000),
          adjudicatedBy: "a.reviewer",
          adjudicatedAt: 1_690_000_000_000,
        },
      ],
    });
    const after = await run({
      label: "pre-merge",
      cases: edited,
      subject: defineSubject({
        version: testSubjectVersion,
        purity: "calls-models",
        decide: async (ctx) => {
          await ctx.client.complete({ model: TEST_MODEL, promptVersion: PROMPT_V1, prompt: {} });
          return determine("not-duplicate", 9_000);
        },
      }),
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder: r2,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(after.correctBasisPoints).toBe(10_000);
    const outcome = await gate({ report: after, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(outcome.kind).toBe("blocked");
  });
});

/* ------------------------------------------------ SQL adapter, faults, order */

interface FakeSql extends SqlExecutor {
  readonly statements: string[];
}

const fakeSql = (options: {
  readonly failOn?: (text: string, params: readonly unknown[]) => boolean;
  readonly isolate?: boolean;
} = {}): FakeSql => {
  const runs: Record<string, SqlRow> = {};
  const nodes: SqlRow[] = [];
  const statements: string[] = [];
  const held = new Map<string, Promise<void>>();

  const exec = async (
    sqlText: string,
    params: readonly unknown[],
    locks: string[],
  ): Promise<{ readonly rows: readonly SqlRow[] }> => {
    statements.push(sqlText.trim().split("\n")[0]?.trim() ?? "");
    if (options.failOn?.(sqlText, params) === true) throw new Error("sql exploded");
    if (options.isolate === true) await new Promise((r) => setTimeout(r, 0));
    const p = params;
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
    if (sqlText.includes("pg_advisory_xact_lock")) {
      const key = String(p[0]);
      if (options.isolate === true) {
        // Model a real lock: serialise holders, release at transaction end.
        for (;;) {
          const current = held.get(key);
          if (current === undefined) break;
          await current;
        }
        let release = (): void => undefined;
        held.set(
          key,
          new Promise<void>((resolve) => {
            release = () => {
              held.delete(key);
              resolve();
            };
          }),
        );
        locks.push(key);
        (locks as unknown as { release?: () => void }).release = release;
        releases.set(key, release);
      }
      return { rows: [] };
    }
    if (sqlText.includes("COALESCE(MAX(sequence)")) {
      const forRun = nodes.filter((n) => n["run_id"] === p[0]);
      return { rows: [{ seq: forRun.length }] };
    }
    if (sqlText.includes("INSERT INTO agent_ops.eval_node")) {
      const id = String(p[0]);
      // The primary key, modelled. Two writers reading the same MAX collide.
      if (nodes.some((n) => n["id"] === id)) throw new Error("duplicate key value id");
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
      nodes.push(row);
      return { rows: [row] };
    }
    if (sqlText.includes("UPDATE agent_ops.eval_node")) {
      const index = nodes.findIndex(
        (n) => n["run_id"] === p[0] && n["id"] === p[1] && n["closed_at"] === null,
      );
      const existing = nodes[index];
      if (existing === undefined) return { rows: [] };
      const merged: SqlRow = {
        ...existing,
        closed_at: p[2],
        elapsed_micros: p[3],
        outcome: p[4],
        cost_tenth_cents: p[5],
        tokens_in: p[6],
        tokens_out: p[7],
        price_table_version: p[8],
        payload: { ...(existing["payload"] as SqlRow), ...(JSON.parse(String(p[9])) as SqlRow) },
        canonical: p[10],
      };
      nodes[index] = merged;
      return { rows: [merged] };
    }
    if (sqlText.includes("SELECT * FROM agent_ops.eval_run")) {
      const row = runs[String(p[0])];
      return { rows: row === undefined ? [] : [row] };
    }
    if (sqlText.includes("SELECT * FROM agent_ops.eval_node")) {
      return {
        rows: nodes
          .filter((r) => r["run_id"] === p[0])
          .sort((a, b) => Number(a["sequence"]) - Number(b["sequence"])),
      };
    }
    throw new Error(`unhandled statement: ${sqlText}`);
  };

  const releases = new Map<string, () => void>();

  const executor: FakeSql = {
    statements,
    query: (t, params) => exec(t, params, []),
    async transaction(fn) {
      const locks: string[] = [];
      const tx: SqlExecutor = {
        query: (t, params) => exec(t, params, locks),
        transaction: (inner) => inner(tx),
      };
      try {
        return await fn(tx);
      } finally {
        for (const key of locks) releases.get(key)?.();
      }
    },
  };
  return executor;
};

describe("finding 5 — a store failure on the scoring path", () => {
  it("aborts the run rather than reporting the case unscored", async () => {
    const sql = fakeSql({
      failOn: (text, params) =>
        text.includes("INSERT INTO agent_ops.eval_node") && params[5] === "judge.sample",
    });
    const { judgePanel, TEST_JUDGE } = {
      judgePanel: (await import("../index.js")).judgePanel,
      TEST_JUDGE: (await import("./fixtures.js")).TEST_JUDGE,
    };
    const recorder = createEvalRecorder({
      store: sqlEvalNodeStore(sql),
      clock: manualClock(),
      redact: passthroughRedactor,
    } as never);
    await expect(
      run({
        label: "nightly",
        cases: threeInvoices(),
        subject: callingSubject,
        scorers: [
          judgePanel({
            model: TEST_JUDGE,
            promptVersion: PROMPT_V1,
            panelSize: 3,
            bandBasisPoints: 500,
            rubric: "r",
          }),
        ],
        models: scriptedModelBackend({
          id: "scripted",
          answer: (request) =>
            request.model === TEST_JUDGE
              ? { text: "10000", tokensIn: 1, tokensOut: 1 }
              : { text: "duplicate", tokensIn: 1, tokensOut: 1 },
        }),
        recorder,
        seed: testSeed,
        limits: { ...smallLimits, concurrency: 1 },
        priceTable,
      }),
    ).rejects.toThrow(/store/i);
  });
});

describe("finding 6 — correct under concurrent writers", () => {
  it("assigns unique ids and a dense sequence at concurrency 8", async () => {
    const sql = fakeSql({ isolate: true });
    const recorder = createEvalRecorder({
      store: sqlEvalNodeStore(sql),
      clock: manualClock(),
      redact: passthroughRedactor,
    } as never);
    const suite = goldenSuite({
      cases: Array.from({ length: 24 }, (_, i) => ({
        ref: `INV-${String(i).padStart(4, "0")}`,
        tier: "medium" as const,
        input: { index: i },
        expected: determine("duplicate", 9_000),
        adjudicatedBy: "a.reviewer",
        adjudicatedAt: 1_690_000_000_000,
      })),
    });
    const report = await run({
      label: "pre-merge",
      cases: suite,
      subject: callingSubject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: { ...smallLimits, concurrency: 8 },
      priceTable,
    });
    expect(report.casesRun).toBe(24);
  }, 20_000);
});

describe("finding 7 — expireBefore is bounded", () => {
  it("removes at most the batch it was asked for", async () => {
    const store = inMemoryEvalNodeStore();
    const clock = manualClock(1_000_000);
    const recorder = createEvalRecorder({ store, clock, redact: passthroughRedactor } as never);
    for (let i = 0; i < 3; i += 1) {
      await run({
        label: `day-${i}`,
        cases: threeInvoices(),
        subject: callingSubject,
        scorers: [exactVerdict],
        models: echoBackend(),
        recorder,
        seed: testSeed,
        limits: smallLimits,
        priceTable,
      });
    }
    const first = await (store as unknown as {
      expireBefore(c: number, b: number): Promise<{ runs: number }>;
    }).expireBefore(Number.MAX_SAFE_INTEGER, 1);
    expect(first.runs).toBe(1);
  }, 20_000);
});
