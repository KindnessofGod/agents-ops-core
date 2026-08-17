/**
 * The one call the other four modules make.
 *
 * `index.ts` used to say, honestly, that nothing was wired into another module:
 * *"`approval` does not call `raise`, `audit` does not back the journal, and the
 * sweeper does not beat — yet."* This file is the "yet". It is deliberately the
 * **only** shape of that wiring, because four modules each inventing their own
 * try/catch around `raise` is four different answers to the same three questions:
 * what happens when nobody wired an `Alerts`, what happens when a sink chain is
 * gone, and what the trace says afterwards.
 *
 * ## Why this lives in `alerts` and not four times over
 *
 * A detection site in `approval` knows one thing an alerting module cannot: that
 * a reserved decision just completed unassisted. It does not know, and must not
 * have an opinion about, whether a page reached a human. So the detection site
 * calls one function and records what it returns.
 *
 * The return value is deliberately **node-shaped** — flat, integer-only, no free
 * text — so a detection site can spread it straight into the payload it was
 * already writing. That is what replaces the `alert: true` flag those payloads
 * used to carry on its own. `alert: true` said *somebody ought to be told*;
 * `alerted: "delivered"` beside `alertBy: "pager"` says somebody was, and
 * `alerted: "not-configured"` says the deployment never wired a sink and the
 * trace is the place that admits it.
 *
 * ## Three rules, and the reasoning for each
 *
 * **1. It never throws.** Not for a delivery failure — `raise` already promises
 * that — and not for a caller defect either. `AlertPayloadInvalid` and
 * `UnknownAlertCondition` are real defects and they are fail-closed *inside*
 * `alerts`, where the caller is a composition root that can fix them. Here the
 * caller is a case that has just been found to be in trouble, and converting
 * "we detected a silent failure" into "the case threw" would lose the case *and*
 * the finding. So the defect is caught, named in the node (`alertError`), and
 * the original work continues. A defect that is loud in the trace and does not
 * destroy evidence is the right trade at a detection site.
 *
 * **2. Absence of an `Alerts` is recorded, never assumed.** Every module takes
 * its alerting dependency as optional, because nineteen applications cannot all
 * be recompiled at once and a required dependency would have been added by
 * everyone as `createAlerts({ sinks: [recordingAlertSink()] })` — which is worse
 * than absence, because it looks wired. Absence produces
 * `alerted: "not-configured"` on the node, so an auditor reading a case in 2033
 * can tell "nobody was told" from "somebody was told".
 *
 * **3. It reports, it does not retry.** `raise` walks an ordered chain of sinks;
 * the chain *is* the redundancy. A retry here would be a second chain walk with
 * no new information, on the path of a case that is already in trouble.
 */

import type { AlertCondition, AlertConditionKind } from "./conditions.js";
import { severityOf } from "./conditions.js";
import type { AlertSeverity } from "./severity.js";
import type { AlertField, AlertSinkId } from "./primitives.js";
import type { Alerts, UndeliveredReason } from "./types.js";

/**
 * What a detecting module needs from `alerts`, and nothing more.
 *
 * `Alerts` itself also carries `health()`, which is for the external watcher and
 * the composition root — not for a module in the middle of handling a case. A
 * narrower parameter type means a detection site cannot start reading the
 * alerting system's own statistics and making decisions on them, which is a
 * feedback loop nobody wants inside `executeEffect`.
 *
 * An `Alerts` from `createAlerts` satisfies this directly, with no adapter.
 */
export type AlertRaiser = Pick<Alerts, "raise">;

/**
 * What happened to the alert, as fields on the node the detection site was
 * already writing.
 *
 * `alert: true` is kept — it is what dashboards and the existing node payloads
 * already key on, and removing it would silently change the meaning of every
 * historical node — but it is no longer the *whole* story, which is the defect
 * this record fixes. It now means "this node describes an alertable condition",
 * and `alerted` says what became of it.
 */
export interface AlertRecord {
  /** This node describes an alertable condition. Unchanged in meaning. */
  readonly alert: true;
  /**
   * What became of it.
   *
   *   `delivered`        A sink in the chain accepted it.
   *   `suppressed`       An identical fingerprint is inside its window. The
   *                      condition is **not** silenced: the window ends and the
   *                      collapsed count rides on the next delivery.
   *   `undelivered`      The chain was walked and reached nobody. See
   *                      `alertReason`, and see `health()` — this is the state
   *                      the external watcher exists to notice.
   *   `not-configured`   No `Alerts` was wired into this module. Loud in the
   *                      trace precisely because it is silent everywhere else.
   *   `refused`          `raise` rejected the condition as malformed. A defect
   *                      in this library or its caller, named rather than
   *                      allowed to take the case down. See `alertError`.
   */
  readonly alerted: "delivered" | "suppressed" | "undelivered" | "not-configured" | "refused";
  readonly alertCondition: AlertConditionKind;
  /** Derived from the condition inside `alerts`. There is no parameter for it. */
  readonly alertSeverity: AlertSeverity;
  /** Which sink took it. Absent unless `alerted` is `delivered`. */
  readonly alertBy?: AlertSinkId;
  /** How many sinks failed on the way. Zero on a healthy chain. */
  readonly alertDegradations: number;
  /** Why nobody was reached. Present only when `alerted` is `undelivered`. */
  readonly alertReason?: UndeliveredReason;
  /**
   * How many identical occurrences were collapsed. Reported on a delivery so a
   * reader learns the condition is flapping rather than that it happened once.
   */
  readonly alertSuppressedSince?: number;
  /**
   * The **name** of the error `raise` threw. Never its message: an exception
   * message routinely echoes the input that produced it, and this record is
   * written into a seven-year archive that has no un-writing.
   */
  readonly alertError?: string;
}

/**
 * `AlertRecord` is already flat and integer-only, but it is an interface with
 * optional members and the node payload types in `audit`, `approval`, `evals`
 * and `guardrails` are index signatures over `PayloadField`. This is the type
 * that says the two are compatible without any of the four needing a cast.
 */
export type AlertRecordFields = Readonly<Record<string, AlertField | undefined>>;

/**
 * Raise a condition through an optional `Alerts` and describe what happened.
 *
 * The `void` return is not available: every call site is expected to put the
 * result on a node. A detection that alerted and did not say so in the trace is
 * half of the mechanism, and the half that is missing is the half an auditor
 * reads.
 */
export const raiseAndRecord = async (
  alerting: AlertRaiser | undefined,
  condition: AlertCondition,
): Promise<AlertRecord> => {
  const severity = severityOf(condition);
  const base = {
    alert: true,
    alertCondition: condition.kind,
    alertSeverity: severity,
    alertDegradations: 0,
  } as const;

  if (alerting === undefined) return { ...base, alerted: "not-configured" };

  let outcome;
  try {
    outcome = await alerting.raise(condition);
  } catch (cause) {
    return {
      ...base,
      alerted: "refused",
      alertError: cause instanceof Error ? cause.name : `non-error:${typeof cause}`,
    };
  }

  switch (outcome.outcome) {
    case "delivered":
      return {
        ...base,
        alerted: "delivered",
        alertBy: outcome.by,
        alertDegradations: outcome.degradations.length,
        alertSuppressedSince: outcome.alert.suppressedSinceLastDelivery,
      };
    case "suppressed":
      return {
        ...base,
        alerted: "suppressed",
        alertSuppressedSince: outcome.suppressedSinceLastDelivery,
      };
    case "undelivered":
      return {
        ...base,
        alerted: "undelivered",
        alertReason: outcome.reason,
        alertDegradations: outcome.degradations.length,
      };
  }
};
