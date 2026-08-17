import { describe, expect, it } from "vitest";
import { harness, testClock } from "./fixtures.js";
import {
  SEVEN_YEARS_MS,
  TraceUnavailable,
  createArchivist,
  inMemoryTraceStore,
  inMemoryWitness,
  postgresRetentionRegister,
  type Archivist,
  type CorrelationId,
  type SqlExecutor,
  type SqlRow,
  type TraceDigest,
  type Witness,
} from "../index.js";

/**
 * Retention, archival and the seven-year expiry.
 *
 * The thing these tests are really asserting is a **negative**: that this
 * library prepares a removal it cannot perform. There is no verb here that
 * deletes, the trace tables grant no role this library creates the ability to
 * delete, and `lib/invariants.ts` fails the build if a removing verb is ever
 * added to `TraceStore`, `RetentionRegister` or `Archivist`. The last test in the
 * first block checks the same rule at runtime, because a type assertion is
 * invisible to somebody reading a diff.
 *
 * What the library does provide is the two things the procedure cannot safely
 * produce for itself: which cases are due, and whether an archive copy is
 * faithful — checked on the day of the removal against the live rows *and*
 * against the external witness.
 */

const DAY = 24 * 60 * 60 * 1_000;
const OPENED = 1_700_000_000_000;

interface Fixture {
  readonly archivist: Archivist;
  readonly witness: Witness;
  readonly store: ReturnType<typeof inMemoryTraceStore>;
  readonly now: number;
  digestOf(correlationId: CorrelationId): Promise<TraceDigest>;
}

/**
 * Three cases: two sealed long enough ago to be past retention, one sealed
 * yesterday. Every timestamp comes from the injected clock, so "seven years
 * ago" costs nothing and waits for nothing.
 */
const fixture = async (): Promise<Fixture> => {
  const store = inMemoryTraceStore();
  const witness = inMemoryWitness();
  const clock = testClock(OPENED);
  const { audit } = harness({ store, witness, clock });

  const seal = async (correlationId: CorrelationId, at: number) => {
    clock.advance(at - clock.now());
    const trace = await audit.open(correlationId);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });
    await trace.close({ unassistedContainment: false });
  };

  const now = OPENED + SEVEN_YEARS_MS + 30 * DAY;
  await seal("case_old_a" as CorrelationId, OPENED);
  await seal("case_old_b" as CorrelationId, OPENED + DAY);
  await seal("case_recent" as CorrelationId, now - DAY);

  const archivist = createArchivist({
    audit,
    register: store,
    witness,
    retentionMs: SEVEN_YEARS_MS,
  });

  return {
    archivist,
    witness,
    store,
    now,
    digestOf: async (correlationId) => (await audit.replay(correlationId)).digest(),
  };
};

