import { describe, expect, it } from "vitest";
import { CASE_A, EN_GB, harness, sameAtEveryTier, scriptedClassifier, setOf, type ManualClock } from "./fixtures.js";
import { NODE, modelDetector, personalDataDetector, type NonEmpty } from "../index.js";

/**
 * Slice 16 — the budget bounds the work, not only the answer.
 *
 * `detectorBudgetMicros` used to bound the *answer*: an overrun was measured
 * after the fact and recorded `unavailable/timed-out`, which fails the screening
 * closed and is worth a great deal — but the detector kept running, and a
 * synchronous one could not be preempted by any timer of any design.
 *
 * A detector now receives a `deadline`: one bit, over the engine's own injected
 * clock, checked between units of work by both shipped adapters. So the
 * deterministic scan stops between patterns and the model scan stops between
 * calls, and neither can compound a slow unit into a slow screening.
 *
 * The honest limit these tests are careful not to overclaim: nothing here
 * preempts a unit already in flight. A pattern that has begun scanning a field
 * finishes scanning that field.
 */

/**
 * A clock that advances on every reading. Not a fake of a real clock's
 * behaviour — a way of putting the passage of time under the test's control
 * without waiting for it, which is what makes the deadline branch tested rather
 * than merely written.
 */
const tickingClock = (stepMs: number, start = 1_700_000_000_000): ManualClock => {
  let t = start;
  return {
    now: () => {
      const seen = t;
      t += stepMs;
      return seen;
    },
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
};

describe("guardrails — a deterministic scan stops when its budget is spent", () => {
  it("abandons the remaining patterns and says how far it got", async () => {
    // The shipped United Kingdom pack is eight patterns. With time advancing on
    // every reading and a budget of a few ticks, the scan runs out partway
    // through — which before this could only be observed after every pattern had
    // already run.
    const h = harness({
      locale: EN_GB,
      clock: tickingClock(40),
      limits: { detectorBudgetMicros: 100_000 },
      detectorSets: sameAtEveryTier(setOf("pii", [personalDataDetector({ locale: EN_GB })])),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "her number is AB 12 34 56 C" },
    });

    expect(screening.detectors[0].outcome).toBe("unavailable");
    // Fail-closed, at every tier, with no configuration key that changes it.
    expect(screening.recommended.recommend).toBe("abstain");

    const node = (await h.nodes()).find((n) => n.payload.kind === NODE.detector);
    // `declared`, not `timed-out`: the detector observed its own budget and said
    // so. A detector may name its dependency failing; it may not classify its
    // own incident, and "timed-out" is the engine's word.
    expect(node?.payload["reason"]).toBe("declared");
    expect(String(node?.payload["detail"])).toContain("budget spent after");
    // And what it could not search is recorded as such, rather than as a search
    // that found nothing.
    expect("couldNotSearch" in screening.findings).toBe(true);
  });

  it("does not fire when there is budget left, so the bound is a bound and not a brake", async () => {
    const h = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(setOf("pii", [personalDataDetector({ locale: EN_GB })])),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "her number is AB 12 34 56 C" },
    });
    expect(screening.detectors[0].outcome).toBe("found");
  });
});

describe("guardrails — a model detector stops between classifier calls", () => {
  it("does not spend the sixth call once the budget is gone, and reports what it spent", async () => {
    const calls: number[] = [];
    const detector = modelDetector({
      id: "injection.model",
      locales: ["en-GB"] as unknown as NonEmpty<string>,
      searches: "injection attempts",
      category: "prompt-injection",
      severity: "escalate",
      classifier: scriptedClassifier(() => ({ injection: 10 }), {
        onCall: () => calls.push(1),
      }),
      labels: ["injection"] as unknown as NonEmpty<string>,
      thresholdBasisPoints: 5_000,
    });

    const h = harness({
      locale: EN_GB,
      clock: tickingClock(30),
      limits: { detectorBudgetMicros: 90_000 },
      detectorSets: sameAtEveryTier(setOf("model", [detector])),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { a: "one", b: "two", c: "three", d: "four", e: "five", f: "six" },
    });

    expect(calls.length).toBeLessThan(6);
    expect(screening.detectors[0].outcome).toBe("unavailable");
    // A detector that spent money before running out **can** say so, and this
    // one does: absent is not zero, and a zero here would have made real spend
    // invisible on exactly the path where it is most likely to have happened.
    expect(screening.detectors[0].costMeasured).toBe(true);
    expect(screening.detectors[0].costTenthCents).toBeGreaterThan(0);
  });
});
