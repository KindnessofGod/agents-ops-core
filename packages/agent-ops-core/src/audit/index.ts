/**
 * audit — the append-only decision trace, replayable by correlation identifier.
 *
 * This is the foundation module: the other three record into it and none of
 * them are meaningful without it. It is built first for that reason.
 *
 * The interface is three verbs — `open`, `record`, `replay` — plus `close`.
 * Everything else a caller must know is an invariant:
 *
 *   Append-only.      There is no `update`, no `delete` and no `amend`, here or
 *                     in the database grants. Re-judging a case appends a new
 *                     node; it never edits an old one.
 *   Store-assigned.   Sequence numbers come from the store, never the caller.
 *                     A caller-assigned sequence is a caller-assigned lie under
 *                     concurrency. Both adapters assign it inside the same
 *                     critical section that writes, and `createAudit` checks
 *                     every acknowledgement against what it asked for.
 *   A graph.          Every node may name a parent — a node of the **same**
 *                     case — so a case's execution is a directed acyclic graph
 *                     and not a list. Replay reproduces the graph.
 *   Byte-stable.      One logical node canonicalises to identical bytes on every
 *                     host and every version, under a named envelope version.
 *                     Integers only in payloads — no IEEE-754 anywhere.
 *   Self-witnessing.  Closing seals, and **replay reads the seal**: the digest
 *                     of everything before it, the count of what it sealed, the
 *                     case's scope statement, and the requirement that the seal
 *                     is last with sequences running 0..n-1.
 *   Tiered failure.   `TraceUnavailable` has a required fail policy with no
 *                     default, and high tier cannot be configured to proceed.
 *                     It is also the only degradable error mode in the module.
 *   Redacted first.   Redaction runs before write. No store adapter ever sees an
 *                     unredacted payload, because there is no un-writing.
 *   Alerting.         `trace-unavailable-at-high-tier` — the seventh silent
 *                     condition — is raised through the injected `alerting`
 *                     when a high-tier write is refused. Fail-closed is correct
 *                     here and is not in question; it is still an incident,
 *                     because correct behaviour that stops a £2M disbursement is
 *                     an outage with a clean conscience, and the only outward
 *                     sign is an error a retry loop will reasonably catch. The
 *                     record travels on `TraceUnavailable.alerting`, because the
 *                     one place this library normally records an alert — a node
 *                     on the case's trace — is the thing that just failed.
 *   Injected clock.   No `Date.now()` inside this module, ever. That is what
 *                     makes ageing testable without waiting.
 *   Terminal close.   Recording after `close` is an error, not a no-op, and the
 *                     terminal kind is reserved to the library.
 *   Bounded.          Nodes per case, bytes per payload, writes in flight, and
 *                     — for the in-memory adapter — cases retained.
 *
 * ## How a payload stays readable for seven years
 *
 * Two versions, owned by two different people, and keeping them apart is the
 * whole mechanism:
 *
 *   - **The envelope version** (`ENVELOPE_VERSION`) is owned by this library and
 *     names the canonicalisation rules. Changing a rule means a new version;
 *     nodes written under the old one keep their old bytes forever. It is
 *     written into every node's canonical form and onto the case.
 *   - **The payload version** (`payload.v`) is owned by the caller and names the
 *     field set. It is required, not defaulted, because a default lets two
 *     incompatible shapes both be written as version 1 by somebody who changed
 *     the fields and forgot — the exact quiet failure the version exists to
 *     prevent. It is copied to `payloadSchemaVersion` on the node and to its own
 *     column in Postgres, so a reader can select by version without parsing.
 *
 * A reader in 2033 therefore needs three things, all of which are in the row:
 * the envelope version, the payload version, and the bytes. There is no lookup
 * against a registry that may not exist by then.
 *
 * **And the code now does this rather than describing it.** Canonicalisers are
 * registered per envelope version and old ones are kept; replay reads the
 * version out of each node's own bytes and recomputes under *that* one. The
 * Postgres adapter reconstructs each node from `node_canonical` and proves the
 * indexed columns agree, rather than the reverse. Digests dispatch the same way,
 * so a digest witnessed by a third party stays reproducible after a bump. A
 * version this release does not implement raises `UnknownEnvelope` — never
 * `TraceTampered`, because "I dropped that canonicaliser" and "somebody edited
 * this row" are different sentences to say to an auditor.
 *
 * ## The limits of the guarantee, stated rather than implied
 *
 * Every node this library mediates is captured, and skipping it is not
 * expressible at this interface. Three qualifications, all of them real:
 *
 *   1. **Unrepresentable *through `audit`*, not unrepresentable.** Application
 *      code holding its own closure can call a payments provider directly and
 *      move money with no node of any kind, and no type in this package can
 *      reach outside this package. That scope is stamped onto every case as
 *      `provenance.capturedVia: "injected-trace-store-only"` so a reader in 2033
 *      learns the limit of the evidence from the evidence.
 *   2. **Acknowledgement is not proof of a write.** `TraceStore` is branded with
 *      a symbol this module does not export, so a structural impostor does not
 *      typecheck, and `createAudit` checks every acknowledgement — the
 *      store-assigned sequence, the canonical bytes, the payload, the parent,
 *      the tier, the clock reading — raising `StoreContractViolated` on any
 *      disagreement. What neither can prove is that bytes reached a disk. A
 *      store that forms the node correctly and discards it is indistinguishable
 *      from one that writes it, until you replay. **Replay is the proof of a
 *      write.**
 *   3. **Tamper detection has a ceiling, and the witness is where it now
 *      stops.** An edited row is caught by `TraceTampered`; a removed row, a row
 *      inserted after the seal, a duplicated sequence and a rewritten scope
 *      statement are caught by `TraceIncoherent`. An adversary who rewrites the
 *      whole case and recomputes the seal is caught by none of them, because
 *      every one of those checks is computed from the rows and that adversary
 *      controls the rows.
 *
 *      So the whole-case digest is published at `close` to an injected
 *      `Witness`, and `verifyAgainstWitness` checks a replayed case against what
 *      was published rather than only against itself. The ceiling moves; it does
 *      not disappear. `lib/witness.ts` sets out exactly what that defeats — a
 *      consistent rewrite, a case restored from an edited backup, retro-dating —
 *      and exactly what it does not: an adversary holding both sets of
 *      credentials, a compromise of the host both tables sit on, tampering that
 *      happened before the seal, and anything at all in the in-memory adapter,
 *      which shares a process with the thing it witnesses. Crossing a real trust
 *      boundary needs a witness under separate custody. That is a third adapter
 *      behind the same interface, it is named there, and it is not shipped —
 *      because shipping it means choosing a custodian for nineteen applications.
 *
 * ## Reading a case that will not fit
 *
 * `replay` materialises the whole case, and for the tens of nodes a case
 * normally holds that is the right answer and stays the default. It is the wrong
 * answer at the ceiling: `maxNodesPerCase` is 100,000. So `TraceStore` also
 * carries `readPage` — bounded, ordered, cursored on the store-assigned sequence
 * — and `Audit.walk` streams a case a page at a time, holding one page and a
 * fixed-size verifier however long the case is.
 *
 * Both read paths make **the same checks, on the same code**: every invariant is
 * expressed once, incrementally, in `lib/stream.ts`, and `replay` and `walk`
 * both drive it. This module's own history is the argument — two paths claiming
 * one guarantee and holding different ones is the defect it has spent its
 * releases removing.
 *
 * A walk that stops early gets no verdict, deliberately. A partial walk cannot
 * verify a seal it never reached, and a verdict that quietly meant "nothing was
 * wrong with the part I looked at" is exactly the reassuring silence this module
 * exists to refuse.
 *
 * ## Seven-year expiry, and why it is not a function here
 *
 * Nothing in this library deletes a trace, and the trace tables grant no role it
 * creates the ability to. That is the guarantee, so retention cannot be a
 * library call: a `expire(correlationId)` verb needs a DELETE grant on the
 * writer role, and nineteen applications would then hold, all day and every day,
 * the one permission the whole design exists to withhold.
 *
 * The library therefore prepares a removal it cannot perform. `RetentionRegister`
 * lists sealed cases past retention; `Archivist.clearForRemoval` re-reads the
 * live case in full, recomputes its digest, and clears it only if the archive
 * copy **and** the external witness both agree — checked on the day of the
 * removal, not the day of the export. Every verb on both is a read, and
 * `lib/invariants.ts` fails the build if one that removes is ever added. The
 * removal itself is a documented procedure run by a separately-authorised role
 * against a runbook a person signs. See `lib/retention.ts`.
 *
 * ## What is not here
 *
 * **Idempotent append.** `record` is not idempotent: a retry after a crash
 * writes a second node rather than returning the first. C2's at-most-once
 * requirement is about *effects*, which `approval` owns; two appends genuinely
 * happened and the trace is evidence of what happened. Making it idempotent
 * needs an `idempotency_key` column and a partial unique index that
 * `migrations/0002_audit_trace.sql` does not have, and adding it to one adapter
 * only would recreate the exact defect this release spent its time removing —
 * two adapters that do not hold the same invariants.
 *
 * ## Seam accounting, honestly
 *
 * C5: one adapter is a hypothetical seam, two is a real one. Counted straight,
 * including where the count is thin:
 *
 *   - **`TraceStore` — a real seam.** Two shipped adapters, `inMemoryTraceStore`
 *     and `postgresTraceStore`, and they now hold the same six invariants; the
 *     tests exercise both through this interface for the parent rule, the
 *     reserved-kind rule and the seal.
 *   - **`Redactor` — a real seam, and thinner than it looks.** Two shipped
 *     adapters with genuinely different bodies and genuinely different
 *     positions: `redactAllExcept` denies key *and* value by default,
 *     `redactFields` denies values from a list the caller owns. A previous
 *     release shipped the same twelve-line body twice with a boolean flipped,
 *     which was one adapter wearing two names.
 *   - **`Clock` — one shipped adapter, and that is stated rather than counted.**
 *     `systemClock` is the only one; the test clock lives in `tests/` and is not
 *     a deliverable. This seam is justified by C2's "clock injected, no
 *     `Date.now()` inside a module", not by C5, and it would fail C5 on its own.
 *   - **`Witness` — a real seam, and the thinnest honest one here.** Two shipped
 *     adapters, `inMemoryWitness` and `postgresWitness`, with genuinely
 *     different bodies and genuinely different worth: the second raises the bar
 *     to two roles and two grants, the first raises it not at all and says so.
 *     The adapter that would make this seam earn its keep completely — a
 *     custodian outside this organisation — is named and not shipped, so the
 *     count is two real ones and one refusal rather than three.
 *   - **`RetentionRegister` — a real seam, narrowly.** Two adapters: the
 *     in-memory trace store implements it directly, and
 *     `postgresRetentionRegister` reads the seal rows on a SELECT-only
 *     connection. The in-memory one is a deliverable — it is what lets an
 *     application test its own expiry procedure without a database — and not a
 *     mock.
 *   - **`SqlExecutor` — not a seam at all, and now checkable anyway.** It is the
 *     driver-injection point C3 forces: this package may not import `pg`, so the
 *     pool arrives as a parameter. There is one shape, no behaviour variation is
 *     wanted, and no second adapter is named because none is intended. Shipping
 *     one would mean taking a driver dependency nineteen applications inherit,
 *     which CLAUDE.md requires an ADR for and C3 forbids anyway. What it has
 *     instead of a second adapter is `sqlExecutorContract` — an executable suite
 *     with no test-framework dependency, runnable in CI against an in-memory
 *     implementation and against a live pool from an operational script. It is
 *     the answer to the honest note at the foot of `tests/postgres-store.test.ts`:
 *     the schema's guarantees still need a real database, but the fifteen lines
 *     every composition root writes no longer need to be taken on trust.
 *   - **`DIGEST_ALGORITHM` — fixed, not a seam**, and versioned instead.
 *
 * See `docs/CONTEXT.md` for the vocabulary and
 * `docs/design/OPEN-ITEMS-RESOLVED.md` for the decisions behind the shape.
 */

