/**
 * Named error modes. Every one states its fail policy **and the reason for it**,
 * because a reader who learns one module's policy will assume the others match
 * and they deliberately do not.
 *
 * The asymmetry with `audit` is the one to internalise. `audit` lets a low-tier
 * decision proceed unrecorded, because a real customer is waiting and the case
 * is worth more than its trace. **An eval run has no customer.** An unrecorded
 * eval run produces a number nobody can check, and being checkable is this
 * module's only purpose — so there is no tier, and no configuration key, at
 * which continuing unrecorded is the right answer. `EvalStoreUnavailable` is
 * fail-closed everywhere and always.
 *
 * Nothing here throws for an **abstention**. Per `docs/CONTEXT.md` an abstention
 * is a successful outcome of a working system; it is a verdict, scored against
 * the golden case's expectation like any other, and a golden case may assert
 * that abstaining is the correct answer.
 */

export abstract class EvalsError extends Error {
  /** `true` when the condition is an incident rather than a metric movement. */
  abstract readonly incident: boolean;
}

/**
 * A payload field is not a safe integer, or nests.
 *
 * Fail-closed, before any write. Byte-stable serialisation is what makes replay
 * possible and IEEE-754 is how it dies quietly: `0.665` does not serialise
 * identically on every host, and a replay diff full of float noise is a replay
 * nobody reads. Cost is in tenth-cents, latency in micros, scores in basis
 * points, and there is no exception.
 */
export class UnserialisablePayload extends EvalsError {
  override readonly name = "UnserialisablePayload";
  override readonly incident = false;
  constructor(
    readonly path: string,
    readonly why: string,
  ) {
    super(`payload field ${path} is not serialisable: ${why}`);
  }
}

/**
 * The eval node store could not accept a write, or could not be read.
 *
 * **Fail-closed at every tier, with no configuration key.** See the note at the
 * top of this file: an unrecorded eval run is worthless, unlike an unrecorded
 * low-tier decision. The run aborts; no report is produced. Nodes already
 * written stay written and stay replayable.
 */
export class EvalStoreUnavailable extends EvalsError {
  override readonly name = "EvalStoreUnavailable";
  override readonly incident = true;
  constructor(
    readonly operation: string,
    override readonly cause: unknown,
  ) {
    super(
      `eval node store unavailable during ${operation}${typeof cause === "string" ? `: ${cause}` : ""}`,
    );
  }
}

/**
 * A recorder arrived that this module did not mint.
 *
 * Fail-closed, **incident**. The brand is a non-exported `unique symbol`, so a
 * structural impostor does not typecheck; reaching this error means somebody
 * defeated the type with `as` or `any`. It matters because the failure it
 * prevents is silent: a two-line no-op recorder acknowledges every node, every
 * downstream check reports success, the report comes back green, and nothing was
 * ever written anywhere.
 *
 * The thing being measured does not choose its own witness.
 */
export class RecorderNotMinted extends EvalsError {
  override readonly name = "RecorderNotMinted";
  override readonly incident = true;
  constructor() {
    super(
      "this recorder was not minted by createEvalRecorder; the thing being measured does not choose its own witness",
    );
  }
}

/**
 * An eval node store arrived that this module did not mint.
 *
 * Fail-closed, **incident**, and it is the sibling of `RecorderNotMinted` — the
 * one that closes the hole that error's own doc comment claimed to close.
 *
 * The recorder's brand stops a caller supplying a no-op *recorder*. It did
 * nothing about a no-op **store** underneath a genuine recorder: an object
 * literal that echoes the header, fabricates nodes and returns `{ header,
 * nodes: [] }` from `read()` produced `correctBasisPoints: 10000`, attribution
 * `complete`, a valid-looking trace digest, `nodes: 0` and a passing gate — with
 * no cast anywhere. The forgery had moved one layer down.
 *
 * So `EvalNodeStore` is branded too. Reaching this error means somebody defeated
 * the type with `as` or `any`.
 */
