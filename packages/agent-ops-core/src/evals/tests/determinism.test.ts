import { describe, expect, it } from "vitest";
import {
  accept,
  DEFAULT_FLOORS,
  defineSubject,
  determine,
  exactVerdict,
  gate,
  judgePanel,
  run,
} from "../index.js";
import type { RunSpec, Subject } from "../index.js";
import {
  echoBackend,
  harness,
  priceTable,
  PROMPT_V1,
  smallLimits,
  TEST_JUDGE,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/**
 * Interface fact 5 said a run is deterministic given (suite, subject, scorer,
 * seed) **or the report declares that it is not** — and the declaration came
 * entirely from what the scorer adapters said about themselves. Nothing verified
 * the subject, which is the half that actually varies.
 *
 * So the report now carries a determinism **check** as well as the declaration:
 * a seeded sample of the run's own cases is re-executed under the identical seed
 * and the verdicts compared. These tests are about the difference between those
 * two words.
 */

/** Answers the same thing every time. The check should find nothing. */
const stable: Subject = defineSubject({
  version: testSubjectVersion,
  purity: "pure",
  decide: async () => determine("duplicate", 9_000),
});

/**
 * Answers "duplicate" for the first three calls and something else afterwards.
 *
 * A temperature setting, an unseeded shuffle, iteration over host-ordered keys,
 * a cache warm on the second call — they all look like this from outside, and
 * none of them is anything a scorer descriptor knows about.
 */
const drifting = (): Subject => {
  let calls = 0;
  return defineSubject({
    version: testSubjectVersion,
    purity: "pure",
    decide: async () => {
      calls += 1;
      return determine(calls <= 3 ? "duplicate" : "something-else", 9_000);
    },
  });
};

const specFor = (
  subject: Subject,
  determinismSampleCases: number,
): Omit<RunSpec<"golden">, "recorder"> => ({
  label: "pre-merge",
  cases: threeInvoices(),
  subject,
  scorers: [exactVerdict],
  models: echoBackend(),
  seed: testSeed,
  limits: { ...smallLimits, concurrency: 1, determinismSampleCases },
  priceTable,
});

describe("determinism is checked, not merely declared", () => {
  it("re-executes a seeded sample under the same seed and reports a CHECK", async () => {
    const { store, recorder } = harness();
    const report = await run({ ...specFor(stable, 2), recorder });

    expect(report.determinism.declared).toBe("deterministic");
    expect(report.determinism.check.kind).toBe("checked");
    if (report.determinism.check.kind !== "checked") throw new Error("unreachable");
    // Bounded by the limit, and it says what it compared so nobody reads more
    // into it than it says.
    expect(report.determinism.check.compared).toBe("subject-verdict");
    expect(report.determinism.check.sampled).toHaveLength(2);
    expect(report.determinism.check.stable).toBe(2);
    expect(report.determinism.check.unstable).toEqual([]);

    // The check is a recorded fact, not a field somebody set. Its node carries
    // the seed and the identifiers it chose, so the selection stays checkable
    // even if the sampling rule is ever changed.
    const nodes = (await store.read(report.runId))?.nodes ?? [];
    const check = nodes.filter((n) => n.kind === "determinism");
    expect(check).toHaveLength(1);
    expect(check[0]?.payload["compared"]).toBe("subject-verdict");
    expect(check[0]?.payload["sampleSize"]).toBe(2);
    expect(String(check[0]?.payload["sampled"] ?? "").split(",")).toHaveLength(2);
    expect(check[0]?.outcome).toBe("ok");

    // The re-executions are spans under it, and are **not** cases: `casesRun`
    // must not move because the run checked itself.
    expect(report.casesRun).toBe(3);
    const rechecks = nodes.filter((n) => n.kind === "span" && n.name.startsWith("recheck:"));
    expect(rechecks).toHaveLength(2);
    // Digests, never the verdict forms themselves — the canonical form embeds
    // the conclusion, and a payload key called `first` is not something a
    // deny-list redactor keyed on `conclusion` would ever strip.
    expect(rechecks[0]?.payload["stable"]).toBe(true);
    expect(String(rechecks[0]?.payload["firstDigest"] ?? "")).toContain("sha256");
    expect(rechecks[0]?.payload["firstDigest"]).toBe(rechecks[0]?.payload["secondDigest"]);
  });

  it("catches a subject that answers differently on re-execution", async () => {
    const { recorder } = harness();
    const report = await run({ ...specFor(drifting(), 2), recorder });

    // The scorers all declared themselves deterministic. The subject is the half
    // nothing used to check.
    expect(report.determinism.check.kind).toBe("checked");
    if (report.determinism.check.kind !== "checked") throw new Error("unreachable");
    expect(report.determinism.check.unstable).toHaveLength(2);
    expect(report.determinism.check.stable).toBe(0);
    // The declaration follows the measurement, rather than the other way round.
    expect(report.determinism.declared).toBe("non-deterministic");
    expect(report.determinism.reasons.join(" ")).toContain("re-execution under the same seed");
  });

  it("selects the same sample every time for the same seed", async () => {
    const first = await run({ ...specFor(stable, 1), recorder: harness().recorder });
    const second = await run({ ...specFor(stable, 1), recorder: harness().recorder });
    if (first.determinism.check.kind !== "checked") throw new Error("unreachable");
    if (second.determinism.check.kind !== "checked") throw new Error("unreachable");
    expect(second.determinism.check.sampled).toEqual(first.determinism.check.sampled);
  });
});

describe("when the check does not run, it says so rather than falling back to the claim", () => {
  it("reports not-checked, with a reason, when the sample size is zero", async () => {
    const { recorder } = harness();
    const report = await run({ ...specFor(stable, 0), recorder });
    expect(report.determinism.declared).toBe("deterministic");
    expect(report.determinism.check.kind).toBe("not-checked");
    if (report.determinism.check.kind !== "not-checked") throw new Error("unreachable");
    expect(report.determinism.check.why).toContain("determinismSampleCases is 0");
  });

  it("reports not-checked when the run stopped early", async () => {
    const { recorder } = harness();
    // Re-executing under a budget that is already spent measures the budget, so
    // the check declines rather than producing a number about the clock.
    const throwing = defineSubject({
      version: testSubjectVersion,
      purity: "pure",
      decide: async () => {
        throw new Error("the subject fell over");
      },
    });
    const report = await run({
      ...specFor(throwing, 2),
      recorder,
      limits: { ...smallLimits, concurrency: 1, determinismSampleCases: 2, maxCaseFailures: 0 },
    });
    expect(report.partial).toBe(true);
    expect(report.determinism.check.kind).toBe("not-checked");
    if (report.determinism.check.kind !== "not-checked") throw new Error("unreachable");
    expect(report.determinism.check.why).toContain("stopped early");
  });

  it("still declares a judge panel non-deterministic, and does not re-run it", async () => {
    // The check is scoped to the subject on purpose. A judge panel is
    // non-deterministic by construction and says so in its descriptor;
    // re-running it would measure the judge's variance at n times the cost, and
    // that disagreement is already surfaced as `contested`.
    const { recorder } = harness();
    const report = await run({
      ...specFor(stable, 2),
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
      models: echoBackend(() => ({ text: "10000", tokensIn: 5, tokensOut: 1 })),
    });
    expect(report.determinism.declared).toBe("non-deterministic");
    expect(report.determinism.reasons.some((r) => r.includes("judgePanel"))).toBe(true);
    // But the subject was still checked, and was stable.
    expect(report.determinism.check.kind).toBe("checked");
    if (report.determinism.check.kind !== "checked") throw new Error("unreachable");
    expect(report.determinism.check.unstable).toEqual([]);
  });
});

describe("the gate blocks on a subject that will not answer twice the same way", () => {
  it("blocks with its own reason, because every other number assumes it would not", async () => {
    const { recorder } = harness();
    const good = await run({ ...specFor(stable, 0), recorder });
    const baseline = accept({ report: good, by: "a.engineer", at: 1_700_000_000_000 });

    const shaky = await run({ ...specFor(drifting(), 2), recorder: harness().recorder });
    const outcome = await gate({ report: shaky, baseline, floors: DEFAULT_FLOORS, recorder });

    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    // Not `regression`. The subject's answers did not get worse; they stopped
    // being answers about anything, and a regression figure over them would be
    // measuring the weather.
    expect(outcome.reason).toBe("non-deterministic-subject");
    expect(outcome.detail).toContain("answered differently");
    expect(outcome.remedy).toContain("ctx.seed");
  });
});
