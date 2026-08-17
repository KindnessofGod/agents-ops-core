import { describe, expect, it } from "vitest";
import { inMemoryTraceStore, type CorrelationId, type NodeId, type TraceStore } from "../../audit/index.js";
import {
  CASE_A,
  harness,
  quietDetector,
  sameAtEveryTier,
  scriptedDetector,
  setOf,
} from "./fixtures.js";
import {
  DetectorReportInvalid,
  NODE,
  OutputCheckOutOfOrder,
  ScreeningParentUnknown,
} from "../index.js";

/**
 * Slice 11 — what the graph is allowed to leave out, and what it is not.
 *
 * Three things this file pins, all of them cases where the code enforced
 * something weaker than the interface stated.
 *
 *   **Parentage is refused, not dropped.** C1 requires parent/child recorded
 *   rather than inferred. A `under` naming a node in another case used to write
 *   a root with no error, silently detaching the screening from the graph.
 *
 *   **`checkOutput` is after an *input* screening.** The brand proves something
 *   was screened; the stated invariant is stronger than that.
 *
 *   **A failed screening stops.** A partial failure must not corrupt the trace,
 *   and a trace that keeps growing after the caller has been told the screening
 *   failed is a trace whose last node is not its last event.
 */

const ticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise<void>((r) => setImmediate(r));
};

describe("guardrails — parentage", () => {
  it("refuses an `under` that names no node in this case, rather than writing a root", async () => {
    const h = harness({ detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])) });

    await expect(
      h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "high",
        payload: { a: "b" },
        under: "case-somewhere-else#77" as NodeId,
      }),
    ).rejects.toBeInstanceOf(ScreeningParentUnknown);
  });

  it("still hangs under a node this process did not write, once the case is replayed", async () => {
    const h = harness({ detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])) });
    // A node written straight through `audit`, not through `guardrails`: the
    // case exists and the parent is real, but no recorder of this module's has
    // ever seen it.
    const trace = await h.audit.open(CASE_A);
    const result = await trace.record({ kind: "app.intake", v: 1 }, { tier: "high" });
    if (!result.recorded) throw new Error("fixture could not record");

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { a: "b" },
      under: result.node.id,
    });

    const opened = (await h.nodes()).find((n) => n.id === screening.nodes.opened);
    expect(opened?.parent).toBe(result.node.id);
  });
});

describe("guardrails — checkOutput follows an input screening", () => {
  it("refuses an output screening as its `after`", async () => {
    const h = harness({ detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])) });
    const input = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { a: "b" },
    });
    const output = await h.guardrails.checkOutput({
      after: input,
      tier: "high",
      output: { answer: "pay it" },
      sources: { available: false, why: "none" },
    });

    await expect(
      h.guardrails.checkOutput({
        after: output,
        tier: "high",
        output: { answer: "pay it again" },
        sources: { available: false, why: "none" },
      }),
    ).rejects.toBeInstanceOf(OutputCheckOutOfOrder);
  });

  it("does not replay the case to find its own parent", async () => {
    // The bound that was missing. `audit.record` needs the parent as a
    // `RecordedNode`, and `checkOutput` only held a `NodeId`, so every call
    // replayed the whole case — a read that grows for the life of the case, on
    // the hot path before every effect.
    const base = inMemoryTraceStore();
    let reads = 0;
    const counting: TraceStore = {
      ...base,
      async read(correlationId: CorrelationId) {
        reads += 1;
        return base.read(correlationId);
      },
    };
    const h = harness({
      detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])),
      store: counting,
    });

    const input = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { a: "b" },
    });
    const afterInput = reads;

    let latest = input;
    for (let i = 0; i < 5; i += 1) {
      latest = await h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "low",
        payload: { a: `b${i}` },
        // The `Screening`, not its identifier: it carries its own settled node.
        under: input,
      });
      await h.guardrails.checkOutput({
        after: input,
        tier: "low",
        output: { answer: `pay ${i}` },
        sources: { available: false, why: "none" },
      });
    }
    expect(latest.phase).toBe("input");

    // Ten further screenings, no further reads: the witness was proven once for
    // this case and every parent travels on the `Screening` that named it.
    expect(reads - afterInput).toBe(0);

    // A bare `NodeId` this process did not mint still costs exactly one replay,
    // because `audit.record` needs a recorded node and there is nothing else to
    // go on. Bounded by the case's own node count, paid once, and stated on
    // `InputScreeningRequest` rather than hidden.
    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { a: "by-identifier" },
      under: input.nodes.settled,
    });
    expect(reads - afterInput).toBe(1);
  });
});

describe("guardrails — a screening that fails stops", () => {
  it("does not let sibling detectors keep writing after the caller has the error", async () => {
    const slow = scriptedDetector("slow", async () => {
      await ticks(20);
      return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
    });
    const broken = scriptedDetector("broken", () => ({
      // `found` with nothing in it: a defect in a detector, not an outage.
      outcome: "found",
      findings: [] as unknown as never,
      costTenthCents: 0,
      modelCalls: 0,
    }));
    const h = harness({
      detectorSets: sameAtEveryTier(setOf("mixed", [broken, slow])),
    });

    await expect(
      h.guardrails.screenInput({ correlationId: CASE_A, tier: "high", payload: { a: "b" } }),
    ).rejects.toBeInstanceOf(DetectorReportInvalid);

    const atThrow = (await h.nodes()).length;
    await ticks(60);
    expect((await h.nodes()).length).toBe(atThrow);
  });

  it("marks the throw on the trace rather than ending in silence", async () => {
    const broken = scriptedDetector("broken", () => ({
      outcome: "found",
      findings: [] as unknown as never,
      costTenthCents: 0,
      modelCalls: 0,
    }));
    const h = harness({ detectorSets: sameAtEveryTier(setOf("broken", [broken])) });

    await expect(
      h.guardrails.screenInput({ correlationId: CASE_A, tier: "high", payload: { a: "b" } }),
    ).rejects.toBeInstanceOf(DetectorReportInvalid);

    const kinds = await h.kinds();
    expect(kinds).toContain(NODE.abandoned);
    const abandoned = (await h.nodes()).find((n) => n.payload.kind === NODE.abandoned);
    expect(abandoned?.payload["error"]).toBe("DetectorReportInvalid");
    expect(kinds[kinds.length - 1]).toBe(NODE.abandoned);
  });
});
