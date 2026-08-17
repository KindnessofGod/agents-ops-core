import { describe, expect, it } from "vitest";
import { CASE_A, harness, mustRecord } from "./fixtures.js";
import {
  REDACTED,
  REDACTED_KEY_PREFIX,
  RedactionUnsound,
  inMemoryTraceStore,
  redactAllExcept,
  redactFields,
  type NodePayload,
  type RedactionId,
  type Redactor,
} from "../index.js";

/**
 * Slice 6 — redaction applied before write.
 *
 * There is no un-writing personal data, so the assertion that matters is not
 * "the reader hides it" but "the store never held it". Every test here reaches
 * past `replay` to the store itself for exactly that reason.
 */

const CLAIMANT: NodePayload = {
  kind: "claim.assessed",
  v: 1,
  claimantName: "Aisha Okonkwo",
  nationalInsuranceNumber: "QQ123456C",
  amountTenthCents: 4_720_000,
  tier: "high",
};

describe("audit — deny-by-default redaction", () => {
  it("never lets an unlisted field reach the store", async () => {
    const store = inMemoryTraceStore();
    const { audit } = harness({
      store,
      redact: redactAllExcept(["amountTenthCents"]),
    });
    const trace = await audit.open(CASE_A);
    await trace.record(CLAIMANT, { tier: "high" });

    const stored = (await store.read(CASE_A))?.nodes ?? [];
    const bytes = stored.map((n) => n.canonical).join("");

    expect(bytes).not.toContain("Aisha");
    expect(bytes).not.toContain("QQ123456C");
    expect(bytes).toContain("4720000");
  });

  it("redacts the fields nobody anticipated, which is the point of an allow list", async () => {
    const store = inMemoryTraceStore();
    const { audit } = harness({ store, redact: redactAllExcept([]) });
    const trace = await audit.open(CASE_A);

    const node = mustRecord(
      await trace.record(
        { kind: "document.extracted", v: 1, somethingNewNobodyReviewed: "07700 900123" },
        { tier: "high" },
      ),
    ).node;

    // Deny by default takes the key as well as the value: a field nobody
    // listed is a field nobody reviewed, and a flattened key carries a phone
    // number as readily as a value does. The marker keeps "a field was here".
    expect(node.payload["somethingNewNobodyReviewed"]).toBeUndefined();
    expect(node.payload[`${REDACTED_KEY_PREFIX}0`]).toBe(REDACTED);
    expect(node.canonical).not.toContain("07700");
  });
});

describe("audit — deny-list redaction", () => {
  it("strips the named fields and keeps the rest", async () => {
    const store = inMemoryTraceStore();
    const { audit } = harness({
      store,
      redact: redactFields(["claimantName", "nationalInsuranceNumber"]),
    });
    const trace = await audit.open(CASE_A);
    const node = mustRecord(await trace.record(CLAIMANT, { tier: "high" })).node;

    expect(node.payload["claimantName"]).toBe(REDACTED);
    expect(node.payload["nationalInsuranceNumber"]).toBe(REDACTED);
    expect(node.payload["amountTenthCents"]).toBe(4_720_000);
  });
});

describe("audit — redaction is structural, not advisory", () => {
  it("keeps `kind` and `v` whatever the redactor is asked to strip", async () => {
    const store = inMemoryTraceStore();
    const { audit } = harness({ store, redact: redactFields(["kind", "v"]) });
    const trace = await audit.open(CASE_A);
    const node = mustRecord(
      await trace.record({ kind: "claim.assessed", v: 7 }, { tier: "high" }),
    ).node;

    // A node whose discriminant was stripped is uninterpretable in 2033, which
    // is worse than the node not existing.
    expect(node.payload.kind).toBe("claim.assessed");
    expect(node.payloadSchemaVersion).toBe(7);
  });

  it("refuses to write at all when a redactor removes the discriminant", async () => {
    const unsound: Redactor = {
      id: "test.unsound" as RedactionId,
      apply: () => ({ kind: "something-else", v: 1 }),
    };
    const store = inMemoryTraceStore();
    const { audit } = harness({ store, redact: unsound });
    const trace = await audit.open(CASE_A);

    // Fail-closed at every tier: an unsound redactor means stop writing, not
    // write something unreadable.
    await expect(
      trace.record({ kind: "claim.assessed", v: 1 }, { tier: "low" }),
    ).rejects.toThrow(RedactionUnsound);
    expect((await store.read(CASE_A))?.nodes).toHaveLength(0);
  });

  it("names the redactor on every node and on the case, so what was stripped is knowable later", async () => {
    const redact = redactAllExcept(["amountTenthCents"]);
    const { audit } = harness({ redact });
    const trace = await audit.open(CASE_A);
    const node = mustRecord(await trace.record(CLAIMANT, { tier: "high" })).node;
    const replayed = await audit.replay(CASE_A);

    expect(node.redaction).toBe(redact.id);
    expect(replayed.provenance.redaction).toBe(redact.id);
    expect(String(redact.id)).toContain("amountTenthCents");
  });

  it("does not disturb byte-stability: the same payload redacts to the same bytes", async () => {
    const one = harness({ redact: redactAllExcept(["amountTenthCents"]) });
    const two = harness({ redact: redactAllExcept(["amountTenthCents"]) });

    const a = mustRecord(
      await (await one.audit.open(CASE_A)).record(CLAIMANT, { tier: "high" }),
    ).node;
    const b = mustRecord(
      await (await two.audit.open(CASE_A)).record(CLAIMANT, { tier: "high" }),
    ).node;

    expect(a.canonical).toBe(b.canonical);
  });
});