export type { Clock } from "./lib/clock.js";
export { systemClock } from "./lib/clock.js";

export type {
  Audit,
  AuditDeps,
  AuditLimits,
  AppendInput,
  CaseTrace,
  CorrelationId,
  Degraded,
  ExpiredCase,
  FailPolicy,
  NodeId,
  NodePayload,
  NodeTelemetry,
  PayloadField,
  Recorded,
  RecordedNode,
  RecordOptions,
  RecordResult,
  RedactionId,
  Redactor,
  ReplayedCase,
  RetentionPage,
  RetentionQuery,
  RetentionRegister,
  RiskTier,
  StoredCase,
  StoredNode,
  TraceDigest,
  TracePage,
  TracePageRequest,
  TraceProvenance,
  TraceStore,
  TraceUnavailableReason,
  TraceVerdict,
  UnassistedContainment,
  UnavailabilityPolicy,
  WalkLimits,
  Witness,
  WitnessId,
  WitnessReceipt,
  WitnessRecord,
  WitnessVerdict,
} from "./lib/types.js";

export { createAudit } from "./lib/audit.js";

/** Store adapters. Two, which is what makes `TraceStore` a real seam. */
export { inMemoryTraceStore } from "./lib/in-memory-store.js";
export type {
  InMemoryStoreLimits,
  InMemoryTraceStore,
} from "./lib/in-memory-store.js";
export { postgresTraceStore } from "./lib/postgres-store.js";
export type { PostgresStoreLimits } from "./lib/postgres-store.js";

