import { checkCoverage, type CoverageCategory, type CoverageNote, type DetectorCoverage } from "./coverage.js";
import { assertPatternSafe, type Pattern } from "./safe-pattern.js";
import type {
  Classifier,
  Detector,
  DetectorId,
  DetectorReport,
  DetectorSpend,
  FindingCategory,
  FindingDraft,
  Locale,
  NonEmpty,
  ScreeningSubject,
  Severity,
} from "./types.js";

export type { Pattern } from "./safe-pattern.js";

/**
 * The two adapters behind the `Detector` seam. Both are real and both ship.
 *
 *   1. `deterministicDetector` — patterns and dictionaries. Sub-millisecond, no
 *      I/O of any kind, and safe to run at every tier.
 *   2. `modelDetector` — a classifier reached through an injected `Classifier`.
 *      Roughly doubles decision latency and cost, which is exactly why tier
 *      selects the detector *set*: low-tier throughput dies if the expensive set
 *      runs on the highest-volume path.
 *
 * Neither constructs anything. `modelDetector` receives its `Classifier` as a
 * constructor parameter, so a test is structurally unable to reach a live model
 * even with real credentials present in the environment.
 *
 * Both are **pure with respect to the payload and the sources**: they receive
 * deep-frozen copies of both, they return coordinates and integers, and they
 * never carry matched text back out. Redaction is the module's job, not theirs —
 * a detector cannot forget to redact what it found, because redacting was never
 * its job.
 *
 * ## How the deterministic adapter is bounded, and what is left over
 *
 * This used to be the module's frankest residual: `screen` could return a value
 * rather than a promise, a synchronous body never yields, and no in-process
 * timer could preempt a catastrophically backtracking regular expression over a
 * 32,768-character field. It was an unbounded event-loop stall on the hot path
 * of every decision, twice.
 *
 * Three changes, in decreasing order of how much they actually buy:
 *
 *   1. **A `Pattern` cannot be built from a regular expression capable of
 *      exponential backtracking.** Its brand is a non-exported `unique symbol`,
 *      `safePattern` is the only mint, and this adapter re-checks every pattern
 *      at construction so a cast is refused too. `(a+)+`, `(a|aa)*` and every
 *      backreference are unrepresentable in a pack. See `lib/safe-pattern.ts`.
 *   2. **The scan checks `subject.deadline` between every pattern and every
 *      field**, and stops, declaring itself unavailable with how far it got. An
 *      accepted-but-slow pattern therefore costs one scan, not a pack.
 *   3. **`screen` is asynchronous and yields periodically**, so the engine's
 *      race can be scheduled while a scan is still running rather than after it.
 *
 * What is left, stated as a bound: an accepted pattern can still be *polynomial*
 * in field length, so a single (pattern, field) scan can cost on the order of
 * `maxFieldChars²` character comparisons — roughly a second of one core at the
 * default 32,768 — and no in-process timer can preempt it. `lib/safe-pattern.ts`
 * gives the full accounting, including why a worker thread is the wrong trade.
 */

/** How many (field, pattern) scans run between yields to the event loop. */
const SCANS_PER_YIELD = 8;

export interface DeterministicDetectorSpec {
  readonly id: string;
  readonly locales: NonEmpty<string>;
  readonly searches: string;
  readonly category: FindingCategory;
  readonly severity: Severity;
  /** Minted by `safePattern`, which is the only way to obtain one. */
  readonly patterns: NonEmpty<Pattern>;
  /** Screen only these fields. Omit to screen every field. */
  readonly fields?: readonly string[];
  /**
   * Categories this pack addresses **incompletely**, each with the caveat.
   *
   * The covered list is not declared here — it is derived from the patterns,
   * every one of which carries a `covers` category and cannot be constructed
   * without one. So a declaration cannot drift from the pack it describes. What
   * no analysis can derive is what is *missing*, which is what these two lists
   * are for.
   */
  readonly partial?: readonly CoverageNote[];
  readonly doesNotCover?: readonly CoverageNote[];
}

/**
 * Adapter 1. Patterns and dictionaries.
 *
 * The patterns are supplied rather than built in, and the locales they are
 * valid for are declared rather than assumed — see `PERSONAL_DATA_PACKS`. A
 * detector wired into a market it does not declare fails at construction, not
 * by finding nothing.
 */
