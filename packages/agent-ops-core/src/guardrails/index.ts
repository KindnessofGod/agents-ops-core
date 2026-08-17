/**
 * guardrails — screening before a decision, and checking before an effect.
 *
 * Two entry points, and deliberately no third:
 *
 *   screenInput   Strictly **before** the decision.
 *   checkOutput   Strictly **after** the decision and strictly **before** any
 *                 effect. A groundedness check that runs after an effect is
 *                 theatre.
 *
 * There is no `redact`, no `runDetector` and no `score` verb here. A detector
 * cannot be run except through a screening, and a screening cannot happen
 * without its nodes being written first. That absence is the auditability
 * mechanism, not an omission.
 *
 * ## What this module does not do
 *
 * **Guardrails do not abstain.** Per `docs/CONTEXT.md` an abstention is a
 * *verdict disposition* — the system declining to conclude — and a verdict is
 * the content of a decision. This module produces **findings** and a
 * **recommended disposition**; the decision records the abstention. If
 * guardrails could abstain directly there would be two places in the codebase
 * producing verdicts, and the trace would carry entries with no decision behind
 * them.
 *
 * ## Invariants a caller must know
 *
 *   Fail-closed.   A detector that errors, times out or declares itself
 *                  unavailable yields **abstain-recommended, never allow** — at
 *                  every tier, with no configuration key that changes it. This
 *                  is deliberately the **opposite** of `audit`'s tiered fail
 *                  policy, where a low- or medium-tier decision may be
 *                  configured to proceed without a trace. The two modules are
 *                  failing at different things: an unrecordable decision is a
 *                  gap in the evidence about work that was nonetheless done, and
 *                  its cost genuinely differs between a ticket routing and a £2M
 *                  disbursement; an unscreened payload is a gap in the work
 *                  itself, and there is no tier at which "we did not check, so
 *                  we allowed it" is defensible. Both modules state the
 *                  asymmetry, because a reader who learns one will assume the
 *                  other.
 *   Sources.       `Sources` has no empty-array branch. A caller with no
 *                  reference material says so in words, and the screening
 *                  recommends abstain. Cannot check is never pass.
 *   Redaction.     Irreversible within the trace. Detectors report
 *                  **coordinates**, never matched text; this module does the
 *                  masking; the masked form is what is recorded and what a
 *                  caller receives. There is no un-writing. **The claim is about
 *                  detected sites**: no site any detector reported reaches a
 *                  store, and text no detector flagged is recorded verbatim,
 *                  bounded by `maxRecordedFieldChars`. See "The residual risk"
 *                  below — it is a conversation nineteen regulated teams need to
 *                  have, not a footnote.
 *   Locale.        Required configuration, no default and no fallback. A region
 *                  subtag is mandatory, because `en` is a language and `en-GB`
 *                  is a jurisdiction. A detector wired into a market it does not
 *                  declare fails at construction, not by finding nothing.
 *   Tier.          Selects the detector set, and that is the whole of the tier
 *                  policy here. A model-based detector roughly doubles decision
 *                  latency and cost, so low-tier throughput dies without a
 *                  cheap-only set.
 *   Purity.        No detector may produce an effect. It receives deep-frozen
 *                  copies of **both** the payload and the sources, and no
 *                  client, no store, no recorder and no clock; the module works
 *                  from its own copy regardless; its entire influence on the run
 *                  is the `DetectorReport` it returns. A detector cannot rewrite
 *                  the reference material a sibling detector is judged against,
 *                  and cannot mutate the caller's own objects.
 *   Absence.       "Nothing found" is an assertion about a search performed —
 *                  `searchedAndFoundNone: { searched }` — never an empty array.
 *                  When no detector completed a search, `couldNotSearch` says so
 *                  instead, because claiming a search nobody ran is worse than
 *                  admitting none happened.
 *   Rate watch.    The eighth silent condition — **the fail-closed screening
 *                  rate moving sharply** — is the only one this module can see,
 *                  and it is a property of a window rather than of a payload:
 *                  *"every individual case behaved exactly as designed."* Wired
 *                  through `GuardrailsDeps.rateAlerting`, as one object with its
 *                  raiser so a window with nowhere to raise cannot be built.
 *                  Deliberately **not** written as a node: a movement over a
 *                  population is not a fact about whichever case happened to
 *                  close the window. See `lib/rate-watch.ts`.
 *   Integers.      Cost in tenth-cents, latency in microseconds, confidence and
 *                  support in basis points. No IEEE-754 in any payload.
 *   Clock.         Injected. No `Date.now()` in this module, ever. So is the
 *                  timer that bounds a detector's budget.
 *   Bounds.        Bounded fan-out, bounded payload, bounded finding list,
 *                  bounded budget per detector — and **no retries at all**. A
 *                  caller who wants a second attempt re-screens with the first
 *                  `Screening` as `under`, so the retry is a visible node with a
 *                  recorded parent rather than a hidden one. Every `Limits`
 *                  field is range-checked at construction, because
 *                  `maxFindingsPerScreening: 0` used to turn a `block` into an
 *                  `allow`.
 *   Budget.        The detector budget bounds the answer deterministically — a
 *                  detector that overran is recorded `unavailable/timed-out`
 *                  against the injected clock however it got there, so the
 *                  screening fails closed. It now also bounds the **work**, on
 *                  two further axes: `Detector.screen` must return a promise, so
 *                  the race is scheduled rather than deferred; and every
 *                  detector is handed a `deadline` — a one-bit oracle over the
 *                  same injected clock, never a clock — which both shipped
 *                  adapters check between units of work. See "The synchronous
 *                  detector, closed and re-measured" below for what is left.
 *   Patterns.      A `Pattern` cannot be constructed from a regular expression
 *                  capable of exponential backtracking. `safePattern` is the
 *                  only mint, the brand is a non-exported `unique symbol`, and
 *                  `deterministicDetector` re-checks so a cast is refused too.
 *                  `PatternUnsafe` is a boot failure, never a screening-time
 *                  one. There is deliberately no override.
 *   Coverage.      Every screening reports how much of the payload a completing
 *                  detector actually examined, how much text went into the trace
 *                  unmasked, and what the detectors that ran declare they do and
 *                  do not cover. It is **coverage, not confidence** — see
 *                  `ScreeningCoverage`.
 *   Telemetry.     Cost, tokens, latency and the price-table version on every
 *                  node that measured a model call, as `audit`'s typed
 *                  `NodeTelemetry` rather than as free-form payload keys. Where
 *                  a detector could not say what it spent — it threw, or never
 *                  answered — the node records `costMeasured: false` rather than
 *                  a zero indistinguishable from free.
 *
 * ## How an unrecorded screening is made unrepresentable
 *
 * The opened node is written **before any detector runs**, and the write is then
 * **proven by replay** before any detector runs either; each detector's own node
 * is written as it completes; the redacted payload, the settled node and one
 * node per finding follow. Only then is a `Screening` minted, and its brand is a
 * non-exported `unique symbol`. The redacted `ScreenedPayload` — the only form
 * of the payload this module lets out — is reachable only through a `Screening`.
 * A caller that wants the screened payload has therefore already caused every
 * node to be written, and had the witness that wrote them corroborated.
 *
 * ## Where that guarantee stops, stated rather than implied
 *
 * Three limits, and the third is the one that voids the guarantee if it is not
 * held in mind.
 *
 * 1. The caller still holds the original string it passed in, and no type in
 *    this package reaches outside this package: application code can send that
 *    original to a model without screening it at all.
 * 2. Nothing here can see effects, so "before any effect" is enforced only as
 *    far as `checkOutput` requiring an **input** `Screening` — the effect side
 *    of the ordering belongs to `approval`.
 * 3. **The recording witness is caller-supplied and unbranded.**
 *    `GuardrailsDeps.audit` names `Audit`, a structural interface: a fully-typed
 *    object that acknowledges every write and persists nothing satisfies it, and
 *    a caller holding one used to receive a real branded `Screening` over zero
 *    persisted bytes. `docs/design/OPEN-ITEMS-RESOLVED.md` §1 resolved exactly
 *    this by branding the recorder with a symbol only `audit`'s own constructors
 *    can mint — and the brand landed on `TraceStore`, one layer below this
 *    module, and on `Screening`, one layer above, but not on `Audit`.
 *
 *    What this module does about it, since the brand is `audit`'s to mint:
 *    every acknowledgement is checked against what was asked for, and the first
 *    node of each case is **proven by replay** before any detector runs —
 *    `audit`'s own doctrine that replay is the proof of a write. A two-line
 *    impostor fails. A witness that maintains a coherent in-memory trace and
 *    writes no bytes still passes, exactly as `audit` says of its own store
 *    contract check, so the scope is stamped onto every opened node as
 *    `capturedVia: "caller-supplied-audit-witness"` rather than asserted here.
 *    **A brand on `Audit` is reported upward as the real fix.**
 *
 * The honest claim is *unrepresentable through `guardrails`, against a witness
 * that persists*, not *unrepresentable*.
 *
 * ## The synchronous detector, closed and re-measured
 *
 * This module's frankest residual was that a synchronous detector's work could
 * not be bounded: `screen` could return a value rather than a promise, a
 * synchronous body never yields, and no in-process timer could preempt a
 * catastrophically backtracking regular expression over a 32,768-character
 * field. It was an unbounded event-loop stall on the hot path of every decision,
 * twice. It is closed structurally, on three axes, and the honest accounting of
 * each is worth more than the headline:
 *
 *   1. **`Pattern` is unforgeable and analysed.** `safePattern` refuses
 *      backreferences, `(a+)+`-shaped nesting, alternations under an unbounded
 *      quantifier, and repetition products past a bound — at construction, with
 *      no escape hatch. This is what removes *exponential* blowup, and it is the
 *      one that actually matters. Both shipped market packs pass unchanged.
 *   2. **`screen` must return a promise.** This is a precondition, not a bound:
 *      an `async` body that never awaits blocks exactly as a synchronous one
 *      did. It buys the race a chance to be scheduled and it buys the interface
 *      an honest signal to its implementor. Saying more than that would be the
 *      comfortable sentence rather than the true one.
 *   3. **A `deadline` is handed to every detector** — one bit, over the engine's
 *      injected clock, never a clock — and both shipped adapters check it
 *      between patterns, between fields and between classifier calls. This is
 *      what bounds the aggregate: a pack of twelve patterns over sixty-four
 *      fields cannot compound one slow scan into a slow screening.
 *
 * **What remains possible.** An accepted pattern can still be polynomial, so one
 * (pattern, field) scan can cost on the order of `maxFieldChars²` character
 * comparisons — roughly a second of one core at the default — and nothing in
 * this runtime can preempt it. That is a stall, it is bounded, and the bound is
 * computable from `Limits`. A caller-supplied detector that neither awaits nor
 * reads its deadline is bounded by nothing this module can offer; its *answer*
 * is still refused on time. True preemption needs a worker thread, and
 * `lib/safe-pattern.ts` states why serialising an unredacted payload into a
 * second heap is the wrong trade for closing a bounded stall.
 *
 * ## The residual risk, because it is a conversation and not a footnote
 *
 * Redaction masks **detected sites**. A free-text narrative carrying a name, an
 * address or a diagnosis in a shape no pattern matched is recorded in full,
 * bounded by `maxRecordedFieldChars` — and the digest beside the truncation is
 * brute-forceable for a low-entropy value, so it is not a redaction of the tail
 * either. That is inherent to detection-based redaction and this module does not
 * claim to have closed it. What it now does is **make it visible**:
 * `Screening.coverage` reports how much text a completing detector examined, how
 * many code units were masked, and how many went into the trace verbatim — so
 * "we found and masked three items" and "we found nothing and wrote all 4,812
 * characters down" are different rows in the trace rather than the same one.
 *
 * Three things shrink the residue and all three are the caller's to wire:
 *
 *   - a model-class detector on the same field, which is what the tiered
 *     detector sets exist for;
 *   - `audit`'s deny-by-default `redactAllExcept`, wired with
 *     `GUARDRAILS_TRACE_FIELDS` so this module's integers survive as evidence
 *     while the payload text does not. Applied *without* that list it replaces
 *     every integer on every guardrails node with the string `"[redacted]"`,
 *     which destroys the trace it was meant to protect; and
 *   - reading `coverage` and deciding which fields are worth either, since
 *     neither is free.
 *
 * ## What a pack does not find, said by the pack
 *
 * A locale that silently covers less than a caller assumes is the compliance
 * incident this module exists to prevent, and it is invisible by construction:
 * an unmatched street address produces a clean screening and a green dashboard.
 * So every shipped pack declares what it covers, what it covers **partially**
 * with the caveat, and what it does **not** cover with the reason — and the
 * covered list is *derived from the patterns*, so a declaration cannot drift
 * from the pack. `localeCoverage(locale)` answers the question before anything
 * is wired; `Screening.coverage.declared` answers it on every screening, over
 * the detectors that actually completed.
 *
 * ## Groundedness is implemented once
 *
 * Comparing an output against reference material is the same shape as an
 * `evals` `Scorer`, so it lives here, once, behind the `Groundedness` interface
 * — a pure function of `(claims, sources, budget)` with an integer result,
 * taking no correlation identifier, no recorder and no tier. `evals` consumes it
 * as a scorer; `guardrails` wraps it as a detector. This module does not import
 * `evals` and never will: the dependency runs `evals` → `guardrails`.
 *
 * ## Seam accounting, honestly
 *
 * C5: one adapter is a hypothetical seam, two is a real one. Counted straight,
 * including where the count is zero:
 *
 *   - **`Detector` — a real seam.** Two shipped adapters with genuinely
 *     different bodies: `deterministicDetector` (patterns, no I/O) and
 *     `modelDetector` (a classifier behind an injected port).
 *
 *     `personalDataDetector` and `promptInjectionDetector` are **not** a third
 *     and fourth adapter, and counting them would be exactly the fudge C5
 *     forbids: both are pattern packs configured into `deterministicDetector`,
 *     sharing its body entirely. They are shipped content behind an adapter, and
 *     the deletion test for them is different — delete them and nineteen
 *     applications write their own personal-data and injection patterns, which
 *     is nineteen chances at an incident that presents as a clean payload.
 *   - **`Groundedness` — a real seam.** Two shipped adapters:
 *     `overlapGroundedness` (deterministic token overlap) and
 *     `judgeGroundedness` (a model judging each claim). `evals` consumes either
 *     as a scorer; `guardrails` wraps either as a detector.
 *   - **`Clock` and `Timer` — injected, not seamed.** `systemTimer` is the only
 *     shipped timer and the test clock and timer live in `tests/` and are not
 *     deliverables. Injection is a hermeticism requirement; counting a fake
 *     clock as an adapter would let anyone call any injected dependency a seam.
 *   - **`Classifier` — a port with zero adapters, and it stays at zero.** It is
 *     the model-client injection point C3 forces: this package may not construct
 *     or import a model client, so one arrives as a parameter. No second adapter
 *     is named because none is intended — shipping one means a model-SDK
 *     dependency nineteen applications inherit. Same accounting as `audit`'s
 *     `SqlExecutor`.
 *   - **`Audit` — not a seam of this module's, and the thing that most needs a
 *     brand.** See "Where that guarantee stops" above.
 *
 * See `docs/CONTEXT.md` for the vocabulary and
 * `docs/design/PHASE-2-INTERFACE-REVIEW.md` §4 for the narrowing this
 * implements.
 */

