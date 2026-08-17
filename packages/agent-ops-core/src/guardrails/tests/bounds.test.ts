import { describe, expect, it } from "vitest";
import {
  CASE_A,
  EN_GB,
  harness,
  manualClock,
  manualTimer,
  quietDetector,
  sameAtEveryTier,
  scriptedClassifier,
  scriptedDetector,
  setOf,
} from "./fixtures.js";
import {
  DEFAULT_LIMITS,
  LimitsInvalid,
  NODE,
  createGuardrails,
  deterministicDetector,
  groundednessDetector,
  judgeGroundedness,
  safePattern,
  type NonEmpty,
  type Source,
  type SourceId,
} from "../index.js";

/**
 * Slice 13 — the bounds, checked rather than asserted.
 *
 * `limits.ts` claims "there is no unbounded anything in this module" and
 * `index.ts` claimed bounded fan-out, bounded budget per detector, bounded
 * payload and bounded finding list. Three of those were not true:
 *
 *   - no `Limits` value was range-checked, and `maxFindingsPerScreening: 0`
 *     turned a `block` into an `allow`;
 *   - a **synchronous** detector ignored `detectorBudgetMicros` entirely,
 *     because a synchronous body never yields and `Promise.race` is therefore
 *     never scheduled. The test below is what could be done from the engine's
 *     side alone — refuse the answer deterministically — and it still holds for
 *     any detector whose body does not yield. What was done about the *work* is
 *     in `safe-pattern.test.ts` and `deadline.test.ts`;
 *   - `judgeGroundedness` discarded the budget and handed every one of up to
 *     `maxClaims` sequential model calls a hardcoded `budgetMicros: 0`.
 */

