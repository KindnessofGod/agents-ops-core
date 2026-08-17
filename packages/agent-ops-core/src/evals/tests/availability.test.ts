import { describe, expect, it } from "vitest";
import {
  accept,
  DEFAULT_FLOORS,
  defineSubject,
  determine,
  exactVerdict,
  exitCodeFor,
  gate,
  inMemoryRunLedger,
  judgePanel,
  manualTimers,
  ProviderUnavailable,
  run,
  runKeyOf,
  scriptedModelBackend,
  systemTimers,
} from "../index.js";
import type { ModelBackend, RunSpec, Subject } from "../index.js";
import {
  echoBackend,
  harness,
  passthroughRedactor,
  priceTable,
  PROMPT_V1,
  smallLimits,
  TEST_JUDGE,
  TEST_MODEL,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/**
 * **A 429 storm is not a regression.**
 *
 * The module noted that provider rate-limiting surfaced as a quality regression
 * and failed the build. That is two very different causes arriving on one red
 * line, and the cheap one is far more frequent — so the frequent one teaches
 * people to ignore the line, and then the expensive one goes past unread.
 *
 * These tests are about keeping them apart: a separate status, a separate rate,
 * a separate gate reason and a separate exit code, all the way through.
 */

const subject: Subject = defineSubject({
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

const suite = () => {
  const base = threeInvoices();
  return { ...base, cases: base.cases.map((c) => ({ ...c, input: { ...c.input, ref: c.ref } })) };
};

const specFor = (models: ModelBackend): Omit<RunSpec<"golden">, "recorder"> => ({
  label: "pre-merge",
  cases: suite(),
  subject,
  scorers: [exactVerdict],
  models,
  seed: testSeed,
  limits: { ...smallLimits, concurrency: 1 },
  priceTable,
});

/** Refuses one named case; serves the others. */
const refusing = (ref: string): ModelBackend =>
  scriptedModelBackend({
    id: "throttled",
    answer: (request) => {
      if (request.prompt["ref"] === ref) {
        throw new ProviderUnavailable("test-model", "429 Too Many Requests", null);
      }
      return { text: "duplicate", tokensIn: 10, tokensOut: 2 };
    },
  });

describe("a provider that will not serve", () => {
  it("makes the case could-not-evaluate, not unscored", async () => {
    const { recorder } = harness();
    const report = await run({
      ...specFor(refusing("INV-0002")),
      recorder,
      limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 5 },
    });

    const statuses = report.cases.map((c) => c.status);
    expect(statuses).toContain("could-not-evaluate");
    // Its own rate. `unscored` keeps its meaning — unmeasurable for reasons
    // attributable to the system under test — and a provider outage is not that.
    expect(report.couldNotEvaluateBasisPoints).toBe(3_333);
    expect(report.unscoredBasisPoints).toBe(0);
    // And it does not move the attribution figure: a case with no decision to
    // attribute is out of that denominator entirely, rather than counted in a
    // direction somebody would have to argue about.
    expect(report.attributionCoverageBasisPoints).toBe(10_000);
    expect(report.unattributedCases).toEqual([]);
  });

  it("is still bounded — a storm stops the run rather than hammering the provider", async () => {
    const { recorder } = harness();
    const stormy = scriptedModelBackend({
      id: "storm",
      answer: () => {
        throw new ProviderUnavailable("test-model", "429 Too Many Requests", 250);
      },
    });
    const report = await run({
      ...specFor(stormy),
      recorder,
      limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 0 },
    });
    // One case attempted, then the failure budget ended the run. The other two
    // were never dispatched.
    expect(report.casesRun).toBe(1);
    expect(report.partial).toBe(true);
    expect(report.cases[0]?.status).toBe("could-not-evaluate");
  });

  it("honours the provider's own retry interval, capped, instead of ignoring it", async () => {
    const timers = manualTimers();
    const { store, recorder } = harness(passthroughRedactor, timers);
    let attempts = 0;
    const backend = scriptedModelBackend({
      id: "retry-after",
      answer: () => {
        attempts += 1;
        // The cap is 30 seconds; 250ms is well under it and is used as-is.
        throw new ProviderUnavailable("test-model", "429", 250);
      },
    });
    // Virtual time moves because this pump moves it, not because anything waits:
    // the backoff and both wall clocks read these timers, and nothing here
    // sleeps.
    const pump = setInterval(() => timers.advance(3_000), 1);
    let report;
    try {
      report = await run({
        ...specFor(backend),
        recorder,
        limits: {
          ...smallLimits,
          concurrency: 1,
          retries: 2,
          maxCaseFailures: 5,
          perCaseMillis: 600_000,
          runMillis: 7_200_000,
        },
      });
    } finally {
      clearInterval(pump);
    }
    // Three attempts per case: the first plus two bounded retries, nine in all.
    // The waits are the provider's number, not the seeded backoff — ignoring
    // `Retry-After` is how a bounded retry fails three times in ninety
    // milliseconds and then reports a regression.
    expect(attempts).toBe(9);
    expect(timers.slept().slice(0, 2)).toEqual([250, 250]);

    // And the storm is legible in the trace as a storm, rather than as a series
    // of unexplained model failures.
    const nodes = (await store.read(report.runId))?.nodes ?? [];
    const retries = nodes.filter((n) => n.kind === "retry");
    expect(retries.length).toBeGreaterThan(0);
    expect(retries[0]?.payload["providerUnavailable"]).toBe(true);
    expect(retries[0]?.payload["error.name"]).toBe("ProviderUnavailable");
    expect(retries[0]?.payload["waitMillis"]).toBe(250);
  });

  it("treats a rate-limited judge the same way as a rate-limited subject", async () => {
    const { recorder } = harness();
    const report = await run({
      ...specFor(
        scriptedModelBackend({
          id: "judge-throttled",
          answer: (request) => {
            if (request.model === TEST_JUDGE) {
              throw new ProviderUnavailable("test-judge", "429", null);
            }
            return { text: "duplicate", tokensIn: 10, tokensOut: 2 };
          },
        }),
      ),
      recorder,
      scorers: [
        judgePanel({
          model: TEST_JUDGE,
          promptVersion: PROMPT_V1,
          panelSize: 3,
          bandBasisPoints: 500,
          rubric: "is the conclusion right",
        }),
      ],
      limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 5 },
    });
    // The subject answered fine; the ruler was unavailable. That is not a
    // scoring regression, and it used to arrive as one.
    expect(report.couldNotEvaluateBasisPoints).toBe(10_000);
    expect(report.unscoredBasisPoints).toBe(0);
  });
});

