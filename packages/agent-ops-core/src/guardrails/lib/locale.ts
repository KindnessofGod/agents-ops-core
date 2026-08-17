import { LocaleNotJurisdictional } from "./errors.js";
import type { Locale } from "./types.js";

/**
 * The only way to obtain a `Locale`.
 *
 * There is no default and there is no fallback, because personal-data formats
 * are jurisdictional and a library serving nineteen applications across several
 * markets that quietly picks one country's patterns is a compliance incident
 * waiting for a date.
 *
 * The region subtag is required, and this is the one place that rule is
 * enforced. `en` does not tell you whether a nine-digit run is a United States
 * social security number, a United Kingdom telephone number, or noise — and the
 * failure mode of guessing is not an error, it is a clean screening. So a
 * language without a region does not become a `Locale` at all.
 *
 * Shape accepted: `ll-RR` or `lll-RR`, optionally with a script subtag —
 * `en-GB`, `de-DE`, `pt-BR`, `sr-Latn-RS`. This is a deliberately narrow
 * reading of BCP 47: enough to name a market, not a full parser, because a full
 * parser here would be a dependency nineteen applications inherit.
 */
const JURISDICTIONAL = /^[a-z]{2,3}(-[A-Z][a-z]{3})?-[A-Z]{2}$/;

export const localeOf = (tag: string): Locale => {
  if (!JURISDICTIONAL.test(tag)) throw new LocaleNotJurisdictional(tag);
  return tag as Locale;
};
