/**
 * alerts — the module that means an engineer finds out before a customer
 * telephones.
 *
 * `docs/design/OPEN-ITEMS-RESOLVED.md` item 6 was found by asking a plain
 * question: *are the right engineers notified on failure, long before a client
 * or an employee makes contact?* The honest answer was no — alerting existed as
 * scattered obligations in other modules' error tables, with no seam, no
 * adapter, no severity model, and nothing at all for the failures that never
 * throw. This is that concept.
 *
 * ## The one idea
 *
 * **Alerting is driven by absence, not by thrown errors.** A system that alerts
 * only on exceptions is monitoring the failures it was going to survive anyway.
 * The eight conditions `docs/CONTEXT.md` tabulates all return success or return
 * nothing at all: a reserved decision completed unassisted *returns success*; an
 * effect in `unknown` *did not fail*; reminders that stopped firing *did not
 * error*. None of them is reachable by catching anything. They are raised by
 * something that went looking.
 *
 * ## Four verbs and one assertion
 *
 *   createAlerts              `raise(condition)` and `health()`. Ordered sink
 *                             chain, bounded, suppressed, journalled, ledgered.
 *   createHeartbeat           `beat({ component, run })`. Every run, including
 *                             the empty ones.
 *   createLivenessCheck       `check()`. Reads the store, judges it against an
 *                             injected clock, raises what is overdue.
 *   livenessQuery             What an EXTERNAL watcher polls. See below.
 *   assertProductionAlerting  Called at the composition root. Throws rather than
 *                             letting a chain that pages nobody look healthy.
 *
 * ## Invariants a caller must know
 *
 *   Separation.    An alert is not an escalation and never shares its channel.
 *                  Escalation routes a *decision* to an authority: expected,
 *                  routine, continuous. An alert says the *machinery* is wrong:
 *                  unexpected, rare. Mixed into one channel the routine volume
 *                  mutes the exceptional signal. Enforced in the types, not by
 *                  convention: an alert is addressed to an `OperatorRotaId`,
 *                  which an authority identifier does not typecheck as, and an
 *                  `Alert` carries no brief, no verdict and no effect.
 *   Severity.      Derived from the condition, never a parameter. A missed
 *                  heartbeat outranks every per-case alert, and that ordering is
 *                  a compile-time proof in `severity.ts` — not a comment, not a
 *                  convention. One stalled case is one customer; a stopped
 *                  sweeper is every waiting case at once.
 *   Closed union.  Nine conditions, exhaustively checked in four places: the
 *                  severity table, the correlation lookup, the fingerprint and
 *                  the payload. Adding a tenth without handling it does not
 *                  compile.
 *   Heartbeat.     A component proves liveness on **every run, including empty
 *                  ones**. "Nothing was due" and "I did not run" do not share a
 *                  representation — the first is a recorded run, the second is
 *                  the absence of one. A component must be `watch`ed before it
 *                  may `beat`.
 *   Watchdog.      **External. Always.** See the block below; it is the one
 *                  alert this library cannot deliver itself.
 *   Degradation.   A sink that throws does not take the case down and does not
 *                  fail silently. It degrades to the next sink in the chain and
 *                  the degradation is recorded — on the outcome, in the journal,
 *                  and in `health()`.
 *   Bounded.       No unbounded retry (in fact no retry at all — the chain is
 *                  the redundancy), no unbounded queue, no unbounded suppression
 *                  table, no unbounded ledger. Every bound publishes what it
 *                  shed.
 *   Suppression.   Collapses repeats; **never silences a condition**. The first
 *                  occurrence always fires, every window ends, and the collapsed
 *                  count rides on the next delivery.
 *   Integers.      Every payload number is a safe integer — durations in
 *                  milliseconds, rates in basis points, counts as counts. No
 *                  IEEE-754 anywhere, because byte-stable serialisation is what
 *                  makes replay possible and floats are how it dies quietly.
 *   No personal data. No condition has a free-text field, so there is nowhere
 *                  for a name or a narrative to arrive. Sink failures record the
 *                  exception's **name only** — never its message, which routinely
 *                  echoes the request that failed.
 *   Injected.      Clock, timers, transport, stream, store, journal. This module
 *                  constructs no HTTP client and reads no URL, token or routing
 *                  key from the environment, so a test cannot page a real
 *                  engineer even with real credentials present. There is no code
 *                  path from this package to a network to be disabled — which is
 *                  a fact about the call graph, not a promise about a flag.
 *
 * ## ⚠ The watchdog is external, and this is the sentence most likely to be skipped
 *
 * A watchdog that depends on the thing it watches fails silently at the exact
 * moment it is needed. If the process hosting the sweeper dies, an in-process
 * check dies with it: nothing runs, nothing throws, no dashboard turns red, and
 * every waiting case rots until somebody telephones.
 *
 * This module therefore ships the **emit** side, the **store**, the **verdict**
 * (`livenessFindings`, a pure function of records and an instant) and the
 * **query** (`livenessQuery`). It does **not** ship the watcher, and it will not
 * pretend to. `createLivenessCheck` run inside the process it watches is a
 * second line of defence and never the first. See `lib/external-watchdog.ts` and
 * `EXTERNAL_WATCHDOG_REQUIREMENT`, which `RUNBOOK.md` must carry verbatim.
 *
 * ## Failure to alert, and where the regress stops
 *
 * Requirement (f) is that failing to alert is itself alertable. A sink that
 * throws degrades to the next; a chain that fails entirely is returned to the
 * caller as `outcome: "undelivered"`, recorded in the journal, and published in
 * `health()`. What this module does **not** do is raise an alert about the
 * alerting through the alerting — that is an infinite regress dressed up as
 * thoroughness. The regress stops at the external watcher, which reads
 * `health()` alongside the liveness records. That is the honest bottom, and it
 * is stated rather than hidden behind a retry loop.
 *
 * ## Seam accounting (C5), counted straight
 *
 *   `AlertSink`      **A real seam.** Two shipped adapters with different
 *                    bodies, different urgency and different audiences:
 *                    `pagingAlertSink` over an injected `PageTransport`, and
 *                    `operationalStreamAlertSink` over an injected
 *                    `OperationalStream`. `recordingAlertSink` is a third and is
 *                    a test deliverable — `assertProductionAlerting` refuses it
 *                    by name, which is what keeps it from being counted.
 *   `AlertJournal`   **ONE adapter — hypothetical, and reported as such.**
 *                    `inMemoryAlertJournal` ships. The `audit`-backed adapter is
 *                    named and deliberately not built here: wiring two modules
 *                    together is a composition-root decision, and the payload is
 *                    already node-shaped so that it is four lines when it is.
 *   `LivenessStore`  **ONE adapter — hypothetical.** `inMemoryLivenessStore`
 *                    ships; `postgresLivenessStore` is named and not built,
 *                    because it needs a migration that does not exist. The cost
 *                    is stated where the adapter is: beat history dies with the
 *                    process, so a watcher polling across a restart sees `never`
 *                    rather than `beat` — the safe direction, and still a limit.
 *   `PageTransport`  **Not a seam — the injection point.** This package may not
 *                    take an HTTP dependency nineteen applications inherit, so
 *                    the transport arrives as a parameter. One shape, no
 *                    behaviour variation wanted, no second adapter intended.
 *   `Clock`, `AlertTimers`  **Injected, not seamed.** Hermeticism requires them;
 *                    C5 would fail them. Counting a fake clock as an adapter
 *                    would make "seam" mean nothing.
 *
 * ## How the other four modules reach this one
 *
 * Through exactly one function: `raiseAndRecord(alerting, condition)`, in
 * `lib/wiring.ts`. `approval`, `audit`, `evals` and `guardrails` each take an
 * optional `AlertRaiser` and call it at the sites where they — and only they —
 * can see a silent condition. Nothing else crosses: this module still imports no
 * other module, and every type it needs from elsewhere is redeclared
 * structurally (`Clock`, `CorrelationId`, `RiskTier`, `AlertPayload`) so a
 * composition root passes one object to both without a cast.
 *
 * The direction of the dependency is the point. `alerts` does not know that
 * approvals or traces exist; the four modules know that alerting exists and take
 * it as a parameter. Reverse it — an `alerts` that inspected a suspension — and
 * the module would need a store, a clock it did not own, and a reason to import
 * four things, which is how a fifth module becomes a fifth god object.
 *
 * `raiseAndRecord` never throws and its result is node-shaped, so a detection
 * site spreads it into the payload it was already writing. That is deliberate:
 * an alert that fired and left no trace is half a mechanism, and the missing
 * half is the half an auditor reads.
 *
 * ## What is deliberately not here
 *
 * **`audit` does not back the journal.** The `AlertJournal` seam still ships one
 * adapter. Wiring the audit-backed one is a composition-root decision and the
 * payload is already node-shaped so that it is four lines when someone makes it.
 *
 * **No alert rate limiting by severity, no escalation of an alert to a second
 * rota, no acknowledgement tracking.** Those are a paging product's job, and
 * this module's job is to be certain the paging product hears about it.
 *
 * See `docs/CONTEXT.md` for the vocabulary — `Alert`, `Silent failure`,
 * `Heartbeat` — and `docs/design/OPEN-ITEMS-RESOLVED.md` item 6 for the decision
 * this implements.
 */

