import { describe, expect, it } from "vitest";
import {
  ComponentNotWatched,
  LivenessBeatUnrecordable,
  LivenessRecordCorrupt,
  LivenessStoreUnavailable,
  LivenessTermsConflict,
  createHeartbeat,
  inMemoryLivenessStore,
  livenessFindings,
  livenessQuery,
  postgresLivenessStore,
  runLivenessStoreContract,
  type LivenessStore,
  type LivenessStoreContractSubject,
  type SqlExecutor,
  type SqlRow,
} from "../index.js";
import { COMPONENT, testClock } from "./fixtures.js";

/**
 * README item 2, closed: `postgresLivenessStore`.
 *
 * ## Why this file is hermetic without a flag
 *
 * The adapter takes an injected `SqlExecutor`. It imports no driver, reads no
 * connection string and opens no socket, so there is no code path in this
 * package — shipped or test — that could reach a database even with real
 * credentials in the environment. Nothing here reads an environment variable or
 * imports one dynamically; `production.test.ts` asserts that structurally over
 * every file in this folder.
 *
 * ## What the fake proves and what it does not
 *
 * The fake below understands exactly the three tagged statements this adapter is
 * allowed to issue, and implements their *semantics* — the upsert that returns
 * the stored cadence, the row-scoped update that increments a sequence and
 * clamps `last_seen_at` upwards, the ordered read. That is enough to hold the
 * adapter to every obligation in `livenessStoreContract`, and it is what makes
 * running the same contract against `inMemoryLivenessStore` meaningful: the two
 * shipped adapters are checked against one another, in continuous integration,
 * with no database.
 *
 * It does **not** prove the schema. The primary key, the `CHECK` constraints
 * that stop a `nothing-was-due` row acquiring an item count, `GREATEST` /
 * `COALESCE` semantics, the row lock under concurrent writers, the grants — all
 * are properties of Postgres and none is exercised here. That half is verified
 * by running `runLivenessStoreContract` against a live pool from an operational
 * script, per the note at the foot of this file. A green run here is **not**
 * evidence that beats survive a restart.
 */

const tagOf = (text: string): string => {
  const match = /^-- alerts:([a-z-]+)/.exec(text);
  return match?.[1] ?? "untagged";
};

interface FakeRow {
  component: string;
  expected_every_ms: number;
  watching_since: number;
  beats: number;
  empty_beats: number;
  working_beats: number;
  items_processed: number;
  last_seen_at: number | null;
  last_run_kind: string | null;
  last_run_items: number | null;
  sequence: number;
}

interface Fake {
  readonly executor: SqlExecutor;
  readonly statements: string[];
  /** The shared table. Survives a store object, which is the point. */
  readonly table: Map<string, FakeRow>;
}

/**
 * A stand-in that understands exactly three tagged statements. It is not a
 * database and does not pretend to be one; every value it returns is shaped the
 * way a driver returns it, including `bigint` columns as **strings**, which is
 * how a real driver hands back a 64-bit integer and is the decode this adapter
 * has to get right.
 */
