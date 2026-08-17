import { describe, expect, it } from "vitest";
import {
  accept,
  BaselineRefused,
  DEFAULT_FLOORS,
  defineSubject,
  determine,
  exactVerdict,
  gate,
  goldenSuite,
  preMergeSubset,
  run,
  runKeyOf,
  seed as makeSeed,
  SubsetUnselectable,
} from "../index.js";
import type { CaseRef, CaseSource, RunSpec, Subject } from "../index.js";
import {
  echoBackend,
  harness,
  priceTable,
  smallLimits,
  testSeed,
  testSubjectVersion,
} from "./fixtures.js";

/**
 * Pre-merge subset selection.
 *
 * The review's own words: *"the gate must support a subset pre-merge and the
 * full suite nightly, or it will be disabled for being slow."* A gate that gets
 * disabled protects nothing — but a cheap gate that skips the cases where being
 * wrong is expensive protects nothing either, and looks green while doing it.
 */

/** Twelve cases: three high tier, nine below it. */
const twelve = (): CaseSource<"golden"> =>
  goldenSuite({
    cases: Array.from({ length: 12 }, (_, i) => ({
      ref: `INV-${String(i).padStart(4, "0")}`,
      tier: i < 3 ? ("high" as const) : i < 7 ? ("medium" as const) : ("low" as const),
      input: { supplier: `s-${String(i)}` },
      expected: determine("duplicate", 9_000),
      adjudicatedBy: "a.reviewer",
      adjudicatedAt: 1_690_000_000_000,
    })),
  });

const subject: Subject = defineSubject({
  version: testSubjectVersion,
  purity: "pure",
  decide: async () => determine("duplicate", 9_000),
});

const specFor = (cases: CaseSource<"golden">): Omit<RunSpec<"golden">, "recorder"> => ({
  label: "pre-merge",
  cases,
  subject,
  scorers: [exactVerdict],
  models: echoBackend(),
  seed: testSeed,
  limits: smallLimits,
  priceTable,
});

const selectionOf = (source: CaseSource<"golden">) => {
  if (source.selection === null) throw new Error("expected a subset");
  return source.selection;
};

describe("what a subset pins, and what it will not drop to save time", () => {
  it("pins every high-tier case and every quarantined one, then samples the rest", () => {
    const suite = twelve();
    const subset = preMergeSubset({
      from: suite,
      label: "pre-merge",
      seed: makeSeed("subset-0"),
      maxCases: 6,
      quarantined: ["INV-0009" as CaseRef],
    });
    const selection = selectionOf(subset);

    expect(selection.pinnedHighTier).toEqual(["INV-0000", "INV-0001", "INV-0002"]);
    expect(selection.pinnedQuarantined).toEqual(["INV-0009"]);
    expect(subset.size).toBe(6);
    expect(selection.sampled).toHaveLength(2);
    expect(selection.overBudget).toBe(false);
    // Enumerated, not counted: `gate` has to tell "the subset skipped it" from
    // "somebody deleted it", and a count cannot answer that.
    expect(selection.notSelected).toHaveLength(6);
    expect([...selection.notSelected, ...subset.cases.map((c) => c.ref)].sort()).toHaveLength(12);
  });

  it("runs over budget rather than dropping a case that matters", () => {
    // Three high-tier cases and a budget of one. The trade nobody would defend
    // out loud is therefore not available silently: the subset takes all three
    // and records that it exceeded its budget.
    const subset = preMergeSubset({
      from: twelve(),
      label: "pre-merge",
      seed: makeSeed("subset-0"),
      maxCases: 1,
    });
    const selection = selectionOf(subset);
    expect(subset.size).toBe(3);
    expect(selection.overBudget).toBe(true);
    expect(selection.sampled).toEqual([]);
    expect(selection.pinnedHighTier).toHaveLength(3);
  });

  it("selects the same cases for the same seed, and different ones for a different seed", () => {
    const suite = twelve();
    const a = preMergeSubset({ from: suite, label: "p", seed: makeSeed("s1"), maxCases: 6 });
    const again = preMergeSubset({ from: suite, label: "p", seed: makeSeed("s1"), maxCases: 6 });
    const b = preMergeSubset({ from: suite, label: "p", seed: makeSeed("s2"), maxCases: 6 });

    expect(selectionOf(again).sampled).toEqual(selectionOf(a).sampled);
    expect(again.digest).toBe(a.digest);
    expect(selectionOf(b).sampled).not.toEqual(selectionOf(a).sampled);
  });

  it("is a case source with its own content address, not a flag on a run", () => {
    const suite = twelve();
    const subset = preMergeSubset({ from: suite, label: "p", seed: makeSeed("s1"), maxCases: 6 });
    expect(subset.digest).not.toBe(suite.digest);
    // Which is what makes the pre-merge run key differ from the nightly one
    // without anybody having to remember that it should.
    expect(runKeyOf(specFor(subset))).not.toBe(runKeyOf(specFor(suite)));
  });

  it("refuses the ways a subset can silently cover nothing", () => {
    const suite = twelve();
    expect(() =>
      preMergeSubset({ from: suite, label: "p", seed: makeSeed("s"), maxCases: 0 }),
    ).toThrow(SubsetUnselectable);
    expect(() =>
      preMergeSubset({ from: suite, label: "", seed: makeSeed("s"), maxCases: 4 }),
    ).toThrow(SubsetUnselectable);
    // A quarantine that names a case the suite does not contain protects
    // nothing, and would do it quietly.
    expect(() =>
      preMergeSubset({
        from: suite,
        label: "p",
        seed: makeSeed("s"),
        maxCases: 4,
        quarantined: ["INV-9999" as CaseRef],
      }),
    ).toThrow(SubsetUnselectable);
    // A subset of a subset would need two parents to say what it did not cover,
    // and `gate` reads exactly one.
    const subset = preMergeSubset({ from: suite, label: "p", seed: makeSeed("s"), maxCases: 6 });
    expect(() =>
      preMergeSubset({ from: subset, label: "q", seed: makeSeed("s"), maxCases: 3 }),
    ).toThrow(SubsetUnselectable);
  });
});

