import {
  createAudit,
  inMemoryTraceStore,
  redactFields,
  type Audit,
  type Clock,
  type CorrelationId,
  type RecordedNode,
  type TraceStore,
} from "../../audit/index.js";
import {
  DEFAULT_LIMITS,
  createGuardrails,
  deterministicDetector,
  localeOf,
  type Classifier,
  type ClassifierRequest,
  type Detector,
  type DetectorSet,
  type DetectorSets,
  type Guardrails,
  type Limits,
  type Locale,
  type NonEmpty,
  type Timer,
  type TimerHandle,
} from "../index.js";

/**
 * Hermetic by construction, not by convention.
 *
 * Every dependency below is a constructor parameter: the store, the clock, the
 * timer and the classifier. Nothing in this file — and nothing in the module —
 * can reach a live model, a real database or the machine clock, and no
 * environment variable changes that. A test with real credentials in the
 * environment still cannot make a network call, because there is no code path
 * that constructs a client.
 */

export const CASE_A = "case-guardrails-a" as CorrelationId;
export const EN_GB: Locale = localeOf("en-GB");
export const EN_US: Locale = localeOf("en-US");

/** A clock the test drives. Milliseconds since epoch, like the real one. */
export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export const manualClock = (start = 1_700_000_000_000): ManualClock => {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
};

/**
 * A timer the test fires. `fire()` settles every outstanding wait, which is how
 * the detector-budget path is exercised without waiting two real seconds — and
 * therefore without the timeout branch being, in practice, untested.
 */
export interface ManualTimer extends Timer {
  fire(): void;
  readonly outstanding: number;
}

export const manualTimer = (): ManualTimer => {
  const pending = new Set<() => void>();
  const timer: ManualTimer = {
    wait(): TimerHandle {
      let settle: () => void = () => {};
      const elapsed = new Promise<void>((resolve) => {
        settle = resolve;
      });
      pending.add(settle);
      return {
        elapsed,
        cancel() {
          pending.delete(settle);
        },
      };
    },
    fire() {
      for (const settle of [...pending]) {
        pending.delete(settle);
        settle();
      }
    },
    get outstanding() {
      return pending.size;
    },
  };
  return timer;
};

/**
 * Wait until a detector budget is actually outstanding, then the test can fire
 * it. Ticks the event loop; never the wall clock, so the timeout branch is
 * exercised in milliseconds rather than in the two seconds it really bounds.
 */
export const whenWaiting = async (timer: ManualTimer, ticks = 100): Promise<void> => {
  for (let i = 0; i < ticks && timer.outstanding === 0; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/**
 * A classifier the test scripts. There is no other kind in this package —
 * `Classifier` is the model-client injection point C3 forces, and it ships no
 * adapters at all.
 *
 * Tokens and the price-table version are **required** on a response, so this
 * fixture supplies them: C2 names four things per node and a classifier that
 * cannot say what it consumed leaves a cost figure nobody can reconstruct.
 */
export const scriptedClassifier = (
  scores: (text: string) => { readonly [label: string]: number },
  options: {
    readonly costTenthCents?: number;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
    readonly priceTableVersion?: string;
    readonly onCall?: (request: ClassifierRequest) => void;
  } = {},
): Classifier => ({
  model: "test-classifier",
  promptVersion: "v1",
  async classify(request) {
    options.onCall?.(request);
    return {
      scores: scores(request.text),
      costTenthCents: options.costTenthCents ?? 12,
      tokensIn: options.tokensIn ?? 100,
      tokensOut: options.tokensOut ?? 7,
      priceTableVersion: options.priceTableVersion ?? "prices-2026-01",
    };
  },
});

/** A detector that always behaves the way the test asks it to. */
export const scriptedDetector = (
  id: string,
  screen: Detector["screen"],
  overrides: Partial<Pick<Detector, "costClass" | "locales" | "searches">> = {},
): Detector => ({
  id: id as Detector["id"],
  costClass: overrides.costClass ?? "deterministic",
  locales: overrides.locales ?? ([EN_GB] as unknown as NonEmpty<Locale>),
  searches: overrides.searches ?? `whatever ${id} looks for`,
  screen,
});

/** Finds nothing, and says what it looked for. The baseline of every test. */
export const quietDetector = (id = "quiet", searches = "nothing in particular"): Detector =>
  scriptedDetector(
    id,
    () => ({ outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 }),
    { searches },
  );

/** A United Kingdom national insurance number. Deliberately one pattern only. */
export const ninDetector = (severity: "redact" | "advisory" = "redact"): Detector =>
  deterministicDetector({
    id: "pii.uk.nin",
    locales: ["en-GB"] as unknown as NonEmpty<string>,
    searches: "United Kingdom national insurance numbers",
    category: "personal-data",
    severity,
    patterns: [
      {
        rule: "uk.national-insurance-number",
        match: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g,
        confidenceBasisPoints: 9_500,
      },
    ],
  });

export const setOf = (
  id: string,
  input: NonEmpty<Detector>,
  output: NonEmpty<Detector> = input,
): DetectorSet => ({ id: id as DetectorSet["id"], input, output });

export const sameAtEveryTier = (set: DetectorSet): DetectorSets => ({
  low: set,
  medium: set,
  high: set,
});

export interface Harness {
  readonly guardrails: Guardrails;
  readonly audit: Audit;
  readonly store: TraceStore;
  readonly clock: ManualClock;
  readonly timer: ManualTimer;
  nodes(correlationId?: CorrelationId): Promise<readonly RecordedNode[]>;
  kinds(correlationId?: CorrelationId): Promise<readonly string[]>;
}

export const harness = (options: {
  readonly detectorSets: DetectorSets;
  readonly locale?: Locale;
  readonly limits?: Partial<Limits>;
  readonly store?: TraceStore;
  readonly clock?: ManualClock;
}): Harness => {
  const store = options.store ?? inMemoryTraceStore();
  const clock = options.clock ?? manualClock();
  const timer = manualTimer();
  const audit = createAudit({
    store,
    clock,
    // A deny list that strips nothing, so a test can assert what `guardrails`
    // itself put in the trace rather than what `audit` masked afterwards.
    redact: redactFields([]),
    onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
  });
  const guardrails = createGuardrails({
    audit,
    clock,
    timer,
    locale: options.locale ?? EN_GB,
    detectorSets: options.detectorSets,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
  });
  return {
    guardrails,
    audit,
    store,
    clock,
    timer,
    async nodes(correlationId = CASE_A) {
      return (await store.read(correlationId))?.nodes ?? [];
    },
    async kinds(correlationId = CASE_A) {
      return (await this.nodes(correlationId)).map((n) => n.payload.kind);
    },
  };
};
