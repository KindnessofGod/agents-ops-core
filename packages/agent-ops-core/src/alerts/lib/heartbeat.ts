/**
 * Heartbeat: the emit side, the store, and the check.
 *
 * `docs/CONTEXT.md` is unambiguous about why this exists and about the exact
 * shape of the mistake it prevents:
 *
 * > *"The sweeper emits a heartbeat on every run, including runs with nothing to
 * > do — 'nothing was due' and 'I did not run' must not share a representation,
 * > for the same reason `not-attempted` and `unknown` do not."*
 *
 * That sentence is the whole design. A component that beats only when it did
 * work is **indistinguishable from a dead one on a quiet night**, which means
 * the monitoring is correct exactly when it does not matter and blind exactly
 * when it does. So:
 *
 *   - `HeartbeatRun` is a union. `nothing-was-due` carries no `itemsProcessed`
 *     field at all, so "I did nothing" cannot be spelled as "I did zero things"
 *     and later be read as a component processing empty batches.
 *   - "I did not run" is not a value in that union, and cannot be: it is the
 *     **absence** of a beat, which only something watching the clock can notice.
 *     That is `livenessFindings`.
 *   - A component must be `watch`ed before it may `beat`. A heartbeat nobody
 *     watches for is the silent failure this module exists to find, wearing the
 *     costume of monitoring. See `ComponentNotWatched`.
 *
 * And the part this module does **not** do is in `external-watchdog.ts`. Read it.
 */

import { ComponentNotWatched, LivenessTermsConflict } from "./errors.js";
import { asLivenessStore } from "./types.js";
import type {
  Alerts,
  BeatReceipt,
  Heartbeat,
  HeartbeatDeps,
  HeartbeatRun,
  LivenessCheck,
  LivenessCheckDeps,
  LivenessCheckReport,
  LivenessFinding,
  LivenessRecord,
  LivenessStore,
  LivenessTolerance,
} from "./types.js";
import type { AlertOutcome } from "./types.js";
import type { HeartbeatMissed, LastSeen } from "./conditions.js";
import type { ComponentId, DurationMs, Instant } from "./primitives.js";

/**
 * The shipped adapter.
 *
 * **One adapter, so this is a hypothetical seam by C5**, and that is reported
 * rather than dressed up: `postgresLivenessStore` is named and not built,
 * because it needs a migration that does not exist and a driver handle this
 * package may not construct.
 *
 * The limit that follows is real and is stated here rather than discovered:
 * with this adapter, beat history dies with the process. An external watcher
 * polling across a restart sees `never` rather than `beat`, which reads as "not
 * seen" and therefore alerts — the safe direction — but it is a false alarm
 * after every deploy until a durable adapter exists.
 *
 * **Correct under concurrent writers.** Every mutation below is one synchronous
 * block with no `await` inside it, so two beats landing in the same tick cannot
 * interleave; the sequence is store-assigned, exactly as `audit` assigns node
 * sequences; and `at` is clamped monotonic, so a beat arriving late or from a
 * host with a skewed clock can never move a component's last-seen backwards and
 * make a live component look overdue.
 */
export const inMemoryLivenessStore = (): LivenessStore => {
  interface Row {
    component: ComponentId;
    expectedEveryMs: DurationMs;
    watchingSince: Instant;
    beats: number;
    emptyBeats: number;
    workingBeats: number;
    itemsProcessed: number;
    lastSeen: LastSeen;
    lastRun: HeartbeatRun | undefined;
    sequence: number;
  }
  const rows = new Map<ComponentId, Row>();

  const snapshotOf = (row: Row): LivenessRecord => ({
    component: row.component,
    expectedEveryMs: row.expectedEveryMs,
    watchingSince: row.watchingSince,
    beats: row.beats,
    emptyBeats: row.emptyBeats,
    workingBeats: row.workingBeats,
    itemsProcessed: row.itemsProcessed,
    lastSeen: row.lastSeen,
    lastRun: row.lastRun,
    sequence: row.sequence,
  });

  return asLivenessStore({
    // `async` on purpose: a promise-returning method that throws SYNCHRONOUSLY
    // escapes `.catch()` and breaks `await Promise.all([...])` in a way that is
    // very hard to see. Every rejection out of this store is a rejection.
    async watch(component, expectedEveryMs, since) {
      const existing = rows.get(component);
      if (existing !== undefined) {
        // Idempotent on identical terms, loud on contradictory ones: two callers
        // disagreeing about a cadence means one is wrong about when it is
        // overdue, and quietly taking the later value lets a deploy widen a
        // detection window with nothing recorded.
        if (existing.expectedEveryMs !== expectedEveryMs) {
          throw new LivenessTermsConflict(component, existing.expectedEveryMs, expectedEveryMs);
        }
        return;
      }
      rows.set(component, {
        component,
        expectedEveryMs,
        watchingSince: since,
        beats: 0,
        emptyBeats: 0,
        workingBeats: 0,
        itemsProcessed: 0,
        lastSeen: { seen: "never", watchingSince: since },
        lastRun: undefined,
        sequence: 0,
      });
    },

    async beat(component, at, run) {
      const row = rows.get(component);
      if (row === undefined) throw new ComponentNotWatched(component);
      row.beats += 1;
      row.sequence += 1;
      if (run.ran === "did-work") {
        row.workingBeats += 1;
        row.itemsProcessed += run.itemsProcessed;
      } else {
        row.emptyBeats += 1;
      }
      const previous = row.lastSeen.seen === "beat" ? row.lastSeen.at : Number.NEGATIVE_INFINITY;
      row.lastSeen = { seen: "beat", at: at > previous ? at : previous };
      row.lastRun = run;
      return snapshotOf(row);
    },

    async snapshot() {
      return [...rows.values()].map(snapshotOf);
    },
  });
};

