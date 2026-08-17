import { describe, expect, it } from "vitest";
import { compileFixture } from "./typecheck.js";

/**
 * Slice 1 — the capability constraint.
 *
 * The single highest-leverage requirement in the library, and the one place a
 * design in the review was falsified: `approval/minimal` documented a compile
 * error it had never run, and its brand did not build. So this is proved by
 * compiling, not by asserting.
 *
 * These tests cross the same seam as the nineteen callers: the fixtures import
 * only from `../../index.js`.
 */

describe("capability — a write-capable client cannot reach a decide function", () => {
  // A generous timeout, not a slow test. This case runs the TypeScript
  // compiler in-process over a fixture; under `vitest`'s default parallelism
  // several such cases compile at once and the 5s default is a coin flip on a
  // loaded machine. A flaky gate is worse than a slow one — it teaches people
  // to re-run rather than to read.
  it("rejects every fixture line that must not compile, and nothing else", () => {
    const diagnostics = compileFixture("capability-rejected.ts");

    // Each expected error is marked `@ts-expect-error` in the fixture, so a
    // clean compile means every one of them fired. A guarantee that quietly
    // weakened shows up here as TS2578 "Unused '@ts-expect-error' directive".
    expect(diagnostics).toEqual([]);
  }, 30_000);

  // A generous timeout, not a slow test. This case runs the TypeScript
  // compiler in-process over a fixture; under `vitest`'s default parallelism
  // several such cases compile at once and the 5s default is a coin flip on a
  // loaded machine. A flaky gate is worse than a slow one — it teaches people
  // to re-run rather than to read.
  it("still compiles a correctly declared decision point", () => {
    expect(compileFixture("capability-accepted.ts")).toEqual([]);
  }, 30_000);
});
