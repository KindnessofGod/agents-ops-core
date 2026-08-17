import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * A compiler harness, because a type-level guarantee asserted in prose is
 * exactly the failure the design exercise caught: a design document quoted a
 * compile error it had never seen, and an adversary who ran `tsc` found the code
 * did not build at all.
 *
 * So the fixtures in `tests/fixtures/` are compiled by this repository's own
 * TypeScript under this repository's own strict settings, and the diagnostics
 * are asserted.
 *
 * The convention is `@ts-expect-error`, which inverts the assertion in a way
 * that cannot rot: a fixture line marked `@ts-expect-error` that **stops**
 * erroring produces `TS2578: Unused '@ts-expect-error' directive`. A fixture
 * full of expected compile errors is therefore expected to compile with **zero**
 * diagnostics, and either kind of drift — the error disappearing or a new one
 * appearing — fails the test.
 *
 * Hermetic: it reads files from disk and touches no network.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Mirrors `tsconfig.base.json`. `strictFunctionTypes` rides in on `strict`. */
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  lib: ["lib.es2023.d.ts"],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  skipLibCheck: true,
  noEmit: true,
  types: ["node"],
};

export interface Diagnostic {
  readonly code: number;
  readonly line: number;
  readonly text: string;
}

/** Compile one fixture and return its own diagnostics, sorted by line. */
export const compileFixture = (fixture: string): readonly Diagnostic[] => {
  const file = resolve(here, "fixtures", fixture);
  const program = ts.createProgram([file], options);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === file.replace(/\\/g, "/"))
    .map((d) => ({
      code: d.code,
      line:
        d.file && d.start !== undefined
          ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
          : -1,
      text: ts.flattenDiagnosticMessageText(d.messageText, " "),
    }))
    .sort((a, b) => a.line - b.line);
};
