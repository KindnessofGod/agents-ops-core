import { LedgerNotMinted } from "./errors.js";
import type { RunLedger, RunLedgerMethods } from "./types.js";

/**
 * The runtime half of the `RunLedger` brand, and the exact sibling of
 * `store-brand.ts`.
 *
 * `RunLedger` carries a non-exported `unique symbol` declared in `types.ts`, so
 * a hand-rolled ledger does not typecheck. This is what happens when someone
 * defeats that with `as`: a module-private `WeakSet` that only the two shipped
 * adapter constructors populate, checked once by `createEvalRecorder` — before a
 * run opens, before any node is written, before a report can exist.
 *
 * It matters more here than it does for the store, and that is worth stating.
 * A forged store makes a run report success while writing nothing. A forged
 * **ledger** makes `run` return a green report **without executing anything at
 * all** — no subject call, no scorer, no model, no node. It is the cheapest
 * possible way to make a build pass, and unlike a deleted golden case it leaves
 * no diff.
 */
const minted = new WeakSet<object>();

export const mintRunLedger = (impl: RunLedgerMethods): RunLedger => {
  const ledger = impl as RunLedger;
  minted.add(ledger);
  return ledger;
};

export const assertMintedLedger = (ledger: RunLedger): RunLedger => {
  if (typeof ledger !== "object" || ledger === null || !minted.has(ledger)) {
    throw new LedgerNotMinted();
  }
  return ledger;
};
