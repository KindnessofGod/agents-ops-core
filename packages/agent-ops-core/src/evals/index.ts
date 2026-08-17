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
 * `accept`, `goldenSuite`, `defineSubject`, `exactVerdict`, `judgePanel`,
 * `preMergeSubset`, `runKeyOf`, `exitCodeFor`, `mintCompletedRun` and
 * `reopenAccuracyReport` / `reopenAgreementReport` are constructors of argument
 * types and readers of artefacts: they evaluate nothing, open no node and reach
 * no store. A third *executing* entry point is a signal to **split the module**,
 * not to extend it — and the accounting is stated plainly because that
 * distinction is exactly the one somebody will use next year to add
 * `generateSuite()` as "just a constructor".
 *
 * Two of them are worth reading against that rule rather than assumed to pass
 * it. `runKeyOf` is pure and is the reason idempotency did **not** need a fourth
 * verb: a caller asks the ledger `findCompleted(runKeyOf(spec))` to find out
 * whether a run will cost anything, and `run` itself does the same thing
 * internally. `exitCodeFor` is a decision about what a failure *means*, and
 * decisions about meaning belong where they can be tested — a `bin` wrapper over
 * it is four lines, and none of the nineteen applications should be
 * re-deriving in shell whether a rate-limit storm is a regression.
 *
 * **`recordedCases` is not in that list, and the earlier version of this comment
 * put it there.** It is `async`; it calls `humanDecisions.decisionFor` once per
 * case; and the shipped `humanDecisionsFromAuditTrace` adapter replays against
 * the **audit store**, so it performs up to `maxCases` sequential round trips
 * before any run exists. It opens no node — no run is open yet, and a trace
 * never spans both stores — which is why `run` writes a `source` node carrying
 * what it found: the named adapter, the window, how many cases were considered
 * and how many were dropped for having no human decision. The cohort's assembly
 * is in the trace; the I/O that produced it is not, and saying otherwise was a
 * claim about the strongest constraint in this project that the code did not
 * deliver.
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
 * **`EvalNodeStore` is branded the same way**, because the recorder's brand on
 * its own only moved the forgery one layer down: a genuine recorder over an
 * object-literal store that echoed the header and returned `{ header, nodes: []
 * }` produced `correctBasisPoints: 10000`, attribution `complete`, a
 * valid-looking trace digest and a passing gate, with no cast anywhere. An
 * application brings its own database through `sqlEvalNodeStore`'s injected
 * `SqlExecutor`, not by implementing this interface.
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
 *   Attribution.   A decision subtree that **contradicts its own purity
 *                  declaration** — `"calls-models"` with no recorded call, or
 *                  `"pure"` with one — is an `UnattributedDecision`: unscored,
 *                  against the coverage floor, and it fails the gate. A
 *                  `"pure"` subject that records nothing is `declared-pure`
 *                  with coverage `0`, **not** `complete` with coverage `10000`:
 *                  the check is a declaration, not a measurement, and the
 *                  report says which. See the honesty note at the foot.
 *   Idempotent.    `run` is content-addressed by `runKeyOf(spec)` — source
 *                  digest, subject version and purity, scorer digests, seed,
 *                  price-table version, every limit. **Re-running a completed
 *                  key returns the original report and executes nothing**: the
 *                  original `runId`, `startedAt` and `traceDigest`, not a fresh
 *                  run that happens to agree. An interrupted run **resumes** —
 *                  200 cases dying at 180 pays for 20, and the 180 arrive as
 *                  `case` nodes stamped with the run and node they came from, so
 *                  the trace says they were not observed today. A **partial run
 *                  is never memoised as complete**: `mintCompletedRun` is the
 *                  only producer of the ledger's write type and refuses one, so
 *                  a budget-exceeded run cannot become a permanent, free,
 *                  biased pass. There is no `force: true`; to re-execute,
 *                  change something the key is made of.
 *   Determinism.   **Checked, not declared.** A seeded sample of the run's own
 *                  cases is re-executed under the identical seed and the
 *                  verdicts compared byte for byte, bounded by
 *                  `Limits.determinismSampleCases` (2 by default, 0 switches it
 *                  off and the report then says `not-checked` and why). The
 *                  report carries `declared` *and* `check`, and the check states
 *                  `compared: "subject-verdict"` — the scorers are not re-run,
 *                  because a judge panel is non-deterministic by construction
 *                  and says so. A subject that answers differently on
 *                  re-execution blocks the gate: every other number here — the
 *                  baseline, the comparison, the replay — assumes it would not.
 *   Coverage.      A pre-merge **subset** is a `CaseSource` with its own content
 *                  address, not a flag: high-tier and quarantined cases are
 *                  pinned and are never dropped to fit the budget, the seeded
 *                  remainder is recorded by reference, and `notSelected` is
 *                  enumerated so `gate` can tell "the pre-merge run skipped it"
 *                  from "somebody deleted it". A green gate states what it
 *                  covered, on the pass line. A subset never advances a
 *                  baseline.
 *   Availability.  A provider that will not serve is **not a regression**.
 *                  `ProviderUnavailable` — a 429, a 503, a reset, raised by the
 *                  `ModelBackend` adapter — makes a case `could-not-evaluate`:
 *                  its own status, its own rate, its own gate reason, its own
 *                  exit code. It is still bounded, counting against
 *                  `maxCaseFailures` so a storm stops the run rather than
 *                  hammering the provider for the other 199 cases.
 *   Exit codes.    `exitCodeFor` is a library function, so the decision is
 *                  testable without a process: `0` pass, `1` evidence failure,
 *                  `2` could-not-evaluate, `3` integrity failure. Could-not-
 *                  evaluate never returns `0`, and an unrecognised throw is `3`
 *                  rather than `1`. The block-reason classification is a
 *                  `switch` with no `default`, so adding a gate reason without
 *                  classifying it does not compile.
 *   Judges.        Non-deterministic and they say so. Model and prompt version
 *                  recorded per sample; aggregated over an odd n ≥ 3; a panel
 *                  that splits beyond its declared band is `contested`, carrying
 *                  every sample. Disagreement is surfaced, never averaged away.
 *   Unscored.      Never `passed`. A case nobody could measure counts against
 *                  the gate.
 *   Partial.       A run that stopped early is `partial: true` and **cannot pass
 *                  a gate**. A biased sample published as a pass invites being
 *                  read as complete.
 *   Bounded.       Concurrency 1..32, retries 0..5, a bounded store, and — the
 *                  three that were claimed and absent — **wall clocks that
 *                  terminate something**, a cost ceiling checked *inside* a
 *                  case, and a batch-limited `expireBefore`. Both wall clocks
 *                  race the subject and the scorers, so a subject that ignores
 *                  `ctx.signal` bounds the run instead of hanging it; the
 *                  ceiling is checked after every recorded model call rather
 *                  than between cases; retention takes a required batch limit.
 *                  Target: 200 golden cases under 5 minutes at concurrency 8.
 *                  What is *not* bounded, stated because JavaScript cannot:
 *                  the subject's own promise. Nothing here kills it. The run
 *                  terminates, the node is settled `timeout`, the report is
 *                  `partial`, and the abandoned work runs on.
 *   Alerting.      `under-recording-detected` — the sixth silent condition — is
 *                  raised through `RecorderDeps.alerting` at the end of a run
 *                  that found decisions with no model call beneath them. The
 *                  gate already blocks on the same fact, and that is right for a
 *                  change a developer is watching land; it is wrong for a
 *                  nightly run, where a red build is a line in a report nobody
 *                  opens until Monday while the subject has been thinking
 *                  somewhere unrecorded since Thursday. One alert per run, not
 *                  one per case, carrying the run identifier — an eval run has
 *                  no case, and saying so is better than inventing one.
 *   Integers.      Every number in a payload is a safe integer — cost in
 *                  tenth-cents, latency in micros, scores in basis points. No
 *                  IEEE-754 anywhere, because byte-stable serialisation is what
 *                  makes replay possible and floats are how it dies quietly.
 *   Clock.         Injected, and so is the **passage** of time: `Timers` drives
 *                  both wall clocks and the retry backoff, so neither reaches
 *                  for ambient `setTimeout`. `Date.now()` and `Math.random()`
 *                  do not appear in this module — run identifiers come from the
 *                  injected clock plus a per-recorder counter, which is why a
 *                  test can drive a backoff sequence rather than wait for it.
 *   Fail policy.   `EvalStoreUnavailable` is fail-closed at every tier with no
 *                  configuration key, **on every path including scoring**. It
 *                  was not: `judgePanel`'s bare `catch {}` and the runner's
 *                  scorer catch both swallowed it, so a store failing only on
 *                  `judge.sample` yielded `unscored: judge-unavailable` and a
 *                  report. Both now rethrow any `EvalsError` whose `incident`
 *                  is true — which covers `SubjectAttemptedWrite` from a rogue
 *                  scorer as well, documented as aborting the whole run and
 *                  previously reduced to a detail string. This is deliberately
 *                  the **opposite** of `audit`'s per-tier policy: `audit` lets
 *                  a low-tier decision proceed unrecorded because a real
 *                  customer is waiting, and an eval run has no customer. An
 *                  unrecorded eval run produces a number nobody can check.
 *   Redaction.     Applied to **reports as well as nodes**, under the policy the
 *                  nodes used, with `redaction` stamped on the report. Reports
 *                  outlive the node graph — the graph expires at 90 days — and
 *                  they used to carry `authority` (a named person), the
 *                  correlation identifier and every verdict conclusion
 *                  unredacted into the long-lived artefact.
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
 * rather than of the run — and there is now code that does it. `lib/upcast.ts`
 * is the reader: both store adapters decode every row through it, a known
 * envelope passes, a known older envelope goes through a registered upcaster,
 * and an unknown envelope, node kind or outcome is `UnreadableEnvelope` rather
 * than a plausible-looking node. `READABLE_ENVELOPES` says what this build can
 * decode. Until that existed the three version stamps were written by
 * everything and read by nothing, and the SQL adapter cast its `outcome` and
 * `kind` columns straight through — which is a stamp, not a schema-evolution
 * story.
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
 *                          what makes hermeticity structural. Both are branded,
 *                          so this seam's extension point for an application is
 *                          `sqlEvalNodeStore`'s injected `SqlExecutor` — its
 *                          own pool, its own database — not a third
 *                          implementation of the interface.
 *   `Timers`               `systemTimers` / `manualTimers`. Reading the clock
 *                          and waiting on it are different dependencies and
 *                          only the first was injected, so the wall clocks and
 *                          the backoff were the one part of this module with
 *                          real timing behaviour that no test could drive.
 *   `HumanDecisionSource`  `humanDecisionsFromAuditTrace` / `legacyReviewerExport`.
 *                          The second is not hypothetical — every one of the
 *                          nineteen has a first shadow run, and at that point
 *                          the reviewers' decisions were never in `audit`.
 *   `RunLedger`            `inMemoryRunLedger` / `sqlRunLedger`. Idempotency and
 *                          resume. Branded for a sharper reason than the store
 *                          is: `findCompleted` returns a report **without
 *                          executing anything**, so a hand-rolled ledger is the
 *                          cheapest possible way to make a build green and,
 *                          unlike a deleted golden case, it leaves no diff. The
 *                          in-memory one forgets at process exit — right for a
 *                          test, wrong for continuous integration, and a
 *                          property of the adapter rather than of the seam.
 *
 * `ModelBackend` is a seam with one shipped adapter (`scriptedModelBackend`) and
 * nineteen unshipped ones — the applications' own provider clients. Counted as
 * real on that basis and flagged here rather than dressed up.
 *
 * `Clock` and `Redactor` are **injected, not seamed**. Injection is a
 * hermeticism requirement; a seam is a place behaviour genuinely varies with a
 * second shipped adapter. Counting a fake clock as an adapter would let anyone
 * call any injected dependency a seam, and then the rule stops meaning anything.
 * `Timers` is counted as a seam on the same test and passes it: the two adapters
 * genuinely differ in behaviour — one advances by itself and one does not — and
 * both ship.
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
 *   1. **Detection, and only of one shape of it.** A decision subtree with no
 *      recorded model call, from a subject that did not declare itself pure, is
 *      an `UnattributedDecision` — unscored, against the coverage floor, and it
 *      fails the gate. That is the whole of the detection, and this used to be
 *      written as "out-of-band work is *detected*, not merely regretted", which
 *      overstates it in two directions that both matter:
 *
 *      - **`purity: "pure"` turns the check off.** A subject that declares
 *        itself pure and does all of its thinking through a provider SDK
 *        produced attribution `complete`, coverage `10000`, cost `0`, tokens
 *        `0` and a passing gate. Nothing in this module can tell that apart
 *        from a rules engine, so it no longer pretends to: such a run is
 *        `declared-pure` with coverage `0`, the gate records the declaration,
 *        and the number a reader sees is an assertion by the subject's author
 *        rather than a measurement. The one thing that *is* checkable — a
 *        `"pure"` subject that does record calls — is now a misdeclaration and
 *        fails the gate.
 *      - **Under `"calls-models"` the check is a floor of one.** A single
 *        recorded three-token call satisfies it. That is not fixable, so it is
 *        made visible instead: `modelCalls` and `costTenthCents` are on every
 *        case result, and "high-tier underwriting determination, 1 call, 3
 *        tokens" is a shape a reviewer can see without having to allege
 *        anything.
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
 * ## The report brands hold in one process, and only there
 *
 * `AccuracyReport` and `AgreementReport` are sealed with non-exported `unique
 * symbol`s, so neither is assignable to the other and `gate` accepts only the
 * first. That is a **compile-time, single-process** guarantee. It does not
 * survive `JSON.stringify`, and the flow this gate exists for — run in
 * continuous-integration job A, write JSON, gate in job B — could therefore only
 * re-enter through a cast, at which point nothing was checked at all.
 *
 * So the boundary is carried by three things instead of one:
 *
 *   1. The brands, in process, unchanged.
 *   2. The literal `schema` and `against` fields, which do survive
 *      serialisation and are what `reopenAccuracyReport` reads.
 *   3. `reopenAccuracyReport` itself: the validating re-entry. It refuses an
 *      agreement report's JSON by schema, refuses any figure that is not a safe
 *      integer, and **recomputes the four rates from the cases**, so a report
 *      whose headline numbers do not follow from its own contents is refused
 *      rather than gated. `gate` runs the same validation on whatever it is
 *      handed, so a cast-in report is refused at runtime too.
 *
 * What that does **not** prove, stated rather than implied: that the run
 * happened. `reopenAccuracyReport` establishes that an artefact is of the right
 * kind and internally consistent. Establishing that it came from a real run
 * means reading the trace out of the eval store by `runId` and recomputing
 * `traceDigest` — which needs the store, and is what an auditor does rather than
 * what a gate does.
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
  CaseMemo,
  CaseRef,
  CaseSource,
  Clock,
  CompletedRunRecord,
  DecisionContext,
  EvalCase,
  EvalNode,
  EvalNodeId,
  EvalNodeKind,
  EvalNodeStore,
  EvalPayload,
  ExpiryResult,
  ExpectationOf,
  JudgeDescriptor,
  LedgerExpiryResult,
  Limits,
  MemoisedStatus,
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
  RunKey,
  RunLedger,
  RunLedgerMethods,
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
  StoredCaseMemo,
  StoredCompletedRun,
  StoredEvalRun,
  StoredRunHeader,
  Subject,
  SubjectSpec,
  SubjectVersion,
  SubsetSelection,
  Timers,
  TraceDigest,
  Verdict,
} from "./lib/types.js";
export { abstain, caseRef, determine, scorerId, seed, subjectVersion } from "./lib/types.js";

