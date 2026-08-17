/**
 * Every marked line here is expected to be a compile error. The test asserts
 * this file produces **zero** diagnostics, which — given `@ts-expect-error` — is
 * true only if each marked line errors. If a guarantee ever weakens,
 * `TS2578: Unused '@ts-expect-error' directive` fails the build.
 *
 * These are the two claims this module would otherwise be making in prose:
 *
 *   (b) *"Severity means something, and the ordering is in the type, not in a
 *       comment."*
 *   (c) *"The eight silent conditions are a closed, exhaustively-checked union,
 *       and adding a condition without handling it is a compile error."*
 *
 * Literals are kept on one line on purpose: `@ts-expect-error` suppresses the
 * line that follows it, and a multi-line literal scatters its diagnostics across
 * the property lines.
 */
import type {
  Alert,
  AlertCondition,
  AlertConditionKind,
  AlertSeverity,
  AlertSink,
  AlertJournal,
  Alerts,
  CaseSeverity,
  Clock,
  HeartbeatRun,
  LivenessOutranksEveryCaseAlert,
  LivenessStore,
  PageTransport,
  AlertTimers,
  SeverityOfKind,
  SilentConditionKind,
} from "../../index.js";
import { createAlerts, pagingAlertSink } from "../../index.js";

declare const condition: AlertCondition;
declare const clock: Clock;
declare const timers: AlertTimers;
declare const transport: PageTransport;
declare const sink: AlertSink;

/* ========================================================================== */
/* (c) EXHAUSTIVENESS                                                          */
/* ========================================================================== */

/* 1. A total table over the condition kinds cannot be missing one. This is the
      mechanism `SEVERITY_BY_CONDITION` uses: a tenth condition added to the
      union without a severity does not compile, at the table, before it is a
      gap in production. */
// prettier-ignore
// @ts-expect-error the table is missing `heartbeat-missed`
export const incomplete: Record<AlertConditionKind, AlertSeverity> = { "reserved-decision-completed-unassisted": "incident", "effect-outcome-unknown": "incident", "reminders-stopped": "degraded", "case-buried": "degraded", "authority-unavailable": "incident", "under-recording-detected": "incident", "trace-unavailable-at-high-tier": "incident", "rate-moved-sharply": "notice" };

/* 2. The complete one compiles, so the fixture proves a mechanism rather than a
      type that rejects everything. */
// prettier-ignore
export const complete: Record<AlertConditionKind, AlertSeverity> = { "reserved-decision-completed-unassisted": "incident", "effect-outcome-unknown": "incident", "reminders-stopped": "degraded", "case-buried": "degraded", "authority-unavailable": "incident", "under-recording-detected": "incident", "trace-unavailable-at-high-tier": "incident", "rate-moved-sharply": "notice", "heartbeat-missed": "liveness-lost" };

/* 3. And the switch mechanism — the one `correlationOf`, `fingerprintOf` and
      `payloadOf` each use. A branch left unhandled leaves a residual that is not
      `never`, and the assignment fails. This is what makes "adding a condition
      forces its author to answer the question" true rather than hoped for. */
export const missingABranch = (c: AlertCondition): string => {
  switch (c.kind) {
    case "reserved-decision-completed-unassisted":
    case "effect-outcome-unknown":
    case "reminders-stopped":
    case "case-buried":
    case "authority-unavailable":
    case "under-recording-detected":
    case "trace-unavailable-at-high-tier":
    case "rate-moved-sharply":
      return c.kind;
    default: {
      // @ts-expect-error `heartbeat-missed` is unhandled, so this is not `never`
      const unhandled: never = c;
      return String(unhandled);
    }
  }
};

/* 4. Handling all nine leaves `never`, and compiles. */
export const allBranches = (c: AlertCondition): string => {
  switch (c.kind) {
    case "reserved-decision-completed-unassisted":
    case "effect-outcome-unknown":
    case "reminders-stopped":
    case "case-buried":
    case "authority-unavailable":
    case "under-recording-detected":
    case "trace-unavailable-at-high-tier":
    case "rate-moved-sharply":
    case "heartbeat-missed":
      return c.kind;
    default: {
      const unhandled: never = c;
      return String(unhandled);
    }
  }
};

/* ========================================================================== */
/* (b) SEVERITY ORDERING, PROVED                                               */
/* ========================================================================== */

/* 5. The proof instantiates. `LivenessOutranksEveryCaseAlert` is `Assert<true>`,
      and it is only `true` because every per-case severity ranks strictly below
      `liveness-lost`. Reorder the severity tuple and this stops being `true`. */
