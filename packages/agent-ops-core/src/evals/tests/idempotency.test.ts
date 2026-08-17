import { describe, expect, it } from "vitest";
import {
  createEvalRecorder,
  defineSubject,
  determine,
  exactVerdict,
  inMemoryEvalNodeStore,
  inMemoryRunLedger,
  LedgerCorrupt,
  LedgerNotMinted,
  mintCompletedRun,
  ProviderUnavailable,
  reopenMemoisedReport,
  run,
  runKeyOf,
  RunNotMemoisable,
  scriptedModelBackend,
  seed as makeSeed,
  systemTimers,
} from "../index.js";
import type { EvalNodeStore, EvalRecorder, ModelBackend, RunLedger, RunSpec } from "../index.js";
import {
  manualClock,
  passthroughRedactor,
  priceTable,
  PROMPT_V1,
  smallLimits,
  TEST_MODEL,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/**
 * Idempotency and resume — a named C2 requirement the module reported as not
 * built, and the largest gap in it.
 *
 * C2 states the rule for effects: *"an effect executes at most once per key; a
 * repeat returns the original outcome rather than re-executing or erroring."* An
 * eval run is the one thing here that costs real money, so the same rule
 * applies — and the trap, flagged by the design's own review, is that a
 * **partial** run must not be memoised as if it were complete.
 *
 * Every test crosses `../index.js`, like every caller, and reaches no network.
 */

/**
 * A provider that refuses the third case until it is told to stop.
 *
 * This is a 200-case run dying at case 180, written in three cases instead of
 * two hundred: some work finishes, then the world goes wrong.
 */
const flakyProvider = (): {
  readonly state: { calls: number; refuse: boolean };
  readonly backend: ModelBackend;
} => {
  const state = { calls: 0, refuse: true };
  const backend = scriptedModelBackend({
    id: "flaky",
    answer: (request) => {
      state.calls += 1;
      if (state.refuse && request.prompt["ref"] === "INV-0003") {
        throw new ProviderUnavailable("test-model", "429 Too Many Requests", null);
      }
      return { text: "duplicate", tokensIn: 10, tokensOut: 2 };
    },
  });
  return { state, backend };
};

const subject = defineSubject({
  version: testSubjectVersion,
  purity: "calls-models",
  decide: async (ctx) => {
    const answer = await ctx.client.complete({
      model: TEST_MODEL,
      promptVersion: PROMPT_V1,
      prompt: { ref: String(ctx.input["ref"] ?? "") },
    });
    return determine(answer.text, 9_000);
  },
});

/** The suite, with each case's reference in its input so the fake can see it. */
const suite = () => {
  const base = threeInvoices();
  return { ...base, cases: base.cases.map((c) => ({ ...c, input: { ...c.input, ref: c.ref } })) };
};

/**
 * One store per process, one ledger across processes. That is the shape of a
 * continuous-integration job that crashed and was re-triggered: the node graph
 * of the dead run is somewhere else, and the memo is what survives.
 */
const processWith = (
  ledger: RunLedger,
): { readonly store: EvalNodeStore; readonly recorder: EvalRecorder } => {
  const store = inMemoryEvalNodeStore();
  return {
    store,
    recorder: createEvalRecorder({
      store,
      clock: manualClock(),
      redact: passthroughRedactor,
      timers: systemTimers(),
      ledger,
    }),
  };
};

const specFor = (models: ModelBackend): Omit<RunSpec<"golden">, "recorder"> => ({
  label: "pre-merge",
  cases: suite(),
  subject,
  scorers: [exactVerdict],
  models,
  seed: testSeed,
  // `maxCaseFailures: 0`, so the first refusal ends the run — which is what a
  // rate-limit storm does at scale, only sooner.
  limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 0 },
  priceTable,
});

