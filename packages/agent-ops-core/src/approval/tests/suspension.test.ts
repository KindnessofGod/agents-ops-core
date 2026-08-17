import { describe, expect, it } from "vitest";
import { SuspensionAlreadySettled, SuspensionNotFound, UnknownDecisionPoint } from "../index.js";
import { CASE, harness, human, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, extraction, gatedDisbursement } from "./fixtures/points.js";

/**
 * Slice 4 — durable suspension.
 *
 * The human gate is unbounded: hours or days. The process *will* be redeployed
 * mid-wait. So the test is not "does state round-trip" — it is: throw the
 * entire runtime away, build a new one over the same durable stores, and see
 * whether the case can still be answered.
 *
 * `await approve()` is the wrong shape and this module makes it unwritable:
 * `run` returns `Suspended`, which carries no promise of an answer.
 */

const setup = () =>
  harness({
    points: [gatedDisbursement({ dualControlAtOrAbove: "never" }), extraction()],
    tierPolicy: tierBy({ disburse: "high", extract: "low" }),
    reservedPolicy: neverReserved(),
    evidence: { [INVOICE.id]: { matched: true } },
  });

describe("suspension — the process dies and the case does not", () => {
  it("answers days later from a runtime that never saw the run", async () => {
    const first = setup();
    const suspended = await first.approval.run(
      gatedDisbursement({ dualControlAtOrAbove: "never" }),
      INVOICE,
      { correlationId: CASE("s1") },
    );
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    // The process dies here. Everything the old runtime held in memory — the
    // decision point closure, the recorder's node index, the brief it built —
    // is gone. Only the two durable stores survive.
    const reborn = first.restart();
    reborn.clock.advance(9 * 24 * 3_600_000); // nine days

    const settled = await reborn.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "purchase order checked with the buyer" },
      { authority: human("auth_jane") },
    );

    expect(settled.kind).toBe("executed");
    if (settled.kind !== "executed") return;
    expect(settled.effect).toEqual({ kind: "done", reference: "pay_4720000" });
    expect(settled.authorityTransferred).toBe(true);
    expect(reborn.writes).toHaveLength(1);
  });

  it("keeps ONE trace across the gap, with the later nodes parented on the earlier", async () => {
    const first = setup();
    const suspended = await first.approval.run(
      gatedDisbursement({ dualControlAtOrAbove: "never" }),
      INVOICE,
      { correlationId: CASE("s2") },
    );
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    const reborn = first.restart();
    reborn.clock.advance(3 * 24 * 3_600_000);
    await reborn.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    const replayed = await reborn.audit.replay(CASE("s2"));
    const kinds = replayed.nodes.map((n) => String(n.payload["kind"]));

    // One trace, both halves.
    expect(kinds).toContain("approval.run");
    expect(kinds).toContain("approval.suspend.durable");
    expect(kinds).toContain("approval.answered");
    expect(kinds).toContain("effect.done");

    // Parentage is recorded, not inferred — and it survives the gap. The
    // answer node hangs off the suspension node written by a process that no
    // longer exists, which is only possible because the new runtime rehydrated
    // the graph from the store.
    const answered = replayed.nodes.find((n) => n.payload["kind"] === "approval.answered");
    expect(answered?.parent).toBe(suspended.node);
    expect(replayed.childrenOf(suspended.node).length).toBeGreaterThan(0);
  });

  it("carries nothing in a closure: every field needed to resume is plain data", async () => {
    const first = setup();
    const suspended = await first.approval.run(
      gatedDisbursement({ dualControlAtOrAbove: "never" }),
      INVOICE,
      { correlationId: CASE("s3") },
    );
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    const record = await first.store.loadSuspension(suspended.suspension);
    expect(record).toBeDefined();
    // Round-trips through JSON with nothing lost. A closure would not.
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
    for (const value of Object.values(record ?? {})) {
      expect(typeof value).not.toBe("function");
    }
  });

  it("fails closed, still answerable, when the release no longer declares the point", async () => {
    const first = setup();
    const suspended = await first.approval.run(
      gatedDisbursement({ dualControlAtOrAbove: "never" }),
      INVOICE,
      { correlationId: CASE("s4") },
    );
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    // A deploy that drops the decision point while a case waits on it.
    const reborn = first.restart({ points: [extraction()] });
    await expect(
      reborn.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "checked" },
        { authority: human("auth_jane") },
      ),
    ).rejects.toBeInstanceOf(UnknownDecisionPoint);

    // Not closed, not expired, not lost. A rollback fixes it; nothing else
    // needs to.
    const record = await reborn.store.loadSuspension(suspended.suspension);
    expect(record?.state).toBe("awaiting");
  });
});

describe("suspension — the same question is never asked twice", () => {
  it("rejoins an existing suspension when `run` is retried", async () => {
    const h = setup();
    const point = gatedDisbursement({ dualControlAtOrAbove: "never" });
    const a = await h.approval.run(point, INVOICE, { correlationId: CASE("s5") });
    const b = await h.approval.run(point, INVOICE, { correlationId: CASE("s5") });

    if (a.kind !== "suspended" || b.kind !== "suspended") throw new Error("expected suspensions");
    expect(b.suspension).toBe(a.suspension);
    // One brief, one approver interrupted, one question asked.
    expect(h.renderer.presented).toHaveLength(1);
  });

  it("distinguishes a forged suspension id from a settled one", async () => {
    const h = setup();
    const suspended = await h.approval.run(
      gatedDisbursement({ dualControlAtOrAbove: "never" }),
      INVOICE,
      { correlationId: CASE("s6") },
    );
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    await expect(
      h.approval.answer(
        "sus_never_existed" as typeof suspended.suspension,
        { choice: "approve", reason: "x" },
        { authority: human("auth_jane") },
      ),
    ).rejects.toBeInstanceOf(SuspensionNotFound);

    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );
    await expect(
      h.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "checked again" },
        { authority: human("auth_jane") },
      ),
    ).rejects.toBeInstanceOf(SuspensionAlreadySettled);
    // The retried webhook did not pay twice.
    expect(h.writes).toHaveLength(1);
  });
});
