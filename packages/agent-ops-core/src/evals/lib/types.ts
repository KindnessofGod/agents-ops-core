import type { ModelBackend, ModelId, PromptVersion, ReadOnlyClient } from "./clients.js";

/* ------------------------------------------------------------------ identity */

export type RunId = string & { readonly __brand: "EvalRunId" };
export type EvalNodeId = string & { readonly __brand: "EvalNodeId" };
export type CaseRef = string & { readonly __brand: "CaseRef" };
export type CaseDigest = string & { readonly __brand: "CaseDigest" };
export type SourceDigest = string & { readonly __brand: "SourceDigest" };
export type SubjectVersion = string & { readonly __brand: "SubjectVersion" };
export type ScorerId = string & { readonly __brand: "ScorerId" };
export type ScorerDigest = string & { readonly __brand: "ScorerDigest" };
export type Seed = string & { readonly __brand: "Seed" };
export type TraceDigest = string & { readonly __brand: "EvalTraceDigest" };

export const caseRef = (value: string): CaseRef => value as CaseRef;
export const subjectVersion = (value: string): SubjectVersion => value as SubjectVersion;
export const scorerId = (value: string): ScorerId => value as ScorerId;
export const seed = (value: string): Seed => value as Seed;

/**
 * The consequence of being wrong, classified before the work runs. Same three
 * values as `audit`, same meaning, and per `OPEN-ITEMS-RESOLVED` item 5 it
 * attaches to a decision-and-its-effect rather than to a case — which is why a
 * golden case declares the tier of the decision it exercises.
 */
export type RiskTier = "low" | "medium" | "high";

/* ------------------------------------------------------------------ payloads */

/**
 * The only value types a node payload field may hold. Integers only — no
 * IEEE-754 anywhere. Flat — no arrays, no nesting. See `canonical.ts`.
 */
export type PayloadField = string | number | boolean | null;

export type EvalPayload = Readonly<Record<string, PayloadField | undefined>>;

/**
 * Applied before write. There is no un-writing personal data, so redaction runs
 * here and no store adapter ever receives an original payload.
 *
 * Deliberately structurally identical to `audit`'s `Redactor`, so an application
 * wires the *same* redactor into both modules and cannot end up with a strict
 * policy on case traces and a lax one on eval traces. Not imported, for the same
 * reason the canonical form is not imported: two stores, two retention regimes,
 * one accidental coupling is enough.
 */
export interface Redactor {
  /** Stamped onto every node, so what was stripped is knowable years later. */
  readonly id: string;
  apply(payload: EvalPayload): EvalPayload;
}

/* ------------------------------------------------------------------- verdicts */

/**
 * What a decision concluded. Per `docs/CONTEXT.md`, a decision produces exactly
 * one verdict, a verdict is immutable, and an **abstention is a verdict** — a
 * successful outcome of a working system, never an error and never a
 * low-confidence determination.
 */
export interface Verdict {
  readonly disposition: "determine" | "abstain";
  /** What was concluded, in the application's own vocabulary. */
  readonly conclusion: string;
  /** Likelihood the verdict is wrong, in basis points. Never multiplied by tier. */
  readonly confidenceBasisPoints: number;
  /** Why, when the disposition is `abstain`. Evidence missing, out of scope, … */
  readonly because: string | null;
}

export const determine = (
  conclusion: string,
  confidenceBasisPoints: number,
): Verdict => ({ disposition: "determine", conclusion, confidenceBasisPoints, because: null });

export const abstain = (because: string): Verdict => ({
  disposition: "abstain",
  conclusion: "",
  confidenceBasisPoints: 0,
  because,
});

/* --------------------------------------------------------------- case sources */

export type SourceKind = "golden" | "recorded";

/**
 * What a case asserts. **This is where agreement stops being a naming
 * convention.** A golden case carries a verdict somebody adjudicated on purpose
 * and wrote down; a recorded case carries whatever a human happened to do. They
 * are different claims about the world, they are typed differently, and the
 * report type is derived from which one arrived — not from which function the
 * caller reached for (graft 7).
 */
