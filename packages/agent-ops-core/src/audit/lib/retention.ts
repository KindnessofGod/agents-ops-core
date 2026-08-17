import { decodeNode } from "./canonical.js";
import { AuditError, TraceCorrupt, TraceUnavailable } from "./errors.js";
import type { SqlExecutor, SqlRow } from "./sql.js";
import { closedCaseDigest, witnessVerdict } from "./witness.js";
import type {
  Audit,
  CorrelationId,
  ExpiredCase,
  RetentionPage,
  RetentionQuery,
  RetentionRegister,
  TraceDigest,
  WalkLimits,
  Witness,
  WitnessRecord,
} from "./types.js";

/**
 * Retention, archival and the seven-year expiry.
 *
 * ## The problem, stated exactly
 *
 * The trace tables hold seven years of regulated evidence. They have no DELETE
 * grant for any role this library's migrations create, no UPDATE grant, and a
 * trigger that raises on both — and that is not an oversight to be worked
 * around, it is the guarantee. `migrations/0002` says why in one line: *a grant
 * that exists is a grant that gets used.*
 *
 * But retention is finite. At some point a case that has been held for seven
 * years is removed, and something has to remove it. If that something is a
 * library function, then the library's own role needs DELETE, and the append-only
 * guarantee is now "append-only, except for the code path that deletes, which is
 * called with a correlation identifier and a date somebody computed". Every
 * application inherits that. It is a bad trade at any size and it is a
 * catastrophic one at nineteen.
 *
 * ## The resolution: the library prepares the removal and cannot perform it
 *
 * **Nothing in this file removes anything, and there is no verb here that
 * could.** `RetentionRegister` has one method and it is a read. `Archivist` has
 * two and both are reads. The compile-time assertions in `lib/invariants.ts`
 * fail the build if a verb whose name suggests removal ever appears on either.
 *
 * The removal itself is a **procedure**, not a function:
 *
 *   1. It runs as a role this library's migrations do not create and this
 *      library never connects as. `agent_ops_writer` — the role the application
 *      holds all day, every day — has SELECT and INSERT and will never have
 *      more. The expiry role's DELETE grant is issued as part of an authorised
 *      change and revoked when the run finishes, so for the overwhelming
 *      majority of the seven years there is no role on the cluster that can
 *      delete a trace row at all.
 *   2. It removes nothing that this library has not **cleared**, and clearance
 *      is what `Archivist.clearForRemoval` produces: proof that a faithful copy
 *      exists somewhere else, checked against the live rows and against the
 *      external witness, on the day of the removal rather than on the day of the
 *      export.
 *   3. It is written down in `RUNBOOK`, performed by a person, and leaves its own
 *      record.
 *
 * That division is the whole design. The library holds the evidence and the
 * judgement; the authority to destroy sits outside it, with someone who can be
 * asked why.
 *
 * ## Why clearance re-reads the live case rather than trusting the survey
 *
 * `dueForRemoval` derives its digest from each seal's own bytes — one row per
 * case, cheap enough to sweep millions. That is exactly the wrong thing to
 * destroy a case on the strength of: if an adversary rewrote the case and
 * recomputed the seal, the seal agrees with itself perfectly, and an expiry
 * procedure driven by the survey alone would then delete the original evidence
 * of the rewrite as the last step of the attack.
 *
 * So clearance streams the whole case again, runs every integrity check
 * (`lib/stream.ts`), recomputes the digest from the nodes, compares it with the
 * **archive copy's** digest, and compares it with the **witness**. Three
 * independent statements have to agree before a byte is allowed to be removed,
 * and the one that matters most is the one held outside the database.
 *
 * It also re-checks the retention date itself, from the seal's own clock
 * reading, rather than trusting that the case in front of it is the case the
 * query returned. A defect in a `WHERE` clause should not be able to destroy
 * evidence that is three years old.
 */

/**
 * Seven years in milliseconds, computed as 2,557 days: seven 365-day years plus
 * two leap days, which is the minimum number of leap days any seven-year window
 * contains. It errs towards keeping evidence **longer**, never shorter, which is
 * the only direction to err in when the alternative is destroying a record you
 * were obliged to hold.
 *
 * It is exported as a convenience and is deliberately **not** a default: the
 * retention period is a legal obligation that differs by jurisdiction and by
 * application, and a library that quietly supplies one is a library that decides
 * when nineteen applications may destroy evidence.
 */
export const SEVEN_YEARS_MS = 2_557 * 24 * 60 * 60 * 1_000;

