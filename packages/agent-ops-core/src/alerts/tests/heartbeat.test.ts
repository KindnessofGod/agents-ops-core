import { describe, expect, it } from "vitest";
import {
  ComponentNotWatched,
  LivenessTermsConflict,
  createHeartbeat,
  createLivenessCheck,
  heartbeatMissedFrom,
  inMemoryLivenessStore,
  livenessFindings,
} from "../index.js";
import { COMPONENT, harness, testClock } from "./fixtures.js";

/**
 * Requirement (d): a component proves liveness on every run **including empty
 * ones**, and "nothing was due" and "I did not run" must not share a
 * representation.
 *
 * `docs/CONTEXT.md` gives the reason in one line: the sweeper is the single
 * point of failure for the whole recurrence guarantee. If it stops, nobody is
 * chased, nothing throws, and every waiting case rots silently — the system
 * doing precisely what reserved decisions exist to prevent, while reporting no
 * problem.
 */

const sweeper = COMPONENT("sweeper");
const reconciler = COMPONENT("reconciler");
const tolerance = { graceMs: 30_000 };

const wired = () => {
  const clock = testClock();
  const store = inMemoryLivenessStore();
  const heartbeat = createHeartbeat({ store, clock });
  return { clock, store, heartbeat };
};

describe("an empty run is a run", () => {
  it("records 'nothing was due' as a beat, counted separately from work", async () => {
    const { clock, store, heartbeat } = wired();
    await store.watch(sweeper, 60_000, clock.now());

    await heartbeat.beat({ component: sweeper, run: { ran: "nothing-was-due" } });
    clock.advance(60_000);
    await heartbeat.beat({ component: sweeper, run: { ran: "did-work", itemsProcessed: 3 } });

    const [record] = await store.snapshot();
    expect(record?.beats).toBe(2);
    expect(record?.emptyBeats).toBe(1);
    expect(record?.workingBeats).toBe(1);
    expect(record?.itemsProcessed).toBe(3);
  });

  it("keeps a quiet component alive: a sweeper with nothing to do is not dead", async () => {
    const { clock, store, heartbeat } = wired();
    await store.watch(sweeper, 60_000, clock.now());

    for (let i = 0; i < 100; i += 1) {
      await heartbeat.beat({ component: sweeper, run: { ran: "nothing-was-due" } });
      clock.advance(60_000);
    }

    const findings = livenessFindings(await store.snapshot(), clock.now(), tolerance);
    expect(findings[0]?.status).toBe("alive");
  });

  it("cannot spell 'I did nothing' as 'I did zero things'", async () => {
    const { clock, store, heartbeat } = wired();
    await store.watch(sweeper, 60_000, clock.now());
    await heartbeat.beat({ component: sweeper, run: { ran: "nothing-was-due" } });

    const [record] = await store.snapshot();
    // The union has no itemsProcessed on the empty branch, so an empty run and a
    // batch of zero are different values rather than the same one read twice.
    expect(record?.lastRun).toEqual({ ran: "nothing-was-due" });
    expect(record?.lastRun).not.toHaveProperty("itemsProcessed");
  });

  it("distinguishes 'I did not run' by its ABSENCE, which only a checker sees", async () => {
    const { clock, store, heartbeat } = wired();
    await store.watch(sweeper, 60_000, clock.now());
    await heartbeat.beat({ component: sweeper, run: { ran: "nothing-was-due" } });

    clock.advance(600_000); // ten minutes of saying nothing at all

    const [finding] = livenessFindings(await store.snapshot(), clock.now(), tolerance);
    expect(finding?.status).toBe("overdue");
  });
});

describe("a heartbeat nobody watches for is refused", () => {
  it("throws ComponentNotWatched rather than accepting a beat into the void", async () => {
    const { heartbeat } = wired();
    // A beat nobody watches produces the FEELING of liveness monitoring while
    // the component's death stays invisible. That is a silent failure inside the
    // machinery whose whole job is finding silent failures.
    await expect(
      heartbeat.beat({ component: sweeper, run: { ran: "nothing-was-due" } }),
    ).rejects.toBeInstanceOf(ComponentNotWatched);
  });

  it("is idempotent on identical terms and loud on contradictory ones", async () => {
    const { clock, store } = wired();
    await store.watch(sweeper, 60_000, clock.now());
    await expect(store.watch(sweeper, 60_000, clock.now())).resolves.toBeUndefined();
    // Silently taking the later value would let a deploy widen a two-minute
    // detection window to an hour with nothing recorded and nobody asked.
    await expect(store.watch(sweeper, 3_600_000, clock.now())).rejects.toBeInstanceOf(
      LivenessTermsConflict,
    );
  });
});

describe("the store is correct under concurrent writers and a skewed clock", () => {
  it("assigns a monotonic sequence with no duplicates under a concurrent burst", async () => {
    const { clock, store } = wired();
    await store.watch(sweeper, 60_000, clock.now());

    const records = await Promise.all(
      Array.from({ length: 64 }, () =>
        store.beat(sweeper, clock.now(), { ran: "did-work", itemsProcessed: 1 }),
      ),
    );

    const sequences = records.map((r) => r.sequence);
    expect(new Set(sequences).size).toBe(64);
    expect(Math.max(...sequences)).toBe(64);
    const [final] = await store.snapshot();
    expect(final?.beats).toBe(64);
    expect(final?.itemsProcessed).toBe(64);
  });

  it("never moves last-seen backwards, so a late or skewed beat cannot fake death", async () => {
    const { clock, store } = wired();
    const start = clock.now();
    await store.watch(sweeper, 60_000, start);
    await store.beat(sweeper, start + 100_000, { ran: "nothing-was-due" });
    // A beat from a host whose clock is behind, arriving after a fresher one.
    const after = await store.beat(sweeper, start - 500_000, { ran: "nothing-was-due" });

    expect(after.lastSeen).toEqual({ seen: "beat", at: start + 100_000 });
  });
});

