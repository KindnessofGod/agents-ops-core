/**
 * The alertable conditions, as a closed union.
 *
 * `docs/CONTEXT.md` tabulates eight failures and says the same thing about every
 * one of them: **it is silent.** Nothing throws, nothing returns non-zero, no
 * request fails, and every dashboard stays green.
 *
 *   1. A reserved decision completed unassisted — *returns success.* A legal
 *      breach reported as a good outcome.
 *   2. An effect is in `unknown` — *nothing failed*; something is merely
 *      unwitnessed. Possible double payment.
 *   3. Reminders have stopped firing — *nothing errored.* The case simply
 *      stopped being chased.
 *   4. A case is buried — *no component is down.* The organisation failed.
 *   5. `AuthorityUnavailable` — *looks like a queue with nothing in it.*
 *   6. Under-recording detected — *the build stays green* unless something
 *      counts what is missing.
 *   7. Trace unavailable at high tier — *fail-closed is correct*, and correct
 *      behaviour is still an incident because work has stopped.
 *   8. Abstention or fail-closed screening rate moved sharply — *every
 *      individual case behaved exactly as designed.*
 *
 * None of the eight is reachable by catching an exception, which is why this
 * module exists at all: **a system that alerts only on thrown errors is
 * monitoring the failures it was going to survive anyway.** Every one of these
 * is raised by something that went looking, not by something that broke.
 *
 * The ninth condition — `heartbeat-missed` — is the absence of an expected
 * event rather than a property of a case, and it is the only one that outranks
 * the rest. See `severity.ts` for the proof of that ordering and
 * `external-watchdog.ts` for why this library cannot be the thing that notices.
 *
 * ## Why every field here is an identifier, an enumerated value or an integer
 *
 * No condition carries free text. There is nowhere to put a claim narrative, a
 * customer name or an approver's email, because a page and an operational
 * stream are read by people and retained by systems that are not the seven-year
 * archive. Identifiers are the application's own; the module contributes no
 * personal data and provides no field in which a caller can smuggle any.
 */

import {
  assertNever,
  type AlertPayload,
  type AuthorityPoolId,
  type BasisPoints,
  type ComponentId,
  type CorrelationId,
  type DecisionPointId,
  type DurationMs,
  type EffectKindId,
  type IdempotencyKeyId,
  type Instant,
  type ReservedRuleId,
  type ReservedStatus,
  type RiskTier,
  type AlertFingerprint,
} from "./primitives.js";
import type { AlertSeverity, CaseSeverity, LivenessSeverity } from "./severity.js";

/** Payload schema version for everything this file emits. Bump on any field change. */
export const CONDITION_PAYLOAD_VERSION = 1;

// --- the eight silent conditions ---------------------------------------------

/**
 * 1. A decision the law or a standing policy reserved to a human was completed
 * without one.
 *
 * Correct unassisted containment for a reserved decision is exactly zero, so any
 * occurrence is a breach rather than a metric movement. It returns success,
 * which is precisely why it needs a check that runs whether or not anything
 * went wrong.
 */
export interface ReservedDecisionCompletedUnassisted {
  readonly kind: "reserved-decision-completed-unassisted";
  readonly correlationId: CorrelationId;
  readonly decisionPoint: DecisionPointId;
  /** The statute or standing policy that reserved it. Names the obligation. */
  readonly reservedRule: ReservedRuleId;
  readonly tier: RiskTier;
}

/**
 * 2. An effect was attempted and its outcome is unrecorded.
 *
 * Not `not-attempted`, which is safe to retry, and not `settled`. `unknown` is
 * never auto-retried — ambiguity resolves toward not paying twice — so this
 * alert is the only thing that moves it, by putting a human on it.
 */
export interface EffectOutcomeUnknown {
  readonly kind: "effect-outcome-unknown";
  readonly correlationId: CorrelationId;
  readonly effectKind: EffectKindId;
  readonly idempotencyKey: IdempotencyKeyId;
  /** How long it has been unwitnessed. Integer milliseconds. */
  readonly unknownForMs: DurationMs;
  readonly tier: RiskTier;
}

/**
 * 3. A case is awaiting an authority and the reminders that were supposed to
 * keep asking have stopped arriving.
 *
 * The recurrence has no "stop" value and no maximum attempt count — the type
 * cannot express giving up — so reminders ceasing is never a legitimate state.
 * It means the thing that fires them is not firing them.
 */
export interface RemindersStopped {
  readonly kind: "reminders-stopped";
  readonly correlationId: CorrelationId;
  /** The declared floor interval of the recurrence. Never accelerates. */
  readonly expectedEveryMs: DurationMs;
  readonly overdueByMs: DurationMs;
  readonly remindersSent: number;
}

