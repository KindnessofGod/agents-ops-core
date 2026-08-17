/**
 * The journal adapter that ships, and an honest note about the one that does not.
 *
 * Requirement (g): *"Alerts are recorded into audit as nodes where a correlation
 * identifier exists. Where none exists (a missed heartbeat has no case) the
 * alert still emits."*
 *
 * The first half is a composition-root job, not a job for this module. An
 * `audit`-backed journal is four lines — open the case's trace, `record` the
 * payload, done — and those four lines belong where the two modules are wired
 * together, because a module that imports another module's store to satisfy its
 * own requirement has taken a dependency nineteen applications inherit whether
 * they wanted it or not.
 *
 * So: `AlertJournalEntry.payload` is already node-shaped — flat, integer-only,
 * versioned, redaction-safe — and the adapter that writes it to `audit` is
 * **named and not built here**. That is the same standard `approval` applied to
 * `postgresApprovalStore`, and it is the standard C5 requires: one shipped
 * adapter is a hypothetical seam, and calling a test fixture the second adapter
 * would be counting a mock.
 *
 * The second half — *the alert still emits* — is enforced in `createAlerts`
 * rather than here: the journal is written **after** the sink chain has been
 * walked, so nothing about journalling can prevent, delay or fail a delivery.
 * A journal that throws produces `journalled: false, why: "journal-failed"` on
 * an outcome that still says `delivered`.
 */

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
