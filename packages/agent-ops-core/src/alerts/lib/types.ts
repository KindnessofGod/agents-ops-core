/**
 * The seams and the shapes that cross them.
 *
 * Two brands live here, both `declare const … : unique symbol`, both
 * unexported from `index.ts`. A brand costs nothing at runtime and buys the one
 * thing a structural type system cannot otherwise give: an object a caller
 * outside this module is unable to name, and therefore unable to forge.
 */

import type {
  AlertFingerprint,
  AlertId,
  AlertPayload,
  AlertSinkId,
  AlertTimers,
  Clock,
  ComponentId,
  CorrelationId,
  DurationMs,
  Instant,
  NonEmpty,
  OperatorRotaId,
} from "./primitives.js";
import type { AlertCondition, AlertConditionKind, HeartbeatMissed, LastSeen } from "./conditions.js";
import type { AlertSeverity } from "./severity.js";

// --- the alert ---------------------------------------------------------------

declare const alertBrand: unique symbol;

/**
 * One raised alert.
 *
 * Branded, so a caller cannot assemble one and hand it straight to a sink. That
 * is not paranoia about forgery — it is what keeps suppression, the ordered
 * chain, the journal and the health ledger on the only path an alert can take.
 * A sink that could be called directly is a sink that can be called without any
 * of them.
 *
 * Every field is assigned by this module: the time from the injected clock, the
 * severity from the condition, the fingerprint from the condition's identity,
 * the sequence from a counter. A caller supplies a condition and nothing else.
 */
export interface Alert {
  readonly [alertBrand]: true;
  readonly id: AlertId;
  /** Milliseconds since epoch, from the injected clock. Never `Date.now()`. */
  readonly at: Instant;
  /** Derived from `condition`. There is no parameter for this. */
  readonly severity: AlertSeverity;
  readonly condition: AlertCondition;
  readonly fingerprint: AlertFingerprint;
  /**
   * The case this is about, where there is one. `undefined` for a missed
   * heartbeat and for a population statistic — and the alert still emits.
   */
  readonly correlationId: CorrelationId | undefined;
  /**
   * How many identical occurrences were collapsed while this fingerprint was
   * inside its suppression window.
   *
   * **Reported, never lost.** Suppression collapses repeats; it does not silence
   * a condition. An alert that fires after four hundred suppressed repeats says
   * four hundred, and an operator reading it learns that the condition is
   * flapping rather than that it happened once.
   */
  readonly suppressedSinceLastDelivery: number;
  /** Monotonic within one `Alerts`. Makes a page idempotent at the transport. */
  readonly sequence: number;
  /** The flat, integer-only, versioned form. Identical for every sink. */
  readonly payload: AlertPayload;
}

/** Mints the brand. Called in exactly one place — `raise`. */
export const asAlert = (impl: Omit<Alert, typeof alertBrand>): Alert => impl as Alert;

// --- the sink seam -----------------------------------------------------------

declare const alertSinkBrand: unique symbol;

/**
 * What a sink actually does with an alert.
 *
 * The composition root asserts on this, which is why it is a declared property
 * rather than something inferred from a class name. `docs/design/
 * OPEN-ITEMS-RESOLVED.md` item 6: *"An `AlertSink` that swallows everything is a
 * legitimate test adapter and an illegitimate production one — so it is branded,
 * and the production wiring is asserted at the composition root rather than
 * assumed."*
 */
export type SinkDelivery =
  /** Wakes a human now, through an injected transport. */
  | "page"
  /** Writes a structured record to an operational stream a human reads later. */
  | "operational-stream"
  /** Keeps it in memory. A deliverable for tests, and never a production chain. */
  | "in-memory";

/**
 * What a sink says back.
 *
 * `accepted: false` is **routing, not failure**: a paging sink declining a
 * `notice` is the design working, and the chain moves to the next sink without
 * recording a degradation. A throw is failure, and is recorded.
 */
export type SinkAck =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly why: "severity-not-accepted" };

