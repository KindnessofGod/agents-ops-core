import { describe, expect, it } from "vitest";
import { CASE_A, harness, quietDetector, sameAtEveryTier, scriptedDetector, setOf } from "./fixtures.js";
import { createRateWatch, isFailClosed, type RateAlerting, type RateWatchSpec } from "../index.js";
import { createAlerts, recordingAlertSink, type Alerts } from "../../alerts/index.js";

/**
 * The eighth silent condition: **the fail-closed screening rate moving
 * sharply.**
 *
 * `docs/CONTEXT.md`: *"every individual case behaved exactly as designed."*
 * There is no case to look at. A classifier that starts timing out at noon
 * produces two hundred screenings that each fail closed correctly, recommend
 * `abstain` correctly and write a correct node — and together mean this
 * deployment stopped making decisions with nobody told.
 *
 * It is therefore the one condition here that is a property of a **window**, and
 * the one alert in this library that is deliberately not written as a node: a
 * rate movement is not a fact about the case that happened to be screening when
 * the window closed, and attributing it to one would mislead a reader in 2033.
 */

const WINDOW = 60_000;

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

const terms = (alerts: Alerts, over: Partial<RateAlerting> = {}): RateAlerting => ({
  alerts,
  windowMs: WINDOW,
  moveBasisPoints: 2_000,
  minSample: 4,
  ...over,
});

/** Detectors whose availability a test turns on and off between screenings. */
const flakeable = () => {
  let down = false;
  const sets = sameAtEveryTier(
    setOf("mixed", [
      quietDetector("quiet", "prompt-injection phrasing"),
      scriptedDetector("classifier", () =>
        down
          ? {
              outcome: "unavailable",
              reason: "declared",
              detail: "classifier returned 503",
              costTenthCents: 0,
              modelCalls: 0,
            }
          : { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 },
      ),
    ]),
  );
  return {
    sets,
    break: () => {
      down = true;
    },
    heal: () => {
      down = false;
    },
  };
};

describe("what counts as fail-closed", () => {
  it("is an abstention grounded in a detector that could not look", async () => {
    const flaky = flakeable();
    const h = harness({ detectorSets: flaky.sets });

    const clean = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "ordinary text" },
    });
    expect(isFailClosed(clean)).toBe(false);

    flaky.break();
    const refused = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "ordinary text" },
    });
    // "We could not look, so we refused to say it was clean." Not a finding, and
    // not a payload anybody judged.
    expect(refused.recommended.recommend).toBe("abstain");
    expect(isFailClosed(refused)).toBe(true);
  });
});

