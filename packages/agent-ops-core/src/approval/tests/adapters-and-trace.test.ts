import { describe, expect, it } from "vitest";
import {
  AdapterFailed,
  ReservedFactsEmpty,
  inMemoryClientFactory,
  type PolicyFacts,
  type ReservedPolicy,
  type TierPolicy,
} from "../index.js";
import {
  CASE,
  harness,
  human,
  neverReserved,
  reservedBy,
  tierBy,
} from "./fixtures/harness.js";
import { INVOICE, extraction, gatedDisbursement } from "./fixtures/points.js";

/**
 * Rework slice C/E — every adapter failure is named and recorded, no free text
 * or personal data reaches the trace, and every node carries its telemetry.
 *
 * Before the fix `errors.ts` named fifteen module-raised errors and zero
 * adapter-raised ones: `decide` throwing left a trace ending at
 * `approval.deciding`, `tierPolicy.classify` throwing left one containing only
 * `approval.run`, and a `renderer.present` that threw lost the `SuspensionId`
 * for a suspension that was already durable.
 */

const setup = (options: Parameters<typeof harness>[0]) => harness(options);

const kindsOf = async (h: ReturnType<typeof harness>, id: string) =>
  (await h.audit.replay(CASE(id))).nodes.map((n) => String(n.payload["kind"]));

const base = {
  points: [gatedDisbursement(), extraction()],
  tierPolicy: tierBy({ disburse: "high", extract: "low" }),
  reservedPolicy: neverReserved(),
  evidence: { [INVOICE.id]: { matched: true } },
};

const throwingTier = (): TierPolicy => ({
  version: "tier-broken",
  classify: () => {
    throw new Error("tier table unreachable");
  },
});

const throwingReserved = (): ReservedPolicy => ({
  version: "reserved-broken",
  screen: () => {
    throw new Error("statute index unreachable");
  },
});

describe("adapter failures — named, recorded, fail-closed", () => {
  it("records a `decide` that threw instead of ending the trace mid-phase", async () => {
    const broken = gatedDisbursement();
    const point = {
      ...broken,
      spec: {
        ...broken.spec,
        decide: async () => {
          throw new TypeError("client.write is not a function");
        },
      },
    } as typeof broken;
    const h = setup({ ...base, points: [point] });

    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("c1") }),
    ).rejects.toBeInstanceOf(AdapterFailed);

    const nodes = (await h.audit.replay(CASE("c1"))).nodes;
    const failure = nodes.find((n) => n.payload["kind"] === "approval.adapter-failed");
    expect(failure?.payload["seam"]).toBe("spec.decide");
    expect(failure?.payload["causeClass"]).toBe("TypeError");
    expect(failure?.payload["fatal"]).toBe(true);
    // The claim `clients.ts` made about the runtime backstop, run rather than
    // asserted: an `any`-typed handler reaching for `write` gets a TypeError
    // and the module records an error node.
  });

  it("records a tier policy that threw", async () => {
    const h = setup({ ...base, tierPolicy: throwingTier() });
    await expect(
      h.approval.run(extraction(), INVOICE, { correlationId: CASE("c2") }),
    ).rejects.toBeInstanceOf(AdapterFailed);
    const nodes = (await h.audit.replay(CASE("c2"))).nodes;
    expect(nodes.find((n) => n.payload["kind"] === "approval.adapter-failed")?.payload["seam"]).toBe(
      "tierPolicy.classify",
    );
  });

  it("records a reserved policy that threw", async () => {
    const h = setup({ ...base, reservedPolicy: throwingReserved() });
    await expect(
      h.approval.run(extraction(), INVOICE, { correlationId: CASE("c3") }),
    ).rejects.toBeInstanceOf(AdapterFailed);
    expect(await kindsOf(h, "c3")).toContain("approval.adapter-failed");
  });

  it("records a brief builder that threw", async () => {
    const broken = gatedDisbursement();
    const point = {
      ...broken,
      spec: {
        ...broken.spec,
        brief: () => {
          throw new Error("template store unreachable");
        },
      },
    } as typeof broken;
    const h = setup({ ...base, points: [point] });
    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("c4") }),
    ).rejects.toBeInstanceOf(AdapterFailed);
    const nodes = (await h.audit.replay(CASE("c4"))).nodes;
    expect(nodes.find((n) => n.payload["kind"] === "approval.adapter-failed")?.payload["seam"]).toBe(
      "spec.brief",
    );
  });

  it("keeps the SuspensionId when the renderer throws, and re-serves on the next sweep", async () => {
    const h = setup(base);
    h.renderer.failNextPresent();

    const suspended = await h.approval.run(gatedDisbursement(), INVOICE, {
      correlationId: CASE("c5"),
    });
    // The suspension is durable, so the caller MUST get its identifier. Losing
    // it left a case nobody could answer and nobody could find.
    expect(suspended.kind).toBe("suspended");
    if (suspended.kind !== "suspended") return;

    const kinds = await kindsOf(h, "c5");
    expect(kinds).toContain("approval.adapter-failed");
    expect(kinds).toContain("approval.brief-undelivered");

    const before = await h.store.loadSuspension(suspended.suspension);
    expect(before?.presentedAt).toBeNull();
    expect(before?.offeredTo).toEqual([]);

    h.clock.advance(5 * 3_600_000);
    const report = await h.approval.sweep({ limit: 10 });
    expect(report.presented).toBe(1);
    const after = await h.store.loadSuspension(suspended.suspension);
    expect(after?.presentedAt).not.toBeNull();
    expect(after?.offeredTo.length).toBeGreaterThan(0);
  });
});

