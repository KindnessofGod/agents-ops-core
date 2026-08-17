import type { Clock } from "./clock.js";

/** Ties every node belonging to one case together. Assigned by the application. */
export type CorrelationId = string & { readonly __brand: "CorrelationId" };

/** Identity of one recorded node, assigned by this module. */
export type NodeId = string & { readonly __brand: "NodeId" };

/** A content digest over a trace. Carries its own version and algorithm inline. */
export type TraceDigest = string & { readonly __brand: "TraceDigest" };

/** Names the redactor that ran before write, stamped onto every node. */
export type RedactionId = string & { readonly __brand: "RedactionId" };

/**
 * The consequence of being wrong, classified before the work runs.
 *
 * Per `docs/design/OPEN-ITEMS-RESOLVED.md` item 5, tier attaches to a
 * decision-and-its-effect rather than to a case, so a case has a tier profile.
 * That is why the tier is supplied at `record` and stamped on the node: the
 * profile is then readable straight off the trace instead of reconstructed.
 *
 * Tier is consequence; confidence is likelihood. They are never multiplied.
 */
export type RiskTier = "low" | "medium" | "high";

/**
 * The only value types a payload field may hold.
 *
 * Integers only. No IEEE-754 anywhere, because byte-stable serialisation is
 * what makes replay possible and floats are how byte-stability dies quietly.
 * Cost in tenth-cents, latency in micros, scores in basis points.
 *
 * Payloads are deliberately **flat**. Nesting would need canonical rules for
 * array order and for key collision across levels, and every one of those rules
 * is a place a 2033 reader can be misled. A caller who needs structure flattens
 * it with dotted keys, which survives seven years unambiguously.
 *
 * **A flattened key is a payload field like any other, and personal data hides
 * in field names.** `redactAllExcept` therefore redacts the key as well as the
 * value for anything outside its allow list; `redactFields` does not, because a
 * deny list is for a field set the caller owns and can enumerate. Choosing
 * between them is choosing between those two behaviours, not only between two
 * lists.
 */
export type PayloadField = string | number | boolean | null;

/**
 * What happened at a node. Discriminated on `kind` so the set of node kinds
 * grows deliberately rather than by accident.
 *
 * `v` is the **payload** schema version and is required, not defaulted. A
 * default would let two incompatible shapes both be written as version 1 by a
 * caller who changed the fields and forgot — which is precisely the quiet
 * failure the version exists to prevent. The envelope around the payload
 * carries its own separate version, owned by this library.
 *
 * `kind` values beginning `case.` are reserved to this library. Writing one is
 * `ReservedNodeKind`, not a silently-accepted forgery of a terminal node.
 */
export interface NodePayload {
  readonly kind: string;
  /** Payload schema version. Bump whenever the field set or a meaning changes. */
  readonly v: number;
  readonly [field: string]: PayloadField | undefined;
}

/**
 * Cost, tokens, latency and the price table that priced them — the one
 * surviving requirement of the cut `telemetry` module, per `BRIEF.md` C2.
 *
 * It is a **typed field of the node**, not a convention about payload keys.
 * That is the whole point: nineteen applications each inventing `tokensIn`,
 * `input_tokens` and `promptTokens` in a free-form payload produces a trace
 * from which no cross-application cost report is derivable, which is the same
 * as not recording it.
 *
 * Integers only, in the units the rest of the module uses: cost in tenth-cents,
 * latency in micros. `priceTableVersion` is a string because a cost is
 * uninterpretable without knowing what priced it — a figure from a table nobody
 * can name is not evidence, and in 2033 the table itself may be gone.
 *
 * Optional per node, because most nodes are not model calls: a tier
 * classification costs nothing and consumes no tokens, and recording four
 * zeroes there would make "we spent nothing" indistinguishable from "we did not
 * measure". Where it is present, all five fields are present.
 */
export interface NodeTelemetry {
  /** Tenth-cents. Integer. */
  readonly costTenthCents: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Microseconds. Integer. */
  readonly latencyMicros: number;
  /** Names the table that turned tokens into money. */
  readonly priceTableVersion: string;
}

/**
 * A node the store has accepted. Everything here except `payload`, `tier` and
 * `telemetry` is assigned by the module or the store, never by the caller.
 */
