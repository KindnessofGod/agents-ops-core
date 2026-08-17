/**
 * The two journal adapters, and the direction that decides how the second one is
 * wired.
 *
 * Requirement (g): *"Alerts are recorded into audit as nodes where a correlation
 * identifier exists. Where none exists (a missed heartbeat has no case) the
 * alert still emits."*
 *
 * Both halves are now implemented. `inMemoryAlertJournal` is the fast adapter;
 * `auditBackedAlertJournal` is the durable one and is the second real adapter
 * that makes `AlertJournal` a real seam by C5 rather than a hypothetical one.
 *
 * The second half — *the alert still emits* — is enforced in `createAlerts`
 * rather than here: the journal is written **after** the sink chain has been
 * walked, so nothing about journalling can prevent, delay or fail a delivery. A
 * journal that throws produces `journalled: false, why: "journal-failed"` on an
 * outcome that still says `delivered`.
 *
 * `AlertJournalEntry.payload` is node-shaped — flat, integer-only, versioned,
 * redaction-safe — which is what lets the audit-backed adapter merge a delivery
 * outcome into it rather than translate it.
 */

import { AlertJournalEntryUnrecordable } from "./errors.js";
import type { AlertPayload, CorrelationId, RiskTier } from "./primitives.js";
import { asAlertJournal, type AlertJournal, type AlertJournalEntry } from "./types.js";

/** What an in-memory journal kept. Bounded; drops are counted, never silent. */
export interface InMemoryAlertJournal extends AlertJournal {
  readonly entries: readonly AlertJournalEntry[];
  readonly dropped: number;
  clear(): void;
}

/**
 * The shipped adapter. A deliverable in the same sense `inMemoryTraceStore` is:
 * it is what lets a test assert that an alert about a case was recorded against
 * that case, with no database and no network anywhere in the call graph.
 */
export const inMemoryAlertJournal = (config?: {
  readonly capacity?: number;
}): InMemoryAlertJournal => {
  const capacity = config?.capacity ?? 1024;
  const kept: AlertJournalEntry[] = [];
  let dropped = 0;
  const impl = {
    record(entry: AlertJournalEntry): Promise<void> {
      kept.push(entry);
      while (kept.length > capacity) {
        kept.shift();
        dropped += 1;
      }
      return Promise.resolve();
    },
    get entries(): readonly AlertJournalEntry[] {
      return kept;
    },
    get dropped(): number {
      return dropped;
    },
    clear(): void {
      kept.length = 0;
      dropped = 0;
    },
  };
  return asAlertJournal(impl) as InMemoryAlertJournal;
};

// --- the second adapter, and why it takes a parameter rather than an import --

