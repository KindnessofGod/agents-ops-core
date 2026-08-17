import type { TraceUnavailableReason } from "./types.js";

/**
 * Named error modes. Every one states its fail policy and the reason for it,
 * because a reader who learns one module's policy will assume the others match
 * and they deliberately do not.
 *
 * ## Degradability is a property of the error, not of a list somewhere else
 *
 * Exactly one error mode in this module is degradable: `TraceUnavailable`, and
 * only below high tier, and only where the application configured it. Every
 * other error here carries `degradable = false` on the class itself.
 *
 * That inversion is deliberate and it is a fix for a real defect. The previous
 * shape was an allow-list of "never degradable" errors, so anything the list
 * had not thought of — a foreign-key violation, a check-constraint violation, a
 * corrupt column — was funnelled into "the store was unavailable" and then
 * silently dropped at low tier. A programming error and an outage were reported
 * to the caller as the same fact. Here, a new error mode is non-degradable
 * unless its author says otherwise in the class, which is the safe default.
 */

/**
 * The family. Callers that want one `catch` for everything this module raises
 * catch this; callers that want to distinguish an outage from a defect read
 * `degradable`.
 */
export abstract class AuditError extends Error {
  /**
   * True only where "the write did not happen and the caller may lawfully
   * continue" is a coherent reading. See `UnavailabilityPolicy`.
   */
  abstract readonly degradable: boolean;
}

/**
 * Replay was asked for a correlation identifier the store has never seen.
 *
 * Fail-closed: this throws rather than returning an empty case. An empty trace
 * and a missing trace mean very different things to an auditor, and a silent
 * empty result would let "we have no record" masquerade as "nothing happened".
 */
export class NoSuchCase extends AuditError {
  override readonly name = "NoSuchCase";
  override readonly degradable = false;
  constructor(readonly correlationId: string) {
    super(`no such case: ${correlationId}`);
  }
}

/**
 * A node was recorded against a closed case, or a case was closed twice.
 *
 * Fail-closed at every tier, and never degradable: this is not the store being
 * unavailable, it is the caller writing after the outcome that was supposed to
 * summarise the case. Accepting the node would make the ordering of the trace a
 * lie, which is worse than losing the node.
 */
export class CaseAlreadyClosed extends AuditError {
  override readonly name = "CaseAlreadyClosed";
  override readonly degradable = false;
  constructor(readonly correlationId: string) {
    super(`case is already closed: ${correlationId}`);
  }
}

/**
 * The store could not accept a write.
 *
 * Fail policy is **tiered and required configuration** — see
 * `UnavailabilityPolicy`. At high tier the policy type admits only
 * `fail-closed`, so an unrecordable high-tier decision cannot proceed: no
 * trace, no effect. At medium and low the application chooses, because the
 * cost of stalling a ticket-routing decision and the cost of stalling a
 * disbursement are not the same cost and the library will not pretend they are.
 *
 * This is the **only** degradable error mode in the module.
 */
export class TraceUnavailable extends AuditError {
  override readonly name = "TraceUnavailable";
  override readonly degradable = true;
  constructor(
    readonly reason: TraceUnavailableReason,
    readonly correlationId: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      `trace store unavailable (${reason}) for case ${correlationId}`,
      options as ErrorOptions,
    );
  }
}

/**
 * A payload cannot be canonicalised byte-stably — a float, an unsafe integer,
 * an array, a nested object, a symbol, a function.
 *
 * Fail-closed at **every** tier, including low, and deliberately not degradable.
 * This is a defect at the call site, not an outage. Degrading would convert a
 * loud programming error into a silently missing node, and a node that cannot
 * be replayed byte-for-byte is not evidence of anything.
 */
export class UnserialisablePayload extends AuditError {
  override readonly name = "UnserialisablePayload";
  override readonly degradable = false;
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`payload field ${path} is not byte-stably serialisable: ${detail}`);
  }
}

/**
 * One payload exceeds the configured byte ceiling for canonical bytes.
 *
 * Fail-closed at every tier, not degradable. `maxNodesPerCase` bounds the
 * *count* of nodes; without this the real bound on a case would be that count
 * multiplied by an unbounded payload, which is not a bound. A 20MB string field
 * is a call-site defect — the trace records what happened, not the documents it
 * happened to.
 */
