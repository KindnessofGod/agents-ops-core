/**
 * evals — quality measurement: golden cases, shadow runs, scorers, the gate.
 *
 * Two entry points that execute and record, plus the gate:
 *
 *   run     Execute a subject against a case source. **The report type is
 *           derived from the case source, not from which function you called.**
 *           A golden suite yields an `AccuracyReport`; recorded production cases
 *           yield an `AgreementReport`. There is no `runShadow` and no
 *           `mode: "shadow"` flag, because a shadow run is not a different verb
 *           — it is a run whose cases came from production.
 *   gate    The continuous-integration regression gate. Accepts **only** an
 *           `AccuracyReport`. Passing an `AgreementReport` is a compile error.
 *
 * `accept`, `goldenSuite`, `recordedCases`, `defineSubject`, `exactVerdict` and
 * `judgePanel` are constructors of argument types: they evaluate nothing, open
 * no node and reach no store. A third *executing* entry point is a signal to
 * **split the module**, not to extend it — and the accounting above is stated
 * plainly because that distinction is exactly the one somebody will use next
 * year to add `generateSuite()` as "just a constructor".
 *
 * ## The three things this interface makes impossible
 *
 * **1. Recording you can forget.** `NodeHandle` exposes only
 * `child(spec, body)`. There is no `open` and no `close`, so the `try/finally`,
 * the abort path and the throw path are written by this library. A caller cannot
 * leave a node dangling and cannot forget to record a failure, because neither
 * is code they write. `ReadOnlyClient` has no exported constructor and is
 * obtainable only from a `NodeContext`, which only `child` produces — so **no
 * node ⇒ no client ⇒ no model call**. A subject that never calls `child()` still
 * emits a complete graph having written zero recording code.
 *
 * **2. A witness chosen by the thing being measured.** The recorder is branded
 * with a non-exported `unique symbol`, so a caller-supplied no-op does not
 * typecheck, and it arrives as a parameter of `run` from the composition root —
 * never through the subject. `SubjectSpec` has no `deps` field at all.
 *
 * **3. A subject that writes.** `Client<"read">` and `Client<"write">` are
 * disjoint in both directions, so a `decide` that asks for a write-capable
 * client is a compile error. This is the same mechanism that gives a shadow run
 * its no-effect guarantee: a shadow run has no effects because the thing it runs
 * cannot express one, not because a flag was set.
 *
 * ## Invariants a caller must know
 *
 *   Provenance.    Agreement is not accuracy. `AgreementReport` is not
 *                  assignable where `AccuracyReport` is expected, in either
 *                  direction, and the report type follows the **case source**.
 *                  If reviewers are wrong 8% of the time, perfect agreement is
 *                  8% wrong; every disagreement is a case for adjudication,
 *                  never a defect, and the field is called `disagreements`.
 *   Versioned.     A suite is content-addressed at construction, so there is no
 *                  unversioned suite for a report to be refused against.
 *   Baseline.      `BaselineMissing` is an explicit non-passing gate outcome.
 *                  A gate that silently passes because it had nothing to
 *                  compare against is worse than no gate.
 *   Attribution.   A decision subtree with zero model calls, where the subject
 *                  has not declared itself `"pure"`, is an
 *                  `UnattributedDecision`: unscored, counted against the
 *                  coverage floor, and it **fails the gate**. Silent
 *                  under-recording is a red build, not a quiet green one.
 *   Judges.        Non-deterministic and they say so. Model and prompt version
 *                  recorded per sample; aggregated over an odd n ≥ 3; a panel
 *                  that splits beyond its declared band is `contested`, carrying
 *                  every sample. Disagreement is surfaced, never averaged away.
 *   Unscored.      Never `passed`. A case nobody could measure counts against
 *                  the gate.
 *   Partial.       A run that stopped early is `partial: true` and **cannot pass
 *                  a gate**. A biased sample published as a pass invites being
 *                  read as complete.
 *   Bounded.       Concurrency 1..32, per-case and per-run wall clocks, a cost
 *                  ceiling, retries 0..5, a bounded store. No unbounded
 *                  anything. Target: 200 golden cases under 5 minutes at
 *                  concurrency 8.
 *   Integers.      Every number in a payload is a safe integer — cost in
 *                  tenth-cents, latency in micros, scores in basis points. No
 *                  IEEE-754 anywhere, because byte-stable serialisation is what
 *                  makes replay possible and floats are how it dies quietly.
 *   Clock.         Injected. `Date.now()` does not appear in this module.
 *   Fail policy.   `EvalStoreUnavailable` is fail-closed at every tier with no
 *                  configuration key. This is deliberately the **opposite** of
 *                  `audit`'s per-tier policy: `audit` lets a low-tier decision
 *                  proceed unrecorded because a real customer is waiting, and an
 *                  eval run has no customer. An unrecorded eval run produces a
 *                  number nobody can check.
 *
 * ## Its own store, and why
 *
 * Per `docs/design/OPEN-ITEMS-RESOLVED.md` item 4, eval nodes go to their **own**
 * physical store with its own grants and its own retention. Eval runs generate
 * on the order of 10M nodes a day and want 90-day retention; expiring them needs
 * a `DELETE` grant, and `audit`'s headline invariant is that its grants withhold
 * `UPDATE`/`DELETE` so the guarantee holds even against someone with a psql
 * prompt. Granting `DELETE` there to save disk on test data would void
 * append-only for all four modules and all nineteen applications.
 *
 * So `EvalNodeStore` has an `expireBefore` verb that `audit`'s `TraceStore`
 * refuses to have. **A trace never spans both stores.** A shadow run reading
 * recorded production cases *reads* the audit store and *writes* this one.
 *
 * ## How a payload stays readable for seven years
 *
 * Reports are seven-year artefacts even though the node graph behind them is
 * not, so both carry their version inline and neither needs a registry that may
 * not exist by then.
 *
 * Three versions, owned by three different people, and keeping them apart is the
 * whole mechanism:
 *
 *   - **The envelope version** (`EVAL_ENVELOPE_VERSION`) is owned by this module
 *     and names the canonicalisation rules — sorted keys, dropped `undefined`,
 *     safe integers only, flat payloads, no whitespace. Changing a rule means a
 *     new version; nodes written under the old one keep their old bytes forever.
 *     It is written onto every node and onto the run header.
 *   - **The payload version** (`NodeSpec.v`, stored as `payloadSchemaVersion`) is
 *     owned by whoever declared the node, and names the field set. It is
 *     required, never defaulted, because a default lets two incompatible shapes
 *     both be written as version 1 by somebody who changed the fields and forgot
 *     — the exact quiet failure the version exists to prevent.
 *   - **The artefact version** is the literal `schema` field on each report
 *     (`"report.accuracy/1"`, `"report.agreement/1"`) and on a baseline
 *     (`"baseline/1"`). Fields may be added; never removed, never retyped, never
 *     repurposed. A changed meaning gets a new number.
 *
 * Nothing is ever rewritten in place. Upcasting happens on read, because a
 * migration that touches history makes the trace evidence of the migration
 * rather than of the run.
 *
 * The `priceTableVersion` is stamped on every node rather than on the run, so a
 * mid-run price change is visible instead of smoothed. Without it the 2033 view
 * of 2026's cost per decision is fiction.
 *
 * ## Seams, and the ones deliberately not built
 *
 * Two adapters or it is not a seam. Four survive:
 *
 *   `CaseSource<K>`        `goldenSuite` / `recordedCases`. The one that makes a
 *                          shadow run a case source rather than a module, and
 *                          the one the report type is derived from.
 *   `Scorer`               `exactVerdict` / `judgePanel`. They differ in
 *                          determinism, cost, latency and error mode, which is
 *                          why a judge is an adapter and not a feature of the
 *                          runner.
 *   `EvalNodeStore`        `inMemoryEvalNodeStore` / `sqlEvalNodeStore`. The
 *                          in-memory one is a deliverable, not a mock: it is
 *                          what makes hermeticity structural.
 *   `HumanDecisionSource`  `humanDecisionsFromAuditTrace` / `legacyReviewerExport`.
 *                          The second is not hypothetical — every one of the
 *                          nineteen has a first shadow run, and at that point
 *                          the reviewers' decisions were never in `audit`.
 *
 * `ModelBackend` is a seam with one shipped adapter (`scriptedModelBackend`) and
 * nineteen unshipped ones — the applications' own provider clients. Counted as
 * real on that basis and flagged here rather than dressed up.
 *
 * `Clock` and `Redactor` are **injected, not seamed**. Injection is a
 * hermeticism requirement; a seam is a place behaviour genuinely varies with a
 * second shipped adapter. Counting a fake clock as an adapter would let anyone
 * call any injected dependency a seam, and then the rule stops meaning anything.
 *
 * Marked **speculative — do not build**: a report renderer (formatting a value
 * the caller already holds needs no seam, and giving this module an output
 * channel would give it a network); a baseline store (`accept` returns a plain
 * value; loading and saving it is the caller's six lines); a gate-policy plugin
 * (`GateFloors` is data, and the second "adapter" nobody has asked for is
 * absolute thresholds); a scheduler (bounded semaphore, one adapter, it is a
 * number in `Limits`).
 *
 * ## The limit of the guarantee, stated rather than implied
 *
 * Every node this module mediates is captured, and skipping it is not
 * expressible at this interface. That is **not** the same as "no unrecorded
 * execution is possible". A subject's `decide` is application code holding its
 * own closure: it can `import` a provider SDK and call a model directly, and no
 * type in this package can reach outside this package. This module records the
 * surrounding `decision` node but not that call, its tokens or its cost.
 *
 * Three responses, in descending order of strength, and the first is not a type:
 *
 *   1. **Detection, not prevention.** A decision subtree with no recorded model
 *      call, from a subject that did not declare itself pure, is an
 *      `UnattributedDecision` — unscored, against the coverage floor, and it
 *      fails the gate. Out-of-band work is *detected*, not merely regretted.
 *   2. **This module has no network capability at all.** It contains nothing
 *      that can open a socket; the only thing that dials is the injected
 *      `ModelBackend`. A test cannot reach a live model with real credentials
 *      present in the environment because there is nothing here to reach it
 *      with.
 *   3. **The artefact states its own scope.** Every report and every run header
 *      carries `capturedVia: "injected-client-only"`. A reader in 2033 learns
 *      the limits of the evidence from the evidence.
 *
 * The honest claim is *unrepresentable through `evals`*, not *unrepresentable*,
 * and this file says so rather than letting the stronger claim stand.
 *
 * See `docs/CONTEXT.md` for the vocabulary, `docs/design/design-it-twice/
 * FINDINGS.md` for the hybrid this implements, and
 * `docs/design/OPEN-ITEMS-RESOLVED.md` for the settled decisions.
 */

