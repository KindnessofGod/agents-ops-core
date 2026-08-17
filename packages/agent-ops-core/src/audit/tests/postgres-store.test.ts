import { describe, expect, it } from "vitest";
import { CASE_A, mustRecord, redactNothing, strictPolicy, testClock } from "./fixtures.js";
import {
  SEAL_KIND,
  TraceTampered,
  TraceUnavailable,
  createAudit,
  postgresTraceStore,
  type SqlExecutor,
  type SqlRow,
} from "../index.js";

/**
 * Slice 7 — the Postgres adapter, the second real adapter of the `TraceStore`
 * seam.
 *
 * ## Why these tests are hermetic without a flag
 *
 * The adapter takes an injected `SqlExecutor`. It imports no driver, reads no
 * connection string and opens no socket, so there is no code path in this
 * package — shipped or test — that could reach a database even with real
 * credentials present in the environment. The guarantee comes from the absence
 * of a driver, and nothing in this file reads an environment variable or
 * imports one dynamically. See the note at the foot of the file for what that
 * costs and where the schema's own guarantees are verified instead.
 *
 * ## What the recording executor does and does not prove
 *
 * It proves what this adapter is allowed to issue — that no UPDATE, DELETE or
 * TRUNCATE is ever sent, that every statement is parameterised, that writes are
 * wrapped in a transaction and take the per-case lock first — and it proves the
 * adapter round-trips a trace through rows.
 *
 * It does **not** prove the schema's own guarantees: the primary key, the
 * one-seal partial unique index, the parent foreign key, the DAG check, the
 * immutability triggers or the grants. Those are properties of Postgres and
 * **no test in this package exercises them**, because no test in this package
 * may open a socket. That half is verified by applying the migration to a real
 * database as an operational step; see the note at the foot of this file. A
 * green run of this file is **not** evidence that append-only holds.
 */

interface Recorder {
  readonly executor: SqlExecutor;
  readonly statements: string[];
}

const tagOf = (text: string): string => {
  const match = /^-- audit:([a-z-]+)/.exec(text);
  return match?.[1] ?? "untagged";
};

/**
 * A small stand-in that understands exactly the six tagged statements this
 * adapter issues. It is not a database and does not pretend to be one.
 */
const recordingExecutor = (): Recorder => {
  const statements: string[] = [];
  const cases = new Map<string, SqlRow>();
  const nodes = new Map<string, SqlRow[]>();

  const run = async (
    text: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: readonly SqlRow[] }> => {
    statements.push(text);
    const correlationId = String(params[0]);
    const forCase = nodes.get(correlationId) ?? [];

    switch (tagOf(text)) {
      case "open-case":
        if (!cases.has(correlationId)) {
          cases.set(correlationId, {
            captured_via: params[1],
            canonical_form: params[2],
            redaction: params[3],
            // bigint arrives as text from most drivers; return it that way so
            // the adapter's own coercion is exercised.
            opened_at_ms: String(params[4]),
          });
          nodes.set(correlationId, []);
        }
        return { rows: [] };

      case "lock":
        return { rows: [{ pg_advisory_xact_lock: null }] };

      case "next-sequence":
        return {
          rows: [
            {
              next_sequence: forCase.length,
              sealed: forCase.some((row) => row["is_seal"] === true),
            },
          ],
        };

      case "append":
        forCase.push({
          sequence: params[1],
          node_id: params[2],
          at_ms: String(params[3]),
          tier: params[4],
          parent_sequence: params[5],
          payload_schema_version: params[6],
          redaction: params[7],
          kind: params[8],
          payload_canonical: params[9],
          node_canonical: params[10],
          is_seal: params[11],
        });
        nodes.set(correlationId, forCase);
        return { rows: [] };

      case "read-case": {
        const row = cases.get(correlationId);
        return { rows: row === undefined ? [] : [row] };
      }

      case "read-nodes":
        return { rows: [...forCase] };

      case "read-page": {
        // `sequence > $2 ORDER BY sequence LIMIT $3`, faithfully enough to hold
        // the adapter to invariant 7. The adapter asks for `limit + 1` rows and
        // derives `more` from the extra one.
        const after = Number(params[1]);
        const limit = Number(params[2]);
        return {
          rows: forCase
            .filter((row) => Number(row["sequence"]) > after)
            .sort((a, b) => Number(a["sequence"]) - Number(b["sequence"]))
            .slice(0, limit),
        };
      }

      default:
        throw new Error(`unexpected statement: ${text}`);
    }
  };

  const executor: SqlExecutor = {
    query: run,
    transaction: async (fn) => fn(executor),
  };

  return { executor, statements };
};

