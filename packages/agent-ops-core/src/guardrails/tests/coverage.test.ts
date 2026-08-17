import { describe, expect, it } from "vitest";
import {
  CASE_A,
  EN_GB,
  harness,
  quietDetector,
  sameAtEveryTier,
  scriptedClassifier,
  scriptedDetector,
  setOf,
} from "./fixtures.js";
import {
  CoverageIncoherent,
  DetectorReportInvalid,
  NODE,
  modelDetector,
  personalDataDetector,
  promptInjectionDetector,
  type NonEmpty,
} from "../index.js";

/**
 * Slice 18 — "we masked three items" and "we wrote it all down" stop being the
 * same screening.
 *
 * Redaction masks **detected sites**. Text no detector flagged is recorded
 * verbatim, bounded only by `maxRecordedFieldChars` — which is inherent to
 * detection-based redaction and is not closed here. What is closed is that the
 * two cases used to be indistinguishable: same `recommend: "allow"`, same shape
 * of `Screening`, same row in the trace. A caller could not tell a payload that
 * had been searched thoroughly and found clean from one nobody had looked at.
 *
 * Note what is deliberately absent: any number claiming to be the probability
 * that the payload is clean. That depends on text nobody recognised, nothing
 * here can estimate it, and a plausible figure in that slot would be believed
 * and put on a dashboard.
 */

describe("guardrails — coverage separates 'looked and found nothing' from 'nobody looked'", () => {
  it("counts the characters that went into the trace unmasked", async () => {
    const narrative = "the claimant telephoned about the delay and was very patient";
    const h = harness({
      detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative },
    });

    expect(screening.recommended.recommend).toBe("allow");
    expect(screening.coverage.maskedSites).toBe(0);
    // The headline. Sixty characters of free text are now in a seven-year
    // archive, and the screening says so rather than implying a clean bill.
    expect(screening.coverage.verbatimCodeUnitsRecorded).toBe(narrative.length);
    expect(screening.coverage.totalCodeUnits).toBe(narrative.length);
  });

  it("and reports the masked case differently, which is the whole distinction", async () => {
    const h = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(setOf("pii", [personalDataDetector({ locale: EN_GB })])),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ref AB 12 34 56 C and 20-00-00" },
    });

    expect(screening.coverage.maskedSites).toBe(2);
    expect(screening.coverage.maskedCodeUnits).toBeGreaterThan(0);
    // Some text still reaches the trace — "ref" and "and" — and the number does
    // not pretend otherwise.
    expect(screening.coverage.verbatimCodeUnitsRecorded).toBeGreaterThan(0);
    expect(screening.coverage.verbatimCodeUnitsRecorded).toBeLessThan(
      screening.coverage.totalCodeUnits,
    );
  });

  it("names the fields nobody examined, which used to be invisible wiring", async () => {
    // A detector configured for one field of two produced a screening that read
    // as though both had been searched. The second field went into the trace
    // unexamined and unremarked.
    const h = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(
        setOf("pii", [personalDataDetector({ locale: EN_GB, fields: ["subject"] })]),
      ),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { subject: "claim", narrative: "a long free-text account of what happened" },
    });

    expect(screening.coverage.unexaminedFields).toEqual(["narrative"]);
    expect(screening.coverage.examinedBasisPoints).toBeLessThan(2_000);
    const settled = (await h.nodes()).find((n) => n.payload.kind === NODE.settled);
    expect(settled?.payload["coverageUnexaminedFields"]).toBe("narrative");
    expect(settled?.payload["coverageDepth"]).toBe("deterministic");
  });

  it("gives an unavailable detector no credit, because an outage covered nothing", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("down", [
          scriptedDetector("down", () => ({
            outcome: "unavailable",
            reason: "declared",
            detail: "classifier returned 503",
          })),
        ]),
      ),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });

    expect(screening.coverage.examinedBasisPoints).toBe(0);
    expect(screening.coverage.depth).toBe("none");
    expect(screening.coverage.unavailableDetectors).toBe(1);
    expect(screening.coverage.unexaminedFields).toEqual(["narrative"]);
    // And the screening fails closed regardless, which is the older guarantee.
    expect(screening.recommended.recommend).toBe("abstain");
  });

  it("records which classes of detector ran, since a model detector is what shrinks the residue", async () => {
    const h = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(
        setOf("both", [
          personalDataDetector({ locale: EN_GB }),
          modelDetector({
            id: "model.pii",
            locales: ["en-GB"] as unknown as NonEmpty<string>,
            searches: "personal data a pattern would miss",
            category: "personal-data",
            severity: "escalate",
            classifier: scriptedClassifier(() => ({ pii: 10 })),
            labels: ["pii"] as unknown as NonEmpty<string>,
            thresholdBasisPoints: 9_000,
          }),
        ]),
      ),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "nothing of interest here" },
    });

    expect(screening.coverage.depth).toBe("deterministic-and-model");
    expect(screening.coverage.deterministicDetectors).toBe(1);
    expect(screening.coverage.modelDetectors).toBe(1);
  });
});

