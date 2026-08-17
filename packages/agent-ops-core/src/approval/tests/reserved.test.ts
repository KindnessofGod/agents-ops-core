import { describe, expect, it } from "vitest";
import { ReservedDelegationAttempt, ReservedStepMisdeclared } from "../index.js";
import {
  CASE,
  alwaysReserved,
  harness,
  human,
  neverReserved,
  tierBy,
} from "./fixtures/harness.js";
import { INVOICE, delegatedDisbursement, extraction, gatedDisbursement } from "./fixtures/points.js";

/**
 * Slice 2 — reserved decisions, on their own seam.
 *
 * Reserved status is a legal or policy obligation. It is orthogonal to risk
 * tier, it is not defeatable by configuration, and the correct value of
 * `unassisted_containment` for a reserved decision is exactly zero. (The term
 * is never line-wrapped: the qualifier is what stops it reading as a quality
 * score, and a naive lint for a bare occurrence should not have to guess.)
 */

const setup = (reservedPolicy = neverReserved()) =>
  harness({
    points: [gatedDisbursement(), extraction(), delegatedDisbursement()],
    tierPolicy: tierBy({ disburse: "high", extract: "low", small: "low" }),
    reservedPolicy,
    evidence: { [INVOICE.id]: { matched: true } },
  });

const kindsOf = async (h: ReturnType<typeof setup>, id: string) =>
  (await h.audit.replay(CASE(id))).nodes.map((n) => String(n.payload["kind"]));

describe("reserved — the screening is a node, whatever the answer", () => {
  it("records an explicit versioned assertion when NO rule matched", async () => {
    const h = setup(neverReserved("reserved-2026-08"));
    await h.approval.run(extraction(), INVOICE, { correlationId: CASE("c1") });

    const replayed = await h.audit.replay(CASE("c1"));
    const screen = replayed.nodes.find(
      (n) => n.payload["kind"] === "approval.reserved-screened",
    );

    // "We checked and it is not reserved" is a recorded fact with a policy
    // version behind it. "Nobody thought about it" would be the ABSENCE of this
    // node, and the two can never be confused.
    expect(screen).toBeDefined();
    expect(screen?.payload["reserved"]).toBe(false);
    expect(screen?.payload["policyVersion"]).toBe("reserved-2026-08");
    expect(screen?.payload["basis"]).toEqual(expect.stringContaining("no rule"));
  });

  it("screens on a seam separate from the tier policy", async () => {
    const h = setup(alwaysReserved());
    await h.approval
      .run(gatedDisbursement(), INVOICE, { correlationId: CASE("c2") })
      .catch(() => undefined);

    const kinds = await kindsOf(h, "c2");
    // Two independent nodes, from two independent policies with two versions.
    // A risk-threshold change cannot delete a legal obligation because it
    // cannot reach the policy that produced the second one.
    expect(kinds).toContain("approval.classified");
    expect(kinds).toContain("approval.reserved-screened");
  });
});

describe("reserved — structural enforcement, not configuration", () => {
  it("halts as an incident when a reserved decision reaches an ungated point", async () => {
    const h = setup(alwaysReserved());

    await expect(
      h.approval.run(extraction(), INVOICE, { correlationId: CASE("c3") }),
    ).rejects.toBeInstanceOf(ReservedStepMisdeclared);

    const replayed = await h.audit.replay(CASE("c3"));
    const halted = replayed.nodes.find((n) => n.payload["kind"] === "approval.halted");
    expect(halted?.payload["incident"]).toBe(true);
    expect(halted?.payload["error"]).toBe("ReservedStepMisdeclared");
  });

  it("halts as an incident when a reserved decision reaches a delegated effect", async () => {
    const h = setup(alwaysReserved());

    // There is no confidence value, threshold or setting that changes this.
    // The delegated-effect point simply cannot carry a reserved decision.
    await expect(
      h.approval.run(delegatedDisbursement(), INVOICE, { correlationId: CASE("c4") }),
    ).rejects.toBeInstanceOf(ReservedStepMisdeclared);
    expect(h.writes).toEqual([]);
  });

  it("refuses a delegated authority answering a reserved gate", async () => {
    const h = setup(alwaysReserved());
    const suspended = await h.approval.run(gatedDisbursement(), INVOICE, {
      correlationId: CASE("c5"),
    });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    await expect(
      h.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "auto" },
        {
          authority: {
            kind: "delegated",
            id: human("auth_bot").id,
            delegatedBy: human("auth_controller").id,
            delegationRef: "DEL-1",
            grantedAt: 0,
          },
        },
      ),
    ).rejects.toBeInstanceOf(ReservedDelegationAttempt);

    const kinds = await kindsOf(h, "c5");
    expect(kinds).toContain("approval.reserved-delegation-refused");
    expect(h.writes).toEqual([]);
  });
});

describe("reserved — no terminal state is reachable without an authority", () => {
  it("deletes a declared expiry rather than overriding it by setting", async () => {
    const h = setup(alwaysReserved());
    // The point DECLARES an expiry. For a reserved case it does not exist.
    const suspended = await h.approval.run(
      gatedDisbursement({ expireAfter: 72 * 3_600_000 }),
      INVOICE,
      { correlationId: CASE("c6") },
    );
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    expect(suspended.expiresAt).toBeNull();
    expect(suspended.doNothing.expire).toBeNull();

    const kinds = await kindsOf(h, "c6");
    // Recorded, so an auditor can see that an expiry was declared and deleted
    // rather than never declared at all.
    expect(kinds).toContain("approval.expiry-deleted-reserved");
  });

  it("keeps a reserved case answerable no matter how long it waits", async () => {
    const h = setup(alwaysReserved());
    const suspended = await h.approval.run(
      gatedDisbursement({ expireAfter: 72 * 3_600_000 }),
      INVOICE,
      { correlationId: CASE("c7") },
    );
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    // A year later.
    h.clock.advance(365 * 24 * 3_600_000);
    for (let i = 0; i < 30; i += 1) await h.approval.sweep({ limit: 50 });

    const record = await h.store.loadSuspension(suspended.suspension);
    // Never expired, never defaulted, never closed by the passage of time.
    expect(record?.state).toBe("awaiting");
    // And thirty catch-up sweeps at one instant send ONE reminder, not thirty.
    // This loop used to assert nothing about the chasing it triggered, which
    // is how a ladder that floods a channel after downtime went unnoticed.
    expect(h.renderer.reminders).toHaveLength(1);

    const first = await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "sanctions officer reviewed" },
      { authority: human("auth_jane") },
    );
    // High tier, so dual control: the first answer opens the second seat.
    expect(first.kind).toBe("suspended");

    const second = await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "controller countersigned" },
      { authority: human("auth_ravi") },
    );
    expect(second.kind).toBe("executed");
  });
});
