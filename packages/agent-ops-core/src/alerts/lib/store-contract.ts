/**
 * The `LivenessStore` contract, as an executable suite.
 *
 * ## Why a seam with two adapters still needs this
 *
 * `LivenessStore` now has two real adapters — `inMemoryLivenessStore` and
 * `postgresLivenessStore` — and two adapters is what C5 calls a real seam. But
 * two adapters that quietly disagree are worse than one: an application tests
 * against the in-memory store, deploys against Postgres, and discovers on the
 * first restart that its monotonic clamp was only ever in the fast one.
 *
 * The obligations below are the *whole* interface in the sense `CLAUDE.md`
 * means — not the type signature, but the invariants, the ordering constraints
 * and the error modes a caller must know. They are shipped as a suite rather
 * than as a paragraph so that:
 *
 *   - **Both shipped adapters are held to them in continuous integration**, with
 *     no database, which is what stops the two drifting.
 *   - **A live Postgres run is a five-minute job**, from an operational script
 *     against a real pool. That run is the only thing that says anything about
 *     the schema's own guarantees — the primary key, the `CHECK` constraints,
 *     the grants — because no test in this package may open a socket.
 *   - **An application that writes its own adapter** (a different engine, a
 *     key-value store, a metrics backend) can hold it to the same bar without
 *     reading this module's source.
 *
 * Framework-free, exactly as `audit`'s `sqlExecutorContract` is: no test runner
 * is imported, because a contract only one runner can check is a contract only
 * one team can check. Each case is a name and an async function that throws.
 *
 * ## The obligations
 *
 *   1. **`watch` before `beat`.** A beat from an unwatched component raises
 *      `ComponentNotWatched`. A heartbeat nobody watches for is the silent
 *      failure this module exists to find, wearing the costume of monitoring.
 *   2. **`watch` is idempotent on identical terms and loud on contradictory
 *      ones** — `LivenessTermsConflict`, carrying the stored cadence and the
 *      offered one. The stored cadence wins; it is never overwritten.
 *   3. **The sequence is store-assigned and monotonic per component**,
 *      incremented inside the same critical section that writes.
 *   4. **`at` is clamped monotonic.** A beat arriving late, or from a host with a
 *      skewed clock, never moves a component's last-seen backwards.
 *   5. **Counters separate empty runs from working ones**, and `nothing-was-due`
 *      never acquires an item count. The `HeartbeatRun` union's shape survives
 *      the round trip: "I did nothing" cannot come back as "I did zero things".
 *   6. **A beat that cannot be recorded byte-stably is refused** —
 *      `LivenessBeatUnrecordable` — rather than rounded. A fractional instant
 *      makes the overdue comparison meaningless.
 *   7. **`snapshot` returns every watched component**, including ones that have
 *      never beaten, whose `lastSeen` is `never` and whose `watchingSince` is the
 *      instant `watch` was called. This is the obligation that makes
 *      `never-seen` distinguishable from `overdue` at all.
 *   8. **A record outlives the store object.** Build a second store over the same
 *      backing and the beats are still there. For the in-memory adapter this
 *      holds only within one process and the case says so; for a durable adapter
 *      it is the entire point, and it is the obligation that closes README item
 *      2 — a watcher polling across a restart must see a real gap rather than
 *      `never-seen`.
 *
 * ## What it cannot check, said plainly
 *
 * It checks the *adapter's* obligations. It does not check Postgres. A green
 * suite against `inMemoryLivenessStore` says the suite is satisfiable and that
 * the obligations are coherent; it says nothing whatsoever about grants,
 * constraints or durability. Only a run against a real cluster says anything
 * about those, and only `migrations/` and `RUNBOOK.md` say anything about the
 * grants.
 */

import {
  AlertError,
  ComponentNotWatched,
  LivenessBeatUnrecordable,
  LivenessTermsConflict,
} from "./errors.js";
import { livenessFindings } from "./heartbeat.js";
import type { LivenessRecord, LivenessStore } from "./types.js";
import type { ComponentId } from "./primitives.js";

/** Raised when a subject breaks the contract. Carries the case that found it. */
export class LivenessStoreContractViolation extends Error {
  override readonly name = "LivenessStoreContractViolation";
  constructor(
    readonly contractCase: string,
    detail: string,
  ) {
    super(`LivenessStore contract — ${contractCase}: ${detail}`);
  }
}

