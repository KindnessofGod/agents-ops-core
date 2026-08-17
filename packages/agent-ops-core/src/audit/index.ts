/**
 * audit — the append-only decision trace, replayable by correlation identifier.
 *
 * This is the foundation module: the other three record into it and none of
 * them are meaningful without it. It is built first for that reason.
 *
 * The interface is three verbs — `open`, `record`, `replay` — plus `close`.
 * Everything else a caller must know is an invariant:
 *
 *   Append-only.      There is no `update`, no `delete` and no `amend`, here or
 *                     in the database grants. Re-judging a case appends a new
 *                     node; it never edits an old one.
 *   Store-assigned.   Sequence numbers come from the store, never the caller.
 *                     A caller-assigned sequence is a caller-assigned lie under
 *                     concurrency.
 *   A graph.          Every node may name a parent, so a case's execution is a
 *                     directed acyclic graph and not a list. Replay reproduces
 *                     the graph, not just the final answer.
 *   Injected clock.   No `Date.now()` inside this module, ever. That is what
 *                     makes ageing testable without waiting.
 *   Terminal close.   Recording after `close` is an error, not a no-op.
 *
 * See `docs/CONTEXT.md` for the vocabulary and
 * `docs/design/OPEN-ITEMS-RESOLVED.md` for the decisions behind the shape.
 */

export type { Clock } from "./lib/clock.js";
export type {
  CorrelationId,
  NodeId,
  NodePayload,
  RecordedNode,
  ReplayedCase,
  Containment,
  CaseTrace,
  TraceStore,
  Audit,
} from "./lib/types.js";

export { createAudit } from "./lib/audit.js";
export { inMemoryTraceStore } from "./lib/in-memory-store.js";
export { NoSuchCase, CaseAlreadyClosed } from "./lib/errors.js";
