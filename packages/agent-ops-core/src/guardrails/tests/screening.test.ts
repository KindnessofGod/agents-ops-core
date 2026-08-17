import { describe, expect, it } from "vitest";
import {
  CASE_A,
  harness,
  quietDetector,
  sameAtEveryTier,
  scriptedDetector,
  setOf,
} from "./fixtures.js";
import { NODE } from "../index.js";

/**
 * Slice 1 — a screening is a recorded node, and "nothing found" is an assertion
 * about a search performed.
 *
 * The two facts this slice pins down are the ones everything else rests on: a
 * detector cannot run before its screening exists in the trace, and an empty
 * finding list is never how absence is spelled.
 */

describe("guardrails — screenInput records before it screens", () => {
  const setup = () =>
    harness({
      detectorSets: sameAtEveryTier(
        setOf("cheap", [quietDetector("quiet", "prompt-injection phrasing")]),
      ),
    });

  it("writes the opened node before any detector runs", async () => {
    let kindsWhenDetectorRan: readonly string[] = [];
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("watchful", [
          scriptedDetector(
            "observer",
            async () => {
              kindsWhenDetectorRan = await h.kinds();
              return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
            },
            { searches: "when it was allowed to run" },
          ),
        ]),
      ),
    });

    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "the claimant reported a leak on the second floor" },
    });

    expect(kindsWhenDetectorRan).toEqual([NODE.opened]);
  });

  it("records the detector set that ran, its cost, and one node per detector", async () => {
    const h = setup();
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "invoice 8812 for roof repairs" },
    });

    expect(await h.kinds()).toEqual([
      NODE.opened,
      NODE.detector,
      NODE.payload,
      NODE.settled,
    ]);

    const opened = (await h.nodes())[0];
    expect(opened?.payload.detectorSet).toBe("cheap");
    expect(opened?.payload.detectorIds).toBe("quiet");
    expect(opened?.payload.locale).toBe("en-GB");

    const settled = (await h.nodes())[3];
    expect(settled?.parent).toBe(opened?.id);
    expect(settled?.payload.recommend).toBe("allow");
    expect(settled?.payload.costTenthCents).toBe(0);

    expect(screening.detectorSet).toBe("cheap");
    expect(screening.detectors).toHaveLength(1);
    expect(screening.cost.costTenthCents).toBe(0);
    expect(screening.nodes.settled).toBe(settled?.id);
  });

  it("spells absence as a search performed, never as an empty array", async () => {
    const h = setup();
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "medium",
      payload: { narrative: "nothing untoward here" },
    });

    expect(screening.findings).toEqual({
      searchedAndFoundNone: { searched: "prompt-injection phrasing" },
    });
    expect(screening.recommended).toEqual({ recommend: "allow" });
    // The distinction that matters: there is no `findings: []` to mistake for
    // "we looked and it was clean" when in fact nobody looked.
    expect("found" in screening.findings).toBe(false);
  });

  it("hangs the screening under a caller-named parent, recorded not inferred", async () => {
    const h = setup();
    const first = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "first look" },
    });
    const second = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "second look" },
      under: first.nodes.settled,
    });

    const nodes = await h.nodes();
    const openedSecond = nodes.find((n) => n.id === second.nodes.opened);
    expect(openedSecond?.parent).toBe(first.nodes.settled);
  });
});