/**
 * What a subject supplies.
 *
 * `open()` rather than a store, because obligation 8 needs a **second store
 * object over the same backing** — that is what a process restart looks like
 * from inside a test, and it is the only way to ask whether the record outlived
 * anything. A subject over a pool returns a new adapter each call; a subject
 * over the in-memory adapter returns the same one, and the case is honest about
 * what that proves.
 */
export interface LivenessStoreContractSubject {
  /**
   * A store over the subject's backing. Called more than once per case; each
   * call must return a **fresh adapter object** reading the same records.
   */
  open(): Promise<LivenessStore> | LivenessStore;
  /** Empty the backing. Called before every case. */
  reset(): Promise<void>;
  /**
   * `true` where the backing outlives the adapter object — a database, a file, a
   * shared table. Where `false`, obligation 8 is checked in the weaker form the
   * in-memory adapter can actually satisfy, and the outcome says which was run.
   */
  readonly durable: boolean;
}

export interface LivenessStoreContractCase {
  readonly name: string;
  run(): Promise<void>;
}

export interface LivenessStoreContractOutcome {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: unknown;
}

const COMPONENT = (id: string): ComponentId => id as ComponentId;

const SWEEPER = COMPONENT("sweeper");
const RECONCILER = COMPONENT("reconciler");

/**
 * The name states exactly what the run proved, so a green outcome list cannot
 * be read as more than it is. A non-durable subject hands back the same adapter
 * object from `open()`, so the case checks that the records are consistent
 * across two references and nothing more — beat history still dies with the
 * process, and the name says so rather than a footnote nobody reads.
 */
const durabilityCaseName = (durable: boolean): string =>
  durable
    ? "8. the record outlives the store object: a restart sees a gap, not never-seen"
    : "8. a second reference sees the same beats (WEAK: this backing dies with the process)";

const fail = (name: string, detail: string): never => {
  throw new LivenessStoreContractViolation(name, detail);
};

const expect = (name: string, condition: boolean, detail: string): void => {
  if (!condition) fail(name, detail);
};

const only = (name: string, records: readonly LivenessRecord[], component: ComponentId) => {
  const record = records.find((r) => r.component === component);
  if (record === undefined) {
    return fail(name, `snapshot does not contain ${component}`);
  }
  return record;
};

/** Assert a rejection of a named class, and that it is a rejection rather than a throw. */
const rejectsWith = async (
  name: string,
  what: string,
  expected: new (...args: never[]) => AlertError,
  run: () => Promise<unknown>,
): Promise<AlertError> => {
  let promise: Promise<unknown>;
  try {
    promise = run();
  } catch (thrown) {
    return fail(
      name,
      `${what} threw synchronously; a promise-returning method that throws synchronously escapes ` +
        `.catch() and breaks await Promise.all([...]) — every rejection must be a rejection ` +
        `(${String(thrown)})`,
    );
  }
  try {
    await promise;
  } catch (error) {
    if (error instanceof expected) return error;
    return fail(name, `${what} rejected with ${String(error)}, expected ${expected.name}`);
  }
  return fail(name, `${what} resolved; expected ${expected.name}`);
};

/**
 * Build the suite for one subject. Nothing runs until a case is called, so a
 * caller may filter, reorder, or drive them from whatever runner it has.
 */
