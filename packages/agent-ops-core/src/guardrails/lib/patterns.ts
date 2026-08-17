import { deterministicDetector, type Pattern } from "./detectors.js";
import { LocaleUnsupported } from "./errors.js";
import type { Detector, Locale, NonEmpty, Severity } from "./types.js";

/**
 * Shipped personal-data pattern packs, one per market.
 *
 * This is the deletion test for the whole module. Nineteen applications each
 * writing their own personal-data patterns is nineteen chances at a notifiable
 * incident, and the incident does not present as a bug — a pattern that is
 * subtly wrong finds nothing, and finding nothing is indistinguishable from a
 * clean payload. So the patterns live here, declared against the jurisdiction
 * they are valid for, and a detector wired into a market it does not declare
 * fails at construction.
 *
 * Two markets ship, which is the point rather than the limit: a library serving
 * nineteen applications across several markets that hardcodes one country's
 * formats is a compliance incident waiting for a date. An application in a third
 * market supplies its own pack through `deterministicDetector` and declares its
 * own locale — the seam is the pack, not a fork of this file.
 *
 * ## What these patterns are and are not
 *
 * They are **shape** matchers, not validators. `AB 12 34 56 C` has the shape of
 * a United Kingdom national insurance number; this module does not check the
 * prefix against the issued list, and does not run a checksum on a card number
 * or an international bank account number. That is deliberate and it errs the
 * safe way: a shape matcher over-matches, and over-matching costs a redacted
 * substring, while under-matching costs an incident. Every pattern carries a
 * confidence in basis points so an application can see which are strong.
 *
 * **Every pattern with a letter in it is case-insensitive**, for the same
 * reason. `ab 12 34 56 c`, `sw1a 1aa` and `gb29 nwbk...` are what free-text
 * fields typed by humans actually contain, and the packs used to match none of
 * them — under-matching, in a file whose stated policy is to err the other way.
 * Case-insensitivity widens the shapes and therefore redacts more substrings
 * that were never identifiers; that is the trade this file already declared.
 *
 * They are also **not exhaustive**, and no pattern pack can be. A free-text
 * narrative can carry a name, an address or a diagnosis in a shape no regular
 * expression will find. Deterministic detection is the cheap floor; a
 * model-based detector on the same field is the tier's answer to the rest, and
 * neither is a substitute for a deny-by-default redactor on the trace itself.
 */

/** Valid in every market. Formats defined by a standard, not by a jurisdiction. */
const UNIVERSAL: readonly Pattern[] = [
  {
    rule: "email-address",
    match: /\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/gu,
    confidenceBasisPoints: 9_800,
  },
  {
    rule: "iban",
    match: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b/gi,
    confidenceBasisPoints: 9_000,
  },
  {
    rule: "payment-card-number",
    match: /\b(?:\d{4}[ -]?){3}\d{1,4}\b/g,
    confidenceBasisPoints: 8_500,
  },
];

const PACKS: Readonly<Record<string, readonly Pattern[]>> = Object.freeze({
  "en-GB": [
    {
      rule: "uk.national-insurance-number",
      match: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi,
      confidenceBasisPoints: 9_500,
    },
    {
      rule: "uk.postcode",
      match: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi,
      confidenceBasisPoints: 9_000,
    },
    { rule: "uk.sort-code", match: /\b\d{2}-\d{2}-\d{2}\b/g, confidenceBasisPoints: 8_000 },
    {
      rule: "uk.telephone",
      match: /\b(?:\+44\s?|0)(?:7\d{3}|\d{2,4})\s?\d{3}\s?\d{3,4}\b/g,
      confidenceBasisPoints: 7_500,
    },
    { rule: "uk.nhs-number", match: /\b\d{3}\s?\d{3}\s?\d{4}\b/g, confidenceBasisPoints: 7_000 },
  ],
  "en-US": [
    {
      rule: "us.social-security-number",
      match: /\b(?!000|666|9\d{2})\d{3}-\d{2}-\d{4}\b/g,
      confidenceBasisPoints: 9_500,
    },
    { rule: "us.zip-code", match: /\b\d{5}(?:-\d{4})?\b/g, confidenceBasisPoints: 6_000 },
    {
      rule: "us.telephone",
      match: /\b(?:\+1[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}\b/g,
      confidenceBasisPoints: 8_000,
    },
    { rule: "us.routing-number", match: /\b\d{9}\b/g, confidenceBasisPoints: 5_500 },
  ],
});

/** The markets this library ships patterns for. Not a limit — see the note above. */
export const SHIPPED_LOCALES: readonly string[] = Object.freeze(Object.keys(PACKS));

/**
 * A personal-data detector for one market.
 *
 * Throws `LocaleUnsupported` for a market with no shipped pack, at construction
 * — never at screening time, and never by quietly falling back to another
 * market's formats. Falling back is the failure this whole design exists to
 * make impossible: it produces a clean screening over the wrong patterns, and
 * nobody finds out until a regulator does.
 */
export const personalDataDetector = (options: {
  readonly locale: Locale;
  readonly severity?: Severity;
  readonly id?: string;
  readonly fields?: readonly string[];
}): Detector => {
  const pack = PACKS[options.locale];
  if (pack === undefined) {
    throw new LocaleUnsupported("guardrails.personal-data", options.locale, SHIPPED_LOCALES);
  }
  const patterns = [...pack, ...UNIVERSAL] as unknown as NonEmpty<Pattern>;
  return deterministicDetector({
    id: options.id ?? `pii.${options.locale}`,
    locales: [options.locale] as unknown as NonEmpty<string>,
    searches: `personal-data formats for ${options.locale} (${patterns.length} patterns) and the international formats`,
    category: "personal-data",
    // Redact by default: the site is masked before anything is recorded or
    // returned. There is no un-writing, so the default is the safe one.
    severity: options.severity ?? "redact",
    patterns,
    ...(options.fields === undefined ? {} : { fields: options.fields }),
  });
};
