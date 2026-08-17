import { describe, expect, it } from "vitest";
import {
  CASE_A,
  harness,
  quietDetector,
  sameAtEveryTier,
  scriptedDetector,
  setOf,
  whenWaiting,
} from "./fixtures.js";
import { DetectorReportInvalid, NODE, type DetectorReport } from "../index.js";

/**
 * Slice 3 — a detector that errors yields abstain-recommended, never allow.
 *
 * At every tier, with no configuration key that changes it. This is
 * deliberately the **opposite** of `audit`'s tiered fail policy, and the reason
 * is that the two modules are failing at different things: an unrecordable
 * decision is a gap in the evidence about work that was nonetheless done, whose
 * cost genuinely differs between a ticket routing and a £2M disbursement; an
 * unscreened payload is a gap in the work itself, and there is no tier at which
 * "we did not check, so we allowed it" is defensible.
 *
 * Note what is *not* tested here: an abstain-recommended screening throwing.
 * Per `CONTEXT.md` an abstention is a successful outcome of a working system,
 * not an error, so it is returned. A caller's `catch` must never be able to
 * turn a deliberate refusal into a retry.
 */

const three: readonly ("low" | "medium" | "high")[] = ["low", "medium", "high"];

describe("guardrails — fail-closed at every tier", () => {
  it.each(three)("recommends abstain when a detector throws, at %s tier", async (tier) => {
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("mixed", [
          quietDetector("quiet", "prompt-injection phrasing"),
          scriptedDetector("flaky", () => {
            throw new Error("classifier connection reset");
          }),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier,
      payload: { narrative: "perfectly ordinary text" },
    });

    expect(screening.recommended.recommend).toBe("abstain");
    expect(screening.recommended).toMatchObject({
      grounds: [
        {
          ground: "detector-unavailable",
          detector: "flaky",
          reason: "threw",
        },
      ],
    });
  });

  it("does not let a healthy detector's clean result become an allow", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("mixed", [
          quietDetector("quiet", "prompt-injection phrasing"),
          scriptedDetector("down", () => ({
            outcome: "unavailable",
            reason: "declared",
            detail: "classifier returned 503",
          })),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "ordinary" },
    });

    expect(screening.recommended.recommend).toBe("abstain");
    // The honest half: the search that *did* happen is still named, so the
    // trace says what was covered rather than throwing the clean result away.
    expect(screening.findings).toEqual({
      searchedAndFoundNone: { searched: "prompt-injection phrasing" },
    });
  });

  it("will not claim a search was performed when no detector completed one", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("all-down", [
          scriptedDetector("down", () => ({
            outcome: "unavailable",
            reason: "declared",
            detail: "classifier returned 503",
          })),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });

    expect(screening.findings).toEqual({
      couldNotSearch: { why: "no detector completed a search (1 ran, all unavailable)" },
    });
    expect(screening.recommended.recommend).toBe("abstain");
  });

  it("bounds a detector that never answers, and records why", async () => {
    let released: (() => void) | undefined;
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("hanging", [
          scriptedDetector(
            "hangs",
            () =>
              new Promise<DetectorReport>((resolve) => {
                released = () =>
                  resolve({
                    outcome: "searched-and-found-none",
                    costTenthCents: 0,
                    modelCalls: 0,
                  });
              }),
          ),
        ]),
      ),
    });

    const pending = h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });
    // The budget elapses on the injected timer. No real waiting, which is why
    // this branch is tested at all rather than merely written.
    await whenWaiting(h.timer);
    h.timer.fire();
    const screening = await pending;
    released?.();

    expect(screening.recommended).toMatchObject({
      recommend: "abstain",
      grounds: [{ ground: "detector-unavailable", detector: "hangs", reason: "timed-out" }],
    });

    const detectorNode = (await h.nodes()).find((n) => n.payload.kind === NODE.detector);
    expect(detectorNode?.payload.outcome).toBe("unavailable");
    expect(detectorNode?.payload.reason).toBe("timed-out");
  });

  it("treats a malformed report as a defect in a detector, not an outage in one", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("broken", [
          scriptedDetector(
            "broken",
            () => ({ outcome: "found", findings: [], costTenthCents: 0, modelCalls: 0 }) as never,
          ),
        ]),
      ),
    });

    // Degrading this to an abstention would let a broken detector look like a
    // cautious one, and the build would stay green while a whole category
    // stopped being screened.
    await expect(
      h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "low",
        payload: { narrative: "ordinary" },
      }),
    ).rejects.toBeInstanceOf(DetectorReportInvalid);

    // The evidence survives the throw: the screening opened, the detector's
    // failure is on the trace, and the screening says it was abandoned. That
    // last node is not decoration — without it, a trace that stops after a
    // detector node is indistinguishable from one whose process died, and those
    // are different incidents.
    expect(await h.kinds()).toEqual([NODE.opened, NODE.detector, NODE.abandoned]);
  });

  it("refuses a detector that tries to classify its own incident", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("liar", [
          scriptedDetector(
            "liar",
            () => ({ outcome: "unavailable", reason: "timed-out", detail: "not my call" }) as never,
          ),
        ]),
      ),
    });

    await expect(
      h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "low",
        payload: { narrative: "ordinary" },
      }),
    ).rejects.toBeInstanceOf(DetectorReportInvalid);
  });
});
