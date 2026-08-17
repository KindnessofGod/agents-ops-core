import { describe, expect, it } from "vitest";
import {
  AuthorityNotOffered,
  DualControlSelfApproval,
  type KillSwitchReader,
} from "../index.js";
import { CASE, harness, human, neverReserved, tierBy } from "./fixtures/harness.js";
import { INVOICE, gatedDisbursement } from "./fixtures/points.js";
import { compileFixture } from "./typecheck.js";

/**
 * Slice 7 — dual control, the approval brief, the kill switch, and the three
 * anti-rubber-stamping countermeasures.
 *
 * Dual control where the second person is shown "Jane approved this" is not two
 * decisions; it is Jane's decision with an echo.
 */

const setup = (killSwitch?: KillSwitchReader) =>
  harness({
    points: [gatedDisbursement()],
    tierPolicy: tierBy({ disburse: "high" }),
    reservedPolicy: neverReserved(),
    evidence: { [INVOICE.id]: { matched: true } },
    members: [human("auth_jane"), human("auth_ravi"), human("auth_dowen")],
    ...(killSwitch === undefined ? {} : { killSwitch }),
  });

const suspend = async (h: ReturnType<typeof setup>, id: string) => {
  const r = await h.approval.run(gatedDisbursement(), INVOICE, { correlationId: CASE(id) });
  if (r.kind !== "suspended") throw new Error("expected a suspension");
  return r;
};

describe("dual control — the second seat cannot see the first's verdict", () => {
  // A generous timeout, not a slow test. This case runs the TypeScript
  // compiler in-process over a fixture; under `vitest`'s default parallelism
  // several such cases compile at once and the 5s default is a coin flip on a
  // loaded machine. A flaky gate is worse than a slow one — it teaches people
  // to re-run rather than to read.
  it("has no representation for it, proved by the compiler", () => {
    expect(compileFixture("dual-control-rejected.ts")).toEqual([]);
  }, 30_000);

  it("serves a second brief carrying who and when, and nothing about what", async () => {
    const h = setup();
    const suspended = await suspend(h, "d1");

    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "purchase order checked with the buyer" },
      { authority: human("auth_jane") },
    );

    const second = h.renderer.presented[1];
    expect(second?.brief.seat).toBe("second");
    if (second?.brief.seat !== "second") return;

    expect(second.brief.priorAnswer.by).toBe(human("auth_jane").id);
    expect(Object.keys(second.brief.priorAnswer).sort()).toEqual(["at", "by", "node"]);

    // Nothing anywhere in the served value discloses the first answer, so a
    // renderer that walked every field could still not display it.
    const serialised = JSON.stringify(second.brief);
    expect(serialised).not.toContain('"approve"');
    expect(serialised).not.toContain('"refuse"');
    expect(serialised).not.toContain("purchase order checked with the buyer");
  });

  it("narrows the directory before it is asked, so the first approver is never offered it", async () => {
    const h = setup();
    const suspended = await suspend(h, "d2");
    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    const second = h.renderer.presented[1];
    expect(second?.to.map((a) => a.id)).not.toContain(human("auth_jane").id);
    expect(second?.to.map((a) => a.id)).toContain(human("auth_ravi").id);
  });

  it("refuses a self-approval structurally, and keeps the suspension open", async () => {
    const h = setup();
    const suspended = await suspend(h, "d3");
    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    // `AuthorityNotOffered`, NOT `DualControlSelfApproval`. The second seat's
    // offered set was computed from a directory already narrowed by
    // `excluding: [auth_jane]`, so the first approver is not merely
    // un-notified — they are unable to answer. "The second approver must be
    // unable to be the first" is enforced by the durable set, not by a string
    // comparison.
    await expect(
      h.approval.answer(
        suspended.suspension,
        { choice: "approve", reason: "and again" },
        { authority: human("auth_jane") },
      ),
    ).rejects.toBeInstanceOf(AuthorityNotOffered);

    expect((await h.store.loadSuspension(suspended.suspension))?.state).toBe("awaiting");
    const settled = await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "countersigned" },
      { authority: human("auth_ravi") },
    );
    expect(settled.kind).toBe("executed");
    expect(h.writes).toHaveLength(1);
  });

  it("still has the string comparison as a backstop for a directory that lies", async () => {
    // A directory that ignores `excluding` and hands the first approver the
    // second seat's brief. This is the ONLY condition under which
    // `DualControlSelfApproval` is reachable, which is what makes it a backstop
    // rather than the mechanism.
    const members = [human("auth_jane"), human("auth_ravi")];
    const lying = {
      candidates: async () => members,
      resolve: async () => members,
    };
    const h = harness({
      points: [gatedDisbursement()],
      tierPolicy: tierBy({ disburse: "high" }),
      reservedPolicy: neverReserved(),
      evidence: { [INVOICE.id]: { matched: true } },
      authorities: lying,
    });
    const first = await h.approval.run(gatedDisbursement(), INVOICE, {
      correlationId: CASE("d3b"),
    });
    if (first.kind !== "suspended") throw new Error("expected a suspension");
    await h.approval.answer(
      first.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );

    expect((await h.store.loadSuspension(first.suspension))?.offeredTo).toContain(
      human("auth_jane").id,
    );
    await expect(
      h.approval.answer(
        first.suspension,
        { choice: "approve", reason: "and again" },
        { authority: human("auth_jane") },
      ),
    ).rejects.toBeInstanceOf(DualControlSelfApproval);
    expect(h.writes).toHaveLength(0);
  });
});

