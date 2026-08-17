import { describe, expect, it } from "vitest";
import {
  createAudit,
  inMemoryTraceStore,
  redactFields,
  type AppendInput,
  type RecordedNode,
  type TraceStore,
} from "../../audit/index.js";
import {
  CASE_A,
  EN_GB,
  harness,
  manualClock,
  quietDetector,
  sameAtEveryTier,
  scriptedDetector,
  setOf,
  manualTimer,
} from "./fixtures.js";
import {
  DEFAULT_LIMITS,
  NODE,
  ScreeningLimitExceeded,
  ScreeningNotRecorded,
  createGuardrails,
  type DetectorReport,
} from "../index.js";

/**
 * Slice 9 — production grade: bounds, concurrency, the clock, and what happens
 * when the trace store is the thing that fails.
 */

/** A store that refuses the nth append. Everything else is the real adapter. */
const failingStore = (failOn: number): TraceStore => {
  const inner = inMemoryTraceStore();
  let appends = 0;
  // Spread the real adapter rather than rebuild it: `audit` says a delegating
  // wrapper is a legitimate thing to build, and spreading carries the brand
  // along with the methods. Rebuilding by hand does not satisfy `TraceStore`.
  return {
    ...inner,
    async append(input: AppendInput): Promise<RecordedNode> {
      appends += 1;
      if (appends === failOn) throw new Error("trace store connection reset");
      return inner.append(input);
    },
    closeCase: (id, at, outcome) => inner.closeCase(id, at, outcome),
    read: (id) => inner.read(id),
  };
};

describe("guardrails — recording is fail-closed at every tier", () => {
  it("throws rather than screening when the opened node cannot be written", async () => {
    let detectorRan = false;
    const store = failingStore(1);
    const clock = manualClock();
    const guardrails = createGuardrails({
      // The tiered policy `audit` permits is deliberately overridden here: this
      // module narrows it to fail-closed for its own writes. A low-tier
      // screening with no node behind it is an assertion, not evidence.
      audit: createAudit({
        store,
        clock,
        redact: redactFields([]),
        onTraceUnavailable: { high: "fail-closed", medium: "degrade", low: "degrade" },
      }),
      clock,
      timer: manualTimer(),
      locale: EN_GB,
      detectorSets: sameAtEveryTier(
        setOf("cheap", [
          scriptedDetector("counter", () => {
            detectorRan = true;
            return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
          }),
        ]),
      ),
      limits: DEFAULT_LIMITS,
    });

    await expect(
      guardrails.screenInput({
        correlationId: CASE_A,
        tier: "low",
        payload: { narrative: "ordinary" },
      }),
    ).rejects.toBeInstanceOf(ScreeningNotRecorded);
    expect(detectorRan).toBe(false);
  });

  it("refuses to hand back a Screening whose settled node was dropped", async () => {
    const store = failingStore(4);
    const clock = manualClock();
    const guardrails = createGuardrails({
      audit: createAudit({
        store,
        clock,
        redact: redactFields([]),
        onTraceUnavailable: { high: "fail-closed", medium: "degrade", low: "degrade" },
      }),
      clock,
      timer: manualTimer(),
      locale: EN_GB,
      detectorSets: sameAtEveryTier(setOf("cheap", [quietDetector()])),
      limits: DEFAULT_LIMITS,
    });

    // No `Screening`, therefore no `ScreenedPayload`, therefore nothing for the
    // caller to proceed with. That is the whole mechanism, stated as a test.
    await expect(
      guardrails.screenInput({
        correlationId: CASE_A,
        tier: "low",
        payload: { narrative: "ordinary" },
      }),
    ).rejects.toBeInstanceOf(ScreeningNotRecorded);
  });
});

describe("guardrails — bounded resources", () => {
  it("refuses an oversized payload rather than screening part of it", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(setOf("cheap", [quietDetector()])),
      limits: { maxFields: 2, maxFieldChars: 16 },
    });

    // Truncating would produce a `Screening` asserting a search over text
    // nobody searched — evidence of a check that did not happen.
    await expect(
      h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "low",
        payload: { a: "1", b: "2", c: "3" },
      }),
    ).rejects.toBeInstanceOf(ScreeningLimitExceeded);

    await expect(
      h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "low",
        payload: { a: "x".repeat(17) },
      }),
    ).rejects.toBeInstanceOf(ScreeningLimitExceeded);

    // Nothing was opened, so nothing claims a screening happened.
    expect(await h.kinds()).toEqual([]);
  });

  it("never runs more detectors at once than the bound allows", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const slow = (id: string) =>
      scriptedDetector(id, () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<DetectorReport>((resolve) => {
          release.push(() => {
            inFlight -= 1;
            resolve({ outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 });
          });
        });
      });

    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("many", [slow("a"), slow("b"), slow("c"), slow("d"), slow("e")]),
      ),
      limits: { detectorConcurrency: 2 },
    });

    const pending = h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });
    for (let i = 0; i < 40 && release.length < 5; i += 1) {
      release.shift()?.();
      await new Promise<void>((r) => setImmediate(r));
    }
    while (release.length > 0) {
      release.shift()?.();
      await new Promise<void>((r) => setImmediate(r));
    }
    await pending;

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("bounds the reported finding list, and masks everything anyway", async () => {
    // The trap this avoids: truncating findings *before* masking would leak
    // exactly the personal data the truncation was meant to bound.
    const sites = Array.from({ length: 5 }, (_, i) => ({
      field: "narrative",
      startCodeUnit: i * 4,
      lengthCodeUnits: 3,
    }));
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("noisy", [
          scriptedDetector("noisy", () => ({
            outcome: "found",
            findings: sites.map((at) => ({
              category: "personal-data" as const,
              severity: "redact" as const,
              rule: `site-${at.startCodeUnit}`,
              at,
              confidenceBasisPoints: 9_000,
            })) as never,
            costTenthCents: 0,
            modelCalls: 0,
          })),
        ]),
      ),
      limits: { maxFindingsPerScreening: 2 },
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "aaa bbb ccc ddd eee" },
    });

    expect(screening.payload.maskedSites).toBe(5);
    expect(screening.payload.fields["narrative"]).not.toContain("eee");
    const settled = (await h.nodes()).find((n) => n.payload.kind === NODE.settled);
    expect(settled?.payload.findingCount).toBe(2);
    // The trace never claims the list is complete when it is not.
    expect(settled?.payload.findingsTruncated).toBe(3);
  });
});

describe("guardrails — the clock is injected", () => {
  it("derives every recorded time from the injected clock, never Date.now()", async () => {
    const clock = manualClock(1_000_000);
    const h = harness({
      clock,
      detectorSets: sameAtEveryTier(
        setOf("slow", [
          scriptedDetector("slow", () => {
            clock.advance(250);
            return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
          }),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "ordinary" },
    });

    expect(screening.at).toBe(1_000_250);
    expect(screening.cost.latencyMicros).toBe(250_000);
    expect(screening.detectors[0].latencyMicros).toBe(250_000);
    for (const node of await h.nodes()) {
      expect(node.at).toBeGreaterThanOrEqual(1_000_000);
      expect(node.at).toBeLessThanOrEqual(1_000_250);
    }
  });

  it("writes safe integers only, everywhere a number reaches the trace", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(setOf("cheap", [quietDetector()])),
    });
    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "ordinary" },
    });

    for (const node of await h.nodes()) {
      for (const [field, value] of Object.entries(node.payload)) {
        if (typeof value !== "number") continue;
        expect(Number.isSafeInteger(value), `${node.payload.kind}.${field}`).toBe(true);
      }
    }
  });
});