/** Why a case is or is not cleared for removal. One reason, always stated. */
export type ClearanceReason =
  /** Everything agreed. The procedure may proceed for this case. */
  | "cleared"
  /** The case is not sealed. An unfinished case is never past retention. */
  | "not-closed"
  /** The seal's own clock reading is inside the retention period. */
  | "not-due"
  /** The live rows do not digest to what the archive copy holds. */
  | "archive-digest-mismatch"
  /** The live rows do not digest to what was published at close. **The alarm.** */
  | "witness-mismatch"
  /** Nothing was ever published for this case, so nothing corroborates the copy. */
  | "not-witnessed";

export interface RemovalClearance {
  readonly correlationId: CorrelationId;
  /** True only for `reason === "cleared"`. Spelled out so a caller cannot skim past it. */
  readonly cleared: boolean;
  readonly reason: ClearanceReason;
  /** Recomputed from the live rows, now — not read from the seal. */
  readonly digest: TraceDigest;
  /** What the caller says their archive copy digests to. */
  readonly archiveDigest: TraceDigest;
  /** Nodes the live case holds, the seal counted. */
  readonly nodes: number;
  /** The seal's clock reading, absent on an unsealed case. */
  readonly closedAt: number | undefined;
  /** What the witness holds, where it holds anything. */
  readonly witnessed?: WitnessRecord;
}

export interface ArchivistDeps {
  /**
   * Reads the live case. The same `Audit` the application uses — clearance
   * runs every check replay runs, on the same code, because a clearance that
   * used a weaker reader than the one an auditor uses would clear cases an
   * auditor would reject.
   */
  readonly audit: Audit;
  readonly register: RetentionRegister;
  /**
   * Required here, unlike on `AuditDeps`. A case may be recorded without a
   * witness — that is the application's decision — but nothing may be
   * **destroyed** on the strength of an integrity check the destroyer also
   * controls. No witness, no clearance.
   */
  readonly witness: Witness;
  /**
   * Required. No default. See `SEVEN_YEARS_MS` for why the library will not
   * choose a retention period on an application's behalf.
   */
  readonly retentionMs: number;
  /** Bounds the streaming re-read that clearance performs. */
  readonly limits?: Partial<WalkLimits>;
}

/**
 * Everything the expiry procedure needs. Nothing it uses to expire.
 *
 * Both verbs are reads. That is not a limitation of the current release; it is
 * the interface, and `lib/invariants.ts` fails the build if a removing verb is
 * ever added to it.
 */
export interface Archivist {
  /**
   * Sealed cases past retention as of `now`, a bounded page at a time.
   *
   * `now` is a parameter rather than a clock reading taken inside, so a survey
   * is reproducible: an operator can ask "what would have been due last Monday"
   * and get the answer they would have got last Monday.
   */
  due(
    now: number,
    page: {
      /**
       * Explicitly `undefined` for the first page rather than optional. Under
       * `exactOptionalPropertyTypes` an optional property cannot be handed an
       * `undefined` from a previous page's cursor without a conditional spread
       * at every call site, and a cursor that is awkward to pass is a cursor
       * somebody drops — which turns a paged sweep into a first-page-only one
       * that silently misses a retention obligation.
       */
      readonly after: CorrelationId | undefined;
      readonly limit: number;
    },
  ): Promise<RetentionPage>;
  /**
   * Decide whether one case may be removed, given the digest of the archive copy
   * that will survive it.
   *
   * Never throws on a *negative* answer — "this case is not cleared" is a
   * verdict, not an exception, because an expiry run over ten thousand cases
   * must be able to record every refusal and continue. It does still throw on a
   * broken trace: a case that is tampered, incoherent or unreadable raises, and
   * an expiry procedure that meets one should stop rather than log and carry on.
   */
  clearForRemoval(
    correlationId: CorrelationId,
    archiveDigest: TraceDigest,
    now: number,
  ): Promise<RemovalClearance>;
}