export interface RecordedNode {
  readonly id: NodeId;
  readonly correlationId: CorrelationId;
  /** Total order within one case. Assigned by the store, never the caller. */
  readonly sequence: number;
  /** Milliseconds since epoch, from the injected clock. */
  readonly at: number;
  /** The tier this node ran under. Part of the case's tier profile. */
  readonly tier: RiskTier;
  /** Absent for a root node. Present for every derived one. */
  readonly parent?: NodeId;
  /** Copied from `payload.v` so the stored artefact states it without parsing. */
  readonly payloadSchemaVersion: number;
  /** Which redactor ran before this was written. */
  readonly redaction: RedactionId;
  /** Redacted. The raw payload never reaches a store. */
  readonly payload: NodePayload;
  /** Absent where the node measured nothing. See `NodeTelemetry`. */
  readonly telemetry?: NodeTelemetry;
  /**
   * The exact bytes this node canonicalises to, computed by the store once the
   * sequence exists. Stored alongside the columns rather than derived from them
   * so that a row edited in place disagrees with itself and is detectable.
   *
   * The bytes name their own envelope version, which is what makes a node
   * written today readable by a release that has since moved on: replay
   * canonicalises each node under *its* envelope, never under the current one.
   */
  readonly canonical: string;
}

/**
 * How a case finished.
 *
 * The type is `UnassistedContainment` and the field is
 * `unassistedContainment` — the full two-word term in both, deliberately.
 * `docs/CONTEXT.md` rule 4 is unambiguous: bare `containment` is not a valid
 * identifier anywhere in the codebase, and a type name spreads further than a
 * field name because it is in the signature nineteen callers must learn. The
 * qualifier is what stops it being read as a quality score. It carries no
 * target in this library; it is recorded, never optimised.
 *
 * Note what is absent: there is no `success` field and no `resolution` field.
 * Resolution is not knowable at close and requires a named evidence source and
 * window, so it cannot be written here.
 */
export interface UnassistedContainment {
  readonly unassistedContainment: boolean;
}

/**
 * What the trace's evidence actually covers, stamped onto the case at open.
 *
 * This is the honest scope statement. `capturedVia` says the library captured
 * everything that went through the injected store and makes no claim about
 * work an application did out of band. A reader in 2033 learns the limits of
 * the evidence from the evidence, not from a wiki that no longer exists.
 *
 * All four fields are copied into the seal node's payload at close, so on a
 * closed case they sit inside the digest chain and a scope statement rewritten
 * after export no longer verifies. On an **open** case they are outside every
 * integrity check, and that is a real gap rather than a hidden one: an open
 * case has no seal to witness anything.
 */
export interface TraceProvenance {
  readonly capturedVia: "injected-trace-store-only";
  /**
   * Which canonical envelope was current when the case was opened. Nodes carry
   * their own envelope in their own bytes and may differ from this after a
   * release; this field is the case's starting point, not a claim about every
   * node under it.
   */
  readonly canonicalForm: string;
  /**
   * Which redactor ran before every write on this case. Enforced: reopening a
   * case under a different redactor raises `ProvenanceConflict` rather than
   * leaving this sentence quietly false about half the nodes.
   */
  readonly redaction: RedactionId;
  readonly openedAt: number;
}

/** What a store hands back. Provenance travels with the nodes, never apart. */
export interface StoredCase {
  readonly provenance: TraceProvenance;
  /** In store-assigned sequence order. */
  readonly nodes: readonly StoredNode[];
}

/**
 * A node as the store holds it: the recorded node plus the canonical bytes the
 * store persisted at write time. Replay recomputes the bytes and compares.
 */
export type StoredNode = RecordedNode;

/**
 * The replayed graph.
 *
 * **Bounded, and materialised on purpose.** `nodes` is a real array, so a case
 * costs its own node count in memory to replay and nothing more; the ceiling is
 * the store's `maxNodesPerCase`, which is why that limit is part of this
 * module's interface rather than an implementation detail. `roots` and
 * `childrenOf` are answered from an index built once during replay, so walking
 * the graph is linear rather than quadratic, and `digest` is computed at most
 * once however many times it is asked for.
 */
export interface ReplayedCase {
  readonly correlationId: CorrelationId;
  readonly provenance: TraceProvenance;
  /** Every node, in store-assigned sequence order. */
  readonly nodes: readonly RecordedNode[];
  /** True once a seal node has been appended. Derived, never a mutable flag. */
  readonly closed: boolean;
  /** Nodes with no parent. */
  roots(): readonly RecordedNode[];
  /** Direct children of a node, in recorded order. */
  childrenOf(id: NodeId): readonly RecordedNode[];
  /** Content digest over the whole trace, in sequence order. */
  digest(): TraceDigest;
  /**
   * True when the trace still hashes to a digest recorded elsewhere. The
   * version is read out of `expected` rather than assumed, so a digest
   * witnessed under an older construction stays checkable after a bump.
   */
  verify(expected: TraceDigest): boolean;
}

/** A node that was written. */
export interface Recorded {
  readonly recorded: true;
  readonly node: RecordedNode;
}

