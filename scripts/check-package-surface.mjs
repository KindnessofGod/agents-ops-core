#!/usr/bin/env node
/**
 * Assert the published surface of `packages/agent-ops-core` is what nineteen
 * applications are promised.
 *
 * ## What can break silently, and does
 *
 * Everything this checks is invisible to `tsc`, to the tests and to
 * `dependency-cruiser`, because all three read the SOURCE tree and none of them
 * reads the TARBALL. A subpath export can point at a file the build no longer
 * emits; a `files` entry can start shipping `src/` and seven years of internal
 * comments with it; a dependency can be added to the package that nineteen
 * applications then inherit. Each of those is a green build and a broken
 * install, discovered by a caller.
 *
 * So this script packs the package the way npm would (`npm pack --dry-run`)
 * and asserts against the FILE LIST npm produced — not against the working
 * directory. A file that exists on disk but is not in the tarball is exactly
 * the failure being hunted.
 *
 * ## What it asserts
 *
 *   1. `dist/` is in the tarball and is not empty.
 *   2. No `src/`, no `tests/`, no `*.test.*`, no `tsconfig*` — the private
 *      halves of every module stay private, in the published artefact as well
 *      as in `dependency-cruiser`.
 *   3. Every `exports` subpath — both its `types` and its runtime target —
 *      names a path that is IN THE TARBALL, and so do `main` and `types`.
 *   4. Every module directory in `src/` has a subpath export. A sixth module
 *      that nobody can import is a build that passed.
 *   5. Zero runtime dependencies: no `dependencies`, `peerDependencies`,
 *      `optionalDependencies` or `bundleDependencies`. `CLAUDE.md`: every added
 *      dependency is nineteen applications' problem.
 *
 * ## Error modes, each named, each fail-closed, and why
 *
 * All fail-closed. There is no degraded publish: the artefact is either the one
 * the callers were promised or it is not, and the cheap moment to find out is
 * before the tag.
 *
 * - `PackFailed` — `npm pack --dry-run` did not produce a file list.
 *   **Fail-closed.** No list means no evidence; a checker that cannot see the
 *   tarball must not vouch for it.
 * - `DistMissing` — nothing under `dist/` in the tarball. **Fail-closed.** Run
 *   the build first; an unbuilt package publishes an empty one.
 * - `PrivateFilesPublished` — `src/`, tests or config in the tarball.
 *   **Fail-closed.** Module shape is a promise about what callers may reach,
 *   and a published `lib/` source tree is that promise broken by other means.
 * - `ExportTargetMissing` — an `exports`, `main` or `types` target is not in the
 *   tarball. **Fail-closed.** This is the one that produces
 *   `ERR_MODULE_NOT_FOUND` in a caller's production process and nowhere else.
 * - `ModuleNotExported` — a module in `src/` has no subpath export.
 *   **Fail-closed.**
 * - `RuntimeDependencyAdded` — the package declares a runtime dependency.
 *   **Fail-closed.** `SqlExecutor` arrives as a parameter precisely so that no
 *   driver is inherited; a dependency here reverses a decision nineteen
 *   applications did not take part in.
 *
 * ## Bounds
 *
 * One child process (`npm pack --dry-run --json`), bounded by
 * `AGENT_OPS_PACK_TIMEOUT_MS` (default 120000). No network: `--dry-run` writes
 * nothing and contacts no registry.
 *
 * ## Usage
 *
 *   npm run build && npm run check:package
 */

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * The package to check. Defaults to the published one; an explicit directory
 * argument exists so the checker's own failure modes can be exercised against a
 * throwaway fixture, which is the only way to know a checker still fails.
 */
const PKG_DIR = resolve(process.argv[2] ?? join(REPO_ROOT, "packages", "agent-ops-core"));
const TIMEOUT_MS = Number(process.env["AGENT_OPS_PACK_TIMEOUT_MS"] ?? "120000");

const failures = [];
const note = (mode, detail) => failures.push({ mode, detail });
const ok = (line) => process.stdout.write(`  ok  ${line}\n`);

const pkg = JSON.parse(await readFile(join(PKG_DIR, "package.json"), "utf8"));

// ---------------------------------------------------------------------------
// Pack it the way npm would
// ---------------------------------------------------------------------------

let packed;
try {
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], {
    cwd: PKG_DIR,
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  packed = (parsed[0]?.files ?? []).map((f) => f.path);
} catch (error) {
  process.stderr.write(
    `\ncheck-package-surface: PackFailed\n  npm pack --dry-run failed in ${PKG_DIR}: ` +
      `${error instanceof Error ? error.message : String(error)}\n\n`,
  );
  process.exit(1);
}

const inTarball = new Set(packed);
process.stdout.write(
  `check-package-surface: ${pkg.name}@${pkg.version}, ${packed.length} file(s) in the tarball\n`,
);

// ---------------------------------------------------------------------------
// 1. dist is there
// ---------------------------------------------------------------------------

const distFiles = packed.filter((p) => p === "dist" || p.startsWith("dist/"));
if (distFiles.length === 0) {
  note("DistMissing", "no file under dist/ in the tarball. Run `npm run build` first.");
} else {
  ok(`dist/ present — ${distFiles.length} file(s)`);
}