describe("the fail-closed rate window", () => {
  const screenN = async (
    h: ReturnType<typeof harness>,
    count: number,
    tier: "low" | "medium" | "high" = "low",
  ) => {
    for (let i = 0; i < count; i += 1) {
      await h.guardrails.screenInput({
        correlationId: CASE_A,
        tier,
        payload: { narrative: `ordinary text ${String(i)}` },
      });
    }
  };

  it("raises when a healthy window is followed by one where the classifier died", async () => {
    const a = alertsFor();
    const flaky = flakeable();
    const h = harness({ detectorSets: flaky.sets, rateAlerting: terms(a.alerts) });

    // Window 1: everything clean. No baseline yet, so nothing can be raised.
    await screenN(h, 5);
    h.clock.advance(WINDOW);
    expect(a.sink.delivered).toHaveLength(0);

    // Window 2: the classifier is down for every screening. The window closes on
    // the first arrival after it, which is the sixth screening below.
    flaky.break();
    await screenN(h, 5);
    h.clock.advance(WINDOW);
    await screenN(h, 1);

    expect(a.sink.delivered).toHaveLength(1);
    expect(a.sink.delivered[0]?.condition).toMatchObject({
      kind: "rate-moved-sharply",
      measure: "fail-closed-screening",
      baselineBasisPoints: 0,
      observedBasisPoints: 10_000,
      sampleSize: 5,
      windowMs: WINDOW,
    });
    // A rate movement wants a human to look, in the morning. It is not a page,
    // and the severity is derived from the condition rather than chosen here.
    expect(a.sink.delivered[0]?.severity).toBe("notice");
  });

  it("raises when the rate collapses too, because a detector set that went missing looks like a fix", async () => {
    const a = alertsFor();
    const flaky = flakeable();
    flaky.break();
    const h = harness({ detectorSets: flaky.sets, rateAlerting: terms(a.alerts) });

    await screenN(h, 5);
    h.clock.advance(WINDOW);
    flaky.heal();
    await screenN(h, 5);
    h.clock.advance(WINDOW);
    await screenN(h, 1);

    expect(a.sink.delivered[0]?.condition).toMatchObject({
      baselineBasisPoints: 10_000,
      observedBasisPoints: 0,
    });
  });

  it("stays silent while the rate holds steady", async () => {
    const a = alertsFor();
    const flaky = flakeable();
    const h = harness({ detectorSets: flaky.sets, rateAlerting: terms(a.alerts) });

    for (let window = 0; window < 4; window += 1) {
      await screenN(h, 5);
      h.clock.advance(WINDOW);
    }
    await screenN(h, 1);
    expect(a.sink.delivered).toHaveLength(0);
  });

  it("refuses to judge a window too small to mean anything", async () => {
    const a = alertsFor();
    const flaky = flakeable();
    const h = harness({ detectorSets: flaky.sets, rateAlerting: terms(a.alerts, { minSample: 10 }) });

    await screenN(h, 5);
    h.clock.advance(WINDOW);
    flaky.break();
    await screenN(h, 5);
    h.clock.advance(WINDOW);
    await screenN(h, 1);

    // A move over five cases is noise, and an alert built from noise is an alert
    // that gets muted — the recurrence-cadence failure, one level up.
    expect(a.sink.delivered).toHaveLength(0);
  });

  it("keeps high-tier and low-tier windows apart", async () => {
    const a = alertsFor();
    const flaky = flakeable();
    const h = harness({ detectorSets: flaky.sets, rateAlerting: terms(a.alerts) });

    // A healthy baseline at both tiers.
    await screenN(h, 5, "low");
    await screenN(h, 5, "high");
    h.clock.advance(WINDOW);

    // Then only the high-tier path breaks — a model detector that fails under
    // load at high tier and not at low is a different incident from one that
    // fails at both, and an operator needs to be told which.
    await screenN(h, 5, "low");
    flaky.break();
    await screenN(h, 5, "high");
    h.clock.advance(WINDOW);
    await screenN(h, 1, "low");
    await screenN(h, 1, "high");

    expect(a.sink.delivered).toHaveLength(1);
    expect(a.sink.delivered[0]?.condition).toMatchObject({ decisionPoint: "input:high" });
  });

  it("watches nothing, and changes nothing, when a deployment wires no terms", async () => {
    const flaky = flakeable();
    const h = harness({ detectorSets: flaky.sets });

    flaky.break();
    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "ordinary" },
    });
    // Screening behaves identically. Nothing degrades; nothing is watched.
    expect(screening.recommended.recommend).toBe("abstain");
  });

  it("does not write the movement as a node on whichever case closed the window", async () => {
    const a = alertsFor();
    const flaky = flakeable();
    const h = harness({ detectorSets: flaky.sets, rateAlerting: terms(a.alerts) });

    await screenN(h, 5);
    h.clock.advance(WINDOW);
    flaky.break();
    await screenN(h, 5);
    h.clock.advance(WINDOW);
    await screenN(h, 1);
    expect(a.sink.delivered).toHaveLength(1);

    // `alerts.correlationOf` returns `undefined` for this condition, and this is
    // the same judgement one level up: a property of a window over a population
    // is not a fact about one claim, and a reader in 2033 would reasonably
    // conclude that claim had something to do with it.
    const kinds = await h.kinds();
    expect(kinds.some((k) => k.includes("rate"))).toBe(false);
  });
});