/** Timer adapters. Two, which is what makes `Timers` a real seam. */
export type { ManualTimers } from "./lib/timers.js";
export { manualTimers, systemTimers } from "./lib/timers.js";

export { defineSubject } from "./lib/subject.js";

/** The recorder. Branded — a caller-supplied no-op does not typecheck. */
export type { EvalRecorder } from "./lib/recorder.js";
export { createEvalRecorder } from "./lib/recorder.js";

/** Store adapters. Two, which is what makes `EvalNodeStore` a real seam. */
export { inMemoryEvalNodeStore } from "./lib/in-memory-store.js";
export type { InMemoryStoreLimits } from "./lib/in-memory-store.js";
export { EVAL_STORE_SCHEMA_SQL, sqlEvalNodeStore } from "./lib/sql-store.js";
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

/** Ledger adapters. Two, which is what makes `RunLedger` a real seam. */
export type { InMemoryLedgerLimits } from "./lib/ledger.js";
export {
  EVAL_LEDGER_SCHEMA_SQL,
  inMemoryRunLedger,
  mintCompletedRun,
  reopenMemoisedReport,
  sqlRunLedger,
} from "./lib/ledger.js";

/** Pre-merge subset selection: seeded, budget-sized, high tier and quarantine pinned. */
export type { SubsetInput } from "./lib/subset.js";
export { preMergeSubset } from "./lib/subset.js";