// ---------------------------------------------------------------------------
// 2. the private halves stayed private
// ---------------------------------------------------------------------------

const privatePatterns = [
  [/^src\//, "source tree"],
  [/(^|\/)tests\//, "test folder"],
  [/\.test\.[cm]?[jt]s$/, "test file"],
  [/(^|\/)tsconfig[^/]*\.json$/, "TypeScript configuration"],
  [/(^|\/)fixtures?\//, "test fixtures"],
  [/(^|\/)typecheck\.[cm]?ts$/, "typecheck-only source"],
];
const leaked = packed.flatMap((p) => {
  const hit = privatePatterns.find(([re]) => re.test(p));
  return hit === undefined ? [] : [`${p} (${hit[1]})`];
});
if (leaked.length > 0) {
  note(
    "PrivateFilesPublished",
    `the tarball ships files that are private by module shape:\n    ${leaked
      .slice(0, 20)
      .join("\n    ")}${leaked.length > 20 ? `\n    …and ${leaked.length - 20} more` : ""}`,
  );
} else {
  ok("no src/, tests/, fixtures, typecheck sources or tsconfig in the tarball");
}

// Build state is its own mode because its fix is its own line. `tsc --build`
// writes `.tsbuildinfo` INTO `outDir`, so `"files": ["dist"]` ships the
// compiler's incremental state — a list of every source file in the package and
// its hash — to nineteen applications. Harmless to run, and still not the
// artefact we said we publish.
const buildState = packed.filter((p) => p.endsWith(".tsbuildinfo"));
if (buildState.length > 0) {
  note(
    "BuildStatePublished",
    `the tarball ships compiler build state: ${buildState.join(", ")}.\n    ` +
      'Fix in packages/agent-ops-core/package.json: "files": ["dist", "!dist/*.tsbuildinfo"] ' +
      "(or point tsBuildInfoFile outside outDir).",
  );
} else {
  ok("no compiler build state (.tsbuildinfo) in the tarball");
}

// ---------------------------------------------------------------------------
// 3. every export target is a file that is actually shipped
// ---------------------------------------------------------------------------

/** `./dist/audit/index.js` -> `dist/audit/index.js`, the form npm pack reports. */
const asTarballPath = (specifier) => specifier.replace(/^\.\//, "");

const targets = [];
if (typeof pkg.main === "string") targets.push(["main", pkg.main]);
if (typeof pkg.types === "string") targets.push(["types", pkg.types]);
for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
  if (typeof entry === "string") {
    targets.push([subpath, entry]);
    continue;
  }
  for (const [condition, target] of Object.entries(entry ?? {})) {
    if (typeof target === "string") targets.push([`${subpath} (${condition})`, target]);
  }
}

const missingTargets = targets.filter(([, target]) => !inTarball.has(asTarballPath(target)));
if (missingTargets.length > 0) {
  note(
    "ExportTargetMissing",
    `these entry points name a file that is NOT in the tarball, so importing them ` +
      `throws ERR_MODULE_NOT_FOUND in a caller's process:\n    ${missingTargets
        .map(([name, target]) => `${name} -> ${target}`)
        .join("\n    ")}`,
  );
} else {
  ok(`${targets.length} entry point target(s) resolve to files in the tarball`);
}

// ---------------------------------------------------------------------------
// 4. every module in src/ is reachable through a subpath
// ---------------------------------------------------------------------------

const moduleDirs = (await readdir(join(PKG_DIR, "src"), { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const exportedSubpaths = new Set(Object.keys(pkg.exports ?? {}));
const unexported = moduleDirs.filter((m) => !exportedSubpaths.has(`./${m}`));
if (unexported.length > 0) {
  note(
    "ModuleNotExported",
    `modules with no subpath export — no caller can import them: ${unexported.join(", ")}. ` +
      "Add `./<module>` to `exports` in packages/agent-ops-core/package.json.",
  );
} else {
  ok(`${moduleDirs.length} module(s) each have a subpath export: ${moduleDirs.join(", ")}`);
}

// ---------------------------------------------------------------------------
// 5. zero runtime dependencies
// ---------------------------------------------------------------------------

const dependencyFields = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
];
const declared = dependencyFields.flatMap((field) => {
  const value = pkg[field];
  const names = Array.isArray(value) ? value : Object.keys(value ?? {});
  return names.map((name) => `${field}.${name}`);
});
if (declared.length > 0) {
  note(
    "RuntimeDependencyAdded",
    `the published package declares runtime dependencies: ${declared.join(", ")}. ` +
      "Nineteen applications inherit every one of them. Argue for it in an ADR first " +
      "(CLAUDE.md, Stack).",
  );
} else {
  ok("zero runtime dependencies (no dependencies, peer, optional or bundled)");
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  for (const { mode, detail } of failures) {
    process.stderr.write(`\ncheck-package-surface: ${mode}\n  ${detail}\n`);
  }
  process.stderr.write(`\n${failures.length} assertion(s) failed. Nothing was published.\n\n`);
  process.exit(1);
}

process.stdout.write("check-package-surface: the published surface is intact\n");