/**
 * ============================================================================
 *  THE AUDIT-BACKED JOURNAL. READ THE DIRECTION NOTE BEFORE CHANGING THIS.
 * ============================================================================
 *
 * Requirement (g)'s first half — *alerts are recorded into audit as nodes where
 * a correlation identifier exists* — is implemented here, and it is implemented
 * **without importing `audit`**. That is not fastidiousness; it is forced, and
 * the force is worth stating because the obvious fix is the broken one.
 *
 * `audit/lib/audit.ts` imports `alerts.raiseAndRecord`: the detecting module
 * calls the alerting module, which is the direction `index.ts` argues for at
 * length. An `import` of `audit` from here would close that into a cycle —
 * `alerts → audit → alerts` — and `npm run lint:boundaries` fails the build on
 * one. A cycle here would also be a real design fault rather than a tooling
 * irritation: it would mean neither module could be understood, tested or
 * deployed without the other, and nineteen applications would inherit an
 * alerting module that drags a seven-year archive in behind it.
 *
 * So the trace arrives as a **parameter**, and the parameter's type is declared
 * structurally in this file. `audit`'s `Audit` satisfies `AlertTraceOpener`
 * exactly, with no adapter and no cast, because the two declarations are
 * deliberately identical in the same way `Clock`, `CorrelationId` and `RiskTier`
 * already are. The composition root writes:
 *
 *     const alerting = createAlerts({
 *       sinks: [pager, stream],
 *       clock, timers,
 *       journal: auditBackedAlertJournal({ trace: audit, tier: "high" }),
 *     });
 *
 * ...and the two modules are joined at the one place that is allowed to know
 * about both.
 *
 * ## What this adapter does that a caller would otherwise do nineteen times
 *
 * It is not a pass-through, and the deletion test is the reason it exists:
 *
 *   1. **It builds the node.** The condition payload is already node-shaped, but
 *      a node that says only *what was wrong* and not *whether anybody was told*
 *      is half the evidence. This merges the delivery outcome in, using the
 *      **same field names `raiseAndRecord` writes** — `alerted`, `alertBy`,
 *      `alertSeverity`, `alertDegradations` — so a node written by a detection
 *      site and a node written by this journal read identically in 2033.
 *   2. **It refuses to overwrite.** A payload field colliding with a journal
 *      field raises `AlertJournalEntryUnrecordable` rather than silently winning,
 *      because a node that says something the condition never said is worse than
 *      a missing node.
 *   3. **It reads the result.** `record` at a degradable tier can return
 *      `recorded: false` — the store was down and the policy permitted
 *      continuing. That is **not** a journalled alert, and reporting it as one
 *      would be the exact dishonesty this library is built against. It rejects,
 *      and `createAlerts` turns the rejection into
 *      `journalled: false, why: "journal-failed"` on an outcome that still says
 *      `delivered`.
 *   4. **It is bounded.** `maxOpenTraces` caps the memoised trace handles and
 *      `maxPendingWrites` caps journal writes in flight. An alert storm across
 *      ten thousand cases must not open ten thousand traces or hold ten thousand
 *      writes; over the ceiling the journal write is shed, which costs a node
 *      and never costs an alert.
 *
 * Delete it and every one of those four reappears in nineteen composition roots,
 * where three of them will be got wrong quietly.
 *
 * ## What it deliberately does not do
 *
 * It does not open a case that does not exist in any other sense, it does not
 * close one, and it never writes a `case.`-prefixed kind — those are `audit`'s
 * reserved node kinds and forging one is `ReservedNodeKind`. It also never
 * retries: the alert has already been delivered by the time this runs, so a
 * retry would buy a second node and nothing else.
 */

/**
 * The one verb this adapter needs out of `audit`'s interface, redeclared
 * structurally so that `alerts` imports nothing. `audit`'s `Audit` is assignable
 * to this as it stands.
 */
export interface AlertTraceOpener {
  open(correlationId: CorrelationId): Promise<AlertCaseTrace>;
}

/**
 * The one verb this adapter needs out of `audit`'s `CaseTrace`.
 *
 * `record` is typed to return only what this adapter reads: whether the node was
 * written. `audit`'s richer `Recorded | Degraded` union satisfies it — both
 * members carry `recorded` — and narrowing here is what stops this module
 * growing an opinion about node identifiers, sequences or canonical bytes, none
 * of which are any of its business.
 */
export interface AlertCaseTrace {
  record(
    payload: AlertPayload,
    options: { readonly tier: RiskTier },
  ): Promise<{ readonly recorded: boolean }>;
}

export interface AuditBackedJournalDeps {
  /** `audit`'s `Audit`, passed straight in. No adapter, no cast. */
  readonly trace: AlertTraceOpener;
  /**
   * The tier the alert node is recorded at. **Required, with no default.**
   *
   * This is a decision about what happens when the archive is down while the
   * machinery is already known to be failing, and it is not one this library may
   * make for nineteen applications. At `high` the write is fail-closed: it
   * either lands or rejects, and the rejection becomes `journal-failed` on the
   * outcome. At `low` or `medium` the application's own `UnavailabilityPolicy`
   * may permit a degraded write, which this adapter then reports as not
   * journalled — never as journalled.
   */
  readonly tier: RiskTier;
  readonly limits?: Partial<AuditBackedJournalLimits> | undefined;
}

