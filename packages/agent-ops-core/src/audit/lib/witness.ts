import { extendDigest } from "./canonical.js";
import {
  AuditError,
  WitnessConflict,
  WitnessContractViolated,
  WitnessUnavailable,
} from "./errors.js";
import { SEAL_KIND } from "./seal.js";
import type { SqlExecutor, SqlRow } from "./sql.js";
import { asWitness } from "./types.js";
import type {
  CorrelationId,
  RecordedNode,
  TraceDigest,
  Witness,
  WitnessId,
  WitnessRecord,
  WitnessReceipt,
  WitnessVerdict,
} from "./types.js";

/**
 * The external witness — the module's stated blind spot, closed as far as it
 * can honestly be closed.
 *
 * ## What this is for
 *
 * `index.ts` has always said where tamper detection stops: an edited row is
 * `TraceTampered`, a removed row or one inserted after the seal is
 * `TraceIncoherent`, and **an adversary who rewrites the whole case and
 * recomputes the seal is caught by none of them**. Every check the module has
 * is computed from the rows, so an adversary who controls all the rows controls
 * every check. Nothing inside one store can fix that. The only thing that can
 * is a copy of the digest held somewhere the adversary does not control, taken
 * at a time they cannot revise.
 *
 * So: at close, the whole-case digest is published to an injected `Witness`. A
 * replayed case is then checked against what the witness holds rather than only
 * against itself.
 *
 * ## What this defeats, exactly
 *
 * - **A consistent rewrite of a whole case.** Rewriting every row and
 *   recomputing the seal produces a different whole-case digest, and the
 *   witnessed digest does not move with it. `verifyAgainstWitness` returns
 *   `digest-mismatch`, which is the sentence "the archive disagrees with what
 *   was published at the time" — an accusation an auditor can act on.
 * - **A case quietly deleted in full.** The trace tables have no DELETE grant,
 *   but a restore-from-an-edited-backup does not need one. A witness record with
 *   no case behind it is visible; a missing case with no witness record is not.
 * - **Retro-dating.** The witness table is INSERT-only with a unique key on the
 *   correlation identifier, so a second, different digest for a case already
 *   witnessed cannot be written at all — it raises `WitnessConflict` rather than
 *   overwriting. An adversary must rewrite the case *and* the witness *and* they
 *   cannot, because the witness will not take a second value.
 *
 * ## What this does **not** defeat, said plainly
 *
 * - **An adversary holding both sets of credentials.** If the same role can
 *   write the trace and the witness, this is theatre. That is why the Postgres
 *   witness takes its **own** `SqlExecutor` and why migration `0003` grants
 *   INSERT on the witness table to `agent_ops_witness` and **not** to
 *   `agent_ops_writer`. Wire the trace pool in here and the database itself
 *   refuses the insert on the first close — loudly, rather than silently
 *   producing a worthless witness.
 * - **A compromise of the database host.** Both tables in one cluster is one
 *   trust domain with two roles in it. That is a real increase in difficulty and
 *   it is not a trust boundary. Crossing one needs a witness under different
 *   custody: another organisation's append-only log, a timestamping authority,
 *   a customer-held copy. That is a **third adapter behind this same interface**
 *   and it is the one that actually finishes the job. It is named here and not
 *   shipped, because shipping it means choosing a vendor for nineteen
 *   applications.
 * - **Tampering before the close.** The witness attests to the digest of the
 *   case as it stood at close. A trace that was already wrong when it was sealed
 *   is witnessed as wrong, faithfully and forever.
 * - **Time.** `at` comes from this library's injected clock, so it is *our*
 *   claim about when we published, not a notary's. A witness that issues its own
 *   trusted timestamp is exactly the third adapter above.
 * - **Anything at all, in the in-memory adapter.** It lives in the same process
 *   as the thing it witnesses. It is a deliverable — it is what makes an
 *   application's own witness wiring testable hermetically — and it defeats no
 *   adversary whatsoever. Both facts are true at once and neither is hidden.
 *
 * ## The unavoidable window
 *
 * A digest cannot be published before it exists, and it does not exist until the
 * seal is written. So publication is necessarily *after* the seal commits, and a
 * process that dies in between leaves a sealed, unwitnessed case. That is
 * handled rather than pretended away: `publish` is idempotent, `Audit.witness`
 * re-publishes on demand, and `RUNBOOK` sweeps sealed-and-unwitnessed cases.
 * `verifyAgainstWitness` reports `not-witnessed` as its own verdict and never as
 * a mismatch, because "nobody published this" and "this disagrees with what was
 * published" are different sentences to say to an auditor.
 */

