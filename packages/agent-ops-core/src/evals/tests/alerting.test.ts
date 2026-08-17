import { describe, expect, it } from "vitest";
import { defineSubject, determine, exactVerdict, run } from "../index.js";
import {
  echoBackend,
  harness,
  priceTable,
  PROMPT_V1,
  smallLimits,
  TEST_MODEL,
  testSeed,
  testSubjectVersion,
  threeInvoices,
} from "./fixtures.js";
import { createAlerts, recordingAlertSink, type Alerts } from "../../alerts/index.js";

/**
 * The sixth silent condition: **under-recording — decisions with no recorded
 * model call.**
 *
 * This module already counts it, and `UnattributedDecision` already blocks the
 * gate. That is the right consequence for a change a developer is watching land.
 * It is the wrong consequence for a nightly run, where a red build is a line in
 * a report nobody opens until Monday while the subject has been doing its
 * thinking somewhere unrecorded since Thursday. `docs/CONTEXT.md` puts it
 * exactly: *"The build stays green unless something counts what is missing."*
 * The gate tells a developer; this tells an operator.
 */

const alertsFor = () => {
  const sink = recordingAlertSink();
  const alerts: Alerts = createAlerts({
    sinks: [sink],
    clock: { now: () => 1_700_000_000_000 },
    timers: { deadline: () => () => undefined },
    limits: { suppressionWindowMs: 0 },
  });
  return { alerts, sink };
};

/** Stands in for a subject that captured a provider SDK in its own closure. */
const thinkingElsewhere = defineSubject({
  version: testSubjectVersion,
  purity: "calls-models",
  decide: async () => determine("duplicate", 9_000),
});

/** A subject that records its work, which is the ordinary case. */
const recorded = defineSubject({
  version: testSubjectVersion,
  purity: "calls-models",
  decide: async (ctx) => {
    await ctx.client.complete({
      model: TEST_MODEL,
      promptVersion: PROMPT_V1,
      prompt: { ref: String(ctx.input["ref"] ?? "") },
    });
    return determine("duplicate", 9_000);
  },
});

const runWith = async (subject: typeof thinkingElsewhere, alerting?: Alerts) => {
  const h = harness(undefined, undefined, undefined, alerting);
  const report = await run({
    label: "nightly",
    cases: threeInvoices(),
    subject,
    scorers: [exactVerdict],
    models: echoBackend(),
    recorder: h.recorder,
    seed: testSeed,
    limits: smallLimits,
    priceTable,
  });
  return { ...h, report };
};

describe("under-recording detected", () => {
  it("raises once for the run, not once per case", async () => {
    const a = alertsFor();
    const { report } = await runWith(thinkingElsewhere, a.alerts);

    expect(report.unattributedCases).toHaveLength(3);
    // A subject that routes around `ctx.client` does it on every case, so three
    // hundred alerts would be three hundred pages about one defect. One is the
    // honest shape of the finding.
    expect(a.sink.delivered).toHaveLength(1);
    expect(a.sink.delivered[0]?.condition).toMatchObject({
      kind: "under-recording-detected",
      decisionsExamined: 3,
      decisionsWithoutModelCall: 3,
      coverageFloorBasisPoints: 10_000,
      observedCoverageBasisPoints: 0,
    });
  });

  it("carries the run identifier, and says so rather than inventing a case", async () => {
    const a = alertsFor();
    const { report } = await runWith(thinkingElsewhere, a.alerts);
    // `docs/CONTEXT.md` binds a correlation identifier to a case, and an eval
    // run has none — it measures a subject against golden cases. What the field
    // is *for* is leading a reader from the alert to the evidence, and the run
    // identifier is the only thing here that does that.
    expect(a.sink.delivered[0]?.condition).toMatchObject({ correlationId: report.runId });
  });

  it("writes the finding as a node on the run, with what became of the alert", async () => {
    const a = alertsFor();
    const { store, report } = await runWith(thinkingElsewhere, a.alerts);
    const nodes = (await store.read(report.runId))?.nodes ?? [];
    const found = nodes.filter((n) => n.kind === "under-recording");

    expect(found).toHaveLength(1);
    expect(found[0]?.payload["alerted"]).toBe("delivered");
    expect(found[0]?.payload["alertSeverity"]).toBe("incident");
    expect(found[0]?.payload["declaredPurity"]).toBe("calls-models");
  });

  it("records `not-configured` when nobody wired alerting, rather than nothing at all", async () => {
    const { store, report } = await runWith(thinkingElsewhere);
    const nodes = (await store.read(report.runId))?.nodes ?? [];
    const found = nodes.filter((n) => n.kind === "under-recording");
    expect(found).toHaveLength(1);
    expect(found[0]?.payload["alerted"]).toBe("not-configured");
  });

  it("stays silent, and writes no node, when every decision is attributed", async () => {
    const a = alertsFor();
    const { store, report } = await runWith(recorded, a.alerts);

    expect(report.attribution).toBe("complete");
    expect(report.unattributedCases).toHaveLength(0);
    expect(a.sink.delivered).toHaveLength(0);
    const nodes = (await store.read(report.runId))?.nodes ?? [];
    // No node when there is nothing to say. A node written on every clean run
    // would be a row an operator learns to skip.
    expect(nodes.filter((n) => n.kind === "under-recording")).toHaveLength(0);
  });
});
