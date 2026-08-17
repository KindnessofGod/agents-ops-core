import { describe, expect, it } from "vitest";
import { CASE_A, EN_GB, EN_US, harness, sameAtEveryTier, setOf } from "./fixtures.js";
import {
  PatternUnsafe,
  deterministicDetector,
  localeCoverage,
  personalDataDetector,
  promptInjectionDetector,
  safePattern,
  type NonEmpty,
  type Pattern,
} from "../index.js";

/**
 * Slice 15 — a runaway regular expression is unrepresentable.
 *
 * The module's frankest residual was that a synchronous detector's work could
 * not be bounded, and the realistic way that becomes an outage is a
 * catastrophically backtracking pattern in a caller-supplied pack: an unbounded
 * event-loop stall on the hot path of every decision, twice, with no in-process
 * timer able to preempt it.
 *
 * Requiring `screen` to be asynchronous does not fix that, and the tests below
 * do not pretend it does — an `async` body that never awaits blocks identically.
 * What fixes the exponential case is that the pattern cannot be built.
 */

const mint = (source: RegExp): Pattern =>
  safePattern({
    rule: "under-test",
    match: source,
    confidenceBasisPoints: 9_000,
    covers: "personal-data.name",
  });

describe("guardrails — a pattern that can blow up cannot be constructed", () => {
  it("refuses the catastrophic shapes, at construction, by name", () => {
    const catastrophic: readonly RegExp[] = [
      /(a+)+$/g, //          the textbook nested quantifier
      /(a|aa)*$/g, //        ambiguous alternation under a star
      /(\s*\w+)*$/g, //      the shape a hand-written address pattern drifts into
      /(x+x+)+y/g, //        two quantifiers under one
      /([a-z]+)+@/g, //      and the version an email pattern reaches for
    ];
    for (const source of catastrophic) {
      expect(() => mint(source)).toThrow(PatternUnsafe);
    }
  });

  it("refuses a backreference, which cannot be matched in linear time at all", () => {
    expect(() => mint(/(\w+)\s\1/g)).toThrow(PatternUnsafe);
    expect(() => mint(/(?<word>\w+)\s\k<word>/g)).toThrow(PatternUnsafe);
  });

  it("refuses a repetition large enough to be a denial of service on its own", () => {
    // Not exponential. Merely a million character comparisons per start
    // position, which is the same outage with a longer explanation.
    expect(() => mint(/(?:a{1000}){1000}/g)).toThrow(PatternUnsafe);
    expect(() => mint(/a{50}b{50}/g)).not.toThrow();
  });

  it("accepts the bounded ambiguity real market formats are made of", () => {
    // The refusal is on *unbounded* repetition of an ambiguous group. A bounded
    // one — an international bank account number is seven groups of four — has a
    // worst case anyone can compute, and refusing it would refuse the shipped
    // packs, which would tell us the rule was wrong rather than the pattern.
    expect(() => mint(/\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b/gi)).not.toThrow();
    expect(() => mint(/\b(?:\+1[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}\b/g)).not.toThrow();
    expect(() => mint(/\b(?!000|666|9\d{2})\d{3}-\d{2}-\d{4}\b/g)).not.toThrow();
  });

  it("accepts every pattern in every shipped pack, which is the test that keeps the rule honest", () => {
    // A rule that refused the library's own packs would be a rule nobody could
    // ship behind. Both markets and the injection pack construct unchanged.
    for (const locale of [EN_GB, EN_US]) {
      expect(() => personalDataDetector({ locale })).not.toThrow();
      expect(() => promptInjectionDetector({ locale })).not.toThrow();
      expect(localeCoverage(locale).rules.length).toBeGreaterThan(5);
    }
  });

  it("refuses a cast as well as a literal, because a brand only stops the literal", () => {
    // `Pattern` is branded, so an object literal does not typecheck — see
    // `tests/fixtures/unforgeable.ts`. A cast does, and would put an unanalysed
    // regular expression on the hot path, so the adapter re-checks at
    // construction rather than trusting the type it was handed.
    const smuggled = {
      rule: "smuggled",
      match: /(a+)+$/g,
      confidenceBasisPoints: 9_000,
      covers: "personal-data.name",
    } as unknown as Pattern;

    expect(() =>
      deterministicDetector({
        id: "smuggler",
        locales: ["en-GB"] as unknown as NonEmpty<string>,
        searches: "nothing good",
        category: "personal-data",
        severity: "redact",
        patterns: [smuggled] as unknown as NonEmpty<Pattern>,
      }),
    ).toThrow(PatternUnsafe);
  });

  it("refuses a confidence that is not basis points, since the mint is the one gate", () => {
    expect(() =>
      safePattern({
        rule: "over",
        match: /\bx\b/g,
        confidenceBasisPoints: 10_001,
        covers: "personal-data.name",
      }),
    ).toThrow(PatternUnsafe);
  });
});

describe("guardrails — an accepted pack still screens", () => {
  it("finds what it is meant to find, so the analyser has not quietly broken the packs", async () => {
    const h = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(setOf("pii", [personalDataDetector({ locale: EN_GB })])),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "her number is AB 12 34 56 C and she banks at 20-00-00" },
    });
    const rules = "found" in screening.findings ? screening.findings.found.map((f) => f.rule) : [];
    expect(rules).toContain("uk.national-insurance-number");
    expect(rules).toContain("uk.sort-code");
  });
});
