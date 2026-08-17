/**
 * The driver-injection point for this module.
 *
 * ## Why this type is declared here and not imported from `audit`
 *
 * `audit` declares a structurally identical `SqlExecutor`, and one composition
 * root hands the *same* object to both. It is redeclared rather than imported
 * for the same reason `Clock`, `CorrelationId` and `RiskTier` are: `alerts`
 * imports no other module. Reverse that and the dependency runs
 * `alerts → audit`, while `audit` already imports `alerts.raiseAndRecord` — a
 * cycle, which `npm run lint:boundaries` fails on, and which would be a genuine
 * design smell rather than a tooling irritation. Structural identity is what
 * makes the redeclaration free at the call site: no adapter, no cast.
 *
 * ## No driver is imported, in shipped code or in test
 *
 * This package may not take a database dependency nineteen applications
 * inherit, and the hermetic-test rule requires that no code path here can open
 * a socket. Both are satisfied by the same fact: the pool arrives as a
 * parameter. There is nothing to disable and therefore no flag to be trusted.
 *
 * ## Not a seam, and the accounting has not moved
 *
 * C5: one adapter is a hypothetical seam, two is a real one. There is exactly
 * one shape here, no behaviour variation is wanted, and no second adapter is
 * intended — shipping one would mean taking a driver dependency. What this
 * interface has instead of a second adapter is a **contract**, stated in full
 * below and checked by `audit`'s `sqlExecutorContract`, which is the same
 * contract: an executor that satisfies one satisfies the other, deliberately,
 * so a composition root writes its fifteen lines once.
 */

export interface SqlRow {
  readonly [column: string]: unknown;
}

/**
 * The obligations, in full, so an implementer can satisfy them from this
 * comment alone.
 *
 *   1. **Parameters are bound, never interpolated.** `$1..$n` are passed to the
 *      driver as values. A component identifier is caller data and must never
 *      become SQL.
 *   2. **`transaction` runs the whole callback on one connection**, commits
 *      when it resolves, rolls back when it rejects, and **rethrows the
 *      original error** rather than one of its own.
 *   3. **A statement the database refuses rejects.** It never resolves with an
 *      empty row set. "The write did not happen" and "the write happened and
 *      returned nothing" are the two answers this module must not confuse —
 *      `beat` distinguishes an unwatched component from a stored beat by
 *      exactly that difference.
 *   4. **`rows` is always an array**, empty rather than absent.
 *   5. **Concurrent transactions do not share a connection.**
 *
 * `postgresLivenessStore` issues no multi-statement transaction — every verb it
 * has is one statement — so obligations 2 and 5 are unused by this module and
 * stated anyway, because the object passed in is the same one `audit` uses and
 * a reader of this file should not have to guess whether the halves agree.
 */
export interface SqlExecutor {
  query(text: string, params: readonly unknown[]): Promise<{ readonly rows: readonly SqlRow[] }>;
  /** Runs `fn` on one connection inside a transaction, rolling back on throw. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