export const createArchivist = ({
  audit,
  register,
  witness,
  retentionMs,
  limits,
}: ArchivistDeps): Archivist => {
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
    // A retention period that is not a positive whole number of milliseconds is
    // a wiring defect, and the consequence of the defect is destroying evidence
    // early. It fails at the composition root rather than at 3am on a sweep.
    throw new RangeError(
      `retentionMs must be a positive safe integer; received ${String(retentionMs)}`,
    );
  }

  return {
    async due(now, page) {
      const query: RetentionQuery = {
        closedBefore: now - retentionMs,
        afterCorrelationId: page.after,
        limit: page.limit,
      };
      return register.dueForRemoval(query);
    },

    async clearForRemoval(correlationId, archiveDigest, now) {
      // Stream rather than replay: clearance must work at the node ceiling, and
      // it discards each node as it passes. Every integrity check replay makes
      // is made here, and a tampered or incoherent case throws out of this line
      // rather than returning a verdict.
      const walk = audit.walk(correlationId, limits);
      let verdict;
      for (;;) {
        const step = await walk.next();
        if (step.done) {
          verdict = step.value;
          break;
        }
      }

      const base = {
        correlationId,
        digest: verdict.digest,
        archiveDigest,
        nodes: verdict.nodes,
        closedAt: verdict.closedAt,
      };

      if (!verdict.closed || verdict.closedAt === undefined) {
        return { ...base, cleared: false, reason: "not-closed" as const };
      }
      // Re-checked from the seal's own clock reading rather than trusted from
      // the query that produced this identifier. A defect in a `WHERE` clause
      // must not be able to destroy evidence that is three years old.
      if (verdict.closedAt >= now - retentionMs) {
        return { ...base, cleared: false, reason: "not-due" as const };
      }
      if (String(verdict.digest) !== String(archiveDigest)) {
        return { ...base, cleared: false, reason: "archive-digest-mismatch" as const };
      }

      const held = await witness.lookUp(correlationId);
      const against = witnessVerdict(verdict.digest, held);
      if (!against.agrees) {
        return {
          ...base,
          cleared: false,
          reason:
            against.reason === "not-witnessed"
              ? ("not-witnessed" as const)
              : ("witness-mismatch" as const),
          ...(held === undefined ? {} : { witnessed: held }),
        };
      }

      return {
        ...base,
        cleared: true,
        reason: "cleared" as const,
        witnessed: against.witnessed,
      };
    },
  };
};

// ---------------------------------------------------------------------------
// The Postgres retention register
// ---------------------------------------------------------------------------

const NODE = "agent_ops.audit_trace_node";

/**
 * Two statements rather than one with an empty-string cursor.
 *
 * `correlation_id > ''` is true for every non-empty text value in every
 * collation, so one statement would work — right up until a deployment runs a
 * collation where it does not, at which point the first page of an expiry sweep
 * silently returns nothing and a retention obligation is quietly missed. Two
 * statements cost eight lines and remove the question.
 */
const SQL = {
  first: `-- audit:retention-due-first
SELECT correlation_id, at_ms, node_canonical
FROM ${NODE}
WHERE is_seal AND at_ms < $1
ORDER BY correlation_id
LIMIT $2`,

  after: `-- audit:retention-due-after
SELECT correlation_id, at_ms, node_canonical
FROM ${NODE}
WHERE is_seal AND at_ms < $1 AND correlation_id > $2
ORDER BY correlation_id
LIMIT $3`,
} as const;

const rowToExpired = (row: SqlRow): ExpiredCase => {
  const rawId = row["correlation_id"];
  if (typeof rawId !== "string") {
    throw new TraceCorrupt("(retention sweep)", "column correlation_id is not text");
  }
  const correlationId = rawId as CorrelationId;

  const canonical = row["node_canonical"];
  if (typeof canonical !== "string") {
    throw new TraceCorrupt(rawId, "column node_canonical is not text");
  }
  const rawAt = row["at_ms"];
  const at = typeof rawAt === "string" ? Number(rawAt) : rawAt;
  if (typeof at !== "number" || !Number.isSafeInteger(at)) {
    throw new TraceCorrupt(rawId, `column at_ms is not a safe integer: ${String(rawAt)}`);
  }

  // The seal is rebuilt from its own bytes and its digest derived from the
  // payload it carries — the same derivation `close` uses, so a survey and a
  // close cannot disagree about what a case digests to.
  const seal = decodeNode(canonical, correlationId);
  const closed = closedCaseDigest(seal);
  if (closed === undefined) {
    throw new TraceCorrupt(
      rawId,
      "a row marked as the seal does not carry a derivable whole-case digest",
    );
  }
  return { correlationId, closedAt: at, nodes: closed.nodes, digest: closed.digest };
};

/**
 * Reads seal rows. **SELECT only** — this adapter issues no statement that is
 * not a SELECT, and its executor should be wired to `agent_ops_reader`, which
 * has no INSERT, no UPDATE and no DELETE on anything.
 *
 * That is a third pool and a third role in one composition root, and it is worth
 * the wiring: the sweep that decides what may be destroyed should not be running
 * on a connection that could destroy it.
 */
export const postgresRetentionRegister = (sql: SqlExecutor): RetentionRegister => ({
  async dueForRemoval(query: RetentionQuery): Promise<RetentionPage> {
    const limit = Math.max(query.limit, 0);
    try {
      // `limit + 1` so `more` is a fact from the database rather than an
      // inference from a full page.
      const { rows } =
        query.afterCorrelationId === undefined
          ? await sql.query(SQL.first, [query.closedBefore, limit + 1])
          : await sql.query(SQL.after, [
              query.closedBefore,
              query.afterCorrelationId,
              limit + 1,
            ]);
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      return { cases: page.map(rowToExpired), more };
    } catch (error) {
      if (error instanceof AuditError) throw error;
      throw new TraceUnavailable("store-failure", "(retention sweep)", { cause: error });
    }
  },
});
