import { describe, expect, it } from "vitest";
import { EN_GB, EN_US, harness, ninDetector, sameAtEveryTier, setOf } from "./fixtures.js";
import { LocaleNotJurisdictional, LocaleUnsupported, localeOf } from "../index.js";

/**
 * Slice 4 — locale is required configuration, and it names a jurisdiction.
 *
 * Personal-data patterns are jurisdictional. A library serving nineteen
 * applications across several markets that hardcodes one country's formats is a
 * compliance incident waiting for a date, and the failure mode is the dangerous
 * one: a detector aimed at the wrong market does not error, it finds nothing,
 * and finding nothing is indistinguishable from a clean payload.
 *
 * So the check is at construction. A compliance incident becomes a boot
 * failure, which is the loudest cheap place to put it.
 */

describe("guardrails — locale", () => {
  it("refuses a language that names no jurisdiction", () => {
    // `en` does not tell you whether a nine-digit run is a United States social
    // security number, a United Kingdom telephone number, or noise.
    expect(() => localeOf("en")).toThrow(LocaleNotJurisdictional);
    expect(() => localeOf("")).toThrow(LocaleNotJurisdictional);
    expect(() => localeOf("en-gb")).toThrow(LocaleNotJurisdictional);
  });

  it("accepts a market, with or without a script subtag", () => {
    expect(localeOf("en-GB")).toBe("en-GB");
    expect(localeOf("pt-BR")).toBe("pt-BR");
    expect(localeOf("sr-Latn-RS")).toBe("sr-Latn-RS");
  });

  it("fails at construction when a detector is wired into the wrong market", () => {
    expect(() =>
      harness({
        locale: EN_US,
        detectorSets: sameAtEveryTier(setOf("uk-only", [ninDetector()])),
      }),
    ).toThrow(LocaleUnsupported);
  });

  it("names the detector and both locales, so the wiring error is readable", () => {
    let thrown: unknown;
    try {
      harness({
        locale: EN_US,
        detectorSets: sameAtEveryTier(setOf("uk-only", [ninDetector()])),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "LocaleUnsupported",
      detector: "pii.uk.nin",
      configured: "en-US",
      supported: ["en-GB"],
      // A wiring error that screens the wrong market is not a metric movement.
      incident: true,
    });
  });

  it("stamps the configured locale onto every screening and its opened node", async () => {
    const h = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(setOf("uk", [ninDetector()])),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: "case-locale" as never,
      tier: "low",
      payload: { narrative: "nothing" },
    });
    expect(screening.locale).toBe("en-GB");
    const opened = (await h.nodes("case-locale" as never))[0];
    expect(opened?.payload.locale).toBe("en-GB");
  });
});
