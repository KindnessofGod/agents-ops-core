import { describe, expect, it } from "vitest";
import { CASE_A, CASE_B, harness, redactNothing, testClock } from "./fixtures.js";
import {
  CaseNotClosed,
  WitnessConflict,
  WitnessContractViolated,
  WitnessUnavailable,
  createAudit,
  inMemoryTraceStore,
  inMemoryWitness,
  postgresWitness,
  type CorrelationId,
  type SqlExecutor,
  type SqlRow,
  type TraceDigest,
  type Witness,
  type WitnessId,
  type WitnessRecord,
} from "../index.js";

/**
 * The external witness — the module's stated blind spot.
 *
 * The test that matters here is the third one. Every other check in this module
 * is computed from the rows, so a rewritten case that is *internally consistent*
 * passes all of them: replay succeeds, the seal verifies, no row is tampered, no
 * row is missing. That case is the one an adversary with a `psql` prompt and a
 * restore-from-backup produces, and until the digest was published somewhere
 * this module cannot write, nothing in the library could tell it from the truth.
 *
 * These tests are hermetic in the same structural way as the rest: `Witness` is
 * injected, both shipped adapters are in this package, and neither opens a
 * socket. A test could not reach a real witness with real credentials present.
 */

describe("audit — a closed case is witnessed", () => {
  it("publishes the whole-case digest at close and agrees on replay", async () => {
    const witness = inMemoryWitness();
    const { audit } = harness({ witness });

    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });
    await trace.close({ unassistedContainment: false });

    const verdict = await audit.verifyAgainstWitness(CASE_A);
    expect(verdict.agrees).toBe(true);

    // The published digest is the whole case including the seal — the same
    // number `replay(...).digest()` computes, derived at close from the seal
    // alone rather than by reading the case back.
    const replayed = await audit.replay(CASE_A);
    expect(String(verdict.digest)).toBe(String(replayed.digest()));
    expect(witness.size).toBe(1);
  });

  it("publishes no payload, no kinds and no field names — only a digest", async () => {
    const witness = inMemoryWitness();
    const { audit } = harness({ witness });

    const trace = await audit.open(CASE_A);
    await trace.record(
      { kind: "claim.assessed", v: 1, claimant: "Ada Lovelace" },
      { tier: "high" },
    );
    await trace.close({ unassistedContainment: false });

    const held = (await witness.lookUp(CASE_A)) as WitnessRecord;
    // A witness may be under someone else's custody. What travels to it is a
    // digest, a count and a time — and nothing that could be personal data.
    expect(Object.keys(held).sort()).toEqual([
      "at",
      "correlationId",
      "digest",
      "nodes",
      "witness",
    ]);
    expect(JSON.stringify(held)).not.toContain("Ada");
  });

  it("catches a whole-case rewrite that every row-level check accepts", async () => {
    // The headline. Case A is recorded honestly and witnessed.
    const witness = inMemoryWitness();
    const honest = harness({ witness });
    const trace = await honest.audit.open(CASE_A);
    await trace.record(
      { kind: "payment.authorised", v: 1, amountTenthCents: 47_200_000 },
      { tier: "high" },
    );
    await trace.close({ unassistedContainment: false });

    // Now an adversary rebuilds the same case from scratch, consistently: the
    // amount is different, every node is genuinely canonicalised, the seal is
    // genuinely recomputed over the nodes it seals. This is what a restore from
    // an edited backup looks like.
    const rewritten = harness({ store: inMemoryTraceStore() });
    const forged = await rewritten.audit.open(CASE_A);
    await forged.record(
      { kind: "payment.authorised", v: 1, amountTenthCents: 4_720 },
      { tier: "high" },
    );
    await forged.close({ unassistedContainment: false });

    // Every check computed from the rows passes. That is the point.
    const replayed = await rewritten.audit.replay(CASE_A);
    expect(replayed.closed).toBe(true);
    expect(replayed.nodes).toHaveLength(2);

    // The one check that is not computed from the rows does not.
    const reader = harness({ store: rewritten.store, witness });
    const verdict = await reader.audit.verifyAgainstWitness(CASE_A);
    expect(verdict.agrees).toBe(false);
    expect(verdict.agrees === false && verdict.reason).toBe("digest-mismatch");
  });
});

