import { describe, expect, it } from "vitest";
import { CASE_A, CASE_B, harness, mustRecord } from "./fixtures.js";
import {
  DIGEST_ALGORITHM,
  SEAL_KIND,
  TRACE_DIGEST_VERSION,
  TraceTampered,
  inMemoryTraceStore,
  traceDigest,
  type RecordedNode,
  type StoredCase,
  type TraceDigest,
  type TraceStore,
} from "../index.js";

/**
 * Slice 3 — a content digest over the trace, so tampering is detectable, and a
 * seal node so the trace witnesses itself.
 */

describe("audit — trace digest", () => {
  it("names its own version and algorithm inline, so an old digest stays checkable", async () => {
    const { audit } = harness();
    await audit.open(CASE_A);

    const digest = (await audit.replay(CASE_A)).digest();

    expect(digest.startsWith(`${TRACE_DIGEST_VERSION}:${DIGEST_ALGORITHM}:`)).toBe(
      true,
    );
  });

  it("gives an empty trace a digest rather than an empty string", async () => {
    const { audit } = harness();
    await audit.open(CASE_A);
    await audit.open(CASE_B);

    const a = (await audit.replay(CASE_A)).digest();
    const b = (await audit.replay(CASE_B)).digest();

    // "No nodes" is a verifiable claim, not a missing one — and it is the same
    // claim for both cases, which is what the genesis value means.
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("changes when a payload changes", async () => {
    const one = harness();
    const two = harness();
    const a = await one.audit.open(CASE_A);
    const b = await two.audit.open(CASE_A);

    await a.record({ kind: "decision.decided", v: 1, verdict: "pay" }, { tier: "high" });
    await b.record({ kind: "decision.decided", v: 1, verdict: "deny" }, { tier: "high" });

    expect((await one.audit.replay(CASE_A)).digest()).not.toBe(
      (await two.audit.replay(CASE_A)).digest(),
    );
  });

  it("is the same for the same nodes recorded the same way", async () => {
    const one = harness();
    const two = harness();

    for (const h of [one, two]) {
      const trace = await h.audit.open(CASE_A);
      const parent = mustRecord(
        await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" }),
      ).node;
      await trace.record(
        { kind: "model.call", v: 1, tokensIn: 900 },
        { tier: "high", parent },
      );
    }

    expect((await one.audit.replay(CASE_A)).digest()).toBe(
      (await two.audit.replay(CASE_A)).digest(),
    );
  });

  it("is stable under the store's assigned sequence, not under arrival order", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });
    await trace.record({ kind: "b", v: 1 }, { tier: "low" });

    const replayed = await audit.replay(CASE_A);
    const shuffled = [...replayed.nodes].reverse();

    // Handing the nodes over in the wrong order does not change the digest:
    // the chain is defined over the sequence the store assigned.
    expect(traceDigest(shuffled)).toBe(replayed.digest());
  });

  it("verifies against a digest recorded elsewhere", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });

    const witnessed = (await audit.replay(CASE_A)).digest();

    expect((await audit.replay(CASE_A)).verify(witnessed)).toBe(true);
    expect((await audit.replay(CASE_A)).verify("nonsense" as TraceDigest)).toBe(
      false,
    );
  });
});

describe("audit — sealing on close", () => {
  it("appends a terminal node carrying the digest of everything before it", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });

    const before = (await audit.replay(CASE_A)).digest();
    const seal = await trace.close({ unassistedContainment: false });

    expect(seal.payload.kind).toBe(SEAL_KIND);
    expect(seal.payload["sealDigest"]).toBe(before);
    expect(seal.payload["nodesSealed"]).toBe(1);
  });

  it("records unassisted containment as a node, never as an assertion", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    const seal = await trace.close({ unassistedContainment: false });

    // The full two-word term. Bare `containment` is a lint failure.
    expect(seal.payload["unassistedContainment"]).toBe(false);
    expect((await audit.replay(CASE_A)).closed).toBe(true);
  });

  it("derives closure from the seal node rather than a mutable flag", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    expect((await audit.replay(CASE_A)).closed).toBe(false);
    await trace.close({ unassistedContainment: true });
    expect((await audit.replay(CASE_A)).closed).toBe(true);
  });
});

describe("audit — tamper detection on read", () => {
  /**
   * A store that hands back a node whose payload has been edited while its
   * stored canonical bytes were left alone. This is what a row edited in place
   * with a `psql` prompt looks like from the read path.
   */
  const tamperingStore = (inner: TraceStore): TraceStore => ({
    // Spread, not a fresh literal. `TraceStore` carries a brand this module
    // does not export, so an impostor store does not typecheck at all — that
    // is `OPEN-ITEMS-RESOLVED.md` item 1. A decorator over a real store keeps
    // the brand, which is deliberate and is why the acknowledgement checks in
    // `createAudit` are not redundant with it.
    ...inner,
    async read(correlationId): Promise<StoredCase | undefined> {
      const stored = await inner.read(correlationId);
      if (stored === undefined) return undefined;
      const nodes = stored.nodes.map(
        (node): RecordedNode => ({
          ...node,
          payload: { ...node.payload, verdict: "pay" },
        }),
      );
      return { provenance: stored.provenance, nodes };
    },
  });

  it("refuses a trace whose stored bytes disagree with its own columns", async () => {
    const { audit } = harness({ store: tamperingStore(inMemoryTraceStore()) });
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1, verdict: "deny" }, {
      tier: "high",
    });

    // Fail-closed. Handing back a trace we know disagrees with itself would
    // launder tampering into evidence.
    await expect(audit.replay(CASE_A)).rejects.toThrow(TraceTampered);
  });
});
