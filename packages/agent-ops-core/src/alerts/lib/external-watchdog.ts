/**
 * ============================================================================
 *  THE WATCHDOG IS EXTERNAL. THIS LIBRARY IS NOT THE WATCHDOG AND CANNOT BE.
 * ============================================================================
 *
 * Read this before wiring anything in this module.
 *
 * A watchdog that depends on the thing it watches fails silently at the exact
 * moment it is needed. That is not a stylistic objection; it is the mechanism:
 *
 *   - If the process hosting the sweeper dies, an in-process liveness check dies
 *     with it. Nothing runs. Nothing throws. No dashboard turns red. Every
 *     waiting case rots, and the first person to find out is a customer with a
 *     telephone.
 *   - If the event loop is blocked, the check does not run and does not report
 *     that it did not run.
 *   - If the container is OOM-killed, the alerting chain, the journal and the
 *     ledger go with it — including the record that they went.
 *
 * So `agent-ops-core` provides the **emit** side (`createHeartbeat`), the
 * **store** (`LivenessStore`), the **verdict** (`livenessFindings`, a pure
 * function of records and an instant), and the **query** below. It does not
 * provide the watcher, and `createLivenessCheck` wired inside the process it
 * watches is a second line of defence, never the first.
 *
 * **This is the one alert this library cannot deliver itself.** Everything else
 * here — the eight silent conditions, the ordered sink chain, the suppression,
 * the ledger — is downstream of something in this process noticing. When this
 * process is what failed, only something outside it can notice, and pretending
 * otherwise would be the same class of dishonesty as a `resolution_rate`
 * computed from trace data alone.
 *
 * ## What an external watcher must do
 *
 * Poll `LivenessQuery` from **another process, on another host, on another
 * schedule** — a scheduler's own liveness alerting, a monitoring system's
 * blackbox probe, a cron on a different machine. Then:
 *
 *   1. `records()` → `livenessFindings(records, itsOwnNow, tolerance)`. Anything
 *      `overdue` or `never-seen` is a `liveness-lost` alert, which outranks
 *      every per-case alert in this library.
 *   2. `alerting()` → the `AlertingHealth` snapshot. A rising `undelivered`, a
 *      rising `degradations`, or a non-empty `ledger` means the alerting itself
 *      is failing, and the watcher is the only thing that can say so.
 *   3. **Alert if the query itself stops answering.** A watcher that only reports
 *      what the query told it has inherited the same defect one level out. No
 *      answer is the loudest answer there is.
 *
 * `docs/design/OPEN-ITEMS-RESOLVED.md` item 6 allows an application to satisfy
 * this with a scheduler it already runs and already alerts on. That is an
 * `AlertSink` adapter plus a watcher it already owns — the requirement is
 * **satisfied, not waived**. What is never acceptable is no watcher at all.
 */

import { livenessFindings } from "./heartbeat.js";
import type { Alerts, AlertingHealth, LivenessRecord, LivenessStore } from "./types.js";

/**
 * The sentence `RUNBOOK.md` is required to carry, exported so the runbook and
 * the code cannot drift apart. It is the single deployment instruction most
 * likely to be skipped and the most expensive to have skipped.
 */
export const EXTERNAL_WATCHDOG_REQUIREMENT =
  "A watcher outside this process must poll livenessQuery() and alert on overdue, never-seen, " +
  "and on the query failing to answer at all. agent-ops-core emits heartbeats and judges them; " +
  "it cannot notice its own death. Deploying without an external watcher means a stopped sweeper " +
  "stops chasing every waiting case, silently, until a customer telephones.";

/**
 * Everything an external watcher needs, and nothing it does not.
 *
 * Deliberately two plain reads with no side effects, no subscription and no
 * callback: a watcher that had to be *called back* would depend on this process
 * being alive enough to call it, which is the defect this file exists to
 * prevent. The watcher pulls; nothing pushes.
 */
export interface LivenessQuery {
  /** Every watched component and its last beat. Feed to `livenessFindings`. */
  records(): Promise<readonly LivenessRecord[]>;
  /**
   * The alerting module's own health, or `undefined` where no `Alerts` was
   * wired into the query. A watcher that gets `undefined` should treat the
   * alerting path as unobserved, not as healthy.
   */
  alerting(): AlertingHealth | undefined;
}

/**
 * Build the query an external watcher reads. Expose it over whatever this
 * application already exposes — an operational endpoint, a metrics scrape, a
 * file the scheduler reads. This module deliberately does not choose, because
 * choosing would mean this package opening a socket.
 *
 * Note the verdict is **not** included. `livenessFindings` is a pure function
 * and the watcher should apply it against **its own** clock: a component whose
 * host clock has jumped is precisely the case where asking that host whether it
 * is late gives the wrong answer.
 */
export const livenessQuery = (deps: {
  readonly store: LivenessStore;
  readonly alerts?: Alerts | undefined;
}): LivenessQuery => ({
  records: () => deps.store.snapshot(),
  alerting: () => deps.alerts?.health(),
});

/**
 * Re-exported here so a watcher written against this file has the verdict
 * function in hand without reaching for the emit side it has no business
 * calling.
 */
export { livenessFindings };
