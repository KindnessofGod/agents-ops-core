import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOORS,
  defineSubject,
  determine,
  gate,
  judgePanel,
  PanelMisdeclared,
  run,
  scriptedModelBackend,
} from "../index.js";
import type { AccuracyReport, ModelRequest, ModelResponse } from "../index.js";
import {
  harness,
  PROMPT_V1,
  priceTable,
  smallLimits,
  TEST_JUDGE,
  TEST_MODEL,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/**
 * Slice 5 — judge scorers.
 *
 * Three obligations from interface fact 6, and the third is the one a naive
 * implementation gets wrong: record the judge model and prompt version,
 * aggregate over n > 1, and **surface panel disagreement rather than averaging
 * it away**. A panel that splits 2–1 must not become a confident number in the
 * middle; it must become a case somebody looks at.
 */

const JUDGE_PROMPT = PROMPT_V1;

const subject = defineSubject({
  version: testSubjectVersion,
  purity: "calls-models",
  decide: async (ctx) => {
    const answer = await ctx.client.complete({
      model: TEST_MODEL,
      promptVersion: PROMPT_V1,
      prompt: {},
    });
    return determine(answer.text, 9_000);
  },
});

/** Answers the subject normally and the judges from a per-member script. */
const backendWithJudges = (judgeAnswers: (member: number) => string) =>
  scriptedModelBackend({
    id: "scripted",
    answer: (request: ModelRequest): ModelResponse => {
      if (request.model === TEST_JUDGE) {
        const member = Number(request.prompt["member"]);
        return { text: judgeAnswers(member), tokensIn: 500, tokensOut: 5 };
      }
      return { text: "duplicate", tokensIn: 1_000, tokensOut: 20 };
    },
  });

const runWithPanel = async (
  judgeAnswers: (member: number) => string,
  bandBasisPoints: number,
): Promise<{ report: AccuracyReport; harness: ReturnType<typeof harness> }> => {
  const h = harness();
  const report = await run({
    label: "nightly",
    cases: threeInvoices(),
    subject,
    scorers: [
      judgePanel({
        model: TEST_JUDGE,
        promptVersion: JUDGE_PROMPT,
        panelSize: 3,
        bandBasisPoints,
        rubric: "is the conclusion supported by the evidence?",
      }),
    ],
    models: backendWithJudges(judgeAnswers),
    recorder: h.recorder,
    seed: testSeed,
    limits: smallLimits,
    priceTable,
  });
  return { report, harness: h };
};

describe("judge panels", () => {
  it("refuses a panel that is even, too small, or a single opinion", () => {
    const base = {
      model: TEST_JUDGE,
      promptVersion: JUDGE_PROMPT,
      bandBasisPoints: 500,
      rubric: "r",
    };
    expect(() => judgePanel({ ...base, panelSize: 1 })).toThrow(PanelMisdeclared);
    expect(() => judgePanel({ ...base, panelSize: 2 })).toThrow(PanelMisdeclared);
    expect(() => judgePanel({ ...base, panelSize: 4 })).toThrow(PanelMisdeclared);
    expect(() => judgePanel({ ...base, panelSize: 9 })).toThrow(PanelMisdeclared);
    expect(judgePanel({ ...base, panelSize: 3 }).descriptor.determinism).toBe("non-deterministic");
  });

  it("records the judge model and prompt version on every sample", async () => {
    const { report, harness: h } = await runWithPanel(() => "10000", 500);
    const nodes = (await h.store.read(report.runId))?.nodes ?? [];

    const scoring = nodes.filter((n) => n.kind === "scoring");
    expect(scoring).toHaveLength(3);
    expect(scoring[0]?.payload["judgeModel"]).toBe("test-judge");
    expect(scoring[0]?.payload["judgePromptVersion"]).toBe(JUDGE_PROMPT);
    expect(scoring[0]?.payload["panelSize"]).toBe(3);
    expect(scoring[0]?.payload["determinism"]).toBe("non-deterministic");

    // n > 1: three samples per case, each its own node, each with its own model
    // call carrying the model and the prompt version.
    const samples = nodes.filter((n) => n.name === "judge.sample");
    expect(samples).toHaveLength(9);
    const judgeCalls = nodes.filter((n) => n.kind === "model.call" && n.name === "test-judge");
    expect(judgeCalls).toHaveLength(9);
    for (const call of judgeCalls) {
      expect(call.payload["promptVersion"]).toBe(JUDGE_PROMPT);
      expect(call.payload["model"]).toBe("test-judge");
    }

    // The report declares itself non-deterministic and names the reason rather
    // than claiming a reproducibility it cannot deliver.
    expect(report.determinism.declared).toBe("non-deterministic");
    expect(report.correctBasisPoints).toBe(10_000);
  });

  it("surfaces a split panel as contested, carrying every sample, never a mean", async () => {
    // 10000 / 10000 / 0 — a mean would be 6667 and would look like a mediocre
    // pass. It is not a mediocre pass. It is a ruler that disagrees with itself.
    const { report, harness: h } = await runWithPanel(
      (member) => (member === 2 ? "0" : "10000"),
      500,
    );

    expect(report.contestedBasisPoints).toBe(10_000);
    expect(report.correctBasisPoints).toBe(0);
    expect(report.cases.every((c) => c.status === "contested")).toBe(true);
    expect(report.cases[0]?.detail).toContain("10000/10000/0");
    // Nothing anywhere equals the average of the panel.
    expect(report.cases[0]?.detail).not.toContain("6667");

    const nodes = (await h.store.read(report.runId))?.nodes ?? [];
    const scoring = nodes.filter((n) => n.kind === "scoring");
    expect(scoring[0]?.payload["kind"]).toBe("contested");
    expect(scoring[0]?.payload["spreadBasisPoints"]).toBe(10_000);
    expect(scoring[0]?.payload["samples"]).toBe("10000/10000/0");
    expect(scoring[0]?.outcome).toBe("indeterminate");
  });

  it("blocks the gate on a contested rate above the floor", async () => {
    const { report, harness: h } = await runWithPanel(
      (member) => (member === 2 ? "0" : "10000"),
      500,
    );
    const outcome = await gate({
      report,
      baseline: {
        schema: "baseline/1",
        acceptedBy: "a.engineer",
        acceptedAt: 1_700_000_000_000,
        fromRun: report.runId,
        suiteDigest: report.suiteDigest,
        subjectVersion: report.subjectVersion,
        cases: report.cases.map((c) => ({
          ref: c.ref,
          digest: c.digest,
          status: "contested" as const,
          scoreBasisPoints: 0,
        })),
      },
      floors: DEFAULT_FLOORS,
      recorder: h.recorder,
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("contested-rate");
    // Adjudication candidates, not defects. The vocabulary holds even here.
    expect(outcome.remedy).toContain("adjudication candidates, not defects");
  });

  it("scores a case unscored — never passed — when the judge cannot be reached", async () => {
    const h = harness();
    const report = await run({
      label: "nightly",
      cases: threeInvoices(),
      subject,
      scorers: [
        judgePanel({
          model: TEST_JUDGE,
          promptVersion: JUDGE_PROMPT,
          panelSize: 3,
          bandBasisPoints: 500,
          rubric: "r",
        }),
      ],
      models: scriptedModelBackend({
        id: "scripted",
        answer: (request) => {
          if (request.model === TEST_JUDGE) throw new Error("judge unavailable");
          return { text: "duplicate", tokensIn: 10, tokensOut: 1 };
        },
      }),
      recorder: h.recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    expect(report.unscoredBasisPoints).toBe(10_000);
    expect(report.correctBasisPoints).toBe(0);
    expect(report.cases[0]?.status).toBe("unscored");
    expect(report.cases[0]?.detail).toBe("judge-unavailable");
  });
});