/**
 * 4. A buried case: the scheduled ladder steps are spent, the recurrence is
 * running, and nobody has answered.
 *
 * An incident of the organisation, not of the software — which is exactly why it
 * is invisible to every health check. Chasing continues; the case stays
 * answerable indefinitely and never acquires a verdict from the passage of time.
 */
export interface CaseBuried {
  readonly kind: "case-buried";
  readonly correlationId: CorrelationId;
  readonly awaitingForMs: DurationMs;
  readonly scheduledStepsSpent: number;
  readonly recurrenceCycles: number;
  /** Which pool has been widened to and still not answered. */
  readonly pool: AuthorityPoolId;
}

/**
 * 5. There is nobody to escalate to.
 *
 * Looks like a queue with nothing in it. For a reserved decision it is the
 * failure the whole reserved-decision doctrine exists to prevent: no lawful path
 * to a terminal state exists while this holds.
 */
export interface AuthorityUnavailable {
  readonly kind: "authority-unavailable";
  readonly correlationId: CorrelationId;
  readonly pool: AuthorityPoolId;
  readonly reserved: ReservedStatus;
  readonly awaitingForMs: DurationMs;
}

/**
 * 6. Decisions were recorded with no model call under them, and the subject did
 * not declare itself pure.
 *
 * Work happened out of band. The build stays green unless something counts what
 * is missing, and this is that count arriving as an alert rather than as a
 * number nobody reads.
 */
export interface UnderRecordingDetected {
  readonly kind: "under-recording-detected";
  readonly correlationId: CorrelationId;
  readonly decisionsExamined: number;
  readonly decisionsWithoutModelCall: number;
  /** The floor the application declared, in basis points. */
  readonly coverageFloorBasisPoints: BasisPoints;
  readonly observedCoverageBasisPoints: BasisPoints;
}

/**
 * 7. A high-tier decision could not be traced, so it did not proceed.
 *
 * Fail-closed is correct here and is not in question. It is still an incident,
 * because correct behaviour that stops a £2M disbursement is an outage with a
 * clean conscience.
 */
export interface TraceUnavailableAtHighTier {
  readonly kind: "trace-unavailable-at-high-tier";
  readonly correlationId: CorrelationId;
  /** Mirrors `audit`'s `TraceUnavailableReason`, so the two agree in a report. */
  readonly reason: "store-failure" | "backpressure" | "capacity";
}

/**
 * 8. A population statistic moved sharply.
 *
 * Every individual case behaved exactly as designed, which is what makes this
 * undetectable per case. It has **no correlation identifier** — it is a property
 * of a window, not of a case — and it is the one condition that is a `notice`:
 * it wants a human to look, not a human woken up.
 */
export interface RateMovedSharply {
  readonly kind: "rate-moved-sharply";
  readonly measure: "abstention" | "fail-closed-screening";
  readonly windowMs: DurationMs;
  readonly baselineBasisPoints: BasisPoints;
  readonly observedBasisPoints: BasisPoints;
  /** How many cases the observation is drawn from. A move over eleven cases is noise. */
  readonly sampleSize: number;
  /** Which decision point the window covers. */
  readonly decisionPoint: DecisionPointId;
}

// --- the ninth: the one that outranks the rest -------------------------------

/**
 * When a component was last seen, as a closed pair.
 *
 * "Stopped beating" and "never beat at all" are different sentences to say to an
 * operator: the first is a component that died, the second is a component that
 * was deployed without ever starting, or a watcher pointed at a name nothing
 * emits. Collapsing them would hide the second inside the first, which is the
 * same class of error as letting "nothing was due" share a representation with
 * "I did not run".
 */
export type LastSeen =
  | { readonly seen: "beat"; readonly at: Instant }
  | { readonly seen: "never"; readonly watchingSince: Instant };

/**
 * 9. A component has stopped proving it is alive.
 *
 * The highest severity in the system, and the ordering is proved in
 * `severity.ts` rather than asserted here. One stalled case is one customer; a
 * stopped sweeper is every waiting case at once.
 *
 * **This library cannot raise this condition about itself and be believed.** See
 * `external-watchdog.ts`.
 */
export interface HeartbeatMissed {
  readonly kind: "heartbeat-missed";
  readonly component: ComponentId;
  readonly expectedEveryMs: DurationMs;
  readonly overdueByMs: DurationMs;
  readonly lastSeen: LastSeen;
  readonly beatsObserved: number;
}

// --- the closed union --------------------------------------------------------

