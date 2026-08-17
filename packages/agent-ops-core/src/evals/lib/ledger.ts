import { LedgerCorrupt, LedgerUnavailable, LimitOutOfRange, RunNotMemoisable } from "./errors.js";
import { mintRunLedger } from "./ledger-brand.js";
import type { AccuracyReport, AgreementReport } from "./report.js";
import { reopenAccuracyReport, reopenAgreementReport } from "./report.js";
import type { SqlExecutor, SqlRow } from "./sql-store.js";
import type {
  CaseMemo,
  CaseRef,
  CompletedRunRecord,
  MemoisedStatus,
  RunKey,
  RunLedger,
  SourceKind,
  StoredCaseMemo,
  StoredCompletedRun,
} from "./types.js";

/**
 * The run ledger: what makes a repeat of a run key free, and an interrupted run
 * resumable.
 *
 * See `RunLedgerMethods` in `types.ts` for the interface and its fail policy.
 * This file holds the mint that closes the partial-run trap and the two shipped
 * adapters that make the seam real.
 */

/* ------------------------------------------------------------------- minting */

/**
 * The only producer of a `CompletedRunRecord`, and therefore the only way a
 * report can ever be returned by a later run **without executing anything**.
 *
 * It refuses three shapes, and the first is the one the design review flagged:
 *
 *  1. **A partial run.** A run that spent its wall clock at case 41 of 200 has a
 *     biased sample. Memoised as complete, that sample becomes permanent and
 *     free: every later run of the key returns it, instantly, looking exactly
 *     like a finished run because it *is* the same type. `gate` already refuses
 *     a partial report — but only if a partial report is what it is handed, and
 *     a memo hands the same object back forever.
 *  2. **An unattributed run.** A run whose decisions contradicted their own
 *     purity declaration did not establish where the thinking happened.
 *  3. **A run that could not evaluate cases.** A provider outage is a fact about
 *     ten minutes on a Tuesday. Freezing it into the ledger makes it a fact
 *     about the run key forever, and the next engineer would have no way to
 *     re-ask the question.
 *
 * The refusal is a `throw` rather than a `false`, and the brand is what makes it
 * unskippable: `CompletedRunRecord` carries a non-exported `unique symbol`, so
 * `recordCompleted` cannot be handed an object a caller built.
 */
export const mintCompletedRun = (input: {
  readonly report: AccuracyReport | AgreementReport;
  readonly runKey: RunKey;
  readonly completedAt: number;
}): CompletedRunRecord => {
  const report = input.report;
  if (report.partial) {
    throw new RunNotMemoisable(
      `the run was partial (${report.partialReason ?? "unknown"}); a biased sample memoised as complete is permanent and free`,
    );
  }
  if (report.attribution === "partial") {
    throw new RunNotMemoisable(
      `${String(report.unattributedCases.length)} decision(s) contradicted the subject's purity declaration`,
    );
  }
  if (report.couldNotEvaluateBasisPoints > 0) {
    throw new RunNotMemoisable(
      `${String(report.couldNotEvaluateBasisPoints)}bp of cases could not be evaluated; a provider outage is not a property of the run key`,
    );
  }
  return {
    runKey: input.runKey,
    runId: report.runId,
    completedAt: input.completedAt,
    schema: report.schema,
    sourceKind: report.against === "golden" ? "golden" : "recorded",
    // Byte-stable enough for the purpose: this is re-entered through
    // `reopenAccuracyReport` / `reopenAgreementReport`, which recompute the
    // rates from the cases, so the bytes are checked against their own contents
    // rather than trusted.
    reportJson: JSON.stringify(report),
  } as unknown as CompletedRunRecord;
};

/**
 * Re-enter a memoised report, and refuse anything that cannot be one.
 *
 * This is the read-side backstop for the mint above. The mint makes a partial
 * report unrepresentable *going in*; a row written by an older build, or edited
 * with a psql prompt, is what this catches coming out. Both directions matter
 * because the value being guarded is "a green build with no execution".
 *
 * Fail-closed, `LedgerCorrupt`, incident — deliberately **not** the fail-open
 * `LedgerUnavailable` policy the rest of the ledger runs under. A ledger that
 * cannot answer costs money. A ledger that answers wrongly publishes a number no
 * run produced.
 */
