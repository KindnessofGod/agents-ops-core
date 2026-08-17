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

/**
 * The content address of *what would be run*: source digest, subject version,
 * scorer digests, seed, price-table version and the limits.
 *
 * It is not the run's identity — `RunId` is, and it is unique per execution.
 * `RunKey` is the identity of the **question**, which is what makes two
 * executions recognisable as repeats of one another. Everything that could
 * change the answer is in it; nothing that cannot is. The label is not in it, so
 * `"nightly"` and `"pre-merge"` over the same suite are one question asked
 * twice, not two.
 */
export type RunKey = string & { readonly __brand: "EvalRunKey" };

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
  /**
   * Present when this source is a **subset** of a larger one, `null` when it is
   * the whole thing.
   *
   * A subset is a `CaseSource` in its own right with its own content address —
   * not a flag on a run — which is what makes the pre-merge run's key different
   * from the nightly run's key without anybody having to remember. It also
   * makes the coverage claim travel: `run` stamps this onto a `source` node and
   * onto the report, and `gate` reads it so a green pre-merge build **states
   * what it actually covered** instead of implying it covered everything.
   */
  readonly selection: SubsetSelection | null;
}

/**
 * What a subset selected, what it deliberately did not, and how it decided.
 *
 * Every field here exists so the selection can be reproduced and argued with.
 * The seeded sample is a function of `(seed, ref)` alone, so the same seed over
 * the same suite selects the same cases on every host and in every year — and
 * the sample is recorded by reference anyway, so the selection is checkable even
 * if the sampling rule is later changed.
 *
 * **High-tier and quarantined cases are pinned.** They are selected before the
 * budget is consulted and are never dropped to fit it: the point of a cheap
 * pre-merge run is to be cheap about the cases where being wrong is cheap. If
 * the pinned cases alone exceed `maxCases` the subset runs over budget and says
 * so in `overBudget`, because dropping the high-tier cases to hit a time target
 * is exactly the trade nobody would defend out loud.
 */
