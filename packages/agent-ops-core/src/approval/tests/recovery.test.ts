import { describe, expect, it } from "vitest";
import {
  ApprovalOverloaded,
  type ApprovalStore,
  type KillSwitchState,
  type SuspensionRecord,
} from "../index.js";
import type { NodeId } from "../../audit/index.js";
import { CASE, harness, human, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, gatedDisbursement } from "./fixtures/points.js";

/**
 * The three dead ends this module reported against itself, and the bound it did
 * not have.
 *
 * 1. **A kill-switch hold was terminal.** The switch stops effects without
 *    stopping decisions, and it is engaged during an incident and disengaged
 *    after it — but a case answered while it was on settled into `held` and was
 *    never looked at again. Nothing errored. Every dashboard stayed green. That
 *    is the dangerous quadrant of `CONTEXT.md` reached by a path nobody
 *    designed: not resolved, not honestly contained, and invisible.
 * 2. **`licenceValidFor` was recorded and never read at the point of use.** A
 *    field that is written onto a node and compared to nothing reads as a
 *    control and is decoration.
 * 3. **A suspension and its trace node do not share a transaction.** They
 *    cannot — see `reconcile` — so the gap is made findable instead of silent.
 * 4. **Nothing bounded how many invocations were in flight at once.**
 */

const point = gatedDisbursement({ dualControlAtOrAbove: "never" });

const base = {
  points: [point],
  tierPolicy: tierBy({ disburse: "high" }),
  reservedPolicy: neverReserved(),
  evidence: { [INVOICE.id]: { matched: true } },
  members: [human("auth_jane"), human("auth_ravi")],
};

const DAY = 24 * 3_600_000;

describe("a kill-switch hold is resumable, not a grave", () => {
  it("returns the case to an approver once the switch is off, and asks again", async () => {
    let state: KillSwitchState = {
      engaged: true,
      scope: "all-effects",
      by: "ops",
      at: 1_700_000_000_000,
    };
    const h = harness({ ...base, killSwitch: async () => state });

    const suspended = await h.approval.run(point, INVOICE, { correlationId: CASE("k1") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    const held = await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked, during the incident" },
      { authority: human("auth_jane") },
    );
    expect(held.kind).toBe("held");
    expect(h.writes).toEqual([]);

    // The hold is durable AND still has a due time. Before this, the record was
    // terminal and no sweeper would ever look at it again.
    const during = await h.store.loadSuspension(suspended.suspension);
    expect(during?.state).toBe("held");
    expect(during?.nextDueAt).toBe(h.clock.now() + DAY);

    // Still engaged a day later: recorded as a fact, and pushed out by the
    // ladder's own interval rather than re-read every second.
    h.clock.advance(DAY);
    const stillHeld = await h.approval.sweep({ limit: 10 });
    expect(stillHeld.holdsReleased).toBe(0);
    expect((await h.store.loadSuspension(suspended.suspension))?.state).toBe("held");

    // The incident ends.
    state = { engaged: false };
    h.clock.advance(DAY);
    const released = await h.approval.sweep({ limit: 10 });
    expect(released.holdsReleased).toBe(1);

    const after = await h.store.loadSuspension(suspended.suspension);
    expect(after?.state).toBe("awaiting");
    expect(after?.seat).toBe("first");
    // The pre-incident approval is void. A fresh one licenses the effect, or
    // nothing does — and nothing was paid on release.
    expect(after?.finalAnswer).toBeNull();
    expect(after?.firstAnswer).toBeNull();
    expect(h.writes).toEqual([]);

    // And somebody was told. A case returned to the queue that nobody knows
    // about is the silent failure this module exists to prevent.
    expect(h.renderer.presented).toHaveLength(2);
    expect(after?.offeredTo.length).toBeGreaterThan(0);

    const kinds = (await h.audit.replay(CASE("k1"))).nodes.map((n) => String(n.payload["kind"]));
    expect(kinds).toContain("approval.hold-continues");
    expect(kinds).toContain("approval.hold-released");

    // Answered again, after the incident, it pays exactly once.
    const settled = await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "re-checked after the incident" },
      { authority: human("auth_jane") },
    );
    expect(settled.kind).toBe("executed");
    expect(h.writes).toHaveLength(1);
  });

  it("never releases a hold on a switch it could not read", async () => {
    let readable = false;
    const h = harness({
      ...base,
      killSwitch: async () => {
        if (!readable) throw new Error("consul quorum lost");
        return { engaged: false };
      },
    });
    const suspended = await h.approval.run(point, INVOICE, { correlationId: CASE("k2") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");
    const held = await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );
    expect(held.kind).toBe("held");
    if (held.kind !== "held") return;
    expect(held.reason).toBe("kill-switch-unreadable");

    // Fail-closed: an unreadable switch is treated as engaged, so a hold is
    // never released on a guess.
    h.clock.advance(DAY);
    expect((await h.approval.sweep({ limit: 10 })).holdsReleased).toBe(0);
    const stuck = (await h.audit.replay(CASE("k2"))).nodes.find(
      (n) => n.payload["kind"] === "approval.hold-continues",
    );
    expect(stuck?.payload["readable"]).toBe(false);

    readable = true;
    h.clock.advance(DAY);
    expect((await h.approval.sweep({ limit: 10 })).holdsReleased).toBe(1);
  });

  it("reads the switch once per sweep, not once per held case", async () => {
    let reads = 0;
    const h = harness({
      ...base,
      points: [point, gatedDisbursement({ id: "invoices.disburse_other" })],
      killSwitch: async () => {
        reads += 1;
        return { engaged: true, scope: "all", by: "ops", at: 1 };
      },
    });

    for (const id of ["k3a", "k3b", "k3c"]) {
      const suspended = await h.approval.run(point, INVOICE, { correlationId: CASE(id) });
      if (suspended.kind !== "suspended") throw new Error("expected a suspension");
      await h.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "checked" },
        { authority: human("auth_jane") },
      );
    }

    reads = 0;
    h.clock.advance(DAY);
    const report = await h.approval.sweep({ limit: 10 });
    expect(report.examined).toBe(3);
    // Three held cases, one read. A batch of two hundred during an incident
    // must not be two hundred reads of the control plane having the incident.
    expect(reads).toBe(1);
  });
});

