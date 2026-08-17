import type { Clock } from "./clock.js";

/** Ties every node belonging to one case together. Assigned by the application. */
export type CorrelationId = string & { readonly __brand: "CorrelationId" };

/** Identity of one recorded node, assigned by this module. */
export type NodeId = string & { readonly __brand: "NodeId" };

/**
 * What happened at a node. Discriminated on `kind` so the closed set of node
 * kinds grows deliberately rather than by accident.
 *
 * Payloads carry integers only — cost in tenth-cents, latency in micros. No
 * IEEE-754 anywhere, because byte-stable serialisation is what makes replay
 * possible and floats are how byte-stability dies quietly.
 */
export interface NodePayload {
  readonly kind: string;
  readonly [field: string]: string | number | boolean | null | undefined;
}

/**
 * A node the store has accepted. `sequence` and `at` are assigned by the
 * module, never supplied by the caller.
 */
export interface RecordedNode {
  readonly id: NodeId;
  readonly correlationId: CorrelationId;
  /** Total order within one case. Assigned by the store. */
  readonly sequence: number;
  /** Milliseconds since epoch, from the injected clock. */
  readonly at: number;
  /** Absent for a root node. Present for every derived one. */
  readonly parent?: NodeId;
  readonly payload: NodePayload;
}

/**
 * How a case finished.
 *
 * `unassistedContainment` is the full two-word term deliberately — bare
 * `containment` is a lint failure, because the qualifier is what stops it being
 * read as a quality score. It carries no target in this library; it is
 * recorded, never optimised.
 *
 * Note what is absent: there is no `success` field and no `resolution` field.
 * Resolution is not knowable at close and requires a named evidence source and
 * window, so it cannot be written here.
 */
export interface Containment {
  readonly unassistedContainment: boolean;
}

/** The replayed graph. */
export interface ReplayedCase {
  readonly correlationId: CorrelationId;
  /** Every node, in recorded order. */
  readonly nodes: readonly RecordedNode[];
  /** Nodes with no parent. */
  roots(): readonly RecordedNode[];
  /** Direct children of a node, in recorded order. */
  childrenOf(id: NodeId): readonly RecordedNode[];
}

/**
 * An open case. Note the verbs that are absent: no update, no delete, no
 * amend. The guarantee is the shape of this interface, and the database grants
 * carry the other half of it.
 */
export interface CaseTrace {
  readonly correlationId: CorrelationId;
  record(payload: NodePayload, parent?: RecordedNode): Promise<RecordedNode>;
  close(outcome: Containment): Promise<void>;
}

/**
 * The seam. Two adapters, both shipped: Postgres and in-memory. The in-memory
 * adapter is a deliverable rather than a mock — it is what makes hermetic tests
 * structural — and it is the second adapter that makes this a real seam rather
 * than a hypothetical one.
 */
export interface TraceStore {
  openCase(correlationId: CorrelationId, at: number): Promise<void>;
  append(
    correlationId: CorrelationId,
    at: number,
    payload: NodePayload,
    parent: NodeId | undefined,
  ): Promise<RecordedNode>;
  closeCase(
    correlationId: CorrelationId,
    at: number,
    outcome: Containment,
  ): Promise<void>;
  isClosed(correlationId: CorrelationId): Promise<boolean>;
  read(correlationId: CorrelationId): Promise<readonly RecordedNode[] | undefined>;
}

export interface AuditDeps {
  readonly store: TraceStore;
  readonly clock: Clock;
}

export interface Audit {
  open(correlationId: CorrelationId): Promise<CaseTrace>;
  replay(correlationId: CorrelationId): Promise<ReplayedCase>;
}
