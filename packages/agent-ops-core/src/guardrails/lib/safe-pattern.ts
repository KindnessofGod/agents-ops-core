import { PatternUnsafe } from "./errors.js";
import type { CoverageCategory } from "./coverage.js";
import { isBasisPoints } from "./canonical.js";

/**
 * Making a runaway regular expression unrepresentable.
 *
 * ## The residual this closes, and the half of it that stays open
 *
 * `Detector.screen` is now asynchronous, which is a precondition for bounding a
 * detector and **not the bound itself**: an `async` function whose body is
 * central-processing-unit-bound until it returns blocks the event loop exactly
 * as a synchronous one does. Requiring a promise buys the engine a race it can
 * schedule; it buys nothing at all against a pattern that backtracks for a
 * minute. Saying otherwise would be the most comfortable sentence in this
 * module and the least true.
 *
 * So the work is bounded on two other axes, and both are structural:
 *
 *   1. **A `Pattern` cannot be constructed from a regular expression capable of
 *      exponential backtracking.** The brand is a non-exported `unique symbol`,
 *      `safePattern` is the only mint, and it refuses the shapes that blow up.
 *      `deterministicDetector` re-checks at construction, so a caller who
 *      defeats the brand with a cast is refused anyway.
 *   2. **The shipped scan checks a deadline between every pattern and every
 *      field**, so an accepted-but-slow pattern costs one scan rather than a
 *      whole screening. See `deterministicDetector`.
 *   3. **A scan can now be preempted outright**, in a bounded worker pool that
 *      terminates the thread when the budget is spent. Opt-in per detector; see
 *      `lib/preemption.ts`, and see below for the reversal that is.
 *
 * ## What remains possible, and the reversal that closes it
 *
 * A pattern this analyser accepts can still be far worse than linear in the
 * length of the field. `[\p{L}\p{N}.-]+\.[\p{L}]{2,}` — the tail of the shipped
 * email pattern — is ambiguous on `.`, so a long non-matching run costs roughly
 * one pass per starting position: on the order of `maxFieldChars²` character
 * comparisons for **one** pattern against **one** field.
 *
 * This file used to call that a bounded stall, quote `maxFieldChars²` as the
 * bound, and conclude that a worker thread was the wrong trade for closing it.
 * **That conclusion is reversed, and the premise was the part that was wrong.**
 * `a*a*a*b` carries no backreference, no alternation and no quantified group;
 * this analyser accepts it, correctly by the rules below; and it is
 * superpolynomial — two hundred characters cost hundreds of milliseconds and two
 * thousand cost hours. The analyser cannot prove a pattern linear, so it cannot
 * put a number on what it accepts, and a bound nobody can compute in advance is
 * not a bound. An event loop held for an unknown period on the hot path of every
 * decision is not something a regulated deployment should be asked to accept.
 *
 * So `lib/preemption.ts` ships `preemptiveDetector`: the same scan in a bounded
 * worker pool, with the timeout **terminating the thread** rather than rejecting
 * a promise beside one that spins on. What survives of the old argument is the
 * shape rather than the verdict — the caller's text really does live in a second
 * heap this module cannot freeze, deep-copy or prove it has released, which is
 * why preemption is **opt-in per detector** and why `deterministicDetector`
 * remains the default. `lib/preemption.ts` states that residue in full.
 *
 * What is still true here, unchanged:
 *
 *   - halving `maxFieldChars` quarters the in-process worst case for an
 *     ambiguous-but-polynomial pattern;
 *   - the deadline check stops the *next* scan, so a pack of twelve patterns
 *     over sixty-four fields cannot compound one slow scan into a slow screening;
 *   - nothing in-process can preempt a scan already under way, at any budget, by
 *     any design of timer. That is a property of the runtime, not of this module.
 *
 * ## The rules, and that they are conservative
 *
 * The analyser is syntactic and deliberately over-refuses. It cannot prove a
 * pattern linear — nothing short of a different matching engine can — so it
 * refuses the shapes that are *known* to blow up and accepts the rest. Refusals:
 *
 *   - **A backreference of any kind.** Backreferences make linear matching
 *     impossible in principle, and `(a+)\1` is the textbook exponential.
 *   - **An unbounded quantifier applied to a group that itself contains a
 *     quantifier or an alternation.** This is the `(a+)+`, `(a|aa)*`,
 *     `(\s*\w+)*` family — the classic catastrophic shape, and the one a
 *     hand-written personal-data pattern most easily drifts into.
 *   - **A bounded repetition above `MAX_REPETITION`, or a nested product above
 *     `MAX_REPETITION_PRODUCT`.** `(?:a{1000}){1000}` is not exponential; it is
 *     merely a million.
 *   - **A source longer than `MAX_SOURCE_CHARS`**, which bounds the analysis
 *     itself and the compile.
 *
 * There is **no escape hatch**, and that is a decision rather than an
 * oversight. A `dangerouslyUnsafePattern` would be reached for at 4pm on a
 * Friday by someone whose pattern would not compile, which is the same failure
 * mode `CONTEXT.md` gives for a reserved decision behind a configuration key.
 * A pattern this analyser refuses can be decomposed — hoist the alternation out
 * of the quantified group, or bound the repetition — and the decomposition is
 * what the author should have written anyway. What would change our mind: a
 * legitimate market pattern that provably cannot be decomposed. We have not
 * found one; the shipped packs for two markets all pass unchanged.
 */