/**
 * The whole-case digest of a sealed case, computed from the seal alone.
 *
 * The seal carries `sealDigest` — the digest of everything before it — so the
 * digest of the whole case is that chain extended by one link. No re-read, no
 * second pass over 100,000 nodes under the close lock, and the result is byte
 * for byte what `replay(...).digest()` produces.
 *
 * Returns `undefined` for a node that is not a seal, or a seal whose payload
 * does not carry a readable digest: publishing a number we could not derive
 * would be worse than not publishing.
 */
export const closedCaseDigest = (
  seal: RecordedNode,
): { readonly digest: TraceDigest; readonly nodes: number } | undefined => {
  if (seal.payload.kind !== SEAL_KIND) return undefined;
  const sealed = seal.payload["sealDigest"];
  const count = seal.payload["nodesSealed"];
  if (typeof sealed !== "string" || typeof count !== "number") return undefined;
  return {
    digest: extendDigest(sealed as TraceDigest, seal),
    nodes: count + 1,
  };
};

/** Compare a recomputed digest with what a witness holds. */
export const witnessVerdict = (
  digest: TraceDigest,
  witnessed: WitnessRecord | undefined,
): WitnessVerdict => {
  if (witnessed === undefined) {
    return { agrees: false, reason: "not-witnessed", digest };
  }
  if (String(witnessed.digest) !== String(digest)) {
    return { agrees: false, reason: "digest-mismatch", digest, witnessed };
  }
  return { agrees: true, digest, witnessed };
};

/**
 * Check a receipt against what we asked to be published, on exactly the
 * reasoning `verifyAcknowledgement` applies to a store: the brand stops an
 * object literal being a witness at all, and this stops a *branded* witness — a
 * decorator, or an `as unknown as` cast — from acknowledging something it did
 * not record. What neither proves is that anything reached a disk. `lookUp` is
 * the proof of a publication, exactly as replay is the proof of a write.
 */
export const verifyReceipt = (asked: WitnessRecord, receipt: WitnessReceipt): void => {
  const held = receipt.record;
  const wrong = (detail: string): never => {
    throw new WitnessContractViolated(String(asked.correlationId), detail);
  };
  if (held.correlationId !== asked.correlationId) {
    wrong(`receipted a record for case ${String(held.correlationId)}`);
  }
  if (String(held.digest) !== String(asked.digest)) {
    wrong("receipted a digest other than the one published");
  }
  if (held.nodes !== asked.nodes) {
    wrong("receipted a different node count from the one published");
  }
};

// ---------------------------------------------------------------------------
// Adapter 1 — in memory
// ---------------------------------------------------------------------------

export interface InMemoryWitnessLimits {
  /**
   * Ceiling on records retained. Reached, `publish` refuses with
   * `WitnessUnavailable("capacity")` rather than evicting — an evicted witness
   * record is the one piece of evidence whose absence cannot be distinguished
   * from never having existed.
   */
  readonly maxRecords: number;
}

export interface InMemoryWitness extends Witness {
  readonly size: number;
}

const DEFAULT_IN_MEMORY_LIMITS: InMemoryWitnessLimits = { maxRecords: 100_000 };

/**
 * In-process witness.
 *
 * A deliverable, not a mock — it is what lets an application test its own
 * witness wiring, its recovery sweep and its verification step without a
 * database and without a network. It is also **worthless as a witness**: it
 * shares a process, a heap and a lifetime with the thing it witnesses, so an
 * adversary who can rewrite the trace can rewrite this. Read the header.
 */
export const inMemoryWitness = (
  limits: Partial<InMemoryWitnessLimits> = {},
): InMemoryWitness => {
  const { maxRecords } = { ...DEFAULT_IN_MEMORY_LIMITS, ...limits };
  const records = new Map<CorrelationId, WitnessRecord>();
  const id = "aoc.audit.witness.in-memory.v1" as WitnessId;

  const witness = asWitness({
    id,
    async publish(record: WitnessRecord): Promise<WitnessReceipt> {
      const held = records.get(record.correlationId);
      if (held !== undefined) {
        if (String(held.digest) !== String(record.digest)) {
          throw new WitnessConflict(
            String(record.correlationId),
            String(held.digest),
            String(record.digest),
          );
        }
        return { record: held };
      }
      if (records.size >= maxRecords) {
        throw new WitnessUnavailable("capacity", String(record.correlationId));
      }
      const stored: WitnessRecord = { ...record, witness: id };
      records.set(record.correlationId, stored);
      return { record: stored };
    },
    async lookUp(correlationId: CorrelationId) {
      return records.get(correlationId);
    },
  });

  return {
    ...witness,
    get size() {
      return records.size;
    },
  };
};