describe("audit — the retention survey", () => {
  it("lists sealed cases past retention and leaves the rest alone", async () => {
    const { archivist, now } = await fixture();
    const page = await archivist.due(now, { after: undefined, limit: 10 });

    expect(page.cases.map((c) => String(c.correlationId))).toEqual([
      "case_old_a",
      "case_old_b",
    ]);
    expect(page.more).toBe(false);
    // Retention runs from the seal's own clock reading, never from a database's
    // arrival timestamp.
    expect(page.cases[0]?.closedAt).toBe(OPENED);
  });

  it("pages, and states `more` rather than inferring it from a full page", async () => {
    const { archivist, now } = await fixture();

    const first = await archivist.due(now, { after: undefined, limit: 1 });
    expect(first.cases).toHaveLength(1);
    expect(first.more).toBe(true);

    const second = await archivist.due(now, {
      after: first.cases[0]?.correlationId,
      limit: 1,
    });
    expect(second.cases.map((c) => String(c.correlationId))).toEqual(["case_old_b"]);
    // The page is full and there is nothing after it. Inferring `more` from
    // `length === limit` would loop forever here.
    expect(second.more).toBe(false);
  });

  it("reports the digest each seal attests to, matching a live replay", async () => {
    const { archivist, now, digestOf } = await fixture();
    const page = await archivist.due(now, { after: undefined, limit: 10 });

    for (const expired of page.cases) {
      expect(String(expired.digest)).toBe(String(await digestOf(expired.correlationId)));
    }
  });

  it("exposes no verb that removes anything", async () => {
    const { archivist, store } = await fixture();
    const removing = /^(delete|remove|purge|expire|drop|truncate|erase|destroy)/i;

    // The type assertions in lib/invariants.ts fail the build on this; the
    // runtime check is here because a compile-time assertion is invisible to
    // somebody reading a diff, and this is the rule most worth seeing.
    expect(Object.keys(archivist).filter((k) => removing.test(k))).toEqual([]);
    expect(Object.keys(store).filter((k) => removing.test(k))).toEqual([]);
  });

  it("refuses a retention period that is not a positive whole number", () => {
    const store = inMemoryTraceStore();
    const { audit } = harness({ store });
    // A wiring defect whose consequence is destroying evidence early. It fails
    // at the composition root, not at 3am on a sweep.
    expect(() =>
      createArchivist({
        audit,
        register: store,
        witness: inMemoryWitness(),
        retentionMs: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("audit — clearance for removal", () => {
  it("clears a case whose archive copy and witness both agree", async () => {
    const { archivist, now, digestOf } = await fixture();
    const correlationId = "case_old_a" as CorrelationId;

    const clearance = await archivist.clearForRemoval(
      correlationId,
      await digestOf(correlationId),
      now,
    );

    expect(clearance.cleared).toBe(true);
    expect(clearance.reason).toBe("cleared");
    expect(clearance.witnessed?.correlationId).toBe(correlationId);
  });

  it("refuses when the archive copy digests to something else", async () => {
    const { archivist, now } = await fixture();

    const clearance = await archivist.clearForRemoval(
      "case_old_a" as CorrelationId,
      "aoc.audit.trace.v1:sha256:deadbeef" as TraceDigest,
      now,
    );

    // The export is not the case. Nothing is destroyed on the strength of a
    // copy nobody has checked since the day it was written.
    expect(clearance.cleared).toBe(false);
    expect(clearance.reason).toBe("archive-digest-mismatch");
  });

  it("re-checks the retention date itself rather than trusting the query", async () => {
    const { archivist, now, digestOf } = await fixture();
    const correlationId = "case_recent" as CorrelationId;

    const clearance = await archivist.clearForRemoval(
      correlationId,
      await digestOf(correlationId),
      now,
    );

    // A defect in a WHERE clause must not be able to destroy evidence that is
    // three years old, so clearance measures retention from the seal itself.
    expect(clearance.cleared).toBe(false);
    expect(clearance.reason).toBe("not-due");
  });

  it("refuses an unsealed case", async () => {
    const store = inMemoryTraceStore();
    const witness = inMemoryWitness();
    const clock = testClock(OPENED);
    const { audit } = harness({ store, witness, clock });
    const trace = await audit.open("case_open" as CorrelationId);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });

    const archivist = createArchivist({
      audit,
      register: store,
      witness,
      retentionMs: SEVEN_YEARS_MS,
    });
    const replayed = await audit.replay("case_open" as CorrelationId);

    const clearance = await archivist.clearForRemoval(
      "case_open" as CorrelationId,
      replayed.digest(),
      OPENED + SEVEN_YEARS_MS * 2,
    );
    expect(clearance.reason).toBe("not-closed");
  });

  it("refuses a case nothing ever witnessed", async () => {
    // Written before the witness was wired — the shape of a real deployment
    // that adopted the witness partway through its retention period.
    const store = inMemoryTraceStore();
    const clock = testClock(OPENED);
    const unwitnessed = harness({ store, clock });
    const trace = await unwitnessed.audit.open("case_bare" as CorrelationId);
    await trace.close({ unassistedContainment: true });

    const witness = inMemoryWitness();
    const reader = harness({ store, witness, clock });
    const archivist = createArchivist({
      audit: reader.audit,
      register: store,
      witness,
      retentionMs: SEVEN_YEARS_MS,
    });
    const digest = (await reader.audit.replay("case_bare" as CorrelationId)).digest();

    const clearance = await archivist.clearForRemoval(
      "case_bare" as CorrelationId,
      digest,
      OPENED + SEVEN_YEARS_MS * 2,
    );
    // Nothing corroborates the copy, so nothing is cleared. The remedy is to
    // publish it — `Audit.witness` — not to lower the bar.
    expect(clearance.cleared).toBe(false);
    expect(clearance.reason).toBe("not-witnessed");
  });

  it("refuses — loudly — a case the witness disagrees with", async () => {
    const witness = inMemoryWitness();
    const clock = testClock(OPENED);

    const honest = harness({ store: inMemoryTraceStore(), witness, clock });
    const original = await honest.audit.open("case_rewritten" as CorrelationId);
    await original.record(
      { kind: "payment.authorised", v: 1, amountTenthCents: 47_200_000 },
      { tier: "high" },
    );
    await original.close({ unassistedContainment: false });

    // A consistent rewrite: internally perfect, and archived along with a
    // matching "archive copy" digest. Only the witness disagrees.
    const rewrittenStore = inMemoryTraceStore();
    const rewritten = harness({ store: rewrittenStore, clock });
    const forged = await rewritten.audit.open("case_rewritten" as CorrelationId);
    await forged.record(
      { kind: "payment.authorised", v: 1, amountTenthCents: 4_720 },
      { tier: "high" },
    );
    await forged.close({ unassistedContainment: false });

    const reader = harness({ store: rewrittenStore, witness, clock });
    const archivist = createArchivist({
      audit: reader.audit,
      register: rewrittenStore,
      witness,
      retentionMs: SEVEN_YEARS_MS,
    });
    const forgedDigest = (
      await reader.audit.replay("case_rewritten" as CorrelationId)
    ).digest();

    const clearance = await archivist.clearForRemoval(
      "case_rewritten" as CorrelationId,
      forgedDigest,
      OPENED + SEVEN_YEARS_MS * 2,
    );

    // Without the witness this would have cleared: the rows agree with
    // themselves and the archive copy agrees with the rows. The expiry
    // procedure would then have destroyed the last evidence of the rewrite as
    // its final step.
    expect(clearance.cleared).toBe(false);
    expect(clearance.reason).toBe("witness-mismatch");
  });
});

// ---------------------------------------------------------------------------
// The Postgres register, through the same interface
// ---------------------------------------------------------------------------

describe("audit — the Postgres retention register", () => {
  const sealRow = (correlationId: string, at: number, canonical: string): SqlRow => ({
    correlation_id: correlationId,
    // bigint arrives as text from most drivers.
    at_ms: String(at),
    node_canonical: canonical,
  });

  const registerOver = (rows: readonly SqlRow[]) => {
    const statements: string[] = [];
    const executor: SqlExecutor = {
      query: async (text, params) => {
        statements.push(text);
        const closedBefore = Number(params[0]);
        const after = text.includes("retention-due-after") ? String(params[1]) : undefined;
        const limit = Number(params[text.includes("retention-due-after") ? 2 : 1]);
        const matching = rows
          .filter((row) => Number(row["at_ms"]) < closedBefore)
          .filter((row) => after === undefined || String(row["correlation_id"]) > after)
          .sort((a, b) =>
            String(a["correlation_id"]) < String(b["correlation_id"]) ? -1 : 1,
          );
        return { rows: matching.slice(0, limit) };
      },
      transaction: async (fn) => fn(executor),
    };
    return { register: postgresRetentionRegister(executor), statements };
  };

  /** Two real sealed cases, taken from the in-memory adapter's own rows. */
  const sealsOf = async (): Promise<readonly SqlRow[]> => {
    const store = inMemoryTraceStore();
    const clock = testClock(OPENED);
    const { audit } = harness({ store, clock });
    const rows: SqlRow[] = [];
    for (const id of ["case_p", "case_q"]) {
      const trace = await audit.open(id as CorrelationId);
      await trace.record({ kind: "a", v: 1 }, { tier: "low" });
      const seal = await trace.close({ unassistedContainment: true });
      rows.push(sealRow(id, seal.at, seal.canonical));
      clock.advance(DAY);
    }
    return rows;
  };

  it("reads seal rows and derives the same digest the seal attests to", async () => {
    const rows = await sealsOf();
    const { register, statements } = registerOver(rows);

    const page = await register.dueForRemoval({
      closedBefore: OPENED + SEVEN_YEARS_MS,
      afterCorrelationId: undefined,
      limit: 10,
    });

    expect(page.cases.map((c) => String(c.correlationId))).toEqual(["case_p", "case_q"]);
    expect(page.cases[0]?.nodes).toBe(2);
    expect(String(page.cases[0]?.digest)).toMatch(/^aoc\.audit\.trace\.v1:sha256:/);

    // SELECT only. The sweep that decides what may be destroyed does not run on
    // a connection that could destroy it.
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(update|delete|insert|truncate)\b/i);
    }
  });

  it("uses a separate statement for the first page rather than an empty cursor", async () => {
    const rows = await sealsOf();
    const { register, statements } = registerOver(rows);

    await register.dueForRemoval({
      closedBefore: OPENED + SEVEN_YEARS_MS,
      afterCorrelationId: undefined,
      limit: 10,
    });
    await register.dueForRemoval({
      closedBefore: OPENED + SEVEN_YEARS_MS,
      afterCorrelationId: "case_p" as CorrelationId,
      limit: 10,
    });

    // `correlation_id > ''` is true in every collation this project has met and
    // is not guaranteed to be in every collation it will meet. Two statements
    // cost eight lines and remove the question.
    expect(statements[0]).toContain("retention-due-first");
    expect(statements[1]).toContain("retention-due-after");
  });

  it("names a failing sweep rather than letting a raw driver error escape", async () => {
    const broken: SqlExecutor = {
      query: async () => {
        throw new Error("ECONNREFUSED");
      },
      transaction: async (fn) => fn(broken),
    };
    await expect(
      postgresRetentionRegister(broken).dueForRemoval({
        closedBefore: 0,
        afterCorrelationId: undefined,
        limit: 1,
      }),
    ).rejects.toThrow(TraceUnavailable);
  });
});
