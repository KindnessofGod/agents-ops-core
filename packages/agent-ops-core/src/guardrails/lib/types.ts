import type { CorrelationId, NodeId, RiskTier } from "../../audit/index.js";
import type { Clock } from "../../audit/index.js";
import type { DeclaredCoverage, DetectorCoverage } from "./coverage.js";
import type { SETTLED_NODE } from "./mint.js";
import type { Timer } from "./timer.js";

/**
 * The vocabulary of `guardrails`, in the terms `docs/CONTEXT.md` fixes.
 *
 * Two words this file deliberately does **not** use for anything it produces:
 * `verdict` and `abstention`. Per `CONTEXT.md` an abstention is a *verdict
 * disposition* — the system declining to conclude — and a verdict is the content
 * of a decision. This module produces neither. It produces **findings** and a
 * **recommended disposition**, and the decision records the abstention. If
 * guardrails could abstain directly there would be two places in the codebase
 * producing verdicts, and the trace would carry entries with no decision behind
 * them.
 *
 * Every number that crosses into the trace is a safe integer: cost in
 * tenth-cents, latency in microseconds, confidence and support in basis points.
 * No IEEE-754 anywhere, because byte-stable serialisation is what makes replay
 * possible and floats are how it dies quietly.
 */

/** A list that cannot be empty. "Nothing" is never spelled as an empty array. */
export type NonEmpty<T> = readonly [T, ...T[]];

/** Milliseconds since the Unix epoch, from the injected clock. Never `Date.now()`. */
export type Instant = number;

export type { Clock, Timer };

// ---------------------------------------------------------------------------
// Locale — required configuration, no default
// ---------------------------------------------------------------------------

/**
 * The jurisdiction whose personal-data formats apply.
 *
 * There is **no default**, and there is no fallback. Personal-data patterns are
 * jurisdictional: a national identifier, a bank account, a health number and a
 * postcode have different shapes in every market, and a library serving
 * nineteen applications across several of them that hardcodes one country's
 * formats is a compliance incident waiting for a date.
 *
 * A language subtag alone is not a jurisdiction — `en` does not tell you
 * whether a nine-digit run is a United States social security number or noise —
 * so a region subtag is required by `localeOf`.
 */
export type Locale = string & { readonly __brand: "Locale" };

// ---------------------------------------------------------------------------
// What is screened
// ---------------------------------------------------------------------------

/**
 * What the caller hands in: flat, string-valued fields.
 *
 * Flat and string-only on purpose. Detectors search text, and nesting would
 * need canonical rules for array order and for key collision across levels —
 * every one of which is a place a reader in 2033 can be misled. A caller with
 * structure flattens it with dotted keys, which survives seven years
 * unambiguously.
 */
export type Payload = { readonly [field: string]: string };

declare const SCREENED: unique symbol;

/**
 * The redacted form of a payload, and the **only** form this module lets out.
 *
 * Unconstructible outside this module: the brand is a non-exported `unique
 * symbol`, so no external object literal satisfies the type. A caller therefore
 * cannot fabricate a payload that claims to have been screened.
 *
 * What this does *not* do, stated plainly: the caller still holds the original
 * string it passed in, and nothing in this package can stop application code
 * from sending that original to a model instead of this. The guarantee is that
 * the **trace** never holds the original — see `Screening`.
 */
export interface ScreenedPayload {
  readonly [SCREENED]: true;
  readonly fields: { readonly [field: string]: string };
  /** How many code-unit ranges were masked. Zero is a fact, not an absence. */
  readonly maskedSites: number;
}

/** Marks a masked range. Fixed, so redaction does not disturb byte-stability. */
export const MASK = "[redacted]";

export type ScreeningPhase = "input" | "output";

// ---------------------------------------------------------------------------
// Sources, for groundedness
// ---------------------------------------------------------------------------

export type SourceId = string & { readonly __brand: "SourceId" };

export interface Source {
  readonly id: SourceId;
  readonly text: string;
}

/**
 * Reference material for a groundedness check.
 *
 * Note the shape: **absence must be asserted, never implied**. There is no
 * empty-array branch, because an empty array and "we could not fetch the
 * sources" would be the same value, and the whole point of this module is that
 * "we could not check, so we allowed it" must be impossible to express. A
 * caller with nothing to check against says so, in words, and the screening
 * recommends abstain.
 */
export type Sources =
  | { readonly available: true; readonly items: NonEmpty<Source> }
  | { readonly available: false; readonly why: string };

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type FindingCategory =
  | "personal-data"
  | "prompt-injection"
  | "prohibited-content"
  | "ungrounded-claim";

