import { CoverageIncoherent } from "./errors.js";
import type { NonEmpty } from "./types.js";

/**
 * What a detector says it looks for — and, load-bearingly, what it says it does
 * **not**.
 *
 * ## Why a declaration rather than a comment
 *
 * A detector wired into a market it does not cover produces a clean screening.
 * A pack that covers postcodes but not street addresses produces a clean
 * screening over a street address. Neither errors, neither is visible in a
 * trace, and neither is distinguishable from a payload that genuinely held
 * nothing. That is the compliance incident this module exists to prevent, and
 * the only defence that survives contact with nineteen applications is for the
 * detector to state its own scope in a form the trace can carry.
 *
 * Three lists, and the second is the one that gets skipped everywhere else:
 *
 *   `covers`        Categories the detector's rules address.
 *   `partial`       Categories it addresses **incompletely**, each with the
 *                   caveat spelled out. A postcode is not an address; a sort
 *                   code is not an account number. A partial claim recorded as a
 *                   full one is worse than no claim, because a reader stops
 *                   looking.
 *   `doesNotCover`  Categories it deliberately does not address, each with the
 *                   reason. Absence of a finding is not a finding, and absence
 *                   of a *rule* is not visible at all unless somebody writes it
 *                   down.
 *
 * **`partial` may overlap `covers`, and must not overlap `doesNotCover`.** The
 * overlap is the useful case and refusing it would force a dishonest choice: a
 * United Kingdom pack matches postcodes, so `personal-data.postcode` is covered,
 * while `personal-data.postal-address` is matched only in that one component —
 * and a pack that matches an international bank account number still misses a
 * bare eight-digit account number, which qualifies a category it also covers.
 * Covered-and-uncovered is the one combination that is simply a contradiction,
 * and it is refused at construction.
 *
 * **A caveat is never dropped in aggregation.** If any detector qualifies a
 * category, the qualification survives even when another detector covers it
 * outright — because "another pack covers this" is a claim about the other pack
 * that nothing here can check, and over-warning is the safe direction for a
 * number a data-protection officer reads.
 *
 * ## The covered list is derived, not declared
 *
 * For a pattern pack, `covers` is computed from the patterns themselves — every
 * `Pattern` carries `covers: CoverageCategory` and cannot be constructed without
 * one. So a rule added to a pack appears in its coverage declaration in the same
 * commit, and a declaration cannot drift from the thing it describes. Only
 * `partial` and `doesNotCover` are written by hand, because no analysis can
 * derive what is missing.
 *
 * ## The category vocabulary is closed on purpose
 *
 * A closed union is byte-stable for seven years and greppable across nineteen
 * applications. `personal-data.*` and `prompt-injection.*` are enumerated
 * because this module ships packs for both; `prohibited-content` and
 * `ungrounded-claim` are coarse because it ships none, and pretending to a
 * finer vocabulary than the packs justify would be the same overclaim this file
 * exists to prevent. Adding a member is a deliberate addition, like a node kind.
 */

/**
 * Personal-data categories, in the terms a data-protection officer uses rather
 * than the terms a regular expression uses. `postcode` is separate from
 * `postal-address` because a pack matching one and claiming the other is the
 * single most likely overclaim in this file.
 */
export type PersonalDataCategory =
  | "personal-data.name"
  | "personal-data.postal-address"
  | "personal-data.postcode"
  | "personal-data.national-identifier"
  | "personal-data.tax-identifier"
  | "personal-data.health-identifier"
  | "personal-data.bank-account"
  | "personal-data.payment-card"
  | "personal-data.telephone"
  | "personal-data.email-address"
  | "personal-data.date-of-birth"
  | "personal-data.vehicle-registration"
  | "personal-data.network-address"
  | "personal-data.credential"
  | "personal-data.biometric"
  | "personal-data.criminal-record"
  | "personal-data.free-text-identifier";

/**
 * Prompt-injection techniques, named by what the attacker does rather than by
 * what the pattern matches. The last four have no deterministic rule and never
 * will — they are here so a pack can say so in the trace.
 */
export type PromptInjectionTechnique =
  | "prompt-injection.instruction-override"
  | "prompt-injection.role-hijack"
  | "prompt-injection.system-prompt-exfiltration"
  | "prompt-injection.delimiter-forgery"
  | "prompt-injection.tool-coercion"
  | "prompt-injection.data-exfiltration"
  | "prompt-injection.hidden-characters"
  | "prompt-injection.encoded-payload"
  | "prompt-injection.paraphrase"
  | "prompt-injection.multilingual"
  | "prompt-injection.split-across-fields"
  | "prompt-injection.indirect";

export type CoverageCategory =
  | PersonalDataCategory
  | PromptInjectionTechnique
  | "prohibited-content"
  | "ungrounded-claim";