describe("the checker judges records against an injected clock", () => {
  it("calls a component alive inside its cadence plus grace", async () => {
    const { clock, store, heartbeat } = wired();
    await store.watch(sweeper, 60_000, clock.now());
    await heartbeat.beat({ component: sweeper, run: { ran: "did-work", itemsProcessed: 2 } });

    clock.advance(89_999);
    expect(livenessFindings(await store.snapshot(), clock.now(), tolerance)[0]?.status).toBe("alive");
    clock.advance(2);
    expect(livenessFindings(await store.snapshot(), clock.now(), tolerance)[0]?.status).toBe(
      "overdue",
    );
  });

  it("reports how late, so an operator can tell a blip from a death", async () => {
    const { clock, store, heartbeat } = wired();
    await store.watch(sweeper, 60_000, clock.now());
    await heartbeat.beat({ component: sweeper, run: { ran: "nothing-was-due" } });
    clock.advance(600_000);

    const [finding] = livenessFindings(await store.snapshot(), clock.now(), tolerance);
    expect(finding).toMatchObject({
      status: "overdue",
      component: "sweeper",
      overdueByMs: 600_000 - 90_000,
      expectedEveryMs: 60_000,
      beats: 1,
    });
  });

  it("separates 'never started' from 'stopped'", async () => {
    const { clock, store } = wired();
    await store.watch(reconciler, 60_000, clock.now());
    clock.advance(600_000);

    const [finding] = livenessFindings(await store.snapshot(), clock.now(), tolerance);
    // A component deployed and never started, or a watcher pointed at a name
    // nothing emits, is a different problem with a different fix. Collapsing it
    // into "stopped" is how it stays missed on a deployment checklist.
    expect(finding?.status).toBe("never-seen");
  });

  it("does not call a just-registered component overdue", async () => {
    const { clock, store } = wired();
    await store.watch(sweeper, 60_000, clock.now());
    clock.advance(9);

    const [finding] = livenessFindings(await store.snapshot(), clock.now(), tolerance);
    expect(finding?.status).toBe("never-seen");
    // Alerting on it would page somebody on every deploy, which is how a channel
    // gets muted — the recurrence-cadence failure, one level up.
    expect(heartbeatMissedFrom(finding!)).toBeUndefined();
  });

  it("is pure: same records, same instant, same verdict, no clock of its own", async () => {
    const { clock, store, heartbeat } = wired();
    await store.watch(sweeper, 60_000, clock.now());
    await heartbeat.beat({ component: sweeper, run: { ran: "nothing-was-due" } });
    const records = await store.snapshot();
    const at = clock.now() + 500_000;

    expect(livenessFindings(records, at, tolerance)).toEqual(livenessFindings(records, at, tolerance));
  });
});

describe("createLivenessCheck raises what is overdue, at the top severity", () => {
  it("raises heartbeat-missed for each dead component and nothing for the live ones", async () => {
    const h = harness();
    const store = inMemoryLivenessStore();
    const heartbeat = createHeartbeat({ store, clock: h.clock });
    await store.watch(sweeper, 60_000, h.clock.now());
    await store.watch(reconciler, 60_000, h.clock.now());
    await heartbeat.beat({ component: sweeper, run: { ran: "nothing-was-due" } });
    await heartbeat.beat({ component: reconciler, run: { ran: "nothing-was-due" } });

    h.clock.advance(600_000);
    await heartbeat.beat({ component: reconciler, run: { ran: "nothing-was-due" } });

    const check = createLivenessCheck({
      store,
      clock: h.clock,
      tolerance,
      alerts: h.alerts,
    });
    const report = await check.check();

    expect(report.raised.map((c) => c.component)).toEqual(["sweeper"]);
    expect(h.recorder.delivered).toHaveLength(1);
    expect(h.recorder.delivered[0]?.severity).toBe("liveness-lost");
    expect(h.recorder.delivered[0]?.correlationId).toBeUndefined();
  });

  it("is usable with no alerting at all, for a watcher that has its own", async () => {
    const clock = testClock();
    const store = inMemoryLivenessStore();
    await store.watch(sweeper, 60_000, clock.now());
    clock.advance(600_000);

    const report = await createLivenessCheck({ store, clock, tolerance }).check();

    expect(report.findings[0]?.status).toBe("never-seen");
    expect(report.raised).toHaveLength(1);
    expect(report.outcomes).toHaveLength(0);
  });

  it("does not fan out one raise per dead component", async () => {
    // The day a whole scheduler host dies, every component is overdue at once.
    // A check that fanned out would do precisely what the bounds exist to stop.
    const h = harness({ limits: { maxInFlightDeliveries: 1, maxQueuedRaises: 1 } });
    const store = inMemoryLivenessStore();
    for (let i = 0; i < 20; i += 1) await store.watch(COMPONENT(`c_${i}`), 60_000, h.clock.now());
    h.clock.advance(600_000);

    const report = await createLivenessCheck({
      store,
      clock: h.clock,
      tolerance,
      alerts: h.alerts,
    }).check();

    expect(report.raised).toHaveLength(20);
    expect(report.outcomes.every((o) => o.outcome === "delivered")).toBe(true);
    expect(h.alerts.health().inFlightHighWater).toBe(1);
  });
});