/**
 * What a finding costs the caller. The detector set carries the tier's policy,
 * so severity is a property of how a detector was configured into a set rather
 * than a second tier table this module consults — one knob, not two.
 *
 *   advisory  Recorded, changes nothing.
 *   redact    The site is masked before anything is recorded or returned — in
 *             **every** category, not only `personal-data`. It was a no-op for
 *             `prompt-injection`, `prohibited-content` and `ungrounded-claim`
 *             until the masking rule was corrected, which meant three of the
 *             four categories recorded the raw text and recommended `allow`.
 *   escalate  A named human should hold this. Authority moves; the system may
 *             still have concluded.
 *   block     The system should not conclude at all.
 *
 * The converse also holds and is the other half of the rule: **every
 * `personal-data` site is masked at every severity**, including `advisory`.
 * Severity says what the *caller* should do with the payload it still holds; it
 * gets no say in what reaches the trace, because there is no un-writing.
 */
export type Severity = "advisory" | "redact" | "escalate" | "block";

/**
 * Where a finding is, never what it says.
 *
 * A detector reports **coordinates**, not the matched text. That is what keeps
 * personal data out of the trace structurally: there is no field on a finding
 * that could carry a name or an account number, so a careless detector cannot
 * leak one into a node.
 */
export interface FindingSite {
  readonly field: string;
  readonly startCodeUnit: number;
  readonly lengthCodeUnits: number;
}

export interface FindingDraft {
  readonly category: FindingCategory;
  readonly severity: Severity;
  /** Stable identifier of the rule that fired. Never the matched value. */
  readonly rule: string;
  readonly at: FindingSite;
  /** 0..10000. Integers only. */
  readonly confidenceBasisPoints: number;
}

/**
 * A draft, plus which detector produced it and which text its coordinates index
 * into. Both stamped by this module.
 *
 * `space` exists because detectors run in two rounds. A `deterministic` detector
 * sees the caller's text (`"original"`); a `model` detector sees the text after
 * the deterministic round's redaction (`"post-redaction"`), because a model
 * detector reaches a third party and shipping unmasked personal data to one is
 * not something this module will do. A coordinate without the space it belongs
 * to is a coordinate a 2033 reader has to guess at.
 */
export interface Finding extends FindingDraft {
  readonly detector: DetectorId;
  readonly space: "original" | "post-redaction";
}

/**
 * The result of a search, which is not the same thing as a list of findings.
 *
 * "Nothing found" is an **assertion about a search performed**, so it names what
 * was searched. Absence of a finding is not a finding, and an empty array
 * cannot say whether anybody looked.
 */
export type Findings =
  | { readonly found: NonEmpty<Finding> }
  | { readonly searchedAndFoundNone: { readonly searched: string } }
  /**
   * The third branch, and the one that keeps the second honest. When no
   * detector completed a search there is nothing to assert, and saying
   * "searched and found none" would be a claim about work nobody did. This is
   * always accompanied by a recommendation of abstain.
   */
  | { readonly couldNotSearch: { readonly why: string } };

// ---------------------------------------------------------------------------
// The detector seam
// ---------------------------------------------------------------------------

export type DetectorId = string & { readonly __brand: "DetectorId" };
export type DetectorSetId = string & { readonly __brand: "DetectorSetId" };

/**
 * What a detector costs to run, recorded on every screening.
 *
 * A model-based detector adds a full model call, roughly doubling decision
 * latency and cost. This is not forbidden at low tier — it is *recorded*, so an
 * application that has quietly wired an expensive set onto its highest-volume
 * path can see it on the trace instead of on the invoice.
 */
export type DetectorCostClass = "deterministic" | "model";

/**
 * What a detector sees. Note what is absent: no client, no store, no recorder,
 * no clock, no network handle, no correlation identifier.
 *
 * **No detector may produce an effect**, and this is the structural half of
 * that: there is nothing here to have an effect *with*. The other half is that
 * **both** `fields` and `sources` are deep-copied and frozen before they are
 * handed over, so a detector can neither mutate the payload it was asked to
 * inspect nor rewrite the reference material a sibling detector is judged
 * against — and the module works from its own copy in any case.
 *
 * `sources` is named explicitly because it was the hole. It used to be passed by
 * reference: one detector could rewrite `sources.items[0].text`, a second
 * detector in the same screening was then judged against the fabrication, and
 * the caller's own array came back mutated. That was a second influence channel
 * this comment denied the existence of.
 *
 * The honest limit that remains: a detector is application-supplied code holding
 * its own closure, and no type in this package can reach outside this package. A
 * detector that captured an HTTP client at construction can still call it. The
 * claim is *no effect through anything `guardrails` hands it*, not *no effect*.
 */