export const deterministicDetector = (spec: DeterministicDetectorSpec): Detector => {
  // A cast can defeat the brand; it cannot defeat this. Refused at boot, which
  // is the loudest cheap place to refuse a pattern that stalls a hot path.
  for (const pattern of spec.patterns) assertPatternSafe(pattern);

  const covers = [...new Set(spec.patterns.map((p) => p.covers))].sort() as unknown as NonEmpty<CoverageCategory>;
  const declares: DetectorCoverage = {
    covers,
    ...(spec.partial === undefined ? {} : { partial: spec.partial }),
    ...(spec.doesNotCover === undefined ? {} : { doesNotCover: spec.doesNotCover }),
  };
  checkCoverage(spec.id, declares);

  return {
    id: spec.id as DetectorId,
    costClass: "deterministic",
    locales: spec.locales as unknown as NonEmpty<Locale>,
    searches: spec.searches,
    declares,
    async screen(subject: ScreeningSubject): Promise<DetectorReport> {
      const drafts: FindingDraft[] = [];
      const requested = spec.fields ?? Object.keys(subject.fields);
      // Only fields this detector was actually shown, so the coverage it claims
      // is coverage it could have delivered.
      const examined: string[] = [];
      let scans = 0;
      for (const field of requested) {
        const text = subject.fields[field];
        if (typeof text !== "string") continue;
        for (const pattern of spec.patterns) {
          // The bound the engine cannot enforce from outside. Checked *before*
          // the scan, so what is abandoned is work not yet started — and
          // reported as `declared`, because a detector may name its own
          // dependency failing and may not classify its own incident.
          if (subject.deadline.expired()) {
            return {
              outcome: "unavailable",
              reason: "declared",
              detail: `budget spent after ${scans} of ${requested.length * spec.patterns.length} pattern scans`,
              costTenthCents: 0,
              modelCalls: 0,
            };
          }
          // A fresh regex per scan: a shared sticky regex carries `lastIndex`
          // between calls, and a detector whose answer depends on what it was
          // asked last is not deterministic.
          const re = new RegExp(pattern.match.source, withGlobal(pattern.match.flags));
          for (const match of text.matchAll(re)) {
            if (match.index === undefined || match[0].length === 0) continue;
            drafts.push({
              category: spec.category,
              severity: spec.severity,
              rule: pattern.rule,
              at: {
                field,
                startCodeUnit: match.index,
                lengthCodeUnits: match[0].length,
              },
              confidenceBasisPoints: pattern.confidenceBasisPoints,
            });
          }
          scans += 1;
          // Yield so the engine's race against the budget can be *scheduled*
          // while this scan is still going, rather than only after it. It does
          // not preempt the scan in flight; nothing in this runtime does.
          if (scans % SCANS_PER_YIELD === 0) await Promise.resolve();
        }
        examined.push(field);
      }
      return drafts.length === 0
        ? {
            outcome: "searched-and-found-none",
            costTenthCents: 0,
            modelCalls: 0,
            examinedFields: examined,
          }
        : {
            outcome: "found",
            findings: drafts as unknown as NonEmpty<FindingDraft>,
            costTenthCents: 0,
            modelCalls: 0,
            examinedFields: examined,
          };
    },
  };
};

const withGlobal = (flags: string): string => (flags.includes("g") ? flags : `${flags}g`);

export interface ModelDetectorSpec {
  readonly id: string;
  readonly locales: NonEmpty<string>;
  readonly searches: string;
  readonly category: FindingCategory;
  readonly severity: Severity;
  /** Injected. The module never constructs one. */
  readonly classifier: Classifier;
  /** The labels the classifier scores. The first is the one that fires. */
  readonly labels: NonEmpty<string>;
  /** A label at or above this fires a finding. Basis points. */
  readonly thresholdBasisPoints: number;
  readonly fields?: readonly string[];
  /**
   * What this classifier's labels cover, declared by the caller who chose them.
   *
   * Not derivable here: a label is a string, and nothing in this adapter can
   * tell what a model was trained to notice. Omitted means the detector declares
   * nothing, and a screening counts it in `coverage.declared.undeclared` rather
   * than assuming either direction.
   */
  readonly declares?: DetectorCoverage;
}

