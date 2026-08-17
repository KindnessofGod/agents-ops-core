import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOORS,
  defineSubject,
  determine,
  exactVerdict,
  gate,
  READABLE_REPORT_SCHEMAS,
  reopenAccuracyReport,
  reopenAgreementReport,
  ReportRefused,
  run,
} from "../index.js";
import type { RunSpec, Subject } from "../index.js";
import {
  echoBackend,
  harness,
  priceTable,
  smallLimits,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";

/**
 * Report schema evolution, on read.
 *
 * The module claimed a seven-year story for **nodes** and had none for
 * **reports**, which is the wrong way round: the node graph expires at 90 days
 * and the report is the artefact that outlives it. Adding
 * `couldNotEvaluateBasisPoints`, `selection` and a determinism *check* changed
 * the meaning of the artefact, so the number moved — `report.accuracy/2` — and
 * `/1` is upcast on read rather than reinterpreted under today's rules.
 *
 * The values chosen for an old report matter as much as the mechanism, and both
 * are asserted below.
 */

const subject: Subject = defineSubject({
  version: testSubjectVersion,
  purity: "pure",
  decide: async () => determine("duplicate", 9_000),
});

const specFor = (): Omit<RunSpec<"golden">, "recorder"> => ({
  label: "pre-merge",
  cases: threeInvoices(),
  subject,
  scorers: [exactVerdict],
  models: echoBackend(),
  seed: testSeed,
  limits: smallLimits,
  priceTable,
});

/** A `/1` report, as an older build would have written it. */
const asVersionOne = (report: unknown): Record<string, unknown> => {
  const record = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  record["schema"] = "report.accuracy/1";
  delete record["couldNotEvaluateBasisPoints"];
  delete record["selection"];
  delete record["memoisation"];
  record["determinism"] = { declared: "deterministic" };
  return record;
};

describe("a report written by an older build still reads", () => {
  it("upcasts report.accuracy/1 on read without touching the bytes on disk", async () => {
    const { recorder } = harness();
    const fresh = await run({ ...specFor(), recorder });
    const old = asVersionOne(fresh);
    const bytes = JSON.stringify(old);

    const reopened = reopenAccuracyReport(old);
    expect(reopened.schema).toBe("report.accuracy/2");
    // Nothing was rewritten in place. A migration that touches history makes the
    // artefact evidence of the migration rather than of the run.
    expect(JSON.stringify(old)).toBe(bytes);

    // `0`, because a `/1` run could not tell a provider outage from an unscored
    // case — its outage cases are already inside `unscoredBasisPoints`, and
    // moving them would be inventing data.
    expect(reopened.couldNotEvaluateBasisPoints).toBe(0);
    // `null`, because subsets did not exist: the run covered whatever it covered
    // and nothing claims otherwise.
    expect(reopened.selection).toBeNull();
    // **`not-checked`, not stable.** An old report is silent about determinism,
    // and silence is not a pass.
    expect(reopened.determinism.check.kind).toBe("not-checked");
    if (reopened.determinism.check.kind !== "not-checked") throw new Error("unreachable");
    expect(reopened.determinism.check.why).toContain("report.accuracy/1");
  });

  it("gates an upcast report, so the old artefact is still usable evidence", async () => {
    const { recorder } = harness();
    const fresh = await run({ ...specFor(), recorder });
    const outcome = await gate({
      report: reopenAccuracyReport(asVersionOne(fresh)),
      baseline: undefined,
      floors: DEFAULT_FLOORS,
      recorder,
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    expect(outcome.reason).toBe("baseline-missing");
    expect(outcome.coverage.kind).toBe("full");
  });

  it("names every schema this build reads, and refuses the rest", async () => {
    expect(READABLE_REPORT_SCHEMAS).toContain("report.accuracy/1");
    expect(READABLE_REPORT_SCHEMAS).toContain("report.accuracy/2");
    // A schema from a future build is refused rather than reinterpreted under
    // today's rules, which is how a 2033 reader gets misled quietly.
    const { recorder } = harness();
    const fresh = await run({ ...specFor(), recorder });
    const future = { ...JSON.parse(JSON.stringify(fresh)), schema: "report.accuracy/9" };
    expect(() => reopenAccuracyReport(future)).toThrow(ReportRefused);
  });
});

describe("the agreement report has an honest re-entry too", () => {
  it("refuses an accuracy report's JSON, in both directions", async () => {
    const { recorder } = harness();
    const accuracy = JSON.parse(JSON.stringify(await run({ ...specFor(), recorder }))) as unknown;
    // The compile-time brands do not survive `JSON.stringify`, so the runtime
    // twin has to hold the same line — and it holds it both ways round.
    expect(() => reopenAgreementReport(accuracy)).toThrow(ReportRefused);
  });

  it("refuses an agreement report with no named human-decision source", () => {
    // A figure whose provenance is unknown cannot be audited and is therefore
    // not evidence of anything.
    expect(() =>
      reopenAgreementReport({
        schema: "report.agreement/2",
        against: "recorded-human-decisions",
        capturedVia: "injected-client-only",
        humanDecisionSource: "",
        cases: [{ status: "agreed" }],
      }),
    ).toThrow(ReportRefused);
  });
});
