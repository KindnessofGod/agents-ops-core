import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { conditions, harness, testPageTransport, ROTA, SINK } from "./fixtures.js";
import { pagingAlertSink } from "../index.js";

/**
 * Production grade, asserted structurally.
 *
 * "Hermetic tests, structurally, via dependency injection — never a flag, never
 * an env var. A test must be UNABLE to reach a live model or a real pager even
 * with real credentials present."
 *
 * That claim cannot be proved by a test that calls a sink and observes nothing
 * happening; it is a claim about the **call graph**. So this file reads the
 * module's own source and asserts the absence of every way out: no HTTP client,
 * no socket, no environment read, no ambient clock, no ambient timer outside the
 * single adapter that exists to own one.
 *
 * Reading source text is not reaching past the interface — nothing here imports
 * `lib/`. It is the same trick `audit` uses when it says a guarantee's scope
 * must be stamped on the artefact rather than asserted in a wiki.
 */

const here = dirname(fileURLToPath(import.meta.url));
const moduleRoot = resolve(here, "..");

const sourceFiles = (): readonly { path: string; name: string; text: string }[] => {
  const files = [{ path: join(moduleRoot, "index.ts"), name: "index.ts" }];
  for (const entry of readdirSync(join(moduleRoot, "lib"))) {
    if (entry.endsWith(".ts")) files.push({ path: join(moduleRoot, "lib", entry), name: entry });
  }
  return files.map((f) => ({ ...f, text: readFileSync(f.path, "utf8") }));
};

/** Strip comments, so a rule is about code and not about a paragraph explaining it. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("there is no code path from this module to a network", () => {
  it("constructs no HTTP client and opens no socket", () => {
    for (const file of sourceFiles()) {
      const code = codeOnly(file.text);
      for (const forbidden of [
        "fetch(",
        "XMLHttpRequest",
        "node:http",
        "node:https",
        "node:net",
        "node:dgram",
        "node:tls",
        "child_process",
        "require(",
      ]) {
        expect(code, `${file.name} references ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("reads no URL, token or routing key from the environment", () => {
    // An environment read is how "the transport is injected" quietly becomes
    // "the transport is injected, except in production". There is nothing to
    // disable here and therefore no flag to be trusted.
    for (const file of sourceFiles()) {
      expect(codeOnly(file.text), `${file.name} reads the environment`).not.toContain("process.env");
    }
  });

  it("imports nothing from another module: this one is wired at the composition root", () => {
    for (const file of sourceFiles()) {
      const code = codeOnly(file.text);
      expect(code, `${file.name} imports across a module edge`).not.toMatch(
        /from\s+"\.\.\/\.\.\//,
      );
    }
  });
});

describe("time is a dependency, not an ambient fact", () => {
  it("calls Date.now() in exactly one place — the one adapter that exists to", () => {
    const offenders = sourceFiles()
      .filter((f) => codeOnly(f.text).includes("Date.now("))
      .map((f) => f.name);
    expect(offenders).toEqual(["primitives.ts"]);
  });

  it("touches the timer wheel in exactly one place", () => {
    const offenders = sourceFiles()
      .filter((f) => /\bsetTimeout\(|\bsetInterval\(|\bsetImmediate\(/.test(codeOnly(f.text)))
      .map((f) => f.name);
    // `systemAlertTimers`, and nothing else. A module with a timer of its own is
    // a module whose ageing cannot be tested without waiting.
    expect(offenders).toEqual(["primitives.ts"]);
  });

  it("runs no background loop: nothing here schedules itself", () => {
    for (const file of sourceFiles()) {
      const code = codeOnly(file.text);
      expect(code, `${file.name} schedules repeating work`).not.toContain("setInterval");
    }
  });
});

describe("the vocabulary is the one docs/CONTEXT.md binds", () => {
  it("never writes bare `containment`", () => {
    // `docs/CONTEXT.md` rule 4: `containment` alone is not a valid identifier
    // anywhere in the codebase. This module has no reason to use it at all, and
    // asserting so keeps a future edit from introducing it casually.
    for (const file of sourceFiles()) {
      const bare = codeOnly(file.text).match(/(?<!unassisted[_ ]?)\bcontainment\b/gi);
      expect(bare, `${file.name} uses bare containment`).toBeNull();
    }
  });

  it("does not call an alert an escalation, a notification or a page in its types", () => {
    // `Avoid: notification, warning, escalation, page, incident` — as SYNONYMS
    // for alert. `incident` survives as a severity because it names how bad an
    // alert is, not the alert itself, and `PageRequest` names what a paging
    // transport receives rather than the concept.
    const surface = readFileSync(join(moduleRoot, "index.ts"), "utf8");
    const exported = codeOnly(surface);
    for (const forbidden of ["EscalationSink", "NotificationSink", "WarningSink", "AlertNotification"]) {
      expect(exported).not.toContain(forbidden);
    }
  });
});

describe("a test cannot page a real engineer", () => {
  it("delivers a page into an object the test is holding, and nowhere else", async () => {
    const transport = testPageTransport();
    const h = harness({
      sinks: [pagingAlertSink({ id: SINK("sink_pager"), rota: ROTA("rota_oncall"), transport })],
    });

    await h.alerts.raise(conditions.heartbeatMissed("sweeper"));

    // The only place the page could have gone. There is no second destination
    // and no configuration that would create one.
    expect(transport.sent).toHaveLength(1);
  });

  it("needs no flag and no environment variable to be safe", () => {
    // If any test here ever needs an environment branch, the module's
    // dependencies are wrong and the module is what should change.
    const branch = /process\.env\.[A-Za-z_]/;
    const offenders = readdirSync(here)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => branch.test(readFileSync(join(here, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});