describe("a repeat of a completed run key", () => {
  it("returns the original report and executes nothing at all", async () => {
    const ledger = inMemoryRunLedger();
    const { state, backend } = flakyProvider();
    state.refuse = false;

    const first = await run({ ...specFor(backend), recorder: processWith(ledger).recorder });
    expect(first.partial).toBe(false);
    expect(first.correctBasisPoints).toBe(10_000);
    expect(first.memoisation.kind).toBe("fresh");
    expect(state.calls).toBe(3);

    // A different process — new store, new recorder — asking the same question.
    const second = await run({ ...specFor(backend), recorder: processWith(ledger).recorder });

    // Not "a fresh run that happens to agree". The original artefact: same run
    // identifier, same trace digest, same start time.
    expect(second.runId).toBe(first.runId);
    expect(second.traceDigest).toBe(first.traceDigest);
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.runKey).toBe(first.runKey);
    // And nothing executed. At 200 cases this is the difference between a
    // re-triggered build costing nothing and costing twice.
    expect(state.calls).toBe(3);
  });

  it("keys on the question, not the label — pre-merge and nightly are one question", async () => {
    const ledger = inMemoryRunLedger();
    const { state, backend } = flakyProvider();
    state.refuse = false;

    const preMerge = await run({
      ...specFor(backend),
      label: "pre-merge",
      recorder: processWith(ledger).recorder,
    });
    const nightly = await run({
      ...specFor(backend),
      label: "nightly",
      recorder: processWith(ledger).recorder,
    });

    expect(nightly.runId).toBe(preMerge.runId);
    expect(state.calls).toBe(3);
  });

  it("re-executes when anything the key is made of changes, and there is no force flag", async () => {
    const ledger = inMemoryRunLedger();
    const { state, backend } = flakyProvider();
    state.refuse = false;

    await run({ ...specFor(backend), recorder: processWith(ledger).recorder });
    // A different seed is a different question. So is a different suite, subject
    // version, scorer digest, price table or limit.
    const other = await run({
      ...specFor(backend),
      seed: makeSeed("seed-1"),
      recorder: processWith(ledger).recorder,
    });
    expect(state.calls).toBe(6);
    expect(other.memoisation.kind).toBe("fresh");
  });

  it("computes the same key regardless of the order the limits were written in", () => {
    const cases = suite();
    const shared = { cases, subject, scorers: [exactVerdict] as const, seed: testSeed, priceTable };
    const forward = runKeyOf({ ...shared, limits: { ...smallLimits } });
    // The same values, assembled in the opposite order. `JSON.stringify` is
    // key-order dependent, so this used to be two different keys — idempotency
    // would have depended on how somebody typed an object literal.
    const reversed = Object.fromEntries(
      Object.entries(smallLimits).reverse(),
    ) as typeof smallLimits;
    expect(runKeyOf({ ...shared, limits: reversed })).toBe(forward);
  });
});

describe("an interrupted run resumes rather than restarting", () => {
  it("does not pay again for the cases that already finished", async () => {
    const ledger = inMemoryRunLedger();
    const { state, backend } = flakyProvider();

    // Attempt one. Two cases finish; the provider refuses the third; the failure
    // budget ends the run.
    const crashed = await run({ ...specFor(backend), recorder: processWith(ledger).recorder });
    expect(crashed.partial).toBe(true);
    expect(crashed.couldNotEvaluateBasisPoints).toBeGreaterThan(0);
    expect(state.calls).toBe(3);

    // **The partial report was not memoised as complete.** That is the trap the
    // design review named: memoised, a biased sample would be returned by every
    // later run of this key, instantly, looking exactly like a finished run
    // because it is the same type.
    const key = runKeyOf(specFor(backend));
    expect(await ledger.findCompleted(key)).toBeUndefined();
    // The two cases that genuinely finished *were* memoised. The one the
    // provider refused was not: that is a fact about ten minutes on a Tuesday,
    // not about the case, and freezing it would make it permanent for this key.
    expect((await ledger.findCases(key)).map((m) => m.ref)).toEqual(["INV-0001", "INV-0002"]);

    // Attempt two, with the provider serving again.
    state.refuse = false;
    const { store, recorder } = processWith(ledger);
    const resumed = await run({ ...specFor(backend), recorder });

    expect(resumed.partial).toBe(false);
    expect(resumed.correctBasisPoints).toBe(10_000);
    // One model call, not three.
    expect(state.calls).toBe(4);
    expect(resumed.memoisation.kind).toBe("resumed");
    if (resumed.memoisation.kind !== "resumed") throw new Error("unreachable");
    expect(resumed.memoisation.cases).toEqual(["INV-0001", "INV-0002"]);

    // The trace says so. A carried-forward case is a real `case` node stamped
    // with the run and node it came from, so "this was not observed today" is
    // recorded rather than inferred from a suspiciously low cost figure.
    const nodes = (await store.read(resumed.runId))?.nodes ?? [];
    const resumeNodes = nodes.filter((n) => n.kind === "resume");
    expect(resumeNodes).toHaveLength(1);
    expect(resumeNodes[0]?.payload["memoisedCases"]).toBe(2);
    const carried = nodes.filter((n) => n.kind === "case" && n.payload["memoised"] === true);
    expect(carried).toHaveLength(2);
    expect(carried[0]?.payload["memoisedFromRun"]).toBe(crashed.runId);
    expect(String(carried[0]?.payload["memoisedFromNode"] ?? "")).toContain(crashed.runId);
    const fresh = nodes.filter((n) => n.kind === "case" && n.payload["memoised"] === false);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.name).toBe("INV-0003");
  });

  it("memoises the run once it completes, so a third attempt executes nothing", async () => {
    const ledger = inMemoryRunLedger();
    const { state, backend } = flakyProvider();
    await run({ ...specFor(backend), recorder: processWith(ledger).recorder });
    state.refuse = false;
    const completed = await run({ ...specFor(backend), recorder: processWith(ledger).recorder });
    const after = state.calls;

    const third = await run({ ...specFor(backend), recorder: processWith(ledger).recorder });
    expect(third.runId).toBe(completed.runId);
    expect(state.calls).toBe(after);
  });
});