export const livenessStoreContract = (
  subject: LivenessStoreContractSubject,
): readonly LivenessStoreContractCase[] => {
  const fresh = async (): Promise<LivenessStore> => subject.open();

  const cases: LivenessStoreContractCase[] = [
    {
      name: "1. a beat from an unwatched component is refused",
      async run() {
        const store = await fresh();
        await rejectsWith(
          "1. a beat from an unwatched component is refused",
          "beat before watch",
          ComponentNotWatched,
          () => store.beat(SWEEPER, 1_000, { ran: "nothing-was-due" }),
        );
      },
    },
    {
      name: "2. watch is idempotent on identical terms and loud on contradictory ones",
      async run() {
        const name = "2. watch is idempotent on identical terms and loud on contradictory ones";
        const store = await fresh();
        await store.watch(SWEEPER, 60_000, 1_000);
        await store.watch(SWEEPER, 60_000, 9_999);
        const conflict = await rejectsWith(name, "watch at a different cadence", LivenessTermsConflict, () =>
          store.watch(SWEEPER, 30_000, 2_000),
        );
        expect(
          name,
          conflict instanceof LivenessTermsConflict &&
            conflict.watching === 60_000 &&
            conflict.offered === 30_000,
          `conflict must carry the stored cadence and the offered one, got ${String(conflict)}`,
        );
        const records = await store.snapshot();
        const record = only(name, records, SWEEPER);
        expect(name, record.expectedEveryMs === 60_000, "the stored cadence was overwritten");
        expect(
          name,
          record.watchingSince === 1_000,
          `watchingSince moved to ${record.watchingSince}; the first watch owns it`,
        );
        expect(name, records.length === 1, `idempotent watch created ${records.length} rows`);
      },
    },
    {
      name: "3. the sequence is store-assigned and monotonic per component",
      async run() {
        const name = "3. the sequence is store-assigned and monotonic per component";
        const store = await fresh();
        await store.watch(SWEEPER, 60_000, 0);
        await store.watch(RECONCILER, 60_000, 0);
        const first = await store.beat(SWEEPER, 1_000, { ran: "nothing-was-due" });
        const second = await store.beat(SWEEPER, 2_000, { ran: "did-work", itemsProcessed: 3 });
        const other = await store.beat(RECONCILER, 3_000, { ran: "nothing-was-due" });
        expect(name, first.sequence === 1, `first sequence was ${first.sequence}, expected 1`);
        expect(name, second.sequence === 2, `second sequence was ${second.sequence}, expected 2`);
        expect(
          name,
          other.sequence === 1,
          `the sequence is per component; reconciler's first was ${other.sequence}`,
        );
      },
    },
    {
      name: "4. a late or skewed beat never moves last-seen backwards",
      async run() {
        const name = "4. a late or skewed beat never moves last-seen backwards";
        const store = await fresh();
        await store.watch(SWEEPER, 60_000, 0);
        await store.beat(SWEEPER, 10_000, { ran: "nothing-was-due" });
        const late = await store.beat(SWEEPER, 4_000, { ran: "nothing-was-due" });
        expect(
          name,
          late.lastSeen.seen === "beat" && late.lastSeen.at === 10_000,
          `a beat from 4000 moved last-seen to ${JSON.stringify(late.lastSeen)}; a host with a ` +
            `skewed clock would make a live component look overdue`,
        );
        expect(name, late.beats === 2, `the late beat was not counted (beats=${late.beats})`);
      },
    },
    {
      name: "5. empty runs and working runs are counted apart, and the union survives the round trip",
      async run() {
        const name =
          "5. empty runs and working runs are counted apart, and the union survives the round trip";
        const store = await fresh();
        await store.watch(SWEEPER, 60_000, 0);
        await store.beat(SWEEPER, 1_000, { ran: "nothing-was-due" });
        await store.beat(SWEEPER, 2_000, { ran: "did-work", itemsProcessed: 7 });
        await store.beat(SWEEPER, 3_000, { ran: "did-work", itemsProcessed: 5 });
        const record = only(name, await (await fresh()).snapshot(), SWEEPER);
        expect(name, record.beats === 3, `beats=${record.beats}, expected 3`);
        expect(name, record.emptyBeats === 1, `emptyBeats=${record.emptyBeats}, expected 1`);
        expect(name, record.workingBeats === 2, `workingBeats=${record.workingBeats}, expected 2`);
        expect(
          name,
          record.itemsProcessed === 12,
          `itemsProcessed=${record.itemsProcessed}, expected 12`,
        );
        expect(
          name,
          record.lastRun?.ran === "did-work" && record.lastRun.itemsProcessed === 5,
          `lastRun did not round-trip: ${JSON.stringify(record.lastRun)}`,
        );

        // The half that matters: an empty run must come back with NO item count.
        await store.beat(SWEEPER, 4_000, { ran: "nothing-was-due" });
        const after = only(name, await (await fresh()).snapshot(), SWEEPER);
        expect(
          name,
          after.lastRun?.ran === "nothing-was-due" &&
            !Object.prototype.hasOwnProperty.call(after.lastRun, "itemsProcessed"),
          `nothing-was-due came back as ${JSON.stringify(after.lastRun)}; "I did nothing" must ` +
            `not be spelled "I did zero things"`,
        );
        expect(
          name,
          after.itemsProcessed === 12,
          `an empty run changed the running total to ${after.itemsProcessed}`,
        );
      },
    },
    {
      name: "6. a beat that cannot be recorded byte-stably is refused, not rounded",
      async run() {
        const name = "6. a beat that cannot be recorded byte-stably is refused, not rounded";
        const store = await fresh();
        await store.watch(SWEEPER, 60_000, 0);
        await rejectsWith(name, "a fractional instant", LivenessBeatUnrecordable, () =>
          store.beat(SWEEPER, 1_000.5, { ran: "nothing-was-due" }),
        );
        await rejectsWith(name, "a fractional item count", LivenessBeatUnrecordable, () =>
          store.beat(SWEEPER, 1_000, { ran: "did-work", itemsProcessed: 1.5 }),
        );
        await rejectsWith(name, "a NaN instant", LivenessBeatUnrecordable, () =>
          store.beat(SWEEPER, Number.NaN, { ran: "nothing-was-due" }),
        );
        await rejectsWith(name, "a non-positive cadence", LivenessBeatUnrecordable, () =>
          store.watch(COMPONENT("bad-cadence"), 0, 0),
        );
        const record = only(name, await store.snapshot(), SWEEPER);
        expect(name, record.beats === 0, `a refused beat was recorded anyway (beats=${record.beats})`);
      },
    },
    {
      name: "7. snapshot returns a watched component that has never beaten",
      async run() {
        const name = "7. snapshot returns a watched component that has never beaten";
        const store = await fresh();
        await store.watch(SWEEPER, 60_000, 5_000);
        const record = only(name, await store.snapshot(), SWEEPER);
        expect(
          name,
          record.lastSeen.seen === "never" && record.lastSeen.watchingSince === 5_000,
          `a never-beaten component came back as ${JSON.stringify(record.lastSeen)}`,
        );
        expect(name, record.lastRun === undefined, "a never-beaten component has no last run");
        const findings = livenessFindings([record], 5_000 + 60_000 + 60_000, { graceMs: 0 });
        expect(
          name,
          findings[0]?.status === "never-seen",
          `expected never-seen, got ${findings[0]?.status}`,
        );
      },
    },
    {
      name: durabilityCaseName(subject.durable),
      async run() {
        const name = durabilityCaseName(subject.durable);
        const before = await fresh();
        await before.watch(SWEEPER, 60_000, 0);
        await before.beat(SWEEPER, 1_000, { ran: "nothing-was-due" });
        await before.beat(SWEEPER, 2_000, { ran: "did-work", itemsProcessed: 4 });

        // The restart. Every reference to the old adapter is dropped; the next
        // line builds a new one over the same backing, which is exactly what a
        // redeployed process does.
        const after = await fresh();
        const record = only(name, await after.snapshot(), SWEEPER);
        expect(
          name,
          record.lastSeen.seen === "beat" && record.lastSeen.at === 2_000,
          `after a restart the store reports ${JSON.stringify(record.lastSeen)}; a watcher would ` +
            `read never-seen and could not tell a death from a deploy`,
        );
        expect(name, record.beats === 2, `beat history did not survive (beats=${record.beats})`);
        expect(name, record.sequence === 2, `sequence did not survive (sequence=${record.sequence})`);

        // The verdict an external watcher would reach, an hour later.
        const findings = livenessFindings([record], 2_000 + 3_600_000, { graceMs: 30_000 });
        const finding = findings[0];
        expect(
          name,
          finding?.status === "overdue",
          `expected overdue, got ${finding?.status} — this is README item 2 exactly`,
        );
        expect(
          name,
          finding?.status === "overdue" && finding.lastSeenAt === 2_000 && finding.beats === 2,
          `the overdue finding lost the history it exists to carry: ${JSON.stringify(finding)}`,
        );
      },
    },
  ];

  return cases;
};

/**
 * Run every case, resetting before each, and return one outcome per case.
 *
 * Deliberately does not throw on the first failure: an application running this
 * against its own adapter wants the whole list, and a suite that stops at the
 * first problem is a suite people run once.
 */
export const runLivenessStoreContract = async (
  subject: LivenessStoreContractSubject,
): Promise<readonly LivenessStoreContractOutcome[]> => {
  const outcomes: LivenessStoreContractOutcome[] = [];
  for (const contractCase of livenessStoreContract(subject)) {
    await subject.reset();
    try {
      await contractCase.run();
      outcomes.push({ name: contractCase.name, passed: true });
    } catch (error) {
      outcomes.push({ name: contractCase.name, passed: false, error });
    }
  }
  return outcomes;
};