export interface ScreeningSubject {
  readonly phase: ScreeningPhase;
  readonly locale: Locale;
  /**
   * Frozen. Assignment throws; the module reads its own copy regardless.
   *
   * Which text this is depends on the detector's `costClass`. A `deterministic`
   * detector runs in the first round and sees the caller's text. A `model`
   * detector runs in the second and sees that text **after** the first round's
   * redaction, because a model detector reaches a third party.
   */
  readonly fields: { readonly [field: string]: string };
  /**
   * Reference material: a deep-frozen copy of what the caller supplied, shared
   * by every detector in the screening. On an input screening this is always
   * `{ available: false }` — an input has nothing to be grounded against — so a
   * groundedness detector wired into an input set declares itself unavailable
   * and the screening fails closed, which is the correct answer to that wiring
   * mistake.
   */
  readonly sources: Sources;
  /**
   * How long this detector has. The module also races the call against this
   * budget, but a detector that owns a client should pass the budget down —
   * racing cannot cancel work the module does not control.
   */
  readonly budgetMicros: number;
  /**
   * Whether the budget above is already spent. Checked by a well-behaved
   * detector between units of work; honoured by both shipped adapters.
   *
   * **Not a clock, and the distinction is what keeps purity intact.** It cannot
   * say what time it is, how long is left, or how long anything took: it is a
   * one-bit, monotone oracle closed over the engine's injected clock. There is
   * nothing here to have an effect with, nothing to seed a nonce from, and
   * nothing that varies between two calls in the same instant.
   *
   * It exists because a budget a detector cannot observe is a budget only the
   * engine can enforce, and the engine can only enforce it *after the fact* —
   * see `Detector.screen` for the half of that which stays true regardless.
   */
  readonly deadline: Deadline;
}

/**
 * The one-bit budget oracle handed to a detector. See `ScreeningSubject.deadline`.
 */
export interface Deadline {
  expired(): boolean;
}

export type DetectorUnavailableReason =
  /** The detector threw. */
  | "threw"
  /** The detector did not answer within its budget. */
  | "timed-out"
  /** The detector said so itself — its dependency is down. */
  | "declared"
  /** The detector returned something that is not a valid report. */
  | "malformed";

/**
 * Tokens and the table that priced them, reported by a detector that made model
 * calls.
 *
 * C2 names four things per node — cost, tokens, latency and the price-table
 * version — and two of them used to be absent everywhere in this module, so a
 * 2033 reader could not reconstruct how a cost figure was derived. Optional on a
 * report, because a deterministic detector measures no tokens and recording
 * zeroes against a made-up table would make "we spent nothing" indistinguishable
 * from "we did not measure". Where it is present, this module writes `audit`'s
 * typed `NodeTelemetry` on the detector's node rather than free-form payload
 * keys, so a cross-application cost report is derivable.
 */
export interface DetectorSpend {
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Names the table that turned tokens into money. Uninterpretable without it. */
  readonly priceTableVersion: string;
}

/**
 * What a detector returns. Data only — there is no command, no callback and no
 * handle here, so a detector's entire influence on the run is this value.
 */
export type DetectorReport =
  | {
      readonly outcome: "found";
      readonly findings: NonEmpty<FindingDraft>;
      readonly costTenthCents: number;
      readonly modelCalls: number;
      readonly spend?: DetectorSpend;
      readonly examinedFields?: readonly string[];
    }
  | {
      readonly outcome: "searched-and-found-none";
      readonly costTenthCents: number;
      readonly modelCalls: number;
      readonly spend?: DetectorSpend;
      /**
       * Which fields this detector actually looked at. Omitted means **all of
       * them** — every field it was shown.
       *
       * It is here because `fields?: readonly string[]` on the shipped adapters
       * was invisible wiring: a personal-data detector configured for
       * `["subject"]` while the free-text `narrative` went unexamined produced a
       * screening reading `searchedAndFoundNone` over text nobody searched. The
       * engine folds this into `Screening.coverage`, so the trace records how
       * much of the payload was looked at rather than implying all of it.
       *
       * Names must be fields the detector was shown; anything else is a
       * `DetectorReportInvalid`, because a detector claiming to have searched a
       * field that does not exist is claiming a search nobody ran.
       */
      readonly examinedFields?: readonly string[];
    }
  | {
      readonly outcome: "unavailable";
      readonly reason: Extract<DetectorUnavailableReason, "declared">;
      /**
       * What was spent before the dependency failed. Optional, and **absent is
       * not zero**: a detector that spent money and then lost its classifier can
       * say so here, and one that cannot say records `costMeasured: false` on
       * its node rather than a zero nobody can distinguish from free.
       */
      readonly costTenthCents?: number;
      readonly modelCalls?: number;
      readonly spend?: DetectorSpend;
      /**
       * Names the *dependency* that failed — "classifier returned 503" — and
       * never payload content. Recorded truncated to a bounded prefix.
       *
       * Stated plainly because it is the one place a detector could put payload
       * text into the trace: this is a **contract, not an enforcement**. Nothing
       * in this module can tell a connection error from a claimant's name. Every
       * other route from a detector back into the trace carries coordinates and
       * integers only, by construction.
       */
      readonly detail: string;
    };

