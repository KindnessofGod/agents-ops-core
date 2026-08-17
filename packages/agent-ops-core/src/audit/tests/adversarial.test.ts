import { describe, expect, it } from "vitest";
import {
  CASE_A,
  CASE_B,
  degradeBelowHigh,
  harness,
  mustRecord,
  redactNothing,
  strictPolicy,
  testClock,
} from "./fixtures.js";
import {
  ENVELOPE_VERSION,
  ParentNotOfThisCase,
  PayloadTooLarge,
  ProvenanceConflict,
  REDACTED,
  ReservedNodeKind,
  SEAL_KIND,
  StoreContractViolated,
  TRACE_DIGEST_VERSION,
  TraceCorrupt,
  TraceIncoherent,
  TraceUnavailable,
  UnknownEnvelope,
  canonicalNodeForm,
  createAudit,
  inMemoryTraceStore,
  postgresTraceStore,
  redactAllExcept,
  redactFields,
  traceDigest,
  type CorrelationId,
  type NodeId,
  type RecordedNode,
  type SqlExecutor,
  type StoredCase,
  type TraceStore,
} from "../index.js";

/**
 * Adversarial slice — each test here reproduces a defect an adversarial
 * reviewer demonstrated against this module. Every one of them failed before
 * the corresponding fix landed, which is the only reason to trust the fix.
 *
 * They cross the same seam as the nineteen callers: `../index.js` only.
 */

// ---------------------------------------------------------------------------
// 1. An impostor store must not be able to report a trace that does not exist
// ---------------------------------------------------------------------------

describe("audit — the store seam cannot be impersonated", () => {
  it("rejects a store that acknowledges without writing", async () => {
    // The eight-line `nowhere` store: fabricates its own sequence, returns
    // empty canonical bytes, writes nothing. It no longer typechecks (see
    // lib/invariants.ts) and it no longer passes at runtime either.
    const nowhere = {
      openCase: async () => undefined,
      append: async (input: { readonly correlationId: CorrelationId }) => ({
        node: {
          id: "forged" as NodeId,
          correlationId: input.correlationId,
          sequence: 0,
          at: 0,
          tier: "high" as const,
          payloadSchemaVersion: 1,
          redaction: "none",
          payload: { kind: "payment.authorised", v: 1 },
          canonical: "",
        },
        deduplicated: false,
      }),
      closeCase: async () => {
        throw new Error("unreachable");
      },
      read: async () => undefined,
    } as unknown as TraceStore;

    const { audit } = harness({ store: nowhere });
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record({ kind: "payment.authorised", v: 1 }, { tier: "high" }),
    ).rejects.toThrow(StoreContractViolated);
  });

  it("rejects a store that reuses a sequence across appends", async () => {
    const inner = inMemoryTraceStore();
    const frozen: TraceStore = {
      ...inner,
      async append(input) {
        const ack = await inner.append(input);
        return { ...ack, node: { ...ack.node, sequence: 0 } };
      },
    };
    const { audit } = harness({ store: frozen });
    const trace = await audit.open(CASE_A);

    // The first append is honestly sequence 0, so it passes. The second is
    // sequence 1 in the bytes and 0 in the acknowledgement, which is both a
    // repeat and a disagreement between the node and its own canonical form.
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });
    await expect(
      trace.record({ kind: "b", v: 1 }, { tier: "low" }),
    ).rejects.toThrow(StoreContractViolated);
  });
});

// ---------------------------------------------------------------------------
// 2. A parent from another case must never be accepted
// ---------------------------------------------------------------------------

