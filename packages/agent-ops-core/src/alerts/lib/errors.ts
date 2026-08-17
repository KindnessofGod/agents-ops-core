/**
 * Named error modes, each with a fail policy **and the reason for it**.
 *
 * The inversion `audit` established is kept: `degradable` is a property of the
 * error class, so a mode added later is fail-closed unless its author decides
 * otherwise in the class. An allow-list of "safe to swallow" errors is how a
 * programming defect ends up reported as an outage and then dropped.
 *
 * ## The shape of this module's failure policy, in one paragraph
 *
 * There are two kinds of failure in an alerting module and they must not share a
 * policy. A **caller defect** — a float in a payload, an unknown condition kind,
 * an unusable limit, a beat from a component nobody watches — is fail-closed and
 * throws, because it is a bug that will otherwise produce alerts nobody can read
 * or heartbeats nobody watches, and it surfaces on the first run rather than
 * during the first incident. A **delivery failure** — a sink that throws, a sink
 * that hangs, every sink declining — does **not** throw, ever: requirement (f)
 * is that an `AlertSink` failing must not take the case down with it. Those are
 * returned as data on `AlertOutcome`, recorded in the journal, and published in
 * `health()`.
 *
 * That is why there is no `AlertSinkFailed` error class here. A sink failure is
 * not an exception in this module's model; it is a recorded degradation, and
 * making it throwable would invite exactly the `try { alert() } catch {}` that
 * turns a failed alert back into a silent one.
 */

import type { AlertSinkId, ComponentId } from "./primitives.js";
import type { AlertSeverity } from "./severity.js";

/**
 * The family. One `catch` for everything this module raises; `degradable` for
 * callers that want to tell an outage from a defect.
 */
export abstract class AlertError extends Error {
  /** Nothing in this module is degradable. Every mode here is a defect. */
  abstract readonly degradable: boolean;
}

/**
 * A condition carried a value that cannot be recorded byte-stably: a float, an
 * unsafe integer, a NaN, an infinity, or an identifier over the configured
 * ceiling.
 *
 * **Fail-closed, not degradable.** This is a defect at the call site. An alert
 * payload becomes a node on a seven-year trace and a line on an operational
 * stream; a float there is how byte-stable serialisation dies quietly, and an
 * unbounded identifier is how a page becomes unreadable and a payload becomes a
 * denial of service. Degrading would convert a loud programming error into an
 * alert nobody can interpret, which is worse than no alert because it looks like
 * one.
 */
export class AlertPayloadInvalid extends AlertError {
  override readonly name = "AlertPayloadInvalid";
  override readonly degradable = false;
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`alert payload field ${field} is not recordable: ${detail}`);
  }
}

/**
 * A condition arrived with a `kind` outside the closed union — from a JavaScript
 * caller, or a `JSON.parse` of something older or newer than this release.
 *
 * **Fail-closed, not degradable.** The union is closed and exhaustively checked
 * at compile time; reaching this means the compile-time guarantee was bypassed.
 * Guessing a severity for an unknown condition would be inventing the one thing
 * this module exists to get right.
 */
export class UnknownAlertCondition extends AlertError {
  override readonly name = "UnknownAlertCondition";
  override readonly degradable = false;
  constructor(readonly kind: string) {
    super(`unknown alert condition kind: ${kind}`);
  }
}

/**
 * A limit was configured to a value that makes a bound meaningless — a
 * suppression window that is negative, a queue of size zero, a timeout of zero.
 *
 * **Fail-closed at construction, not degradable.** A zero-length queue is not a
 * bound, it is a system that sheds everything; a zero timeout is not a deadline,
 * it is a chain that always fails. Both would be discovered during an incident.
 * This is discovered at the composition root, on the first line of the process.
 */
export class AlertLimitsUnusable extends AlertError {
  override readonly name = "AlertLimitsUnusable";
  override readonly degradable = false;
  constructor(
    readonly limit: string,
    readonly value: number,
    readonly detail: string,
  ) {
    super(`limit ${limit}=${value} is unusable: ${detail}`);
  }
}