/** The eight from `docs/CONTEXT.md`. Every one of them silent, every one of them per-case or per-population. */
export type SilentCondition =
  | ReservedDecisionCompletedUnassisted
  | EffectOutcomeUnknown
  | RemindersStopped
  | CaseBuried
  | AuthorityUnavailable
  | UnderRecordingDetected
  | TraceUnavailableAtHighTier
  | RateMovedSharply;

/** The ninth, kept separate because its severity is a different kind of thing. */
export type LivenessCondition = HeartbeatMissed;

/** Everything this module can be asked to raise. Closed. */
export type AlertCondition = SilentCondition | LivenessCondition;

export type AlertConditionKind = AlertCondition["kind"];
export type SilentConditionKind = SilentCondition["kind"];

/**
 * Severity is a property of the **condition**, not a parameter.
 *
 * A caller cannot page for a rate movement, and — the half that matters —
 * cannot file a missed heartbeat as a notice. There is no argument to get
 * wrong at 4pm on a Friday.
 *
 * Total by `satisfies`: a ninth condition added to the union without a severity
 * is a compile error **here**, before it is a gap in production.
 */
export const SEVERITY_BY_CONDITION = {
  // A legal obligation has already been breached; the record says it went well.
  "reserved-decision-completed-unassisted": "incident",
  // Money may have moved twice. Nothing will tell us on its own.
  "effect-outcome-unknown": "incident",
  // No lawful terminal state is reachable while this holds.
  "authority-unavailable": "incident",
  // The evidence for decisions that were made is not there.
  "under-recording-detected": "incident",
  // Correct, fail-closed, and work has stopped.
  "trace-unavailable-at-high-tier": "incident",

  // The machinery promised to keep asking and is not asking.
  "reminders-stopped": "degraded",
  // Deliberately not `incident`. `docs/CONTEXT.md` calls a buried case an
  // incident of the ORGANISATION, and it is right — but this severity addresses
  // an OPERATOR, and no part of the machinery is broken. Paging an engineer at
  // 3am for a case a manager must answer trains them to ignore the channel,
  // which is the exact failure the escalation/alert separation exists to
  // prevent. It is loud, it is recorded, it is not a page.
  "case-buried": "degraded",

  // Every case behaved as designed. This wants a human to look, in the morning.
  "rate-moved-sharply": "notice",

  // Above all of them. Proved in severity.ts, not asserted here.
  "heartbeat-missed": "liveness-lost",
} as const satisfies Record<AlertConditionKind, AlertSeverity>;

export type SeverityOfKind<K extends AlertConditionKind> = (typeof SEVERITY_BY_CONDITION)[K];

type Assert<T extends true> = T;

/**
 * The two halves of requirement (b), proved rather than described.
 *
 * Together with `LivenessOutranksEveryCaseAlert` in `severity.ts` this says: a
 * missed heartbeat carries the liveness severity, every other condition carries
 * a per-case severity, and every per-case severity ranks strictly below the
 * liveness one. Break any of the three and the build fails.
 */
export type HeartbeatCarriesTheLivenessSeverity = Assert<
  SeverityOfKind<"heartbeat-missed"> extends LivenessSeverity ? true : false
>;

export type EverySilentConditionIsAPerCaseSeverity = Assert<
  SeverityOfKind<SilentConditionKind> extends CaseSeverity ? true : false
>;

/** The severity of a condition. Derived, never supplied. */
export const severityOf = (condition: AlertCondition): AlertSeverity =>
  SEVERITY_BY_CONDITION[condition.kind];

/**
 * Which case an alert is about, or `undefined` where the condition is not about
 * a case at all.
 *
 * Written as an exhaustive switch on purpose. Requirement (g) says an alert is
 * recorded into the trace **where a correlation identifier exists**, and this is
 * where that question is answered — so adding a condition forces its author to
 * answer it, rather than inheriting `undefined` from a lookup that quietly
 * missed a key.
 */
export const correlationOf = (condition: AlertCondition): CorrelationId | undefined => {
  switch (condition.kind) {
    case "reserved-decision-completed-unassisted":
    case "effect-outcome-unknown":
    case "reminders-stopped":
    case "case-buried":
    case "authority-unavailable":
    case "under-recording-detected":
    case "trace-unavailable-at-high-tier":
      return condition.correlationId;
    // A window over a population is not a case.
    case "rate-moved-sharply":
      return undefined;
    // And a component that stopped running has no case either. This is the one
    // the requirement names: the alert still emits, it simply cannot be a node
    // on a trace, because there is no trace it belongs to.
    case "heartbeat-missed":
      return undefined;
    default:
      return assertNever(condition, "correlationOf");
  }
};