describe("audit — parentage stays inside one case", () => {
  it("refuses a parent belonging to a different correlation identifier", async () => {
    const { audit } = harness();
    const a = await audit.open(CASE_A);
    const b = await audit.open(CASE_B);

    const foreign = mustRecord(
      await a.record({ kind: "decision.decided", v: 1 }, { tier: "low" }),
    ).node;

    await expect(
      b.record({ kind: "model.call", v: 1 }, { tier: "low", parent: foreign }),
    ).rejects.toThrow(ParentNotOfThisCase);
  });

  it("is not degradable, because it is a caller defect and not an outage", async () => {
    const { audit } = harness({ onTraceUnavailable: degradeBelowHigh });
    const a = await audit.open(CASE_A);
    const b = await audit.open(CASE_B);
    const foreign = mustRecord(
      await a.record({ kind: "decision.decided", v: 1 }, { tier: "low" }),
    ).node;

    await expect(
      b.record({ kind: "model.call", v: 1 }, { tier: "low", parent: foreign }),
    ).rejects.toThrow(ParentNotOfThisCase);
  });
});

// ---------------------------------------------------------------------------
// 3. The seal kind is reserved to the library
// ---------------------------------------------------------------------------

describe("audit — the terminal node kind is reserved", () => {
  it("refuses a caller-authored node using the seal kind", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record({ kind: SEAL_KIND, v: 1 }, { tier: "low" }),
    ).rejects.toThrow(ReservedNodeKind);
  });

  it("leaves the case open and writable after the attempt", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace
      .record({ kind: SEAL_KIND, v: 1 }, { tier: "low" })
      .catch(() => undefined);

    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "low" });
    const replayed = await audit.replay(CASE_A);

    expect(replayed.closed).toBe(false);
    expect(replayed.nodes).toHaveLength(1);
  });

  it("is refused by the store adapter too, not only by the module", async () => {
    const store = inMemoryTraceStore();
    await store.openCase(CASE_A, {
      capturedVia: "injected-trace-store-only",
      canonicalForm: ENVELOPE_VERSION,
      redaction: redactNothing.id,
      openedAt: 0,
    });

    await expect(
      store.append({
        correlationId: CASE_A,
        at: 0,
        tier: "low",
        payload: { kind: SEAL_KIND, v: 1 },
        redaction: redactNothing.id,
        parent: undefined,
        telemetry: undefined,
        idempotencyKey: undefined,
      }),
    ).rejects.toThrow(ReservedNodeKind);
  });
});

// ---------------------------------------------------------------------------
// 4. The seal digest is checked on replay
// ---------------------------------------------------------------------------

/** Hands back the stored trace with one node removed. */
const droppingStore = (inner: TraceStore, sequence: number): TraceStore => ({
  ...inner,
  async read(correlationId): Promise<StoredCase | undefined> {
    const stored = await inner.read(correlationId);
    if (stored === undefined) return undefined;
    return {
      provenance: stored.provenance,
      nodes: stored.nodes.filter((n) => n.sequence !== sequence),
    };
  },
});

/** Hands back the stored trace with one extra, well-formed node after the seal. */
const appendingStore = (inner: TraceStore): TraceStore => ({
  ...inner,
  async read(correlationId): Promise<StoredCase | undefined> {
    const stored = await inner.read(correlationId);
    if (stored === undefined) return undefined;
    const sequence = stored.nodes.length;
    const skeleton = {
      id: `${correlationId}#${sequence}` as NodeId,
      correlationId,
      sequence,
      at: 0,
      tier: "low" as const,
      payloadSchemaVersion: 1,
      redaction: stored.provenance.redaction,
      payload: { kind: "approval.granted", v: 1, forged: true },
    };
    const forged: RecordedNode = {
      ...skeleton,
      canonical: canonicalNodeForm(skeleton),
    };
    return { provenance: stored.provenance, nodes: [...stored.nodes, forged] };
  },
});

