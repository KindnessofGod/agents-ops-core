/**
 * `createAlerts` — the ordered chain, the suppression, the bounds, the journal
 * and the last-resort ledger, behind one verb.
 *
 * ## The path one alert takes, in order, with the reason for each step
 *
 *  1. **Validate.** A caller defect throws here and nowhere later: an unknown
 *     kind, a float, an oversized identifier. Loud, at the call site, on the
 *     first run.
 *  2. **Derive.** Severity from the condition, fingerprint from its identity,
 *     time from the injected clock, sequence from a counter. Nothing in an alert
 *     is chosen by the caller except the condition.
 *  3. **Suppress or claim, synchronously.** One block, no `await` inside it, so
 *     two concurrent raises of one fingerprint cannot both claim the slot.
 *  4. **Enter the bounded gate**, or shed loudly into the ledger.
 *  5. **Walk the chain in order.** First sink to accept ends the walk. A sink
 *     that throws, hangs, or returns something that is not an acknowledgement is
 *     a *recorded degradation*, and the walk moves to the next sink. A sink that
 *     declines a severity it does not take is *routing*, not failure.
 *  6. **Journal**, where a correlation identifier exists — after the walk, so
 *     what is recorded is what happened rather than what was intended.
 *  7. **Return an outcome.** Never throw for a delivery problem.
 *
 * ## What this module refuses to do
 *
 * **No retry.** Not once, not with backoff. The ordered chain is the redundancy:
 * a pager that is down does not become available in 200ms, and a retry loop in
 * the alerting path is a queue that grows while the thing being alerted about
 * gets worse. One attempt per sink, bounded by a deadline, then the next sink.
 *
 * **No buffering across `raise`.** There is no `flush` and no background drain,
 * so there is never work in a buffer to lose when the process dies. The cost is
 * that `raise` is awaited on the alerting path; that is the right cost, because
 * an alert still in a buffer at exit is an alert nobody ever gets.
 *
 * **No alert about the alerting, raised through the alerting.** When every sink
 * fails, the honest response is not to raise a ninth condition through the same
 * broken chain — that is an infinite regress dressed up as thoroughness. The
 * fact is *returned* to the caller, *recorded* in the journal, and *published*
 * in `health()`, which is read from outside this process by the same external
 * watcher that watches the heartbeat. See `external-watchdog.ts`.
 */

import {
  correlationOf,
  fingerprintOf,
  payloadOf,
  severityOf,
  type AlertCondition,
} from "./conditions.js";
import { AlertLimitsUnusable, AlertPayloadInvalid } from "./errors.js";
import { deliveryGate } from "./gate.js";
import type { AlertSeverity } from "./severity.js";
import { suppressionTable } from "./suppression.js";
import { asAlert } from "./types.js";
import type {
  Alert,
  AlertJournalEntry,
  AlertLimits,
  AlertOutcome,
  Alerts,
  AlertsDeps,
  AlertingHealth,
  JournalOutcome,
  SinkAck,
  SinkDegradation,
  UndeliveredEntry,
  UndeliveredReason,
} from "./types.js";
import type { AlertId, AlertSinkId, AlertTimers, DurationMs, Instant } from "./primitives.js";
import { assertKnownCondition, assertRecordablePayload } from "./validate.js";

/**
 * Bounds, defaulted. Unlike a fail policy, a bound is a statement about how much
 * memory and how much latency this module may cost — not a decision about
 * whether a decision may proceed — so a default here is a bound rather than a
 * policy somebody should have been made to confront.
 */
export const DEFAULT_LIMITS: AlertLimits = {
  /** Five minutes. Long enough to collapse a flap, short enough to stay honest. */
  suppressionWindowMs: 300_000,
  maxTrackedFingerprints: 1_024,
  maxInFlightDeliveries: 8,
  maxQueuedRaises: 256,
  deliveryTimeoutMs: 5_000,
  ledgerSize: 128,
  maxIdentifierChars: 256,
};

const LIMIT_FLOORS: Readonly<Record<keyof AlertLimits, number>> = {
  suppressionWindowMs: 0,
  maxTrackedFingerprints: 1,
  maxInFlightDeliveries: 1,
  maxQueuedRaises: 1,
  deliveryTimeoutMs: 1,
  ledgerSize: 1,
  maxIdentifierChars: 1,
};