export class StoreNotMinted extends EvalsError {
  override readonly name = "StoreNotMinted";
  override readonly incident = true;
  constructor() {
    super(
      "this eval node store was not minted by inMemoryEvalNodeStore or sqlEvalNodeStore; a forged store makes every downstream check report success while nothing is written",
    );
  }
}

/**
 * A node was settled twice.
 *
 * Fail-closed, **incident**. `EvalNodeStore` states that settling twice is an
 * error rather than a no-op, and the recorder used to swallow the second call
 * before the store ever saw it — so the contract held at one layer and was
 * silently contradicted at the one above. A node closed twice makes the recorded
 * outcome depend on which path got there first, which makes the trace's ordering
 * a lie. The recorder now settles each node on exactly one path and this error
 * is what happens if that ever stops being true.
 */
export class NodeSettledTwice extends EvalsError {
  override readonly name = "NodeSettledTwice";
  override readonly incident = true;
  constructor(readonly node: string) {
    super(`node ${node} was settled twice; settling twice is an error, not a no-op`);
  }
}

/**
 * Two cases in one source carry the same reference.
 *
 * Fail-closed at construction, and again at run open for a hand-rolled source.
 * Both copies execute and both open a `case` node, but results are keyed by
 * reference — so the report showed `casesRun: 2` with the same node id listed
 * twice and one execution's outcome silently discarded. The trace and the report
 * then disagree about what happened, which is the one thing neither may do.
 */
export class DuplicateCaseRef extends EvalsError {
  override readonly name = "DuplicateCaseRef";
  override readonly incident = false;
  constructor(readonly ref: string) {
    super(`case reference ${ref} appears more than once in this source`);
  }
}

/**
 * A stored node cannot be read under any envelope this build knows.
 *
 * Fail-closed. This is the read half of the seven-year story, and without it the
 * three version stamps were written by everything and read by nothing: the SQL
 * adapter cast `outcome` and `kind` straight out of their columns, so a value
 * written by a future build — or a corrupted one — became a plausible-looking
 * node rather than a refusal. A trace that cannot be read under a known envelope
 * must say so; reinterpreting it under today's rules is how a 2033 reader is
 * misled quietly.
 */
export class UnreadableEnvelope extends EvalsError {
  override readonly name = "UnreadableEnvelope";
  override readonly incident = true;
  constructor(
    readonly node: string,
    readonly detail: string,
  ) {
    super(`node ${node} cannot be read: ${detail}`);
  }
}

/**
 * A value offered as a report is not one this module would have produced.
 *
 * Fail-closed. The two report brands are phantom `unique symbol`s, so their
 * disjointness holds **in one process only**. The flow this module exists for —
 * run in continuous-integration job A, serialise to JSON, gate in job B — can
 * only re-enter through a cast, and `gate` performed no runtime check at all.
 *
 * `reopenAccuracyReport` is the honest re-entry: it checks the literal `schema`
 * and `against` fields, checks every figure is a safe integer, and
 * **recomputes the rates from the cases**, refusing a report whose headline
 * numbers do not follow from its own contents. `gate` runs the same validation
 * on whatever it is handed, so a cast-in agreement report is refused at runtime
 * as well as at compile time.
 */
export class ReportRefused extends EvalsError {
  override readonly name = "ReportRefused";
  override readonly incident = false;
  constructor(readonly why: string) {
    super(`refusing this value as an accuracy report: ${why}`);
  }
}

/**
 * A case source presented itself without a content address.
 *
 * Fail-closed at run open, before the first model call and before any money is
 * spent. A report against an unversioned suite is a number with no referent:
 * nobody can say later what it was measured against. The shipped `goldenSuite`
 * adapter makes this unreachable by computing the digest at construction — this
 * error exists for a hand-rolled `CaseSource`, which is the only way to get
 * here.
 */