/**
 * The seam. Three adapters ship, all real:
 *
 *   1. `deterministicDetector` — patterns and dictionaries, sub-millisecond, no
 *      I/O of any kind.
 *   2. `modelDetector` — a classifier behind an injected `Classifier`.
 *   3. `preemptiveDetector` — the same patterns in a bounded worker pool, so a
 *      runaway scan can be **stopped** rather than merely refused. Opt-in per
 *      detector; see `lib/preemption.ts` for what still crosses into the second
 *      heap and for the reversal it represents.
 *
 * Tier selects which set runs, because a model-based detector roughly doubles
 * decision latency and cost, and low-tier throughput dies without a cheap-only
 * set.
 */
export interface Detector {
  readonly id: DetectorId;
  readonly costClass: DetectorCostClass;
  /**
   * The jurisdictions this detector's patterns are valid for. Checked against
   * the configured locale when guardrails is constructed, so a detector wired
   * into the wrong market fails at boot rather than by finding nothing.
   */
  readonly locales: NonEmpty<Locale>;
  /**
   * What this detector looks for, in words. Used verbatim to build
   * `searchedAndFoundNone.searched`, which is why it is required rather than
   * derived from the identifier.
   */
  readonly searches: string;
  /**
   * What this detector claims to cover, and — the half that matters — what it
   * claims not to. Optional, because a bespoke caller detector may have nothing
   * to say; a detector that completes a search having declared nothing is
   * counted in `Screening.coverage.declared.undeclared` rather than assumed
   * either way. See `lib/coverage.ts`.
   */
  readonly declares?: DetectorCoverage;
  /**
   * **Asynchronous, and that is a requirement rather than a convenience.**
   *
   * It used to be `Promise<DetectorReport> | DetectorReport`. A synchronous body
   * never yields, so the engine's race against `detectorBudgetMicros` was not
   * scheduled until after the detector had already finished, and a detector that
   * looped could not be preempted by any in-process timer of any design.
   *
   * Requiring a promise is the precondition for the race being scheduled at all.
   * **It is not, by itself, a bound**, and this interface will not pretend
   * otherwise: an `async` function whose body is central-processing-unit-bound
   * until it returns blocks the event loop exactly as a synchronous one did.
   * What actually bounds the shipped deterministic adapter is two other things —
   * `Pattern` cannot be constructed from a regular expression capable of
   * exponential backtracking, and the scan checks `subject.deadline` between
   * every pattern and every field. Neither can stop a scan already under way, so
   * the only thing that genuinely preempts one is `preemptiveDetector`, which
   * runs it in a worker thread the pool can terminate. See `lib/safe-pattern.ts`
   * for what the analyser can and cannot prove, and `lib/preemption.ts` for the
   * preemption itself.
   *
   * For an application-supplied detector the honest claim is narrower still: a
   * detector that awaits something can be raced, a detector that yields to its
   * `deadline` stops on time, and a detector that does neither is bounded by
   * nothing this module can offer.
   */
  screen(subject: ScreeningSubject): Promise<DetectorReport>;
}

/**
 * Which detectors run at one tier, in each phase.
 *
 * `NonEmpty` in both phases: a tier with no detectors is a tier that is not
 * screened, and "we ran nothing and found nothing" must not be expressible.
 */
export interface DetectorSet {
  readonly id: DetectorSetId;
  readonly input: NonEmpty<Detector>;
  readonly output: NonEmpty<Detector>;
}

/**
 * Required configuration, one set per tier, no default. Tier selects the set —
 * that is the whole of the tier policy in this module.
 */
export interface DetectorSets {
  readonly low: DetectorSet;
  readonly medium: DetectorSet;
  readonly high: DetectorSet;
}

// ---------------------------------------------------------------------------
// Groundedness — implemented once, consumed twice
// ---------------------------------------------------------------------------

export type GroundednessId = string & { readonly __brand: "GroundednessId" };

/** One assertion taken from an output, with where it sits in that output. */
export interface Claim {
  readonly id: string;
  readonly text: string;
  readonly at: FindingSite;
}

/**
 * Note `sources: NonEmpty<Source>`. "We could not check" is handled *before*
 * this interface and cannot be passed into it, so no implementation of
 * `Groundedness` has to decide what an empty source set means — and none of
 * them can decide it means "pass".
 */