describe("a green pre-merge gate states what it actually covered", () => {
  it("does not read the unselected cases as deleted, and reports the coverage", async () => {
    const suite = twelve();
    const full = await run({ ...specFor(suite), recorder: harness().recorder });
    const baseline = accept({ report: full, by: "a.engineer", at: 1_700_000_000_000 });

    const subset = preMergeSubset({
      from: suite,
      label: "pre-merge",
      seed: makeSeed("subset-0"),
      maxCases: 6,
    });
    const cheap = await run({ ...specFor(subset), recorder: harness().recorder });
    const { recorder } = harness();
    const outcome = await gate({ report: cheap, baseline, floors: DEFAULT_FLOORS, recorder });

    // Six baseline cases are absent from this run. Before the selection record
    // existed, that was indistinguishable from deleting them — which is the
    // cheapest way to make a gate green, and precisely what `dropped-cases`
    // exists to catch.
    expect(outcome.kind).toBe("passed");
    expect(outcome.counts.dropped).toEqual([]);
    expect(outcome.coverage.kind).toBe("subset");
    expect(outcome.coverage.label).toBe("pre-merge");
    expect(outcome.coverage.casesRun).toBe(6);
    expect(outcome.coverage.suiteSize).toBe(12);
    expect(outcome.coverage.notCovered).toHaveLength(6);
  });

  it("still blocks when a case is genuinely deleted from a subset run", async () => {
    const suite = twelve();
    const full = await run({ ...specFor(suite), recorder: harness().recorder });
    const baseline = accept({ report: full, by: "a.engineer", at: 1_700_000_000_000 });

    // A subset selected from a suite that has had a case removed. The missing
    // case is not in `notSelected`, because the subset never saw it — so it is
    // reported as dropped, exactly as it would be in a full run.
    const shrunk = goldenSuite({
      cases: suite.cases
        .filter((c) => c.ref !== "INV-0000")
        .map((c) => ({
          ref: c.ref,
          tier: c.tier,
          input: c.input,
          expected: c.expectation.verdict,
          adjudicatedBy: "a.reviewer",
          adjudicatedAt: 1_690_000_000_000,
        })),
    });
    const subset = preMergeSubset({
      from: shrunk,
      label: "pre-merge",
      seed: makeSeed("subset-0"),
      maxCases: 6,
    });
    const cheap = await run({ ...specFor(subset), recorder: harness().recorder });
    const outcome = await gate({
      report: cheap,
      baseline,
      floors: DEFAULT_FLOORS,
      recorder: harness().recorder,
    });

    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("dropped-cases");
    expect(outcome.counts.dropped).toEqual(["INV-0000"]);
  });

  it("reports full coverage for a whole-suite run", async () => {
    const full = await run({ ...specFor(twelve()), recorder: harness().recorder });
    const baseline = accept({ report: full, by: "a.engineer", at: 1_700_000_000_000 });
    const outcome = await gate({
      report: full,
      baseline,
      floors: DEFAULT_FLOORS,
      recorder: harness().recorder,
    });
    expect(outcome.kind).toBe("passed");
    expect(outcome.coverage.kind).toBe("full");
    expect(outcome.coverage.notCovered).toEqual([]);
  });

  it("records the selection on the run's source node, by reference", async () => {
    const subset = preMergeSubset({
      from: twelve(),
      label: "pre-merge",
      seed: makeSeed("subset-0"),
      maxCases: 6,
      quarantined: ["INV-0009" as CaseRef],
    });
    const { store, recorder } = harness();
    const report = await run({ ...specFor(subset), recorder });
    const nodes = (await store.read(report.runId))?.nodes ?? [];
    const source = nodes.find((n) => n.kind === "source");
    expect(source?.payload["subsetLabel"]).toBe("pre-merge");
    expect(source?.payload["subsetOfSize"]).toBe(12);
    expect(source?.payload["subsetPinnedHighTier"]).toBe("INV-0000,INV-0001,INV-0002");
    expect(source?.payload["subsetPinnedQuarantined"]).toBe("INV-0009");
    expect(String(source?.payload["subsetNotSelected"] ?? "").split(",")).toHaveLength(6);
    expect(source?.payload["subsetOverBudget"]).toBe(false);
  });
});

describe("a subset never advances the baseline", () => {
  it("is refused by accept, so the cheap run cannot become the standard", async () => {
    const subset = preMergeSubset({
      from: twelve(),
      label: "pre-merge",
      seed: makeSeed("subset-0"),
      maxCases: 6,
    });
    const cheap = await run({ ...specFor(subset), recorder: harness().recorder });
    // Accepting it would silently shrink what every later run is measured
    // against, and the cases it never selected would stop being compared at all.
    expect(() => accept({ report: cheap, by: "a.engineer", at: 1 })).toThrow(BaselineRefused);
  });
});