/**
 * The driver-injection point. Still not a seam — see the accounting above — but
 * now accompanied by a contract suite, so the fifteen lines every composition
 * root writes are checkable rather than merely described.
 */
export type { SqlExecutor, SqlRow } from "./lib/sql.js";
export {
  runSqlExecutorContract,
  sqlExecutorContract,
  SqlContractViolation,
} from "./lib/contract.js";
export type {
  SqlContractCase,
  SqlContractOutcome,
  SqlContractStatements,
  SqlContractSubject,
} from "./lib/contract.js";

/**
 * Witness adapters. Two, which makes `Witness` a real seam; the third — under
 * separate custody, and the only one that crosses a trust boundary — is named
 * in `lib/witness.ts` and deliberately not shipped.
 */
export { inMemoryWitness, postgresWitness } from "./lib/witness.js";
export type {
  InMemoryWitness,
  InMemoryWitnessLimits,
  PostgresWitnessDeps,
} from "./lib/witness.js";

/**
 * Retention. Everything the seven-year expiry procedure needs, and deliberately
 * nothing that performs it: every verb here is a read, and `lib/invariants.ts`
 * fails the build if a removing verb is ever added.
 */
export { createArchivist, postgresRetentionRegister, SEVEN_YEARS_MS } from "./lib/retention.js";
export type {
  Archivist,
  ArchivistDeps,
  ClearanceReason,
  RemovalClearance,
} from "./lib/retention.js";