/**
 * The **other half** of the eighth silent condition.
 *
 * `AlertCondition.measure` declares `abstention` or `fail-closed-screening` and
 * only the second was ever produced. The first cannot be produced here and the
 * reason is `docs/CONTEXT.md`, not effort: an abstention is a **verdict
 * disposition**, and this module produces no verdict. A screening that
 * recommends `abstain` is a recommendation the decision may overrule in either
 * direction, so counting recommendations under the name "abstention rate" would
 * name a number after something it does not measure.
 *
 * So the watch belongs to `approval`, which sees verdicts, and what is proved
 * here is that the shape it will call is real, exercised and bounded — not that
 * `guardrails` has quietly started producing verdicts.
 */
describe("the abstention half, which approval must call", () => {
  /** Stands in for whatever `approval` will pass. Deliberately not a Screening. */
  interface Settled {
    readonly decisionPoint: string;
    readonly disposition: "concluded" | "abstained";
  }

  const abstentionWatch: RateWatchSpec<Settled> = {
    measure: "abstention",
    partition: (settled) => settled.decisionPoint,
    counts: (settled) => settled.disposition === "abstained",
    maxPartitions: 4,
  };

  const settle = async (
    watch: ReturnType<typeof createRateWatch<Settled>>,
    at: number,
    count: number,
    disposition: Settled["disposition"],
    decisionPoint = "invoice.pay",
  ) => {
    for (let i = 0; i < count; i += 1) {
      await watch.observe({ decisionPoint, disposition }, at);
    }
  };

  it("raises rate-moved-sharply with measure 'abstention'", async () => {
    const a = alertsFor();
    const watch = createRateWatch<Settled>(terms(a.alerts), abstentionWatch);

    await settle(watch, 0, 5, "concluded");
    await settle(watch, WINDOW, 5, "abstained");
    await settle(watch, WINDOW * 2, 1, "concluded");

    expect(a.sink.delivered).toHaveLength(1);
    expect(a.sink.delivered[0]?.condition).toMatchObject({
      kind: "rate-moved-sharply",
      // The half that was declared and never produced.
      measure: "abstention",
      // A real decision point, because `approval` has one. `guardrails` does
      // not, and says `input:high` rather than inventing one.
      decisionPoint: "invoice.pay",
      baselineBasisPoints: 0,
      observedBasisPoints: 10_000,
      sampleSize: 5,
    });
  });

  it("is one implementation, so it holds steady on the same terms the screening watch does", async () => {
    const a = alertsFor();
    const watch = createRateWatch<Settled>(terms(a.alerts), abstentionWatch);
    for (let window = 0; window < 4; window += 1) {
      await settle(watch, WINDOW * window, 5, "concluded");
    }
    await settle(watch, WINDOW * 4, 1, "concluded");
    expect(a.sink.delivered).toHaveLength(0);
  });

  it("folds partitions past its ceiling into one named window rather than growing a map", async () => {
    const a = alertsFor();
    const watch = createRateWatch<Settled>(terms(a.alerts), {
      ...abstentionWatch,
      maxPartitions: 1,
    });

    // The first decision point takes the only slot. Everything after it folds
    // into `(overflow)`, which is still watched — a partition function that
    // explodes is a wiring defect, and signal that quietly stops arriving is
    // worse than an alert that names the defect.
    await settle(watch, 0, 5, "concluded", "invoice.pay");
    await settle(watch, 0, 5, "concluded", "invoice.approve");
    await settle(watch, WINDOW, 5, "abstained", "invoice.approve");
    await settle(watch, WINDOW * 2, 1, "concluded", "invoice.approve");

    expect(a.sink.delivered[0]?.condition).toMatchObject({ decisionPoint: "(overflow)" });
  });

  it("refuses terms that would make it look monitored without being monitored", () => {
    const a = alertsFor();
    expect(() => createRateWatch<Settled>(terms(a.alerts, { minSample: 0 }), abstentionWatch)).toThrow(
      /minSample/,
    );
    expect(() =>
      createRateWatch<Settled>(terms(a.alerts, { moveBasisPoints: 0 }), abstentionWatch),
    ).toThrow(/moveBasisPoints/);
    expect(() =>
      createRateWatch<Settled>(terms(a.alerts), { ...abstentionWatch, maxPartitions: 0 }),
    ).toThrow(/maxPartitions/);
  });
});
