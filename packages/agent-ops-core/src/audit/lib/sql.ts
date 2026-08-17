/**
 * The driver-injection point.
 *
 * This package may not import a database driver — `CLAUDE.md` requires an ADR
 * for every dependency nineteen applications inherit, and the hermetic-test rule
 * requires that no code path in this package can open a socket, in shipped code
 * or in test. So the pool arrives as a parameter. Each composition root already
 * has one; wiring `pg`'s `Pool` to this interface is about fifteen lines.
 *
 * It lives in its own file rather than inside `postgres-store.ts` because three
 * things now take one — the trace store, the witness and the retention register
 * — and each of them is wired to a **different role** with different grants. A
 * shared type in a shared file makes that arrangement legible; one exported from
 * the trace store would suggest the trace store's pool is the one to pass, which
 * is precisely the mistake the witness exists to prevent.
 *
 * ## Not a seam, and the accounting has not changed
 *
 * `C5`: one adapter is a hypothetical seam, two is a real one. There is exactly
 * one shape here, no behaviour variation is wanted, and no second adapter is
 * named because none is intended. Shipping one would mean taking a driver
 * dependency. What this interface has instead of a second adapter is a
 * **contract suite** — see `lib/contract.ts` — so an implementation can be held
 * to its obligations without this package ever meeting a driver.
 */

export interface SqlRow {
  readonly [column: string]: unknown;
}

/**
 * The obligations, in full, so an implementer can satisfy them from this comment
 * alone. `sqlExecutorContract` in `lib/contract.ts` checks every one of them.
 *
 *   1. **Parameters are bound, never interpolated.** `$1..$n` are passed to the
 *      driver as values. A correlation identifier is caller data and must never
 *      become SQL.
 *   2. **`transaction` runs the whole callback on one connection.** Work done by
 *      an earlier statement is visible to a later one inside the same callback.
 *      Handing each statement a different pooled connection breaks the per-case
 *      advisory lock, which is then taken and released around a single
 *      statement instead of held for the transaction.
 *   3. **`transaction` commits when the callback resolves and rolls back when it
 *      rejects**, and **rethrows the original error** rather than one of its
 *      own. The trace store classifies failures by SQLSTATE; an error wrapped in
 *      a fresh `Error` loses `code` and gets read as an outage rather than as
 *      the integrity violation it was.
 *   4. **A statement the database refuses rejects.** It never resolves with an
 *      empty row set. "The write did not happen" and "the write happened and
 *      returned nothing" are the two answers this module must not confuse.
 *   5. **`rows` is always an array**, empty rather than absent when a statement
 *      returns nothing.
 *   6. **Concurrent transactions do not share a connection.** Two transactions
 *      in flight must not see each other's uncommitted work.
 */
export interface SqlExecutor {
  query(
    text: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: readonly SqlRow[] }>;
  /** Runs `fn` on one connection inside a transaction, rolling back on throw. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
