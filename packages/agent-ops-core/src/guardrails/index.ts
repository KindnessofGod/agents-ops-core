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
 *   Budget.        The detector budget bounds the **answer**, not the work, and
 *                  the difference is load-bearing. A detector that overran is
 *                  recorded `unavailable/timed-out` against the injected clock
 *                  however it got there, so the screening fails closed
 *                  deterministically. But losing a race cancels nothing, and a
 *                  **synchronous** detector cannot be raced at all — a
 *                  catastrophically backtracking regular expression in a
 *                  caller-supplied pattern pack is an unbounded event-loop stall
 *                  that no in-process timer can preempt. See `lib/detectors.ts`.
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
 * ## The residual risk, because it is a conversation and not a footnote
 *
 * Redaction masks **detected sites**. A free-text narrative carrying a name, an
 * address or a diagnosis in a shape no pattern matched is recorded in full,
 * bounded by `maxRecordedFieldChars` — and the digest beside the truncation is
 * brute-forceable for a low-entropy value, so it is not a redaction of the tail
 * either. Two things shrink the residue and both are the caller's to wire:
 *
 *   - a model-class detector on the same field, which is what the tiered
 *     detector sets exist for; and
 *   - `audit`'s deny-by-default `redactAllExcept`, wired with
 *     `GUARDRAILS_TRACE_FIELDS` so this module's integers survive as evidence
 *     while the payload text does not. Applied *without* that list it replaces
 *     every integer on every guardrails node with the string `"[redacted]"`,
 *     which destroys the trace it was meant to protect.
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
 *     different bodies: `deterministicDetector` (patterns, synchronous, no I/O)
 *     and `modelDetector` (a classifier behind an injected port).
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
 * Shipped personal-data pattern packs, one per market. This is the deletion
 * test for the module: nineteen applications each writing their own patterns is
 * nineteen chances at a notifiable incident, and a subtly wrong pattern does not
 * present as a bug — it finds nothing, which reads exactly like a clean payload.
 */
export { personalDataDetector, SHIPPED_LOCALES } from "./lib/patterns.js";

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
  DetectorReportInvalid,
  DetectorSetEmpty,
  LimitsInvalid,
  LocaleNotJurisdictional,
  LocaleUnsupported,
  OutputCheckOutOfOrder,
  ScreeningLimitExceeded,
  ScreeningNotRecorded,
  ScreeningParentUnknown,
  ScreeningPayloadInvalid,
} from "./lib/errors.js";
