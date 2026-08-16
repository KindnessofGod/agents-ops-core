// @ts-check
// Deep-module enforcement for agent-ops-core.
//
// Each directory under MODULES_ROOT is a MODULE: a lot of behaviour behind a
// small interface. A module's PUBLIC SURFACE is its ENTRY POINTS — the files
// at the module root. Implementation lives in SUBFOLDERS and is private, by
// convention `lib/` for implementation and `tests/` for tests.
//
// This is the structural half of the deep-module discipline: it makes a
// shallow module (one whose callers must know its internals) fail CI rather
// than merely look wrong in review. Nineteen applications inherit whatever
// surface survives here.
//
// Adapted from the `setup-ts-deep-modules` skill, with one fix: the
// app-side rule below excludes importers *inside a module folder* rather than
// importers *anywhere under the modules root*, so `src/index.ts` — the
// published package entry point — is itself held to the boundary.

/** Where modules live. One immediate child dir per module (flat, no nesting). */
const MODULES_ROOT = "packages/agent-ops-core/src";

// --- derived patterns (no need to edit) -------------------------------------
const R = MODULES_ROOT;

/**
 * A module's private internals: anything nested inside a module subfolder.
 * A module's root files are its entry points and are NOT matched here.
 */
const MODULE_INTERNALS = `^${R}/[^/]+/[^/]+/`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "entrypoint-boundary-from-outside",
      comment:
        "Code outside a module — including the published package entry point src/index.ts — may import a module's entry points (its root files), but nothing inside its subfolders.",
      severity: "error",
      from: { pathNot: `^${R}/[^/]+/` },
      to: { path: MODULE_INTERNALS },
    },
    {
      name: "entrypoint-boundary-across-modules",
      comment:
        "A module's own files import each other freely, but may reach OTHER modules only through their entry points — never their internals.",
      severity: "error",
      from: { path: `^${R}/([^/]+)/`, pathNot: `^${R}/[^/]+/tests/` },
      to: {
        path: MODULE_INTERNALS,
        pathNot: `^${R}/$1/`,
      },
    },
    {
      name: "tests-through-entrypoints",
      comment:
        "A module's tests exercise it through its interface like every other caller: they may import any module's entry points and their own tests/ fixtures, but never any module's internals — not even their own. If a test needs to reach past the interface, the module is the wrong shape.",
      severity: "error",
      from: { path: `^${R}/([^/]+)/tests/` },
      to: {
        path: MODULE_INTERNALS,
        pathNot: `^${R}/$1/tests/`,
      },
    },
    {
      name: "tests-folder-is-private",
      comment:
        "A module's tests/ folder is reachable only from tests — no shipped code may import a fixture.",
      severity: "error",
      from: { pathNot: `^${R}/[^/]+/tests/` },
      to: { path: `^${R}/[^/]+/tests/` },
    },
    {
      name: "no-circular",
      comment: "No dependency cycles.",
      severity: "error",
      from: {},
      to: { circular: true },
    },

    // --- Layering ------------------------------------------------------------
    // Interface-hiding controls HOW you import (through the entry points).
    // Layering controls WHICH modules may depend on which. Filled in once
    // Phase 2 settles which modules survive.
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // No `tsConfig` here on purpose. These rules are path-based, so they need
    // no compiler options — and dependency-cruiser resolves a tsconfig's
    // `extends` relative to the process CWD rather than to the tsconfig file,
    // which breaks on our workspace layout. Add `tsConfig` back only if we
    // ever introduce path aliases, and give it a flat, non-extending file.
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".json"],
    },
  },
};
