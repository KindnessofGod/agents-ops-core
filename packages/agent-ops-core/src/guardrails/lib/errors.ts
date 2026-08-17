import type { DetectorUnavailableReason } from "./types.js";

/**
 * Named error modes, each with its fail policy and the reason for it.
 *
 * ## The asymmetry with `audit`, stated here because a reader will assume it
 *
 * `audit` has a **tiered** fail policy: when the trace store is unavailable, a
 * low- or medium-tier decision may be configured to proceed without a node, and
 * only high tier is pinned closed. `guardrails` is **fail-closed at every
 * tier**, with no configuration key that changes it.
 *
 * The asymmetry is deliberate, and the reason is that the two modules are
 * failing at different things. An unrecordable decision is a gap in the
 * *evidence* about work that was nonetheless screened and judged; whether that
 * gap is tolerable genuinely depends on whether the case is a ticket routing or
 * a £2M disbursement, so the application decides. An unscreened payload is a
 * gap in the *work itself* — nobody looked for the injection, nobody looked for
 * the national insurance number — and there is no tier at which "we did not
 * check, so we allowed it" is a defensible answer. That is the exact failure
 * this module exists to prevent.
 *
 * A reader who learns one of these policies will assume the other. Both modules
 * say so in their own documentation for that reason.
 *
 * ## What is *not* here
 *
 * `DetectorUnavailable` and `SourcesMissing` are not error classes. They are
 * `Ground`s on a returned `Screening` that recommends abstain. Per
 * `CONTEXT.md`, an abstention is a **successful outcome of a working system**
 * and is not an error: an error is the system breaking, an abstention is the
 * system working correctly and saying so. Throwing for them would collapse that
 * distinction at nineteen call sites, and it would let a caller's `catch` turn
 * a deliberate refusal into a retry.
 *
 * ## Errors that reach a caller from `audit`, named here because a `catch` here
 * ## will see them
 *
 * This module writes through the injected `Audit`, and `audit`'s own error
 * modes propagate through `screenInput` and `checkOutput` unchanged. They are
 * **not** re-wrapped: re-wrapping would hide which module refused, and an
 * `AuditError` carries its own `degradable` flag that a wrapper would flatten.
 * A caller's `catch` should expect, in addition to every `GuardrailsError`
 * below:
 *
 *   `UnserialisablePayload`  A payload field this module built is not a value
 *                            `audit` can canonicalise. Fail-closed. This module
 *                            now refuses a non-string field at the entry point
 *                            (`ScreeningPayloadInvalid`) rather than letting it
 *                            reach `audit`, so what remains here is a defect in
 *                            this module, not in a caller.
 *   `PayloadTooLarge`        A node exceeded `audit`'s own byte ceiling.
 *                            Fail-closed. Reachable with a large
 *                            `maxRecordedFieldChars`.
 *   `TraceUnavailable`       The store was down and the tier policy is
 *                            fail-closed. Surfaces as `ScreeningNotRecorded`
 *                            when `audit` degrades instead of throwing.
 *   `ParentNotOfThisCase`    A parent from another case reached `audit`. This
 *                            module refuses it first — see
 *                            `ScreeningParentUnknown` — so this is defence in
 *                            depth rather than a path a caller can take.
 *   `CaseAlreadyClosed`      A screening was attempted on a sealed case.
 *                            Fail-closed; the case is terminal.
 *   `StoreContractViolated`, `TraceTampered`, `TraceIncoherent`,
 *   `TraceCorrupt`, `UnknownEnvelope`  Raised by `audit` during the replay this
 *                            module performs to prove a write or to find a
 *                            foreign parent. All fail-closed.
 */
export abstract class GuardrailsError extends Error {
  /** `true` when the condition is an incident rather than a metric movement. */
  abstract readonly incident: boolean;
}

/**
 * A locale was supplied without a region subtag, or in a shape this library
 * cannot read as a jurisdiction.
 *
 * Fail-closed, at construction. `en` is a language; `en-GB` is a jurisdiction.
 * Personal-data formats follow the jurisdiction, so a language alone would let
 * a nine-digit run be screened by whichever market's patterns happened to be
 * wired in — which is a compliance incident that presents as a quiet pass.
 */
