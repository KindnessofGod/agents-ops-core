import { describe, expect, it } from "vitest";
import {
  AuthorityNotOffered,
  EffectDeclarationDrifted,
  LicenceExpired,
  PointSchemaChanged,
} from "../index.js";
import {
  CASE,
  alwaysReserved,
  harness,
  human,
  neverReserved,
  tierBy,
} from "./fixtures/harness.js";
import { INVOICE, gatedDisbursement } from "./fixtures/points.js";

/**
 * Rework slice A — the answering authority is authorised, the declaration the
 * case was frozen against still holds, and a stale approval is not approval.
 *
 * Every test here failed before the fix. `answer` used to trust whatever
 * identity the calling surface asserted: `AuthorityDirectory` was consulted
 * only to decide who was *shown* the brief.
 */

interface SetupOptions {
  readonly members?: readonly ReturnType<typeof human>[];
  readonly reservedPolicy?: ReturnType<typeof neverReserved>;
}

const setup = (options: SetupOptions = {}) =>
  harness({
    points: [gatedDisbursement()],
    tierPolicy: tierBy({ disburse: "high" }),
    reservedPolicy: options.reservedPolicy ?? neverReserved(),
    evidence: { [INVOICE.id]: { matched: true } },
    members: options.members ?? [human("auth_jane"), human("auth_ravi")],
  });

const suspend = async (h: ReturnType<typeof setup>, id: string) => {
  const r = await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE(id) });
  if (r.kind !== "suspended") throw new Error("expected a suspension");
  return r;
};

describe("answer — the answerer is authorised, not merely asserted", () => {
  it("refuses an authority the directory never offered the brief to", async () => {
    const h = setup({ reservedPolicy: alwaysReserved() });
    const suspended = await suspend(h, "a1");

    await expect(
      h.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "trust me" },
        { authority: human("auth_nobody") },
      ),
    ).rejects.toBeInstanceOf(AuthorityNotOffered);

    expect(h.writes).toEqual([]);
    expect((await h.store.loadSuspension(suspended.suspension))?.state).toBe("awaiting");

    const kinds = (await h.audit.replay(CASE("a1"))).nodes.map((n) => String(n.payload["kind"]));
    expect(kinds).toContain("approval.authority-not-offered");
  });

  it("refuses two fabricated identities standing in for dual control", async () => {
    const h = setup();
    const suspended = await suspend(h, "a2");

    await expect(
      h.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "one" },
        { authority: human("ghost_1") },
      ),
    ).rejects.toBeInstanceOf(AuthorityNotOffered);
    await expect(
      h.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "two" },
        { authority: human("ghost_2") },
      ),
    ).rejects.toBeInstanceOf(AuthorityNotOffered);

    expect(h.writes).toEqual([]);
  });

  it("makes dual-control distinctness structural: the first approver is not in the second seat's offer", async () => {
    const h = setup();
    const suspended = await suspend(h, "a3");
    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    const record = await h.store.loadSuspension(suspended.suspension);
    expect(record?.seat).toBe("second");
    // Not a string comparison in `answer` — the durable record of who may
    // answer excludes the first approver, so there is nothing to compare.
    expect(record?.offeredTo).not.toContain(human("auth_jane").id);
    expect(record?.offeredTo).toContain(human("auth_ravi").id);
  });

  it("records who was offered the brief, so the offer is evidence rather than an assertion", async () => {
    const h = setup();
    const suspended = await suspend(h, "a4");
    const record = await h.store.loadSuspension(suspended.suspension);
    expect([...(record?.offeredTo ?? [])].sort()).toEqual(["auth_jane", "auth_ravi"]);
  });
});

describe("answer — the declaration the case was frozen against still holds", () => {
  it("refuses a point whose schema version changed under a waiting case", async () => {
    const h = setup();
    const suspended = await suspend(h, "a5");

    const drifted = gatedDisbursement();
    const restarted = h.restart({
      points: [{ ...drifted, spec: { ...drifted.spec, schemaVersion: 9 } } as typeof drifted],
    });

    await expect(
      restarted.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "checked" },
        { authority: human("auth_jane") },
      ),
    ).rejects.toBeInstanceOf(PointSchemaChanged);
    expect(h.writes).toEqual([]);
  });

  it("refuses an effect declaration whose schema version changed under a waiting case", async () => {
    const h = setup();
    const suspended = await suspend(h, "a6");

    const drifted = gatedDisbursement();
    const spec = drifted.spec as typeof drifted.spec & { effect: { schemaVersion: number } };
    const restarted = h.restart({
      points: [
        {
          ...drifted,
          spec: { ...spec, effect: { ...spec.effect, schemaVersion: 7 } },
        } as typeof drifted,
      ],
    });

    await expect(
      restarted.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "checked" },
        { authority: human("auth_jane") },
      ),
    ).rejects.toBeInstanceOf(EffectDeclarationDrifted);
    expect(h.writes).toEqual([]);
  });
});

describe("licence — a stale approval is not approval", () => {
  it("refuses to execute when the first approval has aged past licenceValidFor", async () => {
    const h = setup();
    const suspended = await suspend(h, "a7");
    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    // licenceValidFor on the fixture is 24h. The second seat answers on day
    // three.
    h.clock.advance(3 * 24 * 3_600_000);

    await expect(
      h.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "countersigned" },
        { authority: human("auth_ravi") },
      ),
    ).rejects.toBeInstanceOf(LicenceExpired);

    expect(h.writes).toEqual([]);
    // Still answerable — and back at the first seat, because the stale
    // approval is not approval and the ladder restarts.
    const record = await h.store.loadSuspension(suspended.suspension);
    expect(record?.state).toBe("awaiting");
    expect(record?.seat).toBe("first");
    expect(record?.firstAnswer).toBeNull();

    const kinds = (await h.audit.replay(CASE("a7"))).nodes.map((n) => String(n.payload["kind"]));
    expect(kinds).toContain("approval.licence-expired");
  });
});
