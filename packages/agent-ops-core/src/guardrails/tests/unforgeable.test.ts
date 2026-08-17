import { describe, expect, it } from "vitest";
import { compileFixture } from "./typecheck.js";

/**
 * The type-level guarantees, compiled rather than asserted in prose.
 *
 * The convention is `@ts-expect-error`, which inverts the assertion in a way
 * that cannot rot: a fixture line marked `@ts-expect-error` that **stops**
 * erroring produces `TS2578: Unused '@ts-expect-error' directive`. So a fixture
 * full of expected compile errors is expected to compile with **zero**
 * diagnostics, and either kind of drift — the error disappearing or a new error
 * appearing — fails the test.
 *
 * This matters more here than it looks. The claim that an unrecorded screening
 * is unrepresentable rests on `Screening` being unconstructible: a caller that
 * could write one as an object literal could hand a forged `after` to
 * `checkOutput` and skip the input screening entirely. That is a compiler fact
 * or it is nothing.
 *
 * Hermetic: it reads files from disk and touches no network.
 */

describe("guardrails — what the types make unrepresentable", () => {
  // A generous timeout, not a slow test. This case runs the TypeScript
  // compiler in-process over a fixture; under `vitest`'s default parallelism
  // several such cases compile at once and the 5s default is a coin flip on a
  // loaded machine. A flaky gate is worse than a slow one — it teaches people
  // to re-run rather than to read.
  it("compiles the fixture with no diagnostics, which is the assertion", () => {
    expect(compileFixture("unforgeable.ts")).toEqual([]);
  }, 30_000);
});
