import { describe, expect, it } from "vitest";
import { createAudit, inMemoryTraceStore, redactAllExcept } from "../../audit/index.js";
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
  GUARDRAILS_TRACE_FIELDS,
  NODE,
  createGuardrails,
  modelDetector,
  type NonEmpty,
} from "../index.js";

/**
 * Slice 12 — C2's one surviving telemetry requirement, and the redactor
 * interaction that used to destroy it.
 *
 * C2 names **four** things per node: cost, tokens, latency and the price-table
 * version. Two of them were absent from every node this module wrote, so a 2033
 * reader could not reconstruct how a cost figure was derived. And on every
 * failure path — a detector that threw, or one that lost its budget race — cost
 * and model calls were hardcoded to zero, which made real spend invisible
 * exactly when money was most likely to have been spent.
 */

describe("guardrails — what a cost figure carries with it", () => {
  const modelSet = (options: { readonly onCall?: () => void } = {}) =>
    sameAtEveryTier(
      setOf("thorough", [
        modelDetector({
          id: "injection.model",
          locales: ["en-GB"] as unknown as NonEmpty<string>,
          searches: "instructions aimed at the model",
          category: "prompt-injection",
          severity: "escalate",
          classifier: scriptedClassifier(() => ({ injection: 100 }), {
            costTenthCents: 45,
            tokensIn: 310,
            tokensOut: 12,
            priceTableVersion: "prices-2026-01",
            ...(options.onCall === undefined ? {} : { onCall: options.onCall }),
          }),
          labels: ["injection"] as unknown as NonEmpty<string>,
          thresholdBasisPoints: 8_000,
        }),
      ]),
    );

  it("writes tokens and the price table as typed telemetry, not as payload keys", async () => {
    const h = harness({ locale: EN_GB, detectorSets: modelSet() });
    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });

    const detector = (await h.nodes()).find((n) => n.payload.kind === NODE.detector);
    expect(detector?.telemetry).toMatchObject({
      costTenthCents: 45,
      tokensIn: 310,
      tokensOut: 12,
      priceTableVersion: "prices-2026-01",
    });

    // And the screening's own node sums what its detectors could measure.
    const settled = (await h.nodes()).find((n) => n.payload.kind === NODE.settled);
    expect(settled?.telemetry).toMatchObject({
      costTenthCents: 45,
      tokensIn: 310,
      tokensOut: 12,
      priceTableVersion: "prices-2026-01",
    });
  });

  it("leaves telemetry absent on a deterministic detector rather than writing four zeroes", async () => {
    // `audit` makes the field optional for exactly this reason: four zeroes and
    // a made-up price table would make "we spent nothing" indistinguishable
    // from "we did not measure".
    const h = harness({ detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])) });
    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "ordinary" },
    });

    const detector = (await h.nodes()).find((n) => n.payload.kind === NODE.detector);
    expect(detector?.telemetry).toBeUndefined();
    expect(detector?.payload["costMeasured"]).toBe(true);
  });

  it("records what a detector spent before it declared itself unavailable", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("spent-then-failed", [
          scriptedDetector(
            "spender",
            () => ({
              outcome: "unavailable",
              reason: "declared",
              detail: "classifier returned 503 on the third field",
              costTenthCents: 90,
              modelCalls: 2,
              spend: { tokensIn: 600, tokensOut: 20, priceTableVersion: "prices-2026-01" },
            }),
            { costClass: "model" },
          ),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });

    expect(screening.cost.costTenthCents).toBe(90);
    expect(screening.cost.modelCalls).toBe(2);
    expect(screening.cost.unmeasuredDetectors).toBe(0);
    const detector = (await h.nodes()).find((n) => n.payload.kind === NODE.detector);
    expect(detector?.payload["costTenthCents"]).toBe(90);
    expect(detector?.telemetry).toMatchObject({ tokensIn: 600, tokensOut: 20 });
    expect(screening.recommended.recommend).toBe("abstain");
  });

  it("says `unknown`, not `zero`, when a detector could not tell us what it spent", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("thrower", [
          scriptedDetector(
            "thrower",
            () => {
              throw new Error("socket hang up");
            },
            { costClass: "model" },
          ),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });

    expect(screening.cost.unmeasuredDetectors).toBe(1);
    expect(screening.detectors[0].costMeasured).toBe(false);
    const detector = (await h.nodes()).find((n) => n.payload.kind === NODE.detector);
    expect(detector?.payload["costMeasured"]).toBe(false);
    const settled = (await h.nodes()).find((n) => n.payload.kind === NODE.settled);
    expect(settled?.payload["costUnmeasuredDetectors"]).toBe(1);
  });
});

describe("guardrails — under `audit`'s deny-by-default redactor", () => {
  it("keeps its evidence when wired with GUARDRAILS_TRACE_FIELDS", async () => {
    // `redactAllExcept` is what `audit` recommends "on any node whose payload
    // comes from a model or from a document", which is every node here. Applied
    // without this list it replaced every integer on every guardrails node with
    // the *string* "[redacted]" — the whole evidentiary content, gone.
    const store = inMemoryTraceStore();
    const audit = createAudit({
      store,
      clock: manualClock(),
      redact: redactAllExcept([...GUARDRAILS_TRACE_FIELDS]),
      onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
    });
    const guardrails = createGuardrails({
      audit,
      clock: manualClock(),
      timer: manualTimer(),
      locale: EN_GB,
      detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])),
      limits: DEFAULT_LIMITS,
    });

    await guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "the claimant gave a long account at the door" },
    });

    const nodes = (await store.read(CASE_A))?.nodes ?? [];
    const settled = nodes.find((n) => n.payload.kind === NODE.settled);
    expect(settled?.payload["recommend"]).toBe("allow");
    expect(settled?.payload["maskedSites"]).toBe(0);
    expect(settled?.payload["findingCount"]).toBe(0);
    expect(settled?.payload["costTenthCents"]).toBe(0);
    expect(typeof settled?.payload["latencyMicros"]).toBe("number");

    // And the one part that carries caller text does not survive, which is the
    // redactor working rather than the redactor breaking.
    const payloadNode = nodes.find((n) => n.payload.kind === NODE.payload);
    expect(JSON.stringify(payloadNode?.payload)).not.toContain("the claimant gave");
  });
});
