import { StoreNotMinted } from "./errors.js";
import type { EvalNodeStore, EvalNodeStoreMethods } from "./types.js";

/**
 * The runtime half of the `EvalNodeStore` brand.
 *
 * `EvalNodeStore` carries a non-exported `unique symbol` declared in `types.ts`,
 * so a hand-rolled store does not typecheck. This is what happens when someone
 * defeats that with `as`: a module-private `WeakSet` that only the two shipped
 * adapter constructors populate, checked once by `createEvalRecorder` — before
 * a run opens, before any node is written, before a report can exist.
 *
 * The check is at construction rather than per call on purpose. A store that
 * passes at `createEvalRecorder` and lies afterwards is the same object; there
 * is nothing a per-call check would catch that this does not, and a per-call
 * check on the hot path of 10M nodes a day is a cost with no return.
 */
const minted = new WeakSet<object>();

export const mintEvalNodeStore = (impl: EvalNodeStoreMethods): EvalNodeStore => {
  const store = impl as EvalNodeStore;
  minted.add(store);
  return store;
};

export const assertMintedStore = (store: EvalNodeStore): EvalNodeStore => {
  if (typeof store !== "object" || store === null || !minted.has(store)) {
    throw new StoreNotMinted();
  }
  return store;
};
