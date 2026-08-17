import { describe, expect, it } from "vitest";
import {
  CASE_A,
  EN_GB,
  harness,
  quietDetector,
  sameAtEveryTier,
  scriptedClassifier,
  setOf,
} from "./fixtures.js";
import {
  NODE,
  groundednessDetector,
  judgeGroundedness,
  overlapGroundedness,
  sentenceClaims,
  type NonEmpty,
  type Screening,
  type Source,
  type SourceId,
} from "../index.js";

/**
 * Slices 6 and 7 — `checkOutput`, and what happens when it cannot check.
 *
 * Two things are pinned here.
 *
 * **Ordering is structural.** `checkOutput` requires the `Screening` that
 * `screenInput` returned, and a `Screening` is unconstructible outside the
 * module. There is therefore no way to check an output that was never preceded
 * by a screened input, and the input screening's settled node is the output
 * check's parent — recorded in the graph, not inferred from two timestamps.
 *
 * **Cannot check is never pass.** `Sources` has no empty-array branch: a caller
 * with no reference material says so in words, and the screening recommends
 * abstain. "We could not check, so we allowed it" is the exact failure this
 * module exists to prevent.
 */

const SOURCES: NonEmpty<Source> = [
  {
    id: "policy-8812" as SourceId,
    text: "Policy 8812 covers escape of water at the insured address up to £50,000 with a £250 excess.",
  },
  {
    id: "schedule-a" as SourceId,
    text: "The schedule records the insured address as 14 Bramble Way and the excess as £250.",
  },
];

const grounded = (minimum = 3_000) =>
  groundednessDetector({
    id: "groundedness.overlap",
    locales: ["en-GB"] as unknown as NonEmpty<string>,
    groundedness: overlapGroundedness(),
    minimumSupportBasisPoints: minimum,
    severity: "block",
  });

const setup = (minimum?: number) =>
  harness({
    locale: EN_GB,
    detectorSets: sameAtEveryTier(
      setOf(
        "with-groundedness",
        [quietDetector("quiet", "prompt-injection phrasing")],
        [quietDetector("quiet", "prompt-injection phrasing"), grounded(minimum)],
      ),
    ),
  });

const screenFirst = async (h: ReturnType<typeof setup>): Promise<Screening> =>
  h.guardrails.screenInput({
    correlationId: CASE_A,
    tier: "medium",
    payload: { narrative: "escape of water at 14 Bramble Way" },
  });

describe("guardrails — checkOutput", () => {
  it("parents the output check to the input screening's settled node", async () => {
    const h = setup();
    const input = await screenFirst(h);
    const output = await h.guardrails.checkOutput({
      after: input,
      tier: "high",
      output: { answer: "The excess is £250 and the address is 14 Bramble Way." },
      sources: { available: true, items: SOURCES },
    });

    const opened = (await h.nodes()).find((n) => n.id === output.nodes.opened);
    expect(opened?.parent).toBe(input.nodes.settled);
    expect(opened?.payload.phase).toBe("output");
    // Tier attaches to a decision-and-its-effect, so the output check carries
    // its own tier rather than inheriting the input's. A case has a tier
    // profile: reading an invoice is low risk, paying it is high risk.
    expect(opened?.payload.tier).toBe("high");
    expect(output.recommended).toEqual({ recommend: "allow" });
  });

  it("blocks a claim the sources do not support", async () => {
    const h = setup();
    const input = await screenFirst(h);
    const output = await h.guardrails.checkOutput({
      after: input,
      tier: "high",
      output: { answer: "The excess is £250. We will also reimburse your hotel and taxi fares." },
      sources: { available: true, items: SOURCES },
    });

    expect(output.recommended).toMatchObject({
      recommend: "abstain",
      grounds: [{ ground: "finding", category: "ungrounded-claim", severity: "block" }],
    });
    const finding = (await h.nodes()).find(
      (n) => n.payload.kind === NODE.finding && n.payload.category === "ungrounded-claim",
    );
    expect(finding?.payload.field).toBe("answer");
  });

  it("recommends abstain, never pass, when the sources could not be fetched", async () => {
    const h = setup();
    const input = await screenFirst(h);
    const output = await h.guardrails.checkOutput({
      after: input,
      tier: "low",
      output: { answer: "The excess is £250." },
      sources: { available: false, why: "policy store returned 503" },
    });

    expect(output.recommended.recommend).toBe("abstain");
    expect(output.recommended).toMatchObject({
      grounds: expect.arrayContaining([
        { ground: "sources-missing", why: "policy store returned 503" },
      ]),
    });
    // And the groundedness detector itself refuses rather than passing.
    expect(output.detectors.some((d) => d.outcome === "unavailable")).toBe(true);
  });
});

describe("guardrails — groundedness as a reusable shape", () => {
  it("scores the weakest claim, not the mean", () => {
    // One unsupported sentence in an otherwise grounded paragraph is the
    // sentence that matters. An average is precisely the operation that hides it.
    const claims = sentenceClaims({
      answer: "The excess is £250. We will also reimburse hotel and taxi fares.",
    });
    const score = overlapGroundedness().score({
      claims: claims as unknown as NonEmpty<(typeof claims)[number]>,
      sources: SOURCES,
    });
    expect(score.supportedBasisPoints).toBe(0);
    expect(score.claims).toHaveLength(2);
    expect(score.modelCalls).toBe(0);
  });

  it("spells an unsupported claim as a search performed over named sources", () => {
    const claims = sentenceClaims({ answer: "We will reimburse hotel and taxi fares." });
    const score = overlapGroundedness().score({
      claims: claims as unknown as NonEmpty<(typeof claims)[number]>,
      sources: SOURCES,
    });
    expect(score.claims[0]).toMatchObject({
      supportedBasisPoints: 0,
      searchedAndFoundNone: { searched: "2 named sources" },
    });
  });

  it("reports integers only, at every scale", () => {
    const claims = sentenceClaims({ answer: "The excess is £250 at 14 Bramble Way." });
    const score = overlapGroundedness().score({
      claims: claims as unknown as NonEmpty<(typeof claims)[number]>,
      sources: SOURCES,
    });
    expect(Number.isSafeInteger(score.supportedBasisPoints)).toBe(true);
    expect(score.supportedBasisPoints).toBeGreaterThan(0);
    expect(score.supportedBasisPoints).toBeLessThanOrEqual(10_000);
  });

  it("is the same shape whether the judge is a table or a model", async () => {
    // The second adapter, which is what makes `Groundedness` a real seam. Both
    // satisfy one interface, so `evals` consumes either as a scorer without
    // knowing which it holds.
    const judge = judgeGroundedness({
      classifier: scriptedClassifier((text) => ({
        supported: text.includes("excess") ? 9_000 : 1_000,
      })),
    });
    const claims = sentenceClaims({ answer: "The excess is £250." });
    const score = await judge.score({
      claims: claims as unknown as NonEmpty<(typeof claims)[number]>,
      sources: SOURCES,
    });
    expect(judge.costClass).toBe("model");
    expect(score.modelCalls).toBe(1);
    expect(score.supportedBasisPoints).toBe(9_000);
  });
});
