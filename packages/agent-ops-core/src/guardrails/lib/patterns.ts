import { deterministicDetector } from "./detectors.js";
import { LocaleUnsupported } from "./errors.js";
import { safePattern, type Pattern } from "./safe-pattern.js";
import type { CoverageCategory, CoverageNote } from "./coverage.js";
import type { Detector, Locale, NonEmpty, Severity } from "./types.js";

/**
 * Shipped personal-data pattern packs, one per market — and what each of them
 * does **not** find.
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
 * ## Every pack states its own gaps, and that is the load-bearing part
 *
 * A locale that silently covers less than a caller assumes is exactly the
 * incident this module exists to prevent, and it is invisible by construction:
 * an unmatched street address produces a clean screening, a `recommend: "allow"`
 * and a green dashboard. So each market declares three things —
 *
 *   - what it **covers**, which is *derived from the patterns themselves*: every
 *     `Pattern` carries a `covers` category and cannot be built without one, so
 *     the declaration cannot drift from the pack;
 *   - what it covers **partially**, with the caveat in words — a postcode is not
 *     an address, a sort code is not an account number;
 *   - what it does **not** cover, with the reason — names, dates of birth and
 *     free-text identifiers have no shape, and no regular expression will ever
 *     find them.
 *
 * All three reach the caller on `Screening.coverage.declared` and the trace on
 * the settled node, so "we screened for personal data" is a claim with a scope
 * attached rather than a reassurance. `localeCoverage` exposes the same table
 * before anything is wired, which is when it is cheapest to read.
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
  safePattern({
    rule: "email-address",
    match: /\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/gu,
    confidenceBasisPoints: 9_800,
    covers: "personal-data.email-address",
  }),
  safePattern({
    rule: "iban",
    match: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b/gi,
    confidenceBasisPoints: 9_000,
    covers: "personal-data.bank-account",
  }),
  safePattern({
    rule: "payment-card-number",
    match: /\b(?:\d{4}[ -]?){3}\d{1,4}\b/g,
    confidenceBasisPoints: 8_500,
    covers: "personal-data.payment-card",
  }),
];

/**
 * The gaps every market shares, because they are gaps in the *technique* rather
 * than in a particular pack.
 *
 * A regular expression matches shapes. A person's name, a date of birth, a
 * diagnosis and a criminal allegation have no shape — they are ordinary words in
 * ordinary sentences — so no pack in any market will ever find them, and saying
 * so once here is more honest than repeating a per-market fiction.
 */
const UNIVERSAL_GAPS: readonly CoverageNote[] = [
  {
    category: "personal-data.name",
    why: "a person's name is ordinary text; no pattern distinguishes it from any other word, so a narrative naming a claimant is recorded verbatim",
  },
  {
    category: "personal-data.date-of-birth",
    why: "a date of birth has the shape of every other date, so matching it would mask every date in the payload",
  },
  {
    category: "personal-data.biometric",
    why: "biometric data is not text and does not reach this module as text",
  },
  {
    category: "personal-data.criminal-record",
    why: "an allegation or conviction is described in prose and has no shape",
  },
  {
    category: "personal-data.credential",
    why: "a password or access token has no distinguishing shape; secret-scanning is a different discipline and a different tool",
  },
  {
    category: "personal-data.free-text-identifier",
    why: "an identifier described rather than written — 'the account ending in the year she was born' — is the residual this module names rather than closes",
  },
];

interface Market {
  readonly patterns: readonly Pattern[];
  readonly partial: readonly CoverageNote[];
  readonly doesNotCover: readonly CoverageNote[];
}

