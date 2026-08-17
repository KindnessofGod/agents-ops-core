import { describe, expect, it } from "vitest";
import {
  EffectAlreadyInFlight,
  IdempotencyIndeterminate,
  SuspensionRaceLost,
  type ApprovalStore,
  type EffectOutcome,
  type SuspensionRecord,
} from "../index.js";
import { CASE, harness, human, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, delegatedDisbursement, gatedDisbursement } from "./fixtures/points.js";

/**
 * Rework slice B — the order in which state and money change, and what a
 * concurrent writer sees.
 *
 * The defect these were written against: `answer` executed the effect and
 * *then* compare-and-set the suspension, holding a revision read before the
 * kill-switch read, the idempotency claim and the whole outbound payment. A
 * concurrent sweeper bumping the revision meant money moved, `SuspensionRaceLost`
 * reached the caller, the suspension stayed `awaiting`, the next sweep reminded
 * approvers about an already-paid case, and a second authority could answer it
 * and receive `executed` — two complete authorisation chains for one payment.
 */

/** Let every pending microtask in the in-memory adapters drain. */
const settle = async (turns = 400): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

const gated = (options: Parameters<typeof gatedDisbursement>[0] = {}) =>
  gatedDisbursement({ dualControlAtOrAbove: "never", ...options });

const setup = (point = gated()) =>
  harness({
    points: [point],
    tierPolicy: tierBy({ disburse: "high", small: "low" }),
    reservedPolicy: neverReserved(),
    evidence: { [INVOICE.id]: { matched: true } },
    members: [human("auth_jane"), human("auth_ravi")],
  });

describe("answer — the settlement commits before the effect, never after", () => {
  it("has already left `awaiting` by the time the executor runs", async () => {
    let stateDuringExecute: string | undefined;
    const h = setup();
    const point = gated({
      execute: async (licence, client, payload) => {
        stateDuringExecute = (await h.store.loadSuspension(suspensionId))?.state;
        await client.write({
          kind: "ledger.debit",
          idempotencyKey: licence.idempotencyKey,
          payload: { amountMinor: payload.amountMinor },
        });
        return { kind: "done", reference: "pay_1" };
      },
    });
    const runtime = h.restart({ points: [point] });

    const first = await runtime.approval.run(point, INVOICE, { correlationId: CASE("b1") });
    if (first.kind !== "suspended") throw new Error("expected a suspension");
    const suspensionId = first.suspension;

    await runtime.approval.answer(
      suspensionId,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    // Not `awaiting`. No sweeper will touch it and no second `answer` can
    // reach the effect, so the payment happens with the race already resolved.
    expect(stateDuringExecute).toBe("answered");
    expect(runtime.writes).toHaveLength(1);
    expect((await runtime.store.loadSuspension(suspensionId))?.state).toBe("executed");
  });

  it("raises a lost race with no money moved", async () => {
    const h = setup();
    const first = await h.approval.run(gated(), INVOICE, { correlationId: CASE("b2") });
    if (first.kind !== "suspended") throw new Error("expected a suspension");

    // A store whose very next compare-and-set loses, standing in for a
    // concurrent sweeper that bumped the revision.
    let armed = true;
    const racing: ApprovalStore = {
      ...h.store,
      swapSuspension: async (id, revision, next: SuspensionRecord) => {
        if (armed) {
          armed = false;
          return false;
        }
        return h.store.swapSuspension(id, revision, next);
      },
    };
    const runtime = h.restart({ store: racing });

    await expect(
      runtime.approval.answer(
        first.suspension,
        { choice: "approve", reason: "checked" },
        { authority: human("auth_jane") },
      ),
    ).rejects.toBeInstanceOf(SuspensionRaceLost);

    // The error documents itself as safe to retry. That is only true because
    // nothing moved.
    expect(h.writes).toEqual([]);
    expect((await h.store.loadSuspension(first.suspension))?.state).toBe("awaiting");
  });
});

describe("run — a settled suspension is reported as settled", () => {
  it("reports a refusal rather than claiming a human is still needed", async () => {
    const h = setup();
    const point = gated();
    const first = await h.approval.run(point, INVOICE, { correlationId: CASE("b3") });
    if (first.kind !== "suspended") throw new Error("expected a suspension");
    await h.approval.answer(
      first.suspension,
      { choice: "refuse", reason: "purchase order does not match" },
      { authority: human("auth_jane") },
    );

    const retried = await h.approval.run(point, INVOICE, { correlationId: CASE("b3") });
    expect(retried.kind).toBe("refused");
    if (retried.kind !== "refused") return;
    expect(retried.by).toBe(human("auth_jane").id);
  });

  it("reports the original effect rather than re-suspending an executed case", async () => {
    const h = setup();
    const point = gated();
    const first = await h.approval.run(point, INVOICE, { correlationId: CASE("b4") });
    if (first.kind !== "suspended") throw new Error("expected a suspension");
    await h.approval.answer(
      first.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    const retried = await h.approval.run(point, INVOICE, { correlationId: CASE("b4") });
    expect(retried.kind).toBe("executed");
    if (retried.kind !== "executed") return;
    expect(retried.effect).toEqual({ kind: "done", reference: "pay_4720000" });
    // Reported, not re-executed.
    expect(h.writes).toHaveLength(1);
  });

  it("reports an expiry as its own terminal state, never as a refusal", async () => {
    const point = gated({ expireAfter: 48 * 3_600_000 });
    const h = setup(point);
    const first = await h.approval.run(point, INVOICE, { correlationId: CASE("b5") });
    if (first.kind !== "suspended") throw new Error("expected a suspension");

    h.clock.advance(72 * 3_600_000);
    await h.approval.sweep({ limit: 10 });
    expect((await h.store.loadSuspension(first.suspension))?.state).toBe("expired");

    const retried = await h.approval.run(point, INVOICE, { correlationId: CASE("b5") });
    // "Nobody decided" is distinguishable from "an authority decided against
    // it" — CONTEXT.md rule 7, which folding this into `refused` would break.
    expect(retried.kind).toBe("expired");
  });
});

describe("idempotency — a concurrent duplicate is not a reconciliation incident", () => {
  it("names the in-flight claim instead of writing a false in-doubt node", async () => {
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const point = delegatedDisbursement(async (): Promise<EffectOutcome> => {
      entered += 1;
      await barrier;
      return { kind: "done", reference: "pay_1" };
    });
    const h = harness({
      points: [point],
      tierPolicy: tierBy({ small: "low" }),
      reservedPolicy: neverReserved(),
    });

    const winner = h.approval.run(point, INVOICE, { correlationId: CASE("b6") });
    await settle();
    expect(entered).toBe(1);

    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("b6") }),
    ).rejects.toBeInstanceOf(EffectAlreadyInFlight);

    release();
    const settled = await winner;
    expect(settled.kind).toBe("executed");
    expect(entered).toBe(1);

    const kinds = (await h.audit.replay(CASE("b6"))).nodes.map((n) => String(n.payload["kind"]));
    // The loser recorded that a claim was in flight, NOT that an effect was in
    // doubt. A double-clicked approve button must not manufacture a seven-year
    // reconciliation record describing an ambiguity that did not occur.
    expect(kinds).toContain("effect.already-in-flight");
    expect(kinds).not.toContain("effect.in-doubt");
    expect(await h.approval.inDoubt()).toEqual([]);
  });
});