export type { Audit, CorrelationId, NodeId, RiskTier } from "../audit/index.js";

export type { Timer, TimerHandle } from "./lib/timer.js";
export { systemTimer } from "./lib/timer.js";

export type {
  Claim,
  ClaimSupport,
  Classifier,
  ClassifierRequest,
  ClassifierResponse,
  Clock,
  CoverageDepth,
  Deadline,
  Detector,
  DetectorCostClass,
  DetectorId,
  DetectorReport,
  DetectorRun,
  DetectorSpend,
  DetectorSet,
  DetectorSetId,
  DetectorSets,
  DetectorUnavailableReason,
  Finding,
  FindingCategory,
  FindingDraft,
  FindingSite,
  Findings,
  Ground,
  Groundedness,
  GroundednessId,
  GroundednessScore,
  GroundednessSubject,
  Guardrails,
  GuardrailsDeps,
  InputScreeningRequest,
  Instant,
  Limits,
  Locale,
  NonEmpty,
  OutputCheckRequest,
  Payload,
  RecommendedDisposition,
  Screening,
  ScreenedPayload,
  ScreeningCost,
  ScreeningCoverage,
  ScreeningPhase,
  ScreeningSubject,
  Severity,
  Source,
  SourceId,
  Sources,
} from "./lib/types.js";

