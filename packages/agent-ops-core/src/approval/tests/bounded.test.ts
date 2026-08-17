import { describe, expect, it } from "vitest";
import { inMemoryTraceStore, type TraceStore } from "../../audit/index.js";
import { CASE, harness, human, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, gatedDisbursement } from "./fixtures/points.js";

/**
 * Rework slice D — the two things that were unbounded.
 *
 * 1. The ladder flooded the channel after sweeper downtime: `nextDueAt` was
 *    computed from `awaitingSince` and never from when a reminder was last
 *    actually delivered, so every catch-up sweep popped one more already-due
 *    cycle. Thirty days down, then forty sweeps at one clock instant, produced
 *    thirty-one reminders at a single millisecond — escalating through deputy,
 *    line manager and accountable executive in one breath.
 *
 * 2. Every sweep visit built a fresh recorder, missed its parent and replayed
 *    the entire case trace, for up to two hundred cases per invocation, forever.
 */

const base = {
  points: [gatedDisbursement()],
  tierPolicy: tierBy({ disburse: "high" }),
  reservedPolicy: neverReserved(),
  evidence: { [INVOICE.id]: { matched: true } },
  members: [human("auth_jane"), human("auth_ravi")],
};

describe("ladder — the cadence never accelerates, even catching up", () => {
  it("delivers one reminder per instant after a month of sweeper downtime", async () => {
    const h = harness(base);
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("d1") });

    // The sweeper was down for thirty days. It comes back and is run forty
    // times in one millisecond, which is what a restart loop looks like.
    h.clock.advance(30 * 24 * 3_600_000);
    for (let i = 0; i < 40; i += 1) await h.approval.sweep({ limit: 10 });

    expect(h.renderer.reminders).toHaveLength(1);
    const [only] = h.renderer.reminders;
    expect(only?.reminder.phase).toBe("step");
    expect(only?.reminder.ordinal).toBe(1);

    // And it resumes at the DECLARED interval from the reminder that was
    // really delivered — the gap the ladder itself names between step 1 and
    // step 2 is twenty hours.
    h.clock.advance(20 * 3_600_000 - 1);
    await h.approval.sweep({ limit: 10 });
    expect(h.renderer.reminders).toHaveLength(1);
    h.clock.advance(1);
    await h.approval.sweep({ limit: 10 });
    expect(h.renderer.reminders).toHaveLength(2);
    expect(h.renderer.reminders[1]?.reminder.ordinal).toBe(2);
  });

  it("does not skip past anyone: the audience still widens one cycle at a time", async () => {
    const h = harness(base);
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("d2") });

    h.clock.advance(30 * 24 * 3_600_000);
    for (let i = 0; i < 5; i += 1) {
      await h.approval.sweep({ limit: 10 });
      h.clock.advance(30 * 24 * 3_600_000);
    }
    const phases = h.renderer.reminders.map((r) => `${r.reminder.phase}${r.reminder.ordinal}`);
    expect(phases).toEqual(["step1", "step2", "recurrence1", "recurrence2", "recurrence3"]);
  });

  it("still follows a declared schedule exactly when the sweeper is healthy", async () => {
    const h = harness(base);
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("d3") });

    h.clock.advance(4 * 3_600_000);
    await h.approval.sweep({ limit: 10 });
    h.clock.advance(20 * 3_600_000);
    await h.approval.sweep({ limit: 10 });
    expect(h.renderer.reminders.map((r) => r.reminder.ordinal)).toEqual([1, 2]);
  });
});

describe("sweep — the parent index is shared and bounded", () => {
  it("replays a case once, not once per sweep visit", async () => {
    let reads = 0;
    const inner = inMemoryTraceStore();
    const counting: TraceStore = {
      openCase: (id, provenance) => inner.openCase(id, provenance),
      append: (input) => inner.append(input),
      closeCase: (id, at, outcome) => inner.closeCase(id, at, outcome),
      read: (id) => {
        reads += 1;
        return inner.read(id);
      },
    };
    const h = harness({ ...base, traceStore: counting });
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("d4") });

    reads = 0;
    for (let i = 0; i < 12; i += 1) {
      h.clock.advance(48 * 3_600_000);
      await h.approval.sweep({ limit: 10 });
    }
    expect(h.renderer.reminders.length).toBeGreaterThanOrEqual(10);
    // One rehydration for the whole run of sweeps, not one per visit. Before
    // the fix this was twelve full trace replays, and it grew with the trace.
    expect(reads).toBeLessThanOrEqual(1);
  });
});