export const reopenMemoisedReport = (
  stored: StoredCompletedRun,
): AccuracyReport | AgreementReport => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.reportJson);
  } catch (cause) {
    throw new LedgerCorrupt(stored.runKey, `report is not JSON: ${String(cause)}`);
  }
  let report: AccuracyReport | AgreementReport;
  try {
    report =
      stored.sourceKind === "golden"
        ? reopenAccuracyReport(parsed)
        : reopenAgreementReport(parsed);
  } catch (cause) {
    throw new LedgerCorrupt(
      stored.runKey,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (report.partial) {
    throw new LedgerCorrupt(
      stored.runKey,
      "the memoised report is partial; a partial run must never be memoised as complete",
    );
  }
  if (report.runId !== stored.runId) {
    throw new LedgerCorrupt(
      stored.runKey,
      `the row names run ${stored.runId} and the report names run ${report.runId}`,
    );
  }
  return report;
};

/* --------------------------------------------------------------- adapter 1 */

export interface InMemoryLedgerLimits {
  /** Ceiling on memoised run keys. A ledger that grows without bound is a leak. */
  readonly maxRunKeys: number;
  /** Ceiling on memoised cases per key. */
  readonly maxCasesPerKey: number;
}

const IN_MEMORY_DEFAULTS: InMemoryLedgerLimits = { maxRunKeys: 1_024, maxCasesPerKey: 100_000 };

/**
 * Adapter 1 — in memory. A **shipped deliverable, not a mock**, for exactly the
 * reason `inMemoryEvalNodeStore` is: it is what makes hermeticity structural. It
 * forgets at process exit, which is the right answer for a test and the wrong
 * one for continuous integration, and that is a property of the adapter rather
 * than of the seam.
 *
 * Bounded, like everything else here. Hitting a ceiling is `LedgerUnavailable` —
 * fail-open, so the run proceeds and re-executes — rather than a heap that grows
 * until the process dies with no evidence of why.
 */
export const inMemoryRunLedger = (limits: Partial<InMemoryLedgerLimits> = {}): RunLedger => {
  const bounds: InMemoryLedgerLimits = { ...IN_MEMORY_DEFAULTS, ...limits };
  const completed = new Map<RunKey, StoredCompletedRun>();
  const cases = new Map<RunKey, Map<CaseRef, StoredCaseMemo>>();
  /** Insertion order, so `expireBefore` has something stable to walk. */
  const openedAt = new Map<RunKey, number>();

  return mintRunLedger({
    async findCompleted(runKey) {
      return completed.get(runKey);
    },

    async recordCompleted(record) {
      // First writer wins. Two continuous-integration jobs racing the same key
      // both execute — that is unavoidable and harmless — and exactly one memo
      // survives, so every later reader sees one answer rather than whichever
      // arrived last.
      if (completed.has(record.runKey)) return;
      if (completed.size >= bounds.maxRunKeys) {
        throw new LedgerUnavailable(
          "recordCompleted",
          `run-key ceiling ${String(bounds.maxRunKeys)} reached`,
        );
      }
      completed.set(record.runKey, {
        runKey: record.runKey,
        runId: record.runId,
        completedAt: record.completedAt,
        schema: record.schema,
        sourceKind: record.sourceKind,
        reportJson: record.reportJson,
      });
      openedAt.set(record.runKey, record.completedAt);
    },

    async findCases(runKey) {
      const found = cases.get(runKey);
      if (found === undefined) return [];
      return [...found.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    },

    async recordCase(memo) {
      let forKey = cases.get(memo.runKey);
      if (forKey === undefined) {
        forKey = new Map();
        cases.set(memo.runKey, forKey);
      }
      if (forKey.has(memo.ref)) return;
      if (forKey.size >= bounds.maxCasesPerKey) {
        throw new LedgerUnavailable(
          "recordCase",
          `case ceiling ${String(bounds.maxCasesPerKey)} reached for run key ${memo.runKey}`,
        );
      }
      forKey.set(memo.ref, memo);
      if (!openedAt.has(memo.runKey)) openedAt.set(memo.runKey, memo.recordedAt);
    },

    async expireBefore(cutoff, batchLimit) {
      if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 10_000) {
        throw new LimitOutOfRange("ledger.expireBefore.batchLimit", batchLimit, "1..10000 (integer)");
      }
      let runKeys = 0;
      let removedCases = 0;
      for (const [runKey, at] of [...openedAt]) {
        if (runKeys >= batchLimit) break;
        if (at >= cutoff) continue;
        removedCases += cases.get(runKey)?.size ?? 0;
        cases.delete(runKey);
        completed.delete(runKey);
        openedAt.delete(runKey);
        runKeys += 1;
      }
      return { runKeys, cases: removedCases };
    },
  });
};

/* --------------------------------------------------------------- adapter 2 */

const RUN_MEMO = "agent_ops.eval_run_memo";
const CASE_MEMO = "agent_ops.eval_case_memo";

/**
 * The schema this adapter requires, shipped **as a value** for the same reason
 * `EVAL_STORE_SCHEMA_SQL` is: an adapter whose schema lives only in prose is an
 * adapter nobody can run, and there is no way to tell from reading it.
 *
 * Copy into `migrations/0005_eval_ledger.sql`. It belongs to the eval writer
 * role, not the audit one — these rows are memos about tests and they are
 * deleted on the same 90-day retention as the node graph.
 *
 * Two details carry the concurrency guarantee. `ON CONFLICT DO NOTHING` on both
 * inserts is what makes "first writer wins" a property of the database rather
 * than of a read-then-write race in this file — two continuous-integration jobs
 * on the same key will collide, during a deploy or a re-triggered build, and
 * neither may overwrite the other. And `report_json` is `text`, never `jsonb`:
 * `jsonb` reorders keys and normalises numbers, which would destroy the bytes
 * the report's own rate recomputation is checked against.
 */
export const EVAL_LEDGER_SCHEMA_SQL = `-- 0005_eval_ledger.sql
-- The run ledger: idempotency and resume for eval runs. Same role, same grants
-- and the same 90-day retention as the eval node store; a trace never spans the
-- audit store and these tables.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_ops.eval_run_memo (
  run_key      text        PRIMARY KEY,
  run_id       text        NOT NULL,
  completed_at bigint      NOT NULL,
  schema       text        NOT NULL,
  source_kind  text        NOT NULL CHECK (source_kind IN ('golden', 'recorded')),
  -- text, never jsonb: jsonb reorders keys and normalises numbers, and the
  -- report is re-entered by recomputing its rates from its own bytes.
  report_json  text        NOT NULL,
  inserted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_run_memo_completed_at
  ON agent_ops.eval_run_memo (completed_at);

CREATE TABLE IF NOT EXISTS agent_ops.eval_case_memo (
  run_key            text   NOT NULL,
  case_ref           text   NOT NULL,
  case_digest        text   NOT NULL,
  from_run_id        text   NOT NULL,
  from_node          text   NOT NULL,
  recorded_at        bigint NOT NULL,
  status             text   NOT NULL CHECK (status IN
                       ('matched','mismatched','unscored','contested','unattributed')),
  score_basis_points int    NOT NULL,
  observed_json      text   NOT NULL,
  detail             text   NULL,
  model_calls        int    NOT NULL,
  cost_tenth_cents   bigint NOT NULL,
  PRIMARY KEY (run_key, case_ref)
);

CREATE INDEX IF NOT EXISTS eval_case_memo_recorded_at
  ON agent_ops.eval_case_memo (recorded_at);

REVOKE ALL ON agent_ops.eval_run_memo FROM PUBLIC;
REVOKE ALL ON agent_ops.eval_case_memo FROM PUBLIC;

GRANT SELECT, INSERT, DELETE ON agent_ops.eval_run_memo TO agent_ops_eval_writer;
GRANT SELECT, INSERT, DELETE ON agent_ops.eval_case_memo TO agent_ops_eval_writer;

-- No UPDATE grant, on purpose. A memo is written once and read forever or
-- expired; rewriting one in place would let a green result be edited onto a key
-- that never produced it, and nothing downstream would ever look again.

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0005_eval_ledger')
ON CONFLICT (version) DO NOTHING;

COMMIT;
`;

const text = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));
const int = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const rowToCompleted = (row: SqlRow): StoredCompletedRun => ({
  runKey: text(row["run_key"]) as RunKey,
  runId: text(row["run_id"]) as StoredCompletedRun["runId"],
  completedAt: int(row["completed_at"]),
  schema: text(row["schema"]),
  sourceKind: text(row["source_kind"]) as SourceKind,
  reportJson: text(row["report_json"]),
});