describe("idempotency — the lease is enforced, not merely written", () => {
  it("reclaims an expired lease in not-attempted, because no call was made", async () => {
    const calls: number[] = [];
    const point = delegatedDisbursement(async (): Promise<EffectOutcome> => {
      calls.push(1);
      return calls.length === 1
        ? { kind: "not-attempted", reason: "ledger rejected: account frozen" }
        : { kind: "done", reference: "pay_2" };
    });
    const h = harness({
      points: [point],
      tierPolicy: tierBy({ small: "low" }),
      reservedPolicy: neverReserved(),
    });

    await h.approval.run(point, INVOICE, { correlationId: CASE("b7") });
    // Well past the ten-minute idempotency lease.
    h.clock.advance(60 * 60 * 1000);
    const second = await h.approval.run(point, INVOICE, { correlationId: CASE("b7") });
    if (second.kind !== "executed") throw new Error("expected an execution");
    expect(second.effect).toEqual({ kind: "done", reference: "pay_2" });
    expect(calls).toHaveLength(2);
  });

  it("never reclaims an expired lease in unknown, at any age", async () => {
    const calls: number[] = [];
    const point = delegatedDisbursement(async (): Promise<EffectOutcome> => {
      calls.push(1);
      return { kind: "unknown", reason: "gateway timed out after the debit was sent" };
    });
    const h = harness({
      points: [point],
      tierPolicy: tierBy({ small: "low" }),
      reservedPolicy: neverReserved(),
    });

    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("b8") }),
    ).rejects.toBeInstanceOf(IdempotencyIndeterminate);

    // A year later. Ambiguity resolves toward not paying twice, and no lease
    // TTL, configuration key or elapsed time changes that.
    h.clock.advance(365 * 24 * 3_600_000);
    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("b8") }),
    ).rejects.toBeInstanceOf(IdempotencyIndeterminate);
    expect(calls).toHaveLength(1);
    expect(await h.approval.inDoubt()).toHaveLength(1);
  });
});

describe("sweep — a lost compare-and-set is reported, never counted as done", () => {
  it("does not report an expiry it failed to persist", async () => {
    const point = gated({ expireAfter: 48 * 3_600_000 });
    const h = setup(point);
    await h.approval.run(point, INVOICE, { correlationId: CASE("b9") });
    h.clock.advance(72 * 3_600_000);

    const losing: ApprovalStore = {
      ...h.store,
      swapSuspension: async () => false,
    };
    const runtime = h.restart({ store: losing });
    const report = await runtime.approval.sweep({ limit: 10 });

    expect(report.expired).toBe(0);
    expect(report.raceLost).toBe(1);
    // And the case is still awaiting, which is what the store actually holds.
    const record = await h.store.loadSuspension(
      (await h.store.dueSuspensions(h.clock.now(), 10))[0]?.id ??
        ("none" as never),
    );
    expect(record?.state).toBe("awaiting");
  });
});