describe("audit — the seal is read, not merely written", () => {
  const sealedCase = async (store: TraceStore) => {
    const { audit } = harness({ store });
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "document.extracted", v: 1 }, { tier: "low" });
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });
    await trace.record({ kind: "payment.effected", v: 1 }, { tier: "high" });
    await trace.close({ unassistedContainment: false });
  };

  it("detects a removed row", async () => {
    const inner = inMemoryTraceStore();
    await sealedCase(inner);

    const { audit } = harness({ store: droppingStore(inner, 2) });
    await expect(audit.replay(CASE_A)).rejects.toThrow(TraceIncoherent);
  });

  it("detects a row inserted after the seal", async () => {
    const inner = inMemoryTraceStore();
    await sealedCase(inner);

    const { audit } = harness({ store: appendingStore(inner) });
    await expect(audit.replay(CASE_A)).rejects.toThrow(TraceIncoherent);
  });

  it("detects a duplicated sequence", async () => {
    const inner = inMemoryTraceStore();
    const { audit: writer } = harness({ store: inner });
    const trace = await writer.open(CASE_A);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });

    const doubling: TraceStore = {
      ...inner,
      async read(correlationId): Promise<StoredCase | undefined> {
        const stored = await inner.read(correlationId);
        if (stored === undefined) return undefined;
        const first = stored.nodes[0];
        if (first === undefined) return stored;
        return { provenance: stored.provenance, nodes: [first, first] };
      },
    };

    const { audit } = harness({ store: doubling });
    await expect(audit.replay(CASE_A)).rejects.toThrow(TraceIncoherent);
  });

  it("detects a rewritten scope statement on a sealed case", async () => {
    const inner = inMemoryTraceStore();
    await sealedCase(inner);

    const rewritten: TraceStore = {
      ...inner,
      async read(correlationId): Promise<StoredCase | undefined> {
        const stored = await inner.read(correlationId);
        if (stored === undefined) return undefined;
        return {
          provenance: { ...stored.provenance, redaction: redactAllExcept([]).id },
          nodes: stored.nodes,
        };
      },
    };

    const { audit } = harness({ store: rewritten });
    await expect(audit.replay(CASE_A)).rejects.toThrow(TraceIncoherent);
  });
});

// ---------------------------------------------------------------------------
// 5. Schema evolution actually works
// ---------------------------------------------------------------------------

/** Rewrites every node's stored bytes under a named older envelope. */
const olderEnvelopeStore = (inner: TraceStore, envelope: string): TraceStore => ({
  ...inner,
  async read(correlationId): Promise<StoredCase | undefined> {
    const stored = await inner.read(correlationId);
    if (stored === undefined) return undefined;
    return {
      provenance: { ...stored.provenance, canonicalForm: envelope },
      nodes: stored.nodes.map((node) => ({
        ...node,
        canonical: canonicalNodeForm(node, envelope),
      })),
    };
  },
});

