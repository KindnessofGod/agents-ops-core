import { describe, expect, it } from "vitest";
import { CASE_A, EN_GB, EN_US, harness, sameAtEveryTier, setOf } from "./fixtures.js";
import { LocaleUnsupported, MASK, SHIPPED_LOCALES, localeOf, personalDataDetector } from "../index.js";

/**
 * Slice 10 — the shipped pattern packs, and the compliance point made concrete.
 *
 * The same nine digits mean different things in different markets. A library
 * that hardcodes one country's formats screens every other market against
 * patterns that do not fit — and the failure is silent, because a pattern that
 * does not fit finds nothing, and finding nothing reads exactly like a clean
 * payload.
 */

const packFor = (locale: typeof EN_GB) =>
  harness({
    locale,
    detectorSets: sameAtEveryTier(setOf("pii", [personalDataDetector({ locale })])),
  });

describe("guardrails — personal-data packs are jurisdictional", () => {
  it("ships more than one market, because one is the incident", () => {
    expect(SHIPPED_LOCALES.length).toBeGreaterThan(1);
    expect(SHIPPED_LOCALES).toContain("en-GB");
    expect(SHIPPED_LOCALES).toContain("en-US");
  });

  it("masks a United States social security number under the United States pack", async () => {
    const h = packFor(EN_US);
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "member 123-45-6789 called about the claim" },
    });
    expect(screening.payload.fields["narrative"]).toBe(`member ${MASK} called about the claim`);
  });

  it("does not pretend the United Kingdom pack understands that number", async () => {
    // The honest half of the same fact. Under the wrong pack this text screens
    // clean — which is exactly why the locale is required configuration and why
    // wiring a detector into the wrong market fails at construction rather than
    // at screening time.
    const h = packFor(EN_GB);
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "member 123-45-6789 called about the claim" },
    });
    expect(screening.recommended).toEqual({ recommend: "allow" });
    expect("searchedAndFoundNone" in screening.findings).toBe(true);
  });

  it("catches the international formats in every market", async () => {
    const h = packFor(EN_GB);
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "write to aisha.okonkwo@example.com about it" },
    });
    expect(screening.payload.fields["narrative"]).toBe(`write to ${MASK} about it`);
    const bytes = (await h.nodes()).map((n) => n.canonical).join("");
    expect(bytes).not.toContain("aisha.okonkwo");
  });

  it("refuses a market it has no patterns for, rather than falling back", async () => {
    // Falling back to another market's formats is the failure this design
    // exists to make impossible: it produces a clean screening over the wrong
    // patterns, and nobody finds out until a regulator does.
    expect(() => personalDataDetector({ locale: localeOf("de-DE") })).toThrow(LocaleUnsupported);
  });

  it("names what it searched for, including how many patterns ran", async () => {
    const h = packFor(EN_GB);
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "nothing of interest" },
    });
    expect(screening.findings).toMatchObject({
      searchedAndFoundNone: { searched: expect.stringContaining("en-GB") },
    });
  });
});

describe("guardrails — the packs are case-insensitive where the format has letters", () => {
  it("finds a lowercase national insurance number, postcode and account number", async () => {
    // Free-text fields typed by humans are routinely lowercase, and the packs
    // used to match none of these — under-matching, in a file whose stated
    // policy is that under-matching costs an incident.
    const lower =
      "nin ab 12 34 56 c, postcode sw1a 1aa, iban gb29 nwbk 6016 1331 9268 19";
    const upper = lower.toUpperCase();

    const h = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(setOf("pii", [personalDataDetector({ locale: EN_GB })])),
    });

    const rules = async (text: string): Promise<readonly string[]> => {
      const screening = await h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "high",
        payload: { narrative: text },
      });
      return "found" in screening.findings
        ? [...new Set(screening.findings.found.map((f) => f.rule))].sort()
        : [];
    };

    const lowerRules = await rules(lower);
    const upperRules = await rules(upper);
    expect(lowerRules).toContain("uk.national-insurance-number");
    expect(lowerRules).toContain("uk.postcode");
    expect(lowerRules).toContain("iban");
    expect(lowerRules).toEqual(upperRules);
  });
});
