import { describe, expect, it } from "vitest";
import { CASE_A, caseOf, drain, harness } from "./fixtures.js";
import {
  NoSuchCase,
  StoreContractViolated,
  TraceIncoherent,
  canonicalNodeForm,
  inMemoryTraceStore,
  type CorrelationId,
  type NodeId,
  type RecordedNode,
  type TracePage,
  type TracePageRequest,
  type TraceStore,
} from "../index.js";

/**
 * Streaming replay — reading a case at the node ceiling without holding it.
 *
 * `maxNodesPerCase` is 100,000. These tests use two thousand, because the
 * property under test is that memory is bounded by the *page*, not by the case,
 * and two thousand nodes over pages of fifty demonstrates that in a second
 * rather than in a minute. The ceiling itself is a store limit and is tested
 * where it is enforced.
 *
 * The second half is the part worth reading. Every integrity check `replay`
 * makes is expressed once and driven by both read paths, so these tests assert
 * that the streaming path catches the same three attacks the adversarial suite
 * throws at the materialising one. Two paths claiming one guarantee and holding
 * different ones is this module's oldest defect; this is the test that it has
 * not been reintroduced under a new name.
 */

const LARGE = 2_000;

/** Counts what the store was actually asked for. */
const observingStore = (inner: TraceStore) => {
  const pages: TracePageRequest[] = [];
  const sizes: number[] = [];
  const store: TraceStore = {
    ...inner,
    async readPage(request) {
      pages.push(request);
      const page = await inner.readPage(request);
      if (page !== undefined) sizes.push(page.nodes.length);
      return page;
    },
  };
  return { store, pages, sizes };
};

describe("audit — a case is walkable without being held", () => {
  it("walks every node in order, a bounded page at a time", async () => {
    const inner = inMemoryTraceStore();
    const writer = harness({ store: inner });
    await caseOf(writer.audit, CASE_A, LARGE);

    const observed = observingStore(inner);
    const { audit } = harness({ store: observed.store });
    const { nodes, verdict } = await drain(audit.walk(CASE_A, { pageSize: 50 }));

    expect(nodes).toHaveLength(LARGE + 1); // the seal is a node
    expect(nodes.map((n) => n.sequence)).toEqual(nodes.map((_, i) => i));
    expect(verdict.closed).toBe(true);
    expect(verdict.nodes).toBe(LARGE + 1);

    // The bound, asserted rather than described: no read ever returned more
    // than the page size, and the number of round trips is n/pageSize, not one.
    expect(Math.max(...observed.sizes)).toBeLessThanOrEqual(50);
    expect(observed.pages.length).toBeGreaterThan(LARGE / 50);
    for (const request of observed.pages) expect(request.limit).toBe(50);
  });

  it("computes the same digest as the whole-case replay", async () => {
    const { audit } = harness();
    await caseOf(audit, CASE_A, 200);

    const { verdict } = await drain(audit.walk(CASE_A, { pageSize: 7 }));
    const replayed = await audit.replay(CASE_A);

    // If these ever diverge, a case verified by the streaming path and a case
    // verified by an auditor's replay are two different pieces of evidence.
    expect(String(verdict.digest)).toBe(String(replayed.digest()));
    expect(verdict.nodes).toBe(replayed.nodes.length);
  });

  it("clamps a page size rather than refusing an operator's number", async () => {
    const inner = inMemoryTraceStore();
    const writer = harness({ store: inner });
    await caseOf(writer.audit, CASE_A, 30);

    const observed = observingStore(inner);
    const { audit } = harness({ store: observed.store });

    // Zero would mean no progress; a million would mean an unbounded read. Both
    // are clamped into range, because a page size is a performance choice and
    // refusing it outright would leave an operator unable to read the case.
    await drain(audit.walk(CASE_A, { pageSize: 0 }));
    await drain(audit.walk(CASE_A, { pageSize: 1_000_000 }));
    for (const request of observed.pages) {
      expect(request.limit).toBeGreaterThanOrEqual(1);
      expect(request.limit).toBeLessThanOrEqual(10_000);
    }
  });

  it("gives a caller who stops early the nodes read and no verdict", async () => {
    const { audit } = harness();
    await caseOf(audit, CASE_A, 100);

    const seen: RecordedNode[] = [];
    for await (const node of audit.walk(CASE_A, { pageSize: 10 })) {
      seen.push(node);
      if (seen.length === 5) break;
    }

    // A partial walk cannot verify a seal it never reached. `for await`
    // discards a generator's return value, so an early-exiting caller ends up
    // with no verdict at all — deliberately, rather than with one that quietly
    // meant "nothing was wrong with the part I looked at".
    expect(seen).toHaveLength(5);
  });

  it("throws for a case the store has never seen", async () => {
    const { audit } = harness();
    await expect(drain(audit.walk("never_happened" as CorrelationId))).rejects.toThrow(
      NoSuchCase,
    );
  });

  it("walks an open case and reports it as unclosed", async () => {
    const { audit } = harness();
    await caseOf(audit, CASE_A, 10, { close: false });

    const { nodes, verdict } = await drain(audit.walk(CASE_A, { pageSize: 4 }));
    expect(nodes).toHaveLength(10);
    expect(verdict.closed).toBe(false);
    expect(verdict.closedAt).toBeUndefined();
  });
});

