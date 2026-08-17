// agent-ops-core — public entry point.
//
// Four modules survive interface review: audit, approval, evals, guardrails.
// See docs/design/PHASE-2-INTERFACE-REVIEW.md for why, and FINDINGS.md for the
// interface each one took.
//
// `audit` is the foundation — the other three record into it and none of them
// are meaningful without it — so it is built first and is the only one exported
// so far. Re-exporting a module before it exists would be the exact mistake
// this project is trying to avoid.

export {
  createAudit,
  inMemoryTraceStore,
  NoSuchCase,
  CaseAlreadyClosed,
} from "./audit/index.js";

export type {
  Audit,
  CaseTrace,
  Clock,
  CorrelationId,
  NodeId,
  NodePayload,
  RecordedNode,
  ReplayedCase,
  TraceStore,
  // `docs/CONTEXT.md` rule 4: bare `containment` is not a valid identifier
  // anywhere, so the exported type carries the qualifier the field always did.
  UnassistedContainment,
} from "./audit/index.js";
