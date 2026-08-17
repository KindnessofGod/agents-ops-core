import { describe, expect, it } from "vitest";
import type { KillSwitchState, PolicyFacts, Tier, TierPolicy } from "../index.js";
import { CASE, harness, human, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, delegatedDisbursement, gatedDisbursement } from "./fixtures/points.js";

/**
 * `README.md` item 12 — **kill-switch scope was recorded, not enforced.**
 *
 * `docs/CONTEXT.md` says a kill switch stops effects *"system-wide or per
 * tier"*. What shipped read a switch that took no tier, asked no per-tier
 * question, and wrote whatever `scope` string the reader claimed onto the node
 * — and then stopped **every** effect at **every** tier regardless. Two
 * failures in one, and the second is the dangerous one:
 *
 *   - A switch meant for high tier silently stopped low-tier work as well. An
 *     incident on disbursements halted ticket routing, and nobody reading the
 *     trace could tell, because the node agreed with the reader.
 *   - The control **reported that it had worked**. `scope: "tier:high"` in an
 *     append-only archive is a claim about behaviour that nothing in the
 *     library ever compared to anything. A safety control that records its own
 *     scope without obeying it is worse than one with no scope at all, because
 *     an operator plans around it.
 *
 * So the tests below are about enforcement, not recording. `scope` is now a
 * closed type, the reader is asked a per-tier question, and this module —
 * never the reader — decides whether the scope covers the effect in hand.
 *
 * The trace assertions are not decoration either: an enforced control and a
 * recorded one are indistinguishable in a summary, and `appliesToTier` is the
 * field that separates them seven years from now.
 */

const gated = gatedDisbursement({ dualControlAtOrAbove: "never" });
const delegated = delegatedDisbursement();

/**
 * Tier from the money at risk, so one decision point produces cases at two
 * tiers. `tierBy` keys on the fact `kind`, which every invoice shares.
 */
const byMoney: TierPolicy = {
  version: "tier-by-money-2026-08",
  classify: (facts: PolicyFacts): Tier =>
    Number(facts["moneyAtRiskMinor"] ?? 0) >= 1_000_000 ? "high" : "low",
};

const BIG = INVOICE;
const SMALL = { ...INVOICE, id: "inv_00042", amountMinor: 4_200 };

const DAY = 24 * 3_600_000;

/** Records every question the module asked, so "was it asked per tier" is a fact. */
const switchAnswering = (answer: (tier: Tier) => KillSwitchState) => {
  const asked: Tier[] = [];
  return {
    asked,
    read: async ({ tier }: { readonly tier: Tier }): Promise<KillSwitchState> => {
      asked.push(tier);
      return answer(tier);
    },
  };
};