/**
 * **The seam.** Two shipped adapters that genuinely differ — `pagingAlertSink`
 * over an injected transport, and `operationalStreamAlertSink` over an injected
 * structured stream — plus `recordingAlertSink`, which is a deliverable for
 * tests in the same sense `inMemoryTraceStore` is, and is refused by
 * `assertProductionAlerting`.
 *
 * **Structurally separate from every escalation path.** An `AlertSink` takes an
 * `Alert`, which carries no brief, no verdict, no authority and no effect, and a
 * sink is addressed to an `OperatorRotaId`, which an `AuthorityRef` does not
 * typecheck as. There is no shape of call that routes a decision to an authority
 * through here, and no shape of call that routes an alert to an approver. That
 * is the separation `docs/CONTEXT.md` demands, made unavailable rather than
 * discouraged: *"Mixed into one channel, the routine volume mutes the
 * exceptional signal."*
 *
 * Every adapter owes three things:
 *
 *   1. `deliver` **resolves** when the alert has left the process, and rejects
 *      only when it has not. A sink that resolves without delivering is
 *      indistinguishable from one that delivered, exactly as an acknowledging
 *      trace store is — see `audit`'s note on the same limit.
 *   2. It carries no personal data of its own into the channel. The payload it
 *      is given is already flat, integer-only and free-text-free.
 *   3. It is bounded. It does not retry internally and it does not queue without
 *      limit; the chain is the redundancy, and the caller's deadline is the
 *      bound.
 */
export interface AlertSink {
  readonly [alertSinkBrand]: true;
  readonly id: AlertSinkId;
  readonly delivery: SinkDelivery;
  /**
   * Which severities this sink is willing to take. Non-empty, and read by
   * `assertProductionAlerting` to prove the chain covers all four **before** the
   * first alert rather than by discovering a gap during an incident.
   */
  readonly accepts: NonEmpty<AlertSeverity>;
  deliver(alert: Alert): Promise<SinkAck>;
}

/**
 * Mints the sink brand. Called only by the three adapter factories in
 * `sinks.ts`, and not exported from `index.ts` — so "who is allowed to be a
 * sink" is one grep away, and a two-line object literal is not the answer.
 */
export const asAlertSink = (impl: Omit<AlertSink, typeof alertSinkBrand>): AlertSink =>
  impl as AlertSink;

// --- what a paging adapter is driven by --------------------------------------

/**
 * What the paging adapter hands to whatever actually reaches a human.
 *
 * Flat, integer-only, and carrying `idempotencyKey` so a transport that retries
 * on its own does not wake the same person twice for one alert.
 */
export interface PageRequest {
  readonly sink: AlertSinkId;
  readonly rota: OperatorRotaId;
  readonly severity: AlertSeverity;
  /** The numeric rank, so a transport can threshold without knowing our words. */
  readonly severityRank: number;
  readonly condition: AlertConditionKind;
  readonly fingerprint: AlertFingerprint;
  readonly correlationId: CorrelationId | undefined;
  readonly at: Instant;
  readonly suppressedSinceLastDelivery: number;
  /** Stable per alert. A transport-level retry is not a second page. */
  readonly idempotencyKey: string;
  readonly detail: AlertPayload;
}

/**
 * **The injected transport.** This module constructs no HTTP client, opens no
 * socket, and reads no URL, token or routing key from the environment.
 *
 * That is not a style preference. It is the only way a test can be *unable* to
 * reach a real pager with real credentials present in the environment: there is
 * no code path from this package to a network, so no flag and no `if
 * (process.env.CI)` is needed, and none would be trusted if it were.
 */
export interface PageTransport {
  send(request: PageRequest): Promise<void>;
}

/**
 * A structured operational stream — the lower-severity channel. One record per
 * alert, flat and integer-only, so it is greppable in 2033 and cheap now.
 *
 * `write` may be synchronous. A stream adapter that buffers must bound its
 * buffer; this module bounds only what it owns.
 */
export interface OperationalStream {
  write(record: OperationalRecord): void | Promise<void>;
}

/** One line on the operational stream. */
export interface OperationalRecord {
  readonly stream: "agent-ops-core.alerts";
  readonly sink: AlertSinkId;
  readonly severity: AlertSeverity;
  readonly severityRank: number;
  readonly condition: AlertConditionKind;
  readonly fingerprint: AlertFingerprint;
  readonly correlationId: CorrelationId | undefined;
  readonly at: Instant;
  readonly sequence: number;
  readonly suppressedSinceLastDelivery: number;
  readonly detail: AlertPayload;
}