/** A category named together with the caveat or the reason that qualifies it. */
export interface CoverageNote {
  readonly category: CoverageCategory;
  readonly why: string;
}

/** What one detector declares about its own scope. */
export interface DetectorCoverage {
  readonly covers: NonEmpty<CoverageCategory>;
  readonly partial?: readonly CoverageNote[];
  readonly doesNotCover?: readonly CoverageNote[];
}

/**
 * What one screening's detectors, **taken together**, covered.
 *
 * Aggregated across the detectors that completed a search, which is the only
 * honest set: a detector that was unavailable covered nothing, whatever it
 * declares, and counting its declaration would turn an outage into a clean
 * coverage report.
 */
export interface DeclaredCoverage {
  readonly covers: readonly CoverageCategory[];
  /** Covered incompletely by every detector that addressed them. */
  readonly partial: readonly CoverageNote[];
  /**
   * Declared uncovered by some detector and covered by no other. These are the
   * holes the screening knows about — which is a different and much smaller set
   * than the holes that exist.
   */
  readonly gaps: readonly CoverageNote[];
  /**
   * Detectors that completed a search and declared no scope at all. Their
   * contribution to coverage is unknown, and unknown is recorded rather than
   * assumed empty or assumed total.
   */
  readonly undeclared: number;
}

/**
 * Check a declaration at construction: the three lists must be disjoint.
 *
 * A category in both `covers` and `doesNotCover` is not a subtlety, it is two
 * incompatible claims in the same object, and whichever a reader trusts they
 * are reading a coin flip. Fail-closed at boot — see `CoverageIncoherent`.
 */
export const checkCoverage = (detector: string, coverage: DetectorCoverage): void => {
  if (!Array.isArray(coverage.covers) || coverage.covers.length === 0) {
    throw new CoverageIncoherent(detector, "declares no covered category");
  }
  const unique = (categories: readonly CoverageCategory[], list: string): Set<CoverageCategory> => {
    const set = new Set<CoverageCategory>();
    for (const category of categories) {
      if (set.has(category)) {
        throw new CoverageIncoherent(detector, `names ${category} twice in ${list}`);
      }
      set.add(category);
    }
    return set;
  };
  const covers = unique(coverage.covers, "covers");
  const partial = unique(
    (coverage.partial ?? []).map((n) => n.category),
    "partial",
  );
  const uncovered = unique(
    (coverage.doesNotCover ?? []).map((n) => n.category),
    "doesNotCover",
  );
  for (const category of uncovered) {
    // The one combination that is a contradiction rather than a qualification.
    if (covers.has(category)) {
      throw new CoverageIncoherent(detector, `names ${category} as both covered and not covered`);
    }
    if (partial.has(category)) {
      throw new CoverageIncoherent(detector, `names ${category} as both partial and not covered`);
    }
  }
  for (const note of [...(coverage.partial ?? []), ...(coverage.doesNotCover ?? [])]) {
    if (typeof note.why !== "string" || note.why.length === 0) {
      throw new CoverageIncoherent(
        detector,
        `qualifies ${note.category} without saying what the qualification is`,
      );
    }
  }
};

/**
 * Fold the declarations of the detectors that completed a search into one.
 *
 * The interesting rule is the last one: a category one pack cannot see and
 * another can is **not** a gap. Nineteen applications wire several packs
 * together precisely so the holes do not line up, and a coverage report that
 * ignored that would cry wolf on every screening until nobody read it.
 */
export const aggregateCoverage = (
  declarations: readonly DetectorCoverage[],
  undeclared: number,
): DeclaredCoverage => {
  const covers = new Set<CoverageCategory>();
  for (const declaration of declarations) for (const c of declaration.covers) covers.add(c);

  // A caveat survives another pack's unqualified claim. Over-warning is the
  // safe direction; a dropped caveat is how a reader stops looking.
  const partial = new Map<CoverageCategory, CoverageNote>();
  for (const declaration of declarations) {
    for (const note of declaration.partial ?? []) {
      if (!partial.has(note.category)) partial.set(note.category, note);
    }
  }

  const gaps = new Map<CoverageCategory, CoverageNote>();
  for (const declaration of declarations) {
    for (const note of declaration.doesNotCover ?? []) {
      // One pack's hole filled by another pack's rule is not a hole. This is the
      // whole reason nineteen applications wire several packs together.
      if (covers.has(note.category) || partial.has(note.category)) continue;
      if (!gaps.has(note.category)) gaps.set(note.category, note);
    }
  }

  const byCategory = (a: CoverageNote, b: CoverageNote): number =>
    a.category < b.category ? -1 : a.category > b.category ? 1 : 0;

  return Object.freeze({
    covers: Object.freeze([...covers].sort()),
    partial: Object.freeze([...partial.values()].sort(byCategory)),
    gaps: Object.freeze([...gaps.values()].sort(byCategory)),
    undeclared,
  });
};