export type {
  Capability,
  Client,
  EffectCommand,
  ModelBackend,
  ModelId,
  ModelRequest,
  ModelResponse,
  PromptVersion,
  ReadOnlyClient,
  WriteCapableClient,
} from "./lib/clients.js";
export { modelId, promptVersion } from "./lib/clients.js";

export type {
  AppendEvalNode,
  CaseDigest,
  CaseRef,
  CaseSource,
  Clock,
  DecisionContext,
  EvalCase,
  EvalNode,
  EvalNodeId,
  EvalNodeKind,
  EvalNodeStore,
  EvalPayload,
  ExpectationOf,
  JudgeDescriptor,
  Limits,
  NodeContext,
  NodeHandle,
  NodeOutcome,
  NodeSpec,
  ObservationWindow,
  PayloadField,
  PriceTable,
  Purity,
  RecordedProvenance,
  RecorderDeps,
  Redactor,
  RiskTier,
  RunId,
  ScoreOutcome,
  Scorer,
  ScorerDescriptor,
  ScorerDigest,
  ScorerId,
  ScoringContext,
  Seed,
  SettleEvalNode,
  SourceDigest,
  SourceKind,
  StoredEvalRun,
  StoredRunHeader,
  Subject,
  SubjectSpec,
  SubjectVersion,
  TraceDigest,
  Verdict,
} from "./lib/types.js";
export { abstain, caseRef, determine, scorerId, seed, subjectVersion } from "./lib/types.js";