describe("what the ledger refuses, and what it survives", () => {
  it("refuses to mint a completed record from a partial run", async () => {
    const ledger = inMemoryRunLedger();
    const { backend } = flakyProvider();
    const partial = await run({ ...specFor(backend), recorder: processWith(ledger).recorder });
    expect(partial.partial).toBe(true);
    // The refusal is at the **mint**, the only producer of the ledger's write
    // type — so a caller cannot construct the argument that would bypass it.
    // This is the type-level guarantee made observable.
    expect(() =>
      mintCompletedRun({ report: partial, runKey: partial.runKey, completedAt: 1 }),
    ).toThrow(RunNotMemoisable);
  });

  it("refuses a memoised report that claims to be complete and is not", async () => {
    const ledger = inMemoryRunLedger();
    const { state, backend } = flakyProvider();
    state.refuse = false;
    const good = await run({ ...specFor(backend), recorder: processWith(ledger).recorder });
    const stored = await ledger.findCompleted(good.runKey);
    if (stored === undefined) throw new Error("expected a memo");

    // A row edited with a psql prompt, or written by an older build. The write
    // path makes this unrepresentable; this is the read-side backstop, and it is
    // fail-closed where the rest of the ledger is fail-open — a ledger that
    // cannot answer costs money, one that answers wrongly publishes a number no
    // run produced.
    const tampered = JSON.parse(stored.reportJson) as Record<string, unknown>;
    tampered["partial"] = true;
    expect(() =>
      reopenMemoisedReport({ ...stored, reportJson: JSON.stringify(tampered) }),
    ).toThrow(LedgerCorrupt);

    // And a report whose headline numbers no longer follow from its own cases.
    const rewritten = JSON.parse(stored.reportJson) as Record<string, unknown>;
    rewritten["cases"] = [{ status: "incorrect" }];
    expect(() =>
      reopenMemoisedReport({ ...stored, reportJson: JSON.stringify(rewritten) }),
    ).toThrow(LedgerCorrupt);
  });

  it("fails OPEN when the ledger is unavailable, and stamps the degradation on the report", async () => {
    // Deliberately the opposite policy from `EvalStoreUnavailable`. An
    // unrecorded eval run is a false number; an unmemoised one is a bill.
    const ledger = inMemoryRunLedger();
    Object.assign(ledger, {
      findCompleted: async () => {
        throw new Error("connection reset");
      },
    });

    const { state, backend } = flakyProvider();
    state.refuse = false;
    const report = await run({ ...specFor(backend), recorder: processWith(ledger).recorder });

    // The run happened. Nothing was lost but money.
    expect(report.correctBasisPoints).toBe(10_000);
    expect(report.memoisation.kind).toBe("ledger-unavailable");
    if (report.memoisation.kind !== "ledger-unavailable") throw new Error("unreachable");
    expect(report.memoisation.detail).toContain("connection reset");
  });

  it("refuses a ledger this module did not mint", () => {
    // The sharpest brand in the module. A forged store makes a run report
    // success while writing nothing; a forged ledger makes `run` return a green
    // report having executed nothing at all, and unlike a deleted golden case it
    // leaves no diff.
    const forged = {
      findCompleted: async () => undefined,
      recordCompleted: async () => undefined,
      findCases: async () => [],
      recordCase: async () => undefined,
      expireBefore: async () => ({ runKeys: 0, cases: 0 }),
    } as unknown as RunLedger;
    expect(() =>
      createEvalRecorder({
        store: inMemoryEvalNodeStore(),
        clock: manualClock(),
        redact: passthroughRedactor,
        timers: systemTimers(),
        ledger: forged,
      }),
    ).toThrow(LedgerNotMinted);
  });
});

describe("the ledger is bounded, like everything else here", () => {
  it("expires memos in batches and refuses an unbounded call", async () => {
    const ledger = inMemoryRunLedger();
    const { state, backend } = flakyProvider();
    state.refuse = false;
    for (const s of ["a", "b", "c"]) {
      await run({
        ...specFor(backend),
        seed: makeSeed(s),
        recorder: processWith(ledger).recorder,
      });
    }
    const first = await ledger.expireBefore(Number.MAX_SAFE_INTEGER, 1);
    expect(first.runKeys).toBe(1);
    const rest = await ledger.expireBefore(Number.MAX_SAFE_INTEGER, 10);
    expect(rest.runKeys).toBe(2);
    expect(await ledger.expireBefore(Number.MAX_SAFE_INTEGER, 10)).toEqual({
      runKeys: 0,
      cases: 0,
    });
    // There is no unbounded verb on this interface, for the same reason there is
    // none on the node store's.
    await expect(ledger.expireBefore(1, 0)).rejects.toThrow();
  });
});