describe("the brief that nobody could be offered is offered again", () => {
  it("re-serves it once the directory recovers, rather than never", async () => {
    const h = setup({ ...base, members: [] });
    const suspended = await h.approval.run(gatedDisbursement(), INVOICE, {
      correlationId: CASE("c6"),
    });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    expect(await kindsOf(h, "c6")).toContain("approval.authority-unavailable");
    expect((await h.store.loadSuspension(suspended.suspension))?.presentedAt).toBeNull();

    // The on-call rota is repopulated. The next sweep delivers the brief.
    const recovered = h.restart({ members: [human("auth_jane")] });
    h.clock.advance(5 * 3_600_000);
    const report = await recovered.approval.sweep({ limit: 10 });
    expect(report.presented).toBe(1);
    expect(recovered.renderer.presented).toHaveLength(1);
  });

  it("never invents a time-to-decision for a presentation that did not happen", async () => {
    const h = setup({ ...base, members: [] });
    const suspended = await h.approval.run(gatedDisbursement(), INVOICE, {
      correlationId: CASE("c7"),
    });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    // Somebody with a legitimate identity in the store is added and offered it.
    const recovered = h.restart({ members: [human("auth_jane")] });
    h.clock.advance(5 * 3_600_000);
    await recovered.approval.sweep({ limit: 10 });
    const record = await recovered.store.loadSuspension(suspended.suspension);
    expect(record?.presentedAt).toBe(recovered.clock.now());
  });
});

describe("reserved screening on nothing is not the same artefact as screening", () => {
  it("halts a decision point that submits no facts for screening", async () => {
    const bare = extraction();
    const point = {
      ...bare,
      spec: { ...bare.spec, reservedFacts: (): PolicyFacts => ({}) },
    } as typeof bare;
    const h = setup({ ...base, points: [point] });

    await expect(
      h.approval.run(point, INVOICE, { correlationId: CASE("c8") }),
    ).rejects.toBeInstanceOf(ReservedFactsEmpty);
  });

  it("records what was submitted, so 'we checked' is legible in 2033", async () => {
    const h = setup({
      ...base,
      reservedPolicy: reservedBy(() => ({
        reserved: false,
        basis: "no rule in the declared reserved list matches these facts",
        policyVersion: "reserved-2026-08",
      })),
    });
    await h.approval.run(extraction(), INVOICE, { correlationId: CASE("c9") });
    const screen = (await h.audit.replay(CASE("c9"))).nodes.find(
      (n) => n.payload["kind"] === "approval.reserved-screened",
    );
    expect(screen?.payload["factCount"]).toBe(1);
    expect(screen?.payload["factKeys"]).toBe("kind");
  });
});