export interface GroundednessSubject {
  readonly claims: NonEmpty<Claim>;
  readonly sources: NonEmpty<Source>;
  /**
   * The whole budget for scoring these claims, in microseconds.
   *
   * Required, and it is here because it was missing: `judgeGroundedness` issued
   * one sequential model call per claim and handed every one of them
   * `budgetMicros: 0`, so a screening could accrue up to `maxClaims` uncancelled
   * model calls behind a race it was losing. A `Groundedness` with no budget
   * parameter is a seam that cannot honour a bound, whatever the caller writes
   * in `Limits`.
   *
   * An implementation that makes n calls divides this by n rather than passing
   * it whole to each. `evals` supplies its own value like any other caller.
   */
  readonly budgetMicros: number;
}

export type ClaimSupport =
  | {
      readonly claim: string;
      readonly supportedBasisPoints: number;
      readonly by: NonEmpty<SourceId>;
    }
  | {
      readonly claim: string;
      readonly supportedBasisPoints: 0;
      readonly searchedAndFoundNone: { readonly searched: string };
    };

export interface GroundednessScore {
  /** 0..10000. The weakest claim, not the mean — see `overlapGroundedness`. */
  readonly supportedBasisPoints: number;
  readonly claims: NonEmpty<ClaimSupport>;
  readonly costTenthCents: number;
  readonly modelCalls: number;
  /** Tokens and price table, where the implementation made model calls. */
  readonly spend?: DetectorSpend;
}

/**
 * Groundedness — comparing an output against reference material — is the same
 * shape as an `evals` `Scorer`, so it is implemented **once**, here, and shaped
 * so `evals` can consume it directly.
 *
 * This module does not import `evals` and never will: the dependency runs
 * `evals` → `guardrails`. What makes the shape reusable is that `score` is a
 * pure function of `(claims, sources)` with an integer result — it takes no
 * correlation identifier, no recorder and no tier, because a scorer has none of
 * those and a guardrail can supply them from outside.
 */
export interface Groundedness {
  readonly id: GroundednessId;
  readonly costClass: DetectorCostClass;
  score(subject: GroundednessSubject): Promise<GroundednessScore> | GroundednessScore;
}

/**
 * A classifier the composition root injects. The module never constructs one,
 * which is what makes a test structurally unable to reach a live model even
 * with real credentials in the environment.
 *
 * Deliberately read-only in shape: one verb, returning data. There is no write,
 * no tool call and no callback, so a classifier is not a route to an effect.
 *
 * ## Not a seam — a port, and the count is stated rather than fudged
 *
 * C5 says one adapter is a hypothetical seam and two is a real one.
 * `Classifier` has **zero** shipped adapters and will keep zero. It is the
 * model-client injection point C3 forces: this package may not construct or
 * import a model client, so the client arrives as a parameter. There is one
 * shape, no behaviour variation is wanted, and no second adapter is named
 * because none is intended — shipping one would mean taking a model-SDK
 * dependency that nineteen applications inherit, which `CLAUDE.md` requires an
 * ADR for and C3 forbids anyway. This is the same accounting `audit` gives its
 * `SqlExecutor`.
 *
 * Counted straight, this module has **two real seams** — `Detector` and
 * `Groundedness`, two shipped adapters each — one injected dependency pair that
 * is not a seam (`Clock`, `Timer`), and this one port.
 */
export interface Classifier {
  readonly model: string;
  readonly promptVersion: string;
  classify(request: ClassifierRequest): Promise<ClassifierResponse>;
}

export interface ClassifierRequest {
  readonly labels: NonEmpty<string>;
  /**
   * The text to classify, bounded by `Limits`.
   *
   * **What a classifier is actually shown, exactly.** Detectors run in two
   * rounds and a `model`-class detector runs in the second, over the text as it
   * stands *after* the deterministic round's redaction. So a classifier reached
   * through `modelDetector` or `judgeGroundedness` sees personal data that the
   * deterministic detectors in the same set found, masked — and personal data
   * they did not find, in full. The strength of that guarantee is exactly the
   * strength of the deterministic pack wired in beside it, and a set with no
   * deterministic detector hands over the caller's original text.
   */
  readonly text: string;
  /**
   * A bound this call must honour. Divided from the detector's budget across
   * the calls the adapter intends to make, so "pass the budget down" is what the
   * shipped adapters do rather than what they are asked to do.
   */
  readonly budgetMicros: number;
}

export interface ClassifierResponse {
  /** Basis points per label, 0..10000. Integers only. */
  readonly scores: { readonly [label: string]: number };
  readonly costTenthCents: number;
  /**
   * Tokens and the table that priced them. Required, not optional: a model call
   * that cannot say what it consumed leaves a cost figure nobody can reconstruct
   * in 2033, which is C2's stated reason for naming all four of cost, tokens,
   * latency and price-table version.
   */
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly priceTableVersion: string;
}