describe("guardrails — a detector states its scope, and the screening carries it", () => {
  it("reports one pack's gaps, and stops reporting them once another pack fills them", async () => {
    const alone = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(setOf("pii", [personalDataDetector({ locale: EN_GB })])),
    });
    const first = await alone.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });
    expect(first.coverage.declared.gaps.map((n) => n.category)).toContain("personal-data.name");
    // A caveat is a caveat even where the category is covered: the pack matches
    // postcodes and says plainly that a postcode is not an address.
    expect(first.coverage.declared.partial.map((n) => n.category)).toContain(
      "personal-data.postal-address",
    );

    const together = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(
        setOf("pii+names", [
          personalDataDetector({ locale: EN_GB }),
          scriptedDetector(
            "names",
            () => ({ outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 }),
            { declares: { covers: ["personal-data.name"] as unknown as NonEmpty<"personal-data.name"> } },
          ),
        ]),
      ),
    });
    const second = await together.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });
    // One pack's hole filled by another pack's rule is not a hole. This is why
    // nineteen applications wire several packs together.
    expect(second.coverage.declared.gaps.map((n) => n.category)).not.toContain("personal-data.name");
    expect(second.coverage.declared.covers).toContain("personal-data.name");
  });

  it("counts a detector that declared nothing rather than assuming either way", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });
    expect(screening.coverage.declared.undeclared).toBe(1);
    expect(screening.coverage.declared.covers).toEqual([]);
  });

  it("combines a personal-data pack and an injection pack into one scope statement", async () => {
    const h = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(
        setOf("full", [
          personalDataDetector({ locale: EN_GB }),
          promptInjectionDetector({ locale: EN_GB }),
        ]),
      ),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "ordinary" },
    });
    expect(screening.coverage.declared.covers).toContain("personal-data.national-identifier");
    expect(screening.coverage.declared.covers).toContain("prompt-injection.instruction-override");
    expect(screening.coverage.declared.gaps.map((n) => n.category)).toContain(
      "prompt-injection.paraphrase",
    );
  });

  it("refuses a declaration that claims a category is both covered and not, at construction", async () => {
    expect(() =>
      modelDetector({
        id: "confused",
        locales: ["en-GB"] as unknown as NonEmpty<string>,
        searches: "two incompatible things",
        category: "personal-data",
        severity: "escalate",
        classifier: scriptedClassifier(() => ({ pii: 10 })),
        labels: ["pii"] as unknown as NonEmpty<string>,
        thresholdBasisPoints: 9_000,
        declares: {
          covers: ["personal-data.name"] as unknown as NonEmpty<"personal-data.name">,
          doesNotCover: [{ category: "personal-data.name", why: "actually we cannot" }],
        },
      }),
    ).toThrow(CoverageIncoherent);
  });

  it("refuses a detector claiming to have examined a field it was never shown", async () => {
    // A detector may decline to look at a field it was given. It may not claim
    // to have searched one that does not exist — that is a claim about a search
    // nobody ran, which is the failure `searchedAndFoundNone` exists to prevent.
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("liar", [
          scriptedDetector("liar", () => ({
            outcome: "searched-and-found-none",
            costTenthCents: 0,
            modelCalls: 0,
            examinedFields: ["a-field-nobody-passed"],
          })),
        ]),
      ),
    });
    await expect(
      h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "high",
        payload: { narrative: "ordinary" },
      }),
    ).rejects.toThrow(DetectorReportInvalid);
  });
});
