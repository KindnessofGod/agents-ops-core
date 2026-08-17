import { access, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createAudit,
  postgresTraceStore,
  redactFields,
  type CorrelationId,
  type SqlExecutor,
} from "../../audit/index.js";
import {
  DEFAULT_LIMITS,
  createGuardrails,
  localeOf,
  preemptiveDetector,
  preemptiveScanPool,
  safePattern,
  systemTimer,
  type NonEmpty,
  type ScanPool,
} from "../index.js";

/**
 * Two claims of this module, attacked against a real Postgres.
 *
 * Everything else in this folder proves what `guardrails` does against an
 * in-memory trace store — a map in this process, which cannot round-trip a
 * value through a serialiser, cannot refuse a write, and cannot be queried by
 * anybody but this module. So two of the module's load-bearing sentences had
 * never been tested against a store at all:
 *
 *   1. **"No site any detector reported reaches a store, and there is no
 *      un-writing."** Proved here by `SELECT`ing the whole trace's raw text out
 *      of `agent_ops.audit_trace_node` and asserting the personal-data value is
 *      nowhere in any byte of it. A grep of a real table is a different quality
 *      of evidence from an assertion about a returned object, because it also
 *      covers every field this module writes that no test thought to look at.
 *   2. **"A preempted detector fails the screening closed, durably."** The
 *      worker-thread path of `README.md` item 10 writes its `unavailable` node
 *      and its `recommend=abstain` settled node through the real store, and both
 *      are read back by replay after the fact. An abstention that is not in the
 *      database is not evidence in 2033.
 *
 * ## The hermetic rule, and exactly what this file does and does not change
 *
 * `CLAUDE.md` requires hermeticity **structurally, through dependency
 * injection**, not by convention and not by an environment variable. The library
 * is untouched: no module here imports a driver, `postgresTraceStore` takes an
 * injected `SqlExecutor`, and `pg` is a devDependency of the workspace root
 * rather than of the published package, so nineteen applications inherit
 * nothing.
 *
 * What this file changes is narrower, and is the same narrowing
 * `audit/tests/live-postgres.test.ts` already argues: **with
 * `AGENT_OPS_LIVE_DATABASE_URL` set, this one file opens a socket to a
 * database.** It is a database and nothing else — no model client, no pager and
 * no transport of any kind is constructible from anything imported here, so the
 * guarantee that matters most is untouched. The driver import is dynamic and
 * lives inside the gate, so with the variable unset `pg` is never loaded, no
 * pool is constructed and the in-memory path in every other file in this folder
 * is not weakened by a line. And the variable is a connection string supplied
 * deliberately: no default, no fallback to `localhost`, and no reading of the
 * development compose file's own variable, so a developer with a `.env` sourced
 * does not silently start opening sockets from `npm test`.
 *
 * **No variable — skip, cleanly, exit zero.** That is every default run and
 * every `npm run check`. **A variable that does not work — fail, loudly**, for
 * the reason the `audit` suite gives: a job that skips silently for a year is
 * the false green these files exist to remove.
 *
 * Point it at a database you can throw away. This suite applies every migration
 * in `./migrations` and commits rows to a table nothing in this library can ever
 * delete from.
 *
 *   AGENT_OPS_LIVE_DATABASE_URL=postgres://…@localhost:5433/agent_ops \
 *     npx vitest run packages/agent-ops-core/src/guardrails/tests/live-postgres.test.ts
 */

const LIVE_URL = process.env["AGENT_OPS_LIVE_DATABASE_URL"];
const live = LIVE_URL === undefined ? describe.skip : describe;

/** Everything this run writes is prefixed with this, so it is identifiable. */
const RUN = `live-test:guardrails:${randomUUID()}`;
const caseId = (name: string): CorrelationId => `${RUN}:${name}` as CorrelationId;

/**
 * A national insurance number that exists nowhere but this file. If any byte of
 * it turns up in the trace table the redaction claim is false, and the assertion
 * that finds it is worth more than every in-memory redaction test combined.
 */
const SECRET_NIN = "AB123456C";

const migrationsDir = async (): Promise<string> => {
  let here = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 12; up += 1) {
    const candidate = join(here, "migrations");
    try {
      await access(candidate);
      return candidate;
    } catch {
      here = resolve(here, "..");
    }
  }
  throw new Error("could not find the migrations directory above this test file");
};

