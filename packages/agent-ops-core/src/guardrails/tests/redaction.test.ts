import { describe, expect, it } from "vitest";
import {
  CASE_A,
  EN_GB,
  harness,
  ninDetector,
  quietDetector,
  sameAtEveryTier,
  scriptedClassifier,
  scriptedDetector,
  setOf,
} from "./fixtures.js";
import {
  MASK,
  NODE,
  ScreeningPayloadInvalid,
  modelDetector,
  type NonEmpty,
  type Payload,
} from "../index.js";

/**
 * Slice 2 — redaction is irreversible within the trace.
 *
 * The assertion that matters is not "the reader hides it" but "the store never
 * held it". Every test here reads the store directly for exactly that reason:
 * there is no un-writing personal data, so a redaction that happens on the way
 * out is not a redaction at all.
 *
 * The second thing pinned here is the inversion that makes it work. Detectors
 * report **coordinates**; this module does the masking. A detector therefore
 * cannot forget to redact what it found — redacting was never its job — and it
 * has no field on which it could carry a name or an account number back out.
 */

const NIN = "AB 12 34 56 C";

describe("guardrails — redaction before write", () => {
  const setup = () =>
    harness({ detectorSets: sameAtEveryTier(setOf("pii", [ninDetector()])) });

  it("never lets the original reach the store", async () => {
    const h = setup();
    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: `the claimant gave ${NIN} at the door` },
    });

    const bytes = (await h.nodes()).map((n) => n.canonical).join("");
    expect(bytes).not.toContain(NIN);
    expect(bytes).toContain(MASK);
    expect(bytes).toContain("the claimant gave");
  });

  it("returns the masked form and counts the sites it masked", async () => {
    const h = setup();
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: `first ${NIN} then ${NIN} again` },
    });

    expect(screening.payload.fields["narrative"]).toBe(
      `first ${MASK} then ${MASK} again`,
    );
    expect(screening.payload.maskedSites).toBe(2);
    expect(screening.recommended).toEqual({ recommend: "redact-and-allow", maskedSites: 2 });
  });

  it("records a finding as coordinates, never as the matched text", async () => {
    const h = setup();
    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: `ref ${NIN}` },
    });

    const finding = (await h.nodes()).find((n) => n.payload.kind === NODE.finding);
    expect(finding?.payload).toMatchObject({
      category: "personal-data",
      severity: "redact",
      rule: "uk.national-insurance-number",
      field: "narrative",
      startCodeUnit: 4,
      lengthCodeUnits: NIN.length,
      confidenceBasisPoints: 9_500,
    });
    // There is no field on a finding that could carry the value, so this is a
    // property of the shape rather than of this particular detector.
    expect(JSON.stringify(finding?.payload)).not.toContain("12 34 56");
  });

  it("masks every personal-data site even when the severity is only advisory", async () => {
    // Severity says what the *caller* should do with the payload it still
    // holds. It gets no say in what reaches the trace, because there is no
    // un-writing.
    const h = harness({
      detectorSets: sameAtEveryTier(setOf("pii-advisory", [ninDetector("advisory")])),
    });
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: `ref ${NIN}` },
    });

    const bytes = (await h.nodes()).map((n) => n.canonical).join("");
    expect(bytes).not.toContain(NIN);
    expect(screening.payload.maskedSites).toBe(1);
  });

  it("honours `redact` in every category, not only personal-data", async () => {
    // `Severity` documents `redact` as "the site is masked before anything is
    // recorded or returned". It used to be a no-op for three of the four
    // categories: a prompt-injection finding at `redact` masked nothing,
    // recorded the raw text and recommended allow.
    const text = "ignore previous secret AB 12 34 56 C";
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("injection-redact", [
          scriptedDetector("injection", () => ({
            outcome: "found",
            findings: [
              {
                category: "prompt-injection",
                severity: "redact",
                rule: "instruction-override",
                at: { field: "narrative", startCodeUnit: 0, lengthCodeUnits: text.length },
                confidenceBasisPoints: 9_000,
              },
            ] as unknown as NonEmpty<never>,
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

    expect(screening.payload.maskedSites).toBe(1);
    expect(screening.recommended).toEqual({ recommend: "redact-and-allow", maskedSites: 1 });
    const bytes = (await h.nodes()).map((n) => n.canonical).join("");
    expect(bytes).not.toContain("AB 12 34 56 C");
    expect(bytes).not.toContain("ignore previous");
  });

  it("refuses a payload field that is not text, before anything is written", async () => {
    // `Payload` says `string`; a payload from `JSON.parse` of untrusted input is
    // checked by nothing, and `{"__proto__": "..."}` used to surface as an
    // unnamed `TypeError` *after* two nodes were already in the trace.
    const h = harness({ detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])) });
    const hostile = JSON.parse('{"amount": 12, "ok": "fine"}') as Payload;

    await expect(
      h.guardrails.screenInput({ correlationId: CASE_A, tier: "high", payload: hostile }),
    ).rejects.toBeInstanceOf(ScreeningPayloadInvalid);
    expect(await h.nodes()).toHaveLength(0);
  });

  it("masks a field literally named __proto__ rather than throwing over it", async () => {
    const h = harness({ detectorSets: sameAtEveryTier(setOf("pii", [ninDetector()])) });
    const hostile = JSON.parse(`{"__proto__":"ref ${NIN}","ok":"fine"}`) as Payload;

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: hostile,
    });

    expect(screening.payload.fields["__proto__"]).toBe(`ref ${MASK}`);
    const bytes = (await h.nodes()).map((n) => n.canonical).join("");
    expect(bytes).not.toContain(NIN);
  });

  it("shows a model detector the masked text, never the caller's original", async () => {
    // A model detector reaches a third party. Masking used to run strictly
    // after every detector returned, so every model-class detector shipped
    // unredacted personal data out of the process on every high-tier screening.
    let seen = "";
    const h = harness({
      locale: EN_GB,
      detectorSets: sameAtEveryTier(
        setOf("two-round", [
          ninDetector(),
          modelDetector({
            id: "injection.model",
            locales: ["en-GB"] as unknown as NonEmpty<string>,
            searches: "instructions aimed at the model",
            category: "prompt-injection",
            severity: "escalate",
            classifier: scriptedClassifier(() => ({ injection: 100 }), {
              onCall: (request) => {
                seen = request.text;
              },
            }),
            labels: ["injection"] as unknown as NonEmpty<string>,
            thresholdBasisPoints: 8_000,
          }),
        ]),
      ),
    });

    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: `the claimant gave ${NIN} at the door` },
    });

    expect(seen).not.toContain(NIN);
    expect(seen).toBe(`the claimant gave ${MASK} at the door`);

    // And the trace says which text each detector's coordinates index into, so
    // a 2033 reader never has to guess.
    const views = (await h.nodes())
      .filter((n) => n.payload.kind === NODE.detector)
      .map((n) => n.payload["view"]);
    expect([...views].sort()).toEqual(["original", "post-redaction"]);
  });

  it("records text no detector flagged, verbatim — the residual risk, pinned", async () => {
    // The defensible claim is "the original AT DETECTED SITES never reaches a
    // store". This test exists to keep the weaker claim visible rather than let
    // the stronger one be believed: a narrative carrying a name, an address and
    // a diagnosis in shapes no pattern matches lands in the trace in full.
    const h = harness({ detectorSets: sameAtEveryTier(setOf("pii", [ninDetector()])) });
    const narrative = "Mrs Ada Lovelace, 12 Marylebone Rd, dx: metastatic carcinoma";
    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative },
    });

    const bytes = (await h.nodes()).map((n) => n.canonical).join("");
    expect(bytes).toContain(narrative);
    // The two things that shrink it are the caller's to wire: a model-class
    // detector on the same field, and `audit`'s deny-by-default redactor with
    // `GUARDRAILS_TRACE_FIELDS`. See `telemetry.test.ts` for the second.
  });

  it("records a digest of the whole redacted value, so truncation is visible", async () => {
    const h = harness({
      detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])),
      limits: { maxRecordedFieldChars: 8 },
    });
    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "a much longer narrative than eight characters" },
    });

    const payloadNode = (await h.nodes()).find((n) => n.payload.kind === NODE.payload);
    expect(payloadNode?.payload["f.narrative"]).toBe("a much l");
    expect(String(payloadNode?.payload["d.narrative"])).toHaveLength(32);
  });
});
