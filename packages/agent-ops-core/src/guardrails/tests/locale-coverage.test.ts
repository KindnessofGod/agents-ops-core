import { describe, expect, it } from "vitest";
import { EN_GB, EN_US } from "./fixtures.js";
import { LocaleUnsupported, SHIPPED_LOCALES, localeCoverage, localeOf } from "../index.js";

/**
 * Slice 19 — every shipped market states what it does not find.
 *
 * A locale that silently covers less than a caller assumes is the compliance
 * incident this module exists to prevent, and it is invisible by construction:
 * an unmatched street address produces a clean screening, `recommend: "allow"`
 * and a green dashboard. Nobody finds out until a regulator does.
 *
 * So the declaration is part of the pack rather than part of the documentation,
 * the covered list is *derived from the patterns* so it cannot drift, and the
 * two lists that matter — partial and uncovered — are written in words a
 * data-protection officer can act on.
 */

describe("guardrails — each shipped market declares its own scope", () => {
  it("states covered, partial and uncovered categories for every market it ships", () => {
    expect(SHIPPED_LOCALES.length).toBeGreaterThan(1);
    for (const locale of SHIPPED_LOCALES) {
      const coverage = localeCoverage(locale);
      expect(coverage.covers.length).toBeGreaterThan(0);
      // The uncovered list is the one that prevents the incident. A pack that
      // declared no gaps would be claiming a completeness no pattern pack has.
      expect(coverage.doesNotCover.length).toBeGreaterThan(0);
      for (const note of [...coverage.partial, ...coverage.doesNotCover]) {
        // A category named without a reason is a category a reader cannot act
        // on, so the reason is required rather than conventional.
        expect(note.why.length).toBeGreaterThan(20);
      }
    }
  });

  it("derives the covered list from the rules, so a declaration cannot drift from its pack", () => {
    for (const locale of SHIPPED_LOCALES) {
      const coverage = localeCoverage(locale);
      const fromRules = [...new Set(coverage.rules.map((r) => r.covers))].sort();
      expect([...coverage.covers]).toEqual(fromRules);
      // And every covered category names at least one rule a reader can check.
      for (const category of coverage.covers) {
        expect(coverage.rules.some((r) => r.covers === category)).toBe(true);
      }
    }
  });

  it("says plainly that a name, a date of birth and free text are not found anywhere", () => {
    // These are gaps in the *technique*, not in a particular market: a person's
    // name is ordinary text, and no regular expression in any jurisdiction will
    // ever find it. Saying it once per market beats implying it nowhere.
    for (const locale of SHIPPED_LOCALES) {
      const uncovered = localeCoverage(locale).doesNotCover.map((n) => n.category);
      expect(uncovered).toContain("personal-data.name");
      expect(uncovered).toContain("personal-data.date-of-birth");
      expect(uncovered).toContain("personal-data.free-text-identifier");
    }
  });

  it("does not let a postcode be read as an address", () => {
    // The single most likely overclaim in the file: a pack matches postcodes,
    // and a reader takes that as covering addresses. The caveat is in the pack.
    for (const locale of [EN_GB, EN_US]) {
      const coverage = localeCoverage(locale);
      expect(coverage.covers).toContain("personal-data.postcode");
      expect(coverage.covers).not.toContain("personal-data.postal-address");
      const address = coverage.partial.find((n) => n.category === "personal-data.postal-address");
      expect(address?.why).toMatch(/street/);
    }
  });

  it("shows the two markets genuinely differing, which is why the locale is required", () => {
    const gb = localeCoverage(EN_GB);
    const us = localeCoverage(EN_US);
    // The United Kingdom has a national health identifier and the United States
    // has none. A library that hardcoded one market would report the same
    // coverage for both, and be wrong for one of them without saying so.
    expect(gb.covers).toContain("personal-data.health-identifier");
    expect(us.covers).not.toContain("personal-data.health-identifier");
    expect(us.doesNotCover.map((n) => n.category)).toContain("personal-data.health-identifier");
    expect(gb.rules.map((r) => r.rule)).toContain("uk.nhs-number");
    expect(us.rules.map((r) => r.rule)).toContain("us.social-security-number");
  });

  it("qualifies its own strong claims rather than leaving them absolute", () => {
    // The pack matches a sort code and an international bank account number, and
    // says in the same breath that a bare account number has no shape. A
    // qualification of a category the pack also covers is exactly the case a
    // simpler "three disjoint lists" rule would have forced us to lie about.
    const gb = localeCoverage(EN_GB);
    expect(gb.covers).toContain("personal-data.bank-account");
    const caveat = gb.partial.find((n) => n.category === "personal-data.bank-account");
    expect(caveat?.why).toMatch(/eight-digit/);
  });

  it("refuses a market it ships no patterns for rather than answering about it", () => {
    // Returning empty coverage would read as "nothing to find", which is the
    // failure mode of every silent default in this module.
    expect(() => localeCoverage(localeOf("de-DE"))).toThrow(LocaleUnsupported);
  });
});