export type {
  AlertField,
  AlertFingerprint,
  AlertId,
  AlertPayload,
  AlertSinkId,
  AlertTimers,
  AuthorityPoolId,
  BasisPoints,
  Clock,
  ComponentId,
  CorrelationId,
  DecisionPointId,
  DurationMs,
  EffectKindId,
  IdempotencyKeyId,
  Instant,
  NonEmpty,
  OperatorRotaId,
  ReservedRuleId,
  ReservedStatus,
  RiskTier,
} from "./lib/primitives.js";
export { systemClock, systemAlertTimers } from "./lib/primitives.js";

/**
 * Severity, and the proof of its ordering. `LivenessOutranksEveryCaseAlert` is
 * exported so a caller can see that the guarantee is a type rather than a
 * paragraph — instantiate it and the compiler checks it for you.
 */
export type {
  AlertSeverity,
  CaseSeverity,
  LivenessSeverity,
  LivenessOutranksEveryCaseAlert,
  SeverityRank,
} from "./lib/severity.js";
export {
  SEVERITY_ORDER,
  SEVERITY_RANK,
  atLeast,
  compareSeverity,
  isLivenessSeverity,
  maxSeverity,
  severityRank,
} from "./lib/severity.js";

/**
 * The nine conditions. The eight silent ones from `docs/CONTEXT.md`, plus the
 * missed heartbeat that outranks them.
 */