/** A bounded repetition above this is refused outright. */
const MAX_REPETITION = 256;
/** The product of bounded repetitions along one nesting path. */
const MAX_REPETITION_PRODUCT = 4_096;
/** Bounds the analysis and the compile. Longer than any market format needs. */
const MAX_SOURCE_CHARS = 512;

declare const SAFE_PATTERN: unique symbol;

/**
 * One rule in a deterministic pack.
 *
 * Unconstructible outside this module: the brand is a non-exported `unique
 * symbol`, so no object literal — and no array of them — satisfies
 * `DeterministicDetectorSpec.patterns`. `safePattern` is the only mint.
 */
export interface Pattern {
  readonly [SAFE_PATTERN]: true;
  /** Stable identifier, recorded on every finding. Never the matched value. */
  readonly rule: string;
  /** Re-created per scan by the adapter, so `lastIndex` never carries over. */
  readonly match: RegExp;
  /** 0..10000. Integers only. */
  readonly confidenceBasisPoints: number;
  /**
   * Which coverage category this rule contributes to.
   *
   * Required, and it is what makes a pack's coverage declaration impossible to
   * drift from the pack: the covered list is **derived** from the patterns
   * rather than written beside them. A rule added without a category does not
   * compile, and a rule added with one appears in `Screening.coverage`
   * immediately. See `lib/coverage.ts`.
   */
  readonly covers: CoverageCategory;
}

export interface PatternSpec {
  readonly rule: string;
  readonly match: RegExp;
  readonly confidenceBasisPoints: number;
  readonly covers: CoverageCategory;
}

/**
 * The only way to obtain a `Pattern`.
 *
 * Throws `PatternUnsafe` at construction — never at screening time. A pattern
 * that stalls the event loop on the hot path of every decision is a boot
 * failure here, which is the loudest cheap place to put it.
 */
export const safePattern = (spec: PatternSpec): Pattern => {
  if (typeof spec.rule !== "string" || spec.rule.length === 0) {
    throw new PatternUnsafe("(unnamed)", "a pattern carries no rule identifier");
  }
  if (!(spec.match instanceof RegExp)) {
    throw new PatternUnsafe(spec.rule, "match is not a regular expression");
  }
  if (!isBasisPoints(spec.confidenceBasisPoints)) {
    throw new PatternUnsafe(
      spec.rule,
      `confidence ${String(spec.confidenceBasisPoints)} is not basis points`,
    );
  }
  const unsafe = unsafeReason(spec.match.source);
  if (unsafe !== undefined) throw new PatternUnsafe(spec.rule, unsafe);
  return Object.freeze({
    rule: spec.rule,
    match: spec.match,
    confidenceBasisPoints: spec.confidenceBasisPoints,
    covers: spec.covers,
  }) as unknown as Pattern;
};

/**
 * Re-check a pattern that arrived through the type rather than through the mint.
 *
 * `deterministicDetector` calls this on every pattern it is handed. The brand
 * stops an object literal; this stops a cast, which is the only remaining way
 * an unanalysed regular expression reaches the scan.
 */
export const assertPatternSafe = (pattern: Pattern): void => {
  if (!(pattern.match instanceof RegExp)) {
    throw new PatternUnsafe(String(pattern.rule), "match is not a regular expression");
  }
  const unsafe = unsafeReason(pattern.match.source);
  if (unsafe !== undefined) throw new PatternUnsafe(pattern.rule, unsafe);
};

/**
 * The analyser. Returns why a source is refused, or `undefined` for accepted.
 *
 * Private to this file, and not reachable from the module's `index.ts`, so the
 * only observable behaviour is acceptance or `PatternUnsafe`. The tests cross
 * the same seam a caller does — they mint patterns and assert the refusals —
 * because a test that reached past the interface to score the analyser directly
 * would be testing an implementation this module is free to replace.
 */
