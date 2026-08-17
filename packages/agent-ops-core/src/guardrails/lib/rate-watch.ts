/**
 * A rate, watched — and the fail-closed screening rate as the first thing
 * watched with it.
 *
 * ## The other half of the eighth condition, and where it has to live
 *
 * `AlertCondition`'s `rate-moved-sharply` declares two measures: `abstention`
 * **or** `fail-closed-screening`. Only the second was ever produced, and the
 * first was not merely unwritten — it was unwritable here. Per `docs/CONTEXT.md`
 * an abstention is a **verdict disposition**, the system declining to conclude,
 * and this module produces no verdict: it produces findings and a *recommended*
 * disposition. A screening that recommends `abstain` is not an abstention. There
 * are deployments where the decision overrides the recommendation in both
 * directions, so counting recommendations and labelling the result "abstention
 * rate" would put a number in front of an operator that does not measure what
 * its name says — the precise failure `CONTEXT.md` fixes this vocabulary to
 * prevent, and a worse outcome than leaving the measure unimplemented.
 *
 * **So the abstention-rate watch belongs to `approval`, which is the module that
 * sees verdicts.** What is here is the arithmetic, generalised so `approval`
 * supplies its own observation type, its own partition and its own rule for what
 * counts — and so there is exactly one implementation of "has this rate moved
 * sharply?" in the library rather than two that disagree by a hair.
 *
 * Reported upward as the remaining work, stated concretely so it is not a
 * gesture: `approval` constructs
 * `createRateWatch(terms, { measure: "abstention", partition: …, counts: (v) =>
 * v.disposition === "abstained", maxPartitions: … })` and calls `observe` on
 * every settled verdict. Nothing else about this file changes when it does.
 *
 * The natural long-term home for this shape is `alerts`, which owns the
 * condition — it lives here because `guardrails` is the only module that already
 * watched a rate, and moving it is a one-import change for both callers.
 *
 * ## The original argument, unchanged
 *
 * `docs/CONTEXT.md`'s eighth silent condition, and the one that is invisible by
 * construction rather than by accident: *"Abstention rate, or fail-closed
 * screening rate, moves sharply — **every individual case behaved exactly as
 * designed**."* There is no case to look at. A classifier that started timing
 * out at noon produces two hundred screenings that each fail closed correctly,
 * each recommend `abstain` correctly, each write a correct node, and together
 * mean that this deployment stopped making decisions and nobody was told.
 *
 * It is therefore the only condition in this module that is a property of a
 * **window** rather than of a payload, and everything odd about this file
 * follows from that.
 *
 * ## What counts as fail-closed
 *
 * A screening whose recommendation is `abstain` on grounds that include
 * `detector-unavailable`. Not `escalate` — a detector that *found* something is
 * the module working. Not an `abstain` grounded only in findings — that is a
 * payload the detectors judged, which is also the module working. Fail-closed
 * means specifically: *we could not look, so we refused to say it was clean.*
 *
 * ## Why two windows and not a rolling average
 *
 * "Moved sharply" needs something to have moved *from*. A single rolling number
 * cannot say whether 40% is a change or the way this deployment has always been;
 * the honest comparison is one completed window against the one before it. So
 * the tracker holds exactly two closed windows' worth of arithmetic and nothing
 * else — no history, no percentile, no series. A dashboard is a different
 * product, and this module's job is to be certain somebody *looks* at the
 * dashboard.
 *
 * A consequence worth stating plainly: **the first two windows of a process's
 * life raise nothing**, because there is no baseline yet. A deployment that
 * comes up already broken is not caught here; it is caught by the run of cases
 * that all abstain, and by whatever the application does about that. This
 * detects a *change*, which is what the condition says.
 *
 * ## Bounded, as everything in this module is
 *
 * Six keys at most for the screening watch — two phases by three tiers — each
 * holding two integer pairs. Generalising the arithmetic made that bound a
 * caller's to state rather than a fact of the code, so `maxPartitions` is
 * required and there is no unbounded setting: past it every further partition is
 * folded into one reserved `(overflow)` window whose movement is still watched.
 * Folding rather than dropping is deliberate — a partition function that
 * explodes is a wiring defect, and an operator should see it as a partition
 * named `(overflow)` on an alert rather than as signal that quietly stopped
 * arriving.
 *
 * ## Why the window is keyed by phase and tier, and not by decision point
 *
 * The alert condition carries a `decisionPoint`, and this module genuinely does
 * not know one: `screenInput` is given a correlation identifier, a tier and a
 * payload, and the decision point a screening guards is `approval`'s vocabulary,
 * not ours. Widening `InputScreeningRequest` to demand one would push a field
 * onto nineteen callers to serve a metric.
 *
 * So the identifier carried is `input:high`, `output:low` and so on — the finest
 * partition this module can make **truthfully**. It is a real partition and it is
 * the one that matters operationally: a model detector that starts failing at
 * high tier and not at low is a different incident from one that fails at both.
 * Reporting a decision point we do not have would be worse than reporting the
 * partition we do.
 */