describe("audit — absence is a gap, not a proof", () => {
  it("reports a sealed but unpublished case as not-witnessed", async () => {
    const witness = inMemoryWitness();
    // Written without a witness, then read with one — which is exactly the
    // shape of a deployment that added the witness after the fact.
    const writer = harness({ store: inMemoryTraceStore() });
    const trace = await writer.audit.open(CASE_A);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });
    await trace.close({ unassistedContainment: true });

    const reader = harness({ store: writer.store, witness });
    const verdict = await reader.audit.verifyAgainstWitness(CASE_A);

    // "Nobody published this" and "this disagrees with what was published" are
    // different sentences to say to an auditor, so they are different values.
    expect(verdict.agrees === false && verdict.reason).toBe("not-witnessed");
  });

  it("reports an open case as not-closed rather than as a mismatch", async () => {
    const witness = inMemoryWitness();
    const { audit } = harness({ witness });
    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });

    const verdict = await audit.verifyAgainstWitness(CASE_A);
    expect(verdict.agrees === false && verdict.reason).toBe("not-closed");
  });

  it("refuses to witness a case that is not sealed", async () => {
    const witness = inMemoryWitness();
    const { audit } = harness({ witness });
    await audit.open(CASE_A);

    await expect(audit.witness(CASE_A)).rejects.toThrow(CaseNotClosed);
  });

  it("names a missing witness rather than quietly reporting agreement", async () => {
    const { audit } = harness();
    const trace = await audit.open(CASE_A);
    await trace.close({ unassistedContainment: true });

    // No witness wired. The verbs fail loudly: a guarantee that depends on a
    // line of wiring nobody checks is not a guarantee.
    const failure = await audit
      .verifyAgainstWitness(CASE_A)
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(WitnessUnavailable);
    expect((failure as WitnessUnavailable).reason).toBe("not-configured");
  });
});

describe("audit — a witness cannot be overwritten", () => {
  it("accepts an identical republication and returns the record already held", async () => {
    const witness = inMemoryWitness();
    const clock = testClock(1_700_000_000_000);
    const { audit } = harness({ witness, clock });

    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });
    await trace.close({ unassistedContainment: true });
    const first = (await witness.lookUp(CASE_A)) as WitnessRecord;

    clock.advance(86_400_000);
    const receipt = await audit.witness(CASE_A);

    // Idempotent, and honest about it: the receipt is the record the witness
    // already holds, with its original timestamp, not a comfortable new one.
    expect(receipt.record.at).toBe(first.at);
    expect(String(receipt.record.digest)).toBe(String(first.digest));
    expect(witness.size).toBe(1);
  });

  it("refuses a second, different digest for a case already witnessed", async () => {
    const witness = inMemoryWitness();
    const honest = harness({ witness });
    const trace = await honest.audit.open(CASE_A);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });
    await trace.close({ unassistedContainment: true });

    // The adversary rewrites the case and tries to bring the witness along.
    const rewritten = harness({ store: inMemoryTraceStore(), witness });
    const forged = await rewritten.audit.open(CASE_A);
    await forged.record({ kind: "a", v: 1, tampered: true }, { tier: "low" });

    await expect(forged.close({ unassistedContainment: true })).rejects.toThrow(
      WitnessConflict,
    );
    // And the original record is untouched: the table is append-only.
    const held = (await witness.lookUp(CASE_A)) as WitnessRecord;
    expect(String(held.digest)).toBe(String((await honest.audit.replay(CASE_A)).digest()));
  });
});

describe("audit — the publication window is handled, not hidden", () => {
  it("fails closed when the witness is down, and says the case is sealed", async () => {
    const inner = inMemoryWitness();
    const down: Witness = {
      ...inner,
      async publish() {
        throw new Error("connection reset by peer");
      },
    };
    const { audit, store } = harness({ witness: down });

    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "a", v: 1 }, { tier: "low" });
    const failure = await trace
      .close({ unassistedContainment: true })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(WitnessUnavailable);
    // The distinction a caller needs: close did not fail, publication did.
    expect((failure as WitnessUnavailable).sealed).toBe(true);
    expect((failure as WitnessUnavailable).reason).toBe("witness-failure");

    // The case really is sealed, so a second close is correctly refused — which
    // is why the recovery is `witness`, not a retry of `close`.
    await expect(trace.close({ unassistedContainment: true })).rejects.toThrow(/closed/i);

    // Recovery, once the witness is back, over the same store.
    const recovered = harness({ store, witness: inner });
    await recovered.audit.witness(CASE_A);
    expect((await recovered.audit.verifyAgainstWitness(CASE_A)).agrees).toBe(true);
  });

  it("refuses a witness that receipts something it was not asked to publish", async () => {
    const inner = inMemoryWitness();
    // Branded by spreading a real adapter — a legitimate way to build a
    // decorator, and therefore the way a lying one gets built too.
    const lying: Witness = {
      ...inner,
      async publish(record) {
        const receipt = await inner.publish(record);
        return {
          record: { ...receipt.record, digest: "aoc.audit.trace.v1:sha256:00" as TraceDigest },
        };
      },
    };
    const { audit } = harness({ witness: lying });
    const trace = await audit.open(CASE_A);

    await expect(trace.close({ unassistedContainment: true })).rejects.toThrow(
      WitnessContractViolated,
    );
  });

  it("bounds what the in-memory witness retains", async () => {
    const witness = inMemoryWitness({ maxRecords: 1 });
    const { audit } = harness({ witness });

    await (await audit.open(CASE_A)).close({ unassistedContainment: true });
    const second = await audit.open(CASE_B);

    // Refuses rather than evicting: an evicted witness record cannot be
    // distinguished from one that never existed.
    const failure = await second
      .close({ unassistedContainment: true })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(WitnessUnavailable);
    expect((failure as WitnessUnavailable).reason).toBe("capacity");
  });
});