export class LocaleNotJurisdictional extends GuardrailsError {
  override readonly name = "LocaleNotJurisdictional";
  override readonly incident = false;
  constructor(readonly tag: string) {
    super(
      `locale ${JSON.stringify(tag)} names no jurisdiction: a region subtag is required, as in "en-GB"`,
    );
  }
}

/**
 * A detector was wired into a set for a locale it does not declare support for.
 *
 * Fail-closed, at construction, **incident**. This is the compliance incident
 * the locale requirement exists to prevent, and it is caught at boot rather
 * than at screening time on purpose: a detector running against the wrong
 * market does not error, it finds nothing, and finding nothing is
 * indistinguishable from a clean payload unless somebody checks the wiring.
 */
export class LocaleUnsupported extends GuardrailsError {
  override readonly name = "LocaleUnsupported";
  override readonly incident = true;
  constructor(
    readonly detector: string,
    readonly configured: string,
    readonly supported: readonly string[],
  ) {
    super(
      `detector ${detector} supports locales [${supported.join(", ")}] and cannot screen for ${configured}`,
    );
  }
}

/**
 * A screening node could not be written to the trace.
 *
 * Fail-closed at **every** tier, and deliberately not degradable — this module
 * narrows `audit`'s tiered policy for its own writes rather than inheriting a
 * policy written for a different question. A screening that was not recorded is
 * a screening that did not happen: the caller holds no `Screening`, so it holds
 * no `ScreenedPayload`, so there is nothing for it to proceed with.
 */
export class ScreeningNotRecorded extends GuardrailsError {
  override readonly name = "ScreeningNotRecorded";
  override readonly incident = true;
  constructor(
    readonly correlationId: string,
    readonly nodeKind: string,
    readonly reason: string,
  ) {
    super(
      `guardrails could not record ${nodeKind} for case ${correlationId} (${reason}); the screening did not happen`,
    );
  }
}

/**
 * A payload exceeded a declared bound — too many fields, or a field too long.
 *
 * Fail-closed, throws. Truncating and screening the remainder would produce a
 * `Screening` that says a search was performed over text nobody searched, which
 * is worse than refusing: the caller would hold evidence of a check that did not
 * happen. Bounds exist so the hot path stays bounded; exceeding one is a defect
 * at the call site, not an outage.
 */
export class ScreeningLimitExceeded extends GuardrailsError {
  override readonly name = "ScreeningLimitExceeded";
  override readonly incident = false;
  constructor(
    readonly limit: string,
    readonly bound: number,
    readonly actual: number,
  ) {
    super(`screening limit ${limit} is ${bound}; got ${actual}`);
  }
}

/**
 * A detector returned a report this module cannot record: a non-integer cost, a
 * confidence outside 0..10000, a finding site outside its field, or an empty
 * findings list where the type promised a non-empty one.
 *
 * Fail-closed at every tier, and it does **not** become an abstention: this is a
 * defect in a detector, not an outage in one. Degrading it to abstain would let
 * a broken detector look like a cautious one, and the build would stay green
 * while a whole category stopped being screened.
 *
 * Note this catches at runtime what `NonEmpty` catches at compile time, because
 * a detector may be constructed dynamically, or by a caller compiled against an
 * older release of this package.
 */
export class DetectorReportInvalid extends GuardrailsError {
  override readonly name = "DetectorReportInvalid";
  override readonly incident = true;
  constructor(
    readonly detector: string,
    readonly detail: string,
  ) {
    super(`detector ${detector} returned an unrecordable report: ${detail}`);
  }
}

/**
 * A detector set was declared with no detectors for a phase.
 *
 * Fail-closed, at construction. A tier with no detectors is a tier that is not
 * screened, and "we ran nothing and found nothing" must not be expressible.
 * `NonEmpty` states it in the type; this catches the dynamically built set.
 */
export class DetectorSetEmpty extends GuardrailsError {
  override readonly name = "DetectorSetEmpty";
  override readonly incident = true;
  constructor(
    readonly set: string,
    readonly phase: string,
  ) {
    super(`detector set ${set} declares no ${phase} detectors`);
  }
}