/**
 * The emit side. One verb, and it is deliberately not called `ping` or
 * `healthCheck`: those words describe something asking, and this is the
 * component telling.
 */
export const createHeartbeat = (deps: HeartbeatDeps): Heartbeat => ({
  async beat({ component, run }): Promise<BeatReceipt> {
    const at = deps.clock.now();
    const record = await deps.store.beat(component, at, run);
    return { component, at, run, sequence: record.sequence };
  },
});

/**
 * The checker: does a set of liveness records, read at an instant, say anything
 * is wrong?
 *
 * **Pure.** No clock, no store, no alerting — `now` is a parameter. That is what
 * makes the whole of liveness testable without waiting and, more importantly,
 * what makes this function safe for an *external* watcher to use: it can read
 * records out of a database, out of a metrics scrape, or off a wire, and get the
 * same verdict this library would give, without importing anything that could
 * be part of the failure.
 *
 * Three statuses, because "stopped" and "never started" are different problems:
 * one is a component that died, the other is a component that was deployed
 * without starting, or a watcher pointed at a name nothing emits. The second is
 * the one a deployment checklist misses, and collapsing it into the first is how
 * it stays missed.
 */
export const livenessFindings = (
  records: readonly LivenessRecord[],
  now: Instant,
  tolerance: LivenessTolerance,
): readonly LivenessFinding[] =>
  records.map((record): LivenessFinding => {
    const allowance = record.expectedEveryMs + tolerance.graceMs;
    if (record.lastSeen.seen === "never") {
      const waited = now - record.watchingSince;
      return {
        status: "never-seen",
        component: record.component,
        overdueByMs: Math.max(0, waited - allowance),
        expectedEveryMs: record.expectedEveryMs,
        watchingSince: record.watchingSince,
      };
    }
    const since = now - record.lastSeen.at;
    if (since > allowance) {
      return {
        status: "overdue",
        component: record.component,
        overdueByMs: since - allowance,
        expectedEveryMs: record.expectedEveryMs,
        lastSeenAt: record.lastSeen.at,
        beats: record.beats,
      };
    }
    return {
      status: "alive",
      component: record.component,
      sinceLastBeatMs: since,
      expectedEveryMs: record.expectedEveryMs,
      // A record with a beat always has a run; this default is unreachable and
      // exists so the type needs no assertion.
      lastRun: record.lastRun ?? { ran: "nothing-was-due" },
    };
  });

/**
 * Turn a finding into the condition, or `undefined` when the component is alive.
 *
 * Note that a `never-seen` component that is still inside its first expected
 * interval is **not** overdue: a component that was registered nine
 * milliseconds ago has not failed to beat yet, and alerting on it would make
 * every deploy page somebody, which is how a channel gets muted.
 */
export const heartbeatMissedFrom = (finding: LivenessFinding): HeartbeatMissed | undefined => {
  switch (finding.status) {
    case "alive":
      return undefined;
    case "overdue":
      return {
        kind: "heartbeat-missed",
        component: finding.component,
        expectedEveryMs: finding.expectedEveryMs,
        overdueByMs: finding.overdueByMs,
        lastSeen: { seen: "beat", at: finding.lastSeenAt },
        beatsObserved: finding.beats,
      };
    case "never-seen":
      return finding.overdueByMs <= 0
        ? undefined
        : {
            kind: "heartbeat-missed",
            component: finding.component,
            expectedEveryMs: finding.expectedEveryMs,
            overdueByMs: finding.overdueByMs,
            lastSeen: { seen: "never", watchingSince: finding.watchingSince },
            beatsObserved: 0,
          };
  }
};

/**
 * A liveness check that reads the store and — if an `Alerts` was wired — raises
 * `heartbeat-missed` for everything overdue or never seen.
 *
 * **Wiring this inside the process it watches is not monitoring.** It is useful
 * as a second line, and it is never the first. `external-watchdog.ts` says why
 * in the plainest terms available, and `RUNBOOK.md` is required to repeat it,
 * because it is the single deployment instruction most likely to be skipped and
 * the most expensive to have skipped.
 */
export const createLivenessCheck = (deps: LivenessCheckDeps): LivenessCheck => ({
  async check(): Promise<LivenessCheckReport> {
    const at = deps.clock.now();
    const records = await deps.store.snapshot();
    const findings = livenessFindings(records, at, deps.tolerance);
    const raised: HeartbeatMissed[] = [];
    const outcomes: AlertOutcome[] = [];
    const alerts: Alerts | undefined = deps.alerts;
    for (const finding of findings) {
      const condition = heartbeatMissedFrom(finding);
      if (condition === undefined) continue;
      raised.push(condition);
      // Sequential on purpose. A liveness check that fans out one raise per dead
      // component would, on the day a whole scheduler host dies, do precisely
      // what the bounds elsewhere in this module exist to prevent.
      if (alerts !== undefined) outcomes.push(await alerts.raise(condition));
    }
    return { at, findings, raised, outcomes };
  },
});
