import { describe, expect, it } from "vitest";
import { CASE_A, CASE_B, harness, mustRecord } from "./fixtures.js";
import { ENVELOPE_VERSION, type CorrelationId } from "../index.js";

/**
 * Slice 1 — a case can be opened, nodes recorded under it, and the graph
 * replayed by correlation identifier.
 *
 * These tests cross the same seam as the nineteen callers: they import only
 * from `../index.js` (and their own fixtures). Reaching into `../lib/` would
 * mean the module is the wrong shape, and `npm run lint:boundaries` fails the
 * build if we try.
 */

describe("audit — opening and recording", () => {
  it("assigns sequence numbers from the store, not the caller", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    const first = mustRecord(
      await trace.record({ kind: "decision.classified", v: 1 }, { tier: "low" }),
    );
    const second = mustRecord(
      await trace.record(
        { kind: "decision.decided", v: 1, verdict: "pay" },
        { tier: "high" },
      ),
    );

    expect(first.node.sequence).toBe(0);
    expect(second.node.sequence).toBe(1);
  });

  it("stamps every node with the injected clock", async () => {
    const { audit, clock } = harness();
    const trace = await audit.open(CASE_A);

    const first = mustRecord(
      await trace.record({ kind: "decision.classified", v: 1 }, { tier: "low" }),
    );
    clock.advance(250);
    const second = mustRecord(
      await trace.record({ kind: "decision.decided", v: 1 }, { tier: "low" }),
    );

    expect(first.node.at).toBe(1_700_000_000_000);
    expect(second.node.at).toBe(1_700_000_000_250);
  });

  it("records parentage, so the trace is a graph and not a list", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    const decision = mustRecord(
      await trace.record(
        { kind: "decision.decided", v: 1, verdict: "pay" },
        { tier: "high" },
      ),
    ).node;
    const modelCall = mustRecord(
      await trace.record(
        { kind: "model.call", v: 1, tokensIn: 900, tokensOut: 120 },
        { tier: "high", parent: decision },
      ),
    ).node;

    expect(modelCall.parent).toBe(decision.id);
    expect(decision.parent).toBeUndefined();
  });

  it("gives every node a distinct identity", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    const a = mustRecord(
      await trace.record({ kind: "decision.classified", v: 1 }, { tier: "low" }),
    ).node;
    const b = mustRecord(
      await trace.record({ kind: "decision.classified", v: 1 }, { tier: "low" }),
    ).node;

    expect(a.id).not.toBe(b.id);
  });

  it("stamps the tier on the node, so a case's tier profile is readable", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    await trace.record({ kind: "document.extracted", v: 1 }, { tier: "low" });
    await trace.record({ kind: "payment.authorised", v: 1 }, { tier: "high" });

    const replayed = await audit.replay(CASE_A);
    expect(replayed.nodes.map((n) => n.tier)).toEqual(["low", "high"]);
  });
});

describe("audit — replay", () => {
  it("reproduces the graph, not just the last answer", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    const decision = mustRecord(
      await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" }),
    ).node;
    await trace.record(
      { kind: "model.call", v: 1, tokensIn: 900 },
      { tier: "high", parent: decision },
    );
    await trace.record(
      { kind: "guardrail.screened", v: 1, findings: 0 },
      { tier: "high", parent: decision },
    );

    const replayed = await audit.replay(CASE_A);

    expect(replayed.nodes).toHaveLength(3);
    expect(replayed.childrenOf(decision.id)).toHaveLength(2);
    expect(replayed.roots()).toHaveLength(1);
  });

  it("returns nodes in store-assigned sequence order", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    await trace.record({ kind: "decision.classified", v: 1 }, { tier: "low" });
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "low" });

    const replayed = await audit.replay(CASE_A);

    expect(replayed.nodes.map((n) => n.sequence)).toEqual([0, 1]);
  });

  it("keeps cases separate", async () => {
    const { audit } = harness();
    const a = await audit.open(CASE_A);
    const b = await audit.open(CASE_B);

    await a.record({ kind: "decision.decided", v: 1, verdict: "pay" }, { tier: "low" });
    await b.record({ kind: "decision.decided", v: 1, verdict: "deny" }, { tier: "low" });

    expect((await audit.replay(CASE_A)).nodes).toHaveLength(1);
    expect((await audit.replay(CASE_B)).nodes).toHaveLength(1);
  });

  it("reports a case it has never seen rather than inventing an empty one", async () => {
    const { audit } = harness();

    await expect(audit.replay("never_happened" as CorrelationId)).rejects.toThrow(
      /no such case/i,
    );
  });

  it("stamps the scope of the guarantee onto the case itself", async () => {
    const { audit } = harness();
    await audit.open(CASE_A);

    const replayed = await audit.replay(CASE_A);

    // A reader in 2033 learns what the evidence covers from the evidence.
    expect(replayed.provenance.capturedVia).toBe("injected-trace-store-only");
    // The envelope in force when the case was opened. Nodes carry their own in
    // their own bytes, so this is the case's starting point rather than a claim
    // about every node under it.
    expect(replayed.provenance.canonicalForm).toBe(ENVELOPE_VERSION);
  });
});

describe("audit — append-only", () => {
  it("exposes no way to change or remove a recorded node", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "low" });

    // The guarantee is the absence of the verbs, so this is what there is to
    // assert at this seam. The database grants carry the other half.
    expect("update" in trace).toBe(false);
    expect("delete" in trace).toBe(false);
    expect("amend" in trace).toBe(false);
  });

  it("refuses to record against a closed case", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "low" });
    await trace.close({ unassistedContainment: true });

    await expect(
      trace.record({ kind: "decision.decided", v: 1 }, { tier: "low" }),
    ).rejects.toThrow(/closed/i);
  });

  it("refuses to record against a closed case even at a degrading tier", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.close({ unassistedContainment: true });

    // CaseAlreadyClosed is not the store being unavailable, so no fail policy
    // makes it degradable: it would put a decision after the outcome that was
    // supposed to summarise it.
    await expect(
      trace.record({ kind: "decision.decided", v: 1 }, { tier: "low" }),
    ).rejects.toThrow(/closed/i);
  });

  it("refuses to close a case twice", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.close({ unassistedContainment: true });

    await expect(trace.close({ unassistedContainment: true })).rejects.toThrow(
      /closed/i,
    );
  });
});