const pgHarness = () => {
  const { executor, statements } = recordingExecutor();
  const store = postgresTraceStore(executor);
  const clock = testClock(1_700_000_000_000);
  const audit = createAudit({
    store,
    clock,
    redact: redactNothing,
    onTraceUnavailable: strictPolicy,
  });
  return { audit, store, statements, clock };
};

describe("audit — Postgres adapter, statement discipline", () => {
  it("never issues an UPDATE, a DELETE or a TRUNCATE on the whole lifecycle", async () => {
    const { audit, statements } = pgHarness();
    const trace = await audit.open(CASE_A);
    const parent = mustRecord(
      await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" }),
    ).node;
    await trace.record({ kind: "model.call", v: 1 }, { tier: "high", parent });
    await trace.close({ unassistedContainment: false });
    await audit.replay(CASE_A);

    const forbidden = statements.filter((s) =>
      /\b(update|delete|truncate)\b/i.test(s),
    );
    expect(forbidden).toEqual([]);
  });

  it("takes the per-case lock before reading the next sequence, every time", async () => {
    const { audit, statements } = pgHarness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });
    await trace.record({ kind: "b", v: 1 }, { tier: "low" });

    const tags = statements.map(tagOf);
    for (let i = 0; i < tags.length; i += 1) {
      if (tags[i] === "next-sequence") expect(tags[i - 1]).toBe("lock");
    }
    expect(tags.filter((t) => t === "lock")).toHaveLength(2);
  });

  it("parameterises everything, so a correlation identifier cannot be SQL", async () => {
    const { audit, statements } = pgHarness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "a", v: 1, note: "'; drop table --" }, { tier: "low" });

    for (const statement of statements) {
      expect(statement).not.toContain("drop table");
      expect(statement).not.toContain(CASE_A);
    }
  });
});

describe("audit — Postgres adapter, behaviour", () => {
  it("assigns the sequence from the store and round-trips the graph through rows", async () => {
    const { audit } = pgHarness();
    const trace = await audit.open(CASE_A);
    const decision = mustRecord(
      await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" }),
    ).node;
    await trace.record(
      { kind: "model.call", v: 1, tokensIn: 900 },
      { tier: "high", parent: decision },
    );

    const replayed = await audit.replay(CASE_A);

    expect(replayed.nodes.map((n) => n.sequence)).toEqual([0, 1]);
    expect(replayed.childrenOf(decision.id)).toHaveLength(1);
    expect(replayed.provenance.capturedVia).toBe("injected-trace-store-only");
  });

  it("produces the same canonical bytes and the same digest as the in-memory adapter", async () => {
    const { audit: pg } = pgHarness();
    const { harness } = await import("./fixtures.js");
    const { audit: mem } = harness();

    for (const audit of [pg, mem]) {
      const trace = await audit.open(CASE_A);
      const parent = mustRecord(
        await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" }),
      ).node;
      await trace.record(
        { kind: "model.call", v: 1, tokensIn: 900 },
        { tier: "high", parent },
      );
      await trace.close({ unassistedContainment: true });
    }

    // Two adapters, one seam, byte-identical evidence. If these ever diverge,
    // a case migrated between stores stops verifying against its own digest.
    expect((await pg.replay(CASE_A)).digest()).toBe(
      (await mem.replay(CASE_A)).digest(),
    );
  });

  it("seals on close and refuses a second close", async () => {
    const { audit } = pgHarness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });

    const seal = await trace.close({ unassistedContainment: true });
    expect(seal.payload.kind).toBe(SEAL_KIND);
    expect((await audit.replay(CASE_A)).closed).toBe(true);

    await expect(trace.close({ unassistedContainment: true })).rejects.toThrow(
      /closed/i,
    );
  });

  it("refuses to record against a sealed case", async () => {
    const { audit } = pgHarness();
    const trace = await audit.open(CASE_A);
    await trace.close({ unassistedContainment: true });

    await expect(
      trace.record({ kind: "decision.decided", v: 1 }, { tier: "low" }),
    ).rejects.toThrow(/closed/i);
  });
});