/**
 * A node that was **not** written, because the store was unavailable and the
 * configured policy for this tier permits the caller to continue.
 *
 * There is no `node` here, deliberately. A caller that wants to parent
 * something to this cannot, because nothing was recorded to parent to.
 *
 * **The honest gap.** A degraded result is *not itself recorded anywhere*, and
 * cannot be: the store that would hold the record is the thing that is down.
 * The caller receives the fact and owes it somewhere out of band — a metric, an
 * alert, a local spool. This library will not pretend to have written it. A
 * medium- or low-tier trace with a gap in it is therefore possible by
 * construction whenever the policy permits degrading, which is the price of
 * permitting it, and is why the type makes the caller look at the result rather
 * than letting the gap pass as success.
 *
 * Only `TraceUnavailable` reaches here. A caller defect, an adapter defect or a
 * corrupt row throws at every tier — see `AuditError.degradable`.
 */
export interface Degraded {
  readonly recorded: false;
  readonly reason: TraceUnavailableReason;
  readonly at: number;
  /** High tier can never appear here — the policy type forbids it. */
  readonly tier: Exclude<RiskTier, "high">;
}

/**
 * At high tier `record` cannot return a degraded result, so "the decision
 * proceeded without a trace" is not a value the caller can hold.
 */
export type RecordResult<T extends RiskTier> = T extends "high"
  ? Recorded
  : Recorded | Degraded;

export interface RecordOptions<T extends RiskTier> {
  readonly tier: T;
  /**
   * Must be a node of **this** case. A parent from another correlation
   * identifier raises `ParentNotOfThisCase` before either adapter sees it.
   */
  readonly parent?: RecordedNode;
  /** Present where this node measured a model call. See `NodeTelemetry`. */
  readonly telemetry?: NodeTelemetry;
}

/** Why the store could not take a write. Every value is a named error mode. */
export type TraceUnavailableReason =
  /** The store adapter itself failed — connection, timeout, driver fault. */
  | "store-failure"
  /** The bounded write queue is full. Shed rather than grow without limit. */
  | "backpressure"
  /** The case has hit its bounded node ceiling, or the store its case ceiling. */
  | "capacity";

export type FailPolicy = "fail-closed" | "degrade";

/**
 * Required configuration. There is **no default**, because a default here is a
 * decision about whether a £2M disbursement may proceed unrecorded, and that
 * decision belongs to the application that will answer for it.
 *
 * `high` is pinned to `"fail-closed"` in the type. It is still required, so a
 * reader of the composition root confronts it, but no configuration change can
 * make a high-tier decision proceed without a trace. This is the same doctrine
 * as reserved decisions: structural, never a setting somebody edits at 4pm on
 * a Friday chasing a throughput target.
 */
export interface UnavailabilityPolicy {
  readonly high: "fail-closed";
  readonly medium: FailPolicy;
  readonly low: FailPolicy;
}

/**
 * Resource ceilings this module enforces itself, above whichever store it is
 * given. Defaulted rather than required: unlike the fail policy, these decide
 * how much memory one node may cost, not whether a decision may proceed
 * unrecorded, so a default here is a bound rather than a policy.
 */
export interface AuditLimits {
  /**
   * Ceiling on the canonical bytes of one payload. `maxNodesPerCase` bounds the
   * count of nodes; without this the real bound would be that count multiplied
   * by an unbounded payload.
   */
  readonly maxPayloadBytes: number;
}

/**
 * Applied before write. There is no un-writing personal data, so this runs in
 * `audit` itself and no store adapter ever receives the original payload.
 *
 * `apply` sees keys as well as values, and a redactor is entitled to rewrite
 * both — a flattened key can carry a name or a national insurance number as
 * readily as a value can. It may not touch `kind` or `v`.
 */
export interface Redactor {
  /** Stamped onto every node, so what was stripped is knowable years later. */
  readonly id: RedactionId;
  apply(payload: NodePayload): NodePayload;
}

/** Everything a store needs to append one node. Redaction has already run. */
export interface AppendInput {
  readonly correlationId: CorrelationId;
  readonly at: number;
  readonly tier: RiskTier;
  /** Already redacted. */
  readonly payload: NodePayload;
  readonly redaction: RedactionId;
  readonly parent: NodeId | undefined;
  readonly telemetry: NodeTelemetry | undefined;
}

/**
 * The brand on `TraceStore`.
 *
 * `declare const` means it exists only in the type system: no runtime value, no
 * cost, and — critically — no name a caller outside this module can write.
 * `index.ts` does not export it, `lib/` is private to dependency-cruiser, so a
 * structural impostor supplied as `{ append: async n => ({ ...n, sequence: 0 }) }`
 * does not typecheck. That is fatal flaw 2 of `evals/common-case`, resolved in
 * `docs/design/OPEN-ITEMS-RESOLVED.md` item 1, finally implemented.
 *
 * **The limit of the brand, stated exactly.** Two things still get through and
 * both are covered elsewhere rather than pretended away:
 *
 *   1. `as unknown as TraceStore` compiles in any TypeScript. So does spreading
 *      a real store into a decorator, which copies the brand along with the
 *      methods — and that is deliberate, because a delegating wrapper is a
 *      legitimate thing to build. Both are caught at runtime instead:
 *      `createAudit` checks every acknowledgement against the node it asked to
 *      be written, including the store-assigned sequence and the canonical
 *      bytes, and raises `StoreContractViolated`.
 *   2. Neither the brand nor the check proves a row reached a disk. A store
 *      that computes the correct bytes and then discards them is
 *      indistinguishable from one that writes, until you replay. **Replay is
 *      the proof of a write**; acknowledgement is the proof of a correctly
 *      formed node. The artefact says as much: `capturedVia` is stamped on
 *      every case rather than a stronger claim being asserted in prose.
 */
