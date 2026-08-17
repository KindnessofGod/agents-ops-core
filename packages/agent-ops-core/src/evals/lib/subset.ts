import { digestOf, seededRank } from "./canonical.js";
import { SubsetUnselectable } from "./errors.js";
import type {
  CaseRef,
  CaseSource,
  EvalCase,
  Seed,
  SourceDigest,
  SubsetSelection,
} from "./types.js";

/**
 * Pre-merge subset selection: seeded, budget-sized, and with the cases that
 * matter most **pinned** so a cheap run can never skip them.
 *
 * The gate has to be two things at once and cannot be, so it is two runs: a
 * subset before merge and the whole suite nightly. The review said so plainly —
 * *"the gate must support a subset pre-merge and the full suite nightly, or it
 * will be disabled for being slow"* — and a gate that gets disabled protects
 * nothing at all.
 *
 * ## A subset is a case source, not a flag
 *
 * `preMergeSubset` returns a `CaseSource<"golden">` with **its own content
 * address**, computed from the cases it selected. Three consequences fall out
 * for free, and each of them would otherwise be a rule somebody has to remember:
 *
 *  - The pre-merge run key differs from the nightly run key automatically, so
 *    the ledger cannot hand a subset's report back as the full suite's.
 *  - The report type, the versioning refusal and the duplicate check all apply
 *    unchanged, because it is the same type going into `run`.
 *  - `accept` refuses it as a baseline (see `gate.ts`), so a cheap run can never
 *    become the standard everything else is measured against.
 *
 * ## What is pinned, and why nothing can un-pin it
 *
 * Every case whose decision is **high tier**, and every case the caller declares
 * **quarantined**, is selected before the budget is looked at. High tier is the
 * consequence of being wrong; a pre-merge run that skips those to save four
 * minutes has optimised away the only part worth measuring. Quarantined cases
 * are the ones recently flaky — precisely the ones a sampler would otherwise
 * keep missing.
 *
 * If the pinned cases alone exceed `maxCases`, **the subset runs over budget**
 * and records `overBudget: true`. It does not drop a high-tier case to hit a
 * time target, because that is the trade nobody would defend out loud and
 * therefore the one that must not be available silently.
 *
 * ## The sample is reproducible outside this file
 *
 * The remainder is ordered by `seededRank(seed, ref)` — a 32-bit FNV-1a stated
 * completely in `canonical.ts` — with ties broken by reference, and the first N
 * taken. It is short enough to reimplement with a calculator, which the module's
 * sha256 digest is not.
 *
 * It hardly matters that anybody would, which is the point: the selection is
 * also **recorded by reference** on `SubsetSelection.sampled` and on the run's
 * `source` node. If the sampling rule is ever changed, every historical
 * selection stays checkable, because the answer was written down rather than
 * left to be recomputed.
 */

export interface SubsetInput {
  /** The suite to select from. Its digest becomes `selection.fromDigest`. */
  readonly from: CaseSource<"golden">;
  /** Recorded, never interpreted. "pre-merge". */
  readonly label: string;
  /**
   * Required, and separate from the run seed. A subset is chosen before a run
   * exists, so it cannot borrow the run's seed without making the selection
   * depend on something decided later.
   */
  readonly seed: Seed;
  /**
   * The budget, in cases. 1..10_000. A ceiling on what a pre-merge run costs —
   * not a target, and not a floor: the pinned cases may exceed it.
   */
  readonly maxCases: number;
  /**
   * Cases to pin regardless of tier: the ones recently flaky, held out of the
   * sampler's reach until they are trusted again. Every reference must exist in
   * `from`, because a quarantine naming a case that is not there is a quarantine
   * that silently protects nothing.
   */
  readonly quarantined?: readonly CaseRef[];
}

export const preMergeSubset = (input: SubsetInput): CaseSource<"golden"> => {
  if (!Number.isSafeInteger(input.maxCases) || input.maxCases < 1 || input.maxCases > 10_000) {
    throw new SubsetUnselectable(
      `maxCases=${String(input.maxCases)} is outside 1..10000 (integer); a subset that can select nothing is a gate that covers nothing`,
    );
  }
  if (input.seed.length === 0) {
    throw new SubsetUnselectable("seed is empty; an unseeded selection is not reproducible");
  }
  if (input.label.length === 0) {
    throw new SubsetUnselectable("label is empty; a green gate has to be able to say what it ran");
  }
  if (input.from.selection !== null) {
    // A subset of a subset would have to carry two parents to say what it did
    // not cover, and `gate` reads exactly one. Select from the suite.
    throw new SubsetUnselectable(
      `${input.from.selection.label} is already a subset; select from the full suite instead so the coverage claim has one parent`,
    );
  }

  const all = input.from.cases;
  const known = new Set<string>(all.map((c) => c.ref));
  const quarantined = input.quarantined ?? [];
  for (const ref of quarantined) {
    if (!known.has(ref)) {
      throw new SubsetUnselectable(
        `quarantined case ${ref} is not in this suite; a quarantine that names nothing protects nothing`,
      );
    }
  }

  const quarantineSet = new Set<string>(quarantined);
  const pinnedHighTier: EvalCase<"golden">[] = [];
  const pinnedQuarantined: EvalCase<"golden">[] = [];
  const remainder: EvalCase<"golden">[] = [];
  for (const evalCase of all) {
    if (quarantineSet.has(evalCase.ref)) pinnedQuarantined.push(evalCase);
    else if (evalCase.tier === "high") pinnedHighTier.push(evalCase);
    else remainder.push(evalCase);
  }

  const pinned = [...pinnedHighTier, ...pinnedQuarantined];
  const room = input.maxCases - pinned.length;
  const overBudget = room < 0;
  const sampled =
    room <= 0
      ? []
      : [...remainder]
          .sort((a, b) => {
            const ha = seededRank(input.seed, a.ref);
            const hb = seededRank(input.seed, b.ref);
            if (ha !== hb) return ha - hb;
            return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
          })
          .slice(0, room);

  const selectedSet = new Set<string>([...pinned, ...sampled].map((c) => c.ref));
  // Reference order, so the subset's digest depends on the set of cases and not
  // on the order the sampler happened to produce them in — the same rule
  // `goldenSuite` applies, for the same reason.
  const cases = all.filter((c) => selectedSet.has(c.ref));
  const notSelected = all.filter((c) => !selectedSet.has(c.ref)).map((c) => c.ref);

  const selection: SubsetSelection = {
    label: input.label,
    fromDigest: input.from.digest,
    fromSize: input.from.size,
    seed: input.seed,
    maxCases: input.maxCases,
    pinnedHighTier: pinnedHighTier.map((c) => c.ref),
    pinnedQuarantined: pinnedQuarantined.map((c) => c.ref),
    sampled: sampled.map((c) => c.ref).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    notSelected,
    overBudget,
  };

  return {
    kind: "golden",
    // Its own content address, over the cases it selected. This is what makes a
    // pre-merge run key different from a nightly run key without anybody having
    // to remember that it should be.
    digest: digestOf(cases.map((c) => c.digest)) as SourceDigest,
    size: cases.length,
    cases,
    provenance: null,
    selection,
  };
};
