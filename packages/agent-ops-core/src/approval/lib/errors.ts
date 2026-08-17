/**
 * Named error modes. Every one states its fail policy and the reason for it.
 *
 * The reason matters more than the policy: a reader who learns one module's
 * policy will assume the others match, and they deliberately do not. `audit`
 * fails closed on a missing case; this module fails closed on almost
 * everything, because the thing on the other side of the failure is money.
 *
 * Nothing here throws for an **abstention** or an **escalation**. An abstention
 * is a verdict and a successful outcome of a working system; an escalation is a
 * change in who holds authority. Both are returned, never thrown.
 *
 * ## Where alerting lives now, and why it is not in this file
 *
 * This table used to carry scattered alerting obligations in prose —
 * "`AuthorityUnavailable` ... alerts", "`IdempotencyIndeterminate` ... alerts" —
 * with nothing that delivered them. `docs/design/OPEN-ITEMS-RESOLVED.md` item 6
 * named that as the defect: *"Alerts appeared in the error tables of individual
 * modules ... but as scattered obligations rather than a concept."* They are now
 * raised through `ApprovalDeps.alerting`, at the site that detects the
 * condition, and the node records what became of the raise.
 *
 * **The split is not arbitrary and it is worth understanding before adding an
 * error here.** Everything in this file **throws**. A caller who catches it
 * knows something went wrong, and an uncaught one turns a dashboard red. That is
 * not the failure `alerts` exists for. The eight conditions in `docs/CONTEXT.md`
 * are the ones that *return success*: a reserved decision completed unassisted,
 * an effect whose outcome is merely unwitnessed, reminders that quietly stopped.
 * None of them is reachable by catching anything, and none of them belongs in an
 * error table — which is exactly why they were missing from every one.
 *
 * So: an error mode goes here. A silent condition goes through the seam. Two of
 * the five conditions this module raises happen to *accompany* an error
 * (`IdempotencyIndeterminate`, `AuthorityUnavailable`), and the alert is raised
 * at the detection site rather than in the constructor, because an error's
 * constructor cannot know whether anybody is going to catch it.
 *
 * The `alert: true` field still found on some node payloads in this module is
 * neither of those things and is not a delivery. It is a query hint on a node
 * that **already threw** — "an operator reading this trace should stop here" —
 * and it says nothing about whether a human was told. Nodes describing one of
 * the eight conditions carry `alerted: "delivered" | "suppressed" |
 * "undelivered" | "not-configured" | "refused"` instead, which does.
 */

export abstract class ApprovalError extends Error {
  /** `true` when the condition is an incident rather than a metric movement. */
  abstract readonly incident: boolean;
}

/**
 * A reserved decision reached a decision point declared `gate: "never"`.
 *
 * Fail-closed, halt, **incident**. The correct unassisted containment for a
 * reserved decision is exactly zero, so letting this proceed would be a breach
 * rather than an efficiency. There is no configuration key, threshold, override
 * or confidence value that changes this — the check is not consulted from
 * config, it is a branch on a type the policy must return.
 */
export class ReservedStepMisdeclared extends ApprovalError {
  override readonly name = "ReservedStepMisdeclared";
  override readonly incident = true;
  constructor(
    readonly pointId: string,
    readonly rule: string,
  ) {
    super(
      `decision point ${pointId} is declared gate:"never" but this case is reserved under ${rule}`,
    );
  }
}

/**
 * A delegated authority tried to answer a reserved decision.
 *
 * Fail-closed, halt, **incident**. Confidence is never a reason to skip a
 * reserved decision, and neither is a standing delegation.
 */
export class ReservedDelegationAttempt extends ApprovalError {
  override readonly name = "ReservedDelegationAttempt";
  override readonly incident = true;
  constructor(
    readonly suspension: string,
    readonly authority: string,
  ) {
    super(`delegated authority ${authority} may not answer reserved suspension ${suspension}`);
  }
}

