import { describe, expect, it } from "vitest";
import {
  createAudit,
  inMemoryTraceStore,
  type Clock,
  type CorrelationId,
} from "../index.js";

/**
 * Slice 1 — a case can be opened, nodes recorded under it, and the graph
 * replayed by correlation identifier.
 *
 * These tests cross the same seam as the nineteen callers: they import only
 * from `../index.js`. Reaching into `../lib/` would mean the module is the
 * wrong shape, and `npm run lint:boundaries` fails the build if we try.
 *
 * Every dependency is injected. There is no model client, no HTTP client and
 * no real clock anywhere in this module, so these tests cannot reach a network
 * even with live credentials present in the environment.
 */

const fixedClock = (startMs: number): Clock => {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  } as Clock & { advance: (ms: number) => void };
};

const CASE_A = "case_a" as CorrelationId;

const setup = () => {
  const clock = fixedClock(1_700_000_000_000) as Clock & {
    advance: (ms: number) => void;
  };
  const store = inMemoryTraceStore();
  const audit = createAudit({ store, clock });
  return { audit, store, clock };
};

describe("audit — opening and recording", () => {
  it("assigns sequence numbers from the store, not the caller", async () => {
    const { audit } = setup();
    const trace = await audit.open(CASE_A);

    const first = await trace.record({ kind: "decision.classified", tier: "low" });
    const second = await trace.record({ kind: "decision.decided", verdict: "pay" });

    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
  });

  it("stamps every node with the injected clock", async () => {
    const { audit, clock } = setup();
    const trace = await audit.open(CASE_A);

    const first = await trace.record({ kind: "decision.classified", tier: "low" });
    clock.advance(250);
    const second = await trace.record({ kind: "decision.decided", verdict: "pay" });

    expect(first.at).toBe(1_700_000_000_000);
    expect(second.at).toBe(1_700_000_000_250);
  });

  it("records parentage, so the trace is a graph and not a list", async () => {
    const { audit } = setup();
    const trace = await audit.open(CASE_A);

    const decision = await trace.record({ kind: "decision.decided", verdict: "pay" });
    const modelCall = await trace.record(
      { kind: "model.call", tokensIn: 900, tokensOut: 120 },
      decision,
    );

    expect(modelCall.parent).toBe(decision.id);
    expect(decision.parent).toBeUndefined();
  });

  it("gives every node a distinct identity", async () => {
    const { audit } = setup();
    const trace = await audit.open(CASE_A);

    const a = await trace.record({ kind: "decision.classified", tier: "low" });
    const b = await trace.record({ kind: "decision.classified", tier: "low" });

    expect(a.id).not.toBe(b.id);
  });
});

describe("audit — replay", () => {
  it("reproduces the graph, not just the last answer", async () => {
    const { audit } = setup();
    const trace = await audit.open(CASE_A);

    const decision = await trace.record({ kind: "decision.decided", verdict: "pay" });
    await trace.record({ kind: "model.call", tokensIn: 900, tokensOut: 120 }, decision);
    await trace.record({ kind: "guardrail.screened", findings: 0 }, decision);

    const replayed = await audit.replay(CASE_A);

    expect(replayed.nodes).toHaveLength(3);
    expect(replayed.childrenOf(decision.id)).toHaveLength(2);
    expect(replayed.roots()).toHaveLength(1);
  });

  it("returns nodes in recorded order", async () => {
    const { audit } = setup();
    const trace = await audit.open(CASE_A);

    await trace.record({ kind: "decision.classified", tier: "low" });
    await trace.record({ kind: "decision.decided", verdict: "pay" });

    const replayed = await audit.replay(CASE_A);

    expect(replayed.nodes.map((n) => n.sequence)).toEqual([0, 1]);
  });

  it("keeps cases separate", async () => {
    const { audit } = setup();
    const a = await audit.open(CASE_A);
    const b = await audit.open("case_b" as CorrelationId);

    await a.record({ kind: "decision.decided", verdict: "pay" });
    await b.record({ kind: "decision.decided", verdict: "deny" });

    expect((await audit.replay(CASE_A)).nodes).toHaveLength(1);
    expect((await audit.replay("case_b" as CorrelationId)).nodes).toHaveLength(1);
  });

  it("reports a case it has never seen rather than inventing an empty one", async () => {
    const { audit } = setup();

    await expect(audit.replay("never_happened" as CorrelationId)).rejects.toThrow(
      /no such case/i,
    );
  });
});

describe("audit — append-only", () => {
  it("exposes no way to change or remove a recorded node", async () => {
    const { audit } = setup();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", verdict: "pay" });

    // The guarantee is the absence of the verbs, so this is what there is to
    // assert at this seam. The database grants carry the other half.
    expect("update" in trace).toBe(false);
    expect("delete" in trace).toBe(false);
    expect("amend" in trace).toBe(false);
  });

  it("refuses to record against a closed case", async () => {
    const { audit } = setup();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", verdict: "pay" });
    await trace.close({ unassistedContainment: true });

    await expect(
      trace.record({ kind: "decision.decided", verdict: "pay" }),
    ).rejects.toThrow(/closed/i);
  });

  it("refuses to close a case twice", async () => {
    const { audit } = setup();
    const trace = await audit.open(CASE_A);
    await trace.close({ unassistedContainment: true });

    await expect(trace.close({ unassistedContainment: true })).rejects.toThrow(
      /closed/i,
    );
  });
});