const fakeExecutor = (table: Map<string, FakeRow> = new Map()): Fake => {
  const statements: string[] = [];

  const asDriverRow = (row: FakeRow): SqlRow => ({
    component: row.component,
    // Every bigint column comes back as text, deliberately.
    expected_every_ms: String(row.expected_every_ms),
    watching_since: String(row.watching_since),
    beats: String(row.beats),
    empty_beats: String(row.empty_beats),
    working_beats: String(row.working_beats),
    items_processed: String(row.items_processed),
    last_seen_at: row.last_seen_at === null ? null : String(row.last_seen_at),
    last_run_kind: row.last_run_kind,
    last_run_items: row.last_run_items === null ? null : String(row.last_run_items),
    sequence: String(row.sequence),
  });

  const query = async (
    text: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: readonly SqlRow[] }> => {
    statements.push(text);
    switch (tagOf(text)) {
      case "watch": {
        const [component, expectedEveryMs, since] = params as [string, number, number];
        const existing = table.get(component);
        if (existing === undefined) {
          table.set(component, {
            component,
            expected_every_ms: expectedEveryMs,
            watching_since: since,
            beats: 0,
            empty_beats: 0,
            working_beats: 0,
            items_processed: 0,
            last_seen_at: null,
            last_run_kind: null,
            last_run_items: null,
            sequence: 0,
          });
          return { rows: [{ expected_every_ms: String(expectedEveryMs) }] };
        }
        // `DO UPDATE SET expected_every_ms = <table>.expected_every_ms` — the
        // stored value, never the offered one.
        return { rows: [{ expected_every_ms: String(existing.expected_every_ms) }] };
      }

      case "beat": {
        const [component, at, kind, didWork, itemsDelta, lastRunItems] = params as [
          string,
          number,
          string,
          number,
          number,
          number | null,
        ];
        const row = table.get(component);
        // `UPDATE ... WHERE component = $1` matching nothing returns no rows.
        if (row === undefined) return { rows: [] };
        row.beats += 1;
        row.sequence += 1;
        row.working_beats += didWork;
        row.empty_beats += 1 - didWork;
        row.items_processed += itemsDelta;
        // GREATEST(COALESCE(last_seen_at, $2), $2)
        row.last_seen_at = row.last_seen_at === null ? at : Math.max(row.last_seen_at, at);
        row.last_run_kind = kind;
        row.last_run_items = lastRunItems;
        return { rows: [asDriverRow(row)] };
      }

      case "snapshot": {
        const [limit] = params as [number];
        return {
          rows: [...table.values()]
            .sort((a, b) => (a.component < b.component ? -1 : a.component > b.component ? 1 : 0))
            .slice(0, limit)
            .map(asDriverRow),
        };
      }

      default:
        throw new Error(`unexpected statement: ${text}`);
    }
  };

  const executor: SqlExecutor = { query, transaction: async (fn) => fn(executor) };
  return { executor, statements, table };
};

// --- statement discipline ----------------------------------------------------

describe("alerts — the Postgres liveness adapter issues only what it declares", () => {
  it("parameterises everything: no component identifier is ever interpolated into SQL", async () => {
    const fake = fakeExecutor();
    const store = postgresLivenessStore(fake.executor);
    const hostile = COMPONENT("sweeper'); DROP TABLE agent_ops.alerts_liveness_component;--");
    await store.watch(hostile, 60_000, 0);
    await store.beat(hostile, 1_000, { ran: "nothing-was-due" });
    await store.snapshot();

    for (const statement of fake.statements) {
      expect(statement, "a component identifier reached the statement text").not.toContain("DROP");
      expect(statement, "an identifier was interpolated").not.toContain("sweeper");
    }
    // And it round-tripped intact, so the binding is real rather than a filter.
    expect((await store.snapshot())[0]?.component).toBe(hostile);
  });

  it("issues no DELETE, no TRUNCATE and no DDL — a liveness record is never removed here", async () => {
    const fake = fakeExecutor();
    const store = postgresLivenessStore(fake.executor);
    await store.watch(COMPONENT("sweeper"), 60_000, 0);
    await store.beat(COMPONENT("sweeper"), 1_000, { ran: "did-work", itemsProcessed: 2 });
    await store.snapshot();

    for (const statement of fake.statements) {
      for (const forbidden of ["DELETE", "TRUNCATE", "DROP", "ALTER", "CREATE"]) {
        expect(statement, `issued a ${forbidden}`).not.toContain(forbidden);
      }
    }
    expect(fake.statements.map(tagOf)).toEqual(["watch", "beat", "snapshot"]);
  });

  it("opens no transaction: every verb is one statement, so the row lock is the critical section", async () => {
    let transactions = 0;
    const fake = fakeExecutor();
    const counting: SqlExecutor = {
      query: fake.executor.query,
      transaction: async (fn) => {
        transactions += 1;
        return fn(counting);
      },
    };
    const store = postgresLivenessStore(counting);
    await store.watch(COMPONENT("sweeper"), 60_000, 0);
    await store.beat(COMPONENT("sweeper"), 1_000, { ran: "nothing-was-due" });
    await store.snapshot();
    expect(transactions).toBe(0);
  });
});

// --- the restart, which is README item 2 itself ------------------------------