const unsafeReason = (source: string): string | undefined => {
  if (source.length > MAX_SOURCE_CHARS) {
    return `source is ${source.length} characters; the bound is ${MAX_SOURCE_CHARS}`;
  }

  interface Frame {
    /** A quantifier of any kind appeared inside this group. */
    quantified: boolean;
    /** An alternation appeared at this group's own depth. */
    alternation: boolean;
    /** The largest bounded repetition product along a path inside this group. */
    product: number;
  }

  const stack: Frame[] = [{ quantified: false, alternation: false, product: 1 }];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  /** Whether the previous token was something a quantifier could apply to. */
  let repeatable = false;
  let i = 0;

  while (i < source.length) {
    const c = source[i] as string;

    if (c === "\\") {
      const next = source[i + 1];
      if (next === undefined) return "ends in a dangling escape";
      if (next >= "1" && next <= "9") {
        return "uses a backreference, which cannot be matched in linear time";
      }
      if (next === "k" && source[i + 2] === "<") {
        return "uses a named backreference, which cannot be matched in linear time";
      }
      i += 2;
      repeatable = true;
      continue;
    }

    if (c === "[") {
      const end = classEnd(source, i);
      if (end === undefined) return "has an unterminated character class";
      i = end;
      repeatable = true;
      continue;
    }

    if (c === "(") {
      stack.push({ quantified: false, alternation: false, product: 1 });
      i = groupBodyStart(source, i);
      repeatable = false;
      continue;
    }

    if (c === ")") {
      const frame = stack.pop();
      if (frame === undefined || stack.length === 0) return "has an unbalanced )";
      const quantifier = readQuantifier(source, i + 1);
      const parent = top();
      if (quantifier === undefined) {
        parent.quantified = parent.quantified || frame.quantified;
        parent.alternation = parent.alternation || frame.alternation;
        parent.product = Math.max(parent.product, frame.product);
        i += 1;
        repeatable = true;
        continue;
      }
      if (quantifier.max === Infinity) {
        // The catastrophic family, and the whole reason this file exists.
        if (frame.quantified || frame.alternation) {
          return "applies an unbounded quantifier to a group containing a quantifier or an alternation, which is the catastrophic-backtracking shape";
        }
        parent.quantified = true;
        parent.product = Math.max(parent.product, frame.product);
      } else {
        if (quantifier.max > MAX_REPETITION) {
          return `repeats up to ${quantifier.max} times; the bound is ${MAX_REPETITION}`;
        }
        const product = frame.product * quantifier.max;
        if (product > MAX_REPETITION_PRODUCT) {
          return `nests bounded repetitions to a product of ${product}; the bound is ${MAX_REPETITION_PRODUCT}`;
        }
        parent.quantified = true;
        parent.product = Math.max(parent.product, product);
      }
      i = quantifier.end;
      repeatable = true;
      continue;
    }

    if (c === "|") {
      top().alternation = true;
      i += 1;
      repeatable = false;
      continue;
    }

    const quantifier = readQuantifier(source, i);
    if (quantifier !== undefined) {
      if (!repeatable) return "applies a quantifier to nothing";
      const frame = top();
      frame.quantified = true;
      if (quantifier.max !== Infinity) {
        if (quantifier.max > MAX_REPETITION) {
          return `repeats up to ${quantifier.max} times; the bound is ${MAX_REPETITION}`;
        }
        frame.product = Math.max(frame.product, quantifier.max);
      }
      i = quantifier.end;
      // `a++` is a syntax error and `a+*` is too; one quantifier per atom.
      repeatable = false;
      continue;
    }

    i += 1;
    repeatable = c !== "^" && c !== "$";
  }

  if (stack.length !== 1) return "has an unbalanced (";
  return undefined;
};

/** The index just past a character class, or `undefined` if it never closes. */
const classEnd = (source: string, open: number): number | undefined => {
  let i = open + 1;
  if (source[i] === "^") i += 1;
  if (source[i] === "]") i += 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "]") return i + 1;
    i += 1;
  }
  return undefined;
};

/** The index just past a group's opening punctuation, `(?:`, `(?<=`, `(?<n>`. */
const groupBodyStart = (source: string, open: number): number => {
  if (source[open + 1] !== "?") return open + 1;
  const third = source[open + 2];
  if (third === ":" || third === "=" || third === "!") return open + 3;
  if (third === "<") {
    const fourth = source[open + 3];
    if (fourth === "=" || fourth === "!") return open + 4;
    const close = source.indexOf(">", open + 3);
    return close === -1 ? open + 3 : close + 1;
  }
  return open + 2;
};

interface Quantifier {
  readonly max: number;
  /** The index just past the quantifier, including any lazy `?`. */
  readonly end: number;
}

/** Read a quantifier at `i`, or `undefined` when there is not one there. */
const readQuantifier = (source: string, i: number): Quantifier | undefined => {
  const lazy = (end: number): number => (source[end] === "?" ? end + 1 : end);
  const c = source[i];
  if (c === "*" || c === "+") return { max: Infinity, end: lazy(i + 1) };
  if (c === "?") return { max: 1, end: lazy(i + 1) };
  if (c !== "{") return undefined;
  // `{` is a literal brace unless it parses as `{n}`, `{n,}` or `{n,m}`.
  const braced = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
  if (braced === null) return undefined;
  const low = Number(braced[1]);
  const end = lazy(i + braced[0].length);
  if (braced[2] === undefined) return { max: low, end };
  if (braced[3] === undefined || braced[3] === "") return { max: Infinity, end };
  return { max: Number(braced[3]), end };
};