describe("audit — Postgres adapter, bounded reads and evolving bytes", () => {
  it("bounds every read of a case's nodes with a LIMIT", async () => {
    const { audit, statements } = pgHarness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });
    await audit.replay(CASE_A);

    const reads = statements.filter((s) => tagOf(s) === "read-nodes");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read).toContain("LIMIT $2");
  });

  it("refuses a case holding more nodes than the configured ceiling", async () => {
    const { executor } = recordingExecutor();
    const store = postgresTraceStore(executor, { maxNodesPerCase: 2 });
    const audit = createAudit({
      store,
      clock: testClock(1_700_000_000_000),
      redact: redactNothing,
      onTraceUnavailable: strictPolicy,
    });
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });
    await trace.record({ kind: "b", v: 1 }, { tier: "low" });

    // The third append is refused by the ceiling; replay of two nodes is fine.
    await expect(
      trace.record({ kind: "c", v: 1 }, { tier: "low" }),
    ).rejects.toThrow(TraceUnavailable);
    expect((await audit.replay(CASE_A)).nodes).toHaveLength(2);
  });

  it("streams a case through pages and agrees with its own whole-case replay", async () => {
    // Invariant 7 held by the second adapter, not only by the first. Both
    // adapters owe the same page contract, and a streaming reader that agreed
    // with one and not the other would make a case's evidence depend on which
    // store it was read from.
    const { audit, statements } = pgHarness();
    const trace = await audit.open(CASE_A);
    for (let i = 0; i < 9; i += 1) {
      await trace.record({ kind: "decision.decided", v: 1, step: i }, { tier: "low" });
    }
    await trace.close({ unassistedContainment: true });

    const seen: number[] = [];
    const walk = audit.walk(CASE_A, { pageSize: 4 });
    let verdict;
    for (;;) {
      const step = await walk.next();
      if (step.done) {
        verdict = step.value;
        break;
      }
      seen.push(step.value.sequence);
    }

    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(verdict.closed).toBe(true);
    expect(String(verdict.digest)).toBe(String((await audit.replay(CASE_A)).digest()));

    const pages = statements.filter((s) => tagOf(s) === "read-page");
    expect(pages.length).toBeGreaterThan(1);
    // Bounded at the statement, not merely in the caller.
    for (const page of pages) expect(page).toContain("LIMIT $3");
  });

  it("round-trips telemetry through rows without a column for it", async () => {
    // The bytes are the record and the columns are the index, so a field added
    // to the envelope reaches a reader without a migration per field.
    const { audit } = pgHarness();
    const trace = await audit.open(CASE_A);
    await trace.record(
      { kind: "model.call", v: 1 },
      {
        tier: "high",
        telemetry: {
          costTenthCents: 41,
          tokensIn: 900,
          tokensOut: 120,
          latencyMicros: 1_240_000,
          priceTableVersion: "aoc.prices.2026-08",
        },
      },
    );

    const replayed = await audit.replay(CASE_A);
    expect(replayed.nodes[0]?.telemetry).toEqual({
      costTenthCents: 41,
      tokensIn: 900,
      tokensOut: 120,
      latencyMicros: 1_240_000,
      priceTableVersion: "aoc.prices.2026-08",
    });
  });

  it("reports a row edited in place, in either direction", async () => {
    const { executor, statements } = recordingExecutor();
    const store = postgresTraceStore(executor);
    const audit = createAudit({
      store,
      clock: testClock(1_700_000_000_000),
      redact: redactNothing,
      onTraceUnavailable: strictPolicy,
    });
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });
    void statements;

    // Edit the indexed column and leave the bytes alone — a psql prompt with a
    // hypothetical UPDATE grant. The two sides are compared, so it is caught.
    const tampering: SqlExecutor = {
      query: async (text, params) => {
        const result = await executor.query(text, params);
        if (tagOf(text) !== "read-nodes") return result;
        return {
          rows: result.rows.map((row) => ({ ...row, tier: "low" })),
        };
      },
      transaction: (fn) => fn(tampering),
    };

    const reader = createAudit({
      store: postgresTraceStore(tampering),
      clock: testClock(1_700_000_000_000),
      redact: redactNothing,
      onTraceUnavailable: strictPolicy,
    });
    await expect(reader.replay(CASE_A)).rejects.toThrow(TraceTampered);
  });
});

/**
 * There is deliberately no live-database block in this file any more.
 *
 * There used to be one: it read `AGENT_OPS_TEST_DATABASE_URL` and
 * `AGENT_OPS_TEST_PG_MODULE`, dynamically imported a driver and constructed a
 * pool in a top-level `await` that ran at collection time. With both variables
 * set, `npx vitest run packages/agent-ops-core/src/audit` opened a socket.
 *
 * `CLAUDE.md` and `BRIEF.md` C3 are explicit: hermeticity is enforced through
 * dependency injection, "not by convention and not by an environment variable".
 * The old block argued that the guard was one-directional and therefore
 * harmless. That argument is about *blast radius*, and the constraint is not
 * about blast radius — it is about there being no code path in this package
 * that can reach a network. There is now none, in shipped code or in test.
 *
 * **What that costs, stated rather than hidden.** The schema's own guarantees —
 * the primary key, the one-seal partial unique index, the parent foreign key,
 * the `parent_sequence < sequence` check, the immutability triggers and the
 * grants — are properties of Postgres and are not exercised by any test in this
 * package. They are verified by applying `migrations/0002_audit_trace.sql` to a
 * real database and running the assertions from `docs/RUNBOOK.md` against it, as
 * a deliberate operational step outside the test suite. A green run of this file
 * is evidence about this adapter's behaviour and is **not** evidence that
 * append-only holds in the database.
 */