const resolveLimits = (overrides: Partial<AlertLimits> | undefined): AlertLimits => {
  const merged: AlertLimits = { ...DEFAULT_LIMITS, ...overrides };
  for (const key of Object.keys(LIMIT_FLOORS) as (keyof AlertLimits)[]) {
    const value = merged[key];
    const floor = LIMIT_FLOORS[key];
    if (!Number.isSafeInteger(value)) {
      throw new AlertLimitsUnusable(key, value, "must be a safe integer");
    }
    if (value < floor) {
      throw new AlertLimitsUnusable(key, value, `must be at least ${floor}`);
    }
  }
  return merged;
};

type Attempt =
  | { readonly status: "ok"; readonly ack: SinkAck }
  | { readonly status: "threw"; readonly detail: string }
  | { readonly status: "timed-out" }
  | { readonly status: "contract-violated"; readonly detail: string };

/**
 * The error's **name only** reaches a degradation record — never its message and
 * never its stack.
 *
 * A transport's exception message routinely echoes the request it failed on, and
 * that request carries a correlation identifier at best and a payload at worst.
 * A degradation is recorded as a node on a seven-year trace and written to an
 * operational stream, and "no personal data in traces" is not a rule that can be
 * satisfied by hoping a third party's error text is clean. The name is enough to
 * tell a timeout from a refused connection from a type error, which is what an
 * operator is actually reading it for.
 */
const nameOf = (error: unknown): string => {
  if (error instanceof Error) return error.name === "" ? "Error" : error.name;
  return typeof error;
};

const isAck = (value: unknown): value is SinkAck =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { accepted?: unknown }).accepted === "boolean";