// --- the journal seam --------------------------------------------------------

/**
 * Where an alert is recorded as evidence.
 *
 * Requirement (g): an alert is recorded into the trace **as a node** where a
 * correlation identifier exists; where none exists the alert still emits. So
 * this seam is optional in `AlertsDeps` and never blocks delivery: the journal
 * is written *after* the chain has been walked, so that what is recorded is the
 * delivery outcome — including every degradation — rather than an intention.
 *
 * **Seam accounting: two adapters, so this is a real seam by C5.**
 * `inMemoryAlertJournal` is the fast one. `auditBackedAlertJournal` turns an
 * `AlertJournalEntry` into a node on the case's own trace — and takes the trace
 * as a **parameter** rather than importing `audit`, because `audit` already
 * imports `alerts.raiseAndRecord` and an import back would be a cycle the
 * boundary lint fails on. `audit`'s `Audit` satisfies the parameter structurally,
 * with no adapter and no cast; see `lib/journal.ts` for the direction note.
 */
declare const alertJournalBrand: unique symbol;

export interface AlertJournal {
  readonly [alertJournalBrand]: true;
  /**
   * Record one alert and what happened to it. Must not throw for an operational
   * problem — return a rejected promise instead, and the module records the
   * journal failure without losing the alert.
   */
  record(entry: AlertJournalEntry): Promise<void>;
}

export const asAlertJournal = (impl: Omit<AlertJournal, typeof alertJournalBrand>): AlertJournal =>
  impl as AlertJournal;

/**
 * What is recorded. The payload is already node-shaped — flat, integer-only,
 * versioned — so an `audit`-backed adapter is a `record` call and not a
 * translation layer.
 */
export interface AlertJournalEntry {
  readonly alertId: AlertId;
  readonly correlationId: CorrelationId;
  readonly at: Instant;
  readonly severity: AlertSeverity;
  readonly condition: AlertConditionKind;
  readonly fingerprint: AlertFingerprint;
  readonly payload: AlertPayload;
  /** Which sink took it, if any. */
  readonly deliveredBy: AlertSinkId | undefined;
  /** Every sink that failed on the way, in the order they failed. */
  readonly degradations: readonly SinkDegradation[];
  readonly outcome: "delivered" | "undelivered";
}

/** Why the journal did not record an alert. Never a reason to lose the alert. */
export type JournalOutcome =
  | { readonly journalled: true }
  /** The condition has no case. A missed heartbeat is not a node on any trace. */
  | { readonly journalled: false; readonly why: "no-correlation-identifier" }
  /** No journal was wired. Legitimate, and visible rather than assumed. */
  | { readonly journalled: false; readonly why: "no-journal-configured" }
  /** The journal itself failed. The alert was still delivered. */
  | { readonly journalled: false; readonly why: "journal-failed"; readonly detail: string };

// --- degradation and outcomes ------------------------------------------------

/**
 * A sink that failed, recorded rather than swallowed.
 *
 * Requirement (f): *failure to alert is itself alertable.* An `AlertSink` that
 * throws must not take the case down with it and must not fail silently. It
 * degrades to the next sink in the chain, and the degradation lands here — on
 * the returned outcome, in the journal entry, and in `health()`, which is what
 * the external watcher reads.
 */
export interface SinkDegradation {
  readonly sink: AlertSinkId;
  readonly reason:
    /** `deliver` rejected. */
    | "threw"
    /** `deliver` did not settle within `deliveryTimeoutMs`. */
    | "timed-out"
    /** `deliver` resolved with something that is not a `SinkAck`. */
    | "contract-violated";
  /** A bounded, non-personal description. Never an exception's stack. */
  readonly detail: string;
  readonly at: Instant;
}

/** Why an alert reached nobody. Every value is loud in `health()`. */
export type UndeliveredReason =
  /** Every sink in the chain failed. The chain was the redundancy; it is gone. */
  | "every-sink-failed"
  /**
   * Every sink declined the severity. A **misconfiguration**, and the reason
   * `assertProductionAlerting` exists: this is discoverable at startup and must
   * not first be discovered during an incident.
   */
  | "declined-by-every-sink"
  /** The bounded delivery queue was full. Bounded means something is shed. */
  | "delivery-queue-full";

