import { describe, expect, it } from "vitest";
import { LadderCadenceTooTight, type AuthorityId } from "../index.js";
import {
  CASE,
  POOL,
  alwaysReserved,
  harness,
  human,
  ladder,
  neverReserved,
  tierBy,
} from "./fixtures/harness.js";
import { INVOICE, gatedDisbursement } from "./fixtures/points.js";
import { compileFixture } from "./typecheck.js";

/**
 * Slice 3 — ageing. A reserved decision must get louder over time, never
 * quieter, and it must never get quiet at all.
 *
 * The failure this exists to prevent is not a wrong answer. It is a case that
 * simply stops: no error, no red dashboard, no queue entry growing old. Not
 * resolved, not honestly contained, and invisible — the dangerous quadrant
 * reached by a path nobody designed.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const setup = (reserved = false, over: Parameters<typeof gatedDisbursement>[0] = {}) => {
  const point = gatedDisbursement(over);
  return harness({
    points: [point],
    tierPolicy: tierBy({ disburse: "high" }),
    reservedPolicy: reserved ? alwaysReserved() : neverReserved(),
    evidence: { [INVOICE.id]: { matched: true } },
    members: [
      human("auth_jane"),
      human("auth_deputy", "deputy"),
      human("auth_manager", "line-manager"),
      human("auth_exec", "accountable-executive"),
    ],
  });
};

const suspendOne = async (h: ReturnType<typeof setup>, id: string, over = {}) => {
  const result = await h.approval.run(gatedDisbursement(over), INVOICE, {
    correlationId: CASE(id),
  });
  if (result.kind !== "suspended") throw new Error("expected a suspension");
  return result;
};

describe("ladder — the type cannot express giving up", () => {
  it("has no stop value and no maximum attempt count to declare", () => {
    // Proved by the compiler, not asserted: the fixture's `@ts-expect-error` on
    // a ladder with no recurrence compiles clean only because the field is
    // mandatory. There is no `stop`, no `until` and no `maxAttempts` in the
    // type to reach for in the first place.
    expect(compileFixture("capability-rejected.ts")).toEqual([]);
  });

  it("refuses a recurrence tighter than the configured floor", async () => {
    const tight = ladder({ recurrence: { every: 60_000, widenTo: [{ kind: "pool", pool: POOL }] } });
    const h = setup(false, { ladder: tight });

    // A recurrence that speeds up floods a channel, the channel gets muted, and
    // the case becomes LESS likely to be answered than if nothing had been
    // sent. Persistence is the goal; frequency is not.
    await expect(
      h.approval.run(gatedDisbursement({ ladder: tight }), INVOICE, {
        correlationId: CASE("l0"),
      }),
    ).rejects.toBeInstanceOf(LadderCadenceTooTight);
  });
});

describe("ladder — scheduled steps, then a recurrence that never stops", () => {
  it("fires each scheduled step once, in order, and records every one", async () => {
    const h = setup();
    await suspendOne(h, "l1");

    await h.approval.sweep({ limit: 10 });
    expect(h.renderer.reminders).toHaveLength(0); // nothing is due yet

    h.clock.advance(4 * HOUR);
    await h.approval.sweep({ limit: 10 });
    h.clock.advance(20 * HOUR);
    await h.approval.sweep({ limit: 10 });

    expect(h.renderer.reminders.map((r) => r.reminder.phase)).toEqual(["step", "step"]);
    expect(h.renderer.reminders.map((r) => r.reminder.ordinal)).toEqual([1, 2]);

    const nodes = (await h.audit.replay(CASE("l1"))).nodes;
    const fired = nodes.filter((n) => n.payload["kind"] === "ladder.reminder");
    // "We chased them" is evidence, not an assertion.
    expect(fired).toHaveLength(2);
    expect(fired[0]?.payload["action"]).toBe("notify");
    expect(fired[1]?.payload["action"]).toBe("escalate");
  });

  it("keeps a constant cadence across many cycles — it never accelerates", async () => {
    const h = setup();
    await suspendOne(h, "l2");

    h.clock.advance(24 * HOUR);
    const firedAt: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const before = h.renderer.reminders.length;
      await h.approval.sweep({ limit: 10 });
      if (h.renderer.reminders.length > before) firedAt.push(h.clock.now());
      h.clock.advance(DAY);
    }

    const gaps = firedAt.slice(1).map((t, i) => t - (firedAt[i] ?? 0));
    // Every interval identical. There is no field in `Recurrence` that could
    // make this shrink over time.
    expect(new Set(gaps)).toEqual(new Set([DAY]));
    expect(firedAt.length).toBeGreaterThan(8);
  });

  it("widens the audience each cycle instead of raising the volume", async () => {
    const h = setup();
    await suspendOne(h, "l3");

    // Spend the two scheduled steps first.
    h.clock.advance(4 * HOUR);
    await h.approval.sweep({ limit: 10 });
    h.clock.advance(20 * HOUR);
    await h.approval.sweep({ limit: 10 });

    const audiences: number[] = [];
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      h.clock.advance(DAY);
      const before = h.renderer.reminders.length;
      await h.approval.sweep({ limit: 10 });
      const sent = h.renderer.reminders[before];
      if (sent !== undefined) audiences.push(sent.to.length);
    }

    // deputy, then + line manager, then + accountable executive, then held at
    // the full set. The fifteenth reminder to a person who has ignored fourteen
    // is not a plan; reaching someone who CAN answer is.
    expect(audiences).toEqual([1, 2, 3, 3]);
  });

  it("records the crossing into recurrence as an incident, and keeps chasing", async () => {
    const h = setup(true);
    await suspendOne(h, "l4");

    h.clock.advance(4 * HOUR);
    await h.approval.sweep({ limit: 10 });
    h.clock.advance(20 * HOUR);
    await h.approval.sweep({ limit: 10 });
    h.clock.advance(DAY);
    await h.approval.sweep({ limit: 10 });

    const nodes = (await h.audit.replay(CASE("l4"))).nodes;
    const buried = nodes.find((n) => n.payload["kind"] === "approval.buried");
    expect(buried?.payload["incident"]).toBe(true);
    // Buried does NOT mean the chasing stopped.
    expect(buried?.payload["stillAnswerable"]).toBe(true);
    expect(h.renderer.reminders.filter((r) => r.reminder.phase === "recurrence")).toHaveLength(1);

    // ... and it is still answerable, months later.
    for (let i = 0; i < 60; i += 1) {
      h.clock.advance(DAY);
      await h.approval.sweep({ limit: 10 });
    }
    const record = await h.store.loadSuspension((await suspendOne(h, "l4")).suspension);
    expect(record?.state).toBe("awaiting");
  });

  it("retries delivery rather than advancing past a reminder that never arrived", async () => {
    const h = setup();
    await suspendOne(h, "l5");
    h.clock.advance(4 * HOUR);

    h.renderer.failNextRemind();
    await h.approval.sweep({ limit: 10 });
    expect(h.renderer.reminders).toHaveLength(0);

    // Failing to chase is not a reason to stop chasing: the position did not
    // advance, so the next sweep tries the same step again.
    await h.approval.sweep({ limit: 10 });
    expect(h.renderer.reminders.map((r) => r.reminder.ordinal)).toEqual([1]);

    const kinds = (await h.audit.replay(CASE("l5"))).nodes.map((n) => n.payload["kind"]);
    expect(kinds).toContain("ladder.reminder-undeliverable");
  });
});

describe("ladder — expiry exists only for a decision that is not reserved", () => {
  it("expires a non-reserved case into a refusal, never into an effect", async () => {
    const h = setup(false, { expireAfter: 72 * HOUR });
    const suspended = await suspendOne(h, "l6", { expireAfter: 72 * HOUR });
    expect(suspended.expiresAt).not.toBeNull();

    h.clock.advance(73 * HOUR);
    const report = await h.approval.sweep({ limit: 10 });

    expect(report.expired).toBe(1);
    const record = await h.store.loadSuspension(suspended.suspension);
    expect(record?.state).toBe("expired");
    expect(h.writes).toEqual([]);

    const expiredNode = (await h.audit.replay(CASE("l6"))).nodes.find(
      (n) => n.payload["kind"] === "ladder.expired",
    );
    // There is no "approve" arm on an expiry settlement, so this is not a
    // policy choice — it is the only value the type can hold.
    expect(expiredNode?.payload["settlement"]).toBe("refuse");
    expect(expiredNode?.payload["licensedEffect"]).toBe(false);
  });
});

describe("ladder — awaiting is never terminal and never contained", () => {
  it("reports a suspension rather than a settlement, with no way to await it", async () => {
    const h = setup();
    const suspended = await suspendOne(h, "l7");

    // `Suspended` carries no verdict, no outcome and no promise of one. There
    // is nothing on this value to await, which is what makes `await approve()`
    // unwritable rather than merely discouraged.
    expect(suspended.kind).toBe("suspended");
    expect("verdict" in suspended).toBe(false);
    expect("then" in suspended).toBe(false);
    expect("authorityTransferred" in suspended).toBe(false);
    expect(typeof (suspended as unknown as Record<string, unknown>)["wait"]).toBe("undefined");
  });

  it("names the widened audience from the declaration, not from a default", async () => {
    const h = setup();
    await suspendOne(h, "l8");
    const widened = ladder().recurrence.widenTo.map((r) =>
      r.kind === "authority" ? r.id : ("pool" as AuthorityId),
    );
    expect(widened).toHaveLength(3);
  });
});