export { MASK } from "./lib/types.js";

export { createGuardrails } from "./lib/guardrails.js";
export { localeOf } from "./lib/locale.js";
export { DEFAULT_LIMITS } from "./lib/limits.js";

/** Detector adapters. Two, which is what makes `Detector` a real seam. */
export { deterministicDetector, modelDetector } from "./lib/detectors.js";
export type {
  DeterministicDetectorSpec,
  ModelDetectorSpec,
  Pattern,
} from "./lib/detectors.js";

/**
 * The only mint for a `Pattern`, and the reason a runaway regular expression is
 * unrepresentable in a pack rather than merely discouraged. See
 * `lib/safe-pattern.ts` for the refused shapes, why the analyser is deliberately
 * conservative, and why there is no override.
 */
export { safePattern } from "./lib/safe-pattern.js";
export type { PatternSpec } from "./lib/safe-pattern.js";

/**
 * The coverage vocabulary: what a detector says it finds, what it finds
 * incompletely, and what it does not find at all. The third list is the one that
 * prevents the incident, because a missing rule is invisible in a trace unless
 * somebody wrote it down.
 */
export type {
  CoverageCategory,
  CoverageNote,
  DeclaredCoverage,
  DetectorCoverage,
  PersonalDataCategory,
  PromptInjectionTechnique,
} from "./lib/coverage.js";