const MARKETS: Readonly<Record<string, Market>> = Object.freeze({
  "en-GB": {
    patterns: [
      safePattern({
        rule: "uk.national-insurance-number",
        match: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi,
        confidenceBasisPoints: 9_500,
        covers: "personal-data.national-identifier",
      }),
      safePattern({
        rule: "uk.postcode",
        match: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi,
        confidenceBasisPoints: 9_000,
        covers: "personal-data.postcode",
      }),
      safePattern({
        rule: "uk.sort-code",
        match: /\b\d{2}-\d{2}-\d{2}\b/g,
        confidenceBasisPoints: 8_000,
        covers: "personal-data.bank-account",
      }),
      safePattern({
        rule: "uk.telephone",
        match: /\b(?:\+44\s?|0)(?:7\d{3}|\d{2,4})\s?\d{3}\s?\d{3,4}\b/g,
        confidenceBasisPoints: 7_500,
        covers: "personal-data.telephone",
      }),
      safePattern({
        rule: "uk.nhs-number",
        match: /\b\d{3}\s?\d{3}\s?\d{4}\b/g,
        confidenceBasisPoints: 7_000,
        covers: "personal-data.health-identifier",
      }),
    ],
    partial: [
      {
        category: "personal-data.postal-address",
        why: "only the postcode is matched; the building, street and town are ordinary words and are recorded verbatim",
      },
      {
        category: "personal-data.bank-account",
        why: "a sort code and an international bank account number are matched; a bare eight-digit account number is not, because eight digits has no distinguishing shape",
      },
      {
        category: "personal-data.health-identifier",
        why: "the National Health Service number is matched; hospital, general-practice and insurer record numbers have no national format and are not",
      },
    ],
    doesNotCover: [
      {
        category: "personal-data.tax-identifier",
        why: "a Unique Taxpayer Reference is ten digits and cannot be told from any other ten-digit run without a checksum this module does not compute",
      },
      {
        category: "personal-data.vehicle-registration",
        why: "no rule shipped; the current and several historic formats overlap ordinary short words",
      },
      {
        category: "personal-data.network-address",
        why: "no rule shipped, and an internet protocol address is personal data under United Kingdom data-protection law — wire a pack of your own if your payloads carry one",
      },
      ...UNIVERSAL_GAPS,
    ],
  },
  "en-US": {
    patterns: [
      safePattern({
        rule: "us.social-security-number",
        match: /\b(?!000|666|9\d{2})\d{3}-\d{2}-\d{4}\b/g,
        confidenceBasisPoints: 9_500,
        covers: "personal-data.national-identifier",
      }),
      safePattern({
        rule: "us.zip-code",
        match: /\b\d{5}(?:-\d{4})?\b/g,
        confidenceBasisPoints: 6_000,
        covers: "personal-data.postcode",
      }),
      safePattern({
        rule: "us.telephone",
        match: /\b(?:\+1[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}\b/g,
        confidenceBasisPoints: 8_000,
        covers: "personal-data.telephone",
      }),
      safePattern({
        rule: "us.routing-number",
        match: /\b\d{9}\b/g,
        confidenceBasisPoints: 5_500,
        covers: "personal-data.bank-account",
      }),
    ],
    partial: [
      {
        category: "personal-data.postal-address",
        why: "only the ZIP code is matched; the street, city and state are ordinary words and are recorded verbatim",
      },
      {
        category: "personal-data.bank-account",
        why: "a nine-digit routing number is matched at low confidence and an international bank account number is matched; a domestic account number has no fixed length and is not",
      },
      {
        category: "personal-data.national-identifier",
        why: "a social security number is matched only in its hyphenated form; nine bare digits are indistinguishable from a routing number and are matched as that instead",
      },
    ],
    doesNotCover: [
      {
        category: "personal-data.health-identifier",
        why: "there is no national health identifier; member and medical-record numbers are issued per payer and per provider with no shared format",
      },
      {
        category: "personal-data.tax-identifier",
        why: "an Employer Identification Number is nine digits in the same space as a routing number and cannot be told apart by shape",
      },
      {
        category: "personal-data.vehicle-registration",
        why: "no rule shipped; plate formats vary by state and overlap ordinary short words",
      },
      {
        category: "personal-data.network-address",
        why: "no rule shipped; wire a pack of your own if your payloads carry one",
      },
      ...UNIVERSAL_GAPS,
    ],
  },
});

/** The markets this library ships patterns for. Not a limit — see the note above. */
export const SHIPPED_LOCALES: readonly string[] = Object.freeze(Object.keys(MARKETS));

/**
 * What one market's shipped pack covers, covers partially, and does not cover.
 *
 * Readable **before** anything is wired, which is when it is cheapest to
 * discover that the market you operate in has no rule for the identifier your
 * payloads are full of. The same three lists travel on every screening as
 * `Screening.coverage.declared`, so the answer at design time and the answer in
 * the trace are the same answer.
 *
 * Throws `LocaleUnsupported` for a market with no shipped pack — this module
 * does not have an opinion it can defend about a market it ships no rules for,
 * and returning an empty coverage would read as "nothing to find".
 */
export interface LocaleCoverage {
  readonly locale: string;
  /** Derived from the pack's patterns. Cannot drift from them. */
  readonly covers: NonEmpty<CoverageCategory>;
  readonly partial: readonly CoverageNote[];
  readonly doesNotCover: readonly CoverageNote[];
  /** Which rules fire for each covered category, so a reader can check the claim. */
  readonly rules: readonly { readonly rule: string; readonly covers: CoverageCategory }[];
}

export const localeCoverage = (locale: Locale | string): LocaleCoverage => {
  const market = MARKETS[locale];
  if (market === undefined) {
    throw new LocaleUnsupported("guardrails.personal-data", String(locale), SHIPPED_LOCALES);
  }
  const patterns = [...market.patterns, ...UNIVERSAL];
  return Object.freeze({
    locale: String(locale),
    covers: Object.freeze(
      [...new Set(patterns.map((p) => p.covers))].sort(),
    ) as unknown as NonEmpty<CoverageCategory>,
    partial: Object.freeze([...market.partial]),
    doesNotCover: Object.freeze([...market.doesNotCover]),
    rules: Object.freeze(patterns.map((p) => Object.freeze({ rule: p.rule, covers: p.covers }))),
  });
};

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
  const market = MARKETS[options.locale];
  if (market === undefined) {
    throw new LocaleUnsupported("guardrails.personal-data", options.locale, SHIPPED_LOCALES);
  }
  const patterns = [...market.patterns, ...UNIVERSAL] as unknown as NonEmpty<Pattern>;
  return deterministicDetector({
    id: options.id ?? `pii.${options.locale}`,
    locales: [options.locale] as unknown as NonEmpty<string>,
    searches: `personal-data formats for ${options.locale} (${patterns.length} patterns) and the international formats`,
    category: "personal-data",
    // Redact by default: the site is masked before anything is recorded or
    // returned. There is no un-writing, so the default is the safe one.
    severity: options.severity ?? "redact",
    patterns,
    // The pack's own gaps travel with the pack, so a screening records what was
    // not looked for beside what was.
    partial: market.partial,
    doesNotCover: market.doesNotCover,
    ...(options.fields === undefined ? {} : { fields: options.fields }),
  });
};
