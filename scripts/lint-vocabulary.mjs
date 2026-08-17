#!/usr/bin/env node
/**
 * Vocabulary lint.
 *
 * `docs/CONTEXT.md` rule 4: bare `containment` is not a valid identifier
 * anywhere in the codebase. The field, the column and the label are
 * `unassistedContainment`.
 *
 * Four documents asserted this was "a lint failure" while no lint existed —
 * caught by an adversarial review of the documentation against the code. The
 * honest options were to soften four documents or to write the lint. The claim
 * is worth keeping true: the qualifier is what stops the term being read as a
 * quality score, and a rule enforced only by reviewer memory lapses the first
 * time somebody is in a hurry.
 *
 * ## Why this scans identifier positions rather than raw text
 *
 * The rule is about **identifiers**, not prose. A test named
 * `it("never writes bare containment")` and an error message reading
 * "unassisted-containment figure" are both correct usage, and a first draft of
 * this lint reported all six of them. A lint that cries wolf gets switched off,
 * which would leave the four documents overstating again — so it strips
 * comments, string literals, template literals and regular-expression literals
 * before matching, and looks only at what is left.
 *
 * ## Limits, stated because a lint that overstates its own reach is the defect
 * it exists to catch
 *
 * - TypeScript sources under the published package only.
 * - The scanner is lexical, not a parse, so regular-expression detection uses
 *   the usual heuristic: a `/` in operand position opens a literal, a `/` in
 *   operator position is division. Zero dependencies is the right trade in a
 *   package nineteen applications inherit.
 * - It catches the identifier. It cannot catch a database column or a metric
 *   label written in a migration or a dashboard, which is why the rule is also
 *   stated in `docs/CONTEXT.md` for humans.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages/agent-ops-core/src");

/**
 * Blank out everything that is not code, preserving newlines and column
 * offsets so a finding's reported position is the real one.
 */
const codeOnly = (source) => {
  const out = [...source];
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  let i = 0;
  // Tracks whether a `/` would start a regular expression (operand position)
  // or divide (operator position).
  let lastSignificant = "";

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") { j += 2; continue; }
        if (source[j] === ch) break;
        j += 1;
      }
      blank(i, j + 1);
      i = j + 1;
      lastSignificant = "s";
      continue;
    }
    if (ch === "/" && /[([{=,:;!&|?+\-*%<>~^]|^$/.test(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        if (source[j] === "\\") { j += 2; continue; }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
        j += 1;
      }
      if (source[j] === "/") {
        blank(i, j + 1);
        i = j + 1;
        lastSignificant = "s";
        continue;
      }
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }

  return out.join("");
};

/** Bare `containment`, in any case, not carrying the mandatory qualifier. */
const BARE = /(?<!unassisted)\bcontainment\b/gi;

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory()
      ? walk(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });

const findings = [];

for (const path of walk(SRC)) {
  const source = readFileSync(path, "utf8");
  const code = codeOnly(source);
  const rawLines = source.split("\n");
  code.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(BARE)) {
      findings.push({
        file: relative(ROOT, path),
        line: index + 1,
        column: match.index + 1,
        text: (rawLines[index] ?? "").trim(),
      });
    }
  });
}

if (findings.length === 0) {
  console.log("✔ vocabulary: no bare `containment` identifier found");
  process.exit(0);
}

console.error(
  `\n✖ vocabulary: ${findings.length} bare \`containment\` identifier(s).\n` +
    "  The term is always `unassistedContainment` — see docs/CONTEXT.md rule 4.\n" +
    "  The qualifier is what stops it being read as a quality score.\n",
);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}:${f.column}  ${f.text}`);
}
process.exit(1);