live("guardrails — against a real Postgres", () => {
  let pool: Pool;
  let pack: ScanPool;

  const poolExecutor = (): SqlExecutor => ({
    query: async (text, params) => {
      const { rows } = await pool.query(text, [...params]);
      return { rows };
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const onClient: SqlExecutor = {
          query: async (text, params) => {
            const { rows } = await client.query(text, [...params]);
            return { rows };
          },
          transaction: () => {
            throw new Error("SqlExecutor.transaction does not nest");
          },
        };
        const result = await fn(onClient);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  });

  const auditOf = () =>
    createAudit({
      store: postgresTraceStore(poolExecutor()),
      clock: { now: () => Date.now() },
      // A deny list that strips nothing, deliberately: the redaction assertion
      // below must be evidence about what **`guardrails`** wrote, not about what
      // `audit` masked on the way past. Wiring `redactAllExcept` here would make
      // the test pass for the wrong module's reasons.
      redact: redactFields([]),
      onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
    });

  const guardrailsOf = (detectors: NonEmpty<ReturnType<typeof preemptiveDetector>>) => {
    const set = {
      id: "live" as never,
      input: detectors,
      output: detectors,
    };
    return createGuardrails({
      audit: auditOf(),
      clock: { now: () => Date.now() },
      timer: systemTimer(),
      locale: localeOf("en-GB"),
      detectorSets: { low: set, medium: set, high: set },
      limits: DEFAULT_LIMITS,
    });
  };

  beforeAll(async () => {
    const { Pool: PgPool } = await import("pg");
    pool = new PgPool({ connectionString: LIVE_URL, max: 8, connectionTimeoutMillis: 5_000 });

    const dir = await migrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      await pool.query(await readFile(join(dir, file), "utf8"));
    }

    const { rows } = await pool.query<{ readonly correlation_id: string }>(
      `SELECT correlation_id FROM agent_ops.audit_trace_case
       WHERE correlation_id NOT LIKE 'live-test:%' LIMIT 1`,
    );
    if (rows.length > 0) {
      throw new Error(
        "AGENT_OPS_LIVE_DATABASE_URL points at a database holding real cases " +
          `(for example ${String(rows[0]?.correlation_id)}). Point it at a throwaway database.`,
      );
    }

    pack = preemptiveScanPool({
      timer: systemTimer(),
      maxWorkers: 2,
      maxQueued: 4,
      maxTasksPerWorker: 64,
      maxHeapMb: 64,
      maxTimeoutMs: 800,
    });
  }, 60_000);

  afterAll(async () => {
    await pack?.close();
    await pool?.end();
  });

  const ninDetector = () =>
    preemptiveDetector({
      pool: pack,
      id: "pii.uk.nin.live",
      locales: ["en-GB"] as unknown as NonEmpty<string>,
      searches: "United Kingdom national insurance numbers",
      category: "personal-data",
      severity: "redact",
      patterns: [
        safePattern({
          rule: "uk.national-insurance-number",
          match: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g,
          confidenceBasisPoints: 9_500,
          covers: "personal-data.national-identifier",
        }),
      ],
    });

  it("writes no detected site into the database, in any column of any node", async () => {
    const correlationId = caseId("redaction");
    const guardrails = guardrailsOf([ninDetector()]);

    const screening = await guardrails.screenInput({
      correlationId,
      tier: "high",
      payload: { narrative: `claimant ${SECRET_NIN} filed a claim on Tuesday` },
    });
    expect(screening.recommended.recommend).toBe("redact-and-allow");
    expect(screening.payload.fields["narrative"]).toBe(
      "claimant [redacted] filed a claim on Tuesday",
    );

    // The whole trace, as bytes, straight out of the table. Not the object this
    // module returned and not what a replay decoded — the rows themselves.
    const { rows } = await pool.query<{ readonly whole: string }>(
      `SELECT coalesce(string_agg(n.node_canonical || ' ' || n.payload_canonical, ' '), '') AS whole
         FROM agent_ops.audit_trace_node n
        WHERE n.correlation_id = $1`,
      [correlationId],
    );
    const whole = rows[0]?.whole ?? "";
    expect(whole.length).toBeGreaterThan(0);
    // The claim, tested rather than asserted: no site any detector reported
    // reaches a store, and there is no un-writing.
    expect(whole).not.toContain(SECRET_NIN);
    expect(whole).not.toContain("AB 12 34 56 C");
    // And the masked form did reach it, so this is not passing because nothing
    // was written at all.
    expect(whole).toContain("[redacted]");
  }, 60_000);

  it("records a preempted detector as a durable, replayable abstention", async () => {
    const correlationId = caseId("preempted");
    const guardrails = guardrailsOf([
      preemptiveDetector({
        pool: pack,
        id: "pii.pathological.live",
        locales: ["en-GB"] as unknown as NonEmpty<string>,
        searches: "a deliberately expensive pattern",
        category: "personal-data",
        severity: "redact",
        // Accepted by `safePattern`, superpolynomial, and preemptible only
        // because the scan runs in a worker this pool can terminate.
        patterns: [
          safePattern({
            rule: "test.pathological",
            match: /a*a*a*b/,
            confidenceBasisPoints: 9_000,
            covers: "personal-data.national-identifier",
          }),
        ],
      }),
    ]);

    const screening = await guardrails.screenInput({
      correlationId,
      tier: "high",
      payload: { narrative: "a".repeat(2_000) },
    });
    expect(screening.recommended.recommend).toBe("abstain");
    expect(pack.stats().preempted).toBeGreaterThanOrEqual(1);

    // Durable. Read out of Postgres by kind, not out of the returned object: an
    // abstention that is not in the database is not evidence in seven years.
    const { rows } = await pool.query<{
      readonly kind: string;
      readonly payload_canonical: string;
    }>(
      `SELECT kind, payload_canonical
         FROM agent_ops.audit_trace_node
        WHERE correlation_id = $1
        ORDER BY sequence`,
      [correlationId],
    );
    // The canonical payload as the database holds it, parsed here rather than by
    // `audit`: the point is what is in the row, not what a decoder makes of it.
    const payloadOf = (kind: string): Record<string, unknown> =>
      JSON.parse(rows.find((r) => r.kind === kind)?.payload_canonical ?? "{}") as Record<
        string,
        unknown
      >;
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain("guardrails.screening.opened");
    expect(kinds).toContain("guardrails.detector.ran");
    expect(kinds).toContain("guardrails.screening.settled");

    const detector = payloadOf("guardrails.detector.ran");
    expect(detector["outcome"]).toBe("unavailable");
    expect(String(detector["detail"])).toContain("preempted");

    const settled = payloadOf("guardrails.screening.settled");
    expect(settled["recommend"]).toBe("abstain");
    expect(settled["detectorsUnavailable"]).toBe(1);
    // Nothing was examined, and the trace says so rather than reading clean.
    expect(settled["coverageExaminedBasisPoints"]).toBe(0);
  }, 60_000);
});
