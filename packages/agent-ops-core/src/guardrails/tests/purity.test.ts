import { describe, expect, it } from "vitest";
import { CASE_A, harness, quietDetector, sameAtEveryTier, scriptedDetector, setOf } from "./fixtures.js";
import { MASK, NODE, type NonEmpty, type Source, type SourceId } from "../index.js";

/**
 * Slice 8 — no detector may produce an effect, and none may alter the payload
 * it was asked to inspect.
 *
 * Two separate guarantees, worth keeping apart because they are enforced by
 * different mechanisms.
 *
 * **Capability.** A `ScreeningSubject` carries no client, no store, no recorder,
 * no clock, no network handle and no correlation identifier. There is nothing
 * there to have an effect *with*, and a detector's entire influence on the run
 * is the `DetectorReport` it returns.
 *
 * **Payload purity.** The view is frozen — every module file is an ES module and
 * therefore strict, so assignment throws — and the module never reads the
 * subject again in any case: masking, recording and the returned
 * `ScreenedPayload` are all built from a copy the detector never sees.
 *
 * The honest limit, stated in the interface too: a detector is
 * application-supplied code holding its own closure, and no type in this package
 * reaches outside this package. A detector that captured an HTTP client at
 * construction can still call it. The claim is *no effect through anything
 * `guardrails` hands it*, not *no effect*.
 */

describe("guardrails — detectors are pure with respect to the payload", () => {
  it("hands the detector nothing it could cause an effect with", async () => {
    let seen: readonly string[] = [];
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("observer", [
          scriptedDetector("observer", (subject) => {
            seen = Object.keys(subject);
            return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
          }),
        ]),
      ),
    });

    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });

    expect([...seen].sort()).toEqual(["budgetMicros", "fields", "locale", "phase", "sources"]);
  });

  it("freezes the view, so mutation throws rather than being silently dropped", async () => {
    let thrown: string | undefined;
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("meddler", [
          scriptedDetector("meddler", (subject) => {
            try {
              (subject.fields as Record<string, string>)["narrative"] = "tampered";
            } catch (error) {
              thrown = error instanceof Error ? error.constructor.name : "unknown";
            }
            return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
          }),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "the original text" },
    });

    expect(thrown).toBe("TypeError");
    expect(screening.payload.fields["narrative"]).toBe("the original text");
  });

  it("works from its own copy even if a detector defeats the freeze", async () => {
    // Belt and braces. Even where the throw is swallowed — a different engine, a
    // `Reflect` call, a sloppy transpile — the module never reads the subject
    // again, so a detector cannot change what is screened, masked or recorded.
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("deleter", [
          scriptedDetector("deleter", (subject) => {
            try {
              Reflect.deleteProperty(subject.fields as object, "narrative");
              Reflect.set(subject.fields as object, "smuggled", "AB 12 34 56 C");
            } catch {
              /* frozen, as intended */
            }
            return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
          }),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "the original text" },
    });

    expect(Object.keys(screening.payload.fields)).toEqual(["narrative"]);
    const payloadNode = (await h.nodes()).find((n) => n.payload.kind === NODE.payload);
    expect(payloadNode?.payload["f.narrative"]).toBe("the original text");
    expect(payloadNode?.payload["f.smuggled"]).toBeUndefined();
  });

  it("refuses a finding that names text nobody screened", async () => {
    // The only channel from a detector back into the trace carries coordinates
    // and integers. Coordinates that do not land inside a screened field are a
    // defect, and they halt rather than being recorded as evidence.
    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("liar", [
          scriptedDetector("liar", () => ({
            outcome: "found",
            findings: [
              {
                category: "personal-data",
                severity: "redact",
                rule: "invented",
                at: { field: "narrative", startCodeUnit: 0, lengthCodeUnits: 9_999 },
                confidenceBasisPoints: 10_000,
              },
            ],
            costTenthCents: 0,
            modelCalls: 0,
          })),
        ]),
      ),
    });

    await expect(
      h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "low",
        payload: { narrative: "short" },
      }),
    ).rejects.toMatchObject({ name: "DetectorReportInvalid" });
  });

  it("merges overlapping sites so the masked bytes are stable", async () => {
    // Two detectors finding the same personal data at overlapping coordinates
    // must not produce different bytes depending on the order they finished in.
    const site = { field: "narrative", startCodeUnit: 4, lengthCodeUnits: 13 };
    const finder = (id: string, at: typeof site) =>
      scriptedDetector(id, () => ({
        outcome: "found",
        findings: [
          {
            category: "personal-data",
            severity: "redact",
            rule: `${id}.rule`,
            at,
            confidenceBasisPoints: 9_000,
          },
        ],
        costTenthCents: 0,
        modelCalls: 0,
      }));

    const h = harness({
      detectorSets: sameAtEveryTier(
        setOf("overlapping", [
          finder("wide", site),
          finder("narrow", { ...site, startCodeUnit: 7, lengthCodeUnits: 6 }),
        ]),
      ),
    });

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "ref AB 12 34 56 C end" },
    });

    expect(screening.payload.fields["narrative"]).toBe(`ref ${MASK} end`);
    expect(screening.payload.maskedSites).toBe(1);
  });
});

