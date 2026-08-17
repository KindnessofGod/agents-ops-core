/**
 * The fail-closed screening rate, watched.
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
 * Six keys at most — two phases by three tiers — each holding two integer pairs.
 * There is no unbounded map keyed on anything a caller supplies, and no entry is
 * ever evicted because none is ever created beyond those six.
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
  screenings: number;
  failClosed: number;
}

interface Keyed {
  startedAt: Instant;
  current: Window;
  /** The last closed window, or `null` until one has closed. The baseline. */
  baseline: Window | null;
}

/** Hundredths of a percent, as an integer. No IEEE-754 reaches a payload. */
const rateOf = (window: Window): number =>
  window.screenings === 0 ? 0 : Math.round((window.failClosed * 10_000) / window.screenings);

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

export interface RateWatch {
  /**
   * Record one screening and, if it closed a window, judge that window against
   * the one before it.
   *
   * Returns the alert record where one was raised, so a caller can put it
   * somewhere; `undefined` where the window is still open or the sample was too
   * small. **Awaited on the screening path**, which is a real cost and a
   * deliberate one: it happens at most once per window, and an alert sitting in
   * a buffer when the process dies is an alert nobody ever gets.
   */
  observe(screening: Screening, now: Instant): Promise<AlertRecord | undefined>;
}

/**
 * Six windows, no history, no eviction.
 *
 * The arithmetic between `observe` reading the window and writing it back
 * contains no `await`, so two screenings settling concurrently cannot lose a
 * count to a torn read-modify-write. The `await` is on the raise, after the
 * window has already been rolled and the counters replaced — so a slow sink
 * delays the alert and never double-counts a window or raises one twice.
 */
export const createRateWatch = (terms: RateAlerting): RateWatch => {
  const windows = new Map<string, Keyed>();

  return {
    async observe(screening, now) {
      // `input:high`, `output:low`. Six possible values, all of them ours: no
      // caller-supplied string reaches this key, so the map cannot grow.
      const key = `${screening.phase satisfies ScreeningPhase}:${screening.tier satisfies RiskTier}`;
      let held = windows.get(key);
      if (held === undefined) {
        held = { startedAt: now, current: { screenings: 0, failClosed: 0 }, baseline: null };
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
        held.current = { screenings: 0, failClosed: 0 };
        held.startedAt = now;
      }

      held.current.screenings += 1;
      if (isFailClosed(screening)) held.current.failClosed += 1;

      if (closed === undefined || baseline === null) return undefined;
      // Both windows, not just the observation. A busy morning after a quiet
      // night is not evidence that anything changed.
      if (closed.screenings < terms.minSample || baseline.screenings < terms.minSample) {
        return undefined;
      }

      const observed = rateOf(closed);
      const before = rateOf(baseline);
      if (Math.abs(observed - before) < terms.moveBasisPoints) return undefined;

      return await raiseAndRecord(terms.alerts, {
        kind: "rate-moved-sharply",
        measure: "fail-closed-screening",
        // See the header: this is the finest partition this module can name
        // truthfully. It is not a decision point and does not pretend to be one.
        decisionPoint: key as DecisionPointId,
        windowMs: terms.windowMs,
        baselineBasisPoints: before,
        observedBasisPoints: observed,
        sampleSize: closed.screenings,
      });
    },
  };
};