/**
 * The composition root wired an alerting chain that cannot do the job.
 *
 * Thrown only by `assertProductionAlerting`, which is a deliberate, explicit
 * call at the composition root rather than a check inside `raise` — the check
 * belongs where the wiring is, and it must run before the first alert rather
 * than at the moment the first alert needs a channel that is not there.
 *
 * **Fail-closed, not degradable.** `docs/design/OPEN-ITEMS-RESOLVED.md` item 6:
 * *"An `AlertSink` that swallows everything is a legitimate test adapter and an
 * illegitimate production one."* A chain of recording sinks passes every test in
 * this repository and pages nobody, forever, silently. It is exactly the failure
 * class this whole module exists to catch, one level up, and the only place it
 * can be caught is here.
 */
export class AlertingMisconfigured extends AlertError {
  override readonly name = "AlertingMisconfigured";
  override readonly degradable = false;
  constructor(
    readonly problem:
      /** A chain containing an in-memory sink was asserted as production. */
      | "test-sink-in-production-chain"
      /** Some severity is accepted by no sink: those alerts would reach nobody. */
      | "severity-uncovered"
      /** Nothing in the chain wakes a human, so a missed heartbeat reaches nobody in time. */
      | "no-paging-sink"
      /** Two sinks share an identifier, so a degradation cannot name which failed. */
      | "duplicate-sink-id",
    readonly detail: string,
    readonly severities?: readonly AlertSeverity[],
    readonly sinks?: readonly AlertSinkId[],
  ) {
    super(`alerting chain is not fit for production (${problem}): ${detail}`);
  }
}

/**
 * A component emitted a heartbeat and nothing is watching for it.
 *
 * **Fail-closed, not degradable, and this is the most opinionated decision in
 * the module.** A beat nobody watches is worse than no beat at all: it produces
 * the *feeling* of liveness monitoring — there is a heartbeat, it is in the
 * store, it looks healthy — while the component's death remains invisible,
 * because nothing ever compares its last beat against an expected cadence. That
 * is a silent failure in the machinery whose entire job is to find silent
 * failures.
 *
 * So `watch` is a separate, explicit call, and `beat` refuses without it. The
 * cost is real: a composition root that forgets `watch` fails on the sweeper's
 * first run. That is the correct place to find out, and the alternative —
 * auto-registering on first beat — makes the expected cadence unknowable, since
 * the beat does not carry one and inferring it from the first two beats means
 * the first outage is the one that sets the baseline.
 */
export class ComponentNotWatched extends AlertError {
  override readonly name = "ComponentNotWatched";
  override readonly degradable = false;
  constructor(readonly component: ComponentId) {
    super(
      `component ${component} emitted a heartbeat but nothing is watching for it; call watch(component, expectedEveryMs) at the composition root`,
    );
  }
}

/**
 * `watch` was called twice for one component with a different expected cadence.
 *
 * **Fail-closed, not degradable.** Two callers disagreeing about how often a
 * component beats means one of them is wrong about when it is overdue, and
 * silently taking the later value would let a deploy widen a cadence — turning a
 * two-minute detection window into an hour — with nothing recorded and nobody
 * asked. Idempotent on identical terms; loud on contradictory ones.
 */
export class LivenessTermsConflict extends AlertError {
  override readonly name = "LivenessTermsConflict";
  override readonly degradable = false;
  constructor(
    readonly component: ComponentId,
    readonly watching: number,
    readonly offered: number,
  ) {
    super(
      `component ${component} is watched at ${watching}ms; this composition root offers ${offered}ms`,
    );
  }
}

/**
 * The liveness store could not answer.
 *
 * **Fail-closed on both verbs, and the reason differs on each — which is the
 * whole point of naming it.**
 *
 * On `watch` and `beat` the write is refused and the caller learns its beat was
 * not recorded. That is the ordinary direction: a component that cannot record
 * a beat is a component whose next check will read as overdue, which is an
 * alert about a real fault rather than a fabricated all-clear.
 *
 * On `snapshot` the read is refused **rather than returning an empty list**, and
 * that is the decision worth stating. An empty snapshot is indistinguishable
 * from "nothing is watched": `livenessFindings([], now, tolerance)` returns no
 * findings, a watcher reads no findings as all-clear, and the failure of the
 * store becomes silence that looks like health. That is precisely the shape of
 * failure this module exists to find, arriving through the module itself. So a
 * failed read rejects, the external watcher sees the query stop answering, and
 * `external-watchdog.ts` requirement 3 — *alert if the query itself stops
 * answering* — is what catches it. No answer is the loudest answer there is.
 *
 * Not degradable. There is no partial answer a caller could safely act on: half
 * a snapshot read as a whole one is a component silently unmonitored.
 */
