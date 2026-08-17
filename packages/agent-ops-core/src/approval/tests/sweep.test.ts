import { describe, expect, it } from "vitest";
import { CASE, harness, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, gatedDisbursement } from "./fixtures/points.js";

/**
 * Slice 5 — `sweep` as an honest fourth entry point.
 *
 * Something has to drive time. Every durable-suspension system needs it, and
 * hiding it inside another verb does not remove it — it just makes the module
 * lie about how many entry points it has.
 *
 * Bounded, leased, idempotent, re-entrant, and it records its own nodes.
 */

const HOUR = 3_600_000;

const setup = (over: Parameters<typeof harness>[0]["limits"] = {}) =>
  harness({
    points: [gatedDisbursement()],
    tierPolicy: tierBy({ disburse: "high" }),
    reservedPolicy: neverReserved(),
    evidence: { [INVOICE.id]: { matched: true } },
    limits: over,
  });

const suspend = async (h: ReturnType<typeof setup>, id: string) => {
  const r = await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE(id) });
  if (r.kind !== "suspended") throw new Error("expected a suspension");
  return r;
};

describe("sweep — bounded", () => {
  it("never processes more than the batch it was asked for", async () => {
    const h = setup();
    for (let i = 0; i < 7; i += 1) await suspend(h, `w${i}`);
    h.clock.advance(5 * HOUR);

    const report = await h.approval.sweep({ limit: 3 });
    expect(report.examined).toBe(3);
    expect(report.remindersSent).toBe(3);
  });

  it("caps the caller's request at the configured ceiling", async () => {
    const h = setup({ sweepBatch: 2 });
    for (let i = 0; i < 6; i += 1) await suspend(h, `x${i}`);
    h.clock.advance(5 * HOUR);

    // "Process everything due" is not expressible: the module's own bound wins.
    const report = await h.approval.sweep({ limit: 1_000_000 });
    expect(report.examined).toBe(2);
  });
});

describe("sweep — idempotent and re-entrant", () => {
  it("sending a reminder twice at the same instant is not possible", async () => {
    const h = setup();
    await suspend(h, "w-idem");
    h.clock.advance(5 * HOUR);

    await h.approval.sweep({ limit: 10 });
    await h.approval.sweep({ limit: 10 });
    await h.approval.sweep({ limit: 10 });

    expect(h.renderer.reminders).toHaveLength(1);
  });

  it("is safe for two sweepers at once — the loser skips rather than duplicating", async () => {
    const a = setup();
    const suspended = await suspend(a, "w-race");
    a.clock.advance(5 * HOUR);

    // A second sweeper, over the SAME durable stores. This is the deploy case,
    // not the exceptional one.
    const b = a.restart({ sweeperId: "sweeper-b" });
    const held = await a.store.acquireLease(
      suspended.suspension,
      "sweeper-b",
      a.clock.now(),
      a.clock.now() + 5 * 60_000,
    );
    expect(held).toBe(true);

    const report = await a.approval.sweep({ limit: 10 });
    expect(report.skippedLeased).toBe(1);
    expect(report.remindersSent).toBe(0);
    expect(a.renderer.reminders).toHaveLength(0);
    expect(b.approval).toBeDefined();
  });

  it("does not freeze a case when the sweeper that claimed it dies", async () => {
    const h = setup({ sweepLeaseMs: 60_000 });
    const suspended = await suspend(h, "w-dead");
    h.clock.advance(5 * HOUR);

    // A sweeper claims it and never comes back.
    await h.store.acquireLease(suspended.suspension, "ghost", h.clock.now(), h.clock.now() + 60_000);
    expect((await h.approval.sweep({ limit: 10 })).skippedLeased).toBe(1);

    // The lease has a TTL, so the case comes back on its own.
    h.clock.advance(61_000);
    expect((await h.approval.sweep({ limit: 10 })).remindersSent).toBe(1);
  });
});

describe("sweep — it records its own nodes", () => {
  it("writes a visit node on the case it touched, parented on the suspension", async () => {
    const h = setup();
    const suspended = await suspend(h, "w-nodes");
    h.clock.advance(5 * HOUR);

    const report = await h.approval.sweep({ limit: 10 });
    expect(report.nodes).toHaveLength(1);

    const replayed = await h.audit.replay(CASE("w-nodes"));
    const visit = replayed.nodes.find((n) => n.payload["kind"] === "sweep.visited");
    expect(visit?.parent).toBe(suspended.node);
    expect(visit?.payload["sweeper"]).toBe("sweeper-a");
    expect(visit?.payload["awaitingForMs"]).toBe(5 * HOUR);

    // A ladder step firing is a recorded fact with a parent, like anything else.
    const reminder = replayed.nodes.find((n) => n.payload["kind"] === "ladder.reminder");
    expect(reminder?.parent).toBe(visit?.id);
  });

  it("uses the injected clock, so eleven days of ageing takes no time at all", async () => {
    const h = setup();
    await suspend(h, "w-clock");
    h.clock.advance(11 * 24 * HOUR);

    const report = await h.approval.sweep({ limit: 10 });
    const reminder = h.renderer.reminders[0];
    expect(report.remindersSent).toBe(1);
    expect(reminder?.reminder.awaitingForMs).toBe(11 * 24 * HOUR);
  });
});
