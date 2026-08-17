import { describe, expect, it } from "vitest";
import { CASE_A, CASE_B, harness, mustRecord } from "./fixtures.js";
import { TraceUnavailable, inMemoryTraceStore } from "../index.js";

/**
 * Slice 4 — correct total ordering within one case under concurrent writers.
 *
 * These appends genuinely interleave: the in-memory adapter yields inside its
 * critical section on purpose, so a missing mutex shows up here rather than in
 * production at 3am. Correctness comes from the store serialising, not from
 * single-threaded luck.
 */

const WRITERS = 50;

describe("audit — concurrent writers to one case", () => {
  it("assigns every sequence exactly once, with no gap and no duplicate", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        trace.record({ kind: "model.call", v: 1, writer: i }, { tier: "low" }),
      ),
    );

    const sequences = results
      .map((r) => mustRecord(r).node.sequence)
      .sort((a, b) => a - b);

    expect(sequences).toEqual(Array.from({ length: WRITERS }, (_, i) => i));
  });

  it("gives every concurrently-written node a distinct identity", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    const results = await Promise.all(
      Array.from({ length: WRITERS }, () =>
        trace.record({ kind: "model.call", v: 1 }, { tier: "low" }),
      ),
    );

    const ids = new Set(results.map((r) => mustRecord(r).node.id));
    expect(ids.size).toBe(WRITERS);
  });

  it("replays a concurrently-written case as one contiguous total order", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        trace.record({ kind: "model.call", v: 1, writer: i }, { tier: "low" }),
      ),
    );

    const replayed = await audit.replay(CASE_A);
    expect(replayed.nodes.map((n) => n.sequence)).toEqual(
      Array.from({ length: WRITERS }, (_, i) => i),
    );
  });

  it("seals a case that is being written concurrently without losing or double-counting a node", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    const writes = Array.from({ length: WRITERS }, (_, i) =>
      trace.record({ kind: "model.call", v: 1, writer: i }, { tier: "low" }),
    );
    await Promise.all(writes);
    const seal = await trace.close({ unassistedContainment: true });

    // The seal counts exactly what preceded it, because sealing and closing
    // happen inside the same critical section that assigns sequences.
    expect(seal.payload["nodesSealed"]).toBe(WRITERS);
    expect(seal.sequence).toBe(WRITERS);
  });

  it("keeps concurrent writes to different cases independent", async () => {
    const { audit } = harness();
    const a = await audit.open(CASE_A);
    const b = await audit.open(CASE_B);

    await Promise.all([
      ...Array.from({ length: 20 }, () => a.record({ kind: "a", v: 1 }, { tier: "low" })),
      ...Array.from({ length: 20 }, () => b.record({ kind: "b", v: 1 }, { tier: "low" })),
    ]);

    expect((await audit.replay(CASE_A)).nodes.map((n) => n.sequence)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
    expect((await audit.replay(CASE_B)).nodes.map((n) => n.sequence)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
  });
});

describe("audit — bounded resources", () => {
  it("sheds with a named error rather than growing the write queue without limit", async () => {
    const { audit } = harness({
      store: inMemoryTraceStore({ maxPendingWrites: 4 }),
    });
    const trace = await audit.open(CASE_A);

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () =>
        trace.record({ kind: "model.call", v: 1 }, { tier: "low" }),
      ),
    );

    const shed = results.filter(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof TraceUnavailable &&
        r.reason.reason === "backpressure",
    );
    expect(shed.length).toBeGreaterThan(0);
  });

  it("stops at the per-case node ceiling rather than consuming the heap", async () => {
    const { audit } = harness({ store: inMemoryTraceStore({ maxNodesPerCase: 3 }) });
    const trace = await audit.open(CASE_A);

    for (let i = 0; i < 3; i += 1) {
      await trace.record({ kind: "model.call", v: 1 }, { tier: "low" });
    }

    await expect(
      trace.record({ kind: "model.call", v: 1 }, { tier: "high" }),
    ).rejects.toThrow(TraceUnavailable);
  });
});
