/**
 * The private slot a minted `Screening` carries its own settled `RecordedNode`
 * in.
 *
 * A runtime symbol, declared here so `types.ts` can put it on the `Screening`
 * interface and `guardrails.ts` can read it. It is **not** exported from
 * `index.ts` and `lib/` is private to dependency-cruiser, so no caller can name
 * it: a `Screening` is no more constructible for its presence, and the slot is
 * unreadable outside this module.
 *
 * Why it exists. `audit.record` takes a parent as a `RecordedNode`, not a
 * `NodeId`. `checkOutput` parents its screening to `after.nodes.settled`, which
 * belongs to a recorder that no longer exists — so every `checkOutput` used to
 * replay the whole case to turn that identifier back into a node. That read is
 * linear in the nodes already recorded, it sits on the hot path before every
 * effect, and it grows for the life of a case. Carrying the node itself removes
 * it entirely.
 *
 * Flagged upward, as `recorder.ts` already does:
 * `record(payload, { parent: RecordedNode | NodeId })` on `audit` would make
 * this slot unnecessary. That is `audit`'s interface to change.
 */
export const SETTLED_NODE: unique symbol = Symbol("guardrails.settled-node");
