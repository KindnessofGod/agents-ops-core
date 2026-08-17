import { describe, expect, it } from "vitest";
import {
  EXTERNAL_WATCHDOG_REQUIREMENT,
  createHeartbeat,
  heartbeatMissedFrom,
  inMemoryLivenessStore,
  livenessFindings,
  livenessQuery,
  severityOf,
} from "../index.js";
import { COMPONENT, conditions, harness, testClock, throwingSink } from "./fixtures.js";

/**
 * Requirement (e): the watchdog is external, and the module must say so loudly.
 *
 * A watchdog depending on the thing it watches fails silently exactly when it is
 * needed. So what is tested here is that this module exports **what an external
 * watcher needs** — a liveness record shape and a query — and that it does not
 * pretend to be the watcher.
 *
 * The test that would prove the negative does not exist and cannot: nothing in a
 * test suite can demonstrate that this library will not notice its own death,
 * because the suite dies with it. That is the point, and it is why the
 * requirement is carried as an exported sentence `RUNBOOK.md` must repeat rather
 * than as a clever assertion.
 */

const sweeper = COMPONENT("sweeper");
const tolerance = { graceMs: 30_000 };

describe("what an external watcher is given", () => {
  it("is a pull, not a push: two plain reads with no subscription", async () => {
    const h = harness();
    const store = inMemoryLivenessStore();
    const query = livenessQuery({ store, alerts: h.alerts });

    // A watcher that had to be CALLED BACK would depend on this process being
    // alive enough to call it, which is the defect the file exists to prevent.
    expect(Object.keys(query).sort()).toEqual(["alerting", "records"]);
    expect(await query.records()).toEqual([]);
    expect(query.alerting()?.raised).toBe(0);
  });

  it("hands over records a watcher can judge with its OWN clock", async () => {
    const clock = testClock();
    const store = inMemoryLivenessStore();
    const heartbeat = createHeartbeat({ store, clock });
    await store.watch(sweeper, 60_000, clock.now());
    await heartbeat.beat({ component: sweeper, run: { ran: "nothing-was-due" } });

    const records = await livenessQuery({ store }).records();

    // The verdict is deliberately NOT in the query. A component whose host clock
    // has jumped is precisely the case where asking that host whether it is late
    // gives the wrong answer.
    const watcherOwnNow = clock.now() + 600_000;
    const [finding] = livenessFindings(records, watcherOwnNow, tolerance);
    expect(finding?.status).toBe("overdue");
    expect(severityOf(heartbeatMissedFrom(finding!)!)).toBe("liveness-lost");
  });

  it("reports the alerting's own health, so a watcher can see the chain failing", async () => {
    const h = harness({
      sinks: [throwingSink("sink_a", () => new Error("down"))],
    });
    const query = livenessQuery({ store: inMemoryLivenessStore(), alerts: h.alerts });

    await h.alerts.raise(conditions.effectUnknown("c_watch"));

    const health = query.alerting();
    // This is where the regress stops. An alert about the alerting being down
    // cannot be delivered by the alerting that is down; it is published here and
    // read from outside.
    expect(health?.undelivered).toBe(1);
    expect(health?.degradations).toBe(1);
    expect(health?.ledger[0]?.reason).toBe("every-sink-failed");
  });

  it("says `undefined` rather than `healthy` when no alerting was wired", () => {
    const query = livenessQuery({ store: inMemoryLivenessStore() });
    // A watcher receiving `undefined` should treat the alerting path as
    // UNOBSERVED, not as fine. The two are not the same and the type says so.
    expect(query.alerting()).toBeUndefined();
  });
});

describe("the module does not pretend to be the watcher", () => {
  it("exports no watcher, no timer loop and no scheduler", async () => {
    const surface = await import("../index.js");
    const names = Object.keys(surface);
    for (const forbidden of ["startWatchdog", "watch", "monitor", "runForever", "scheduleChecks"]) {
      expect(names).not.toContain(forbidden);
    }
    // What it does export is the emit side, the verdict, and the query.
    expect(names).toContain("createHeartbeat");
    expect(names).toContain("livenessFindings");
    expect(names).toContain("livenessQuery");
  });

  it("carries the runbook sentence in code, so the two cannot drift", () => {
    expect(EXTERNAL_WATCHDOG_REQUIREMENT).toContain("outside this process");
    expect(EXTERNAL_WATCHDOG_REQUIREMENT).toContain("cannot notice its own death");
    expect(EXTERNAL_WATCHDOG_REQUIREMENT).toContain("telephones");
  });

  it("shows what an in-process check cannot do: it needs something to run it", async () => {
    const h = harness();
    const store = inMemoryLivenessStore();
    await store.watch(sweeper, 60_000, h.clock.now());
    h.clock.advance(600_000);

    // Nothing here calls `check()` on its own. There is no timer inside this
    // module that would, and that absence is the design: a check that ran itself
    // would stop running at exactly the moment the process it lives in died.
    const query = livenessQuery({ store, alerts: h.alerts });
    const findings = livenessFindings(await query.records(), h.clock.now(), tolerance);
    expect(findings[0]?.status).toBe("never-seen");
    expect(h.recorder.delivered).toHaveLength(0);
  });
});

describe("a missed heartbeat still emits with no case to attach it to", () => {
  it("delivers, and records that there was no correlation identifier", async () => {
    const h = harness();
    const result = await h.alerts.raise(conditions.heartbeatMissed("sweeper"));

    expect(result.outcome).toBe("delivered");
    if (result.outcome !== "delivered") return;
    // Requirement (g): where no correlation identifier exists, the alert still
    // emits. It simply cannot be a node on a trace it has no place in.
    expect(result.journal).toEqual({ journalled: false, why: "no-correlation-identifier" });
    expect(h.journal?.entries).toHaveLength(0);
    expect(h.recorder.delivered).toHaveLength(1);
  });
});
