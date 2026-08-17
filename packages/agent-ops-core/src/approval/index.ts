/**
 * approval — everything between a verdict and an effect.
 *
 * Risk-tier routing, reserved decisions, the human gate, the escalation ladder
 * and its recurrence, dual control, durable suspension, idempotency, the kill
 * switch and the approval brief.
 *
 * The caller **declares** a decision point and hands it over. There is no
 * `classify`, no `handle`, no `authorise`, no `execute`, no `suspend` and no
 * `resume` in this interface. Those phases exist, they are strictly ordered,
 * and every one of them writes a node — but none of them is reachable from
 * outside the module. That absence is the auditability mechanism, not an
 * omission.
 *
 * Four verbs, and the fourth is the honest one:
 *
 *   run      Declare-and-go. Returns `Settled` or `Suspended`. Never blocks on
 *            a human; there is no promise here that resolves when a person
 *            answers, because `await approve()` is the wrong shape for a wait
 *            measured in days.
 *   answer   Called by the application's approval surface, in another process,
 *            on another release, possibly a week later.
 *   sweep    Drives time. Ladder steps, recurrence reminders and expiry do not
 *            happen because a timer fired inside this module — nothing here
 *            owns a timer. Bounded, leased, idempotent, re-entrant, and it
 *            records its own nodes.
 *   inDoubt  The reconciliation queue: effects whose outcome is unrecorded.
 *            They are never auto-retried. A human resolves them.
 *
 * Invariants a caller must know:
 *
 *   Capability.    No `decide` receives a write-capable client at any tier.
 *                  Declaring one is a compile error in both directions. All
 *                  effects go through a declared `EffectDeclaration`, invoked
 *                  only by this module, only with a licence, only after the
 *                  kill switch has been read.
 *   Reserved.      Structurally enforced and orthogonal to risk tier, on its
 *                  own seam. `ReservedStatus` has no boolean and no `undefined`
 *                  branch: "we checked and it is not reserved" and "nobody
 *                  thought about it" cannot share a representation. A reserved
 *                  decision has no expiry, no default and no override, and its
 *                  correct unassisted containment is exactly zero.
 *   Ladder.        A gated decision cannot be declared without a non-empty
 *                  ladder and a recurrence. The type has no `stop` value and no
 *                  maximum attempt count. The cadence is bounded and never
 *                  accelerates; each cycle widens the audience instead of
 *                  raising the volume. Every reminder sent is a recorded node.
 *   Awaiting.      `awaiting_authority` is not terminal and is never contained.
 *                  A buried case stays answerable indefinitely; only an
 *                  authority closes it.
 *   Durability.    A suspension is plain data. Nothing needed to resume lives in
 *                  a closure, so a runtime may be rebuilt between the question
 *                  and the answer. **Scope, stated rather than implied:** the
 *                  only shipped `ApprovalStore` is in-memory, so every
 *                  durability test here demonstrates survival across a runtime
 *                  restart over the same store — a real property of the shape —
 *                  and not survival across process death. `postgresApprovalStore`
 *                  is named and not built. See `ApprovalStore`.
 *   Authorisation. An answer is authorised against the durable set of
 *                  authorities the directory actually offered that seat's brief
 *                  to, never against the identity the calling surface asserts.
 *                  Dual-control distinctness falls out of it: the second seat's
 *                  set is computed from a directory narrowed by the first
 *                  approver, so the second approver is *unable* to be the first.
 *   Declaration.   A suspension is frozen against its point's `schemaVersion`
 *                  and its effect's kind and version. Answering across drift is
 *                  fail-closed, because the payload it holds was serialised
 *                  under the old field set.
 *   Freshness.     A stale approval is not approval. The licence runs from the
 *                  EARLIEST approval in hand, so a second seat cannot resurrect
 *                  a first approval that has aged past `licenceValidFor`.
 *   Idempotency.   Three states — not-attempted, unknown, settled. `unknown` is
 *                  never auto-retried. Ambiguity resolves toward not paying
 *                  twice.
 *   Kill switch.   Stops effects, never decisions. Read at execute, not at
 *                  classify, so the trace preserves what the system *would*
 *                  have done during the incident.
 *   Integers.      Every number crossing into the trace is a safe integer.
 *                  Money in minor units, latency in microseconds, confidence in
 *                  basis points.
 *   Clock.         Injected. No `Date.now()` in this module, ever.
 *
 * Two notes on what is deliberately *not* here.
 *
 * `sweep` takes a batch limit and reads `now` from the injected clock rather
 * than taking `now` as a parameter as `OPEN-ITEMS-RESOLVED` item 2 sketched. A
 * module with two sources of time has two clocks, and they disagree on the day
 * it matters. Ageing stays fully testable without waiting because the clock is
 * a constructor parameter.
 *
 * `Clock` and `KillSwitchReader` are **injected, not seamed**. Injection is a
 * hermeticism requirement; a seam is a place behaviour genuinely varies with a
 * second shipped adapter. Counting a fake clock as an adapter would let anyone
 * call any injected dependency a seam, and then the seam rule stops meaning
 * anything.
 *
 * ## Seam accounting (C5), stated in full rather than counted from fixtures
 *
 * Six seams are declared in `ApprovalDeps`. The private adapters in `tests/`
 * are **not** counted: they are not exported, and by the same standard that
 * makes `inMemoryApprovalStore` a deliverable they are mocks.
 *
 *   `ApprovalStore`       ONE adapter — in-memory. **Hypothetical by this
 *                         project's own rule.** `postgresApprovalStore` is
 *                         named and not built; it needs a migration that does
 *                         not exist. Reported, not dressed up.
 *   `ClientFactory`       Two. `inMemoryClientFactory` ships here; the second
 *                         is each application's own factory over its evidence
 *                         store and effect channel.
 *   `TierPolicy`          Real, and the adapters are the nineteen applications.
 *   `ReservedPolicy`      A tier table for claims and one for invoices are
 *   `AuthorityDirectory`  different adapters in every sense that matters, and
 *   `BriefRenderer`       this library cannot ship either without inventing a
 *                         domain. That is the defensible answer and it is the
 *                         one made here — not "our test fixtures are the second
 *                         adapters", which they are not.
 *
 * ## What the trace does and does not prove
 *
 * Every node carries `capturedVia: "declared-seams-only"`, and the scope that
 * stamp claims is exactly this: everything reached through this module's own
 * seams is recorded, including every adapter failure and every telemetry
 * figure, and an authority who was not offered the brief cannot license an
 * effect. It does **not** claim to cover application code that holds its own
 * closure inside `decide` and calls a payments provider directly. No type in
 * this package reaches outside this package, and the honest claim is therefore
 * "unrepresentable through this module's seams", not "unrepresentable".
 *
 * See `docs/CONTEXT.md` for the vocabulary, `docs/design/design-it-twice/
 * FINDINGS.md` for the hybrid this implements, and
 * `docs/design/OPEN-ITEMS-RESOLVED.md` for the six settled decisions.
 */