// ---------------------------------------------------------------------------
// The recommendation
// ---------------------------------------------------------------------------

/**
 * Why a screening recommends what it does. Every recommendation that is not
 * `allow` names at least one ground, so "the guardrails blocked it" is never an
 * assertion without evidence behind it.
 */
export type Ground =
  | {
      readonly ground: "detector-unavailable";
      readonly detector: DetectorId;
      readonly reason: DetectorUnavailableReason;
      readonly detail: string;
    }
  | { readonly ground: "sources-missing"; readonly why: string }
  | {
      readonly ground: "finding";
      readonly detector: DetectorId;
      readonly rule: string;
      readonly category: FindingCategory;
      readonly severity: Extract<Severity, "escalate" | "block">;
    };

/**
 * What this module recommends. **A recommendation, not a verdict.** The decision
 * records the abstention; this says what the evidence supports.
 *
 * The strictness ladder, in order, strictest last:
 *
 *   allow < redact-and-allow < escalate < abstain
 *
 * `abstain` outranks `escalate` because "we could not judge" is a stronger
 * statement than "a human should hold this": a system that cannot conclude has
 * nothing for the human to check. The ladder summarises; `findings` is complete
 * either way, so nothing is lost by taking a maximum.
 */
export type RecommendedDisposition =
  | { readonly recommend: "allow" }
  | { readonly recommend: "redact-and-allow"; readonly maskedSites: number }
  | { readonly recommend: "escalate"; readonly grounds: NonEmpty<Ground> }
  | { readonly recommend: "abstain"; readonly grounds: NonEmpty<Ground> };

// ---------------------------------------------------------------------------
// The screening
// ---------------------------------------------------------------------------

/** What one detector did, recorded as its own node under the screening. */
export interface DetectorRun {
  readonly detector: DetectorId;
  readonly costClass: DetectorCostClass;
  readonly node: NodeId;
  readonly outcome: "found" | "searched-and-found-none" | "unavailable";
  readonly findings: number;
  readonly costTenthCents: number;
  /**
   * `false` where the detector could not say what it spent — it threw, or it
   * never answered. `costTenthCents` is then 0 and means *unknown*, which is a
   * different fact from *free* and used to be written as the same one.
   */
  readonly costMeasured: boolean;
  readonly latencyMicros: number;
  readonly modelCalls: number;
  /** Tokens and price table, where the detector reported them. */
  readonly spend?: DetectorSpend;
}

export interface ScreeningCost {
  readonly costTenthCents: number;
  readonly latencyMicros: number;
  readonly modelCalls: number;
  /** How many detectors could not say what they spent. See `DetectorRun`. */
  readonly unmeasuredDetectors: number;
}

/** Which classes of detector completed a search over this payload. */
export type CoverageDepth =
  | "none"
  | "deterministic"
  | "model"
  | "deterministic-and-model";

/**
 * How much of the payload was actually looked at, and how much of it went into
 * the trace unexamined.
 *
 * ## The question this answers, and the one it refuses to
 *
 * Redaction masks **detected sites**. Text no detector flagged is recorded
 * verbatim, bounded only by `maxRecordedFieldChars` — which means a screening
 * that found nothing and a screening that had nothing to find produce the same
 * `Screening.payload` and the same `recommend: "allow"`. A caller could not tell
 * *"we looked, and masked three items"* from *"we found nothing and wrote all
 * 4,812 characters of a free-text narrative into a seven-year archive"*. Those
 * are different risks and they now have different numbers.
 *
 * **It is coverage, not confidence, and the name is deliberate.**
 * `docs/CONTEXT.md` binds *confidence* to a verdict — the system's estimate of
 * how likely its own conclusion is to be wrong — and this module produces no
 * verdict. More to the point, nothing here can estimate the probability that a
 * name, an address or a diagnosis went unrecognised: that depends on text nobody
 * has read. A single number claiming to be "redaction confidence" would be the
 * most dangerous field in the trace, because it would be believed. So what is
 * reported is what is actually observable — how much text was examined, by what
 * class of detector, how much was masked, how much was written down anyway —
 * and the inference is left to the reader, who has the payload.
 *
 * Every figure is an integer, and `rule` names the arithmetic so a 2033 reader
 * can reproduce it without this file.
 */