describe("brief — every required field, and 'none' as an assertion", () => {
  it("serves all seven required contents", async () => {
    const h = setup();
    await suspend(h, "d4");
    const brief = h.renderer.presented[0]?.brief;
    if (brief === undefined) throw new Error("expected a brief");

    expect(brief.effectInConcreteTerms).toContain("£47,200"); // 1, in the approver's units
    expect(brief.concluded.evidence.length).toBeGreaterThan(0); // 2, reachable
    expect(brief.unsureAbout.length).toBeGreaterThan(0); // 3
    expect(brief.couldNotCheck).toBeDefined(); // 4
    expect(brief.reserved.reserved).toBe(false); // 5, with a policy version
    expect(brief.doNothing.ladder.steps.length).toBeGreaterThan(0); // 6
    expect(brief.correlationId).toBe(CASE("d4")); // 7
  });

  it("states contrary evidence as a search performed, never as an empty list", async () => {
    const h = setup();
    await suspend(h, "d5");
    const brief = h.renderer.presented[0]?.brief;
    if (brief === undefined) throw new Error("expected a brief");

    // Absence of a finding is not a finding.
    expect("found" in brief.contrary).toBe(false);
    if ("searchedAndFoundNone" in brief.contrary) {
      expect(brief.contrary.searchedAndFoundNone.searched).toContain("last 90 days");
    }
  });

  it("tells the approver what happens if they do nothing", async () => {
    const h = setup();
    const suspended = await suspend(h, "d6");
    // Indefinite hold here, and the ladder that runs while it holds. An
    // approver who does not know the cost of waiting cannot weigh it.
    expect(suspended.doNothing.expire).toBeNull();
    expect(suspended.doNothing.ladder.recurrence.every).toBeGreaterThan(0);
  });

  it("carries evidence as handles, so the trace is not a copy of the evidence", async () => {
    const h = setup();
    await suspend(h, "d7");
    const brief = h.renderer.presented[0]?.brief;
    expect(brief?.concluded.evidence[0]).toEqual({
      kind: "purchase-order",
      ref: INVOICE.id,
    });

    // The trace records the digest of what was served and to whom, not its
    // contents.
    const presented = (await h.audit.replay(CASE("d7"))).nodes.find(
      (n) => n.payload["kind"] === "approval.brief-presented",
    );
    expect(presented?.payload["briefDigest"]).toEqual(expect.any(String));
    expect(JSON.stringify(presented?.payload)).not.toContain("£47,200");
  });
});