export { defineSubject } from "./lib/subject.js";

/** The recorder. Branded — a caller-supplied no-op does not typecheck. */
export type { EvalRecorder } from "./lib/recorder.js";
export { createEvalRecorder } from "./lib/recorder.js";

/** Store adapters. Two, which is what makes `EvalNodeStore` a real seam. */
export { inMemoryEvalNodeStore } from "./lib/in-memory-store.js";
export type { InMemoryStoreLimits } from "./lib/in-memory-store.js";
export { sqlEvalNodeStore } from "./lib/sql-store.js";
export type { SqlEvalStoreLimits, SqlExecutor, SqlRow } from "./lib/sql-store.js";

/** Case-source adapters. Two, and they are what the report type is derived from. */
export type {
  GoldenCaseDraft,
  GoldenSuiteInput,
  HumanDecisionSource,
  RecordedCaseDraft,
  RecordedCasesInput,
  RecordedHumanDecision,
} from "./lib/sources.js";
export {
  goldenSuite,
  humanDecisionsFromAuditTrace,
  legacyReviewerExport,
  recordedCases,
} from "./lib/sources.js";

/** Scorer adapters. Two: one deterministic, one a judge panel. */
export type { JudgePanelInput } from "./lib/scorers.js";
export { exactVerdict, judgePanel, scriptedModelBackend } from "./lib/scorers.js";

export type {
  AccuracyCaseResult,
  AccuracyCaseStatus,
  AccuracyReport,
  AgreementCaseResult,
  AgreementCaseStatus,
  AgreementReport,
  Attribution,
  Determinism,
  Disagreement,
  RunFacts,
} from "./lib/report.js";
export { INTERPRETATION } from "./lib/report.js";

export type { ReportOf, RunSpec } from "./lib/run.js";
export { DEFAULT_LIMITS, run } from "./lib/run.js";

export type {
  Baseline,
  BaselineCase,
  GateBlockReason,
  GateCounts,
  GateFloors,
  GateInput,
  GateOutcome,
} from "./lib/gate.js";
export { accept, DEFAULT_FLOORS, gate } from "./lib/gate.js";

/** Byte-stable serialisation, exposed so an auditor can recompute it. */
export {
  basisPoints,
  canonicalPayloadForm,
  digestOf,
  DIGEST_ALGORITHM,
  EVAL_DIGEST_VERSION,
  EVAL_ENVELOPE_VERSION,
} from "./lib/canonical.js";

export {
  BaselineRefused,
  EvalsError,
  EvalStoreUnavailable,
  LimitOutOfRange,
  NoSuchRun,
  PanelMisdeclared,
  RecorderNotMinted,
  RunBudgetExhausted,
  SubjectAttemptedWrite,
  SuiteEmpty,
  SuiteUnversioned,
  SuiteVersionMismatch,
  UnserialisablePayload,
} from "./lib/errors.js";