export interface SubsetSelection {
  /** "pre-merge". Recorded, never interpreted. */
  readonly label: string;
  /** The content address of the source this was selected from. */
  readonly fromDigest: SourceDigest;
  readonly fromSize: number;
  /** The selection seed. Not the run seed — a subset is chosen before a run. */
  readonly seed: Seed;
  readonly maxCases: number;
  /** Pinned: every case whose decision is high tier. */
  readonly pinnedHighTier: readonly CaseRef[];
  /** Pinned: every case the caller declared quarantined (recently flaky). */
  readonly pinnedQuarantined: readonly CaseRef[];
  /** The seeded remainder, sized to what is left of the budget. */
  readonly sampled: readonly CaseRef[];
  /**
   * The cases in the parent source this subset did **not** select.
   *
   * Enumerated, not counted. `gate` needs to tell "the author deleted this
   * golden case" from "the pre-merge subset did not run it", and a count cannot
   * answer that. Absence of a case is not evidence about the case.
   */
  readonly notSelected: readonly CaseRef[];
  /** True when the pinned cases alone exceeded `maxCases`. Nothing was dropped. */
  readonly overBudget: boolean;
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
  /**
   * What this run carried forward from a previous execution of the same run
   * key rather than executing: how many cases, from which runs, and why.
   * Present only on a resumed run, so "these 180 results were not observed
   * today" is a recorded fact rather than something a reader has to infer from
   * a suspiciously low cost figure.
   */
  | "resume"
  /**
   * The determinism **check**: a seeded sample of this run's cases re-executed
   * under the same seed and compared. Interface fact 5 used to be satisfied by
   * a declaration; this is the node that makes it a measurement.
   */
  | "determinism"
  /**
   * Under-recording: decisions this run observed with no model call beneath
   * them, on a subject that did not declare itself pure.
   *
   * Written only when there is something to write, and it carries what became
   * of the alert. The gate blocks on the same fact, but a blocked gate tells a
   * developer watching a change land; this node and its alert tell an operator
   * on the night a nightly run finds it.
   */
  | "under-recording"
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
  "resume",
  "determinism",
  "under-recording",
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
  /**
   * 0..32. How many of this run's cases are **re-executed under the same seed
   * and compared**, to turn interface fact 5 from a declaration into a check.
   *
   * The report used to state that a run was deterministic, or name its
   * non-determinism, entirely on the strength of what the scorer adapters
   * declared about themselves. Nothing verified the subject, which is the half
   * that actually varies: a temperature setting, an unseeded shuffle, a
   * `Map` iteration over host-ordered keys, a cache warm on the second call.
   *
   * It costs, which is why it is a number rather than a boolean and why the
   * number is small. `DEFAULT_LIMITS` samples 2 of 200 — around 1% of the run's
   * spend to know whether the other 99% means anything. `0` switches the check
   * off, and the report then says `not-checked` and why, rather than falling
   * back to the claim.
   */
  readonly determinismSampleCases: number;
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
  /**
   * Required, and it arrives **here** rather than on `RunSpec` on purpose.
   *
   * The ledger is durable state belonging to the composition root, exactly like
   * the store: it is wired once, next to the database, by the same code that
   * wires the witness. Putting it on `RunSpec` would make idempotency something
   * each of nineteen callers decides per invocation, and the first one to leave
   * it out pays for a 200-case run twice without noticing.
   *
   * `inMemoryRunLedger()` is a legitimate value here and forgets at process
   * exit, which is the right answer for a test and the wrong one for continuous
   * integration. There is no `undefined`.
   */
  readonly ledger: RunLedger;
  /**
   * Where `under-recording-detected` is raised — the sixth of
   * `docs/CONTEXT.md`'s eight silent conditions, and the one this module is the
   * only place able to see: *"decisions with no recorded model call. The build
   * stays green unless something counts what is missing."*
   *
   * This module already counts it. `UnattributedDecision` blocks the gate and
   * turns the build red, which is the right consequence for a change somebody is
   * watching land. It is the wrong consequence for a **nightly** run, where a
   * red build is a line in a report nobody opens until Monday, and the subject
   * has been doing its thinking somewhere unrecorded since Thursday. The gate
   * tells a developer; this tells an operator.
   *
   * Wired **here** rather than on `RunSpec` for the same reason `ledger` is:
   * alerting is composition-root state, next to the store and the database. A
   * per-invocation parameter is one nineteen callers each decide, and the first
   * to leave it out is silent in exactly the way this exists to prevent.
   *
   * Optional, because nineteen applications cannot be recompiled at once. Its
   * absence is not silent: it is written onto the run's own `under-recording`
   * node as `alerted: "not-configured"`.
   */
  readonly alerting?: import("../../alerts/index.js").AlertRaiser | undefined;
}

/* ------------------------------------------------------------------ ledger */

/**
 * The run ledger — idempotency and resume, and the reason a 200-case run that
 * dies at case 180 does not pay for 180 cases again.
 *
 * Two things are memoised and they are memoised at different granularities,
 * because they answer different questions:
 *
 *   **A completed run**, keyed by `RunKey`. Re-running a key that already
 *   finished returns the original report and executes nothing at all. This is
 *   the C2 idempotency requirement stated for effects — "a repeat returns the
 *   original outcome rather than re-executing or erroring" — applied to the one
 *   thing in this module that costs real money.
 *
 *   **A completed case**, keyed by `(RunKey, CaseRef)`. An interrupted run
 *   resumes from these: the cases that finished are carried forward as recorded
 *   facts and only the remainder executes.
 *
 * ## The trap, and where it is closed
 *
 * A run that exceeded its budget produces a `partial` report. Memoising that as
 * a completed run would make a biased sample permanent *and* free — every later
 * run of the key would return it without executing, and it would look exactly
 * like a finished run because it is the same type. So the write side is not a
 * check: `CompletedRunRecord` is branded and `mintCompletedRun` is its only
 * producer, and that function refuses a partial report. A caller cannot
 * construct the argument.
 *
 * Per-case memos are a different matter and *are* written by a partial run: the
 * cases that genuinely finished did genuinely finish, and carrying them forward
 * is the whole point. What is never memoised is a case that ended because the
 * clock ran out or the run was aborted underneath it — those are facts about the
 * budget, not about the case.
 *
 * ## Fail policy, which is the opposite of `EvalNodeStore`'s
 *
 * `EvalStoreUnavailable` is fail-closed at every tier: an unrecorded eval run is
 * a number nobody can check. `LedgerUnavailable` is **fail-open**: an unmemoised
 * eval run is a bill, not a false number. The run re-executes and the
 * degradation is stamped on the report as `memoisation`. A corrupt answer is a
 * different thing and is fail-closed — see `LedgerCorrupt`.
 *
 * ## Branded, for the same reason the store is
 *
 * `findCompleted` is a path that returns a report **without executing
 * anything**. A hand-rolled ledger is therefore the cheapest possible way to
 * make a build green, cheaper than deleting a golden case and far quieter. Only
 * `inMemoryRunLedger` and `sqlRunLedger` mint one; an application brings its own
 * database through `sqlRunLedger`'s injected `SqlExecutor`.
 */
