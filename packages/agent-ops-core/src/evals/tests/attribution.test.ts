import { describe, expect, it } from "vitest";
import { DEFAULT_FLOORS, defineSubject, determine, exactVerdict, gate, run } from "../index.js";
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
 * Slice 3 — `UnattributedDecision`.
 *
 * This is the module's answer to the one place C1 cannot be met absolutely. A
 * subject can hold its own closure and call a provider directly; no type in this
 * package can reach outside this package. What the module *can* do is notice
 * that a decision subtree recorded no model call while the subject declared it
 * calls models — and refuse to score it, refuse to count it as coverage, and
 * fail the build.
 *
 * Silent under-recording becomes a red build rather than a quiet green one.
 */
describe("unattributed decisions", () => {
  const thinkingElsewhere = defineSubject({
    version: testSubjectVersion,
    purity: "calls-models",
    // Stands in for `import Anthropic from "…"; await client.messages.create(…)`.
    // Nothing in the module mediates it, so nothing in the module records it.
    decide: async () => determine("duplicate", 9_000),
  });

  const genuinelyPure = defineSubject({
    version: testSubjectVersion,
    purity: "pure",
    decide: async (ctx) =>
      determine(Number(ctx.input["amountMinorUnits"]) > 1_000 ? "duplicate" : "clean", 9_000),
  });

  it("marks a decision with no model call as unattributed and refuses to score it", async () => {
    const { store, recorder } = harness();
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

    expect(report.attribution).toBe("partial");
    expect(report.attributionCoverageBasisPoints).toBe(0);
    expect(report.unattributedCases).toEqual(["INV-0001", "INV-0002", "INV-0003"]);
    // The verdicts happened to be right. They are not counted as correct,
    // because nobody can show where they came from.
    expect(report.correctBasisPoints).toBe(0);
    expect(report.unscoredBasisPoints).toBe(10_000);
    expect(report.cases.every((c) => c.status === "unattributed")).toBe(true);

    const nodes = (await store.read(report.runId))?.nodes ?? [];
    const decisions = nodes.filter((n) => n.kind === "decision");
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) {
      expect(decision.outcome).toBe("unattributed");
      expect(decision.payload["modelCalls"]).toBe(0);
      expect(decision.payload["purity"]).toBe("calls-models");
    }
    // No scoring node: there is nothing to score. A case nobody can attribute is
    // not a case that went well, and it is not a case that went badly either.
    expect(nodes.filter((n) => n.kind === "scoring")).toHaveLength(0);
  });

  it("fails the gate — silent under-recording is a red build", async () => {
    const { recorder } = harness();
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
    // A baseline exists, and every case still "passes" on its verdict. The gate
    // blocks anyway, on coverage.
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
          status: "correct" as const,
          scoreBasisPoints: 10_000,
        })),
      },
      floors: DEFAULT_FLOORS,
      recorder,
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("unattributed-decisions");
    expect(outcome.remedy).toContain('purity: "pure"');
  });

  it("scores a subject that declared itself pure, because the two are different claims", async () => {
    const { recorder } = harness();
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: genuinelyPure,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    // "We are a rules engine" and "we thought somewhere you cannot see" must not
    // share a representation, and the declaration is what separates them.
    expect(report.attribution).toBe("complete");
    expect(report.attributionCoverageBasisPoints).toBe(10_000);
    // INV-0003 is £9.00, under the rule's threshold, so it concludes "clean".
    expect(report.correctBasisPoints).toBe(6_667);
    expect(report.incorrectBasisPoints).toBe(3_333);
  });

  it("attributes a decision whose model call happened inside a nested span", async () => {
    const { recorder } = harness();
    const nested = defineSubject({
      version: testSubjectVersion,
      purity: "calls-models",
      decide: async (ctx) =>
        ctx.node.child({ name: "extract", v: 1, payload: {} }, async (child) =>
          child.node.child({ name: "deeper", v: 1, payload: {} }, async (grandchild) =>
            determine(
              (
                await grandchild.client.complete({
                  model: TEST_MODEL,
                  promptVersion: PROMPT_V1,
                  prompt: {},
                })
              ).text,
              9_000,
            ),
          ),
        ),
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject: nested,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    // The count is over the whole subtree, not the immediate children.
    expect(report.attribution).toBe("complete");
    expect(report.correctBasisPoints).toBe(10_000);
  });
});