export class SuiteUnversioned extends EvalsError {
  override readonly name = "SuiteUnversioned";
  override readonly incident = false;
  constructor(readonly detail: string) {
    super(`case source is not content-addressed: ${detail}`);
  }
}

/**
 * The declared digest and the computed digest of a suite differ.
 *
 * Fail-closed at construction. Somebody edited a golden case without
 * re-versioning it; continuing would produce a report that lies about what it
 * tested, which is worse than no report.
 */
export class SuiteVersionMismatch extends EvalsError {
  override readonly name = "SuiteVersionMismatch";
  override readonly incident = false;
  constructor(
    readonly expected: string,
    readonly computed: string,
  ) {
    super(`suite digest mismatch: pinned ${expected}, computed ${computed}`);
  }
}

/**
 * A suite was constructed with no cases.
 *
 * Fail-closed. A zero-case suite passes every gate trivially, which is the
 * silent-pass failure wearing a different hat.
 */
export class SuiteEmpty extends EvalsError {
  override readonly name = "SuiteEmpty";
  override readonly incident = false;
  constructor() {
    super("a suite with no cases would pass every gate trivially");
  }
}

/**
 * The subject — **or a scorer** — reached for a write during an evaluation.
 *
 * **Fail-closed, abort the entire run**, not just the case, and that is now true
 * on both paths. It used to be true only for the subject: a rogue scorer's write
 * attempt was caught by the scoring path's blanket `catch`, converted to an
 * ordinary `unscored` outcome with the incident reduced to a detail string, and
 * the run completed normally. A subject or scorer that attempted an effect may
 * have completed one through a channel this module does not own, so the
 * no-effect guarantee is void for the whole run and every remaining case is
 * suspect. An incident, not a data point.
 *
 * Both fields are recorded because an incident responder needs both. `caseRef`
 * is the case — it used to be constructed from the *node* name, so it read
 * `decide` or `exactVerdict` while the field was called `caseRef`, which is
 * precisely the identifier that is useless at 3am. `at` is the node.
 *
 * The compile-time guarantee is primary — `Client<"read">` and `Client<"write">`
 * are disjoint in both directions, so a subject that asks for a write-capable
 * client does not typecheck. This is the runtime backstop for a subject
 * assembled dynamically or typed through `any`.
 */
export class SubjectAttemptedWrite extends EvalsError {
  override readonly name = "SubjectAttemptedWrite";
  override readonly incident = true;
  constructor(
    readonly caseRef: string,
    /** The node the attempt was made from: `decide`, `judge.sample`, … */
    readonly at: string,
  ) {
    super(`an effect was attempted during case ${caseRef}, at node ${at}`);
  }
}

/**
 * A limit is outside its permitted range.
 *
 * Fail-closed at run open. Unbounded concurrency rate-limits the provider and
 * produces failures that read as regressions; an unbounded budget is not a
 * budget. Every bound in this module has a ceiling and the ceiling is checked
 * before the first case runs.
 */
export class LimitOutOfRange extends EvalsError {
  override readonly name = "LimitOutOfRange";
  override readonly incident = false;
  constructor(
    readonly limit: string,
    readonly value: number,
    readonly permitted: string,
  ) {
    super(`limit ${limit}=${value} is outside ${permitted}`);
  }
}

/**
 * A judge panel was declared with an even or too-small size.
 *
 * Fail-closed at construction. A single judge call is an opinion, and an even
 * panel has no majority. Interface fact 6 requires n > 1 and this module
 * requires n odd and at least 3.
 */
export class PanelMisdeclared extends EvalsError {
  override readonly name = "PanelMisdeclared";
  override readonly incident = false;
  constructor(readonly detail: string) {
    super(`judge panel misdeclared: ${detail}`);
  }
}

/**
 * The run exhausted its wall-clock or failure budget.
 *
 * Fail-closed: the run stops and the report is marked `partial: true`. A
 * partial report can be read, and its nodes replayed, but **it cannot pass a
 * gate** — a run that stopped at case 41 of 200 has a biased sample and
 * publishing it as a pass invites reading it as complete.
 */