/**
 * Shipped personal-data pattern packs, one per market, each declaring its own
 * gaps. This is the deletion test for the module: nineteen applications each
 * writing their own patterns is nineteen chances at a notifiable incident, and a
 * subtly wrong pattern does not present as a bug — it finds nothing, which reads
 * exactly like a clean payload.
 *
 * `localeCoverage` is the same declaration readable *before* wiring, which is
 * when it is cheapest to discover that your market has no rule for the
 * identifier your payloads are full of.
 */
export { localeCoverage, personalDataDetector, SHIPPED_LOCALES } from "./lib/patterns.js";
export type { LocaleCoverage } from "./lib/patterns.js";

/**
 * The deterministic prompt-injection pack — the first adapter for injection
 * screening that does not require a model call, and therefore the first one the
 * cheap tier can have at all. Until it existed, low-tier decisions had **no**
 * injection screening, and the absence read exactly like a clean payload.
 *
 * It is a **floor, not a ceiling**, and `lib/injection.ts` says so at length and
 * first: paraphrase, another language, encoding, splitting across fields and
 * indirection all defeat it without effort. Wiring it and calling the problem
 * solved is worse than not wiring it, because the reassurance is the failure.
 */
export { promptInjectionDetector, SHIPPED_INJECTION_LOCALES } from "./lib/injection.js";

