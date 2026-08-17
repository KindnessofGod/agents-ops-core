import { describe, expect, it } from "vitest";
import { CASE_A, CASE_B, harness, mustRecord, testClock } from "./fixtures.js";
import { IdempotencyKeyConflict, IdempotencyKeyUnusable } from "../index.js";

/**
 * `record` deduplicates on an explicit key — `README.md` item 4.
 *
 * ## What was wrong, exactly
 *
 * A caller crashes between `store.append` committing and the acknowledgement
 * arriving. It restarts and records the same node again. Before this, the trace
 * held two nodes for one event and no reader could tell which of them was the
 * retry — the evidence said something happened twice that happened once.
 *
 * ## What is fixed, and what deliberately is not
 *
 * Fixed: an append carrying an `idempotencyKey` that a case has already seen
 * returns the FIRST node, writes nothing, and says `deduplicated: true` so a
 * caller can tell a fresh write from a replayed one rather than being told a
 * comfortable "yes, done".
 *
 * Not fixed, deliberately: an append with **no** key still appends. There is no
 * content-derived deduplication anywhere in this module, because two identical
 * payloads in one case can be two real events and collapsing them would lose
 * one. See `migrations/0007_audit_idempotency.sql` for the two rejected
 * alternatives.
 *
 * Both adapters owe this. The tests below run through the interface, so a
 * divergence between the in-memory store and Postgres — the exact defect this
 * module has spent its releases removing — fails here rather than in production
 * on whichever adapter was tested second.
 */

describe("audit — idempotent append", () => {
  it("returns the first node on a retry rather than appending a second", async () => {
    const { audit, clock } = harness({ clock: testClock(1_700_000_000_000) });
    const trace = await audit.open(CASE_A);

    const first = mustRecord(
      await trace.record(
        { kind: "invoice.determined", v: 1, verdict: "pay" },
        { tier: "high", idempotencyKey: "attempt-1" },
      ),
    );
    expect(first.deduplicated).toBe(false);

    // The crash-retry. A restarted process is a later process, so the clock has
    // moved: the returned node must be the first node, at the FIRST node's
    // clock reading, not a fresh one wearing the same key.
    clock.advance(5_000);
    const retry = mustRecord(
      await trace.record(
        { kind: "invoice.determined", v: 1, verdict: "pay" },
        { tier: "high", idempotencyKey: "attempt-1" },
      ),
    );

    expect(retry.deduplicated).toBe(true);
    expect(retry.node.id).toBe(first.node.id);
    expect(retry.node.sequence).toBe(first.node.sequence);
    expect(retry.node.at).toBe(first.node.at);
    expect(retry.node.canonical).toBe(first.node.canonical);

    // The proof of a write is replay, so the count is asserted there rather
    // than from the acknowledgement.
    expect((await audit.replay(CASE_A)).nodes).toHaveLength(1);
  });

  it("keeps appending when no key is supplied, because two identical events can be two events", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "model.call", v: 1 }, { tier: "low" });
    await trace.record({ kind: "model.call", v: 1 }, { tier: "low" });

    expect((await audit.replay(CASE_A)).nodes).toHaveLength(2);
  });

  it("scopes the key to one case, so two applications cannot collide", async () => {
    const { audit } = harness();
    const a = await audit.open(CASE_A);
    const b = await audit.open(CASE_B);

    const inA = mustRecord(
      await a.record({ kind: "k", v: 1, which: "a" }, { tier: "low", idempotencyKey: "attempt-1" }),
    );
    const inB = mustRecord(
      await b.record({ kind: "k", v: 1, which: "b" }, { tier: "low", idempotencyKey: "attempt-1" }),
    );

    expect(inB.deduplicated).toBe(false);
    expect(inB.node.correlationId).toBe(CASE_B);
    expect(inA.node.payload["which"]).toBe("a");
    expect(inB.node.payload["which"]).toBe("b");
  });

  it("refuses a key reused for a different payload rather than silently returning the first", async () => {
    // The failure this must not have: a caller reuses a key by mistake, the
    // second event vanishes, and the trace says it never happened. That is a
    // caller defect and it is fail-closed at every tier.
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.record(
      { kind: "invoice.determined", v: 1, verdict: "pay" },
      { tier: "high", idempotencyKey: "attempt-1" },
    );

    await expect(
      trace.record(
        { kind: "invoice.determined", v: 1, verdict: "refuse" },
        { tier: "high", idempotencyKey: "attempt-1" },
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflict);
  });

  it("refuses a key reused at a different tier", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "k", v: 1 }, { tier: "low", idempotencyKey: "attempt-1" });

    await expect(
      trace.record({ kind: "k", v: 1 }, { tier: "high", idempotencyKey: "attempt-1" }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflict);
  });

  it("refuses an empty or oversized key, so the bound is not the caller's to forget", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record({ kind: "k", v: 1 }, { tier: "low", idempotencyKey: "" }),
    ).rejects.toBeInstanceOf(IdempotencyKeyUnusable);
    await expect(
      trace.record({ kind: "k", v: 1 }, { tier: "low", idempotencyKey: "x".repeat(201) }),
    ).rejects.toBeInstanceOf(IdempotencyKeyUnusable);

    expect((await audit.replay(CASE_A)).nodes).toHaveLength(0);
  });

  it("deduplicates concurrently, so two racing retries produce one node", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        trace.record({ kind: "k", v: 1 }, { tier: "low", idempotencyKey: "one" }),
      ),
    );

    const nodes = results.map((r) => mustRecord(r).node);
    expect(new Set(nodes.map((n) => n.sequence)).size).toBe(1);
    expect(results.filter((r) => mustRecord(r).deduplicated)).toHaveLength(7);
    expect((await audit.replay(CASE_A)).nodes).toHaveLength(1);
  });
});