export type ExpectationOf<K extends SourceKind> = K extends "golden"
  ? {
      readonly kind: "correct-by-construction";
      readonly verdict: Verdict;
      /** Who adjudicated it. A golden case with no author is folklore. */
      readonly adjudicatedBy: string;
      readonly adjudicatedAt: number;
    }
  : K extends "recorded"
    ? {
        readonly kind: "recorded-human-decision";
        readonly verdict: Verdict;
        /** The case this was replayed from, so the trace is one step away. */
        readonly correlationId: string;
        readonly authority: string;
      }
    : never;

export interface EvalCase<K extends SourceKind> {
  readonly ref: CaseRef;
  readonly digest: CaseDigest;
  readonly tier: RiskTier;
  /** Flat, integer-only, already redacted by the adapter that produced it. */
  readonly input: EvalPayload;
  readonly expectation: ExpectationOf<K>;
}

/**
 * The seam that makes a shadow run a case source rather than a module. Two
 * adapters ship — `goldenSuite` and `recordedCases` — and they have genuinely
 * different semantics, which is exactly why the report type is derived from the
 * source rather than declared by the caller.
 *
 * A third case source (synthetic generation, an adversarial suite, a labelling
 * tool export) is, per the review rule, a signal to **split the module** rather
 * than extend it. Materialise those into a golden suite first.
 */
export interface CaseSource<K extends SourceKind> {
  readonly kind: K;
  /**
   * Content address of the whole source. Non-optional: an unversioned source
   * cannot be constructed by either shipped adapter, so a report against one
   * cannot exist. A hand-rolled source with an empty digest is refused at run
   * open with `SuiteUnversioned`, before any spend.
   */
  readonly digest: SourceDigest;
  /** Declared up front so budgets, progress and backpressure are computable. */
  readonly size: number;
  readonly cases: readonly EvalCase<K>[];
  /**
   * Present only on `"recorded"` sources. The named human-decision source and
   * the window it was observed over — required, mirroring `CONTEXT.md`'s rule
   * that a figure whose provenance is unknown is not evidence of anything.
   */
  readonly provenance: K extends "recorded" ? RecordedProvenance : null;
}

export interface RecordedProvenance {
  /** Names the adapter that said what the humans decided. */
  readonly humanDecisionSource: string;
  readonly window: ObservationWindow;
  /**
   * How many cases were offered and dropped for having no human decision inside
   * the window. On the **source**, so `run` can read it and put it on the
   * report: the count used to exist only as an extra property on the object
   * `recordedCases` returned, which nothing downstream ever looked at.
   */
  readonly withoutHumanDecision: number;
  /** Offered to the adapter before dropping. `considered - size` is the drop. */
  readonly considered: number;
}

export interface ObservationWindow {
  readonly fromInclusive: number;
  readonly toExclusive: number;
}

/* --------------------------------------------------------------------- nodes */

/**
 * The node kinds, exhaustively. There is no `log` kind and no `note` kind,
 * because those are where drift starts: once a caller can record "something
 * happened", the question of what counts as a node stops having an answer.
 */
export type EvalNodeKind =
  | "run"
  /**
   * How the case source was assembled: which adapter named the human
   * decisions, over what window, how many cases were considered and how many
   * were dropped. `recordedCases` performs that work *before* a run opens and
   * therefore records nothing itself — so the facts it produced are stamped
   * onto the run here rather than living only in a caller's variable. See the
   * honesty note in `index.ts` about what this does and does not cover.
   */
  | "source"
  | "case"
  | "decision"
  | "model.call"
  | "scoring"
  | "retry"
  | "aggregate"
  | "gate"
  /** Whatever the subject or a scorer opened for itself via `child`. */
  | "span";

export type NodeOutcome =
  | "ok"
  | "abstained"
  | "error"
  | "timeout"
  | "indeterminate"
  | "unattributed"
  | "aborted";

/** Exhaustive, and used on read: an unknown value is refused, never coerced. */
export const NODE_OUTCOMES: readonly NodeOutcome[] = [
  "ok",
  "abstained",
  "error",
  "timeout",
  "indeterminate",
  "unattributed",
  "aborted",
];