describe("anti-rubber-stamping — record the signal, set no threshold", () => {
  it("records time-to-decision on every approval", async () => {
    const h = setup();
    const suspended = await suspend(h, "d8");

    h.clock.advance(4 * 60_000 + 51_000);
    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );
    h.clock.advance(1_200);
    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "countersigned" },
      { authority: human("auth_ravi") },
    );

    const answered = (await h.audit.replay(CASE("d8"))).nodes.filter(
      (n) => n.payload["kind"] === "approval.answered",
    );
    expect(answered.map((n) => n.payload["timeToDecisionMs"])).toEqual([291_000, 1_200]);

    // A 1.2-second approval is visible without anyone having to allege it, and
    // the library does not decide that it was too fast: a £200 expense and a
    // £2M disbursement do not share a plausible reading time.
    const anyThreshold = answered.some((n) =>
      Object.keys(n.payload).some((k) => k.toLowerCase().includes("threshold")),
    );
    expect(anyThreshold).toBe(false);
  });

  it("stamps what the measurement is actually measuring", async () => {
    const h = setup();
    await suspend(h, "d9");
    const presented = (await h.audit.replay(CASE("d9"))).nodes.find(
      (n) => n.payload["kind"] === "approval.brief-presented",
    );
    // Honest limit on the artefact rather than in a wiki: time since
    // notification, not time on screen.
    expect(presented?.payload["timeToDecisionMeasuredFrom"]).toBe("notification");
  });

  it("makes approving and refusing cost the same", async () => {
    const h = setup();
    const suspended = await suspend(h, "d10");
    // Both arms of `ApproverAnswer` require a reason. There is no
    // `{ choice: "approve" }` that typechecks on its own.
    const settled = await h.approval.answer(
      suspended.suspension,
      { choice: "refuse", reason: "supplier bank details unverified" },
      { authority: human("auth_jane") },
    );
    expect(settled.kind).toBe("refused");
    expect(h.writes).toEqual([]);
  });
});

describe("kill switch — stops effects, never decisions", () => {
  it("records the whole decision and both approvals, and moves no money", async () => {
    const h = setup(async () => ({
      engaged: true,
      scope: { kind: "tiers", tiers: ["high"] },
      by: "auth_ops_lead",
      at: 1_700_000_000_000,
    }));
    const suspended = await suspend(h, "d11");

    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );
    const settled = await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "countersigned" },
      { authority: human("auth_ravi") },
    );

    expect(settled.kind).toBe("held");
    expect(h.writes).toEqual([]);

    const kinds = (await h.audit.replay(CASE("d11"))).nodes.map((n) => n.payload["kind"]);
    // The evidence of what the system WOULD have done during the incident is
    // exactly what the switch exists to preserve.
    expect(kinds).toContain("approval.decided");
    expect(kinds.filter((k) => k === "approval.answered")).toHaveLength(2);
    expect(kinds).toContain("approval.kill-switch-read");
    expect(kinds).not.toContain("effect.attempting");
  });

  it("is read at execute, not at classify", async () => {
    let reads = 0;
    const h = setup(async () => {
      reads += 1;
      return { engaged: false };
    });
    await suspend(h, "d12");
    // Classified, screened, decided, brief built, suspended — and the switch
    // has not been consulted, because no effect is near.
    expect(reads).toBe(0);
  });

  it("treats an unreadable switch as engaged", async () => {
    const h = setup(async () => {
      throw new Error("flag store unreachable");
    });
    const suspended = await suspend(h, "d13");
    await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "checked" },
      { authority: human("auth_jane") },
    );
    const settled = await h.approval.answer(
      suspended.suspension,
      { choice: "approve", reason: "countersigned" },
      { authority: human("auth_ravi") },
    );

    // Fail-closed. Cheap; the alternative is paying during an incident.
    expect(settled.kind).toBe("held");
    const read = (await h.audit.replay(CASE("d13"))).nodes.find(
      (n) => n.payload["kind"] === "approval.kill-switch-read",
    );
    expect(read?.payload["readable"]).toBe(false);
    expect(read?.payload["engaged"]).toBe(true);
  });
});