/**
 * The tier policy classified above the ceiling the decision point declared.
 *
 * Fail-closed, halt, alert. No brief exists for the tier reached, so proceeding
 * would mean gating on a brief written for a smaller consequence. Never
 * silently downgrade.
 */
export class TierCeilingExceeded extends ApprovalError {
  override readonly name = "TierCeilingExceeded";
  override readonly incident = false;
  constructor(
    readonly pointId: string,
    readonly declared: string,
    readonly classified: string,
  ) {
    super(`${pointId} declares maxTier ${declared}; policy classified ${classified}`);
  }
}

/**
 * A declared recurrence interval is below the configured floor, or a ladder
 * step has a non-positive delay.
 *
 * Fail-closed at declaration-use time. A recurrence that speeds up floods a
 * channel, the channel gets muted, and the case becomes *less* likely to be
 * answered than if nothing had been sent. Persistence is the goal; frequency is
 * not.
 */
export class LadderCadenceTooTight extends ApprovalError {
  override readonly name = "LadderCadenceTooTight";
  override readonly incident = false;
  constructor(
    readonly pointId: string,
    readonly declared: number,
    readonly floor: number,
  ) {
    super(`${pointId} declares a recurrence every ${declared}ms; the floor is ${floor}ms`);
  }
}

/**
 * An authority answered a suspension it was never offered.
 *
 * Fail-closed, **incident**. This is the primary authorisation check: the set
 * of authorities the directory offered the brief to is written into the durable
 * suspension record at the moment of presentation, and `answer` refuses any
 * identity outside it. Before this existed, `ctx.authority` was whatever the
 * calling surface asserted and dual control could be satisfied by two invented
 * strings.
 *
 * It is an incident rather than a routine refusal because there is no benign
 * path to it: a legitimate approval surface can only have obtained the
 * suspension identifier by serving the brief, and the brief was served to the
 * offered set.
 */
export class AuthorityNotOffered extends ApprovalError {
  override readonly name = "AuthorityNotOffered";
  override readonly incident = true;
  constructor(
    readonly suspension: string,
    readonly authority: string,
    readonly seat: string,
  ) {
    super(
      `authority ${authority} was not offered the ${seat}-seat brief for suspension ${suspension}`,
    );
  }
}

/**
 * The second seat was answered by the authority that answered the first.
 *
 * Fail-closed on that answer; the attempt is recorded and the suspension stays
 * open for a different authority.
 *
 * Distinctness is enforced structurally by `AuthorityNotOffered`: the second
 * seat's `offeredTo` set is computed from a directory already narrowed by
 * `excluding: [first]`, and it is that durable set — not this comparison — that
 * `answer` checks. This remains as the backstop for a directory that returns
 * the first approver anyway, i.e. one that lies about identity.
 */
export class DualControlSelfApproval extends ApprovalError {
  override readonly name = "DualControlSelfApproval";
  override readonly incident = false;
  constructor(
    readonly first: string,
    readonly attempted: string,
  ) {
    super(`authority ${attempted} already answered the first seat`);
  }
}

/**
 * An idempotency key is claimed and its outcome is unrecorded: the outbound
 * call was made and we cannot tell what happened.
 *
 * Fail-closed, **never auto-retried**, queued for a human with the full trace
 * attached. A duplicated payment is a clawback, a customer-trust incident and a
 * regulatory conversation; a delayed payment is a phone call. Those costs are
 * not symmetric and the default must not pretend they are.
 *
 * **The alert is raised where the condition is detected, not here.** Every site
 * that puts a claim into `unknown` raises `effect-outcome-unknown` through
 * `ApprovalDeps.alerting` before throwing this, and records the delivery on the
 * node. An error's constructor cannot know whether anybody is going to catch it,
 * and "it alerts" written in a doc comment was the scattered obligation
 * `docs/design/OPEN-ITEMS-RESOLVED.md` item 6 was about.
 *
 * Note that `unknown` is the one state nothing in this library ever clears on
 * its own, at any age. The alert is therefore not a notification about work in
 * progress — it is the **only** thing that starts the work.
 */