/**
 * What `raise` returns. It does **not** throw for a delivery problem: an alert
 * about a stalled case must never be the thing that takes the case down.
 *
 * It is a discriminated union rather than `void` so that a caller cannot ignore
 * an undelivered alert by accident — and so the fact is available to the
 * composition root even when every sink is gone.
 */
export type AlertOutcome =
  | {
      readonly outcome: "delivered";
      readonly alert: Alert;
      readonly by: AlertSinkId;
      readonly degradations: readonly SinkDegradation[];
      readonly journal: JournalOutcome;
    }
  | {
      readonly outcome: "suppressed";
      readonly fingerprint: AlertFingerprint;
      readonly severity: AlertSeverity;
      /** Including this one. Reported when the window ends and it fires. */
      readonly suppressedSinceLastDelivery: number;
      readonly nextEligibleAt: Instant;
    }
  | {
      readonly outcome: "undelivered";
      readonly alert: Alert;
      readonly reason: UndeliveredReason;
      readonly degradations: readonly SinkDegradation[];
      readonly journal: JournalOutcome;
    };

/** One row of the bounded last-resort ledger. */
export interface UndeliveredEntry {
  readonly alertId: AlertId;
  readonly at: Instant;
  readonly severity: AlertSeverity;
  readonly condition: AlertConditionKind;
  readonly fingerprint: AlertFingerprint;
  readonly correlationId: CorrelationId | undefined;
  readonly reason: UndeliveredReason;
  readonly degradations: readonly SinkDegradation[];
}

/**
 * What an **external** watcher reads to answer "is the alerting itself working?"
 *
 * This is the honest bottom of requirement (f). Failure to alert is alertable —
 * but an alert about the alerting being down cannot be delivered by the alerting
 * that is down, and pretending otherwise is the infinite regress that makes
 * monitoring stories dishonest. So the fact is *recorded*, *returned to the
 * caller*, and *published here*, where something outside this process reads it.
 * Everything in it is a bounded integer or a bounded list.
 */
export interface AlertingHealth {
  readonly raised: number;
  readonly delivered: number;
  readonly suppressed: number;
  /** Monotonic. Never reset by anything inside this module. */
  readonly undelivered: number;
  /** Monotonic count of sink failures — the chain degrading. */
  readonly degradations: number;
  /** Alerts whose journal write failed. Delivered, but not evidenced. */
  readonly journalFailures: number;
  /** In flight now, and the high-water mark since construction. */
  readonly inFlight: number;
  readonly inFlightHighWater: number;
  readonly queueDepth: number;
  /** Fingerprints evicted from the suppression table, so it stayed bounded. */
  readonly suppressionEvictions: number;
  /** Fingerprints currently inside a suppression window. */
  readonly suppressedFingerprints: number;
  /**
   * Collapsed-repeat counts lost when the bounded suppression table evicted a
   * fingerprint. Small, and published rather than discarded — an eviction makes
   * the next alert fire immediately, so nothing is silenced, but the count it
   * would have carried is gone and saying so is cheaper than pretending.
   */
  readonly suppressionRepeatsLost: number;
  readonly bySeverity: Readonly<Record<AlertSeverity, number>>;
  /** Most recent first. Bounded by `ledgerSize`. */
  readonly ledger: readonly UndeliveredEntry[];
  /** How many rows fell off the end of the bounded ledger. Never invisible. */
  readonly ledgerDropped: number;
}

// --- liveness ----------------------------------------------------------------

/**
 * What a component says about a run.
 *
 * A union rather than a flag, because *"nothing was due"* and *"I did not run"*
 * must not share a representation — for exactly the reason `not-attempted` and
 * `unknown` do not in `approval`. A sweeper with an empty queue has run
 * correctly and must be able to say so; a sweeper that is dead says nothing at
 * all, and the absence is what `livenessFindings` detects.
 *
 * Note the shape: `nothing-was-due` has no `itemsProcessed` field, so "I did
 * nothing" cannot be spelled as "I did zero things" and later be confused with
 * a component that processed a batch of zero.
 */
export type HeartbeatRun =
  | { readonly ran: "did-work"; readonly itemsProcessed: number }
  | { readonly ran: "nothing-was-due" };

declare const livenessStoreBrand: unique symbol;

