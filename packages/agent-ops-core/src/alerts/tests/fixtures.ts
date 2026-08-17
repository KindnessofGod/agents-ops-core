/**
 * Fixtures. Everything here crosses the same seam a caller crosses: this file
 * imports `../index.js` and nothing else from the module, which is what makes
 * "tests exercise the interface" structural rather than aspirational.
 *
 * Nothing in this file can reach a network, and that is not a discipline — the
 * transports and streams below are objects a test holds, and the module never
 * constructs one of its own. A test could not page a real engineer if it tried.
 */

import type {
  AlertConditionKind,
  AlertSeverity,
  AlertSink,
  AlertTimers,
  AuthorityPoolId,
  Clock,
  ComponentId,
  CorrelationId,
  DecisionPointId,
  EffectKindId,
  IdempotencyKeyId,
  OperationalRecord,
  OperationalStream,
  OperatorRotaId,
  PageRequest,
  PageTransport,
  ReservedRuleId,
  AlertSinkId,
} from "../index.js";
import {
  createAlerts,
  inMemoryAlertJournal,
  operationalStreamAlertSink,
  pagingAlertSink,
  recordingAlertSink,
} from "../index.js";

// --- branded-identifier constructors, so a test reads like a call site -------

export const CASE = (id: string): CorrelationId => id as CorrelationId;
export const COMPONENT = (id: string): ComponentId => id as ComponentId;
export const POINT = (id: string): DecisionPointId => id as DecisionPointId;
export const RULE = (id: string): ReservedRuleId => id as ReservedRuleId;
export const EFFECT = (id: string): EffectKindId => id as EffectKindId;
export const KEY = (id: string): IdempotencyKeyId => id as IdempotencyKeyId;
export const POOL = (id: string): AuthorityPoolId => id as AuthorityPoolId;
export const ROTA = (id: string): OperatorRotaId => id as OperatorRotaId;
export const SINK = (id: string): AlertSinkId => id as AlertSinkId;

// --- injected time -----------------------------------------------------------

export interface TestClock extends Clock {
  advance(millis: number): void;
  set(millis: number): void;
}

/** Virtual time. Starts at a round, obviously-fake instant. */
export const testClock = (start = 1_700_000_000_000): TestClock => {
  let now = start;
  return {
    now: () => now,
    advance: (millis) => {
      now += millis;
    },
    set: (millis) => {
      now = millis;
    },
  };
};

export interface ManualTimers extends AlertTimers {
  /** Fire every deadline due at or before `now + millis`. */
  advance(millis: number): void;
  pending(): number;
}

/**
 * A timer wheel a test turns by hand. No `setTimeout`, so a delivery-deadline
 * assertion costs no wall time and cannot flake.
 */
export const manualTimers = (): ManualTimers => {
  interface Waiter {
    dueAt: number;
    fire: () => void;
    cancelled: boolean;
  }
  let now = 0;
  const waiters: Waiter[] = [];
  return {
    deadline(millis, onDue) {
      const waiter: Waiter = { dueAt: now + Math.max(0, millis), fire: onDue, cancelled: false };
      waiters.push(waiter);
      return () => {
        waiter.cancelled = true;
      };
    },
    advance(millis) {
      now += millis;
      for (const waiter of [...waiters].sort((a, b) => a.dueAt - b.dueAt)) {
        if (waiter.cancelled || waiter.dueAt > now) continue;
        waiter.cancelled = true;
        waiter.fire();
      }
    },
    pending: () => waiters.filter((w) => !w.cancelled).length,
  };
};

/** Timers that never fire. Delivery is then bounded only by the sink itself. */
export const inertTimers = (): AlertTimers => ({
  deadline: () => () => undefined,
});

// --- transports and streams a test holds ------------------------------------

export interface TestPageTransport extends PageTransport {
  readonly sent: readonly PageRequest[];
}

export const testPageTransport = (
  behaviour?: (request: PageRequest) => Promise<void>,
): TestPageTransport => {
  const sent: PageRequest[] = [];
  return {
    async send(request) {
      sent.push(request);
      if (behaviour !== undefined) await behaviour(request);
    },
    get sent(): readonly PageRequest[] {
      return sent;
    },
  };
};

export interface TestStream extends OperationalStream {
  readonly written: readonly OperationalRecord[];
}

export const testStream = (behaviour?: (record: OperationalRecord) => void): TestStream => {
  const written: OperationalRecord[] = [];
  return {
    write(record) {
      written.push(record);
      behaviour?.(record);
    },
    get written(): readonly OperationalRecord[] {
      return written;
    },
  };
};

/** A sink that always throws. Named, so a degradation record can be asserted. */
export const throwingSink = (id: string, error: () => Error): AlertSink =>
  pagingAlertSink({
    id: SINK(id),
    rota: ROTA("rota_oncall"),
    accepts: ["notice", "degraded", "incident", "liveness-lost"],
    transport: {
      send() {
        return Promise.reject(error());
      },
    },
  });

/** A sink that never settles. Only a deadline gets a test past it. */
export const hangingSink = (id: string): AlertSink =>
  pagingAlertSink({
    id: SINK(id),
    rota: ROTA("rota_oncall"),
    accepts: ["notice", "degraded", "incident", "liveness-lost"],
    transport: {
      send: () => new Promise<void>(() => undefined),
    },
  });