export const NODE_KINDS: readonly EvalNodeKind[] = [
  "run",
  "source",
  "case",
  "decision",
  "model.call",
  "scoring",
  "retry",
  "aggregate",
  "gate",
  "span",
];

/** What a caller of `child` declares. Everything else is assigned by the module. */
export interface NodeSpec {
  /** Free text naming the step. Recorded; never interpreted. */
  readonly name: string;
  /** Payload schema version, required. A default lets two shapes both be v1. */
  readonly v: number;
  readonly payload: EvalPayload;
}

/**
 * A node as the store holds it.
 *
 * `closedAt: null` means the process died inside this node — which is
 * information, and is why the open record is written **before** the body runs
 * rather than assembled afterwards.
 */
export interface EvalNode {
  readonly id: EvalNodeId;
  readonly runId: RunId;
  /** Total order over *writes*, assigned by the store. Never by the caller. */
  readonly sequence: number;
  /** Recorded, never inferred. Absent only on the run node. */
  readonly parent: EvalNodeId | undefined;
  readonly kind: EvalNodeKind;
  readonly name: string;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly elapsedMicros: number;
  readonly outcome: NodeOutcome;
  /**
   * **Subtree totals, not this node alone.** A case node carries the whole
   * case's cost and a run node the whole run's, which is what makes a case
   * readable at a glance. The consequence, stated because it is the obvious way
   * to get a wrong number: summing `costTenthCents` across all nodes double
   * counts. Sum over `kind === "model.call"`, or read the run node.
   */
  readonly costTenthCents: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly priceTableVersion: string;
  readonly payloadSchemaVersion: number;
  readonly redaction: string;
  readonly envelope: string;
  /** Redacted. The raw payload never reaches a store. */
  readonly payload: EvalPayload;
  /** The exact bytes this node canonicalises to, computed once it is settled. */
  readonly canonical: string | null;
}

/* --------------------------------------------------------------------- store */

/**
 * The eval node store — **a different physical store from `audit`'s**, per
 * `OPEN-ITEMS-RESOLVED` item 4.
 *
 * Look at `expireBefore`. That verb is the whole reason this seam exists rather
 * than reusing `audit.TraceStore`: eval runs generate on the order of 10M nodes
 * a day and want 90-day retention, and expiring them needs a `DELETE` grant.
 * `audit`'s headline invariant is that its grants withhold `UPDATE`/`DELETE` so
 * the guarantee holds even against someone with a psql prompt. Granting `DELETE`
 * there to save disk on test data would void append-only for all four modules
 * and all nineteen applications.
 *
 * So: same node shape, same brand on the recorder above it, **different store,
 * different grants, different retention.** An eval run that reads recorded
 * production cases *reads* the audit store and *writes* this one. A trace never
 * spans both.
 *
 * Every adapter owes the same invariants:
 *
 *   1. The **store** assigns id and sequence, atomically, correct under
 *      concurrent writers to one run. Concurrency 8 means eight case subtrees
 *      interleaving their writes into one graph.
 *   2. `settle` closes a node that `append` opened, exactly once. Settling twice
 *      or settling an unknown node is an error, not a no-op.
 *   3. Ordering is a total order over *writes*, and is emphatically not a claim
 *      about execution order. Concurrency is represented by parentage plus the
 *      opened/closed interval, which is why both are recorded.
 *
 * ## Why this interface is branded, and what that costs
 *
 * The recorder above it is branded so that the thing being measured cannot
 * choose its own witness. That brand was worth nothing while the store beneath
 * it was a plain structural interface: a caller could hand `createEvalRecorder`
 * an object literal that echoes the header, fabricates nodes and returns an
 * empty `read()`, and get a green report, a plausible trace digest, `nodes: 0`
 * and a passing gate — with no cast, no `any` and no `@ts-expect-error`. The
 * forgery had simply moved one layer down.
 *
 * So `EvalNodeStore` carries a **non-exported `unique symbol`** as well.
 * `EvalNodeStoreMethods` is what an adapter implements; the brand is added by a
 * module-private mint that only `inMemoryEvalNodeStore` and `sqlEvalNodeStore`
 * call, and `createEvalRecorder` throws `StoreNotMinted` on anything forced
 * through with `as`.
 *
 * **The cost, stated rather than hidden:** an application cannot write its own
 * `EvalNodeStore`. That is deliberate and it is not a closed seam — the SQL
 * adapter takes an injected `SqlExecutor`, so an application brings its own
 * database, its own pool and its own schema through *that* parameter. A store
 * genuinely outside both shapes (a compliance archive under separate custody)
 * arrives as a third shipped adapter behind the same brand, exactly as
 * `OPEN-ITEMS-RESOLVED` item 1 says for the recorder.
 */