/** Redactor adapters. Two, with different bodies and different positions on keys. */
export {
  redactAllExcept,
  redactFields,
  REDACTED,
  REDACTED_KEY_PREFIX,
} from "./lib/redaction.js";

/**
 * Byte-stable serialisation, exposed so a caller — or an independent auditor
 * with nothing but the rows — can recompute what this module computed, under
 * the version the rows name rather than under whatever is current.
 */
export {
  ENVELOPE_VERSION,
  KNOWN_ENVELOPES,
  TRACE_DIGEST_VERSION,
  KNOWN_DIGEST_VERSIONS,
  DIGEST_ALGORITHM,
  canonicalNodeForm,
  canonicalPayloadForm,
  decodeNode,
  digestGenesis,
  digestVersionOf,
  envelopeOf,
  extendDigest,
  traceDigest,
} from "./lib/canonical.js";

/**
 * The reserved terminal kind and its prefix. Exported so a caller can recognise
 * a seal, not so it can write one — `record` refuses any `case.`-prefixed kind,
 * and so does every adapter.
 */
export { SEAL_KIND, RESERVED_KIND_PREFIX, isReservedKind } from "./lib/seal.js";

/**
 * Named error modes. Exactly one of them is degradable — `TraceUnavailable` —
 * and `AuditError.degradable` says which, so a new mode is fail-closed unless
 * its author decides otherwise.
 */
export {
  AuditError,
  NoSuchCase,
  CaseAlreadyClosed,
  CaseNotClosed,
  ParentNotOfThisCase,
  PayloadTooLarge,
  ProvenanceConflict,
  ReservedNodeKind,
  StoreContractViolated,
  TraceCorrupt,
  TraceIncoherent,
  TraceTampered,
  TraceUnavailable,
  UnknownEnvelope,
  UnserialisablePayload,
  RedactionUnsound,
  WitnessConflict,
  WitnessContractViolated,
  WitnessUnavailable,
} from "./lib/errors.js";

export type {
  TraceIncoherenceReason,
  WitnessUnavailableReason,
} from "./lib/errors.js";