export type {
  Capability,
  Client,
  ClientFactory,
  ClientScope,
  EvidenceQuery,
  ReadOnlyClient,
  WriteCapableClient,
} from "./lib/clients.js";

/**
 * The in-memory client factory. A shipped deliverable, not a mock — it is what
 * makes hermetic tests structural rather than conventional.
 */
export { inMemoryClientFactory } from "./lib/in-memory-clients.js";
export type { InMemoryClients, InMemoryClientOptions } from "./lib/in-memory-clients.js";

export type {
  Approval,
  ApprovalDeps,
  ApprovalRecord,
  ApprovalStore,
  ApproverAnswer,
  AnyDecisionPoint,
  AnswerReceipt,
  AnsweringContext,
  Authority,
  AuthorityDirectory,
  AuthorityId,
  AuthorityPoolId,
  AuthorityRef,
  AuthorityRequest,
  BriefBody,
  BriefBuilder,
  BriefRenderer,
  ContraryEvidence,
  CouldNotCheck,
  DecisionPoint,
  DecisionPointSpec,
  DecisionSpend,
  DelegatedAuthority,
  DelegationGrant,
  Determination,
  DoNothing,
  DoNothingConsequence,
  DurationMs,
  EffectCommand,
  EffectDeclaration,
  EffectOutcome,
  EscalationAction,
  EscalationLadder,
  EscalationStep,
  EvidenceHandle,
  ExpiryBranch,
  ExpirySettlement,
  GatedSpec,
  HumanAuthority,
  IdempotencyClaim,
  IdempotencyClaimResult,
  IdempotencyKey,
  IdempotencyState,
  Instant,
  KillSwitchReader,
  KillSwitchState,
  Licence,
  Limits,
  NonEmpty,
  NotReserved,
  PolicyFacts,
  RedactedPayload,
  Recurrence,
  Reminder,
  Reserved,
  ReservedPolicy,
  ReservedStatus,
  RunContext,
  SealedAnswer,
  ServedBrief,
  ServedDoNothing,
  Settled,
  Suspended,
  SuspensionId,
  SuspensionRecord,
  SuspensionState,
  SweepReport,
  Tier,
  TierPolicy,
  UncheckedItem,
  Uncertainty,
  UngatedEffect,
  UngatedSpec,
} from "./lib/types.js";

export { defineDecisionPoint } from "./lib/define.js";
export { createApproval } from "./lib/approval.js";
export { inMemoryApprovalStore } from "./lib/in-memory-store.js";
export { DEFAULT_LIMITS } from "./lib/limits.js";

export {
  AdapterFailed,
  ApprovalError,
  AuthorityNotOffered,
  AuthorityUnavailable,
  DualControlSelfApproval,
  EffectAlreadyInFlight,
  EffectDeclarationDrifted,
  IdempotencyIndeterminate,
  KillSwitchUnreadable,
  LadderCadenceTooTight,
  LicenceExpired,
  LicenceValidityUnusable,
  NonIntegerPayload,
  PointSchemaChanged,
  ReservedDelegationAttempt,
  ReservedFactsEmpty,
  ReservedStepMisdeclared,
  SuspensionAlreadySettled,
  SuspensionNotFound,
  SuspensionRaceLost,
  TierCeilingExceeded,
  UnknownDecisionPoint,
  GateDeclarationChanged,
  TraceNodeNotRecorded,
} from "./lib/errors.js";