export class IdempotencyIndeterminate extends ApprovalError {
  override readonly name = "IdempotencyIndeterminate";
  override readonly incident = true;
  constructor(
    readonly key: string,
    readonly reason: string,
  ) {
    super(`idempotency key ${key} is in doubt (${reason}); it will not be retried automatically`);
  }
}

/**
 * A suspension id that the store has never seen.
 *
 * Fail-closed, and deliberately distinct from "already answered": one means a
 * lost or forged identifier, the other means a retried webhook.
 */
export class SuspensionNotFound extends ApprovalError {
  override readonly name = "SuspensionNotFound";
  override readonly incident = false;
  constructor(readonly suspension: string) {
    super(`no such suspension: ${suspension}`);
  }
}

/**
 * A suspension answered after it had already reached a terminal state.
 *
 * Fail-closed. Approval surfaces retry webhooks, so this is expected traffic
 * rather than a defect — but silently re-approving would double the effect.
 */
export class SuspensionAlreadySettled extends ApprovalError {
  override readonly name = "SuspensionAlreadySettled";
  override readonly incident = false;
  constructor(
    readonly suspension: string,
    readonly state: string,
  ) {
    super(`suspension ${suspension} is already ${state}`);
  }
}

/**
 * A concurrent writer changed the suspension between read and write.
 *
 * Transient, bounded retry by the caller. The store assigns revisions; this
 * module never holds a lock across a human gate, because a lock held for three
 * days is not a lock, it is an outage.
 *
 * **Retrying is only safe because this can no longer be raised after an effect
 * has been taken.** `answer` commits the suspension out of `awaiting` and into
 * `answered` *before* the outbound call, so a lost compare-and-set happens with
 * no money moved and nothing to reconcile. Previously the swap came after the
 * payment, and a caller following the advice in this comment would have paid
 * twice.
 */
export class SuspensionRaceLost extends ApprovalError {
  override readonly name = "SuspensionRaceLost";
  override readonly incident = false;
  constructor(readonly suspension: string) {
    super(`suspension ${suspension} was changed by another writer`);
  }
}

/**
 * A numeric field reached the trace that is not a safe integer.
 *
 * Fail-closed **before the write**. Byte-stable serialisation is what makes
 * replay possible and IEEE-754 is how it dies quietly: `0.1 + 0.2` does not
 * round-trip, and a trace that does not round-trip is not evidence.
 */
export class NonIntegerPayload extends ApprovalError {
  override readonly name = "NonIntegerPayload";
  override readonly incident = false;
  constructor(
    readonly field: string,
    readonly value: number,
  ) {
    super(`payload field ${field} must be a safe integer, got ${value}`);
  }
}

/**
 * The kill switch could not be read.
 *
 * Fail-closed: an unreadable kill switch is treated as engaged. Cheap; the
 * alternative is paying during an incident.
 *
 * **It is constructed and recorded, never thrown**, and the distinction is the
 * point rather than an accident. Fail-closed here means the effect is withheld,
 * not that the decision failed: the decision was made and is fully recorded, and
 * the caller receives `{ kind: "held", reason: "kill-switch-unreadable" }` —
 * distinguishable from `"kill-switch"`, which means the switch was read and was
 * engaged. The constructed error's `name` and the cause's class name and
 * message digest are written onto the `approval.kill-switch-read` node, so the
 * reason the switch was unreadable is in the trace rather than discarded by a
 * bare `catch {}`.
 *
 * `instanceof KillSwitchUnreadable` therefore never matches on a thrown value.
 * Match on the held reason.
 */
export class KillSwitchUnreadable extends ApprovalError {
  override readonly name = "KillSwitchUnreadable";
  override readonly incident = false;
  constructor(
    readonly detail: string,
    override readonly cause?: unknown,
  ) {
    super(`kill switch unreadable, treating as engaged: ${detail}`);
  }
}

