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
 * Five verbs, and the last two are the honest ones:
 *
 *   run       Declare-and-go. Returns `Settled` or `Suspended`. Never blocks on
 *             a human; there is no promise here that resolves when a person
 *             answers, because `await approve()` is the wrong shape for a wait
 *             measured in days.
 *   answer    Called by the application's approval surface, in another process,
 *             on another release, possibly a week later.
 *   sweep     Drives time. Ladder steps, recurrence reminders, expiry and the
 *             release of a kill-switch hold do not happen because a timer fired
 *             inside this module — nothing here owns a timer. Bounded, leased,
 *             idempotent, re-entrant, and it records its own nodes.
 *   inDoubt   The reconciliation queue for **effects**: those whose outcome is
 *             unrecorded. They are never auto-retried. A human resolves them.
 *   reconcile The reconciliation queue for the **link**: suspensions whose trace
 *             node is missing, and trace nodes whose suspension is missing. Two
 *             stores that cannot share a transaction can still be compared, and
 *             this is the comparison. See `Durability` below.
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
 *                  and the answer. **Two store adapters ship**, and the scope of
 *                  each is stated rather than implied: `inMemoryApprovalStore`
 *                  demonstrates survival across a runtime restart over the same
 *                  object, and `postgresApprovalStore` demonstrates survival
 *                  across **process death** — `tests/postgres-store.test.ts`
 *                  serialises the whole database to bytes, throws away every
 *                  object including the store and the executor, rebuilds from
 *                  those bytes alone and answers the case.
 *   Linkage.       A suspension and its trace node **do not share a
 *                  transaction**, and cannot: `audit`'s interface exposes none,
 *                  and a transaction spanning `decide` would hold a pooled
 *                  connection open across a model call. So the link is written
 *                  on **both** sides — the record carries `suspendNode`, the
 *                  node carries the suspension id — and a crash between the two
 *                  writes loses a row rather than the link. `reconcile` is the
 *                  bounded query that finds the disagreement and says how to
 *                  close it. This is a real weakening, reported rather than
 *                  dressed up: the window is detectable and recoverable, not
 *                  absent.
 *   Holds.         A kill-switch hold is **not terminal**. The switch is engaged
 *                  during an incident and disengaged after it, so a held case
 *                  keeps a due time, the sweep keeps visiting it, and when the
 *                  switch is found off the case returns to the first seat with
 *                  the ladder restarted and the sealed answers cleared. The
 *                  effect is never taken on release: an approval given before an
 *                  incident was given against pre-incident evidence.
 *   Licence.       `licenceValidFor` is enforced **twice** — once in `answer`
 *                  before the settlement commits, and once at the instant of
 *                  execution, against the clock, before a claim is taken. It was
 *                  previously computed, recorded and never compared on the
 *                  second side, and a field that is recorded and never read is
 *                  worse than no field, because it reads as a control.
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
 *                  have done during the incident. **Its scope is enforced, not
 *                  merely recorded.** `KillSwitchScope` is a closed type —
 *                  `system-wide`, or an explicit list of tiers — the reader is
 *                  asked a per-tier question, and this module compares the scope
 *                  it gets back to the tier of the effect in hand. A switch
 *                  engaged for high tier refuses a disbursement and leaves
 *                  ticket routing running, and the node carries `scopeKind`,
 *                  `scopeTiers` and `appliesToTier` so the trace says which of
 *                  those two happened rather than restating the reader's claim.
 *                  It was previously a free string written onto the node while
 *                  every engaged switch stopped every effect at every tier: a
 *                  safety control that records its own scope without obeying it
 *                  is the most dangerous kind, because it reports that it
 *                  worked. An **unreadable** switch still stops everything at
 *                  every tier — an unreadable scope is a guess, and per-tier
 *                  scope is the last place to start guessing.
 *   Integers.      Every number crossing into the trace is a safe integer.
 *                  Money in minor units, latency in microseconds, confidence in
 *                  basis points.
 *   Clock.         Injected. No `Date.now()` in this module, ever.
 *   Alerting.      Six of `docs/CONTEXT.md`'s eight **silent** conditions are
 *                  visible only from inside this module — a reserved decision
 *                  completed unassisted, an effect in `unknown`, reminders that
 *                  stopped, a buried case, `AuthorityUnavailable`, and the
 *                  **abstention rate moving sharply**. The last is the eighth
 *                  condition's other half: an abstention is a *verdict*, so
 *                  `approval` is the only module that sees one, and a run of two
 *                  hundred individually correct abstentions is a deployment that
 *                  stopped deciding while every case behaved as designed. It is
 *                  a property of a window rather than of a case, so it is wired
 *                  by `ApprovalDeps.abstentionRate` — window, sharpness and
 *                  minimum sample, none of them defaulted — and raised through
 *                  the same `alerting` as the other five. Every one
 *                  of them returns success or returns nothing at all, so none is
 *                  reachable by catching an exception. They are raised through
 *                  the injected `alerting` and what became of each raise is on
 *                  the node: `alerted: "delivered"` and
 *                  `alerted: "not-configured"` are different rows in the archive
 *                  seven years from now. A test cannot page anybody, because
 *                  nothing here constructs a transport.
 *   Heartbeat.     `sweep` beats on **every** run, including empty ones — and
 *                  **the watcher is external.** See `DEFAULT_SWEEPER_COMPONENT`
 *                  below. This is the one alert the library cannot deliver
 *                  itself, and the deployment step most likely to be skipped.
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
 *   `ApprovalStore`       Two, both shipped and both exported:
 *                         `inMemoryApprovalStore` and `postgresApprovalStore`.
 *                         The seam was hypothetical by this project's own rule
 *                         while the second was named and unbuilt; it is built,
 *                         and it ships the schema it needs as
 *                         `APPROVAL_STORE_SCHEMA_SQL` rather than describing it
 *                         in prose, so the adapter and its migration cannot
 *                         drift apart silently.
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
 * `docs/design/OPEN-ITEMS-RESOLVED.md` for the seven settled decisions.
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
  AbstentionRateTerms,
  Approval,
  ApprovalDeps,
  ApprovalRecord,
  ApprovalStore,
  ApproverAnswer,
  AnyDecisionPoint,
  NoEffectPayload,
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
  KillSwitchQuery,
  KillSwitchReader,
  KillSwitchScope,
  KillSwitchState,
  Licence,
  Limits,
  LinkDivergence,
  LinkDivergenceKind,
  NonEmpty,
  NotReserved,
  PolicyFacts,
  ReconciliationReport,
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
export { DEFAULT_LIMITS } from "./lib/limits.js";

