/**
 * The abstention rate, watched — the other half of `docs/CONTEXT.md`'s eighth
 * silent condition, and of `README.md` item 11.
 *
 * The condition reads: *"Abstention rate, **or** fail-closed screening rate,
 * moves sharply — every individual case behaved exactly as designed."*
 * `AlertCondition.measure` has always declared both arms;
 * `fail-closed-screening` was produced by `guardrails`, and `abstention` was
 * produced by nothing at all. This is the missing producer.
 *
 * ## Why it lives here and could not live anywhere else
 *
 * An abstention is a **verdict**, not an error: the system declining to decide,
 * returned through the ordinary success path. `approval` is what sees verdicts
 * — `spec.decide` returns its `Determination` to this module and to nothing
 * else — so this module is the only place in the library that can count them.
 *
 * And the counting is the whole difficulty. A deployment whose model started
 * timing out at noon produces two hundred abstentions that are each individually
 * correct: each one is a working system declining to guess, each returns
 * success, each writes a correct node, and together they mean this deployment
 * stopped deciding anything and nobody was told. There is no case to look at.
 * It is a property of a **window**, and everything odd about this file follows.
 *
 * ## The shape is `guardrails/lib/rate-watch.ts`'s, with one deliberate change
 *
 * Two closed windows and no history; lazy closing on arrival rather than a
 * timer; both windows must reach `minSample`; basis points as integers; an
 * absolute move so a collapse raises too. Those are the same rules, for the
 * same reasons, and they are not restated here.
 *
 * The change: `guardrails`'s `RateAlerting` carries its own `alerts` member,
 * because a screening module with no other alerting had nowhere else to raise
 * from. This module already takes `ApprovalDeps.alerting` for five other silent
 * conditions. Carrying a second raiser would let one module page two different
 * places about conditions drawn from the same case, which is how an operator
 * ends up with a channel they trust and a channel they do not. So the terms
 * here are the **window** only, and the raise goes through the raiser that is
 * already wired.
 *
 * That does weaken `guardrails`'s "one object or not at all" rule, which exists
 * to stop a window being wired with nowhere to raise. It is replaced by
 * something stronger rather than dropped: where `alerting` is absent the raise
 * still happens, the node is still written, and it says
 * `alerted: "not-configured"` — the same treatment every other detection in this
 * module gets, and visibly unmonitored rather than looking monitored.
 *
 * ## Why the key is the decision point, and why that is bounded
 *
 * `guardrails` could only name `input:high` because a screening does not know
 * which decision point it guards. This module does: `pointId` is its own
 * vocabulary, and `AlertCondition.decisionPoint` means exactly that here rather
 * than being the finest truthful approximation of it.
 *
 * The map is bounded by **declaration, not by traffic**: keys come from
 * `ApprovalDeps.points`, the fixed registry a deployment ships, so there is no
 * caller-supplied string that can grow it and nothing is ever evicted because
 * nothing is ever created beyond the registry.
 *
 * Tier is deliberately **not** in the key. A point's tier varies case by case
 * with the money at risk, so splitting by tier would split one point's traffic
 * across three windows and push all three under `minSample` on exactly the
 * deployments — low volume, high value — where an abstention run matters most.
 */

import { raiseAndRecord } from "../../alerts/index.js";
import type { AlertRaiser, AlertRecord, DecisionPointId } from "../../alerts/index.js";
import type { AbstentionRateTerms, Instant } from "./types.js";

interface Window {
  observed: number;
  abstained: number;
}

interface Keyed {
  startedAt: Instant;
  current: Window;
  /** The last closed window, or `null` until one has closed. The baseline. */
  baseline: Window | null;
}

/** Hundredths of a percent, as an integer. No IEEE-754 reaches a payload. */
const rateOf = (window: Window): number =>
  window.observed === 0 ? 0 : Math.round((window.abstained * 10_000) / window.observed);

export interface AbstentionWatch {
  /**
   * Record one determination and, if it closed a window, judge that window
   * against the one before it.
   *
   * Returns the alert record where one was raised, so the caller can put it on
   * a node; `undefined` where the window is still open, the sample was too
   * small, or there is no baseline yet. **Awaited on the decision path**, which
   * is a real cost and a deliberate one: it happens at most once per window,
   * and an alert sitting in a buffer when the process dies is an alert nobody
   * ever gets.
   */
  observe(pointId: string, abstained: boolean, now: Instant): Promise<AlertRecord | undefined>;
}

/**
 * A watch that counts nothing, for a deployment that declared no terms.
 *
 * Not an `if` at the call site: a module with two code paths through its
 * decision phase has two behaviours to keep in step, and the one nobody
 * configured is the one that rots. This one allocates nothing and returns
 * `undefined` synchronously-resolved.
 */
export const noAbstentionWatch: AbstentionWatch = {
  observe: async () => undefined,
};

/**
 * One window per declared decision point, no history, no eviction.
 *
 * The arithmetic between reading a window and writing it back contains no
 * `await`, so two determinations settling concurrently cannot lose a count to a
 * torn read-modify-write. The `await` is on the raise, after the window has
 * already been rolled and the counters replaced — so a slow sink delays the
 * alert and never double-counts a window or raises one twice.
 */
export const createAbstentionWatch = (
  terms: AbstentionRateTerms,
  alerting: AlertRaiser | undefined,
): AbstentionWatch => {
  const windows = new Map<string, Keyed>();

  return {
    async observe(pointId, abstained, now) {
      let held = windows.get(pointId);
      if (held === undefined) {
        held = { startedAt: now, current: { observed: 0, abstained: 0 }, baseline: null };
        windows.set(pointId, held);
      }

      let closed: Window | undefined;
      let baseline: Window | null = null;
      if (now - held.startedAt >= terms.windowMs) {
        // Windows close lazily, on arrival, rather than on a timer. This module
        // owns no timer and will not start one — `sweep` exists precisely
        // because nothing here owns a timer — and a timer here would be the one
        // piece of behaviour no test could drive from the injected clock.
        closed = held.current;
        baseline = held.baseline;
        held.baseline = closed;
        held.current = { observed: 0, abstained: 0 };
        held.startedAt = now;
      }

      held.current.observed += 1;
      if (abstained) held.current.abstained += 1;

      // **The first two windows of a process's life raise nothing**, because
      // there is no baseline to have moved from. A deployment that comes up
      // already abstaining at 100% is not caught here; it is caught by the run
      // of cases that all abstain and by whatever the application does about
      // that. This detects a *change*, which is what the condition says.
      if (closed === undefined || baseline === null) return undefined;
      // Both windows, not just the observation. A busy morning after a quiet
      // night is not evidence that anything changed.
      if (closed.observed < terms.minSample || baseline.observed < terms.minSample) {
        return undefined;
      }

      const observed = rateOf(closed);
      const before = rateOf(baseline);
      if (Math.abs(observed - before) < terms.moveBasisPoints) return undefined;

      return await raiseAndRecord(alerting, {
        kind: "rate-moved-sharply",
        measure: "abstention",
        // A real decision point, named in this module's own vocabulary. The
        // field means what it says here.
        decisionPoint: pointId as DecisionPointId,
        windowMs: terms.windowMs,
        baselineBasisPoints: before,
        observedBasisPoints: observed,
        sampleSize: closed.observed,
      });
    },
  };
};