export class LivenessStoreUnavailable extends AlertError {
  override readonly name = "LivenessStoreUnavailable";
  override readonly degradable = false;
  constructor(
    readonly reason:
      /** The store adapter itself failed — connection, timeout, driver fault. */
      | "store-failure"
      /** The bounded write queue is full. Shed rather than grow without limit. */
      | "backpressure"
      /** More watched components exist than one snapshot may return. */
      | "capacity",
    readonly detail: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`liveness store unavailable (${reason}): ${detail}`, options);
  }
}

/**
 * A stored liveness row does not decode to a `LivenessRecord`.
 *
 * A `bigint` column that came back as `NaN`, a beat count that is not a safe
 * integer, a `did-work` run with no item count beside it, a run kind outside the
 * union. Every one of these is either a schema that has drifted from this
 * adapter or a row edited by hand.
 *
 * **Fail-closed, not degradable, and deliberately not "skip the bad row".**
 * Dropping an undecodable row from a snapshot removes a *watched component*
 * from the watcher's view, which is the one outcome worse than an error: the
 * component stops being monitored and nothing says so. Coercing it is worse
 * again — a fabricated `lastSeen` reads as a live component. So the read fails
 * whole, loudly, naming the component and the column.
 */
export class LivenessRecordCorrupt extends AlertError {
  override readonly name = "LivenessRecordCorrupt";
  override readonly degradable = false;
  constructor(
    readonly component: string,
    readonly column: string,
    readonly detail: string,
  ) {
    super(`liveness row for ${component} is not decodable at column ${column}: ${detail}`);
  }
}

/**
 * A beat offered a value that cannot be recorded byte-stably: a fractional
 * instant, an unsafe integer, a `NaN`, an infinity, a negative item count.
 *
 * **Fail-closed, not degradable.** This is `AlertPayloadInvalid`'s reasoning
 * applied to the one write in this module that is not a payload. A liveness
 * record is compared against an injected clock to decide whether a component is
 * dead; a fractional or unsafe instant makes that comparison meaningless, and
 * rounding one silently is how a two-minute detection window quietly becomes
 * something else. Every store adapter owes this check — see
 * `livenessStoreContract` obligation 6 — so that an application cannot discover
 * the difference by swapping adapters.
 */
export class LivenessBeatUnrecordable extends AlertError {
  override readonly name = "LivenessBeatUnrecordable";
  override readonly degradable = false;
  constructor(
    readonly component: string,
    readonly field: string,
    readonly detail: string,
  ) {
    super(`beat for ${component} is not recordable at ${field}: ${detail}`);
  }
}

/**
 * The journal was handed an entry it cannot record as a node without losing or
 * overwriting evidence.
 *
 * Raised by `auditBackedAlertJournal` when a condition's payload already owns a
 * field name the journal must add — `alerted`, `alertBy`, `alertSeverity` — so
 * that merging the two would silently replace one with the other.
 *
 * **Fail-closed, not degradable, and it never loses the alert.** `createAlerts`
 * walks the sink chain *before* it journals and catches every rejection out of
 * `record`, so this surfaces as `journalled: false, why: "journal-failed"` on an
 * outcome that still says `delivered`. The alert reached a human; the node did
 * not get written; both facts are visible. Silently overwriting a payload field
 * would give an auditor in 2033 a node that says something the condition never
 * said.
 */
export class AlertJournalEntryUnrecordable extends AlertError {
  override readonly name = "AlertJournalEntryUnrecordable";
  override readonly degradable = false;
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`alert journal entry cannot be recorded as a node at ${field}: ${detail}`);
  }
}