export type {
  AccuracyCaseResult,
  AccuracyCaseStatus,
  AccuracyReport,
  AgreementCaseResult,
  AgreementCaseStatus,
  AgreementReport,
  Attribution,
  Determinism,
  DeterminismCheck,
  Disagreement,
  Memoisation,
  RunFacts,
} from "./lib/report.js";
export {
  INTERPRETATION,
  READABLE_REPORT_SCHEMAS,
  reopenAccuracyReport,
  reopenAgreementReport,
} from "./lib/report.js";

export type { ReportOf, RunSpec } from "./lib/run.js";
export { DEFAULT_LIMITS, run, runKeyOf } from "./lib/run.js";

export type {
  Baseline,
  BaselineCase,
  GateBlockReason,
  GateCounts,
  GateCoverage,
  GateFloors,
  GateInput,
  GateOutcome,
} from "./lib/gate.js";
export { accept, DEFAULT_FLOORS, gate } from "./lib/gate.js";

/**
 * The command-line adapter's verdict, as a function — so the decision is
 * testable without spawning a process. A `bin` wrapper over it is four lines.
 */
export type { EvalExitCode, ExitDecision, ExitInput, ExitKind } from "./lib/exit.js";
export { exitCodeFor } from "./lib/exit.js";

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
  DuplicateCaseRef,
  EvalsError,
  EvalStoreUnavailable,
  LedgerCorrupt,
  LedgerNotMinted,
  LedgerUnavailable,
  LimitOutOfRange,
  MemoisedCaseMismatch,
  NodeSettledTwice,
  NoSuchRun,
  PanelMisdeclared,
  ProviderUnavailable,
  RecorderNotMinted,
  ReportRefused,
  RunBudgetExhausted,
  RunNotMemoisable,
  StoreNotMinted,
  SubjectAttemptedWrite,
  SubsetUnselectable,
  SuiteEmpty,
  SuiteUnversioned,
  SuiteVersionMismatch,
  UnreadableEnvelope,
  UnserialisablePayload,
} from "./lib/errors.js";

/** The read half of the seven-year story: which envelopes this build decodes. */
export { READABLE_ENVELOPES } from "./lib/upcast.js";