/**
 * No authority is available to answer.
 *
 * **Never fail-open.** Non-reserved: the case stays suspended and the ladder
 * keeps running. Reserved: indefinite hold. This is the path by which a case
 * becomes contained-without-resolution — the flattering failure — so it is
 * named, distinct, and never folded into a generic timeout.
 *
 * **The alert is raised at the detection site, not here**, and this error is
 * usually *constructed and not thrown*: the offer fails soft, so the name lands
 * on a node while the case stays suspended and the sweep retries. That is
 * precisely what makes it silent — `docs/CONTEXT.md`: *"looks like a queue with
 * nothing in it"* — and why the raise cannot live in a constructor that nobody
 * is waiting on. See `authority-unavailable` in `alerts`.
 */
export class AuthorityUnavailable extends ApprovalError {
  override readonly name = "AuthorityUnavailable";
  override readonly incident = false;
  constructor(
    readonly pool: string,
    readonly reserved: boolean,
  ) {
    super(`no authority available in pool ${pool}${reserved ? " (reserved decision)" : ""}`);
  }
}

/**
 * A suspension names a decision point this release does not declare.
 *
 * Fail-closed. The case stays suspended and answerable — it is not closed, not
 * expired and not lost. A deploy that drops a decision point while cases are
 * waiting on it is a rollback, not a reason to resolve those cases by
 * exhaustion.
 */
export class UnknownDecisionPoint extends ApprovalError {
  override readonly name = "UnknownDecisionPoint";
  override readonly incident = true;
  constructor(
    readonly pointId: string,
    readonly suspension: string,
  ) {
    super(`suspension ${suspension} names decision point ${pointId}, which this release does not declare`);
  }
}

/**
 * A suspension names a decision point that is declared `gate: "never"`.
 *
 * Fail-closed, incident. It means a point's declaration changed shape under a
 * waiting case, which would let a human gate quietly disappear between
 * releases.
 */
export class GateDeclarationChanged extends ApprovalError {
  override readonly name = "GateDeclarationChanged";
  override readonly incident = true;
  constructor(
    readonly pointId: string,
    readonly suspension: string,
  ) {
    super(`decision point ${pointId} no longer declares a human gate, but suspension ${suspension} is waiting on one`);
  }
}

/**
 * A suspension names a decision point whose `schemaVersion` has changed since
 * the case was frozen against it.
 *
 * Fail-closed, **incident**. The suspension holds a payload, a brief and a
 * verdict serialised under the old field set; handing them to a new executor is
 * how a v3 payload reaches a v9 executor and pays `undefined`. The module
 * already fails closed on a *missing* point and a *changed gate*; this is the
 * case that moves money.
 *
 * Recovery is a rollback of the declaration, not a retry: redeclare the old
 * version, let the waiting cases drain, then deploy the new one under a new
 * `pointId` (ids carry meaning, versions carry shape).
 */
export class PointSchemaChanged extends ApprovalError {
  override readonly name = "PointSchemaChanged";
  override readonly incident = true;
  constructor(
    readonly pointId: string,
    readonly suspension: string,
    readonly frozen: number,
    readonly declared: number,
  ) {
    super(
      `suspension ${suspension} froze decision point ${pointId} at schema version ${frozen}; this release declares ${declared}`,
    );
  }
}

/**
 * A suspension's effect declaration has changed kind or schema version since
 * the case was frozen against it.
 *
 * Fail-closed, **incident**, and separate from `PointSchemaChanged` because the
 * two drift independently: a point can keep its shape while its effect channel
 * is re-versioned underneath it. The idempotency key is derived from both, so
 * executing across the drift would also mint a key that no longer matches the
 * one the suspension is holding.
 */
export class EffectDeclarationDrifted extends ApprovalError {
  override readonly name = "EffectDeclarationDrifted";
  override readonly incident = true;
  constructor(
    readonly pointId: string,
    readonly suspension: string,
    readonly frozen: string,
    readonly declared: string,
  ) {
    super(
      `suspension ${suspension} froze effect ${frozen} for ${pointId}; this release declares ${declared}`,
    );
  }
}