/**
 * Adapter 2. A model-based classifier.
 *
 * Whole-field granularity: a classifier says "this field looks like an
 * injection attempt", not "characters 40 to 68 do". The finding site is
 * therefore the whole field, which is honest — and it is why a model detector
 * is a poor choice for `severity: "redact"`, since masking a whole field
 * destroys the payload. Use it for `escalate` or `block`, where the site is
 * evidence rather than a redaction instruction.
 *
 * A classifier that throws or hangs is not caught here: the engine bounds and
 * catches it, and turns it into an abstain-recommended screening. Catching it
 * in the adapter would let a broken classifier report "searched and found none",
 * which is precisely the lie this module exists to prevent.
 */
export const modelDetector = (spec: ModelDetectorSpec): Detector => {
  if (spec.declares !== undefined) checkCoverage(spec.id, spec.declares);
  return {
    id: spec.id as DetectorId,
    costClass: "model",
    locales: spec.locales as unknown as NonEmpty<Locale>,
    searches: spec.searches,
    ...(spec.declares === undefined ? {} : { declares: spec.declares }),
    async screen(subject: ScreeningSubject): Promise<DetectorReport> {
      const drafts: FindingDraft[] = [];
      const candidates = (spec.fields ?? Object.keys(subject.fields)).filter((field) => {
        const text = subject.fields[field];
        return typeof text === "string" && text.length > 0;
      });
      const examined: string[] = [];
      let costTenthCents = 0;
      let modelCalls = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      const priceTables = new Set<string>();
      // **The budget is divided, not handed out whole.** One call per field, so a
      // per-call budget equal to the whole screening budget is a bound that
      // cannot hold once there are two fields.
      const perCall = Math.max(1, Math.floor(subject.budgetMicros / Math.max(1, candidates.length)));
      for (const field of candidates) {
        // Between calls, not during one: a classifier already in flight cannot
        // be cancelled from here, which is why the budget also travels down.
        if (subject.deadline.expired()) {
          return {
            outcome: "unavailable",
            reason: "declared",
            detail: `budget spent after ${modelCalls} of ${candidates.length} classifier calls`,
            costTenthCents,
            modelCalls,
            ...(modelCalls === 0
              ? {}
              : {
                  spend: {
                    tokensIn,
                    tokensOut,
                    priceTableVersion: [...priceTables].sort().join(","),
                  },
                }),
          };
        }
        const text = subject.fields[field] as string;
        const response = await spec.classifier.classify({
          labels: spec.labels,
          // The masked view. A `model` detector runs in the engine's second round,
          // so what leaves the process is the text after the deterministic round's
          // redaction — see `ClassifierRequest.text` for exactly how strong that
          // is and what it depends on.
          text,
          budgetMicros: perCall,
        });
        modelCalls += 1;
        examined.push(field);
        costTenthCents += response.costTenthCents;
        tokensIn += response.tokensIn;
        tokensOut += response.tokensOut;
        priceTables.add(response.priceTableVersion);
        for (const label of spec.labels) {
          const score = response.scores[label] ?? 0;
          if (score < spec.thresholdBasisPoints) continue;
          drafts.push({
            category: spec.category,
            severity: spec.severity,
            rule: `${spec.classifier.model}@${spec.classifier.promptVersion}:${label}`,
            at: { field, startCodeUnit: 0, lengthCodeUnits: text.length },
            confidenceBasisPoints: score,
          });
        }
      }
      const spend: DetectorSpend | undefined =
        modelCalls === 0
          ? undefined
          : { tokensIn, tokensOut, priceTableVersion: [...priceTables].sort().join(",") };
      return drafts.length === 0
        ? {
            outcome: "searched-and-found-none",
            costTenthCents,
            modelCalls,
            examinedFields: examined,
            ...(spend === undefined ? {} : { spend }),
          }
        : {
            outcome: "found",
            findings: drafts as unknown as NonEmpty<FindingDraft>,
            costTenthCents,
            modelCalls,
            examinedFields: examined,
            ...(spend === undefined ? {} : { spend }),
          };
    },
  };
};