export class RunBudgetExhausted extends EvalsError {
  override readonly name = "RunBudgetExhausted";
  override readonly incident = false;
  constructor(
    readonly which: "wall-clock" | "case-failures" | "cost",
    readonly detail: string,
  ) {
    super(`run budget exhausted (${which}): ${detail}`);
  }
}

/**
 * A report was offered as a baseline and refused.
 *
 * Fail-closed. Accepting a partial run, or one with unattributed decisions, as
 * the standard bakes the failure in: everything measured afterwards is measured
 * against a run that did not finish, or against a run whose thinking happened
 * somewhere nobody can see. A bad baseline is worse than no baseline, because it
 * looks like one.
 */
export class BaselineRefused extends EvalsError {
  override readonly name = "BaselineRefused";
  override readonly incident = false;
  constructor(readonly why: string) {
    super(`refusing to accept this report as a baseline: ${why}`);
  }
}

/**
 * A run was asked for from a store that has never seen it.
 *
 * Fail-closed. An empty run and a missing run mean very different things, and a
 * silent empty result lets "we have no record" masquerade as "nothing
 * happened".
 */
export class NoSuchRun extends EvalsError {
  override readonly name = "NoSuchRun";
  override readonly incident = false;
  constructor(readonly runId: string) {
    super(`no such eval run: ${runId}`);
  }
}

/**
 * The provider could not be reached, or refused the call for capacity reasons —
 * a 429, a 503, a quota exhaustion, a connection reset.
 *
 * **Fail-open per case, and this is the only fail-open policy in the module.**
 * The case becomes `could-not-evaluate`: a status of its own, counted in its own
 * rate, and never folded into `unscored`. A gate blocked on it exits `2`, not
 * `1`.
 *
 * The reason is that a rate-limit storm is not a quality signal and must not be
 * readable as one. Before this existed, a provider throttling an eval run
 * produced unscored cases, `unscored-rate` blocked the gate, and the build
 * reported the same failure it reports when a change makes the system worse.
 * Two very different causes, one indistinguishable red build — so the first one
 * teaches people to ignore the second. **A 429 storm is not a regression.**
 *
 * It is still bounded: could-not-evaluate cases count against
 * `Limits.maxCaseFailures`, so a storm stops the run rather than hammering the
 * provider for the remaining 199 cases. The run then ends `partial`, which also
 * cannot pass a gate.
 *
 * This is the one error a `ModelBackend` adapter is expected to **throw**. The
 * nineteen applications' provider clients raise it when they see a 429 or a 503;
 * anything else they throw is an ordinary model failure and makes the case a
 * genuine `unscored`.
 */
export class ProviderUnavailable extends EvalsError {
  override readonly name = "ProviderUnavailable";
  override readonly incident = false;
  constructor(
    readonly model: string,
    readonly detail: string,
    /** Honoured as a backoff floor, capped. `null` when the provider said nothing. */
    readonly retryAfterMillis: number | null = null,
  ) {
    super(`provider unavailable for ${model}: ${detail}`);
  }
}

/**
 * A run ledger arrived that this module did not mint.
 *
 * Fail-closed, **incident**, and the sibling of `StoreNotMinted` for the same
 * reason: a forged ledger makes `run` return a report that no run produced.
 * `findCompleted` returning a hand-built record is a way to make a build green
 * without executing anything at all — strictly cheaper than deleting a golden
 * case, and invisible.
 */
export class LedgerNotMinted extends EvalsError {
  override readonly name = "LedgerNotMinted";
  override readonly incident = true;
  constructor() {
    super(
      "this run ledger was not minted by inMemoryRunLedger or sqlRunLedger; a forged ledger returns a report no run produced",
    );
  }
}

