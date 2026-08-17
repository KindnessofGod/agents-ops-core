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
 * ## The bound `deterministicDetector` cannot honour, named
 *
 * `screen` here is **synchronous**. A synchronous body never yields, so the
 * engine's `Promise.race` against `limits.detectorBudgetMicros` is not scheduled
 * until after it has finished, and no in-process timer of any design can preempt
 * it. The patterns are caller-supplied `RegExp`s compiled per field over text of
 * up to `maxFieldChars` (32,768 by default), so **a catastrophically
 * backtracking pattern is an unbounded event-loop stall on the hot path of every
 * decision, twice**. Nested quantifiers over a shared alternation — the classic
 * `(a+)+` shape — are the thing to keep out of a pack.
 *
 * What the engine does about it, since it cannot preempt: it measures the
 * elapsed time against the injected clock after the call returns and records a
 * detector that overran as `unavailable/timed-out`, which fails the screening
 * closed. The budget therefore bounds the **answer** deterministically; it does
 * not bound the work, and this module will not claim it does.
 */

export interface Pattern {
  /** Stable identifier, recorded on every finding. Never the matched value. */
  readonly rule: string;
  /** Must be sticky or global; the adapter re-creates it per scan regardless. */
  readonly match: RegExp;
  /** 0..10000. */
  readonly confidenceBasisPoints: number;
}

export interface DeterministicDetectorSpec {
  readonly id: string;
  readonly locales: NonEmpty<string>;
  readonly searches: string;
  readonly category: FindingCategory;
  readonly severity: Severity;
  readonly patterns: NonEmpty<Pattern>;
  /** Screen only these fields. Omit to screen every field. */
  readonly fields?: readonly string[];
}

/**
 * Adapter 1. Patterns and dictionaries.
 *
 * The patterns are supplied rather than built in, and the locales they are
 * valid for are declared rather than assumed — see `PERSONAL_DATA_PACKS`. A
 * detector wired into a market it does not declare fails at construction, not
 * by finding nothing.
 */
export const deterministicDetector = (spec: DeterministicDetectorSpec): Detector => ({
  id: spec.id as DetectorId,
  costClass: "deterministic",
  locales: spec.locales as unknown as NonEmpty<Locale>,
  searches: spec.searches,
  screen(subject: ScreeningSubject): DetectorReport {
    const drafts: FindingDraft[] = [];
    const fields = spec.fields ?? Object.keys(subject.fields);
    for (const field of fields) {
      const text = subject.fields[field];
      if (typeof text !== "string") continue;
      for (const pattern of spec.patterns) {
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
      }
    }
    return drafts.length === 0
      ? { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 }
      : {
          outcome: "found",
          findings: drafts as unknown as NonEmpty<FindingDraft>,
          costTenthCents: 0,
          modelCalls: 0,
        };
  },
});

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
export const modelDetector = (spec: ModelDetectorSpec): Detector => ({
  id: spec.id as DetectorId,
  costClass: "model",
  locales: spec.locales as unknown as NonEmpty<Locale>,
  searches: spec.searches,
  async screen(subject: ScreeningSubject): Promise<DetectorReport> {
    const drafts: FindingDraft[] = [];
    const candidates = (spec.fields ?? Object.keys(subject.fields)).filter((field) => {
      const text = subject.fields[field];
      return typeof text === "string" && text.length > 0;
    });
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
      ? { outcome: "searched-and-found-none", costTenthCents, modelCalls, ...(spend === undefined ? {} : { spend }) }
      : {
          outcome: "found",
          findings: drafts as unknown as NonEmpty<FindingDraft>,
          costTenthCents,
          modelCalls,
          ...(spend === undefined ? {} : { spend }),
        };
  },
});