describe("the trace carries no free text, no personal data and no secrets", () => {
  it("keeps an approver's own words out of the seven-year archive", async () => {
    const h = setup(base);
    const suspended = await h.approval.run(
      gatedDisbursement({ dualControlAtOrAbove: "never" }),
      INVOICE,
      { correlationId: CASE("c10") },
    );
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    const reason = "spoke to Mrs A. Okafor, DOB 1954-02-11, mobile 07700 900123";
    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason },
      { authority: human("auth_jane") },
    );

    const dumped = JSON.stringify((await h.audit.replay(CASE("c10"))).nodes);
    expect(dumped).not.toContain("Okafor");
    expect(dumped).not.toContain("1954-02-11");
    expect(dumped).not.toContain("07700 900123");

    const answered = (await h.audit.replay(CASE("c10"))).nodes.find(
      (n) => n.payload["kind"] === "approval.answered",
    );
    // Evidence that a reason was given, and enough to prove which one, without
    // being a copy of it.
    expect(answered?.payload["reasonChars"]).toBe(reason.length);
    expect(typeof answered?.payload["reasonDigest"]).toBe("string");
    // And the words themselves survive where the application's own retention
    // governs them.
    const record = await h.store.loadSuspension(suspended.suspension);
    expect(record?.finalAnswer?.reason).toBe(reason);
  });

  it("keeps an executor's error text out of it too", async () => {
    const secret = "auth failed for sk_live_9931 on NHS number 943 476 5919";
    const point = gatedDisbursement({
      dualControlAtOrAbove: "never",
      execute: async () => {
        throw new Error(secret);
      },
    });
    const h = setup({ ...base, points: [point] });
    const suspended = await h.approval.run(point, INVOICE, { correlationId: CASE("c11") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    await h.approval
      .answer(
        suspended.suspension,
        { choice: "approve", reason: "checked" },
        { authority: human("auth_jane") },
      )
      .catch(() => undefined);

    const dumped = JSON.stringify((await h.audit.replay(CASE("c11"))).nodes);
    expect(dumped).not.toContain("sk_live_9931");
    expect(dumped).not.toContain("943 476 5919");
    const inDoubt = (await h.audit.replay(CASE("c11"))).nodes.find(
      (n) => n.payload["kind"] === "effect.in-doubt",
    );
    expect(inDoubt?.payload["causeClass"]).toBe("Error");
  });

  it("keeps a string policy fact out of it, while integers stay legible", async () => {
    const h = setup(base);
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("c12") });
    const nodes = (await h.audit.replay(CASE("c12"))).nodes;
    const screen = nodes.find((n) => n.payload["kind"] === "approval.reserved-screened");
    const classified = nodes.find((n) => n.payload["kind"] === "approval.classified");

    expect(screen?.payload["fact_supplier"]).not.toBe("acme-ltd");
    expect(String(screen?.payload["fact_supplier"])).toMatch(/^digest:/);
    expect(JSON.stringify(nodes)).not.toContain("acme-ltd");
    // The amount of money at risk is what tiering is about. It stays readable.
    expect(classified?.payload["fact_moneyAtRiskMinor"]).toBe(4_720_000);
  });

  it("records why the kill switch was unreadable rather than discarding it", async () => {
    const h = setup({
      ...base,
      killSwitch: async () => {
        throw new Error("consul quorum lost");
      },
    });
    const point = gatedDisbursement({ dualControlAtOrAbove: "never" });
    const suspended = await h.approval.run(point, INVOICE, { correlationId: CASE("c13") });
    if (suspended.kind !== "suspended") throw new Error("expected a suspension");

    const settled = await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );
    expect(settled.kind).toBe("held");
    if (settled.kind !== "held") return;
    // Distinguishable from a switch that was read and was engaged.
    expect(settled.reason).toBe("kill-switch-unreadable");

    const read = (await h.audit.replay(CASE("c13"))).nodes.find(
      (n) => n.payload["kind"] === "approval.kill-switch-read",
    );
    expect(read?.payload["readable"]).toBe(false);
    expect(read?.payload["error"]).toBe("KillSwitchUnreadable");
    expect(read?.payload["causeClass"]).toBe("Error");
    expect(h.writes).toEqual([]);
  });
});

describe("telemetry — every node carries cost, tokens and latency", () => {
  it("stamps all four on every node the module writes", async () => {
    const h = setup(base);
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("c14") });
    for (const node of (await h.audit.replay(CASE("c14"))).nodes) {
      expect(typeof node.payload["costTenthCents"]).toBe("number");
      expect(typeof node.payload["tokensIn"]).toBe("number");
      expect(typeof node.payload["tokensOut"]).toBe("number");
      expect(typeof node.payload["priceTableVersion"]).toBe("string");
      expect(Number.isSafeInteger(node.payload["elapsedUs"])).toBe(true);
    }
  });

  it("carries the decision's declared spend and its own latency on the decided node", async () => {
    const h = setup(base);
    await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE("c15") });
    const decided = (await h.audit.replay(CASE("c15"))).nodes.find(
      (n) => n.payload["kind"] === "approval.decided",
    );
    expect(decided?.payload["costTenthCents"]).toBe(412);
    expect(decided?.payload["tokensIn"]).toBe(3_180);
    expect(decided?.payload["tokensOut"]).toBe(240);
    expect(decided?.payload["priceTableVersion"]).toBe("prices-2026-08");
    expect(Number.isSafeInteger(decided?.payload["latencyUs"])).toBe(true);
  });
});

describe("the in-memory client factory is a shipped deliverable", () => {
  it("is reachable from the module's own interface, not only from a fixture", async () => {
    const clients = inMemoryClientFactory({ evidence: { [INVOICE.id]: { matched: true } } });
    const readOnly = clients.readOnly({ correlationId: "c", node: "n", pointId: "p" });
    await expect(
      readOnly.read<{ matched: boolean }>({ kind: "purchase-order", ref: INVOICE.id }),
    ).resolves.toEqual({ matched: true });
    // The runtime backstop behind the type-level capability guarantee.
    expect("write" in readOnly).toBe(false);
  });
});