/**
 * The ledger could not be read or written.
 *
 * **Fail-open, and this is deliberately the opposite of `EvalStoreUnavailable`,
 * which sits four classes above and is fail-closed at every tier.** The
 * difference is what each one costs when it is wrong.
 *
 * A node store that cannot accept a write produces an eval run nobody can check:
 * the number exists and the evidence does not. A ledger that cannot be read
 * produces a run that executes when it did not have to. The first is a false
 * number; the second is a bill. So the run continues, re-executing everything,
 * and the degradation is **stamped on the report** as
 * `memoisation: { kind: "ledger-unavailable" }` rather than swallowed — a
 * fail-open policy that is invisible is indistinguishable from a bug.
 *
 * The one ledger condition that is *not* fail-open is `LedgerCorrupt`, below.
 */
export class LedgerUnavailable extends EvalsError {
  override readonly name = "LedgerUnavailable";
  override readonly incident = false;
  constructor(
    readonly operation: string,
    override readonly cause: unknown,
  ) {
    super(
      `run ledger unavailable during ${operation}${typeof cause === "string" ? `: ${cause}` : ""}`,
    );
  }
}

/**
 * The ledger answered, and what it said cannot be true.
 *
 * **Fail-closed, incident.** A completed-run record whose report is partial, or
 * whose report does not survive `reopenAccuracyReport`, means the memo and the
 * artefact disagree — and the memo is the thing `run` would have returned
 * *instead of executing*. Returning it would publish a number no run produced.
 *
 * This is the specific failure the design review flagged: a run that exceeded
 * its budget produces a `partial` report, and memoising that as if it were
 * complete makes every later run of the same key return a biased sample as a
 * finished one. The write path makes it unrepresentable — `mintCompletedRun`
 * refuses a partial report and is the only producer of the record type — and
 * this is the read-side backstop for a row written by an older build or edited
 * in the database.
 */
export class LedgerCorrupt extends EvalsError {
  override readonly name = "LedgerCorrupt";
  override readonly incident = true;
  constructor(
    readonly runKey: string,
    readonly why: string,
  ) {
    super(`the ledger's record for run key ${runKey} cannot be used: ${why}`);
  }
}

/**
 * A report was offered for memoisation and refused.
 *
 * Fail-closed at the mint, before the ledger sees it. A partial run, an
 * unattributed run, or a run that could not evaluate some of its cases has not
 * established what it claims to have established; memoising it means every
 * later run of the same key returns it **without executing**, so the
 * flattering-but-wrong answer becomes permanent and free.
 */
export class RunNotMemoisable extends EvalsError {
  override readonly name = "RunNotMemoisable";
  override readonly incident = false;
  constructor(readonly why: string) {
    super(`refusing to memoise this run as complete: ${why}`);
  }
}

/**
 * A memoised case does not match the case it would be carried forward onto.
 *
 * Fail-closed, **incident**. The run key content-addresses the source digest, so
 * a case whose content changed changes the key and cannot reach its old memo.
 * Arriving here means the ledger and the source disagree under one key — a
 * hand-rolled `CaseSource`, a ledger shared between two suites, or a row edited
 * by hand. Carrying the memo forward would report a result for a case that was
 * never run in that form.
 */
export class MemoisedCaseMismatch extends EvalsError {
  override readonly name = "MemoisedCaseMismatch";
  override readonly incident = true;
  constructor(
    readonly ref: string,
    readonly expected: string,
    readonly found: string,
  ) {
    super(
      `memoised case ${ref} was recorded against digest ${found} but this source carries ${expected}`,
    );
  }
}

/**
 * A subset was declared that cannot be selected.
 *
 * Fail-closed at construction, before any spend. A subset with a budget below
 * one case, a quarantine naming a case the suite does not contain, or a seed
 * that is empty are all ways to get a pre-merge gate that silently covers
 * nothing — the zero-case suite wearing its third hat.
 */
export class SubsetUnselectable extends EvalsError {
  override readonly name = "SubsetUnselectable";
  override readonly incident = false;
  constructor(readonly why: string) {
    super(`refusing to select this subset: ${why}`);
  }
}