describe("guardrails — every bound is a bound", () => {
  it("refuses a Limits value that is not a positive integer, at construction", () => {
    for (const bad of [
      { maxFindingsPerScreening: 0 },
      { detectorConcurrency: 0 },
      { maxFieldChars: -1 },
      { maxClaims: 1.5 },
    ]) {
      expect(() =>
        createGuardrails({
          audit: harness({ detectorSets: sameAtEveryTier(setOf("q", [quietDetector()])) }).audit,
          clock: manualClock(),
          timer: manualTimer(),
          locale: EN_GB,
          detectorSets: sameAtEveryTier(setOf("q", [quietDetector()])),
          limits: { ...DEFAULT_LIMITS, ...bad },
        }),
      ).toThrow(LimitsInvalid);
    }
  });

  it("builds the grounds from every finding, not from the truncated report", async () => {
    // The finding list is a *report*, and a report is not where a disposition
    // comes from. Two sanctions hits, a report bounded to one: the screening
    // still stands on both, and the settled node says how much of the report
    // was cut. Reading the disposition off the truncation is how a `block`
    // became an `allow` at `maxFindingsPerScreening: 0` — a value that is now
    // refused outright, and would still be wrong at any other value.
    const text = "one two three";
    const site = (start: number) => ({
      category: "prohibited-content" as const,
      severity: "escalate" as const,
      rule: `sanctions-hit-${start}`,
      at: { field: "narrative", startCodeUnit: start, lengthCodeUnits: 3 },
      confidenceBasisPoints: 9_900,
    });
    const h = harness({
      limits: { maxFindingsPerScreening: 1 },
      detectorSets: sameAtEveryTier(
        setOf("noisy", [
          scriptedDetector("noisy", () => ({
            outcome: "found",
            findings: [site(0), site(4)] as unknown as NonEmpty<never>,
            costTenthCents: 0,
            modelCalls: 0,
          })),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: text },
    });

    expect(screening.recommended.recommend).toBe("escalate");
    expect(
      screening.recommended.recommend === "escalate" ? screening.recommended.grounds : [],
    ).toHaveLength(2);
    const settled = (await h.nodes()).find((n) => n.payload.kind === NODE.settled);
    expect(settled?.payload["findingCount"]).toBe(1);
    expect(settled?.payload["findingsTruncated"]).toBe(1);
    expect(settled?.payload["searched"]).toBe("");
  });

  it("bounds a synchronous detector's answer against the clock, since it cannot be raced", async () => {
    // A synchronous body never yields, so `Promise.race` is not scheduled until
    // after it has finished: the timer cannot preempt it and no in-process
    // timer of any design could. What the engine can do is refuse the answer,
    // deterministically, against the injected clock.
    const clock = manualClock();
    const h = harness({
      clock,
      limits: { detectorBudgetMicros: 100_000 },
      detectorSets: sameAtEveryTier(
        setOf("spinner", [
          scriptedDetector("spinner", () => {
            clock.advance(600); // 600ms of synchronous work against a 100ms budget
            return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
          }),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });

    expect(screening.detectors[0].outcome).toBe("unavailable");
    expect(screening.recommended.recommend).toBe("abstain");
    const detector = (await h.nodes()).find((n) => n.payload.kind === NODE.detector);
    expect(detector?.payload["reason"]).toBe("timed-out");
    expect(detector?.payload["overBudget"]).toBe(true);
  });
});

describe("guardrails — the budget crosses the Groundedness seam", () => {
  it("divides the detector budget across the judge's claims instead of passing zero", async () => {
    const budgets: number[] = [];
    const source: Source = { id: "policy-1" as SourceId, text: "the invoice is approved" };
    const detector = groundednessDetector({
      id: "grounded.judge",
      locales: ["en-GB"] as unknown as NonEmpty<string>,
      groundedness: judgeGroundedness({
        classifier: scriptedClassifier(() => ({ supported: 9_000 }), {
          onCall: (request) => budgets.push(request.budgetMicros),
        }),
      }),
      minimumSupportBasisPoints: 5_000,
      severity: "escalate",
    });

    const h = harness({
      limits: { detectorBudgetMicros: 2_000_000 },
      detectorSets: sameAtEveryTier(setOf("grounded", [quietDetector()], [detector])),
    });

    const input = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });
    await h.guardrails.checkOutput({
      after: input,
      tier: "high",
      output: { answer: "The invoice is approved. It was checked twice. Payment follows." },
      sources: { available: true, items: [source] as unknown as NonEmpty<Source> },
    });

    expect(budgets).toHaveLength(3);
    // Divided, not discarded, and not handed out whole three times either.
    expect(budgets.every((b) => b > 0)).toBe(true);
    expect(budgets.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2_000_000);
  });
});

describe("guardrails — the timer still bounds an asynchronous detector", () => {
  it("records a detector that never answered as unavailable, without waiting for it", async () => {
    const never = scriptedDetector("never", () => new Promise<never>(() => {}));
    const h = harness({ detectorSets: sameAtEveryTier(setOf("hung", [never])) });

    const screening = h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });
    for (let i = 0; i < 100 && h.timer.outstanding === 0; i += 1) {
      await new Promise<void>((r) => setImmediate(r));
    }
    h.timer.fire();

    expect((await screening).recommended.recommend).toBe("abstain");
    expect((await screening).cost.unmeasuredDetectors).toBe(1);
  });
});

/**
 * The two allocations that used to grow with the payload rather than with the
 * wiring, and which `limits.ts` claimed did not exist.
 *
 * Both are on the shipped deterministic path, so both were reachable by any of
 * the nineteen applications with a pattern slightly wronger than intended — and
 * neither presented as a defect. One presented as memory; the other presented as
 * a clean redaction over text that had not been redacted.
 */
describe("guardrails — a detector's report is bounded, and the bound fails closed", () => {
  const dense = (maxMatchesPerScan?: number) =>
    deterministicDetector({
      id: "pii.dense",
      locales: ["en-GB"] as unknown as NonEmpty<string>,
      searches: "a pattern that matches everywhere",
      category: "personal-data",
      severity: "redact",
      ...(maxMatchesPerScan === undefined ? {} : { maxMatchesPerScan }),
      patterns: [
        safePattern({
          rule: "dense",
          match: /x/g,
          confidenceBasisPoints: 5_000,
          covers: "personal-data.name",
        }),
      ],
    });

  it("declares itself unavailable rather than reporting a partial redaction", async () => {
    const h = harness({ detectorSets: sameAtEveryTier(setOf("dense", [dense(16)])) });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "x".repeat(64) },
    });

    // The alternative — mask the first sixteen and write the other forty-eight
    // into a seven-year archive under `recommend: "redact-and-allow"` — is the
    // failure redaction exists to prevent. A screening that abstains is a
    // working system saying it could not do the job.
    expect(screening.recommended.recommend).toBe("abstain");
    expect(screening.recommended).toMatchObject({
      grounds: [{ ground: "detector-unavailable", reason: "declared" }],
    });
    expect(screening.payload.fields["narrative"]).toBe("x".repeat(64));
    expect(screening.coverage.maskedSites).toBe(0);
  });

  it("still reports normally below the bound", async () => {
    const h = harness({ detectorSets: sameAtEveryTier(setOf("dense", [dense(16)])) });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "x-x" },
    });
    expect(screening.recommended.recommend).toBe("redact-and-allow");
    expect(screening.payload.fields["narrative"]).toBe("[redacted]-[redacted]");
  });

  it("refuses a nonsensical bound at construction, not at screening time", () => {
    expect(() => dense(0)).toThrow(LimitsInvalid);
  });
});

describe("guardrails — grounds are bounded by the wiring, not by the payload", () => {
  it("raises one ground per rule that fired, however many sites it fired at", async () => {
    const many = deterministicDetector({
      id: "content.blocked",
      locales: ["en-GB"] as unknown as NonEmpty<string>,
      searches: "a blocked word",
      category: "prohibited-content",
      severity: "block",
      patterns: [
        safePattern({
          rule: "blocked.word",
          match: /nope/g,
          confidenceBasisPoints: 9_000,
          covers: "prompt-injection.instruction-override",
        }),
      ],
    });
    const h = harness({ detectorSets: sameAtEveryTier(setOf("blocked", [many])) });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "nope ".repeat(50) },
    });

    // Fifty sites, one rule, one ground. A ground carries no coordinates, so
    // fifty copies of it were fifty identical objects on the returned screening
    // and tens of kilobytes of `groundKinds` on the settled node — with a real
    // chance of `audit` refusing the very node that explains the screening.
    expect(screening.recommended.recommend).toBe("abstain");
    expect(screening.recommended).toMatchObject({
      grounds: [{ ground: "finding", rule: "blocked.word", severity: "block" }],
    });
    if (!("grounds" in screening.recommended)) throw new Error("expected grounds");
    expect(screening.recommended.grounds).toHaveLength(1);
    // Nothing observable was lost: every site is still a finding.
    if (!("found" in screening.findings)) throw new Error("expected findings");
    expect(screening.findings.found).toHaveLength(50);
  });
});
