import {
  createAudit,
  inMemoryTraceStore,
  redactFields,
  type Audit,
  type Clock,
  type CorrelationId,
  type RecordedNode,
  type Redactor,
  type TraceStore,
  type TraceVerdict,
  type UnavailabilityPolicy,
  type Witness,
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
  /** Present only where the harness was given one. */
  readonly witness?: Witness;
}

export const harness = (
  overrides: {
    readonly store?: TraceStore;
    readonly redact?: Redactor;
    readonly onTraceUnavailable?: UnavailabilityPolicy;
    readonly witness?: Witness;
    readonly clock?: TestClock;
    /**
     * Where `trace-unavailable-at-high-tier` goes.
     *
     * Only ever an in-memory `Alerts` here — and not because a test remembers to
     * do that. `alerts` constructs no transport and reads nothing from the
     * environment, so there is no path from this package to a pager to reach.
     */
    readonly alerting?: import("../../alerts/index.js").AlertRaiser;
  } = {},
): Harness => {
  const clock = overrides.clock ?? testClock(1_700_000_000_000);
  const store = overrides.store ?? inMemoryTraceStore();
  const audit = createAudit({
    store,
    clock,
    redact: overrides.redact ?? redactNothing,
    onTraceUnavailable: overrides.onTraceUnavailable ?? strictPolicy,
    ...(overrides.witness === undefined ? {} : { witness: overrides.witness }),
    alerting: overrides.alerting,
  });
  return {
    audit,
    store,
    clock,
    ...(overrides.witness === undefined ? {} : { witness: overrides.witness }),
  };
};

/**
 * Record `count` nodes and close. Used where the *shape* of a case matters and
 * its contents do not — the streaming tests, which care about node counts far
 * beyond what any other test in this module builds.
 */
export const caseOf = async (
  audit: Audit,
  correlationId: CorrelationId,
  count: number,
  options: { readonly close?: boolean } = {},
): Promise<void> => {
  const trace = await audit.open(correlationId);
  for (let i = 0; i < count; i += 1) {
    await trace.record({ kind: "decision.decided", v: 1, step: i }, { tier: "low" });
  }
  if (options.close !== false) await trace.close({ unassistedContainment: true });
};

/** Drain a walk, returning the nodes read and the verdict it ended on. */
export const drain = async (
  walk: AsyncGenerator<RecordedNode, TraceVerdict, undefined>,
): Promise<{ readonly nodes: RecordedNode[]; readonly verdict: TraceVerdict }> => {
  const nodes: RecordedNode[] = [];
  for (;;) {
    const step = await walk.next();
    if (step.done) return { nodes, verdict: step.value };
    nodes.push(step.value);
  }
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
