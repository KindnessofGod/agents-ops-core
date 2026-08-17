import { describe, expect, it } from "vitest";
import {
  accept,
  DEFAULT_FLOORS,
  defineSubject,
  determine,
  exactVerdict,
  gate,
  goldenSuite,
  run,
} from "../index.js";
import type { AccuracyReport, Baseline } from "../index.js";
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
import { compileFixture } from "./typecheck.js";

const subjectSaying = (text: string) =>
  defineSubject({
    version: testSubjectVersion,
    purity: "calls-models",
    decide: async (ctx) => {
      const answer = await ctx.client.complete({
        model: TEST_MODEL,
        promptVersion: PROMPT_V1,
        prompt: { supplier: String(ctx.input["supplier"]) },
      });
      return determine(text === "" ? answer.text : text, 9_000);
    },
  });

const goldenRun = async (text: string): Promise<AccuracyReport> => {
  const { recorder } = harness();
  return run({
    label: "pre-merge",
    cases: threeInvoices(),
    subject: subjectSaying(text),
    scorers: [exactVerdict],
    models: echoBackend(),
    recorder,
    seed: testSeed,
    limits: smallLimits,
    priceTable,
  });
};

describe("agreement is not accuracy, and the compiler enforces it", () => {
  it("compiles the disjointness fixture with exactly the expected errors", () => {
    // Zero diagnostics: every expected error is marked `@ts-expect-error`, and a
    // directive that stops being needed raises TS2578 and fails this test.
    expect(compileFixture("reports-are-disjoint.ts")).toEqual([]);
  });

  it("compiles the capability and recorder-brand fixture with exactly the expected errors", () => {
    expect(compileFixture("subject-cannot-write.ts")).toEqual([]);
  });

  it("derives the report type from the case source rather than the verb called", async () => {
    const report = await goldenRun("");
    // A golden source produced an accuracy report. Its provenance is on it.
    expect(report.schema).toBe("report.accuracy/1");
    expect(report.against).toBe("golden");
    expect(report.capturedVia).toBe("injected-client-only");
  });
});

describe("the gate", () => {
  it("blocks explicitly when there is no baseline, and says what to do", async () => {
    const { recorder } = harness();
    const report = await goldenRun("");
    const outcome = await gate({
      report,
      baseline: undefined,
      floors: DEFAULT_FLOORS,
      recorder,
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("baseline-missing");
    expect(outcome.remedy).toContain("accept(");
    // Every case is reported as new, and none of them is a regression.
    expect(outcome.counts.newCases).toHaveLength(3);
    expect(outcome.counts.regressed).toHaveLength(0);
  });

  it("passes on an unchanged run and blocks on a regression", async () => {
    const { recorder } = harness();
    const good = await goldenRun("");
    const baseline: Baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });

    const unchanged = await gate({ report: good, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(unchanged.kind).toBe("passed");

    // Someone tightens a prompt and the subject now concludes something else.
    const regressed = await goldenRun("not-duplicate");
    const blocked = await gate({ report: regressed, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(blocked.kind).toBe("blocked");
    if (blocked.kind !== "blocked") throw new Error("unreachable");
    expect(blocked.reason).toBe("regression");
    expect(blocked.counts.regressed).toHaveLength(3);
  });

  it("blocks when a golden case present in the baseline has been dropped", async () => {
    const { recorder } = harness();
    const full = await goldenRun("");
    const baseline = accept({ report: full, by: "a.engineer", at: 1_700_000_000_000 });

    const { recorder: recorder2 } = harness();
    const shrunk = await run({
      label: "pre-merge",
      cases: goldenSuite({
        cases: [
          {
            ref: "INV-0001",
            tier: "high",
            input: { supplier: "acme", amountMinorUnits: 4_720_000 },
            expected: determine("duplicate", 9_000),
            adjudicatedBy: "a.reviewer",
            adjudicatedAt: 1_690_000_000_000,
          },
        ],
      }),
      subject: subjectSaying(""),
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder: recorder2,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });

    const outcome = await gate({ report: shrunk, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    // The cheapest way to make a gate green is to delete the failing evidence.
    expect(outcome.reason).toBe("dropped-cases");
    expect(outcome.counts.dropped).toEqual(["INV-0002", "INV-0003"]);
  });

  it("records its own decision as a node", async () => {
    const { store, recorder } = harness();
    const report = await goldenRun("");
    const outcome = await gate({ report, baseline: undefined, floors: DEFAULT_FLOORS, recorder });
    const stored = await store.read(outcome.gateRun);
    const gateNodes = (stored?.nodes ?? []).filter((n) => n.kind === "gate");
    expect(gateNodes).toHaveLength(1);
    expect(gateNodes[0]?.payload["outcome"]).toBe("blocked");
    expect(gateNodes[0]?.payload["reason"]).toBe("baseline-missing");
    expect(gateNodes[0]?.id).toBe(outcome.node);
  });
});