// ---------------------------------------------------------------------------
// The second adapter, through the same interface
// ---------------------------------------------------------------------------

interface WitnessRecorder {
  readonly executor: SqlExecutor;
  readonly statements: string[];
}

/** A stand-in that understands the two statements the witness adapter issues. */
const witnessExecutor = (): WitnessRecorder => {
  const statements: string[] = [];
  const rows = new Map<string, SqlRow>();

  const query = async (
    text: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: readonly SqlRow[] }> => {
    statements.push(text);
    const correlationId = String(params[0]);
    if (text.includes("audit:witness-publish")) {
      // ON CONFLICT DO NOTHING.
      if (!rows.has(correlationId)) {
        rows.set(correlationId, {
          correlation_id: correlationId,
          digest: params[1],
          nodes_witnessed: params[2],
          // bigint arrives as text from most drivers; hand it back that way so
          // the adapter's own coercion is exercised.
          witnessed_at_ms: String(params[3]),
          witness_id: params[4],
        });
      }
      return { rows: [] };
    }
    if (text.includes("audit:witness-read")) {
      const row = rows.get(correlationId);
      return { rows: row === undefined ? [] : [row] };
    }
    throw new Error(`unexpected statement: ${text}`);
  };

  const executor: SqlExecutor = { query, transaction: async (fn) => fn(executor) };
  return { executor, statements };
};

describe("audit — the Postgres witness holds the same invariants", () => {
  const custodian = "finance-archive-eu-west" as WitnessId;

  it("publishes, reads back and agrees, issuing no UPDATE or DELETE", async () => {
    const { executor, statements } = witnessExecutor();
    const witness = postgresWitness({ sql: executor, id: custodian });
    const { audit } = harness({ witness });

    const trace = await audit.open(CASE_A);
    await trace.record({ kind: "decision.decided", v: 1 }, { tier: "high" });
    await trace.close({ unassistedContainment: false });

    expect((await audit.verifyAgainstWitness(CASE_A)).agrees).toBe(true);
    expect((await witness.lookUp(CASE_A))?.witness).toBe(custodian);
    expect(statements.filter((s) => /\b(update|delete|truncate)\b/i.test(s))).toEqual([]);
    for (const statement of statements) expect(statement).not.toContain(CASE_A);
  });

  it("raises a conflict rather than overwriting, exactly as the in-memory one does", async () => {
    const { executor } = witnessExecutor();
    const witness = postgresWitness({ sql: executor, id: custodian });

    const honest = harness({ witness });
    await (await honest.audit.open(CASE_A)).close({ unassistedContainment: true });

    const rewritten = harness({ store: inMemoryTraceStore(), witness });
    const forged = await rewritten.audit.open(CASE_A);
    await forged.record({ kind: "a", v: 1 }, { tier: "low" });
    await expect(forged.close({ unassistedContainment: true })).rejects.toThrow(
      WitnessConflict,
    );
  });

  it("names an unreachable witness rather than letting a raw driver error escape", async () => {
    const broken: SqlExecutor = {
      query: async () => {
        throw new Error("ECONNREFUSED");
      },
      transaction: async (fn) => fn(broken),
    };
    const witness = postgresWitness({ sql: broken, id: custodian });
    const audit = createAudit({
      store: inMemoryTraceStore(),
      clock: testClock(0),
      redact: redactNothing,
      onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "fail-closed" },
      witness,
    });

    const trace = await audit.open("case_pg_down" as CorrelationId);
    await expect(trace.close({ unassistedContainment: true })).rejects.toThrow(
      WitnessUnavailable,
    );
  });
});