/**
 * Groundedness adapters. Two, which is what makes `Groundedness` a real seam:
 * deterministic token overlap, and a model judging each claim. `evals` consumes
 * either as a scorer; `guardrails` wraps either as a detector. One
 * implementation, two callers.
 */
export {
  groundednessDetector,
  judgeGroundedness,
  overlapGroundedness,
  sentenceClaims,
} from "./lib/groundedness.js";
export type { GroundednessDetectorSpec } from "./lib/groundedness.js";

/**
 * Node kinds and the payload schema version, exposed so a reader with nothing
 * but the rows — or an independent auditor in 2033 — can select this module's
 * nodes without parsing every payload in the trace.
 */
export {
  GUARDRAILS_PAYLOAD_VERSION,
  GUARDRAILS_TRACE_FIELDS,
  NODE,
} from "./lib/canonical.js";

export {
  GuardrailsError,
  AuditWitnessUnsound,
  CoverageIncoherent,
  DetectorReportInvalid,
  DetectorSetEmpty,
  LimitsInvalid,
  LocaleNotJurisdictional,
  LocaleUnsupported,
  OutputCheckOutOfOrder,
  PatternUnsafe,
  ScreeningLimitExceeded,
  ScreeningNotRecorded,
  ScreeningParentUnknown,
  ScreeningPayloadInvalid,
} from "./lib/errors.js";

/**
 * The fail-closed screening rate watch — `docs/CONTEXT.md`'s eighth silent
 * condition, and the only one this module can see.
 *
 * `isFailClosed` is exported because there must be exactly **one** definition of
 * the thing being measured. A dashboard query that recomputes "fail-closed rate"
 * from node payloads and disagrees by a hair with the rule that raises the alert
 * is how an operator learns to trust neither.
 *
 * `RateAlerting` is the terms a deployment must state — window, move, minimum
 * sample — and it is wired into `GuardrailsDeps.rateAlerting` as one object with
 * its `AlertRaiser`, so a window with nowhere to raise cannot be constructed.
 * There is no third entry point here and no verb to poll: the rate is watched as
 * a side effect of screening, and the raise goes to `alerts`, not to a return
 * value nobody would read.
 */
export { isFailClosed } from "./lib/rate-watch.js";
export type { RateAlerting } from "./lib/rate-watch.js";
