import { describe, expect, it } from "vitest";
import { IdempotencyIndeterminate, type EffectOutcome } from "../index.js";
import { CASE, harness, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, delegatedDisbursement } from "./fixtures/points.js";

/**
 * Slice 6 — three idempotency states, not two.
 *
 * `not-attempted` and `unknown` must never share a representation, because the
 * distinction is what decides whether a retry is safe.
 *
 * A duplicated payment is a clawback, a customer-trust incident and a
 * regulatory conversation. A delayed payment is a phone call. Those costs are
 * not symmetric, and the default does not pretend they are: **ambiguity
 * resolves toward not paying twice.**
 */

const scripted = (outcomes: readonly (EffectOutcome | "throw")[]) => {
  const calls: string[] = [];
  let i = 0;
  const point = delegatedDisbursement(async (licence) => {
    calls.push(licence.idempotencyKey);
    const next = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    if (next === "throw" || next === undefined) throw new Error("socket hung up");
    return next;
  });
  return { point, calls };
};

const setup = (point: ReturnType<typeof scripted>["point"]) =>
  harness({
    points: [point],
    tierPolicy: tierBy({ small: "low" }),
    reservedPolicy: neverReserved(),
  });

describe("idempotency — settled", () => {
  it("returns the original outcome on a repeat rather than re-executing", async () => {
    const { point, calls } = scripted([{ kind: "done", reference: "pay_1" }]);
    const h = setup(point);

    const first = await h.approval.run(point, INVOICE, { correlationId: CASE("i1") });
    const second = await h.approval.run(point, INVOICE, { correlationId: CASE("i1") });

    expect(first.kind).toBe("executed");
    expect(second.kind).toBe("executed");
    if (second.kind !== "executed") return;
    expect(second.effect).toEqual({ kind: "done", reference: "pay_1" });
    // Not re-executed, and not an error either.
    expect(calls).toHaveLength(1);

    const kinds = (await h.audit.replay(CASE("i1"))).nodes.map((n) => n.payload["kind"]);
    expect(kinds).toContain("effect.idempotent-replay");
  });
});

describe("idempotency — not-attempted", () => {
  it("reopens the claim when the executor knows nothing happened", async () => {
    const { point, calls } = scripted([
      { kind: "not-attempted", reason: "ledger rejected: account frozen" },
      { kind: "done", reference: "pay_2" },
    ]);
    const h = setup(point);

    const first = await h.approval.run(point, INVOICE, { correlationId: CASE("i2") });
    expect(first.kind).toBe("executed");
    if (first.kind === "executed") expect(first.effect.kind).toBe("not-attempted");

    // Safe to execute: the executor asserted nothing happened. This is the only
    // path that reopens a claim.
    const second = await h.approval.run(point, INVOICE, { correlationId: CASE("i2") });
    if (second.kind !== "executed") throw new Error("expected an execution");
    expect(second.effect).toEqual({ kind: "done", reference: "pay_2" });
    expect(calls).toHaveLength(2);
  });
});

describe("idempotency — unknown", () => {
  it("never auto-retries, and queues for a human instead", async () => {
    const { point, calls } = scripted([
      { kind: "unknown", reason: "gateway timed out after the debit was sent" },
      { kind: "done", reference: "must-never-happen" },
    ]);
    const h = setup(point);

    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("i3") }),
    ).rejects.toBeInstanceOf(IdempotencyIndeterminate);

    // A second attempt does NOT execute. Ambiguity resolves toward not paying
    // twice, and no configuration key changes that.
    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("i3") }),
    ).rejects.toBeInstanceOf(IdempotencyIndeterminate);
    expect(calls).toHaveLength(1);

    const queue = await h.approval.inDoubt();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.state).toBe("unknown");
    expect(queue[0]?.correlationId).toBe(CASE("i3"));

    const nodes = (await h.audit.replay(CASE("i3"))).nodes;
    const inDoubt = nodes.filter((n) => n.payload["kind"] === "effect.in-doubt");
    expect(inDoubt.length).toBeGreaterThan(0);
    expect(inDoubt[0]?.payload["autoRetried"]).toBe(false);
  });

  it("treats an executor that threw as in-doubt, not as not-attempted", async () => {
    const { point, calls } = scripted(["throw"]);
    const h = setup(point);

    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("i4") }),
    ).rejects.toBeInstanceOf(IdempotencyIndeterminate);

    // The claim was written BEFORE the outbound call, so what survives a crash
    // says "we may have paid" rather than "we never tried".
    expect((await h.approval.inDoubt())[0]?.state).toBe("unknown");
    expect(calls).toHaveLength(1);
  });

  it("survives process death with the claim still in doubt", async () => {
    const { point } = scripted([{ kind: "unknown", reason: "timeout" }]);
    const first = setup(point);
    await first.approval
      .run(point, INVOICE, { correlationId: CASE("i5") })
      .catch(() => undefined);

    const reborn = first.restart();
    const queue = await reborn.approval.inDoubt();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.state).toBe("unknown");
  });
});

describe("idempotency — the key is derived, never supplied", () => {
  it("derives the same key for the same case, point and payload", async () => {
    const { point, calls } = scripted([{ kind: "done", reference: "pay_1" }]);
    const h = setup(point);
    await h.approval.run(point, INVOICE, { correlationId: CASE("i6") });
    await h.approval.run(point, INVOICE, { correlationId: CASE("i6") });
    expect(calls).toHaveLength(1);
  });

  it("derives a different key for a different case", async () => {
    const { point, calls } = scripted([
      { kind: "done", reference: "pay_a" },
      { kind: "done", reference: "pay_b" },
    ]);
    const h = setup(point);
    await h.approval.run(point, INVOICE, { correlationId: CASE("i7") });
    await h.approval.run(point, INVOICE, { correlationId: CASE("i8") });
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(2);
  });
});