export interface EvalNodeStoreMethods {
  openRun(header: StoredRunHeader): Promise<void>;
  /** Writes the open record. Returns id and store-assigned sequence. */
  append(input: AppendEvalNode): Promise<EvalNode>;
  /** Writes the close record onto a node `append` opened. */
  settle(input: SettleEvalNode): Promise<EvalNode>;
  read(runId: RunId): Promise<StoredEvalRun | undefined>;
  /**
   * Retention. Deletes whole runs opened before `cutoff`, **at most
   * `batchLimit` runs per call**, and returns what went. The verb `audit`
   * refuses to have.
   *
   * `batchLimit` is required and range-checked (1..10_000). "Delete everything
   * older than 90 days" against 10M nodes a day is a statement that holds a
   * lock for minutes and materialises a result set nobody reads; the caller
   * loops on `runs > 0` instead. There is no unbounded verb on this interface.
   */
  expireBefore(cutoff: number, batchLimit: number): Promise<ExpiryResult>;
}

export interface ExpiryResult {
  /** Whole runs removed. Loop while this is greater than zero. */
  readonly runs: number;
  readonly nodes: number;
}

declare const EVAL_STORE: unique symbol;

/** Branded. Minted only by this module's two shipped adapters. */
export interface EvalNodeStore extends EvalNodeStoreMethods {
  readonly [EVAL_STORE]: true;
}

export interface StoredRunHeader {
  readonly runId: RunId;
  readonly label: string;
  readonly openedAt: number;
  readonly sourceKind: SourceKind;
  readonly sourceDigest: SourceDigest;
  readonly subjectVersion: SubjectVersion;
  readonly seed: Seed;
  readonly envelope: string;
  readonly redaction: string;
  /**
   * The scope of the evidence, stamped onto the artefact rather than asserted
   * in a wiki that will not exist in 2033. See the honesty note in `index.ts`.
   */
  readonly capturedVia: "injected-client-only";
}

export interface AppendEvalNode {
  readonly runId: RunId;
  readonly parent: EvalNodeId | undefined;
  readonly kind: EvalNodeKind;
  readonly name: string;
  readonly openedAt: number;
  readonly payloadSchemaVersion: number;
  readonly redaction: string;
  readonly envelope: string;
  /** Already redacted. */
  readonly payload: EvalPayload;
}

export interface SettleEvalNode {
  readonly runId: RunId;
  readonly id: EvalNodeId;
  readonly closedAt: number;
  readonly elapsedMicros: number;
  readonly outcome: NodeOutcome;
  readonly costTenthCents: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly priceTableVersion: string;
  /** Merged over the open payload. Already redacted. */
  readonly closing: EvalPayload;
  /**
   * The exact bytes this node canonicalises to, computed by the recorder once
   * the store-assigned sequence exists. Persisted alongside the columns rather
   * than derived from them, so a row edited in place disagrees with itself.
   */
  readonly canonical: string;
}

export interface StoredEvalRun {
  readonly header: StoredRunHeader;
  /** In store-assigned sequence order. */
  readonly nodes: readonly EvalNode[];
}

/* ------------------------------------------------------------- node handle */

/**
 * **The node handle is the capability.**
 *
 * There is no `open` and no `close` here. Only `child(spec, body)`. The
 * `try/finally`, the abort path and the throw path are written by this library,
 * not by the caller — so a caller cannot open a node without closing it, cannot
 * close one they did not open, and cannot forget to record a failure. "Recording
 * is something the caller remembers to do" is not a sentence this interface can
 * express.
 */