describe("alerts — beat history outlives the store object", () => {
  it("a watcher polling across a restart sees a real gap, not never-seen", async () => {
    // The table is the backing. The store objects are not.
    const table = new Map<string, FakeRow>();
    const clock = testClock(1_700_000_000_000);

    // --- before the restart ---
    {
      const store = postgresLivenessStore(fakeExecutor(table).executor);
      await store.watch(COMPONENT("sweeper"), 60_000, clock.now());
      const heartbeat = createHeartbeat({ store, clock });
      await heartbeat.beat({ component: COMPONENT("sweeper"), run: { ran: "nothing-was-due" } });
      clock.advance(60_000);
      await heartbeat.beat({
        component: COMPONENT("sweeper"),
        run: { ran: "did-work", itemsProcessed: 9 },
      });
    }

    // --- the restart. Every reference to the old store is gone. ---
    const lastBeatAt = clock.now();
    clock.advance(3_600_000);

    const revived = postgresLivenessStore(fakeExecutor(table).executor);
    const query = livenessQuery({ store: revived });
    const records = await query.records();
    const findings = livenessFindings(records, clock.now(), { graceMs: 30_000 });
    const finding = findings[0];

    expect(finding?.status, "a restart must not read as never-seen").toBe("overdue");
    if (finding?.status !== "overdue") throw new Error("unreachable");
    expect(finding.lastSeenAt).toBe(lastBeatAt);
    expect(finding.overdueByMs).toBe(3_600_000 - 60_000 - 30_000);
    expect(finding.beats, "the history the finding exists to carry").toBe(2);
    expect(records[0]?.itemsProcessed).toBe(9);
    expect(records[0]?.sequence).toBe(2);
  });

  it("still says never-seen for a component that genuinely never beat", async () => {
    // The distinction is the whole product: `overdue` is a component that died,
    // `never-seen` is one that was deployed and never started, or a watcher
    // pointed at a name nothing emits. Item 2 was the first collapsing into the
    // second on every restart.
    const table = new Map<string, FakeRow>();
    const before = postgresLivenessStore(fakeExecutor(table).executor);
    await before.watch(COMPONENT("reconciler"), 60_000, 1_000);

    const after = postgresLivenessStore(fakeExecutor(table).executor);
    const findings = livenessFindings(await after.snapshot(), 1_000 + 600_000, { graceMs: 0 });
    expect(findings[0]?.status).toBe("never-seen");
  });
});

// --- named error modes -------------------------------------------------------