export interface RunLedgerMethods {
  findCompleted(runKey: RunKey): Promise<StoredCompletedRun | undefined>;
  /** Idempotent under concurrent writers: the first record for a key stands. */
  recordCompleted(record: CompletedRunRecord): Promise<void>;
  /** Every case memo for this key, in reference order. */
  findCases(runKey: RunKey): Promise<readonly StoredCaseMemo[]>;
  /** Idempotent under concurrent writers: the first memo for a case stands. */
  recordCase(memo: CaseMemo): Promise<void>;
  /**
   * Retention, bounded, and required for the same reason the node store's is:
   * "delete everything older than 90 days" against a table this size is a
   * statement that holds a lock for minutes. The caller loops on `runKeys > 0`.
   */
  expireBefore(cutoff: number, batchLimit: number): Promise<LedgerExpiryResult>;
}

export interface LedgerExpiryResult {
  readonly runKeys: number;
  readonly cases: number;
}

declare const RUN_LEDGER: unique symbol;

/** Branded. Minted only by this module's two shipped adapters. */
export interface RunLedger extends RunLedgerMethods {
  readonly [RUN_LEDGER]: true;
}

declare const COMPLETED_RUN: unique symbol;

/**
 * What `recordCompleted` accepts. **Branded, and minted only by
 * `mintCompletedRun`**, which refuses a partial run, an unattributed run and a
 * run that could not evaluate cases.
 *
 * The brand is the mechanism, not the refusal. A check can be skipped by a
 * caller who builds the object themselves; a type that cannot be named cannot be
 * built.
 */
export interface CompletedRunRecord {
  readonly [COMPLETED_RUN]: true;
  readonly runKey: RunKey;
  readonly runId: RunId;
  readonly completedAt: number;
  readonly schema: string;
  readonly sourceKind: SourceKind;
  /**
   * The report, as JSON.
   *
   * Serialised rather than held as an object because the whole point is to
   * survive a process line — continuous-integration job A runs, job B a week
   * later asks the same question. It re-enters through `reopenAccuracyReport` or
   * `reopenAgreementReport`, which recompute the rates from the cases, so a row
   * edited in the database is refused rather than returned.
   */
  readonly reportJson: string;
}

/** The read shape. Plain data: an adapter decodes rows into it. */
export interface StoredCompletedRun {
  readonly runKey: RunKey;
  readonly runId: RunId;
  readonly completedAt: number;
  readonly schema: string;
  readonly sourceKind: SourceKind;
  readonly reportJson: string;
}

/**
 * The statuses a case can be memoised under.
 *
 * `could-not-evaluate` is deliberately **not** here. A provider that was
 * throttling is a fact about ten minutes on a Tuesday, not about the case, and
 * freezing it into the ledger would make a rate-limit storm permanent for that
 * run key. Neither is a timeout: a case that ran out of clock says nothing
 * reproducible about itself.
 */
export type MemoisedStatus =
  | "matched"
  | "mismatched"
  | "unscored"
  | "contested"
  | "unattributed";

export interface CaseMemo {
  readonly runKey: RunKey;
  readonly ref: CaseRef;
  /** Checked on resume. A memo against a different case is fail-closed. */
  readonly caseDigest: CaseDigest;
  readonly fromRunId: RunId;
  readonly fromNode: EvalNodeId;
  readonly recordedAt: number;
  readonly status: MemoisedStatus;
  readonly scoreBasisPoints: number;
  /** The observed verdict as JSON, or the four-character string `null`. */
  readonly observedJson: string;
  readonly detail: string | null;
  readonly modelCalls: number;
  readonly costTenthCents: number;
}

/** The read shape. Structurally identical; a different name so the seam is legible. */
export type StoredCaseMemo = CaseMemo;

export interface RunDeps {
  readonly models: ModelBackend;
  readonly priceTable: PriceTable;
}