describe("audit — a node keeps its own envelope forever", () => {
  it("replays a node canonicalised under a superseded envelope", async () => {
    const inner = inMemoryTraceStore();
    const { audit: writer } = harness({ store: inner });
    const trace = await writer.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });

    const { audit } = harness({ store: olderEnvelopeStore(inner, "aoc.audit.node.v1") });
    const replayed = await audit.replay(CASE_A);

    expect(replayed.nodes).toHaveLength(1);
    expect(replayed.digest().startsWith(TRACE_DIGEST_VERSION)).toBe(true);
  });

  it("says it does not know an envelope rather than calling it tampering", async () => {
    const inner = inMemoryTraceStore();
    const { audit: writer } = harness({ store: inner });
    const trace = await writer.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });

    const fromTheFuture: TraceStore = {
      ...inner,
      async read(correlationId): Promise<StoredCase | undefined> {
        const stored = await inner.read(correlationId);
        if (stored === undefined) return undefined;
        return {
          provenance: stored.provenance,
          nodes: stored.nodes.map((node) => ({
            ...node,
            canonical: node.canonical.replace(ENVELOPE_VERSION, "aoc.audit.node.v9"),
          })),
        };
      },
    };

    const { audit } = harness({ store: fromTheFuture });
    await expect(audit.replay(CASE_A)).rejects.toThrow(UnknownEnvelope);
  });

  it("keeps an old witnessed digest verifiable after a digest version bump", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });

    const replayed = await audit.replay(CASE_A);
    const witnessedUnderV1 = traceDigest(replayed.nodes, "aoc.audit.trace.v1");

    // `verify` reads the version out of the digest it is given rather than
    // reinterpreting it under whatever this release happens to use.
    expect(replayed.verify(witnessedUnderV1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. `__proto__` must not vanish
// ---------------------------------------------------------------------------

describe("audit — a payload field never disappears silently", () => {
  const withProto = () =>
    JSON.parse(
      '{"kind":"document.extracted","v":1,"safe":"ok","__proto__":"secret"}',
    ) as { kind: string; v: number };

  it("keeps a field named __proto__ under the deny-list redactor", async () => {
    // `out[field] = value` on a plain object silently swallows `__proto__`, so
    // the field used to vanish from the evidence with no error and no marker —
    // and it vanished *after* the payload was proven canonicalisable, so
    // nothing downstream could notice.
    const { audit } = harness({ redact: redactFields([]) });
    const trace = await audit.open(CASE_A);

    const node = mustRecord(
      await trace.record(withProto(), { tier: "high" }),
    ).node;

    expect(Object.keys(node.payload)).toContain("__proto__");
    expect(node.canonical).toContain("__proto__");
  });

  it("redacts a field named __proto__ rather than deleting it", async () => {
    const { audit } = harness({ redact: redactFields(["__proto__"]) });
    const trace = await audit.open(CASE_A);

    const node = mustRecord(
      await trace.record(withProto(), { tier: "high" }),
    ).node;

    expect(Object.keys(node.payload)).toContain("__proto__");
    expect(node.payload["__proto__"]).toBe(REDACTED);
    expect(node.canonical).not.toContain("secret");
  });

  it("leaves a marker rather than a hole under the deny-by-default redactor", async () => {
    const { audit } = harness({ redact: redactAllExcept(["safe"]) });
    const trace = await audit.open(CASE_A);

    const node = mustRecord(
      await trace.record(withProto(), { tier: "high" }),
    ).node;

    // Key and value both go, and a marker stays, so "a field was here" survives.
    expect(node.canonical).not.toContain("secret");
    expect(node.canonical).toContain("[redacted-field].");
  });
});

// ---------------------------------------------------------------------------
// 7. Bounded resources
// ---------------------------------------------------------------------------

describe("audit — nothing is unbounded", () => {
  it("bounds the number of cases the in-memory adapter retains", async () => {
    const store = inMemoryTraceStore({ maxCases: 2 });
    const { audit } = harness({ store });
    await audit.open("c0" as CorrelationId);
    await audit.open("c1" as CorrelationId);

    await expect(audit.open("c2" as CorrelationId)).rejects.toThrow(TraceUnavailable);
  });

  it("releases closed cases explicitly rather than growing forever", async () => {
    const store = inMemoryTraceStore({ maxCases: 2 });
    const { audit } = harness({ store });
    const a = await audit.open("c0" as CorrelationId);
    await a.close({ unassistedContainment: true });

    expect(store.releaseClosed(10)).toBe(1);
    await audit.open("c1" as CorrelationId);
    await audit.open("c2" as CorrelationId);
  });

  it("bounds the size of one payload", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record(
        { kind: "document.extracted", v: 1, blob: "x".repeat(200_000) },
        { tier: "low" },
      ),
    ).rejects.toThrow(PayloadTooLarge);
  });

  it("sheds Postgres writes rather than queueing them without limit", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const executor: SqlExecutor = {
      query: async (text: string) => {
        if (text.includes("audit:open-case")) return { rows: [] };
        if (text.includes("audit:read-case")) {
          return {
            rows: [
              {
                captured_via: "injected-trace-store-only",
                canonical_form: ENVELOPE_VERSION,
                redaction: String(redactNothing.id),
                opened_at_ms: "0",
              },
            ],
          };
        }
        await gate;
        return { rows: [{ next_sequence: 0, sealed: false }] };
      },
      transaction: async (fn) => fn(executor),
    };

    const store = postgresTraceStore(executor, { maxPendingWrites: 2 });
    const audit = createAudit({
      store,
      clock: testClock(0),
      redact: redactNothing,
      onTraceUnavailable: strictPolicy,
    });
    const trace = await audit.open(CASE_A);

    const attempts = Array.from({ length: 8 }, () =>
      trace.record({ kind: "a", v: 1 }, { tier: "low" }).catch((e: unknown) => e),
    );
    // Release before awaiting: the two that acquired a slot are parked on the
    // gate, and nothing sheds a write by waiting for it.
    release?.();
    const settled = await Promise.all(attempts);

    const shed = settled.filter(
      (r) => r instanceof TraceUnavailable && r.reason === "backpressure",
    );
    expect(shed.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. A defect is not reported as an outage
// ---------------------------------------------------------------------------

describe("audit — a defect is never degraded into a missing node", () => {
  it("does not degrade an integrity violation at a degrading tier", async () => {
    const executor: SqlExecutor = {
      query: async (text: string) => {
        if (text.includes("audit:open-case")) return { rows: [] };
        if (text.includes("audit:read-case")) {
          return {
            rows: [
              {
                captured_via: "injected-trace-store-only",
                canonical_form: ENVELOPE_VERSION,
                redaction: String(redactNothing.id),
                opened_at_ms: "0",
              },
            ],
          };
        }
        if (text.includes("audit:lock")) return { rows: [{}] };
        if (text.includes("audit:next-sequence")) {
          return { rows: [{ next_sequence: 0, sealed: false }] };
        }
        const violation = Object.assign(
          new Error("insert or update violates foreign key constraint"),
          { code: "23503" },
        );
        throw violation;
      },
      transaction: async (fn) => fn(executor),
    };

    const audit = createAudit({
      store: postgresTraceStore(executor),
      clock: testClock(0),
      redact: redactNothing,
      onTraceUnavailable: degradeBelowHigh,
    });
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record({ kind: "a", v: 1 }, { tier: "low" }),
    ).rejects.toThrow(StoreContractViolated);
  });

  it("does not degrade a corrupt column into a missing node either", async () => {
    const executor: SqlExecutor = {
      query: async (text: string) => {
        if (text.includes("audit:open-case")) return { rows: [] };
        if (text.includes("audit:read-case")) {
          return {
            rows: [
              {
                captured_via: "injected-trace-store-only",
                canonical_form: ENVELOPE_VERSION,
                redaction: String(redactNothing.id),
                opened_at_ms: "0",
              },
            ],
          };
        }
        if (text.includes("audit:lock")) return { rows: [{}] };
        // A column that is not a number. Schema drift or corruption, not an
        // outage — and it used to arrive at the caller as "the store was down"
        // and then be dropped at low tier.
        return { rows: [{ next_sequence: "not-a-number", sealed: false }] };
      },
      transaction: async (fn) => fn(executor),
    };

    const audit = createAudit({
      store: postgresTraceStore(executor),
      clock: testClock(0),
      redact: redactNothing,
      onTraceUnavailable: degradeBelowHigh,
    });
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record({ kind: "a", v: 1 }, { tier: "low" }),
    ).rejects.toThrow(TraceCorrupt);
  });
});

// ---------------------------------------------------------------------------
// 10. Telemetry is a field, not nineteen invented key names
// ---------------------------------------------------------------------------

describe("audit — telemetry is part of the node, not of the payload", () => {
  it("records cost, tokens, latency and the price-table version per node", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    const node = mustRecord(
      await trace.record(
        { kind: "model.call", v: 1 },
        {
          tier: "high",
          telemetry: {
            costTenthCents: 41,
            tokensIn: 900,
            tokensOut: 120,
            latencyMicros: 1_240_000,
            priceTableVersion: "aoc.prices.2026-08",
          },
        },
      ),
    ).node;

    expect(node.telemetry?.costTenthCents).toBe(41);
    expect(node.canonical).toContain("aoc.prices.2026-08");

    const replayed = await audit.replay(CASE_A);
    expect(replayed.nodes[0]?.telemetry?.latencyMicros).toBe(1_240_000);
  });

  it("refuses a fractional cost, because floats are how byte-stability dies", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record(
        { kind: "model.call", v: 1 },
        {
          tier: "low",
          telemetry: {
            costTenthCents: 4.1,
            tokensIn: 900,
            tokensOut: 120,
            latencyMicros: 1,
            priceTableVersion: "aoc.prices.2026-08",
          },
        },
      ),
    ).rejects.toThrow(/IEEE-754|not byte-stably/);
  });
});