describe("the gate keeps the two causes apart, all the way to the exit code", () => {
  it("blocks with could-not-evaluate, ahead of every quality signal, and exits 2", async () => {
    const { recorder } = harness();
    const good = await run({ ...specFor(echoBackend()), recorder });
    const baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });

    const throttled = await run({
      ...specFor(refusing("INV-0002")),
      recorder: harness().recorder,
      limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 5 },
    });
    const outcome = await gate({ report: throttled, baseline, floors: DEFAULT_FLOORS, recorder });

    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    // Not `unscored-rate`, which is where this used to land and which is an
    // evidence signal about the subject.
    expect(outcome.reason).toBe("could-not-evaluate");
    expect(outcome.remedy).toContain("not a regression");

    const decision = exitCodeFor({ kind: "gate", outcome });
    expect(decision.code).toBe(2);
    expect(decision.kind).toBe("could-not-evaluate");
  });

  it("still exits 1 for a genuine regression, so the two lines stay distinguishable", async () => {
    const { recorder } = harness();
    const good = await run({ ...specFor(echoBackend()), recorder });
    const baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });

    const worse = await run({
      ...specFor(echoBackend(() => ({ text: "not-duplicate", tokensIn: 1, tokensOut: 1 }))),
      recorder: harness().recorder,
    });
    const outcome = await gate({ report: worse, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("regression");
    expect(exitCodeFor({ kind: "gate", outcome }).code).toBe(1);
  });

  it("refuses a run that could not be evaluated as a baseline", async () => {
    const throttled = await run({
      ...specFor(refusing("INV-0002")),
      recorder: harness().recorder,
      limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 5 },
    });
    // A provider outage is not a standard. Baking one in means every later run
    // is compared against a run that partly did not happen.
    expect(() => accept({ report: throttled, by: "a.engineer", at: 1 })).toThrow();
  });

  /**
   * The failure that matters most, and the one this whole separation exists for.
   *
   * A storm rarely arrives alone. The interesting run is the one where the
   * provider refused some cases **and** the subject genuinely got worse on
   * others: if the gate reports the regression, the build goes red with `1`, the
   * engineer re-runs, it goes red again for a different reason, and the third
   * time somebody turns the gate off. The order in `decide` is what stops that,
   * and an order is only a guarantee if something asserts it with both signals
   * present at once.
   */
  it("reports the storm, not the regression, when a run contains both", async () => {
    const { recorder } = harness();
    const good = await run({ ...specFor(echoBackend()), recorder });
    const baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });

    const both = await run({
      ...specFor(
        scriptedModelBackend({
          id: "storm-and-regression",
          answer: (request) => {
            // INV-0002: the provider will not serve.
            if (request.prompt["ref"] === "INV-0002") {
              throw new ProviderUnavailable("test-model", "429 Too Many Requests", null);
            }
            // INV-0001 and INV-0003: served, and the answer is now wrong. Both
            // were correct in the baseline, so this run really does contain a
            // two-case regression.
            return { text: "not-duplicate", tokensIn: 10, tokensOut: 2 };
          },
        }),
      ),
      recorder: harness().recorder,
      limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 5 },
    });

    // Both signals are on the artefact — nothing is hidden, and the regression
    // is still there to read once the provider is serving again.
    expect(both.couldNotEvaluateBasisPoints).toBeGreaterThan(0);
    expect(both.correctBasisPoints).toBeLessThan(10_000);

    const outcome = await gate({ report: both, baseline, floors: DEFAULT_FLOORS, recorder });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    // The storm wins. Nothing downstream of a provider that would not serve is a
    // statement about the subject, so reporting the regression first would be
    // reporting the weather as a defect.
    expect(outcome.reason).toBe("could-not-evaluate");
    expect(outcome.counts.regressed.length).toBeGreaterThan(0);

    const decision = exitCodeFor({ kind: "gate", outcome });
    expect(decision.code).toBe(2);
    expect(decision.kind).toBe("could-not-evaluate");
    // The word at the top of the continuous-integration log is the thing an
    // engineer reads at 07:40, and it must not say FAIL.
    expect(decision.line).toContain("INDETERMINATE");
    expect(decision.line).not.toContain("FAIL");
  });

  /**
   * The second half of "a storm is a fact about ten minutes on a Tuesday".
   *
   * `idempotency.test.ts` proves a **partial** run is not memoised. This is the
   * other shape, and it is the more dangerous one: a run that finished every
   * case it was going to finish, is not partial, and still could not evaluate
   * some of them. Memoised, that outage would become a permanent property of the
   * run key — free, instant and unfalsifiable, with no later run able to re-ask.
   */
  it("does not memoise a completed run that could not evaluate part of itself", async () => {
    const ledger = inMemoryRunLedger();
    const spec = {
      ...specFor(refusing("INV-0002")),
      limits: { ...smallLimits, concurrency: 1, maxCaseFailures: 5 },
    };
    const storm = await run({
      ...spec,
      recorder: harness(passthroughRedactor, systemTimers(), ledger).recorder,
    });
    expect(storm.partial).toBe(false);
    expect(storm.couldNotEvaluateBasisPoints).toBeGreaterThan(0);

    // Not in the ledger, so the next run re-asks the question rather than being
    // handed the outage back.
    expect(await ledger.findCompleted(runKeyOf(spec))).toBeUndefined();

    let served = 0;
    const recovered = await run({
      ...spec,
      models: echoBackend(() => {
        served += 1;
        return { text: "duplicate", tokensIn: 10, tokensOut: 2 };
      }),
      recorder: harness(passthroughRedactor, systemTimers(), ledger).recorder,
    });
    // The refused case was re-executed; the two that succeeded were carried.
    expect(served).toBe(1);
    expect(recovered.correctBasisPoints).toBe(10_000);
    expect(recovered.couldNotEvaluateBasisPoints).toBe(0);
    // And the recovered run — a real one — is memoised.
    expect(await ledger.findCompleted(runKeyOf(spec))).toBeDefined();
  });
});