/**
 * The approvals in hand are older than the point's declared `licenceValidFor`.
 *
 * Fail-closed, not an incident. A stale approval is not approval: an approver
 * who signed on Monday did so against Monday's evidence, and a second seat
 * arriving on Thursday must not resurrect it. The suspension returns to the
 * first seat with the sealed answer cleared and the ladder restarted, so the
 * case stays answerable — it is not closed, expired or lost.
 */
export class LicenceExpired extends ApprovalError {
  override readonly name = "LicenceExpired";
  override readonly incident = false;
  constructor(
    readonly suspension: string,
    readonly expiredAt: number,
    readonly now: number,
  ) {
    super(
      `approvals for suspension ${suspension} expired at ${expiredAt}; it is now ${now}. A stale approval is not approval.`,
    );
  }
}

/**
 * A decision point declared a `licenceValidFor` that cannot license anything.
 *
 * Fail-closed **at declaration**, in `defineDecisionPoint`, before any case
 * exists. Zero or negative means every licence is expired at the instant it is
 * minted, which is either a mistake or an attempt to make the validity check
 * vacuous; a non-integer means it is not a duration this library will put near
 * a trace.
 *
 * This is not a hypothetical: the ungated path used to hardcode `0` and then
 * compare it to nothing, so the field read as a control and was decoration.
 */
export class LicenceValidityUnusable extends ApprovalError {
  override readonly name = "LicenceValidityUnusable";
  override readonly incident = false;
  constructor(
    readonly pointId: string,
    readonly declared: number,
  ) {
    super(
      `decision point ${pointId} declares licenceValidFor ${declared}ms; a licence must be valid for a positive whole number of milliseconds`,
    );
  }
}

/**
 * A decision point declared `reservedFacts` that produced nothing to screen.
 *
 * Fail-closed, **incident**, at declaration-use time and before anything is
 * decided. `ReservedStatus` refuses to let "we checked and it is not reserved"
 * and "nobody thought about it" share a representation — but a policy handed an
 * empty fact set produces the former from the latter, and at the node, which is
 * the only artefact an auditor has in 2033, they become byte-identical.
 */
export class ReservedFactsEmpty extends ApprovalError {
  override readonly name = "ReservedFactsEmpty";
  override readonly incident = true;
  constructor(readonly pointId: string) {
    super(
      `decision point ${pointId} submitted no facts for reserved screening; "not reserved" would be indistinguishable from "nobody thought about it"`,
    );
  }
}

/**
 * An injected adapter threw.
 *
 * **Fail-closed at every seam, and always recorded before it is raised.** Named
 * as one error carrying the seam rather than fifteen, because the fail policy
 * is identical across all of them and the seam is data: the caller needs to
 * know *which* adapter to fix, not to write fifteen `catch` arms.
 *
 * Not an incident on its own — nothing was licensed and no effect was taken.
 * Two seams are deliberately **not** fatal and never raise this: `renderer`
 * (present and remind) and `authorities.candidates`, where a failure leaves the
 * case suspended and the ladder running, because failing to reach an approver
 * is not a reason to stop trying to reach them.
 *
 * The `cause` carries the original error for an operator holding the exception.
 * Only its class name and a digest of its message reach the trace: adapter
 * error text is uncontrolled and routinely carries credentials and personal
 * data, and there is no un-writing.
 */
export class AdapterFailed extends ApprovalError {
  override readonly name = "AdapterFailed";
  override readonly incident = false;
  constructor(
    readonly seam: string,
    override readonly cause: unknown,
    readonly causeClass: string,
  ) {
    super(`the ${seam} adapter threw ${causeClass}; halting fail-closed`);
  }
}

/**
 * A second caller reached an effect whose idempotency claim another caller is
 * holding, between the claim and its settlement.
 *
 * Transient, **not an incident**, bounded retry by the caller. Deliberately
 * distinct from `IdempotencyIndeterminate`: nothing is in doubt here, one
 * caller is simply mid-flight. Raising an in-doubt incident for a
 * double-clicked approve button would write a seven-year reconciliation record
 * describing an ambiguity that did not occur.
 *
 * Once the holder settles, a repeat returns the original outcome rather than
 * re-executing — that is the `settled` arm, not this one.
 */