const rowToMemo = (row: SqlRow): StoredCaseMemo => ({
  runKey: text(row["run_key"]) as RunKey,
  ref: text(row["case_ref"]) as CaseRef,
  caseDigest: text(row["case_digest"]) as CaseMemo["caseDigest"],
  fromRunId: text(row["from_run_id"]) as CaseMemo["fromRunId"],
  fromNode: text(row["from_node"]) as CaseMemo["fromNode"],
  recordedAt: int(row["recorded_at"]),
  status: text(row["status"]) as MemoisedStatus,
  scoreBasisPoints: int(row["score_basis_points"]),
  observedJson: text(row["observed_json"]),
  detail: row["detail"] === null || row["detail"] === undefined ? null : text(row["detail"]),
  modelCalls: int(row["model_calls"]),
  costTenthCents: int(row["cost_tenth_cents"]),
});

/**
 * Adapter 2 — SQL, over the same injected `SqlExecutor` the node store takes, so
 * an application wires its existing pool once. No database driver is imported
 * here and no connection string is read: there is no code path in this package
 * that can reach a network, whatever credentials are in the environment.
 *
 * It never retries. A failed query raises `LedgerUnavailable`, which is
 * fail-open — the run proceeds without memoisation and the report says so.
 */
export const sqlRunLedger = (sql: SqlExecutor): RunLedger => {
  const fail = (operation: string, cause: unknown): never => {
    throw cause instanceof LedgerUnavailable ? cause : new LedgerUnavailable(operation, cause);
  };

  return mintRunLedger({
    async findCompleted(runKey) {
      try {
        const found = await sql.query(`SELECT * FROM ${RUN_MEMO} WHERE run_key = $1`, [runKey]);
        const row = found.rows[0];
        return row === undefined ? undefined : rowToCompleted(row);
      } catch (cause) {
        return fail("findCompleted", cause);
      }
    },

    async recordCompleted(record) {
      try {
        // First writer wins, in the database. Two jobs on one key collide during
        // a deploy or a re-triggered build; neither may overwrite the other.
        await sql.query(
          `INSERT INTO ${RUN_MEMO} (run_key, run_id, completed_at, schema, source_kind, report_json)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (run_key) DO NOTHING`,
          [
            record.runKey,
            record.runId,
            record.completedAt,
            record.schema,
            record.sourceKind,
            record.reportJson,
          ],
        );
      } catch (cause) {
        fail("recordCompleted", cause);
      }
    },

    async findCases(runKey) {
      try {
        const found = await sql.query(
          `SELECT * FROM ${CASE_MEMO} WHERE run_key = $1 ORDER BY case_ref ASC`,
          [runKey],
        );
        return found.rows.map(rowToMemo);
      } catch (cause) {
        return fail("findCases", cause);
      }
    },

    async recordCase(memo) {
      try {
        await sql.query(
          `INSERT INTO ${CASE_MEMO}
             (run_key, case_ref, case_digest, from_run_id, from_node, recorded_at,
              status, score_basis_points, observed_json, detail, model_calls, cost_tenth_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (run_key, case_ref) DO NOTHING`,
          [
            memo.runKey,
            memo.ref,
            memo.caseDigest,
            memo.fromRunId,
            memo.fromNode,
            memo.recordedAt,
            memo.status,
            memo.scoreBasisPoints,
            memo.observedJson,
            memo.detail,
            memo.modelCalls,
            memo.costTenthCents,
          ],
        );
      } catch (cause) {
        fail("recordCase", cause);
      }
    },

    /**
     * Bounded, and atomic in one statement, for the same reasons the node
     * store's is: `LIMIT` on the key selection so the batch is bounded, and
     * `count(*)` over the common table expressions so nothing is materialised
     * purely to be counted.
     */
    async expireBefore(cutoff, batchLimit) {
      if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 10_000) {
        throw new LimitOutOfRange("ledger.expireBefore.batchLimit", batchLimit, "1..10000 (integer)");
      }
      try {
        const result = await sql.query(
          `WITH doomed AS (
             SELECT run_key FROM ${RUN_MEMO}
              WHERE completed_at < $1
              ORDER BY completed_at ASC
              LIMIT $2
           ), gone_cases AS (
             DELETE FROM ${CASE_MEMO} WHERE run_key IN (SELECT run_key FROM doomed) RETURNING 1
           ), gone_keys AS (
             DELETE FROM ${RUN_MEMO} WHERE run_key IN (SELECT run_key FROM doomed) RETURNING 1
           )
           SELECT (SELECT count(*) FROM gone_keys) AS run_keys,
                  (SELECT count(*) FROM gone_cases) AS cases`,
          [cutoff, batchLimit],
        );
        const row = result.rows[0];
        return { runKeys: int(row?.["run_keys"]), cases: int(row?.["cases"]) };
      } catch (cause) {
        return fail("expireBefore", cause);
      }
    },
  });
};