// ---------------------------------------------------------------------------
// Adapter 2 — a separate append-only table, under its own grants
// ---------------------------------------------------------------------------

const WITNESS = "agent_ops.audit_witness";

const SQL = {
  publish: `-- audit:witness-publish
INSERT INTO ${WITNESS}
  (correlation_id, digest, nodes_witnessed, witnessed_at_ms, witness_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (correlation_id) DO NOTHING`,

  read: `-- audit:witness-read
SELECT correlation_id, digest, nodes_witnessed, witnessed_at_ms, witness_id
FROM ${WITNESS}
WHERE correlation_id = $1`,
} as const;

const rowToRecord = (row: SqlRow, correlationId: CorrelationId): WitnessRecord => {
  const text = (column: string): string => {
    const value = row[column];
    if (typeof value !== "string") {
      throw new WitnessContractViolated(
        String(correlationId),
        `witness column ${column} is not text`,
      );
    }
    return value;
  };
  const integer = (column: string): number => {
    const raw = row[column];
    const parsed = typeof raw === "string" ? Number(raw) : raw;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
      throw new WitnessContractViolated(
        String(correlationId),
        `witness column ${column} is not a safe integer`,
      );
    }
    return parsed;
  };
  return {
    correlationId: text("correlation_id") as CorrelationId,
    digest: text("digest") as TraceDigest,
    nodes: integer("nodes_witnessed"),
    at: integer("witnessed_at_ms"),
    witness: text("witness_id") as WitnessId,
  };
};

export interface PostgresWitnessDeps {
  /**
   * **Its own executor, connected as its own role.** Passing the trace store's
   * pool here defeats the entire point — and the grants in migration `0003` say
   * so in the only language that binds: `agent_ops_writer` has no INSERT on the
   * witness table, so a composition root that wires the wrong pool fails on the
   * first close instead of producing a witness nobody should believe.
   */
  readonly sql: SqlExecutor;
  /**
   * Names this witness in every row it writes. Required, and it should name the
   * custodian rather than the software — "finance-archive-eu-west", not
   * "postgres" — because in 2033 the question is who held it, not what ran it.
   */
  readonly id: WitnessId;
}

/**
 * Postgres witness: a separate append-only table, with its own role, its own
 * grants and its own connection.
 *
 * Publication is insert-then-read-back rather than read-then-insert, because
 * read-then-insert is a race: two closes of the same case under a deploy would
 * both read nothing and both insert, and one would lose to the unique key with
 * no idea why. `ON CONFLICT DO NOTHING` followed by an authoritative read is
 * correct under any number of concurrent publishers, and it is what turns "the
 * row was already there" into an idempotent success rather than an error.
 */
export const postgresWitness = ({ sql, id }: PostgresWitnessDeps): Witness => {
  const named = (error: unknown, correlationId: string): never => {
    if (error instanceof AuditError) throw error;
    throw new WitnessUnavailable("witness-failure", correlationId, { cause: error });
  };

  return asWitness({
    id,
    async publish(record: WitnessRecord): Promise<WitnessReceipt> {
      const correlationId = String(record.correlationId);
      try {
        return await sql.transaction(async (tx) => {
          await tx.query(SQL.publish, [
            record.correlationId,
            record.digest,
            record.nodes,
            record.at,
            id,
          ]);
          const { rows } = await tx.query(SQL.read, [record.correlationId]);
          const row = rows[0];
          if (row === undefined) {
            // The insert did nothing and the read found nothing. Either the row
            // vanished between two statements of one transaction — impossible on
            // an INSERT-only table — or this executor is not talking to the table
            // it claims to be. Neither is an outage.
            throw new WitnessContractViolated(
              correlationId,
              "published a record the witness does not hold",
            );
          }
          const held = rowToRecord(row, record.correlationId);
          if (String(held.digest) !== String(record.digest)) {
            throw new WitnessConflict(
              correlationId,
              String(held.digest),
              String(record.digest),
            );
          }
          return { record: held };
        });
      } catch (error) {
        return named(error, correlationId);
      }
    },

    async lookUp(correlationId: CorrelationId) {
      try {
        const { rows } = await sql.query(SQL.read, [correlationId]);
        const row = rows[0];
        return row === undefined ? undefined : rowToRecord(row, correlationId);
      } catch (error) {
        return named(error, String(correlationId));
      }
    },
  });
};