describe("kill-switch scope is enforced at execute, not merely written down", () => {
  it("refuses a high-tier effect and lets a low-tier one through, under one switch scoped to high", async () => {
    const engaged: KillSwitchState = {
      engaged: true,
      scope: { kind: "tiers", tiers: ["high"] },
      by: "auth_ops_lead",
      at: 1_700_000_000_000,
    };
    const reader = switchAnswering(() => engaged);
    const h = harness({
      points: [gated],
      tierPolicy: byMoney,
      reservedPolicy: neverReserved(),
      evidence: { [BIG.id]: { matched: true }, [SMALL.id]: { matched: true } },
      members: [human("auth_jane")],
      killSwitch: reader.read,
    });

    const big = await h.approval.run(gated, BIG, { correlationId: CASE("ks-high") });
    const small = await h.approval.run(gated, SMALL, { correlationId: CASE("ks-low") });
    if (big.kind !== "suspended" || small.kind !== "suspended") {
      throw new Error("expected both cases to suspend at the human gate");
    }

    // ---- the high-tier effect: refused -----------------------------------
    const stopped = await h.approval.answer(
      big.suspension,
      { choice: "approve", reason: "purchase order checked" },
      { authority: human("auth_jane") },
    );
    expect(stopped.kind).toBe("held");
    if (stopped.kind !== "held") return;
    expect(stopped.reason).toBe("kill-switch");

    // ---- the low-tier effect: proceeds -----------------------------------
    const proceeded = await h.approval.answer(
      small.suspension,
      { choice: "approve", reason: "purchase order checked" },
      { authority: human("auth_jane") },
    );
    expect(proceeded.kind).toBe("executed");

    // Exactly one payment left the building, and it is the small one. This is
    // the assertion the old code failed: it made none.
    expect(h.writes).toHaveLength(1);

    // ---- and the trace tells the truth about both ------------------------
    const readNode = async (id: string) =>
      (await h.audit.replay(CASE(id))).nodes.find(
        (n) => n.payload["kind"] === "approval.kill-switch-read",
      );

    const high = await readNode("ks-high");
    expect(high?.payload["engaged"]).toBe(true);
    expect(high?.payload["readable"]).toBe(true);
    expect(high?.payload["tier"]).toBe("high");
    expect(high?.payload["scopeKind"]).toBe("tiers");
    expect(high?.payload["scopeTiers"]).toBe("high");
    expect(high?.payload["appliesToTier"]).toBe(true);
    expect(high?.payload["stopped"]).toBe(true);
    expect(high?.payload["by"]).toBe("auth_ops_lead");

    const low = await readNode("ks-low");
    // The switch was ON and the effect went ahead. Both halves are on the node:
    // "engaged but out of scope for this tier" and "nobody had engaged
    // anything" are different sentences to an auditor reading an incident
    // window, and only one of them means the control was not in use.
    expect(low?.payload["engaged"]).toBe(true);
    expect(low?.payload["tier"]).toBe("low");
    expect(low?.payload["scopeKind"]).toBe("tiers");
    expect(low?.payload["scopeTiers"]).toBe("high");
    expect(low?.payload["appliesToTier"]).toBe(false);
    expect(low?.payload["stopped"]).toBe(false);

    // The effect was taken at low tier, so the phases after the read exist.
    const lowKinds = (await h.audit.replay(CASE("ks-low"))).nodes.map((n) =>
      String(n.payload["kind"]),
    );
    expect(lowKinds).toContain("approval.licence-minted");
    const highKinds = (await h.audit.replay(CASE("ks-high"))).nodes.map((n) =>
      String(n.payload["kind"]),
    );
    expect(highKinds).not.toContain("approval.licence-minted");

    // The reader was asked about the tier of the effect in hand, both times.
    expect(reader.asked).toEqual(["high", "low"]);
  });

  it("stops every tier when the scope is system-wide", async () => {
    const h = harness({
      points: [gated],
      tierPolicy: byMoney,
      reservedPolicy: neverReserved(),
      evidence: { [BIG.id]: { matched: true }, [SMALL.id]: { matched: true } },
      members: [human("auth_jane")],
      killSwitch: async () => ({
        engaged: true,
        scope: { kind: "system-wide" },
        by: "auth_ops_lead",
        at: 1_700_000_000_000,
      }),
    });

    for (const [id, invoice] of [
      ["ks-sw-high", BIG],
      ["ks-sw-low", SMALL],
    ] as const) {
      const run = await h.approval.run(gated, invoice, { correlationId: CASE(id) });
      if (run.kind !== "suspended") throw new Error("expected a suspension");
      const settled = await h.approval.answer(
        run.suspension,
        { choice: "approve", reason: "checked" },
        { authority: human("auth_jane") },
      );
      expect(settled.kind).toBe("held");
    }
    expect(h.writes).toEqual([]);

    const node = (await h.audit.replay(CASE("ks-sw-low"))).nodes.find(
      (n) => n.payload["kind"] === "approval.kill-switch-read",
    );
    expect(node?.payload["scopeKind"]).toBe("system-wide");
    // Written out rather than left implicit, so "was low tier stopped at
    // 14:06?" is one string comparison in 2033 and not a join against whatever
    // the tier enumeration was that year.
    expect(node?.payload["scopeTiers"]).toBe("low,medium,high");
    expect(node?.payload["appliesToTier"]).toBe(true);
  });

  it("stops a low-tier delegated effect too — the scope is not a gated-path feature", async () => {
    const h = harness({
      points: [delegated],
      tierPolicy: tierBy({ small: "low" }),
      reservedPolicy: neverReserved(),
      evidence: {},
      killSwitch: async () => ({
        engaged: true,
        scope: { kind: "tiers", tiers: ["low"] },
        by: "auth_ops_lead",
        at: 1_700_000_000_000,
      }),
    });

    const settled = await h.approval.run(delegated, SMALL, { correlationId: CASE("ks-del") });
    expect(settled.kind).toBe("held");
    expect(h.writes).toEqual([]);
  });

  it("stops every tier when the switch cannot be read, whatever scope was intended", async () => {
    const reader = switchAnswering((): KillSwitchState => {
      throw new Error("consul quorum lost");
    });
    const h = harness({
      points: [gated],
      tierPolicy: byMoney,
      reservedPolicy: neverReserved(),
      evidence: { [SMALL.id]: { matched: true } },
      members: [human("auth_jane")],
      killSwitch: reader.read,
    });

    const run = await h.approval.run(gated, SMALL, { correlationId: CASE("ks-unread") });
    if (run.kind !== "suspended") throw new Error("expected a suspension");
    const settled = await h.approval.answer(
      run.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    // Fail-closed at the LOWEST tier: an unreadable switch has no readable
    // scope either, so "it was probably only scoped to high" is a guess, and
    // per-tier scope is the last place in this library to start guessing.
    expect(settled.kind).toBe("held");
    if (settled.kind !== "held") return;
    expect(settled.reason).toBe("kill-switch-unreadable");
    expect(h.writes).toEqual([]);

    const node = (await h.audit.replay(CASE("ks-unread"))).nodes.find(
      (n) => n.payload["kind"] === "approval.kill-switch-read",
    );
    expect(node?.payload["readable"]).toBe(false);
    expect(node?.payload["scopeKind"]).toBe("unreadable");
    expect(node?.payload["stopped"]).toBe(true);
    expect(node?.payload["tier"]).toBe("low");
  });
});

describe("a hold is released when the scope stops covering its tier", () => {
  it("releases the low-tier case and keeps the high-tier one held, in one sweep", async () => {
    let scope: KillSwitchState = {
      engaged: true,
      scope: { kind: "system-wide" },
      by: "auth_ops_lead",
      at: 1_700_000_000_000,
    };
    const reader = switchAnswering(() => scope);
    const h = harness({
      points: [gated],
      tierPolicy: byMoney,
      reservedPolicy: neverReserved(),
      evidence: { [BIG.id]: { matched: true }, [SMALL.id]: { matched: true } },
      members: [human("auth_jane")],
      killSwitch: reader.read,
    });

    const cases: Record<string, string> = {};
    for (const [id, invoice] of [
      ["ks-hold-high", BIG],
      ["ks-hold-low", SMALL],
    ] as const) {
      const run = await h.approval.run(gated, invoice, { correlationId: CASE(id) });
      if (run.kind !== "suspended") throw new Error("expected a suspension");
      const held = await h.approval.answer(
        run.suspension,
        { choice: "approve", reason: "checked, during the incident" },
        { authority: human("auth_jane") },
      );
      expect(held.kind).toBe("held");
      cases[id] = run.suspension;
    }

    // The incident narrows: disbursements stay stopped, everything else resumes.
    scope = {
      engaged: true,
      scope: { kind: "tiers", tiers: ["high"] },
      by: "auth_ops_lead",
      at: 1_700_000_000_100,
    };
    reader.asked.length = 0;
    h.clock.advance(DAY);

    const report = await h.approval.sweep({ limit: 10 });
    expect(report.holdsReleased).toBe(1);

    const low = await h.store.loadSuspension(cases["ks-hold-low"] as never);
    const high = await h.store.loadSuspension(cases["ks-hold-high"] as never);
    expect(low?.state).toBe("awaiting");
    expect(high?.state).toBe("held");

    // The pre-incident approval is void on the released case. A fresh approval
    // licenses the effect, or nothing does — the switch going out of scope is
    // not a lawful basis for moving money.
    expect(low?.finalAnswer).toBeNull();
    expect(low?.seat).toBe("first");
    expect(h.writes).toEqual([]);

    // Bounded: at most one read per TIER per sweep, never one per case. A batch
    // of two hundred held cases during an incident must not be two hundred
    // reads of the control plane that is already having the incident.
    expect(reader.asked.length).toBeLessThanOrEqual(3);
    expect(new Set(reader.asked).size).toBe(reader.asked.length);

    // And both outcomes are on their own traces, with the scope that produced
    // them rather than a bare "released"/"still held".
    const released = (await h.audit.replay(CASE("ks-hold-low"))).nodes.find(
      (n) => n.payload["kind"] === "approval.hold-released",
    );
    expect(released?.payload["tier"]).toBe("low");
    expect(released?.payload["scopeKind"]).toBe("tiers");
    expect(released?.payload["scopeTiers"]).toBe("high");
    expect(released?.payload["appliesToTier"]).toBe(false);
    expect(released?.payload["effectTaken"]).toBe(false);

    const continued = (await h.audit.replay(CASE("ks-hold-high"))).nodes.find(
      (n) => n.payload["kind"] === "approval.hold-continues",
    );
    expect(continued?.payload["tier"]).toBe("high");
    expect(continued?.payload["appliesToTier"]).toBe(true);
  });
});