describe("a licence is checked at the instant it is used, not only before", () => {
  it("withholds the effect when the approvals went stale between the check and the call", async () => {
    const h = harness(base);
    const suspended = await h.approval.run(point, INVOICE, { correlationId: CASE("l1") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    // A store whose settlement write is slow enough to outlive the licence.
    // Contrived in its timing and not in its shape: `answer` checks the licence,
    // then commits the settlement, then reads the kill switch, then claims the
    // key, and every one of those is a round trip to something that can stall.
    let armed = false;
    const slow: ApprovalStore = {
      ...h.store,
      swapSuspension: async (id, revision, next: SuspensionRecord) => {
        if (armed) {
          armed = false;
          h.clock.advance(25 * 3_600_000); // licenceValidFor is 24 hours
        }
        return h.store.swapSuspension(id, revision, next);
      },
    };
    const runtime = h.restart({ store: slow });
    armed = true;

    const settled = await runtime.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    // Withheld, not paid, and not thrown: `held` is resumable, so a stale
    // licence returns the case to an approver rather than ending it.
    expect(settled.kind).toBe("held");
    if (settled.kind !== "held") return;
    expect(settled.reason).toBe("licence-expired");
    expect(runtime.writes).toEqual([]);

    const expiry = (await runtime.audit.replay(CASE("l1"))).nodes.find(
      (n) => n.payload["kind"] === "approval.licence-expired",
    );
    expect(expiry?.payload["checkedAt"]).toBe("execute");
    expect(expiry?.payload["effectAttempted"]).toBe(false);
    // No claim was taken, so there is nothing in doubt and nothing to reconcile.
    expect(await runtime.approval.inDoubt()).toEqual([]);
  });

  it("mints and uses a licence normally when the approvals are fresh", async () => {
    const h = harness(base);
    const suspended = await h.approval.run(point, INVOICE, { correlationId: CASE("l2") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");
    const settled = await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );
    expect(settled.kind).toBe("executed");
    const minted = (await h.audit.replay(CASE("l2"))).nodes.find(
      (n) => n.payload["kind"] === "approval.licence-minted",
    );
    expect(minted?.payload["validForMs"]).toBe(24 * 3_600_000);
  });
});

describe("the suspension and its trace node cannot share a transaction, so they are compared", () => {
  it("finds a recorded intent to suspend that never became durable, and names the recovery", async () => {
    const h = harness(base);
    // The crash window, modelled exactly: the trace node was written and the
    // durable row was not.
    const lossy: ApprovalStore = { ...h.store, saveSuspension: async () => undefined };
    const runtime = h.restart({ store: lossy });

    const suspended = await runtime.approval.run(point, INVOICE, { correlationId: CASE("x1") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");
    // Nothing threw. `run` returned an identifier nobody can answer and no
    // sweeper will ever see, and that is precisely why this is not detectable
    // by catching exceptions.
    expect(await runtime.store.loadSuspension(suspended.suspension)).toBeUndefined();
    expect((await runtime.approval.sweep({ limit: 10 })).examined).toBe(0);

    const report = await runtime.approval.reconcile({ cases: [CASE("x1")] });
    expect(report.examined).toBe(1);
    expect(report.compared).toBe(1);
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]).toMatchObject({
      kind: "trace-without-suspension",
      correlationId: CASE("x1"),
      suspension: suspended.suspension,
      pointId: "invoices.disburse_payment",
      recovery: "re-run",
    });

    // The finding is itself evidence, on the case it belongs to.
    const divergence = (await runtime.audit.replay(CASE("x1"))).nodes.find(
      (n) => n.payload["kind"] === "approval.link-divergence",
    );
    expect(divergence?.payload["divergence"]).toBe("trace-without-suspension");
    expect(divergence?.payload["incident"]).toBe(true);

    // And the named recovery works. `run` is idempotent per case, point and
    // payload, so re-running recreates the lost suspension without asking a
    // second person the same question.
    const repaired = h.restart();
    const again = await repaired.approval.run(point, INVOICE, { correlationId: CASE("x1") });
    expect(again.kind).toBe("suspended");
    expect((await repaired.approval.reconcile({ cases: [CASE("x1")] })).divergences).toEqual([]);
  });

  it("finds a durable suspension whose trace node is missing, and repairs the parentage", async () => {
    const h = harness(base);
    const phantom = "case-that-never-was#99" as NodeId;
    const bent: ApprovalStore = {
      ...h.store,
      saveSuspension: async (record: SuspensionRecord) =>
        h.store.saveSuspension({ ...record, suspendNode: phantom }),
    };
    const runtime = h.restart({ store: bent });

    const suspended = await runtime.approval.run(point, INVOICE, { correlationId: CASE("x2") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");
    expect((await runtime.store.loadSuspension(suspended.suspension))?.suspendNode).toBe(phantom);

    const report = await runtime.approval.reconcile({ cases: [CASE("x2")] });
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]).toMatchObject({
      kind: "suspension-without-trace",
      suspension: suspended.suspension,
      node: phantom,
      recovery: "repaired",
    });

    // Repaired, not rewritten: a node was added — the only edit an append-only
    // archive permits — and the record now points at it, so later nodes are
    // parented again.
    const replayed = await runtime.audit.replay(CASE("x2"));
    const repaired = await runtime.store.loadSuspension(suspended.suspension);
    expect(repaired?.suspendNode).not.toBe(phantom);
    expect(replayed.nodes.some((n) => n.id === repaired?.suspendNode)).toBe(true);
    expect((await runtime.approval.reconcile({ cases: [CASE("x2")] })).divergences).toEqual([]);
  });

  it("reports a case it could not read rather than counting it as agreeing", async () => {
    const h = harness(base);
    const report = await h.approval.reconcile({ cases: [CASE("x3-never-existed")] });
    expect(report.divergences).toEqual([]);
    // "We could not look" and "we looked and everything agreed" are different
    // facts, and a reconciliation that collapses them is a green dashboard for
    // an unread archive.
    expect(report.unreadable).toEqual([CASE("x3-never-existed")]);
  });

  it("says nothing is wrong when nothing is wrong, and stays bounded", async () => {
    const h = harness({ ...base, limits: { reconcileBatch: 2 } });
    for (const id of ["x4a", "x4b", "x4c"]) {
      await h.approval.run(point, INVOICE, { correlationId: CASE(id) });
    }
    const report = await h.approval.reconcile({
      cases: [CASE("x4a"), CASE("x4b"), CASE("x4c")],
    });
    // Bounded per pass. Never "reconcile everything".
    expect(report.examined).toBe(2);
    expect(report.compared).toBe(2);
    expect(report.divergences).toEqual([]);
  });
});

describe("bounded concurrency — invocations in flight are a resource", () => {
  it("sheds an invocation over the ceiling before anything is started", async () => {
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = gatedDisbursement({ dualControlAtOrAbove: "never" });
    const blocking = {
      ...slow,
      spec: {
        ...slow.spec,
        decide: async (client: never, invoice: never) => {
          await barrier;
          return slow.spec.decide(client, invoice);
        },
      },
    } as typeof slow;

    const h = harness({
      ...base,
      points: [blocking],
      limits: { maxInFlight: 1 },
      evidence: { [INVOICE.id]: { matched: true } },
    });

    const first = h.approval.run(blocking, INVOICE, { correlationId: CASE("o1") });
    await expect(
      h.approval.run(blocking, INVOICE, { correlationId: CASE("o2") }),
    ).rejects.toBeInstanceOf(ApprovalOverloaded);

    // Shed before anything started: no trace, no decision, no claim, nothing to
    // reconcile. The caller retries and loses nothing but time.
    await expect(h.audit.replay(CASE("o2"))).rejects.toThrow();

    release();
    expect((await first).kind).toBe("suspended");

    // And the ceiling is not a latch: the next call goes through.
    const after = await h.approval.run(blocking, INVOICE, { correlationId: CASE("o3") });
    expect(after.kind).toBe("suspended");
  });
});