export interface NodeHandle {
  child<T>(spec: NodeSpec, body: (ctx: NodeContext) => Promise<T>): Promise<T>;
}

export interface NodeContext {
  /** For grandchildren. The graph is a graph because this nests. */
  readonly node: NodeHandle;
  /** Node-bound. Minted here and nowhere else. No node ⇒ no client. */
  readonly client: ReadOnlyClient;
  /** The injected clock. `Date.now()` does not appear in this module. */
  readonly now: () => number;
  /** Aborted when the case budget or the run budget is spent. */
  readonly signal: AbortSignal;
}

/* ------------------------------------------------------------------ subject */

/**
 * Whether the subject calls models at all.
 *
 * This is the **purity declaration** and it is not decoration. A decision
 * subtree with zero recorded model calls is one of two very different things: a
 * genuinely pure rules engine, or a subject that reached around the library and
 * did its thinking somewhere this module cannot see. Those must not share a
 * representation, so the subject says which it is, in the type, once — and if it
 * says `"calls-models"` and then produces no model call, the case is
 * `unattributed`, is unscored, counts against the coverage floor, and fails the
 * build. Silent under-recording becomes a red build rather than a quiet green.
 */
export type Purity = "calls-models" | "pure";

export interface DecisionContext {
  readonly node: NodeHandle;
  /** `Client<"read">`. Asking for a write-capable one does not compile. */
  readonly client: ReadOnlyClient;
  readonly input: EvalPayload;
  readonly tier: RiskTier;
  /** Derived from the run seed and the case reference. Same every replay. */
  readonly seed: Seed;
  readonly now: () => number;
  readonly signal: AbortSignal;
}

export interface SubjectSpec {
  readonly version: SubjectVersion;
  readonly purity: Purity;
  /**
   * A **property with a function type**, never a method signature. See
   * `clients.ts` fact 2: the disjointness carries the guarantee either way, and
   * this costs nothing.
   *
   * Note what is absent: `SubjectSpec` has no `deps`, no recorder, no store and
   * no clock. **The thing being measured does not choose its own witness.** That
   * was the fatal flaw in the winning design of the exercise — the recorder
   * arrived inside the subject, so an application could pass a two-line no-op
   * and every downstream check still reported success.
   */
  readonly decide: (ctx: DecisionContext) => Promise<Verdict>;
}

declare const SUBJECT: unique symbol;

/** Opaque. Produced only by `defineSubject`, so `run` cannot take a stand-in. */
export interface Subject {
  readonly [SUBJECT]: true;
  readonly version: SubjectVersion;
  readonly purity: Purity;
  readonly decide: (ctx: DecisionContext) => Promise<Verdict>;
}

/* ------------------------------------------------------------------- scoring */

export interface ScorerDescriptor {
  readonly id: ScorerId;
  /** Content address of the scoring logic, including any judge prompt text. */
  readonly digest: ScorerDigest;
  /** Required. The adapter author states this; the runner does not guess. */
  readonly determinism: "deterministic" | "non-deterministic";
  /** Present iff `determinism` is `"non-deterministic"`. */
  readonly judge: JudgeDescriptor | null;
}

export interface JudgeDescriptor {
  readonly model: ModelId;
  readonly promptVersion: PromptVersion;
  /** Odd, and at least 3. A single judge call is an opinion. */
  readonly panelSize: number;
  /** Above this spread the panel is `contested`, never averaged. */
  readonly bandBasisPoints: number;
}

/**
 * `contested` is a first-class outcome, not an average. A panel that splits 2–1
 * does not become 6667 basis points; it becomes a contested case that appears in
 * the report and blocks a gate above the configured rate. Averaging it away is
 * precisely the dishonesty interface fact 6 forbids.
 *
 * `unscored` is never `passed`. A judge that was unavailable produces `unscored`,
 * and `unscored` counts against the gate.
 */