export type {
  AlertCondition,
  AlertConditionKind,
  AuthorityUnavailable,
  CaseBuried,
  EffectOutcomeUnknown,
  EverySilentConditionIsAPerCaseSeverity,
  HeartbeatCarriesTheLivenessSeverity,
  HeartbeatMissed,
  LastSeen,
  LivenessCondition,
  RateMovedSharply,
  RemindersStopped,
  ReservedDecisionCompletedUnassisted,
  SeverityOfKind,
  SilentCondition,
  SilentConditionKind,
  TraceUnavailableAtHighTier,
  UnderRecordingDetected,
} from "./lib/conditions.js";
export {
  CONDITION_PAYLOAD_VERSION,
  SEVERITY_BY_CONDITION,
  correlationOf,
  fingerprintOf,
  payloadOf,
  severityOf,
} from "./lib/conditions.js";

export type {
  Alert,
  AlertJournal,
  AlertJournalEntry,
  AlertLimits,
  AlertOutcome,
  Alerts,
  AlertsDeps,
  AlertingHealth,
  AlertSink,
  BeatReceipt,
  Heartbeat,
  HeartbeatDeps,
  HeartbeatRun,
  JournalOutcome,
  LivenessCheck,
  LivenessCheckDeps,
  LivenessCheckReport,
  LivenessFinding,
  LivenessRecord,
  LivenessStore,
  LivenessTolerance,
  OperationalRecord,
  OperationalStream,
  PageRequest,
  PageTransport,
  SinkAck,
  SinkDegradation,
  SinkDelivery,
  UndeliveredEntry,
  UndeliveredReason,
} from "./lib/types.js";

export { DEFAULT_LIMITS, createAlerts } from "./lib/alerts.js";

/**
 * Sink adapters. Two real ones, which is what makes `AlertSink` a real seam,
 * plus the recording deliverable that makes hermetic tests structural.
 */
export {
  assertProductionAlerting,
  operationalStreamAlertSink,
  pagingAlertSink,
  recordingAlertSink,
} from "./lib/sinks.js";
export type { RecordingAlertSink } from "./lib/sinks.js";

export { inMemoryAlertJournal } from "./lib/journal.js";
export type { InMemoryAlertJournal } from "./lib/journal.js";

export {
  createHeartbeat,
  createLivenessCheck,
  heartbeatMissedFrom,
  inMemoryLivenessStore,
  livenessFindings,
} from "./lib/heartbeat.js";

/**
 * What an **external** watcher needs, and nothing that pretends to be one.
 * `EXTERNAL_WATCHDOG_REQUIREMENT` is the sentence `RUNBOOK.md` must carry, kept
 * here so the runbook and the code cannot drift.
 */
export { EXTERNAL_WATCHDOG_REQUIREMENT, livenessQuery } from "./lib/external-watchdog.js";
export type { LivenessQuery } from "./lib/external-watchdog.js";

/**
 * The wiring surface — the single call `approval`, `audit`, `evals` and
 * `guardrails` make. See `lib/wiring.ts` for why it is one function rather than
 * four try/catch blocks that disagree.
 */
export { raiseAndRecord } from "./lib/wiring.js";
export type { AlertRaiser, AlertRecord, AlertRecordFields } from "./lib/wiring.js";

/**
 * Named error modes. Every one is fail-closed and none is degradable, because
 * every one is a defect: a float in a payload, an unknown condition, an unusable
 * bound, a chain that pages nobody, a heartbeat nobody watches. **Delivery
 * failures are not errors here** — they are recorded degradations on the
 * returned outcome, so that `try { alert() } catch {}` cannot turn a failed
 * alert back into a silent one.
 */
export {
  AlertError,
  AlertLimitsUnusable,
  AlertPayloadInvalid,
  AlertingMisconfigured,
  ComponentNotWatched,
  LivenessTermsConflict,
  UnknownAlertCondition,
} from "./lib/errors.js";
