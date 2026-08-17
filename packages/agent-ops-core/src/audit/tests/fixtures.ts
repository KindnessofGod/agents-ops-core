import {
  createAudit,
  inMemoryTraceStore,
  redactFields,
  type Audit,
  type Clock,
  type CorrelationId,
  type Redactor,
  type TraceStore,
  type UnavailabilityPolicy,
} from "../index.js";

/**
 * Fixtures shared by this module's tests.
 *
 * Everything here is injected, and nothing here constructs a client, a socket
 * or a real clock. That is the structural half of the hermetic guarantee: these
 * tests could not reach a live model or a live database with real credentials
 * present in the environment, because there is no code in this package that
 * opens either.
 */

export interface TestClock extends Clock {
  advance(ms: number): void;
}

export const testClock = (startMs: number): TestClock => {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

export const CASE_A = "case_a" as CorrelationId;
export const CASE_B = "case_b" as CorrelationId;

/**
 * The policy used by most tests. Note that `high` is not a choice: the type
 * admits only `"fail-closed"` there.
 */
export const strictPolicy: UnavailabilityPolicy = {
  high: "fail-closed",
  medium: "fail-closed",
  low: "fail-closed",
};

export const degradeBelowHigh: UnavailabilityPolicy = {
  high: "fail-closed",
  medium: "degrade",
  low: "degrade",
};

/** A deny-list redactor that denies nothing, named so the trace says as much. */
export const redactNothing: Redactor = redactFields([]);

export interface Harness {
  readonly audit: Audit;
  readonly store: TraceStore;
  readonly clock: TestClock;
}

export const harness = (
  overrides: {
    readonly store?: TraceStore;
    readonly redact?: Redactor;
    readonly onTraceUnavailable?: UnavailabilityPolicy;
  } = {},
): Harness => {
  const clock = testClock(1_700_000_000_000);
  const store = overrides.store ?? inMemoryTraceStore();
  const audit = createAudit({
    store,
    clock,
    redact: overrides.redact ?? redactNothing,
    onTraceUnavailable: overrides.onTraceUnavailable ?? strictPolicy,
  });
  return { audit, store, clock };
};

/** Narrow a record result, failing loudly rather than silently skipping. */
export const mustRecord = <T extends { recorded: boolean }>(
  result: T,
): Extract<T, { recorded: true }> => {
  if (!result.recorded) {
    throw new Error(`expected a recorded node, got ${JSON.stringify(result)}`);
  }
  return result as Extract<T, { recorded: true }>;
};
