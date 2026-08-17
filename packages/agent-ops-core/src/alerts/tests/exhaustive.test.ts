import { describe, expect, it } from "vitest";
import { compileFixture } from "./typecheck.js";

/**
 * The compiler is the test.
 *
 * Requirements (b) and (c) are claims about the **type system**: that the
 * severity ordering is enforced rather than described, and that adding a
 * condition without handling it does not build. Neither can be demonstrated by
 * running code — a runtime test of an exhaustive switch only ever exercises the
 * branches that exist.
 *
 * So `fixtures/exhaustive.ts` is compiled by this repository's own TypeScript
 * under this repository's own strict settings. Every guarantee is a line marked
 * `@ts-expect-error`, which means the file is expected to produce **zero**
 * diagnostics: if a guarantee weakens, the directive becomes unused and
 * `TS2578` fails this test. Drift in either direction is caught.
 */

describe("the guarantees this module states in types", () => {
  it("compiles the fixture with no diagnostics at all", () => {
    const diagnostics = compileFixture("exhaustive.ts");
    expect(
      diagnostics,
      diagnostics.map((d) => `line ${d.line}: TS${d.code} ${d.text}`).join("\n"),
    ).toEqual([]);
  }, 60_000);
});
