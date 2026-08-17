import { describe, expect, it } from "vitest";
import { CASE_A, harness, mustRecord } from "./fixtures.js";
import {
  ENVELOPE_VERSION,
  canonicalNodeForm,
  canonicalPayloadForm,
  UnserialisablePayload,
  type NodePayload,
} from "../index.js";

/**
 * Slice 2 — byte-stable serialisation.
 *
 * The hardest thing in the module and the least visible. Same logical node,
 * identical bytes, every host and every version.
 */

describe("audit — canonical payload form", () => {
  it("serialises structurally-equal payloads identically whatever order the keys went in", () => {
    const insertedOneWay: NodePayload = {
      kind: "model.call",
      v: 2,
      tokensIn: 900,
      costTenthCents: 41,
      model: "sonnet",
    };

    // Same fields, built in a different order — which is what actually happens
    // when two call sites in two applications construct the same node kind.
    const insertedAnother: NodePayload = {
      model: "sonnet",
      costTenthCents: 41,
      v: 2,
      tokensIn: 900,
      kind: "model.call",
    };

    expect(canonicalPayloadForm(insertedOneWay)).toBe(
      canonicalPayloadForm(insertedAnother),
    );
  });

  it("sorts keys and emits no whitespace, so the bytes are reproducible off-platform", () => {
    expect(canonicalPayloadForm({ kind: "k", v: 1, b: 2, a: 1 })).toBe(
      '{"a":1,"b":2,"kind":"k","v":1}',
    );
  });

  it("treats an explicitly-undefined field and an absent field as the same bytes", () => {
    const explicit: NodePayload = { kind: "k", v: 1, note: undefined };
    const absent: NodePayload = { kind: "k", v: 1 };

    expect(canonicalPayloadForm(explicit)).toBe(canonicalPayloadForm(absent));
  });

  it("keeps null distinct from absent, because they are different claims", () => {
    expect(canonicalPayloadForm({ kind: "k", v: 1, note: null })).not.toBe(
      canonicalPayloadForm({ kind: "k", v: 1 }),
    );
  });

  it("normalises negative zero, which some encoders render as -0", () => {
    expect(canonicalPayloadForm({ kind: "k", v: 1, delta: -0 })).toBe(
      canonicalPayloadForm({ kind: "k", v: 1, delta: 0 }),
    );
  });

  it("refuses a float, naming the units to use instead", () => {
    expect(() => canonicalPayloadForm({ kind: "k", v: 1, cost: 0.1 })).toThrow(
      UnserialisablePayload,
    );
    expect(() => canonicalPayloadForm({ kind: "k", v: 1, cost: 0.1 })).toThrow(
      /tenth-cents|micros|basis points/,
    );
  });

  it("refuses an integer beyond the safe range rather than rounding it quietly", () => {
    expect(() =>
      canonicalPayloadForm({ kind: "k", v: 1, big: 2 ** 53 }),
    ).toThrow(UnserialisablePayload);
  });

  it("refuses NaN and Infinity", () => {
    expect(() => canonicalPayloadForm({ kind: "k", v: 1, x: Number.NaN })).toThrow(
      UnserialisablePayload,
    );
    expect(() =>
      canonicalPayloadForm({ kind: "k", v: 1, x: Number.POSITIVE_INFINITY }),
    ).toThrow(UnserialisablePayload);
  });

  it("refuses nesting and arrays, because payloads are flat", () => {
    const nested = { kind: "k", v: 1, inner: { a: 1 } } as unknown as NodePayload;
    const arrayed = { kind: "k", v: 1, xs: [1, 2] } as unknown as NodePayload;

    expect(() => canonicalPayloadForm(nested)).toThrow(/flat/);
    expect(() => canonicalPayloadForm(arrayed)).toThrow(/dotted keys/);
  });
});

describe("audit — canonical node form", () => {
  it("puts the envelope version in the bytes, so a 2033 reader knows the rules", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    const node = mustRecord(
      await trace.record({ kind: "decision.decided", v: 3 }, { tier: "high" }),
    ).node;

    expect(node.canonical).toContain(`"envelope":"${ENVELOPE_VERSION}"`);
    expect(node.payloadSchemaVersion).toBe(3);
  });

  it("produces bytes the caller can recompute from the node alone", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    const node = mustRecord(
      await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" }),
    ).node;

    expect(canonicalNodeForm(node)).toBe(node.canonical);
  });

  it("rejects an unserialisable payload before the store is touched", async () => {
    const { audit, store } = harness();
    const trace = await audit.open(CASE_A);

    await expect(
      trace.record({ kind: "model.call", v: 1, cost: 4.2 }, { tier: "low" }),
    ).rejects.toThrow(UnserialisablePayload);

    // Nothing half-written: the store never saw it. This is fail-closed at
    // every tier, including low, because it is a defect and not an outage.
    expect((await store.read(CASE_A))?.nodes).toHaveLength(0);
  });
});
