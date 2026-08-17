import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOORS,
  DEFAULT_LIMITS,
  defineSubject,
  determine,
  exactVerdict,
  gate,
  goldenSuite,
  LimitOutOfRange,
  run,
  scriptedModelBackend,
  SuiteEmpty,
  SuiteUnversioned,
  SuiteVersionMismatch,
} from "../index.js";
import type { CaseSource, Limits } from "../index.js";
import {
  echoBackend,
  harness,
  PROMPT_V1,
  priceTable,
  smallLimits,
  TEST_MODEL,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/**
 * Slice 6 — bounds, budgets and versioning.
 *
 * There is no unbounded anything in this module: not the concurrency, not the
 * queue, not the retries, not the wall clock, not the cost, not the store. Every
 * bound has a ceiling and every ceiling is checked before the first case runs.
 */

const suiteOf = (count: number) =>
  goldenSuite({
    cases: Array.from({ length: count }, (_, i) => ({
      ref: `INV-${String(i).padStart(4, "0")}`,
      tier: "medium" as const,
      input: { index: i },
      expected: determine("duplicate", 9_000),
      adjudicatedBy: "a.reviewer",
      adjudicatedAt: 1_690_000_000_000,
    })),
  });

const callingSubject = defineSubject({
  version: testSubjectVersion,
  purity: "calls-models",
  decide: async (ctx) => {
    const answer = await ctx.client.complete({
      model: TEST_MODEL,
      promptVersion: PROMPT_V1,
      prompt: { index: Number(ctx.input["index"] ?? 0) },
    });
    return determine(answer.text, 9_000);
  },
});

describe("bounded concurrency", () => {
  it("never exceeds the declared concurrency, and clears 200 cases at 8", async () => {
    let inFlight = 0;
    let peak = 0;
    const backend = scriptedModelBackend({
      id: "counting",
      answer: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { text: "duplicate", tokensIn: 1_000, tokensOut: 20 };
      },
    });

    const { recorder } = harness();
    const started = Date.now();
    const report = await run({
      label: "pre-merge",
      cases: suiteOf(200),
      subject: callingSubject,
      scorers: [exactVerdict],
      models: backend,
      recorder,
      seed: testSeed,
      limits: DEFAULT_LIMITS,
      priceTable,
    });

    // The target is 200 golden cases under 5 minutes at concurrency 8. What is
    // asserted here is the mechanism — the pool is bounded and the run
    // completes — because the wall clock is dominated by the subject, which in
    // production is a model call and here is a millisecond.
    expect(peak).toBeLessThanOrEqual(DEFAULT_LIMITS.concurrency);
    expect(peak).toBeGreaterThan(1);
    expect(report.casesRun).toBe(200);
    expect(report.correctBasisPoints).toBe(10_000);
    expect(Date.now() - started).toBeLessThan(DEFAULT_LIMITS.runMillis);
  });

  it("refuses a limit outside its range before anything runs", async () => {
    const { recorder } = harness();
    const attempt = (limits: Limits) =>
      run({
        label: "pre-merge",
        cases: threeInvoices(),
        subject: callingSubject,
        scorers: [exactVerdict],
        models: echoBackend(),
        recorder,
        seed: testSeed,
        limits,
        priceTable,
      });
    await expect(attempt({ ...smallLimits, concurrency: 0 })).rejects.toBeInstanceOf(LimitOutOfRange);
    await expect(attempt({ ...smallLimits, concurrency: 33 })).rejects.toBeInstanceOf(
      LimitOutOfRange,
    );
    await expect(attempt({ ...smallLimits, retries: 6 })).rejects.toBeInstanceOf(LimitOutOfRange);
    await expect(attempt({ ...smallLimits, perCaseMillis: 1.5 })).rejects.toBeInstanceOf(
      LimitOutOfRange,
    );
  });
});

describe("budgets", () => {
  it("stops on too many case failures, marks the report partial, and the gate refuses it", async () => {
    const { recorder } = harness();
    const exploding = defineSubject({
      version: testSubjectVersion,
      purity: "calls-models",
      decide: async () => {
        throw new Error("supplier lookup failed");
      },
    });
    const report = await run({
      label: "pre-merge",
      cases: suiteOf(20),
      subject: exploding,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 2 },
      priceTable,
    });
    expect(report.partial).toBe(true);
    expect(report.partialReason).toContain("case-failures");
    expect(report.casesRun).toBeLessThan(20);
    expect(report.casesDeclared).toBe(20);

    const outcome = await gate({
      report,
      baseline: {
        schema: "baseline/1",
        acceptedBy: "a.engineer",
        acceptedAt: 1_700_000_000_000,
        fromRun: report.runId,
        suiteDigest: report.suiteDigest,
        subjectVersion: report.subjectVersion,
        cases: [],
      },
      floors: DEFAULT_FLOORS,
      recorder,
    });
    // A run that stopped at case 3 of 20 has a biased sample. Publishing it as a
    // pass invites it being read as complete.
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("partial-run");
  });

  it("stops when the cost ceiling is spent", async () => {
    const { recorder } = harness();
    const report = await run({
      label: "pre-merge",
      cases: suiteOf(50),
      subject: callingSubject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      // 1000 input tokens at 30_000 tenth-cents per million = 30 tenth-cents,
      // plus 20 output at 150_000/M = 3. So 33 per case; 100 buys three.
      limits: { ...smallLimits, concurrency: 1, costCeilingTenthCents: 100 },
      priceTable,
    });
    expect(report.partial).toBe(true);
    expect(report.partialReason).toContain("cost");
    expect(report.casesRun).toBeLessThan(50);
    expect(report.costTenthCents).toBeGreaterThan(100);
  });
});

describe("suites are versioned and content-addressed", () => {
  it("refuses an empty suite, because it would pass every gate trivially", () => {
    expect(() => goldenSuite({ cases: [] })).toThrow(SuiteEmpty);
  });

  it("is content-addressed, and stable under listing order", () => {
    const a = threeInvoices();
    const b = threeInvoices();
    expect(a.digest).toBe(b.digest);
    expect(a.digest.length).toBeGreaterThan(0);
  });

  it("refuses a suite whose pinned digest no longer matches", () => {
    const suite = threeInvoices();
    expect(() => goldenSuite({ cases: [], expectDigest: suite.digest })).toThrow(SuiteEmpty);
    expect(() =>
      goldenSuite({
        cases: [
          {
            ref: "INV-0001",
            tier: "high",
            input: { supplier: "acme", amountMinorUnits: 4_720_001 },
            expected: determine("duplicate", 9_000),
            adjudicatedBy: "a.reviewer",
            adjudicatedAt: 1_690_000_000_000,
          },
        ],
        expectDigest: suite.digest,
      }),
    ).toThrow(SuiteVersionMismatch);
  });

  it("refuses a hand-rolled source with no content address, before any spend", async () => {
    const { recorder } = harness();
    let dialled = false;
    const unversioned = {
      ...threeInvoices(),
      digest: "" as CaseSource<"golden">["digest"],
    };
    await expect(
      run({
        label: "pre-merge",
        cases: unversioned,
        subject: callingSubject,
        scorers: [exactVerdict],
        models: scriptedModelBackend({
          id: "should-not-be-called",
          answer: () => {
            dialled = true;
            return { text: "duplicate", tokensIn: 1, tokensOut: 1 };
          },
        }),
        recorder,
        seed: testSeed,
        limits: smallLimits,
        priceTable,
      }),
    ).rejects.toBeInstanceOf(SuiteUnversioned);
    expect(dialled).toBe(false);
  });
});