/**
 * The injected `Audit` acknowledged a write this module cannot corroborate: a
 * node absent from the case's own replay, a node replayed as something other
 * than what was acknowledged, an acknowledgement against another case, a
 * duplicated store-assigned sequence, or a parent the module did not name.
 *
 * Fail-closed at every tier, **incident**, and raised before any detector runs.
 * The reason it exists at all: `GuardrailsDeps.audit` is a structural interface,
 * so `result.recorded === true` is a claim the witness makes about itself, and
 * `docs/design/OPEN-ITEMS-RESOLVED.md` §1 resolved that exact hole with a brand
 * that sits on `TraceStore` and on `Screening` — one layer below this module and
 * one layer above — but not on `Audit`. Until it does, replay is the only proof
 * of a write available here, and this is what refusing to proceed without one
 * looks like.
 */
export class AuditWitnessUnsound extends GuardrailsError {
  override readonly name = "AuditWitnessUnsound";
  override readonly incident = true;
  constructor(
    readonly correlationId: string,
    readonly detail: string,
  ) {
    super(`the audit witness for case ${correlationId} is unsound: ${detail}`);
  }
}

/**
 * A screening named a parent node that is not in this case's trace.
 *
 * Fail-closed, **incident**. The alternative — writing the node as a root — is
 * what this replaces: a mistyped or cross-case `under` would silently detach the
 * screening from the graph, and C1 requires parent/child relationships to be
 * recorded rather than inferred. A screening with a parent nobody can find is a
 * screening whose place in the case is a guess.
 */
export class ScreeningParentUnknown extends GuardrailsError {
  override readonly name = "ScreeningParentUnknown";
  override readonly incident = true;
  constructor(
    readonly correlationId: string,
    readonly parent: string,
    readonly nodeKind: string,
  ) {
    super(
      `node ${parent} is not in case ${correlationId}, so ${nodeKind} has no parent to hang under`,
    );
  }
}

/**
 * A payload field held something that is not a string.
 *
 * Fail-closed, before any node is written. `Payload` says `string` in the type,
 * but a payload built by `JSON.parse` of untrusted input is checked by nothing:
 * `{"__proto__": "..."}` and `{"amount": 12}` both satisfy the compiler at the
 * call site and neither is a string at the field the module then slices. Without
 * this the failure was an unnamed `TypeError` raised *after* nodes were already
 * in the trace — an error mode with no policy and no name, which is the thing
 * this file exists to prevent.
 */
export class ScreeningPayloadInvalid extends GuardrailsError {
  override readonly name = "ScreeningPayloadInvalid";
  override readonly incident = false;
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`payload field ${JSON.stringify(field)} is not screenable: ${detail}`);
  }
}

/**
 * A `Limits` value is not a bound this module can honour.
 *
 * Fail-closed, at construction. Every field of `Limits` is a positive safe
 * integer, and none of them was range-checked before: `maxFindingsPerScreening:
 * 0` produced a screening whose settled node read `recommend=allow` over a
 * payload where a `block` had fired, because the finding list it was built from
 * had been truncated to nothing. A bound that silently changes an answer is
 * worse than no bound.
 */
export class LimitsInvalid extends GuardrailsError {
  override readonly name = "LimitsInvalid";
  override readonly incident = false;
  constructor(
    readonly limit: string,
    readonly actual: unknown,
  ) {
    super(`limit ${limit} must be a positive safe integer; got ${String(actual)}`);
  }
}

/**
 * `checkOutput` was handed an output screening as its `after`.
 *
 * Fail-closed, **incident**. `Screening` is unforgeable, so *something* was
 * screened either way — but the documented invariant is `screenInput` strictly
 * before the decision and `checkOutput` strictly after it, and an output
 * screening chained onto another output screening is not that. Reading only the
 * brand made the enforced invariant weaker than the stated one, which is the
 * failure mode this whole module is written against.
 */
export class OutputCheckOutOfOrder extends GuardrailsError {
  override readonly name = "OutputCheckOutOfOrder";
  override readonly incident = true;
  constructor(readonly phase: string) {
    super(
      `checkOutput requires the input screening that preceded the decision; it was given a ${phase} screening`,
    );
  }
}

/** Why a detector run did not produce a report. Recorded on the run's node. */
export type { DetectorUnavailableReason };
