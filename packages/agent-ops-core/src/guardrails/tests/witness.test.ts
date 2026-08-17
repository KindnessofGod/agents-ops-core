import { describe, expect, it } from "vitest";
import type {
  Audit,
  CaseTrace,
  CorrelationId,
  NodeId,
  NodePayload,
  RecordOptions,
  RecordResult,
  RecordedNode,
  RedactionId,
  ReplayedCase,
  RiskTier,
  TraceDigest,
} from "../../audit/index.js";
import { CASE_A, harness, quietDetector, sameAtEveryTier, setOf } from "./fixtures.js";
import { AuditWitnessUnsound, NODE, createGuardrails, DEFAULT_LIMITS } from "../index.js";
import { EN_GB, manualClock, manualTimer } from "./fixtures.js";

/**
 * The recording **witness**, and the hole `OPEN-ITEMS-RESOLVED.md` §1 declared
 * closed and this module inherited open.
 *
 * `GuardrailsDeps.audit` is a structural interface. The brand that §1 resolved
 * on sits on `Screening` — the artefact this module mints — and on `TraceStore`,
 * one layer below. It does **not** sit on `Audit`, so a caller can hand
 * `createGuardrails` a fully-typed object that acknowledges every write and
 * persists nothing, and receive a real branded `Screening` back with zero bytes
 * in any store. `result.recorded === true` is a claim the witness makes about
 * itself.
 *
 * A brand on `Audit` is `audit`'s interface to change and is reported upward.
 * What this module can do without it is refuse to trust an acknowledgement:
 * **replay is the proof of a write**, in `audit`'s own words, so the first node
 * of a case is proven by replay before any detector runs.
 */

const impostorAudit = (options: { readonly replay?: readonly RecordedNode[] } = {}): Audit => {
  let sequence = 0;
  const mint = (payload: NodePayload, tier: RiskTier, parent?: RecordedNode): RecordedNode => {
    const node: RecordedNode = {
      id: `impostor-${sequence}` as NodeId,
      correlationId: CASE_A,
      sequence: sequence,
      at: 1_700_000_000_000,
      tier,
      ...(parent === undefined ? {} : { parent: parent.id }),
      payloadSchemaVersion: payload.v,
      redaction: "impostor" as RedactionId,
      payload,
      canonical: `{"impostor":${sequence}}`,
    };
    sequence += 1;
    return node;
  };
  return {
    async open(correlationId: CorrelationId): Promise<CaseTrace> {
      return {
        correlationId,
        async record<T extends RiskTier>(
          payload: NodePayload,
          opts: RecordOptions<T>,
        ): Promise<RecordResult<T>> {
          // The whole impostor: it says yes and writes nothing.
          return { recorded: true, node: mint(payload, opts.tier, opts.parent) } as RecordResult<T>;
        },
        async close(): Promise<RecordedNode> {
          return mint({ kind: "case.sealed", v: 1 }, "high");
        },
      };
    },
    async replay(correlationId: CorrelationId): Promise<ReplayedCase> {
      const nodes = options.replay ?? [];
      return {
        correlationId,
        provenance: {
          capturedVia: "injected-trace-store-only",
          canonicalForm: "impostor",
          redaction: "impostor" as RedactionId,
          openedAt: 1_700_000_000_000,
        },
        nodes,
        closed: false,
        roots: () => [],
        childrenOf: () => [],
        digest: () => "impostor" as TraceDigest,
        verify: () => true,
      };
    },
  };
};

const withAudit = (audit: Audit) =>
  createGuardrails({
    audit,
    clock: manualClock(),
    timer: manualTimer(),
    locale: EN_GB,
    detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])),
    limits: DEFAULT_LIMITS,
  });

describe("guardrails — the recording witness is not taken at its word", () => {
  it("refuses a witness that acknowledges a write and persists nothing", async () => {
    const guardrails = withAudit(impostorAudit());

    await expect(
      guardrails.screenInput({ correlationId: CASE_A, tier: "high", payload: { a: "b" } }),
    ).rejects.toBeInstanceOf(AuditWitnessUnsound);
  });

  it("refuses before any detector has been asked to run", async () => {
    let ran = 0;
    const guardrails = createGuardrails({
      audit: impostorAudit(),
      clock: manualClock(),
      timer: manualTimer(),
      locale: EN_GB,
      detectorSets: sameAtEveryTier(
        setOf("counting", [
          {
            ...quietDetector(),
            screen: () => {
              ran += 1;
              return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
            },
          },
        ]),
      ),
      limits: DEFAULT_LIMITS,
    });

    await expect(
      guardrails.screenInput({ correlationId: CASE_A, tier: "low", payload: { a: "b" } }),
    ).rejects.toBeInstanceOf(AuditWitnessUnsound);
    expect(ran).toBe(0);
  });

  it("refuses a witness whose replay disagrees with what it acknowledged", async () => {
    // A witness that replays *a* node under the right identifier but not the
    // bytes it acknowledged. Coherence is the check, not presence.
    const wrong: RecordedNode = {
      id: "impostor-0" as NodeId,
      correlationId: CASE_A,
      sequence: 0,
      at: 1_700_000_000_000,
      tier: "high",
      payloadSchemaVersion: 1,
      redaction: "impostor" as RedactionId,
      payload: { kind: "something.else", v: 1 },
      canonical: `{"impostor":0}`,
    };
    const guardrails = withAudit(impostorAudit({ replay: [wrong] }));

    await expect(
      guardrails.screenInput({ correlationId: CASE_A, tier: "high", payload: { a: "b" } }),
    ).rejects.toBeInstanceOf(AuditWitnessUnsound);
  });

  it("accepts a real witness, and stamps how the proof was obtained", async () => {
    const h = harness({ detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])) });
    const first = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "high",
      payload: { a: "b" },
    });

    const settled = (await h.nodes()).find((n) => n.id === first.nodes.settled);
    expect(settled?.payload["witnessProof"]).toBe("replay");

    // Proven once per case, not once per screening: the second screening on the
    // same case does not replay the trace again, because that read grows without
    // limit in the number of nodes already recorded.
    const second = await h.guardrails.checkOutput({
      after: first,
      tier: "high",
      output: { answer: "ok" },
      sources: { available: false, why: "none" },
    });
    const secondSettled = (await h.nodes()).find((n) => n.id === second.nodes.settled);
    expect(secondSettled?.payload["witnessProof"]).toBe("proven-earlier-in-process");
  });

  it("stamps the scope of the guarantee onto the opened node rather than asserting it in prose", async () => {
    const h = harness({ detectorSets: sameAtEveryTier(setOf("quiet", [quietDetector()])) });
    await h.guardrails.screenInput({ correlationId: CASE_A, tier: "low", payload: { a: "b" } });

    const opened = (await h.nodes()).find((n) => n.payload.kind === NODE.opened);
    expect(opened?.payload["capturedVia"]).toBe("caller-supplied-audit-witness");
  });
});
