import { describe, expect, it } from "vitest";
import { defineSubject, determine, exactVerdict, run } from "../index.js";
import type { EvalNode } from "../index.js";
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
 * Slice 1 — the node handle is the capability.
 *
 * The claim under test is the strongest one in the module: a subject that
 * contains **no recording code at all** still emits a complete graph, because
 * the only way it can reach a model is through a client that only a node can
 * mint.
 */
describe("the node handle is the capability", () => {
  it("emits a complete graph for a subject that never calls child()", async () => {
    const { store, recorder } = harness();
    const suite = threeInvoices();

    // Note what is absent from this subject: no recorder, no store, no clock, no
    // try/finally, no node bookkeeping. It calls a model and returns a verdict.
    const subject = defineSubject({
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

    const report = await run({
      label: "pre-merge",
      cases: suite,
      subject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });

    const stored = await store.read(report.runId);
    expect(stored).toBeDefined();
    const nodes = stored?.nodes ?? [];

    const kinds = new Set(nodes.map((n) => n.kind));
    expect([...kinds].sort()).toEqual(
      ["aggregate", "case", "decision", "model.call", "run", "scoring"].sort(),
    );

    // Three cases, each with a decision, a model call and one scoring node —
    // and the subject wrote none of that.
    expect(nodes.filter((n) => n.kind === "case")).toHaveLength(3);
    expect(nodes.filter((n) => n.kind === "decision")).toHaveLength(3);
    expect(nodes.filter((n) => n.kind === "model.call")).toHaveLength(3);
    expect(nodes.filter((n) => n.kind === "scoring")).toHaveLength(3);
  });

  it("records parentage rather than inferring it, so the trace is a graph", async () => {
    const { store, recorder } = harness();
    const subject = defineSubject({
      version: testSubjectVersion,
      purity: "calls-models",
      decide: async (ctx) => {
        // A semantic node the subject *chose* to open. It writes no try/finally.
        const screened = await ctx.node.child(
          { name: "guardrail.screening", v: 1, payload: { policy: "uk-fca" } },
          async (child) =>
            (
              await child.client.complete({
                model: TEST_MODEL,
                promptVersion: PROMPT_V1,
                prompt: { step: "screen" },
              })
            ).text,
        );
        return determine(screened, 9_000);
      },
    });

    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });

    const nodes = (await store.read(report.runId))?.nodes ?? [];
    const byId = new Map<string, EvalNode>(nodes.map((n) => [n.id, n]));
    const parentKindOf = (n: EvalNode): string | undefined =>
      n.parent === undefined ? undefined : byId.get(n.parent)?.kind;

    const spans = nodes.filter((n) => n.kind === "span");
    expect(spans).toHaveLength(3);
    for (const span of spans) expect(parentKindOf(span)).toBe("decision");

    // The model call made inside the span is parented to the span, not to the
    // decision: the graph nests because `child` nests.
    for (const call of nodes.filter((n) => n.kind === "model.call")) {
      expect(parentKindOf(call)).toBe("span");
    }

    // Exactly one root, and it is the run.
    const roots = nodes.filter((n) => n.parent === undefined);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.kind).toBe("run");
  });

  it("closes a node the subject left throwing, and records the failure", async () => {
    const { store, recorder } = harness();
    const subject = defineSubject({
      version: testSubjectVersion,
      purity: "calls-models",
      decide: async (ctx) =>
        ctx.node.child({ name: "explodes", v: 1, payload: {} }, async () => {
          throw new Error("supplier lookup failed");
        }),
    });

    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });

    const nodes = (await store.read(report.runId))?.nodes ?? [];
    const spans = nodes.filter((n) => n.kind === "span");
    expect(spans).toHaveLength(3);
    // The library wrote the failure path, not the caller.
    for (const span of spans) {
      expect(span.outcome).toBe("error");
      expect(span.closedAt).not.toBeNull();
      expect(span.payload["error.message"]).toBe("supplier lookup failed");
    }
    // Fail-closed per case, fail-open per run: the run completed and said so.
    expect(report.casesRun).toBe(3);
    expect(report.unscoredBasisPoints).toBe(10_000);
    expect(report.correctBasisPoints).toBe(0);
  });

  it("settles every node it opens, so nothing is left dangling", async () => {
    const { store, recorder } = harness();
    const subject = defineSubject({
      version: testSubjectVersion,
      purity: "calls-models",
      decide: async (ctx) => {
        await ctx.client.complete({
          model: TEST_MODEL,
          promptVersion: PROMPT_V1,
          prompt: {},
        });
        return determine("duplicate", 9_000);
      },
    });
    const report = await run({
      label: "pre-merge",
      cases: threeInvoices(),
      subject,
      scorers: [exactVerdict],
      models: echoBackend(),
      recorder,
      seed: testSeed,
      limits: smallLimits,
      priceTable,
    });
    const nodes = (await store.read(report.runId))?.nodes ?? [];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.closedAt).not.toBeNull();
      expect(node.canonical).not.toBeNull();
    }
    // Sequence is assigned by the store and is a total order over writes.
    expect(nodes.map((n) => n.sequence)).toEqual(nodes.map((_, i) => i));
  });
});
