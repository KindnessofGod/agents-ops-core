import { createHash } from "node:crypto";

/**
 * Byte-stable helpers, and the integer discipline.
 *
 * Every number this module writes into the trace is a safe integer: cost in
 * tenth-cents, latency in microseconds, confidence and support in basis points.
 * There is no IEEE-754 anywhere in a payload, because byte-stable serialisation
 * is what makes replay possible and floats are how it dies quietly — a trace
 * that does not round-trip is not evidence, and nobody discovers that until the
 * year they need it.
 *
 * ## How a guardrails payload stays readable for seven years
 *
 * Every node this module writes carries `v`, the payload schema version, and a
 * `kind` drawn from a closed list documented next to `NODE` below. The rules:
 *
 *   - fields may be **added**; never removed, never retyped, never re-meaninged;
 *   - a semantic change to a node kind takes a **new kind**, not a version bump,
 *     so a 2026 trace naming a kind that no longer exists still parses in 2033
 *     rather than throwing at the decoder;
 *   - `rule`, `detector` and `searched` are open strings against the
 *     application's own registry — this module never interns them, so a reader
 *     needs no lookup table that may not exist by then;
 *   - the redacted text a node carries is bounded by `maxRecordedFieldChars`,
 *     and the digest beside it covers the whole redacted value, so truncation is
 *     visible rather than silent.
 */

/** The payload schema version for every node kind this module writes. */
export const GUARDRAILS_PAYLOAD_VERSION = 1;

/** The closed list of node kinds. A new kind is a deliberate addition. */
export const NODE = Object.freeze({
  opened: "guardrails.screening.opened",
  detector: "guardrails.detector.ran",
  settled: "guardrails.screening.settled",
  payload: "guardrails.screening.payload",
  finding: "guardrails.finding",
  groundedness: "guardrails.groundedness.scored",
  /**
   * A screening that threw. Written under the opened node before the error
   * reaches the caller, so a trace that stops has said why it stopped: a
   * screening whose last node is a detector node is indistinguishable from one
   * whose process died, and those are different incidents.
   */
  abandoned: "guardrails.screening.abandoned",
} as const);

/**
 * The fields a `redactAllExcept` allow list must hold for this module's nodes to
 * survive as evidence.
 *
 * `audit`'s deny-by-default redactor is the right choice on any node whose
 * payload comes from a model or from a document, which is every node here — and
 * applied without this list it replaces every integer on every guardrails node
 * with the **string** `"[redacted]"`. `recommend`, `outcome`, `maskedSites`,
 * `costTenthCents`, `findingCount`: the whole evidentiary content, gone, and
 * gone in a way that also breaks the integers-only discipline the payload
 * depends on.
 *
 * Wire it as `redactAllExcept([...GUARDRAILS_TRACE_FIELDS, ...yourOwn])`.
 *
 * **What is deliberately absent.** The `f.<field>` keys carrying redacted
 * payload text, and their `d.<field>` digests. They are dynamic — a caller's
 * field names — so no fixed list could hold them, and they are the one part of
 * this module's output that carries caller text. A deny-by-default redactor
 * stripping them is the redactor working, and it is the second of the two things
 * that shrink the residual risk named on `Screening.payload`.
 */
export const GUARDRAILS_TRACE_FIELDS: readonly string[] = Object.freeze([
  "kind",
  "v",
  "capturedVia",
  "category",
  "confidenceBasisPoints",
  "costClass",
  "costMeasured",
  "costTenthCents",
  "costUnmeasuredDetectors",
  "couldNotSearch",
  "coverageCovers",
  "coverageDepth",
  "coverageExaminedBasisPoints",
  "coverageExaminedCodeUnits",
  "coverageGaps",
  "coveragePartial",
  "coverageRule",
  "coverageTotalCodeUnits",
  "coverageUndeclaredDetectors",
  "coverageUnexaminedFields",
  "covers",
  "detail",
  "detector",
  "detectorCount",
  "detectorIds",
  "detectorSet",
  "detectorsRecorded",
  "detectorsRun",
  "detectorsUnavailable",
  "error",
  "examinedFieldCount",
  "examinedFields",
  "field",
  "fieldCount",
  "findingCount",
  "findings",
  "findingsTruncated",
  "groundKinds",
  "latencyMicros",
  "lengthCodeUnits",
  "locale",
  "maskedCodeUnits",
  "maskedSites",
  "modelCalls",
  "outcome",
  "overBudget",
  "payloadChars",
  "phase",
  "reason",
  "recommend",
  "recordedFieldChars",
  "rule",
  "searched",
  "searches",
  "severity",
  "sourceCount",
  "sourcesAvailable",
  "space",
  "startCodeUnit",
  "tier",
  "verbatimCodeUnitsRecorded",
  "view",
  "witnessProof",
]);

/**
 * A 256-bit digest over canonical bytes, in hex.
 *
 * SHA-256, matching `audit` and `evals`. This replaced four FNV-1a lanes after
 * a security review found three guarantees resting on a construction that could
 * support none of them:
 *
 * 1. **Privacy.** `approval` digests approver reasons and string policy facts —
 *    supplier names, account references — and claimed nobody reading the trace
 *    could learn a string not already known to them. Against a low-entropy
 *    value that was false, and remains false for *any* unkeyed digest: a holder
 *    of `SELECT` enumerates candidate telephone numbers or sort codes offline
 *    and confirms. SHA-256 does not fix that, so the claim is corrected where
 *    it is made rather than left standing next to a stronger hash. The digest
 *    identifies; it does not conceal.
 * 2. **Evidence.** These digests record that a given brief was shown and a
 *    given reason written. A construction without second-preimage resistance
 *    cannot support an auditor proving a candidate string is the one recorded.
 *    SHA-256 can.
 * 3. **The money path.** The effect idempotency key and the suspension
 *    identifier are derived from this. A collision merges two distinct effects
 *    onto one claim, and the second returns the first's outcome without ever
 *    executing — a payment silently not made. Four 32-bit lanes sharing one
 *    multiplier is not a margin worth holding that on.
 *
 * `node:crypto` is a Node built-in, not a dependency any caller can swap for a
 * stub, and SHA-256 is identical across runtimes for the seven years these
 * traces must stay readable — which were the two reasons the hand-rolled
 * version existed.
 */
export const digest = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");


/** True for a value that may be written into a node payload as a number. */
export const isRecordableInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/** True for a basis-points value: an integer in 0..10000. */
export const isBasisPoints = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