/**
 * Where beats are kept.
 *
 * **Seam accounting: two adapters, so this is a real seam by C5.**
 * `inMemoryLivenessStore` is the fast one and its beat history dies with the
 * process. `postgresLivenessStore` is the durable one, over an injected
 * `SqlExecutor` — no driver is imported anywhere in this package — and it is
 * what makes a heartbeat mean anything across a restart: a watcher polling
 * across a deploy reads a real gap with a real `lastSeenAt`, rather than
 * `never-seen`, which it cannot tell from a component that was never started.
 *
 * The two are held to the same obligations by `livenessStoreContract`, which is
 * runnable with no database (both shipped adapters, in continuous integration)
 * and against a live pool from an operational script. Two adapters that quietly
 * disagree would be worse than one.
 *
 * Every adapter owes:
 *
 *   1. **`watch` before `beat`.** A component nobody is watching for cannot
 *      emit — see `ComponentNotWatched`. A heartbeat nobody watches is a
 *      heartbeat that can stop unnoticed, which is the whole failure.
 *   2. **Monotonic `at`.** Under concurrent writers and under clock skew, the
 *      recorded last-beat never moves backwards.
 *   3. **Store-assigned sequence**, incremented inside the same critical section
 *      that writes, exactly as `audit` assigns node sequences.
 *   4. **Refusal of a beat that cannot be recorded byte-stably** — a fractional
 *      instant, an unsafe integer, a negative item count. See
 *      `LivenessBeatUnrecordable`, and obligation 6 of the contract.
 */
export interface LivenessStore {
  readonly [livenessStoreBrand]: true;
  /** Declare that a component is expected to beat. Idempotent on identical terms. */
  watch(component: ComponentId, expectedEveryMs: DurationMs, since: Instant): Promise<void>;
  /** Record one beat. Raises `ComponentNotWatched` if nobody is watching. */
  beat(component: ComponentId, at: Instant, run: HeartbeatRun): Promise<LivenessRecord>;
  /** Everything being watched. What an external watcher reads. */
  snapshot(): Promise<readonly LivenessRecord[]>;
}

export const asLivenessStore = (
  impl: Omit<LivenessStore, typeof livenessStoreBrand>,
): LivenessStore => impl as LivenessStore;

/**
 * One component's liveness, as an external watcher sees it.
 *
 * `emptyBeats` and `workingBeats` are counted separately on purpose. A sweeper
 * that reports `nothing-was-due` forever is alive and idle; a sweeper that
 * reports work forever is alive and behind. Both are alive, and an operator
 * wants to tell them apart without reading a log.
 */
export interface LivenessRecord {
  readonly component: ComponentId;
  readonly expectedEveryMs: DurationMs;
  readonly watchingSince: Instant;
  readonly beats: number;
  readonly emptyBeats: number;
  readonly workingBeats: number;
  readonly itemsProcessed: number;
  readonly lastSeen: LastSeen;
  readonly lastRun: HeartbeatRun | undefined;
  /** Store-assigned, monotonic per component. */
  readonly sequence: number;
}

/** Acknowledgement of one beat. */
export interface BeatReceipt {
  readonly component: ComponentId;
  readonly at: Instant;
  readonly run: HeartbeatRun;
  readonly sequence: number;
}

/** The emit side. One verb, and it cannot be called for an unwatched component. */
export interface Heartbeat {
  /**
   * Prove liveness for this run — **including a run with nothing to do**. A
   * component that only beats when it did work is indistinguishable from a dead
   * one on a quiet night.
   */
  beat(input: { readonly component: ComponentId; readonly run: HeartbeatRun }): Promise<BeatReceipt>;
}

/**
 * What the checker concluded about one component. Three states, because
 * "stopped" and "never started" are different problems with different fixes.
 */
export type LivenessFinding =
  | {
      readonly status: "alive";
      readonly component: ComponentId;
      readonly sinceLastBeatMs: DurationMs;
      readonly expectedEveryMs: DurationMs;
      readonly lastRun: HeartbeatRun;
    }
  | {
      readonly status: "overdue";
      readonly component: ComponentId;
      readonly overdueByMs: DurationMs;
      readonly expectedEveryMs: DurationMs;
      readonly lastSeenAt: Instant;
      readonly beats: number;
    }
  | {
      readonly status: "never-seen";
      readonly component: ComponentId;
      readonly overdueByMs: DurationMs;
      readonly expectedEveryMs: DurationMs;
      readonly watchingSince: Instant;
    };