export class PayloadTooLarge extends AuditError {
  override readonly name = "PayloadTooLarge";
  override readonly degradable = false;
  constructor(
    readonly correlationId: string,
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(
      `payload for case ${correlationId} canonicalises to ${bytes} bytes, over the ${limit}-byte ceiling`,
    );
  }
}

/**
 * A node named a parent belonging to a different case.
 *
 * Fail-closed at every tier, not degradable. This is the defect that used to
 * brick a seven-year record: the Postgres adapter kept only the sequence half
 * of the identifier, so a parent from case A rebound to whichever node of case
 * B held that sequence, and replay then recomputed different bytes and reported
 * the archive as tampered — permanently, on a table with no UPDATE grant. The
 * in-memory adapter accepted the same call and orphaned the node instead. One
 * caller typo, two different disasters. The edge is now checked before either
 * adapter sees it, and by both adapters as well.
 */
export class ParentNotOfThisCase extends AuditError {
  override readonly name = "ParentNotOfThisCase";
  override readonly degradable = false;
  constructor(
    readonly correlationId: string,
    readonly parent: string,
  ) {
    super(`parent ${parent} does not belong to case ${correlationId}`);
  }
}

/**
 * A caller tried to write a node under a kind reserved to this library.
 *
 * Fail-closed at every tier, not degradable. `case.closed` is the terminal seal
 * kind. Left unreserved it let an application forge `unassistedContainment:
 * true` at low tier using the library's own terminal node — the exact number
 * `docs/CONTEXT.md` rule 6 says must alert as an incident — and, in Postgres,
 * bricked the case at its first node.
 */
export class ReservedNodeKind extends AuditError {
  override readonly name = "ReservedNodeKind";
  override readonly degradable = false;
  constructor(
    readonly correlationId: string,
    readonly kind: string,
  ) {
    super(
      `node kind ${kind} is reserved to the library and cannot be written by a caller (case ${correlationId})`,
    );
  }
}

/**
 * A store adapter broke the seam contract: it acknowledged a node it did not
 * write correctly, reused a sequence, returned bytes that are not the canonical
 * form of the node it returned, or the database refused the write for an
 * integrity reason (a foreign key, a check constraint, a duplicate key).
 *
 * Fail-closed at every tier, not degradable, at high tier and at low alike. An
 * adapter that returns without writing is the fatal flaw
 * `docs/design/OPEN-ITEMS-RESOLVED.md` item 1 exists to close; reporting it as
 * "the store was down" would let a £2M decision report a trace that is not
 * there. An integrity violation is likewise a defect in the writer or a drift
 * in the schema, never an outage.
 */
export class StoreContractViolated extends AuditError {
  override readonly name = "StoreContractViolated";
  override readonly degradable = false;
  constructor(
    readonly correlationId: string,
    readonly detail: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      `trace store broke its contract for case ${correlationId}: ${detail}`,
      options as ErrorOptions,
    );
  }
}

/**
 * A stored row cannot be read back as a node at all — a column of the wrong
 * type, canonical bytes that are not parseable.
 *
 * Fail-closed, not degradable. This is corruption or schema drift, and it is
 * deliberately a different name from `TraceTampered`: telling an auditor
 * "tampering" when the truth is "the `at_ms` column contains text" is a false
 * accusation, and telling them "the store was down" is a false exoneration.
 */
export class TraceCorrupt extends AuditError {
  override readonly name = "TraceCorrupt";
  override readonly degradable = false;
  constructor(
    readonly correlationId: string,
    readonly detail: string,
  ) {
    super(`stored trace for case ${correlationId} cannot be read: ${detail}`);
  }
}

/**
 * Bytes were produced under an envelope version — or a digest under a digest
 * construction — this release does not implement.
 *
 * Fail-closed, not degradable, and deliberately **not** `TraceTampered`. A node
 * written in 2026 and read by a 2033 binary that dropped the old canonicaliser
 * is an operational problem with a known fix — restore the canonicaliser — and
 * calling it tampering would send an auditor after a person instead of after a
 * release. The version is in the bytes, so this error can name it.
 */
export class UnknownEnvelope extends AuditError {
  override readonly name = "UnknownEnvelope";
  override readonly degradable = false;
  constructor(
    readonly envelope: string,
    readonly correlationId: string,
  ) {
    super(
      `case ${correlationId} names version ${envelope}, which this release does not implement`,
    );
  }
}