/**
 * The dedupe key: identity fields only.
 *
 * A flapping condition must collapse into one alert with a count, not into a
 * thousand alerts. So the fingerprint deliberately excludes every measurement —
 * `overdueByMs`, `unknownForMs`, `observedBasisPoints` — because including one
 * would make every observation a new fingerprint and suppression would silently
 * do nothing at all. That is the failure mode this comment exists to prevent.
 */
export const fingerprintOf = (condition: AlertCondition): AlertFingerprint => {
  const parts = ((): readonly string[] => {
    switch (condition.kind) {
      case "reserved-decision-completed-unassisted":
        return [condition.correlationId, condition.decisionPoint, condition.reservedRule];
      case "effect-outcome-unknown":
        return [condition.correlationId, condition.effectKind, condition.idempotencyKey];
      case "reminders-stopped":
        return [condition.correlationId];
      case "case-buried":
        return [condition.correlationId, condition.pool];
      case "authority-unavailable":
        return [condition.correlationId, condition.pool];
      case "under-recording-detected":
        return [condition.correlationId];
      case "trace-unavailable-at-high-tier":
        return [condition.correlationId, condition.reason];
      case "rate-moved-sharply":
        return [condition.measure, condition.decisionPoint];
      case "heartbeat-missed":
        return [condition.component];
      default:
        return assertNever(condition, "fingerprintOf");
    }
  })();
  return [condition.kind, ...parts].join("|") as AlertFingerprint;
};

/**
 * The flat, integer-only, versioned form — what a sink transmits and what the
 * journal records as a node.
 *
 * Exhaustive by the same mechanism. Note what is *not* copied: nothing, from any
 * condition. Every field of every condition is already an identifier, an
 * enumerated value or an integer, so the payload is the condition, flattened —
 * there is no summarising step in which a field could be lost or a narrative
 * could be introduced.
 */
export const payloadOf = (condition: AlertCondition): AlertPayload => {
  const base = { kind: `alert.${condition.kind}`, v: CONDITION_PAYLOAD_VERSION } as const;
  switch (condition.kind) {
    case "reserved-decision-completed-unassisted":
      return {
        ...base,
        correlationId: condition.correlationId,
        decisionPoint: condition.decisionPoint,
        reservedRule: condition.reservedRule,
        tier: condition.tier,
      };
    case "effect-outcome-unknown":
      return {
        ...base,
        correlationId: condition.correlationId,
        effectKind: condition.effectKind,
        idempotencyKey: condition.idempotencyKey,
        unknownForMs: condition.unknownForMs,
        tier: condition.tier,
      };
    case "reminders-stopped":
      return {
        ...base,
        correlationId: condition.correlationId,
        expectedEveryMs: condition.expectedEveryMs,
        overdueByMs: condition.overdueByMs,
        remindersSent: condition.remindersSent,
      };
    case "case-buried":
      return {
        ...base,
        correlationId: condition.correlationId,
        awaitingForMs: condition.awaitingForMs,
        scheduledStepsSpent: condition.scheduledStepsSpent,
        recurrenceCycles: condition.recurrenceCycles,
        pool: condition.pool,
      };
    case "authority-unavailable":
      return {
        ...base,
        correlationId: condition.correlationId,
        pool: condition.pool,
        reserved: condition.reserved,
        awaitingForMs: condition.awaitingForMs,
      };
    case "under-recording-detected":
      return {
        ...base,
        correlationId: condition.correlationId,
        decisionsExamined: condition.decisionsExamined,
        decisionsWithoutModelCall: condition.decisionsWithoutModelCall,
        coverageFloorBasisPoints: condition.coverageFloorBasisPoints,
        observedCoverageBasisPoints: condition.observedCoverageBasisPoints,
      };
    case "trace-unavailable-at-high-tier":
      return {
        ...base,
        correlationId: condition.correlationId,
        reason: condition.reason,
      };
    case "rate-moved-sharply":
      return {
        ...base,
        measure: condition.measure,
        decisionPoint: condition.decisionPoint,
        windowMs: condition.windowMs,
        baselineBasisPoints: condition.baselineBasisPoints,
        observedBasisPoints: condition.observedBasisPoints,
        sampleSize: condition.sampleSize,
      };
    case "heartbeat-missed":
      return {
        ...base,
        component: condition.component,
        expectedEveryMs: condition.expectedEveryMs,
        overdueByMs: condition.overdueByMs,
        beatsObserved: condition.beatsObserved,
        lastSeen: condition.lastSeen.seen,
        lastSeenAt:
          condition.lastSeen.seen === "beat"
            ? condition.lastSeen.at
            : condition.lastSeen.watchingSince,
      };
    default:
      return assertNever(condition, "payloadOf");
  }
};