describe("audit — the streaming path makes every check the materialising one makes", () => {
  const sealedCase = async (store: TraceStore) => {
    const { audit } = harness({ store });
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "document.extracted", v: 1 }, { tier: "low" });
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });
    await trace.record({ kind: "payment.effected", v: 1 }, { tier: "high" });
    await trace.close({ unassistedContainment: false });
  };

  /** Drops one node from every page it appears on. */
  const dropping = (inner: TraceStore, sequence: number): TraceStore => ({
    ...inner,
    async readPage(request): Promise<TracePage | undefined> {
      const page = await inner.readPage(request);
      if (page === undefined) return undefined;
      return { ...page, nodes: page.nodes.filter((n) => n.sequence !== sequence) };
    },
  });

  /** Appends a well-formed node after the seal on the last page. */
  const appending = (inner: TraceStore): TraceStore => ({
    ...inner,
    async readPage(request): Promise<TracePage | undefined> {
      const page = await inner.readPage(request);
      if (page === undefined || page.more) return page;
      const sequence = (page.nodes[page.nodes.length - 1]?.sequence ?? -1) + 1;
      const skeleton = {
        id: `${request.correlationId}#${sequence}` as NodeId,
        correlationId: request.correlationId,
        sequence,
        at: 0,
        tier: "low" as const,
        payloadSchemaVersion: 1,
        redaction: page.provenance.redaction,
        payload: { kind: "approval.granted", v: 1, forged: true },
      };
      const forged: RecordedNode = { ...skeleton, canonical: canonicalNodeForm(skeleton) };
      return { ...page, nodes: [...page.nodes, forged] };
    },
  });

  it("detects a removed row mid-stream", async () => {
    const inner = inMemoryTraceStore();
    await sealedCase(inner);
    const { audit } = harness({ store: dropping(inner, 2) });

    await expect(drain(audit.walk(CASE_A, { pageSize: 2 }))).rejects.toThrow(
      TraceIncoherent,
    );
  });

  it("detects a row inserted after the seal", async () => {
    const inner = inMemoryTraceStore();
    await sealedCase(inner);
    const { audit } = harness({ store: appending(inner) });

    // Page size three, so the forged node lands on a page with room for it and
    // the walk fails on the forgery rather than on the page being overlong.
    await expect(drain(audit.walk(CASE_A, { pageSize: 3 }))).rejects.toThrow(
      TraceIncoherent,
    );
  });

  it("detects a payload edited in place", async () => {
    const inner = inMemoryTraceStore();
    await sealedCase(inner);
    const edited: TraceStore = {
      ...inner,
      async readPage(request): Promise<TracePage | undefined> {
        const page = await inner.readPage(request);
        if (page === undefined) return undefined;
        return {
          ...page,
          nodes: page.nodes.map((node) => ({
            ...node,
            payload: { ...node.payload, verdict: "pay" },
          })),
        };
      },
    };
    const { audit } = harness({ store: edited });

    await expect(drain(audit.walk(CASE_A, { pageSize: 2 }))).rejects.toThrow(
      /stored canonical form disagrees/,
    );
  });
});

describe("audit — a page that breaks the contract is refused", () => {
  const walkOf = async (store: TraceStore, pageSize = 2) => {
    const { audit } = harness({ store });
    return drain(audit.walk(CASE_A, { pageSize }));
  };

  const populated = async () => {
    const inner = inMemoryTraceStore();
    const writer = harness({ store: inner });
    await caseOf(writer.audit, CASE_A, 10);
    return inner;
  };

  it("refuses a page longer than the limit it was given", async () => {
    const inner = await populated();
    const overlong: TraceStore = {
      ...inner,
      readPage: (request) => inner.readPage({ ...request, limit: request.limit + 5 }),
    };
    await expect(walkOf(overlong)).rejects.toThrow(StoreContractViolated);
  });

  it("refuses a page that goes backwards past its own cursor", async () => {
    const inner = await populated();
    const rewinding: TraceStore = {
      ...inner,
      async readPage(request): Promise<TracePage | undefined> {
        const page = await inner.readPage(request);
        if (page === undefined || request.afterSequence === undefined) return page;
        // Hand back the very first node again on the second page. A streaming
        // reader cannot sort, so an out-of-order page is refused rather than
        // repaired — otherwise the digest is computed over an order the store
        // never assigned.
        const first = (await inner.readPage({ ...request, afterSequence: undefined }))
          ?.nodes[0];
        return first === undefined ? page : { ...page, nodes: [first, ...page.nodes] };
      },
    };
    await expect(walkOf(rewinding)).rejects.toThrow(StoreContractViolated);
  });

  it("refuses to spin on a store that promises more and returns nothing", async () => {
    const inner = await populated();
    const stalling: TraceStore = {
      ...inner,
      async readPage(request): Promise<TracePage | undefined> {
        const page = await inner.readPage(request);
        if (page === undefined) return undefined;
        return { ...page, nodes: [], more: true };
      },
    };
    // An operator command that never returns is the silent-failure quadrant
    // with a progress bar on it. This one returns, with a name.
    await expect(walkOf(stalling)).rejects.toThrow(StoreContractViolated);
  });

  it("stops at its own node ceiling rather than walking forever", async () => {
    const inner = await populated();
    const { audit } = harness({ store: inner });

    // The ceiling above the store's own, for a store that miscounts `more`. A
    // walk that never returns is an outage with no error in it, so this one
    // ends with a name on it.
    await expect(
      drain(audit.walk(CASE_A, { pageSize: 2, maxNodes: 3 })),
    ).rejects.toThrow(/capacity/);
  });

  it("refuses a scope statement that changes between two pages of one walk", async () => {
    const inner = await populated();
    const shifting: TraceStore = {
      ...inner,
      async readPage(request): Promise<TracePage | undefined> {
        const page = await inner.readPage(request);
        if (page === undefined || request.afterSequence === undefined) return page;
        return { ...page, provenance: { ...page.provenance, openedAt: 1 } };
      },
    };
    await expect(walkOf(shifting)).rejects.toThrow(StoreContractViolated);
  });
});