export interface ScreeningCoverage {
  /** Names the arithmetic below, so a change to it is a new name, not a drift. */
  readonly rule: string;
  /** Code units of caller text a completing detector examined. */
  readonly examinedCodeUnits: number;
  /** Code units of caller text in the payload, examined or not. */
  readonly totalCodeUnits: number;
  /** `examinedCodeUnits` over `totalCodeUnits`, in basis points, floored. */
  readonly examinedBasisPoints: number;
  /**
   * Fields **no** completing detector examined. Names only — a field name is a
   * caller's key, never its content.
   */
  readonly unexaminedFields: readonly string[];
  readonly maskedSites: number;
  /** Code units of the original text replaced by `MASK`. */
  readonly maskedCodeUnits: number;
  /**
   * Code units of caller text this screening wrote into the trace verbatim,
   * after masking and after truncation to `maxRecordedFieldChars`.
   *
   * The headline risk number. Zero masked sites and a large figure here is the
   * "we found nothing and wrote it all down" case, and it is now a number rather
   * than an inference somebody has to make.
   *
   * Counted by subtracting each `MASK` marker from the recorded text, so a
   * payload whose own words include the literal string `[redacted]` is
   * undercounted by ten code units per occurrence. That is the one inaccuracy in
   * this figure and it errs downward, which is the wrong direction — it is named
   * rather than corrected because correcting it needs a marker that cannot occur
   * in caller text, and a marker that is not byte-stable across seven years is a
   * worse trade than an occasional ten.
   */
  readonly verbatimCodeUnitsRecorded: number;
  readonly depth: CoverageDepth;
  /** Detectors that completed a search, by class. */
  readonly deterministicDetectors: number;
  readonly modelDetectors: number;
  /** Detectors that could not search at all. Their coverage is nil, not partial. */
  readonly unavailableDetectors: number;
  /** What the completing detectors declared they cover — and do not. */
  readonly declared: DeclaredCoverage;
}

declare const SCREENING: unique symbol;

/**
 * One recorded screening.
 *
 * Unconstructible outside this module — the brand is a non-exported `unique
 * symbol`. That is what makes `checkOutput`'s ordering constraint structural
 * rather than documentary: `checkOutput` requires the `Screening` that
 * `screenInput` returned, and there is no other way to obtain one.
 *
 * `nodes.settled` is not decoration. A `Screening` exists only after its nodes
 * are in the trace, so holding one is evidence that the screening was recorded;
 * and `payload` — the redacted form, the only form this module lets out — is
 * reachable only through a `Screening`. A caller who wants the screened payload
 * has already caused the nodes to be written.
 */
export interface Screening {
  readonly [SCREENING]: true;
  /**
   * The settled node itself, not merely its identifier, so `checkOutput` can
   * parent to it without replaying the case. Behind a symbol this module does
   * not export — see `lib/mint.ts`.
   */
  readonly [SETTLED_NODE]: import("../../audit/index.js").RecordedNode;
  readonly correlationId: CorrelationId;
  readonly phase: ScreeningPhase;
  readonly tier: RiskTier;
  readonly locale: Locale;
  readonly detectorSet: DetectorSetId;
  readonly at: Instant;
  readonly nodes: { readonly opened: NodeId; readonly settled: NodeId };
  readonly detectors: NonEmpty<DetectorRun>;
  readonly findings: Findings;
  readonly recommended: RecommendedDisposition;
  readonly cost: ScreeningCost;
  /**
   * How much was looked at, by what, and how much went into the trace anyway.
   *
   * This is what makes the residual risk below **visible** rather than merely
   * documented: `maskedSites: 0` beside `verbatimCodeUnitsRecorded: 4812` is a
   * different sentence from `maskedSites: 3`, and until this field existed they
   * produced identical screenings. See `ScreeningCoverage` — and note it is
   * coverage, not confidence.
   */
  readonly coverage: ScreeningCoverage;
  /**
   * Redacted at every **detected** site: no site any detector reported reaches
   * a store, here or anywhere, and there is no un-writing.
   *
   * The weaker half of that sentence is the one that matters operationally.
   * Text no detector flagged is recorded verbatim, bounded by
   * `maxRecordedFieldChars`, so a free-text narrative carrying a name, an
   * address or a diagnosis in a shape no pattern matched lands in the trace in
   * full. Three things shrink that residue and none of them is this module
   * asserting it away: a model-class detector on the same field, `audit`'s
   * deny-by-default `redactAllExcept` on the trace itself wired with
   * `GUARDRAILS_TRACE_FIELDS`, and — since neither is free — reading `coverage`
   * and deciding which fields are worth either.
   */
  readonly payload: ScreenedPayload;
}

// ---------------------------------------------------------------------------
// Entry-point requests
// ---------------------------------------------------------------------------