import { raiseAndRecord } from "../../alerts/index.js";
import { LimitsInvalid } from "./errors.js";
import type { AlertRaiser, AlertRecord, DecisionPointId } from "../../alerts/index.js";
import type { RiskTier } from "../../audit/index.js";
import type { Instant, Screening, ScreeningPhase } from "./types.js";

/**
 * What a deployment must state before this can judge anything.
 *
 * Wired as **one object or not at all**, deliberately. A window with nowhere to
 * raise is a counter nobody reads; a sink with no window terms cannot judge a
 * movement. Half-wiring the two would produce a system that looks monitored, and
 * looking monitored is worse than being visibly unmonitored.
 *
 * None of the three has a default. The right window for a deployment handling
 * eleven cases an hour and one handling eleven thousand are not the same window,
 * and a default here would be this library deciding on nineteen applications'
 * behalf what counts as a sharp move in their domain.
 */
export interface RateAlerting {
  /** Where `rate-moved-sharply` goes. Injected; a test cannot page anybody. */
  readonly alerts: AlertRaiser;
  /**
   * How long a window is, in integer milliseconds. Windows are closed lazily —
   * by the first screening to arrive after the window's end — so a deployment
   * that stops screening entirely never closes another window and never raises
   * from here. That is correct: **no screenings at all is not a rate movement**,
   * it is a stopped component, and the heartbeat and its external watcher are
   * what detect that. Two mechanisms for two different failures.
   */
  readonly windowMs: number;
  /**
   * How big a move is sharp, in basis points of the fail-closed rate. A move
   * from 4% to 11% is 700. Absolute, so a rate that *collapses* also raises —
   * detectors that suddenly stop failing closed is either a fix or a detector
   * set that quietly went missing, and an operator should decide which.
   */
  readonly moveBasisPoints: number;
  /**
   * The fewest screenings a window must hold before its rate is believed.
   *
   * A move over eleven cases is noise, and an alert built from noise is an alert
   * that gets muted — the same failure the recurrence-cadence rule exists to
   * prevent, one level up. **Both** windows must reach it: a quiet night
   * followed by a busy morning is not evidence of anything.
   */
  readonly minSample: number;
}

interface Window {
  /** How many observations arrived in this window. The denominator. */
  observations: number;
  /** How many of them `RateWatchSpec.counts` counted. The numerator. */
  counted: number;
}

interface Keyed {
  startedAt: Instant;
  current: Window;
  /** The last closed window, or `null` until one has closed. The baseline. */
  baseline: Window | null;
}

/** Hundredths of a percent, as an integer. No IEEE-754 reaches a payload. */
const rateOf = (window: Window): number =>
  window.observations === 0 ? 0 : Math.round((window.counted * 10_000) / window.observations);

/**
 * Whether this screening failed closed: it could not look, so it refused to say
 * the payload was clean.
 *
 * Exported so the rule is testable and so there is exactly one of it. A second
 * definition of "fail-closed" living in a dashboard query is how a metric and
 * its alert start disagreeing about the thing they are both named after.
 */
export const isFailClosed = (screening: Screening): boolean =>
  screening.recommended.recommend === "abstain" &&
  screening.recommended.grounds.some((ground) => ground.ground === "detector-unavailable");

/**
 * The screening watch, which is this module's own use of the shape above.
 *
 * Six partitions and no more: two phases by three tiers, every value of it
 * minted here, so no caller-supplied string reaches the key and the ceiling is
 * unreachable rather than merely enforced.
 */
export const screeningRateWatch: RateWatchSpec<Screening> = Object.freeze({
  measure: "fail-closed-screening",
  partition: (screening: Screening): string =>
    `${screening.phase satisfies ScreeningPhase}:${screening.tier satisfies RiskTier}`,
  counts: isFailClosed,
  maxPartitions: 6,
});

/**
 * Terms and spec are checked at construction, never at observation time.
 *
 * Same argument as `Limits`: a bound whose extreme value silently changes an
 * answer is a defect that presents as a working system. `minSample: 0` believes
 * an empty window, `moveBasisPoints: 0` raises on every window that closes until
 * somebody mutes the alert, and `maxPartitions: 0` folds every partition into
 * one and reports a movement over traffic nobody meant to combine. All three
 * produce a monitored-looking deployment, which is the outcome this whole file
 * exists to avoid.
 */