/** One attempt at one sink, bounded by a deadline. No retry, ever. */
const attempt = async (
  deliver: () => Promise<SinkAck>,
  timeoutMs: DurationMs,
  timers: AlertTimers,
): Promise<Attempt> => {
  let cancel: (() => void) | undefined;
  const timeout = new Promise<Attempt>((resolve) => {
    cancel = timers.deadline(timeoutMs, () => resolve({ status: "timed-out" }));
  });
  // Both branches are settled promises by the time they race, so a sink that
  // rejects AFTER losing the race cannot produce an unhandled rejection.
  const work: Promise<Attempt> = (async () => {
    try {
      const ack: unknown = await deliver();
      return isAck(ack)
        ? { status: "ok", ack }
        : { status: "contract-violated", detail: `deliver resolved with ${typeof ack}` };
    } catch (error: unknown) {
      return { status: "threw", detail: nameOf(error) };
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    cancel?.();
  }
};

export const createAlerts = (deps: AlertsDeps): Alerts => {
  const limits = resolveLimits(deps.limits);
  const sinks = deps.sinks;
  const suppression = suppressionTable(limits);
  const gate = deliveryGate(limits);

  let sequence = 0;
  let raised = 0;
  let delivered = 0;
  let suppressed = 0;
  let undelivered = 0;
  let degradationCount = 0;
  let journalFailures = 0;
  let ledgerDropped = 0;
  const ledger: UndeliveredEntry[] = [];
  const bySeverity: Record<AlertSeverity, number> = {
    notice: 0,
    degraded: 0,
    incident: 0,
    "liveness-lost": 0,
  };

  const remember = (entry: UndeliveredEntry): void => {
    ledger.unshift(entry);
    while (ledger.length > limits.ledgerSize) {
      ledger.pop();
      ledgerDropped += 1;
    }
  };

  const journalise = async (
    alert: Alert,
    deliveredBy: AlertSinkId | undefined,
    degradations: readonly SinkDegradation[],
  ): Promise<JournalOutcome> => {
    // Requirement (g): recorded as a node WHERE a correlation identifier exists.
    // Where none does — a missed heartbeat has no case — the alert has already
    // been delivered by the time we get here, and this is only the record.
    if (alert.correlationId === undefined) {
      return { journalled: false, why: "no-correlation-identifier" };
    }
    if (deps.journal === undefined) {
      return { journalled: false, why: "no-journal-configured" };
    }
    const entry: AlertJournalEntry = {
      alertId: alert.id,
      correlationId: alert.correlationId,
      at: alert.at,
      severity: alert.severity,
      condition: alert.condition.kind,
      fingerprint: alert.fingerprint,
      payload: alert.payload,
      deliveredBy,
      degradations,
      outcome: deliveredBy === undefined ? "undelivered" : "delivered",
    };
    try {
      await deps.journal.record(entry);
      return { journalled: true };
    } catch (error: unknown) {
      // A journal failure must not lose an alert that was already delivered, and
      // must not be silent. It is counted, and it is on the returned outcome.
      journalFailures += 1;
      return { journalled: false, why: "journal-failed", detail: nameOf(error) };
    }
  };

  return {
    async raise(condition: AlertCondition): Promise<AlertOutcome> {
      assertKnownCondition(condition);

      const severity = severityOf(condition);
      const fingerprint = fingerprintOf(condition);
      const payload = payloadOf(condition);
      assertRecordablePayload(payload, limits.maxIdentifierChars);

      const at: Instant = deps.clock.now();
      if (!Number.isSafeInteger(at)) {
        // A clock that reports fractional milliseconds would put a float on a
        // trace. Caught here rather than three layers down in a canonicaliser.
        throw new AlertPayloadInvalid("at", `clock returned ${at}, which is not a safe integer`);
      }

      // --- the synchronous claim. No await between decide and its consequences.
      const decision = suppression.decide(fingerprint, at);
      if (!decision.fire) {
        suppressed += 1;
        return {
          outcome: "suppressed",
          fingerprint,
          severity,
          suppressedSinceLastDelivery: decision.suppressedSinceLastDelivery,
          nextEligibleAt: decision.nextEligibleAt,
        };
      }
      sequence += 1;
      raised += 1;
      bySeverity[severity] += 1;
      const alert: Alert = asAlert({
        id: `alert_${sequence}` as AlertId,
        at,
        severity,
        condition,
        fingerprint,
        correlationId: correlationOf(condition),
        suppressedSinceLastDelivery: decision.suppressedSinceLastDelivery,
        sequence,
        payload,
      });
      // --- end of the synchronous claim.

      const degradations: SinkDegradation[] = [];

      const admitted = await gate.enter();
      if (!admitted) {
        undelivered += 1;
        remember({
          alertId: alert.id,
          at: alert.at,
          severity: alert.severity,
          condition: alert.condition.kind,
          fingerprint: alert.fingerprint,
          correlationId: alert.correlationId,
          reason: "delivery-queue-full",
          degradations,
        });
        const journal = await journalise(alert, undefined, degradations);
        return { outcome: "undelivered", alert, reason: "delivery-queue-full", degradations, journal };
      }

      let acceptedBy: AlertSinkId | undefined;
      try {
        for (const sink of sinks) {
          const result = await attempt(
            () => sink.deliver(alert),
            limits.deliveryTimeoutMs,
            deps.timers,
          );
          if (result.status === "ok") {
            if (result.ack.accepted) {
              acceptedBy = sink.id;
              break;
            }
            // Declining a severity is routing, not failure. Not a degradation.
            continue;
          }
          const degradation: SinkDegradation = {
            sink: sink.id,
            reason: result.status === "timed-out" ? "timed-out" : result.status,
            detail: result.status === "timed-out" ? `no answer in ${limits.deliveryTimeoutMs}ms` : result.detail,
            at: deps.clock.now(),
          };
          degradations.push(degradation);
          degradationCount += 1;
        }
      } finally {
        gate.leave();
      }

      if (acceptedBy !== undefined) {
        delivered += 1;
        const journal = await journalise(alert, acceptedBy, degradations);
        return { outcome: "delivered", alert, by: acceptedBy, degradations, journal };
      }

      // Nobody took it. Which of the two is true matters: a chain that FAILED is
      // an outage, a chain that DECLINED is a misconfiguration that
      // `assertProductionAlerting` would have caught at the composition root.
      const reason: UndeliveredReason =
        degradations.length > 0 ? "every-sink-failed" : "declined-by-every-sink";
      undelivered += 1;
      remember({
        alertId: alert.id,
        at: alert.at,
        severity: alert.severity,
        condition: alert.condition.kind,
        fingerprint: alert.fingerprint,
        correlationId: alert.correlationId,
        reason,
        degradations,
      });
      const journal = await journalise(alert, undefined, degradations);
      return { outcome: "undelivered", alert, reason, degradations, journal };
    },

    health(): AlertingHealth {
      return {
        raised,
        delivered,
        suppressed,
        undelivered,
        degradations: degradationCount,
        journalFailures,
        inFlight: gate.inFlight(),
        inFlightHighWater: gate.highWater(),
        queueDepth: gate.queued(),
        suppressionEvictions: suppression.evictions(),
        suppressedFingerprints: suppression.tracked(),
        suppressionRepeatsLost: suppression.lostRepeats(),
        bySeverity: { ...bySeverity },
        ledger: [...ledger],
        ledgerDropped,
      };
    },
  };
};