declare const traceStoreBrand: unique symbol;

/**
 * The seam. Two adapters, both shipped: Postgres and in-memory. The in-memory
 * adapter is a deliverable rather than a mock — it is what makes hermetic tests
 * structural — and it is the second adapter that makes this a real seam rather
 * than a hypothetical one.
 *
 * Every adapter owes the same six invariants. They are no longer a wish list in
 * a comment: `createAudit` verifies 1, 5 and 6 on every acknowledgement, and
 * both shipped adapters are tested against 2, 3 and 4 through this interface.
 *
 *   1. The **store** assigns the sequence, atomically, correct under concurrent
 *      writers to one case, and never issues the same one twice.
 *   2. Append and close are checked against closure inside the same critical
 *      section that writes. A check outside it is a race, not a check.
 *   3. `closeCase` seals: it computes the digest over everything already
 *      recorded and appends that as the terminal node, atomically.
 *   4. No verb mutates or removes a node. There is no update, no delete, no
 *      amend — here, or in the database grants.
 *   5. A parent is a node of **this** case. An identifier from another
 *      correlation identifier is refused, not silently rebound.
 *   6. `case.`-prefixed kinds are reserved to the library. An `append` carrying
 *      one is refused; only `closeCase` may write the seal.
 */
export interface TraceStore {
  readonly [traceStoreBrand]: true;
  /**
   * Idempotent on an identical scope statement; raises `ProvenanceConflict` on
   * a contradictory one. Writes the case-level provenance once.
   */
  openCase(correlationId: CorrelationId, provenance: TraceProvenance): Promise<void>;
  append(input: AppendInput): Promise<RecordedNode>;
  /** Atomic seal-and-close. Returns the terminal seal node. */
  closeCase(
    correlationId: CorrelationId,
    at: number,
    outcome: UnassistedContainment,
  ): Promise<RecordedNode>;
  read(correlationId: CorrelationId): Promise<StoredCase | undefined>;
}

/**
 * Mints the brand. Called in exactly two places — the two shipped adapter
 * factories — and nowhere else. It is the only cast in the module that widens
 * a type, and it is here rather than smeared across two files so that "who is
 * allowed to be a store" is one grep away.
 */
export const asTraceStore = (
  impl: Omit<TraceStore, typeof traceStoreBrand>,
): TraceStore => impl as TraceStore;

/**
 * An open case. Note the verbs that are absent: no update, no delete, no
 * amend. The guarantee is the shape of this interface, and the database grants
 * carry the other half of it.
 *
 * **Not idempotent, and it says so.** A repeated `record` after a crash writes
 * a second node rather than returning the first: the trace is append-only
 * evidence, and two appends genuinely happened. C2's at-most-once requirement
 * is about *effects*, which `approval` owns; a duplicated node costs a row and
 * is visible on replay, where a duplicated payment is a clawback. Deduplicating
 * appends needs a key column and a partial unique index this migration does not
 * have — see the note in `index.ts`.
 */
export interface CaseTrace {
  readonly correlationId: CorrelationId;
  record<T extends RiskTier>(
    payload: NodePayload,
    options: RecordOptions<T>,
  ): Promise<RecordResult<T>>;
  /**
   * Seals and closes. Always fail-closed regardless of tier: a case whose
   * closure was not recorded is not closed, and an unassisted-containment
   * figure with no node behind it is an assertion rather than evidence.
   */
  close(outcome: UnassistedContainment): Promise<RecordedNode>;
}

export interface AuditDeps {
  readonly store: TraceStore;
  readonly clock: Clock;
  /** Runs before every write. Required — there is no un-writing. */
  readonly redact: Redactor;
  /** Required. No default. See `UnavailabilityPolicy`. */
  readonly onTraceUnavailable: UnavailabilityPolicy;
  /** Optional. See `AuditLimits` for why these carry defaults and the policy does not. */
  readonly limits?: Partial<AuditLimits>;
}

export interface Audit {
  open(correlationId: CorrelationId): Promise<CaseTrace>;
  replay(correlationId: CorrelationId): Promise<ReplayedCase>;
}