export const orderingHolds: LivenessOutranksEveryCaseAlert = true;

/* 6. Which is a real assertion, not a type that accepts anything. */
// @ts-expect-error the proof is the literal `true`, not `boolean`
export const orderingIsNotABoolean: LivenessOutranksEveryCaseAlert = false;

/* 7. A missed heartbeat carries the liveness severity and NOT a per-case one. A
      caller cannot file it as a notice, because the severity is not a parameter
      — it is a function of the condition. */
declare const heartbeatSeverity: SeverityOfKind<"heartbeat-missed">;
export const isLiveness: "liveness-lost" = heartbeatSeverity;
// @ts-expect-error the liveness severity is not a per-case severity
export const isNotPerCase: CaseSeverity = heartbeatSeverity;

/* 8. And every silent condition carries a per-case severity, so none of them can
      be filed at the top. */
declare const silentSeverity: SeverityOfKind<SilentConditionKind>;
export const isPerCase: CaseSeverity = silentSeverity;
// @ts-expect-error a per-case severity is never `liveness-lost`
export const isNotLiveness: "liveness-lost" = silentSeverity;

/* ========================================================================== */
/* WHAT A CALLER CANNOT BUILD                                                  */
/* ========================================================================== */

/* 9. An `Alert` cannot be assembled. That is what keeps suppression, the ordered
      chain, the journal and the ledger on the only path an alert can take: a
      sink that could be called directly is a sink that can be called without any
      of them. */
// prettier-ignore
// @ts-expect-error an Alert has a brand no caller can name
export const forgedAlert: Alert = { id: "a" as Alert["id"], at: 0, severity: "notice", condition, fingerprint: "f" as Alert["fingerprint"], correlationId: undefined, suppressedSinceLastDelivery: 0, sequence: 1, payload: { kind: "x", v: 1 } };

/* 10. Nor an `AlertSink`. A two-line object literal is not the answer to "who is
       allowed to be a sink" — only the three adapter factories mint one. */
// prettier-ignore
// @ts-expect-error an AlertSink has a brand no caller can name
export const forgedSink: AlertSink = { id: "s" as AlertSink["id"], delivery: "page", accepts: ["notice"], deliver: () => Promise.resolve({ accepted: true }) };

/* 11. Nor a journal. An unbranded journal is a two-line object literal that
       acknowledges everything and records nothing — the fatal flaw
       `OPEN-ITEMS-RESOLVED` item 1 exists to close, one module over. */
// @ts-expect-error an AlertJournal has a brand no caller can name
export const forgedJournal: AlertJournal = { record: () => Promise.resolve() };

/* 12. Nor a liveness store, for the same reason: a store that accepts beats and
       keeps none reports perfect health forever. */
// prettier-ignore
// @ts-expect-error a LivenessStore has a brand no caller can name
export const forgedStore: LivenessStore = { watch: () => Promise.resolve(), beat: () => Promise.resolve({} as never), snapshot: () => Promise.resolve([]) };

/* ========================================================================== */
/* SHAPES THAT MUST NOT BE EXPRESSIBLE                                         */
/* ========================================================================== */

/* 13. "I did nothing" cannot be spelled as "I did zero things". The empty branch
       has no `itemsProcessed` field at all, so an idle run and a batch of zero
       stay different values. */
// @ts-expect-error `nothing-was-due` carries no item count
export const zeroItems: HeartbeatRun = { ran: "nothing-was-due", itemsProcessed: 0 };

/* 14. A chain with no sinks is not a degraded alerting system; it is no alerting
       system, and it is not constructible. */
// @ts-expect-error `sinks` is NonEmpty
export const emptyChain: Alerts = createAlerts({ sinks: [], clock, timers });

/* 15. An alert is addressed to an operator rota, never to a business authority.
       This is the escalation/alert separation made structural: an identifier
       from the approval side does not typecheck here, so the two audiences
       cannot be crossed by reaching for whatever identifier is in scope. */
// prettier-ignore
// @ts-expect-error a bare string is not an OperatorRotaId
export const authorityAsRota: AlertSink = pagingAlertSink({ id: "s" as AlertSink["id"], rota: "auth_jane", transport });

/* 16. Severity is not an argument. There is nothing to get wrong at 4pm on a
       Friday. */
declare const alerts: Alerts;
// @ts-expect-error raise takes a condition and nothing else
export const suppliedSeverity = alerts.raise(condition, "notice");

/* 17. A sink is accepted where a sink is wanted, so the fixture is not simply
       rejecting everything it is shown. */
export const realChain: Alerts = createAlerts({ sinks: [sink], clock, timers });