export interface AuditBackedJournalLimits {
  /** Memoised trace handles. Bounded; the oldest is evicted, never the newest. */
  readonly maxOpenTraces: number;
  /** Journal writes in flight. Over it, the node is shed and the alert is not. */
  readonly maxPendingWrites: number;
}

export const DEFAULT_AUDIT_JOURNAL_LIMITS: AuditBackedJournalLimits = {
  maxOpenTraces: 256,
  maxPendingWrites: 32,
};

/**
 * The fields this adapter adds to a condition's payload. A condition payload
 * that already owns one of these names is a collision, and a collision raises.
 */
const JOURNAL_FIELDS = [
  "alert",
  "alerted",
  "alertBy",
  "alertSeverity",
  "alertDegradations",
  "alertDegradedSink",
  "alertDegradedReason",
  "alertId",
  "alertAt",
] as const;

export const auditBackedAlertJournal = (deps: AuditBackedJournalDeps): AlertJournal => {
  const bounds: AuditBackedJournalLimits = {
    ...DEFAULT_AUDIT_JOURNAL_LIMITS,
    ...(deps.limits ?? {}),
  };
  // Insertion-ordered, so the first key is the oldest — a Map is an LRU with no
  // dependency and no cleverness.
  const open = new Map<CorrelationId, Promise<AlertCaseTrace>>();
  let pending = 0;

  const traceFor = (correlationId: CorrelationId): Promise<AlertCaseTrace> => {
    const existing = open.get(correlationId);
    if (existing !== undefined) return existing;
    const opened = deps.trace.open(correlationId);
    open.set(correlationId, opened);
    while (open.size > bounds.maxOpenTraces) {
      const oldest = open.keys().next();
      if (oldest.done === true) break;
      open.delete(oldest.value);
    }
    // A failed open must not be memoised: the next alert on this case would
    // inherit the rejection forever, which turns one outage into a permanent
    // hole in the evidence.
    return opened.catch((error: unknown) => {
      open.delete(correlationId);
      throw error;
    });
  };

  const nodeFor = (entry: AlertJournalEntry): AlertPayload => {
    for (const field of JOURNAL_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(entry.payload, field)) {
        throw new AlertJournalEntryUnrecordable(
          field,
          `the ${entry.condition} payload already carries this field; merging would replace what ` +
            `the condition said with what the journal says`,
        );
      }
    }
    const first = entry.degradations[0];
    return {
      ...entry.payload,
      alert: true,
      alerted: entry.outcome,
      alertSeverity: entry.severity,
      alertDegradations: entry.degradations.length,
      alertId: entry.alertId,
      alertAt: entry.at,
      ...(entry.deliveredBy === undefined ? {} : { alertBy: entry.deliveredBy }),
      ...(first === undefined
        ? {}
        : { alertDegradedSink: first.sink, alertDegradedReason: first.reason }),
    };
  };

  return asAlertJournal({
    async record(entry: AlertJournalEntry): Promise<void> {
      if (pending >= bounds.maxPendingWrites) {
        throw new AlertJournalEntryUnrecordable(
          "(pending)",
          `${pending} journal writes already in flight (max ${bounds.maxPendingWrites}); the ` +
            `node is shed and the alert is not`,
        );
      }
      // Built before the pending counter is held, so a collision costs nothing.
      const payload = nodeFor(entry);
      pending += 1;
      try {
        const trace = await traceFor(entry.correlationId);
        const result = await trace.record(payload, { tier: deps.tier });
        if (!result.recorded) {
          // The archive was down and the application's policy permitted
          // continuing. The alert was delivered; the node was not written.
          // Saying "journalled" here would be the one dishonesty this library
          // exists to refuse.
          throw new AlertJournalEntryUnrecordable(
            "(trace)",
            `the trace degraded the write for ${entry.correlationId}; the alert was delivered ` +
              `and no node was recorded`,
          );
        }
      } finally {
        pending -= 1;
      }
    },
  });
};