describe("alerts — every liveness store failure is a named mode with a policy", () => {
  it("refuses a beat from an unwatched component rather than creating a row", async () => {
    const fake = fakeExecutor();
    const store = postgresLivenessStore(fake.executor);
    await expect(
      store.beat(COMPONENT("ghost"), 1_000, { ran: "nothing-was-due" }),
    ).rejects.toBeInstanceOf(ComponentNotWatched);
    expect(fake.table.size).toBe(0);
  });

  it("keeps the stored cadence and names the conflict when a second caller disagrees", async () => {
    const store = postgresLivenessStore(fakeExecutor().executor);
    await store.watch(COMPONENT("sweeper"), 60_000, 0);
    await store.watch(COMPONENT("sweeper"), 60_000, 5_000);
    const error = await store.watch(COMPONENT("sweeper"), 3_600_000, 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LivenessTermsConflict);
    expect(error).toMatchObject({ watching: 60_000, offered: 3_600_000 });
    // A deploy cannot widen a detection window by asking twice.
    expect((await store.snapshot())[0]?.expectedEveryMs).toBe(60_000);
  });

  it("fails a read whole rather than returning an empty snapshot", async () => {
    // The reason this is fail-closed: `livenessFindings([], ...)` returns no
    // findings, and a watcher reads no findings as all-clear. A failed store
    // would then become silence that looks like health — the exact failure this
    // module exists to find, arriving through the module itself.
    const broken: SqlExecutor = {
      query: () => Promise.reject(new Error("connection terminated")),
      transaction: async (fn) => fn(broken),
    };
    const store = postgresLivenessStore(broken);
    const error = await store.snapshot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LivenessStoreUnavailable);
    expect(error).toMatchObject({ reason: "store-failure", degradable: false });
    expect((error as LivenessStoreUnavailable).cause).toBeInstanceOf(Error);
  });

  it("refuses a truncated snapshot: a short read is a blind spot, a refused read is an alert", async () => {
    const table = new Map<string, FakeRow>();
    const store = postgresLivenessStore(fakeExecutor(table).executor, { maxComponents: 2 });
    for (const name of ["a", "b", "c"]) await store.watch(COMPONENT(name), 60_000, 0);
    const error = await store.snapshot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LivenessStoreUnavailable);
    expect(error).toMatchObject({ reason: "capacity" });
  });

  it("sheds writes over the ceiling rather than queueing behind pool connections", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const table = new Map<string, FakeRow>();
    const fake = fakeExecutor(table);
    const slow: SqlExecutor = {
      query: async (text, params) => {
        if (tagOf(text) === "beat") await gate;
        return fake.executor.query(text, params);
      },
      transaction: async (fn) => fn(slow),
    };
    const store = postgresLivenessStore(slow, { maxPendingWrites: 2 });
    await store.watch(COMPONENT("sweeper"), 60_000, 0);

    const inFlight = [
      store.beat(COMPONENT("sweeper"), 1_000, { ran: "nothing-was-due" }),
      store.beat(COMPONENT("sweeper"), 1_001, { ran: "nothing-was-due" }),
    ];
    const shed = await store
      .beat(COMPONENT("sweeper"), 1_002, { ran: "nothing-was-due" })
      .catch((e: unknown) => e);
    expect(shed).toBeInstanceOf(LivenessStoreUnavailable);
    expect(shed).toMatchObject({ reason: "backpressure" });

    release?.();
    await Promise.all(inFlight);
    // The ceiling is released, not consumed: the next beat lands.
    await expect(
      store.beat(COMPONENT("sweeper"), 1_003, { ran: "nothing-was-due" }),
    ).resolves.toMatchObject({ beats: 3 });
  });

  it("refuses an undecodable row rather than skipping it or coercing it", async () => {
    // Skipping would silently unmonitor a watched component. Coercing would
    // fabricate a `lastSeen`, which reads as a live component.
    const corrupt: SqlExecutor = {
      query: (text) =>
        tagOf(text) === "snapshot"
          ? Promise.resolve({
              rows: [
                {
                  component: "sweeper",
                  expected_every_ms: "60000",
                  watching_since: "0",
                  beats: "3",
                  empty_beats: "3",
                  working_beats: "0",
                  items_processed: "0",
                  last_seen_at: "1000",
                  // The union, spelled the one way the schema forbids.
                  last_run_kind: "nothing-was-due",
                  last_run_items: "0",
                  sequence: "3",
                },
              ],
            })
          : Promise.resolve({ rows: [] }),
      transaction: async (fn) => fn(corrupt),
    };
    const error = await postgresLivenessStore(corrupt)
      .snapshot()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LivenessRecordCorrupt);
    expect(error).toMatchObject({ component: "sweeper", column: "last_run_items" });
  });

  it("refuses a beat count that is not a safe integer instead of letting it lie", async () => {
    const lying: SqlExecutor = {
      query: (text) =>
        tagOf(text) === "snapshot"
          ? Promise.resolve({
              rows: [
                {
                  component: "sweeper",
                  expected_every_ms: "60000",
                  watching_since: "0",
                  // Past 2^53. Number() would round it silently.
                  beats: "9007199254740993",
                  empty_beats: "0",
                  working_beats: "0",
                  items_processed: "0",
                  last_seen_at: "1000",
                  last_run_kind: "nothing-was-due",
                  last_run_items: null,
                  sequence: "1",
                },
              ],
            })
          : Promise.resolve({ rows: [] }),
      transaction: async (fn) => fn(lying),
    };
    await expect(postgresLivenessStore(lying).snapshot()).rejects.toBeInstanceOf(
      LivenessRecordCorrupt,
    );
  });

  it("treats an executor that resolves a refused upsert as a store failure, not as agreement", async () => {
    // Obligation 3 of `SqlExecutor`: a statement the database refuses rejects.
    // An upsert that resolves with no row would otherwise be read as "the stored
    // cadence equals the offered one", which invents agreement.
    const silent: SqlExecutor = {
      query: () => Promise.resolve({ rows: [] }),
      transaction: async (fn) => fn(silent),
    };
    const error = await postgresLivenessStore(silent)
      .watch(COMPONENT("sweeper"), 60_000, 0)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LivenessStoreUnavailable);
    expect(error).toMatchObject({ reason: "store-failure" });
  });

  it("rejects rather than throwing synchronously, so .catch() and Promise.all still work", async () => {
    const store = postgresLivenessStore(fakeExecutor().executor);
    // A fractional instant is refused; the refusal must be a rejection.
    let threw = false;
    let promise: Promise<unknown> | undefined;
    try {
      promise = store.beat(COMPONENT("sweeper"), 1.5, { ran: "nothing-was-due" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    await expect(promise).rejects.toBeInstanceOf(LivenessBeatUnrecordable);
  });
});

// --- the contract, over both shipped adapters --------------------------------

const inMemorySubject = (): LivenessStoreContractSubject => {
  let store = inMemoryLivenessStore();
  return {
    // The same object, because that is all this backing can offer — and the
    // contract's case 8 renames itself accordingly rather than claiming more.
    open: (): LivenessStore => store,
    reset: async () => {
      store = inMemoryLivenessStore();
    },
    durable: false,
  };
};

/**
 * A durable subject over the fake. `durable: true` is the honest claim here in
 * the narrow sense the contract means it: the backing (`table`) outlives the
 * adapter object, and `open()` returns a genuinely new adapter each call. It
 * says nothing about disks, and the note at the foot of this file says so.
 */
const fakePostgresSubject = (): LivenessStoreContractSubject => {
  let table = new Map<string, FakeRow>();
  return {
    open: (): LivenessStore => postgresLivenessStore(fakeExecutor(table).executor),
    reset: async () => {
      table = new Map<string, FakeRow>();
    },
    durable: true,
  };
};

describe("alerts — both shipped LivenessStore adapters satisfy the same contract", () => {
  it.each([
    ["inMemoryLivenessStore", inMemorySubject],
    ["postgresLivenessStore over a fake executor", fakePostgresSubject],
  ])("%s", async (_name, subject) => {
    const outcomes = await runLivenessStoreContract(subject());
    const failed = outcomes.filter((o) => !o.passed);
    expect(
      failed.map((o) => `${o.name}: ${String(o.error)}`).join("\n"),
      "contract violations",
    ).toBe("");
    expect(outcomes).toHaveLength(8);
  });

  it("reports the in-memory adapter's case 8 as the weaker claim it is", async () => {
    const outcomes = await runLivenessStoreContract(inMemorySubject());
    expect(outcomes[7]?.name).toContain("WEAK: this backing dies with the process");
    const durable = await runLivenessStoreContract(fakePostgresSubject());
    expect(durable[7]?.name).toContain("a restart sees a gap, not never-seen");
  });

  it("catches an adapter that loses the monotonic clamp", async () => {
    // The contract earns its keep only if it fails on a plausible mistake. This
    // is the mistake: last-seen taken from the beat rather than clamped, which
    // one host with a skewed clock turns into a live component reading overdue.
    const broken = (): LivenessStoreContractSubject => {
      const inner = inMemoryLivenessStore();
      let lastSeen = 0;
      const store = {
        watch: inner.watch.bind(inner),
        beat: async (...args: Parameters<LivenessStore["beat"]>) => {
          const record = await inner.beat(...args);
          lastSeen = args[1];
          return { ...record, lastSeen: { seen: "beat" as const, at: lastSeen } };
        },
        snapshot: inner.snapshot.bind(inner),
      } as unknown as LivenessStore;
      return { open: () => store, reset: async () => undefined, durable: false };
    };
    const outcomes = await runLivenessStoreContract(broken());
    const clamp = outcomes.find((o) => o.name.startsWith("4."));
    expect(clamp?.passed).toBe(false);
  });
});

/**
 * ## What this file does not prove, and where the other half is verified
 *
 * Everything above runs against a fake. It holds the adapter to the statements
 * it issues and to the obligations both shipped adapters share. It says nothing
 * about Postgres.
 *
 * The schema's own guarantees — the primary key on `component`, the `CHECK`
 * that stops a `nothing-was-due` row carrying an item count, the `GREATEST` /
 * `COALESCE` clamp evaluated by the server, the row lock that serialises two
 * beats in the same millisecond, and the `SELECT, INSERT, UPDATE` grant with no
 * `DELETE` — are verified by applying `migrations/0008_alerts_liveness.sql` to a
 * real database and running `runLivenessStoreContract` against a pool, from an
 * operational script. That is a five-minute job and `RUNBOOK.md` carries it.
 *
 * A green run of this file is evidence about the adapter's behaviour. It is
 * **not** evidence that a beat survives a process restart on a real cluster.
 */