const checkTerms = <T>(terms: RateAlerting, spec: RateWatchSpec<T>): void => {
  const positive = (name: string, value: unknown): void => {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new LimitsInvalid(`rateAlerting.${name}`, value);
    }
  };
  positive("windowMs", terms.windowMs);
  positive("moveBasisPoints", terms.moveBasisPoints);
  positive("minSample", terms.minSample);
  positive("maxPartitions", spec.maxPartitions);
  if (typeof terms.alerts?.raise !== "function") {
    throw new LimitsInvalid("rateAlerting.alerts", terms.alerts);
  }
};

/**
 * What is being watched, supplied by whichever module can see it.
 *
 * Three functions and a bound, and every one of them exists because this module
 * cannot answer the question for another. `guardrails` knows what a fail-closed
 * screening is and cannot know what an abstention is; `approval` is the reverse.
 * Neither should own a second copy of the arithmetic.
 */
export interface RateWatchSpec<T> {
  /**
   * Which of `AlertCondition`'s two measures this is. Written onto the raised
   * condition verbatim, so an operator sees the measure the library declares
   * rather than one this file inferred.
   */
  readonly measure: "abstention" | "fail-closed-screening";
  /**
   * The window key, and the `decisionPoint` the alert carries.
   *
   * Name the finest partition the calling module can make **truthfully**.
   * `guardrails` answers `input:high` because it is given no decision point and
   * will not invent one; `approval` has a real decision point and should use it.
   */
  partition(observation: T): string;
  /** The numerator: whether this observation is one of the things being counted. */
  counts(observation: T): boolean;
  /**
   * The most partitions to hold. Required, with no default: a bound only the
   * caller can state, because only the caller knows how many values its own
   * partition function can take. Past it, everything folds into `(overflow)`.
   */
  readonly maxPartitions: number;
}

export interface RateWatch<T> {
  /**
   * Record one observation and, if it closed a window, judge that window against
   * the one before it.
   *
   * Returns the alert record where one was raised, so a caller can put it
   * somewhere; `undefined` where the window is still open or the sample was too
   * small. **Awaited on the caller's own path**, which is a real cost and a
   * deliberate one: it happens at most once per window, and an alert sitting in
   * a buffer when the process dies is an alert nobody ever gets.
   */
  observe(observation: T, now: Instant): Promise<AlertRecord | undefined>;
}

/** The key everything past `maxPartitions` is folded into. Never a real one. */
const OVERFLOW = "(overflow)";

/**
 * Bounded windows, no history, no eviction.
 *
 * The arithmetic between `observe` reading the window and writing it back
 * contains no `await`, so two observations settling concurrently cannot lose a
 * count to a torn read-modify-write. The `await` is on the raise, after the
 * window has already been rolled and the counters replaced — so a slow sink
 * delays the alert and never double-counts a window or raises one twice.
 */
export const createRateWatch = <T>(terms: RateAlerting, spec: RateWatchSpec<T>): RateWatch<T> => {
  checkTerms(terms, spec);
  const windows = new Map<string, Keyed>();

  return {
    async observe(observation, now) {
      const named = spec.partition(observation);
      // A partition function that explodes is a wiring defect, and it must not
      // become an unbounded map on the hot path of every decision.
      const key =
        windows.has(named) || windows.size < spec.maxPartitions ? named : OVERFLOW;
      let held = windows.get(key);
      if (held === undefined) {
        held = { startedAt: now, current: { observations: 0, counted: 0 }, baseline: null };
        windows.set(key, held);
      }

      let closed: Window | undefined;
      let baseline: Window | null = null;
      if (now - held.startedAt >= terms.windowMs) {
        // Windows close lazily, on arrival, rather than on a timer. This module
        // owns no timer and will not start one: a timer here would fire inside
        // whatever process happened to be idle, against a clock this module was
        // not given, and would be the one piece of behaviour no test could drive.
        closed = held.current;
        baseline = held.baseline;
        held.baseline = closed;
        held.current = { observations: 0, counted: 0 };
        held.startedAt = now;
      }

      held.current.observations += 1;
      if (spec.counts(observation)) held.current.counted += 1;

      if (closed === undefined || baseline === null) return undefined;
      // Both windows, not just the observation. A busy morning after a quiet
      // night is not evidence that anything changed.
      if (closed.observations < terms.minSample || baseline.observations < terms.minSample) {
        return undefined;
      }

      const observed = rateOf(closed);
      const before = rateOf(baseline);
      if (Math.abs(observed - before) < terms.moveBasisPoints) return undefined;

      return await raiseAndRecord(terms.alerts, {
        kind: "rate-moved-sharply",
        measure: spec.measure,
        // The finest partition the calling module can name truthfully. For
        // `guardrails` that is `input:high` and it is not a decision point; the
        // spec's own documentation says so rather than this file pretending.
        decisionPoint: key as DecisionPointId,
        windowMs: terms.windowMs,
        baselineBasisPoints: before,
        observedBasisPoints: observed,
        sampleSize: closed.observations,
      });
    },
  };
};