export class EffectAlreadyInFlight extends ApprovalError {
  override readonly name = "EffectAlreadyInFlight";
  override readonly incident = false;
  constructor(readonly key: string) {
    super(`idempotency key ${key} is claimed by another caller that has not settled it yet`);
  }
}

/**
 * The durable store could not serve a call.
 *
 * **Fail-closed, never degraded, and recorded before it is raised.** Three
 * reasons, and they are not the same fact:
 *
 *   `store-failure`  The connection reset, the disk is full, the database is
 *                    gone. Transient from the caller's side; retryable by the
 *                    caller with backoff, because nothing was written.
 *   `backpressure`   This adapter already holds `maxPendingWrites` writes in
 *                    flight and shed this one rather than queueing it behind
 *                    pool connections. Also retryable, and the retry is the
 *                    point: shedding is how the backlog stays bounded instead
 *                    of surfacing as latency until the process dies.
 *   `contract`       The database refused the statement — a constraint, a data
 *                    type, a missing column. A defect or a schema that has
 *                    drifted from `APPROVAL_STORE_SCHEMA_SQL`, **never**
 *                    retryable, and never reported as an outage: degrading a
 *                    foreign-key violation into "the store was briefly away" is
 *                    how a missing suspension becomes an ordinary Tuesday.
 *
 * It is deliberately raised by the adapter and **recorded by the module**: the
 * store does not hold a recorder, and a failure nobody wrote down is the
 * failure this library exists to make impossible. See `guard` in `approval.ts`.
 */
export class ApprovalStoreUnavailable extends ApprovalError {
  override readonly name = "ApprovalStoreUnavailable";
  override readonly incident = false;
  /** Marks this as raised by an adapter, so `guard` records it rather than assuming it was. */
  readonly adapterRaised = true;
  constructor(
    readonly reason: "store-failure" | "backpressure" | "contract",
    readonly operation: string,
    override readonly cause?: unknown,
  ) {
    super(`approval store could not serve ${operation} (${reason})`);
  }
}

/**
 * More entry-point invocations are in flight than `limits.maxInFlight` permits.
 *
 * **Fail-closed, shed before anything starts, not an incident.** Nothing was
 * classified, screened, decided, recorded or paid, so the caller may retry with
 * backoff and lose nothing but time.
 *
 * It is the one failure in this module with **no node**, and the reason is
 * stated rather than hidden: recording it would mean opening a trace, which is
 * the work being shed. The count belongs in the caller's own operational
 * metrics, and a sustained non-zero value is a capacity fact rather than a case
 * fact — there is no case to attach it to.
 */
export class ApprovalOverloaded extends ApprovalError {
  override readonly name = "ApprovalOverloaded";
  override readonly incident = false;
  constructor(
    readonly entryPoint: string,
    readonly inFlight: number,
    readonly ceiling: number,
  ) {
    super(
      `${entryPoint} refused: ${inFlight} invocations already in flight against a ceiling of ${ceiling}`,
    );
  }
}

/**
 * A node this module needed to write was not written.
 *
 * **Fail-closed at every tier**, which is deliberately stricter than `audit`'s
 * own tiered policy. `audit` permits a low- or medium-tier node to be dropped
 * when the store is unavailable, and for informational nodes that is a
 * reasonable trade. This module has no informational nodes: every one is part
 * of the chain of evidence that an effect was licensed, and a licence with no
 * node behind it is an assertion rather than evidence.
 */
export class TraceNodeNotRecorded extends ApprovalError {
  override readonly name = "TraceNodeNotRecorded";
  override readonly incident = true;
  constructor(
    readonly correlationId: string,
    readonly nodeKind: string,
    readonly reason: string,
  ) {
    super(`node ${nodeKind} for case ${correlationId} was not recorded (${reason}); halting`);
  }
}