/**
 * ⚠ **THE SWEEPER'S DEAD-MAN'S SWITCH, AND THE WATCHER FOR IT IS NOT IN THIS
 * LIBRARY.**
 *
 * `sweep` emits a heartbeat on **every** run, including runs that found nothing
 * to do, under `DEFAULT_SWEEPER_COMPONENT` unless `ApprovalDeps.sweeperComponent`
 * names another. *"Nothing was due"* and *"I did not run"* do not share a
 * representation: the first is a recorded beat, the second is the **absence** of
 * one — and an absence is not observable from inside the process that failed to
 * produce it.
 *
 * So this module ships the emit side and nothing else. **Something outside this
 * process must poll `alerts.livenessQuery` and raise `heartbeat-missed` when the
 * sweeper stops.** A watchdog that depends on the thing it watches fails
 * silently at the exact moment it is needed; if the host dies, an in-process
 * check dies with it, nothing throws, no dashboard turns red, and every waiting
 * case rots until somebody telephones.
 *
 * A missed heartbeat is the highest-severity condition in the system and
 * `alerts` proves that ordering in its type rather than asserting it: one
 * stalled case is one customer, a stopped sweeper is every waiting case at once.
 *
 * `EXTERNAL_WATCHDOG_REQUIREMENT` is re-exported here rather than restated,
 * because a sentence this important that exists in two places will eventually
 * exist in two versions. `docs/RUNBOOK.md` must carry it verbatim.
 */
export { DEFAULT_SWEEPER_COMPONENT } from "./lib/approval.js";
export { EXTERNAL_WATCHDOG_REQUIREMENT } from "../alerts/index.js";

/**
 * Store adapters. **Two**, which is what makes `ApprovalStore` a real seam.
 *
 * `inMemoryApprovalStore` is a shipped deliverable, not a mock — it is what
 * makes hermetic tests structural rather than conventional. `postgresApprovalStore`
 * is the one that carries a suspension across process death, and it takes an
 * injected `SqlExecutor`: no driver is imported here, no connection string is
 * read, and no socket is opened, so no code path in this package can reach a
 * database whatever credentials are in the environment.
 */
export { inMemoryApprovalStore } from "./lib/in-memory-store.js";
export { APPROVAL_STORE_SCHEMA_SQL, postgresApprovalStore } from "./lib/postgres-store.js";
export type {
  PostgresApprovalStoreLimits,
  SqlExecutor,
  SqlRow,
} from "./lib/postgres-store.js";

export {
  AdapterFailed,
  ApprovalError,
  ApprovalOverloaded,
  ApprovalStoreUnavailable,
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
