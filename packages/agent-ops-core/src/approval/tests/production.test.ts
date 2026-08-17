import { describe, expect, it } from "vitest";
import { NonIntegerPayload, TierCeilingExceeded } from "../index.js";
import { CASE, harness, neverReserved, tierBy } from "./fixtures/harness.js";
import {
  INVOICE,
  delegatedDisbursement,
  extraction,
  gatedDisbursement,
} from "./fixtures/points.js";

/**
 * Slice 8 — the production-grade obligations that are not about approval as
 * such: integers only, a named delegation behind every automated approval, a
 * fail-closed tier ceiling, and an abstention that is a verdict rather than an
 * error.
 */

const setup = () =>
  harness({
    points: [gatedDisbursement(), extraction(), delegatedDisbursement()],
    tierPolicy: tierBy({ disburse: "high", extract: "low", small: "low" }),
    reservedPolicy: neverReserved(),
    evidence: { [INVOICE.id]: { matched: true } },
  });

describe("payloads — integers only, checked before the write", () => {
  it("refuses a float before it can reach the trace", async () => {
    const h = setup();
    const floaty = extraction();
    const broken = {
      ...floaty,
      spec: {
        ...floaty.spec,
        // A confidence expressed as a fraction rather than basis points. This
        // is the exact shape of the mistake: it looks harmless, it serialises
        // differently on different hosts, and replay stops being byte-stable.
        tierFacts: () => ({ kind: "extract", ratio: 0.1 + 0.2 }),
      },
    } as typeof floaty;

    await expect(
      h.approval.run(broken, INVOICE, { correlationId: CASE("p1") }),
    ).rejects.toBeInstanceOf(NonIntegerPayload);
  });

  it("writes money in minor units and confidence in basis points", async () => {
    const h = setup();
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("p2") });

    const nodes = (await h.audit.replay(CASE("p2"))).nodes;
    const classified = nodes.find((n) => n.payload["kind"] === "approval.classified");
    const decided = nodes.find((n) => n.payload["kind"] === "approval.decided");

    expect(classified?.payload["fact_moneyAtRiskMinor"]).toBe(4_720_000);
    expect(decided?.payload["confidenceBasisPoints"]).toBe(9_700);
    for (const node of nodes) {
      for (const value of Object.values(node.payload)) {
        if (typeof value === "number") expect(Number.isSafeInteger(value)).toBe(true);
      }
    }
  });

  it("stamps a payload version on every node it writes", async () => {
    const h = setup();
    await h.approval.run(extraction(), INVOICE, { correlationId: CASE("p3") });
    const nodes = (await h.audit.replay(CASE("p3"))).nodes;
    // Fields may be added; never removed, never retyped, never re-meaninged.
    for (const node of nodes) expect(node.payload["v"]).toBe(2);
  });

  it("stamps the scope of the guarantee onto the evidence itself", async () => {
    const h = setup();
    await h.approval.run(extraction(), INVOICE, { correlationId: CASE("p4") });
    const nodes = (await h.audit.replay(CASE("p4"))).nodes;

    // A reader in 2033 learns what the evidence covers FROM the evidence, not
    // from a wiki that no longer exists. This module mediates its own declared
    // seams and nothing beyond them; overstating that would be worse than
    // stating it.
    const mine = nodes.filter((n) => String(n.payload["kind"]).startsWith("approval."));
    expect(mine.length).toBeGreaterThan(0);
    for (const node of mine) expect(node.payload["capturedVia"]).toBe("declared-seams-only");
  });
});

describe("automated approval still names its delegation", () => {
  it("records under whose delegation the system approved", async () => {
    const h = setup();
    const settled = await h.approval.run(delegatedDisbursement(), INVOICE, {
      correlationId: CASE("p5"),
    });
    expect(settled.kind).toBe("executed");

    const granted = (await h.audit.replay(CASE("p5"))).nodes.find(
      (n) => n.payload["kind"] === "approval.granted",
    );
    // "The system approved it" never appears in a trace without saying under
    // whose delegation.
    expect(granted?.payload["authorityKind"]).toBe("delegated");
    expect(granted?.payload["delegatedBy"]).toBe("auth_controller");
    expect(granted?.payload["delegationRef"]).toBe("DEL-2026-14");

    // And authority did NOT transfer to a human, which is a different fact from
    // unassisted containment and is recorded as its own.
    if (settled.kind === "executed") expect(settled.authorityTransferred).toBe(false);
  });
});

describe("tier — a declared ceiling fails closed", () => {
  it("halts rather than silently running a high-tier case at a low tier", async () => {
    const h = harness({
      points: [extraction()],
      // The policy says this extraction is high-consequence today. The point
      // declares a low ceiling. There is no brief for the tier reached.
      tierPolicy: tierBy({ extract: "high" }),
      reservedPolicy: neverReserved(),
    });

    await expect(
      h.approval.run(extraction(), INVOICE, { correlationId: CASE("p6") }),
    ).rejects.toBeInstanceOf(TierCeilingExceeded);

    const halted = (await h.audit.replay(CASE("p6"))).nodes.find(
      (n) => n.payload["kind"] === "approval.halted",
    );
    expect(halted?.payload["alert"]).toBe(true);
  });
});

describe("abstention is a verdict, not an error", () => {
  it("returns it rather than throwing, and records it", async () => {
    const base = extraction();
    const abstaining = {
      ...base,
      spec: {
        ...base.spec,
        decide: async () => ({
          kind: "abstained" as const,
          reason: "fields-illegible",
          evidence: [],
          // Required, never optional: an abstention still spent whatever it
          // spent deciding not to decide, and a verdict that omits its cost is
          // the one shape `DecisionSpend` exists to forbid. Leaving it off made
          // this literal non-comparable to `base`, and the cast below hid that.
          spend: {
            costTenthCents: 0,
            tokensIn: 0,
            tokensOut: 0,
            priceTableVersion: "none",
          },
        }),
      },
    } as typeof base;

    const h = harness({
      points: [abstaining],
      tierPolicy: tierBy({ extract: "low" }),
      reservedPolicy: neverReserved(),
    });

    const settled = await h.approval.run(abstaining, INVOICE, { correlationId: CASE("p7") });
    expect(settled.kind).toBe("abstained");
    if (settled.kind !== "abstained") return;
    // An abstention is a successful outcome of a working system. Nobody was
    // asked, so no authority transferred — which is a separate fact from
    // whether the system concluded.
    expect(settled.authorityTransferred).toBe(false);

    const kinds = (await h.audit.replay(CASE("p7"))).nodes.map((n) => n.payload["kind"]);
    expect(kinds).toContain("approval.abstained");
  });
});
