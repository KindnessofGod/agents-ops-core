import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The hermetic guarantee, as a test rather than as a paragraph.
 *
 * Four files in this package can open a socket, one per module with a Postgres
 * schema of its own: the `live-postgres.test.ts` under `approval`, `audit`,
 * `evals` and `guardrails`. Every one is gated, every one reaches a database and
 * nothing else, and none loads a driver at all unless an explicit connection
 * string is present — but every one of those sentences is a promise about a file
 * somebody can edit, and the last release learned what a promise about a test
 * file is worth: it carried a live-database block that read two environment
 * variables, imported a driver and opened a pool **at collection time**, under a
 * comment explaining why that was safe.
 *
 * So the promise is checked here, from the source on disk, in the ordinary
 * hermetic run:
 *
 *   1. **Only the named files may name a driver**, and the list below is
 *      written out one path at a time rather than as a pattern, so a third one
 *      is somebody's decision rather than somebody's regular expression. A file
 *      not on it fails this test — including a well-meaning fixture, which is
 *      how the last one arrived.
 *   2. **No shipped file may name one at all.** `lib/` and every module's
 *      `index.ts` are checked separately, because a driver reachable from
 *      shipped code is a driver nineteen applications inherit, not merely a test
 *      that opens a socket.
 *   3. **The published package declares no runtime dependencies.** `pg` is a
 *      devDependency of the workspace root. If it ever migrates into
 *      `packages/agent-ops-core/package.json`, the injected `SqlExecutor` has
 *      stopped being the driver-injection point and has become decoration.
 *
 * This test reads files. It opens no socket, and it is the only file here that
 * touches the filesystem at all — which is a real cost and a smaller one than
 * the guarantee it defends.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** `.../packages/agent-ops-core/src` */
const SRC = resolve(HERE, "..", "..");
const PACKAGE_JSON = resolve(SRC, "..", "package.json");

/**
 * The gated files, named one at a time so each exception is explicit rather than
 * a regex. Both prove a Postgres schema's own guarantees — `audit`'s
 * append-only trace, and `evals`' node store and run ledger — and both are held
 * to the identical gate below.
 */
const THE_GATED_FILES: readonly string[] = [
  "approval/tests/live-postgres.test.ts",
  "audit/tests/live-postgres.test.ts",
  "evals/tests/live-postgres.test.ts",
  "guardrails/tests/live-postgres.test.ts",
];

/**
 * Anything that names a database driver, however it is spelled. `import type`
 * is included deliberately: a type-only import is erased at runtime and is
 * therefore harmless, but a file holding one is a file one keystroke away from
 * a value import, and this test is cheaper than that keystroke.
 */
const DRIVER = /\b(?:from\s+["']|require\(["']|import\(["'])(pg|pg-pool|postgres|mysql2?|better-sqlite3|mongodb)(?:\/[^"']*)?["']/;

/**
 * Comments are stripped before the match.
 *
 * Three files in this package write `require("pg")` in prose, in the paragraph
 * explaining why they do not do it — which is exactly the sentence that should
 * be there, and it must not be what fails this test. Matching code rather than
 * commentary is the difference between a guard people keep and a guard people
 * work around by rewording a comment.
 */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const walk = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
};

describe("audit — the hermetic guarantee is structural, and stays that way", () => {
  it("lets only the named files name a database driver, and they are the gated ones", async () => {
    const naming: string[] = [];
    for (const file of await walk(SRC)) {
      if (DRIVER.test(codeOnly(await readFile(file, "utf8")))) {
        naming.push(relative(SRC, file).split("\\").join("/"));
      }
    }
    expect(naming.sort()).toEqual([...THE_GATED_FILES].sort());
  });

  it("keeps every driver out of shipped code, where nineteen applications would inherit it", async () => {
    const shipped = (await walk(SRC)).filter(
      (f) => !relative(SRC, f).split("\\").join("/").includes("/tests/"),
    );
    expect(shipped.length).toBeGreaterThan(20);
    for (const file of shipped) {
      expect(
        DRIVER.test(codeOnly(await readFile(file, "utf8"))),
        `${relative(SRC, file)} names a database driver`,
      ).toBe(false);
    }
  });

  for (const gated of THE_GATED_FILES) {
    it(`gates ${gated} on an explicit connection string, with no default and no fallback`, async () => {
      const source = await readFile(join(SRC, gated), "utf8");

      // The driver is imported dynamically. A static value import would load it —
      // and open nothing, but load it — on every collection of every run.
      expect(source).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+["']pg["']/m);
      expect(source).toMatch(/await import\("pg"\)/);

      // One variable, read once, with no `??` behind it. A fallback to a
      // development connection string is how a gate stops being a gate.
      const reads = source.match(/process\.env\[[^\]]+\]/g) ?? [];
      expect(reads).toEqual(['process.env["AGENT_OPS_LIVE_DATABASE_URL"]']);
      expect(source).not.toMatch(/AGENT_OPS_LIVE_DATABASE_URL"\]\s*\?\?/);
      // Never the development compose file's variable: a developer with `.env`
      // sourced must not start opening sockets from `npm test`.
      expect(source).not.toContain("AGENT_OPS_DATABASE_URL\"");
    });
  }

  it("keeps the published package free of runtime dependencies", async () => {
    const manifest = JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as {
      readonly dependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
    };
    // Not "no `pg`" — none at all. Every dependency here is nineteen
    // applications' problem, and `CLAUDE.md` requires an ADR before one arrives.
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies ?? {}).toEqual({});
  });
});