export interface InputScreeningRequest {
  readonly correlationId: CorrelationId;
  readonly tier: RiskTier;
  readonly payload: Payload;
  /**
   * The node this screening hangs under. Parentage is recorded, never inferred:
   * a case's execution is a directed acyclic graph, not a list.
   *
   * Re-screening after a redaction is not a hidden retry — the caller passes the
   * previous `Screening` here, and the second attempt is a visible node with a
   * recorded parent. This module performs no retries of its own.
   *
   * **Pass the `Screening` where you have one.** `audit.record` needs a parent
   * as a recorded node, not as an identifier, so a bare `NodeId` this process
   * did not mint costs one replay of the case to resolve — bounded by the case's
   * own node count and paid once per screening. A `Screening` carries its
   * settled node with it and costs nothing. A `NodeId` that names no node in
   * this case raises `ScreeningParentUnknown`; it is never written as a root,
   * because a screening silently detached from the graph is worse than a refused
   * one.
   */
  readonly under?: NodeId | Screening;
}

export interface OutputCheckRequest {
  /**
   * The input screening this output follows. Required, and the reason ordering
   * is structural: `screenInput` strictly before the decision, `checkOutput`
   * strictly after it. There is no way to check an output that was never
   * preceded by a screened input.
   */
  readonly after: Screening;
  /**
   * The tier of *this* decision-and-effect. Supplied rather than inherited from
   * `after`, because tier attaches to a decision-and-its-effect and a case has a
   * tier profile: reading an invoice is low risk, paying it is high risk.
   */
  readonly tier: RiskTier;
  readonly output: Payload;
  readonly sources: Sources;
}

// ---------------------------------------------------------------------------
// Bounds and dependencies
// ---------------------------------------------------------------------------

/** No unbounded anything. Every one of these is required; see `DEFAULT_LIMITS`. */
export interface Limits {
  /** Detectors run concurrently, up to this many at once. */
  readonly detectorConcurrency: number;
  /** A detector that has not answered within this is unavailable. */
  readonly detectorBudgetMicros: number;
  /** A payload with more fields than this is refused, not truncated. */
  readonly maxFields: number;
  /** A field longer than this is refused, not truncated. */
  readonly maxFieldChars: number;
  /** How much of a redacted field reaches the trace. The rest is a digest. */
  readonly maxRecordedFieldChars: number;
  /** A screening never reports more findings than this. */
  readonly maxFindingsPerScreening: number;
  /** Groundedness never compares more claims than this. */
  readonly maxClaims: number;
  /** Groundedness never reads more sources than this. */
  readonly maxSources: number;
}

/**
 * Everything `guardrails` needs, all injected. The module constructs no model
 * client, no clock, no timer and no store — which is what makes a test
 * structurally unable to reach a live model even with real credentials present.
 *
 * `clock` and `timer` are **injected, not seamed**. Injection is a hermeticism
 * requirement; a seam is a place behaviour genuinely varies with a second
 * shipped adapter. Counting a fake clock as an adapter would let anyone call
 * any injected dependency a seam, and then the seam rule stops meaning anything.
 */
export interface GuardrailsDeps {
  /** Where every screening node is written. */
  readonly audit: import("../../audit/index.js").Audit;
  readonly clock: Clock;
  readonly timer: Timer;
  /** Required. No default — see `Locale`. */
  readonly locale: Locale;
  /** Required. No default. Tier selects the set. */
  readonly detectorSets: DetectorSets;
  readonly limits: Limits;
  /**
   * The eighth silent condition: **the fail-closed screening rate moving
   * sharply**.
   *
   * `docs/CONTEXT.md`: *"every individual case behaved exactly as designed."*
   * There is no case to look at. A classifier that starts timing out at noon
   * produces two hundred screenings that each fail closed correctly, recommend
   * `abstain` correctly and write a correct node — and together mean this
   * deployment has stopped making decisions with nobody told. It is the one
   * condition here that is a property of a window rather than of a payload.
   *
   * **Wired as one object or not at all.** A window with nowhere to raise is a
   * counter nobody reads, and a sink with no window terms cannot judge a
   * movement. Half-wiring the two would produce something that *looks*
   * monitored, which is worse than being visibly unmonitored — so the two cannot
   * be separated in the type.
   *
   * Optional, and its absence is not disguised. Nothing degrades: screening
   * behaves identically, and no rate is watched. See `lib/rate-watch.ts` for
   * what "fail-closed" means exactly, why the window is keyed by phase and tier,
   * and why the first two windows of a process's life raise nothing.
   */
  readonly rateAlerting?: import("./rate-watch.js").RateAlerting | undefined;
}

/**
 * Two entry points, and deliberately no third.
 *
 * There is no `redact`, no `runDetector` and no `groundedness` verb here. A
 * detector cannot be run except through a screening, and a screening cannot
 * happen without its nodes being written first. That absence is the
 * auditability mechanism, not an omission.
 */
export interface Guardrails {
  /** Strictly before the decision. */
  screenInput(request: InputScreeningRequest): Promise<Screening>;
  /**
   * Strictly after the decision and strictly before any effect. A groundedness
   * check that runs after an effect is theatre.
   */
  checkOutput(request: OutputCheckRequest): Promise<Screening>;
}