/**
 * The second influence channel, which the interface said did not exist.
 *
 * `fields` was frozen and copied; `sources` was passed by reference — the
 * caller's own object, its own array and its own `Source` values. A detector
 * could rewrite the reference material a sibling detector was judged against,
 * and could mutate the caller's array on the way out. The purity suite
 * exercised `fields` three ways and never touched `sources`.
 */
describe("guardrails — detectors are pure with respect to the sources", () => {
  const sourceOf = (text: string): Source => ({ id: "policy-1" as SourceId, text });

  it("does not let one detector rewrite what the next is judged against", async () => {
    let seenByB = "";
    const meddler = scriptedDetector("meddler", (subject) => {
      if (subject.sources.available) {
        try {
          (subject.sources.items[0] as { text: string }).text =
            "FABRICATED SUPPORT: the invoice is approved";
          (subject.sources.items as unknown as Source[]).push(sourceOf("smuggled"));
        } catch {
          // Frozen: assignment throws under strict mode, which is the point.
        }
      }
      return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
    });
    const observer = scriptedDetector("observer", (subject) => {
      seenByB = subject.sources.available
        ? `${subject.sources.items.length}:${subject.sources.items[0].text}`
        : "none";
      return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
    });

    const h = harness({
      // Concurrency 1, so `meddler` runs strictly before `observer` and the
      // assertion is about what it did rather than about a race.
      limits: { detectorConcurrency: 1 },
      detectorSets: sameAtEveryTier(setOf("pair", [quietDetector()], [meddler, observer])),
    });

    const items = [sourceOf("the invoice is unapproved")];
    const input = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });
    await h.guardrails.checkOutput({
      after: input,
      tier: "high",
      output: { answer: "pay it" },
      sources: { available: true, items: items as unknown as NonEmpty<Source> },
    });

    expect(seenByB).toBe("1:the invoice is unapproved");
  });

  it("does not mutate the caller's own array or its own Source objects", async () => {
    const meddler = scriptedDetector("meddler", (subject) => {
      if (subject.sources.available) {
        try {
          (subject.sources.items[0] as { text: string }).text = "rewritten";
          (subject.sources.items as unknown as Source[]).push(sourceOf("smuggled"));
        } catch {
          // Frozen.
        }
      }
      return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
    });
    const h = harness({
      detectorSets: sameAtEveryTier(setOf("meddler", [quietDetector()], [meddler])),
    });

    const original = sourceOf("the invoice is unapproved");
    const items = [original];
    const input = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { narrative: "ordinary" },
    });
    await h.guardrails.checkOutput({
      after: input,
      tier: "high",
      output: { answer: "pay it" },
      sources: { available: true, items: items as unknown as NonEmpty<Source> },
    });

    expect(items).toHaveLength(1);
    expect(original.text).toBe("the invoice is unapproved");
  });
});
