import {
  createEvalRecorder,
  determine,
  goldenSuite,
  inMemoryEvalNodeStore,
  inMemoryRunLedger,
  modelId,
  promptVersion,
  scriptedModelBackend,
  seed as makeSeed,
  subjectVersion,
  systemTimers,
} from "../index.js";
import type {
  Clock,
  EvalNodeStore,
  EvalPayload,
  EvalRecorder,
  Limits,
  ModelRequest,
  ModelResponse,
  PriceTable,
  Redactor,
  RunLedger,
  Timers,
} from "../index.js";

/**
 * Fixtures.
 *
 * Everything here crosses the same seam a caller crosses: this file imports only
 * from `../index.js`. If a test needed to reach past the interface, the module
 * would be the wrong shape.
 *
 * There is no network in any of it, and that is structural rather than
 * conventional: `evals` contains nothing that can open a socket, and the one
 * thing that dials — `ModelBackend` — is a required parameter of `run` with no
 * default. A test cannot reach a live model with real credentials present in the
 * environment because there is nothing in the module to reach one with.
 */

/** The injected clock, advanced by hand. No `Date.now()` anywhere. */
export const manualClock = (start = 1_700_000_000_000): Clock & { advance(ms: number): void } => {
  let now = start;
  return {
    now: () => {
      // Every read advances by a millisecond, so elapsed times are non-zero and
      // ordering is visible without any test having to sleep.
      now += 1;
      return now;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

/** Permissive redactor. A real application wires the same one it wires into `audit`. */
export const passthroughRedactor: Redactor = {
  id: "test-passthrough",
  apply: (payload: EvalPayload) => payload,
};

/** Deny-list redactor, to prove redaction runs before write. */
export const denyFields = (deny: readonly string[]): Redactor => ({
  id: `deny:${deny.join(",")}`,
  apply: (payload) => {
    const out: Record<string, string | number | boolean | null | undefined> = {};
    for (const [k, v] of Object.entries(payload)) out[k] = deny.includes(k) ? "[redacted]" : v;
    return out;
  },
});

export const priceTable: PriceTable = {
  version: "prices@2026-08-01",
  perModel: {
    "test-model": { inTenthCentsPerMillion: 30_000, outTenthCentsPerMillion: 150_000 },
    "test-judge": { inTenthCentsPerMillion: 10_000, outTenthCentsPerMillion: 50_000 },
  },
};

export const TEST_MODEL = modelId("test-model");
export const TEST_JUDGE = modelId("test-judge");
export const PROMPT_V1 = promptVersion("extract@1");

/**
 * `determinismSampleCases: 0` here on purpose.
 *
 * Most tests in this module assert what a run *recorded* — node counts, trace
 * digests, cost figures — and a determinism re-execution adds spans and model
 * calls to every one of them. The check has its own tests, where it is switched
 * on deliberately, which is also how a caller should reach for it.
 */
export const smallLimits: Limits = {
  concurrency: 4,
  perCaseMillis: 5_000,
  runMillis: 30_000,
  maxCaseFailures: 10,
  retries: 0,
  costCeilingTenthCents: 1_000_000,
  determinismSampleCases: 0,
};

export const testSeed = makeSeed("seed-0");
export const testSubjectVersion = subjectVersion("invoice-approval@test");

export interface Harness {
  readonly store: EvalNodeStore;
  readonly ledger: RunLedger;
  readonly recorder: EvalRecorder;
  readonly clock: Clock & { advance(ms: number): void };
}

/**
 * A fresh store and a fresh ledger per harness, so a test that does not care
 * about idempotency gets none: every `harness()` is a new world, and a run
 * cannot accidentally return a memo left behind by the test above it.
 *
 * Passing a ledger in is how the resume tests share one across two harnesses,
 * which is exactly the shape a crashed continuous-integration job has.
 */
export const harness = (
  redact: Redactor = passthroughRedactor,
  timers: Timers = systemTimers(),
  ledger: RunLedger = inMemoryRunLedger(),
  /**
   * Where `under-recording-detected` goes. Only ever an in-memory `Alerts`, and
   * not by convention: `alerts` constructs no transport and reads no
   * environment, so this test suite has no path to a pager at all.
   */
  alerting?: import("../../alerts/index.js").AlertRaiser,
): Harness => {
  const store = inMemoryEvalNodeStore();
  const clock = manualClock();
  return {
    store,
    clock,
    ledger,
    recorder: createEvalRecorder({ store, clock, redact, timers, ledger, alerting }),
  };
};

export const echoBackend = (
  answer: (request: ModelRequest) => ModelResponse | Promise<ModelResponse> = () => ({
    text: "duplicate",
    tokensIn: 1_000,
    tokensOut: 20,
  }),
) => scriptedModelBackend({ id: "scripted", answer });

/** Three golden cases from invoice approval, adjudicated by a named person. */
export const threeInvoices = () =>
  goldenSuite({
    cases: [
      {
        ref: "INV-0001",
        tier: "high",
        input: { supplier: "acme", amountMinorUnits: 4_720_000 },
        expected: determine("duplicate", 9_000),
        adjudicatedBy: "a.reviewer",
        adjudicatedAt: 1_690_000_000_000,
      },
      {
        ref: "INV-0002",
        tier: "medium",
        input: { supplier: "beta", amountMinorUnits: 12_000 },
        expected: determine("duplicate", 9_000),
        adjudicatedBy: "a.reviewer",
        adjudicatedAt: 1_690_000_000_000,
      },
      {
        ref: "INV-0003",
        tier: "low",
        input: { supplier: "gamma", amountMinorUnits: 900 },
        expected: determine("duplicate", 9_000),
        adjudicatedBy: "a.reviewer",
        adjudicatedAt: 1_690_000_000_000,
      },
    ],
  });