/** How much late is late. Required — there is no defensible default grace. */
export interface LivenessTolerance {
  /**
   * Added to `expectedEveryMs` before a component is called overdue. A sweeper
   * on a 60s cadence that is 61s late is not news; one that is 300s late is.
   * Required rather than defaulted, because the right value is a property of the
   * deployment's scheduler jitter, which this library cannot know.
   */
  readonly graceMs: DurationMs;
}

// --- construction ------------------------------------------------------------

/**
 * Bounds. Every one of them exists because the alternative is unbounded, and an
 * unbounded queue in the alerting path is how a flapping condition becomes the
 * outage.
 */
export interface AlertLimits {
  /**
   * How long one fingerprint stays collapsed after firing. Repeats inside the
   * window are counted, not delivered — and the count is reported when it next
   * fires. **Suppression never silences a condition entirely**: the first
   * occurrence always fires, and every window ends.
   */
  readonly suppressionWindowMs: DurationMs;
  /** Ceiling on the suppression table. Eviction makes an alert LOUDER, never quieter. */
  readonly maxTrackedFingerprints: number;
  /** Concurrent walks of the sink chain. */
  readonly maxInFlightDeliveries: number;
  /** Waiting room for raises above the in-flight bound. Full means shed, loudly. */
  readonly maxQueuedRaises: number;
  /** Per sink, per alert. There is no retry — the chain is the redundancy. */
  readonly deliveryTimeoutMs: DurationMs;
  /** Rows kept in the last-resort ledger `health()` publishes. */
  readonly ledgerSize: number;
  /** Ceiling on any identifier a caller supplies. Bounds a page, and a payload. */
  readonly maxIdentifierChars: number;
}

export interface AlertsDeps {
  /**
   * The ordered chain. Tried in order; the first to accept ends the walk.
   * Non-empty in the type — a chain with no sinks is not a degraded alerting
   * system, it is no alerting system, and it should not be constructible.
   */
  readonly sinks: NonEmpty<AlertSink>;
  readonly clock: Clock;
  readonly timers: AlertTimers;
  /** Optional. Where absent, alerts still emit — and `health()` says they were not journalled. */
  readonly journal?: AlertJournal | undefined;
  readonly limits?: Partial<AlertLimits> | undefined;
}

/**
 * The interface. Two verbs, and the second is the one an external watcher reads.
 *
 * There is no `close`, no `flush` and no `drain`: `raise` resolves when the
 * alert has been through the chain, so there is never buffered work to lose at
 * shutdown. That is a deliberate cost — `raise` is awaited on the alerting path
 * — and it is the right one, because an alert that is still in a buffer when the
 * process dies is an alert nobody ever gets.
 */
export interface Alerts {
  /**
   * Raise a condition. Never throws for a delivery problem; throws only for a
   * caller defect (`AlertPayloadInvalid`, `UnknownAlertCondition`).
   */
  raise(condition: AlertCondition): Promise<AlertOutcome>;
  /** Bounded, integer-only, and safe to poll. See `AlertingHealth`. */
  health(): AlertingHealth;
}

export interface HeartbeatDeps {
  readonly store: LivenessStore;
  readonly clock: Clock;
}

export interface LivenessCheckDeps {
  readonly store: LivenessStore;
  readonly clock: Clock;
  readonly tolerance: LivenessTolerance;
  /**
   * Optional. Where present, `check()` raises `heartbeat-missed` for every
   * component that is overdue or never seen.
   *
   * **Optional on purpose.** The watcher that matters runs outside this process
   * and may have its own alerting; see `external-watchdog.ts`. Wiring this is
   * how a *second*, in-process check is built — useful, and never sufficient.
   */
  readonly alerts?: Alerts | undefined;
}

/** What a liveness check produced. */
export interface LivenessCheckReport {
  readonly at: Instant;
  readonly findings: readonly LivenessFinding[];
  /** The conditions that were raised, if an `Alerts` was wired. */
  readonly raised: readonly HeartbeatMissed[];
  readonly outcomes: readonly AlertOutcome[];
}

export interface LivenessCheck {
  check(): Promise<LivenessCheckReport>;
}