// ---------------------------------------------------------------------------
// 12. close() obeys the same error discipline as record()
// ---------------------------------------------------------------------------

describe("audit — close names its failures", () => {
  it("wraps a raw adapter failure as a named error mode", async () => {
    const inner = inMemoryTraceStore();
    const broken: TraceStore = {
      ...inner,
      async closeCase() {
        throw new Error("connection reset by peer");
      },
    };
    const { audit } = harness({ store: broken });
    const trace = await audit.open(CASE_A);

    const failure = await trace
      .close({ unassistedContainment: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(TraceUnavailable);
    expect((failure as TraceUnavailable).reason).toBe("store-failure");
  });

  it("refuses a seal the store did not actually author", async () => {
    const inner = inMemoryTraceStore();
    const lying: TraceStore = {
      ...inner,
      async closeCase(correlationId, at, outcome) {
        const seal = await inner.closeCase(correlationId, at, outcome);
        return { ...seal, canonical: "" };
      },
    };
    const { audit } = harness({ store: lying });
    const trace = await audit.open(CASE_A);

    await expect(trace.close({ unassistedContainment: true })).rejects.toThrow(
      StoreContractViolated,
    );
  });
});

// ---------------------------------------------------------------------------
// 14. Provenance cannot silently disagree with the nodes under it
// ---------------------------------------------------------------------------

describe("audit — the scope statement stays true", () => {
  it("refuses to reopen a case under a different redactor", async () => {
    const store = inMemoryTraceStore();
    const first = harness({ store, redact: redactAllExcept(["amountTenthCents"]) });
    await first.audit.open(CASE_A);

    const second = harness({ store, redact: redactAllExcept([]) });
    await expect(second.audit.open(CASE_A)).rejects.toThrow(ProvenanceConflict);
  });

  it("allows reopening under a newer envelope, because nodes carry their own", async () => {
    const store = inMemoryTraceStore();
    const { audit } = harness({ store });
    await audit.open(CASE_A);
    const again = await audit.open(CASE_A);

    await again.record({ kind: "a", v: 1 }, { tier: "low" });
    expect((await audit.replay(CASE_A)).nodes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 15. Redaction covers keys under the deny-by-default adapter
// ---------------------------------------------------------------------------

describe("audit — deny by default means the key too", () => {
  it("never lets personal data hide in a field name", async () => {
    const store = inMemoryTraceStore();
    const { audit } = harness({ store, redact: redactAllExcept(["amountTenthCents"]) });
    const trace = await audit.open(CASE_A);

    await trace.record(
      {
        kind: "claim.assessed",
        v: 1,
        "claimant.QQ123456C.amount": 4_720_000,
        amountTenthCents: 4_720_000,
      },
      { tier: "high" },
    );

    const bytes = ((await store.read(CASE_A))?.nodes ?? [])
      .map((n) => n.canonical)
      .join("");

    expect(bytes).not.toContain("QQ123456C");
    expect(bytes).toContain(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// 32. The vocabulary rule holds in the exported type, not only in the field
// ---------------------------------------------------------------------------

describe("audit — vocabulary", () => {
  it("exports no bare `containment` identifier", async () => {
    const surface = (await import("../index.js")) as Record<string, unknown>;
    const bare = Object.keys(surface).filter((k) => /^containment$/i.test(k));
    expect(bare).toEqual([]);
  });
});