// --- conditions, one of each, with plausible integers ------------------------

export const conditions = {
  reservedUnassisted: (id = "c_reserved") =>
    ({
      kind: "reserved-decision-completed-unassisted",
      correlationId: CASE(id),
      decisionPoint: POINT("disburse"),
      reservedRule: RULE("fca_conc_7_3"),
      tier: "high",
    }) as const,
  effectUnknown: (id = "c_effect") =>
    ({
      kind: "effect-outcome-unknown",
      correlationId: CASE(id),
      effectKind: EFFECT("disbursement"),
      idempotencyKey: KEY("idem_991"),
      unknownForMs: 900_000,
      tier: "high",
    }) as const,
  remindersStopped: (id = "c_reminders") =>
    ({
      kind: "reminders-stopped",
      correlationId: CASE(id),
      expectedEveryMs: 86_400_000,
      overdueByMs: 172_800_000,
      remindersSent: 4,
    }) as const,
  buried: (id = "c_buried") =>
    ({
      kind: "case-buried",
      correlationId: CASE(id),
      awaitingForMs: 950_400_000,
      scheduledStepsSpent: 3,
      recurrenceCycles: 7,
      pool: POOL("pool_claims_managers"),
    }) as const,
  authorityUnavailable: (id = "c_authority") =>
    ({
      kind: "authority-unavailable",
      correlationId: CASE(id),
      pool: POOL("pool_claims_managers"),
      reserved: "reserved",
      awaitingForMs: 3_600_000,
    }) as const,
  underRecording: (id = "c_under") =>
    ({
      kind: "under-recording-detected",
      correlationId: CASE(id),
      decisionsExamined: 400,
      decisionsWithoutModelCall: 37,
      coverageFloorBasisPoints: 9_500,
      observedCoverageBasisPoints: 9_075,
    }) as const,
  traceUnavailableHigh: (id = "c_trace") =>
    ({
      kind: "trace-unavailable-at-high-tier",
      correlationId: CASE(id),
      reason: "store-failure",
    }) as const,
  rateMoved: (point = "screen_input") =>
    ({
      kind: "rate-moved-sharply",
      measure: "abstention",
      decisionPoint: POINT(point),
      windowMs: 3_600_000,
      baselineBasisPoints: 400,
      observedBasisPoints: 1_100,
      sampleSize: 812,
    }) as const,
  heartbeatMissed: (component = "sweeper") =>
    ({
      kind: "heartbeat-missed",
      component: COMPONENT(component),
      expectedEveryMs: 60_000,
      overdueByMs: 540_000,
      lastSeen: { seen: "beat", at: 1_700_000_000_000 },
      beatsObserved: 4_812,
    }) as const,
} as const;

/** Every condition kind exactly once, for the exhaustiveness tests. */
export const oneOfEachCondition = () =>
  [
    conditions.reservedUnassisted(),
    conditions.effectUnknown(),
    conditions.remindersStopped(),
    conditions.buried(),
    conditions.authorityUnavailable(),
    conditions.underRecording(),
    conditions.traceUnavailableHigh(),
    conditions.rateMoved(),
    conditions.heartbeatMissed(),
  ] as const;

export const ALL_CONDITION_KINDS: readonly AlertConditionKind[] = [
  "reserved-decision-completed-unassisted",
  "effect-outcome-unknown",
  "reminders-stopped",
  "case-buried",
  "authority-unavailable",
  "under-recording-detected",
  "trace-unavailable-at-high-tier",
  "rate-moved-sharply",
  "heartbeat-missed",
];

export const ALL_SEVERITIES: readonly AlertSeverity[] = [
  "notice",
  "degraded",
  "incident",
  "liveness-lost",
];

// --- a harness ---------------------------------------------------------------

export const harness = (options?: {
  readonly sinks?: readonly AlertSink[];
  readonly journal?: ReturnType<typeof inMemoryAlertJournal> | null;
  readonly limits?: Parameters<typeof createAlerts>[0]["limits"];
  readonly timers?: AlertTimers;
}) => {
  const clock = testClock();
  const timers = options?.timers ?? manualTimers();
  const recorder = recordingAlertSink({ id: SINK("sink_recorder") });
  const journal = options?.journal === null ? undefined : (options?.journal ?? inMemoryAlertJournal());
  const chain = options?.sinks ?? [recorder];
  const [first, ...rest] = chain;
  if (first === undefined) throw new Error("fixture: a chain needs at least one sink");
  const alerts = createAlerts({
    sinks: [first, ...rest],
    clock,
    timers,
    journal,
    limits: options?.limits,
  });
  return { alerts, clock, timers, recorder, journal };
};

/** A chain that would pass `assertProductionAlerting`. */
export const productionChain = () => {
  const transport = testPageTransport();
  const stream = testStream();
  return {
    transport,
    stream,
    sinks: [
      pagingAlertSink({ id: SINK("sink_pager"), rota: ROTA("rota_oncall"), transport }),
      operationalStreamAlertSink({ id: SINK("sink_stream"), stream }),
    ] as const,
  };
};