export type ScoreOutcome =
  | { readonly kind: "scored"; readonly valueBasisPoints: number }
  | {
      readonly kind: "contested";
      readonly samplesBasisPoints: readonly number[];
      readonly spreadBasisPoints: number;
    }
  | { readonly kind: "unscored"; readonly reason: string };

export interface ScoringContext {
  readonly node: NodeHandle;
  /** Node-bound, same as the subject's. A judge call it makes is a node. */
  readonly judge: ReadOnlyClient;
  readonly observed: Verdict;
  readonly expected: Verdict;
  readonly seed: Seed;
  readonly signal: AbortSignal;
}

export interface Scorer {
  readonly descriptor: ScorerDescriptor;
  readonly score: (ctx: ScoringContext) => Promise<ScoreOutcome>;
}

/* -------------------------------------------------------------------- limits */

/**
 * Every bound, with a ceiling. There is no unbounded anything: not concurrency,
 * not the queue, not the retries, not the wall clock.
 *
 * `DEFAULT_LIMITS` ships as a **named value the caller passes explicitly**
 * rather than as an implicit default. That is the resolution of the tension the
 * design exercise surfaced: implicit defaults make the shadow path invisible and
 * the gate path illegible to an auditor ("who decided 61 cases were enough?" —
 * "the convention did"), while a fourteen-field object with no defaults makes
 * the shadow path unpleasant, and per ADR 0001 an unpleasant shadow path makes
 * the workflows-not-agents decision unfalsifiable. A named constant is one
 * token, appears in `git blame`, and can be diffed.
 */
export interface Limits {
  /** 1..32. Meets 200 cases in 5 minutes at 8. */
  readonly concurrency: number;
  /** 1..600_000. Per case wall clock. */
  readonly perCaseMillis: number;
  /** 1..7_200_000. Whole-run wall clock. */
  readonly runMillis: number;
  /** 0..1000. Cases that may fail before the run aborts. */
  readonly maxCaseFailures: number;
  /** 0..5. Bounded retries per model call. Never infinite. */
  readonly retries: number;
  /** 1..10_000_000. Cost ceiling in tenth-cents. */
  readonly costCeilingTenthCents: number;
}

/**
 * Prices change, so the table is pinned and its version is stamped on **every**
 * node rather than on the run — a mid-run table change is then visible instead
 * of smoothed. This is the one surviving requirement of the cut `telemetry`
 * module, and without it the 2033 view of 2026's cost per decision is fiction.
 */
export interface PriceTable {
  readonly version: string;
  readonly perModel: Readonly<
    Record<string, { readonly inTenthCentsPerMillion: number; readonly outTenthCentsPerMillion: number }>
  >;
}

/* --------------------------------------------------------------------- deps */

/** Time is a dependency, not an ambient fact. Structurally `audit`'s `Clock`. */
export interface Clock {
  now(): number;
}

/**
 * The *passage* of time, as opposed to the reading of it.
 *
 * `Clock` answers "what time is it"; nothing in a `Clock` can make a wall clock
 * fire or a backoff elapse. Both of those used ambient `setTimeout`, which meant
 * retry backoff and both wall clocks were driven by something no test could
 * reach — so a bounds test had to spend real milliseconds and the expiry path
 * could not be driven at all. `Timers` is the injected half.
 *
 * A real seam, two shipped adapters: `systemTimers` (production) and
 * `manualTimers` (a **deliverable**, like `inMemoryEvalNodeStore` — it is what
 * lets a test assert a bounded backoff sequence without waiting for it).
 */
export interface Timers {
  /** Resolves after `millis`, or as soon as `signal` aborts. Never rejects. */
  sleep(millis: number, signal: AbortSignal): Promise<void>;
  /** Fires `onDue` once after `millis`. Returns a cancel safe to call twice. */
  deadline(millis: number, onDue: () => void): () => void;
}

export interface RecorderDeps {
  readonly store: EvalNodeStore;
  readonly clock: Clock;
  /** Required. There is no un-writing. */
  readonly redact: Redactor;
  /** Required. Wall clocks and backoff are driven from here, never ambiently. */
  readonly timers: Timers;
}

export interface RunDeps {
  readonly models: ModelBackend;
  readonly priceTable: PriceTable;
}