/**
 * A redactor returned something that is not a usable payload — it dropped
 * `kind`, dropped `v`, changed the schema version, or collided two fields into
 * one key.
 *
 * Fail-closed at every tier. A redactor that removes the discriminant produces
 * nodes nobody can interpret in 2033, and the correct response to an unsound
 * redactor is to stop writing, not to write something unreadable.
 */
export class RedactionUnsound extends AuditError {
  override readonly name = "RedactionUnsound";
  override readonly degradable = false;
  constructor(
    readonly redaction: string,
    readonly detail: string,
  ) {
    super(`redactor ${redaction} produced an unusable payload: ${detail}`);
  }
}

/**
 * A case was reopened under a scope statement that contradicts the one already
 * recorded against it — a different redactor, or a different capture claim.
 *
 * Fail-closed, not degradable. `TraceProvenance.redaction` says which redactor
 * ran on this case. A deploy that changes the redactor and then appends to a
 * case opened under the old one makes that sentence false about half the nodes,
 * and there is no un-writing. The operational consequence is deliberate and
 * stated in `docs`: changing a redactor strands cases already in flight, and
 * they must be closed under the redactor they were opened with.
 *
 * `canonicalForm` is explicitly **not** part of this check. Nodes carry their
 * own envelope in their own bytes, so appending v2 nodes to a case opened under
 * v1 is correct rather than contradictory.
 */
export class ProvenanceConflict extends AuditError {
  override readonly name = "ProvenanceConflict";
  override readonly degradable = false;
  constructor(
    readonly correlationId: string,
    readonly field: string,
    readonly recorded: string,
    readonly offered: string,
  ) {
    super(
      `case ${correlationId} was opened with ${field}=${recorded}; this composition root offers ${offered}`,
    );
  }
}

/**
 * A stored node's persisted canonical bytes disagree with the bytes recomputed
 * from its own columns.
 *
 * Fail-closed: replay throws rather than returning the trace. This is the
 * signal that a row was edited in place — the one thing the append-only grants
 * exist to prevent — and handing back a trace we know disagrees with itself
 * would launder tampering into evidence.
 *
 * **The limit of this particular error, stated exactly.** It catches a row
 * edited in place, and only that. A row *removed* and a row *inserted* leave
 * every remaining row self-consistent, so they are caught by `TraceIncoherent`
 * instead — through the seal digest, the sealed node count and the requirement
 * that sequences run 0..n-1 with the seal last. Neither catches an adversary
 * who rewrites the whole case and recomputes the seal; that needs the digest to
 * have been witnessed somewhere this module cannot write.
 */
export class TraceTampered extends AuditError {
  override readonly name = "TraceTampered";
  override readonly degradable = false;
  constructor(
    readonly correlationId: string,
    readonly sequence: number,
  ) {
    super(
      `stored canonical form disagrees with recomputed form at ${correlationId} sequence ${sequence}`,
    );
  }
}

/**
 * Why a trace does not hang together as a trace. Every value is a named defect,
 * so an operator is told which shape of damage was found rather than being
 * handed a sentence to parse.
 */
export type TraceIncoherenceReason =
  /** Two rows claim the same store-assigned sequence. */
  | "duplicate-sequence"
  /** Sequences do not run 0..n-1: a row is missing. */
  | "sequence-gap"
  /** A node sits after the terminal seal. */
  | "node-after-seal"
  /** More than one seal in one case. */
  | "duplicate-seal"
  /** The seal's digest does not match the nodes it claims to seal. */
  | "seal-digest-mismatch"
  /** The seal's node count does not match the nodes before it. */
  | "seal-count-mismatch"
  /** The case's scope statement disagrees with the one the seal witnessed. */
  | "provenance-mismatch"
  /** The seal payload is missing a field the library always writes. */
  | "seal-malformed";

/**
 * The trace's rows are each self-consistent but do not form the trace they
 * claim to be.
 *
 * Fail-closed on replay, not degradable. This is the error that catches the two
 * attacks the per-row check cannot see: a removed row and a row inserted after
 * the seal — the second of which needs only the INSERT grant the writer role
 * legitimately holds, so it is the realistic one. The seal node has always
 * carried the digest of everything before it; this error is the library
 * actually reading it.
 */
export class TraceIncoherent extends AuditError {
  override readonly name = "TraceIncoherent";
  override readonly degradable = false;
  constructor(
    readonly correlationId: string,
    readonly reason: TraceIncoherenceReason,
    readonly detail: string,
  ) {
    super(`trace for case ${correlationId} is incoherent (${reason}): ${detail}`);
  }
}
