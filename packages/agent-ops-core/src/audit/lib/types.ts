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
 * One bounded window onto a case's nodes.
 *
 * `read` returns a whole case and is the right verb for the overwhelming
 * majority of cases, which hold tens of nodes. It is the wrong verb for the
 * ceiling: `maxNodesPerCase` is 100,000, and a caller who only wants to walk
 * such a case should not have to hold it. So the seam carries both, and the
 * cursor is the **store-assigned sequence** rather than an opaque token — the
 * sequence is already a total order the store guarantees, so a cursor built on
 * it is stable across adapters, reproducible in a runbook, and readable by a
 * human comparing two runs.
 */
export interface TracePageRequest {
  readonly correlationId: CorrelationId;
  /**
   * Exclusive lower bound. `undefined` starts at the beginning. A store must
   * never return a node at or below this sequence.
   */
  readonly afterSequence: number | undefined;
  /**
   * Hard ceiling on nodes returned. A store returning more has broken the
   * contract and is refused, because a page that ignores its limit is an
   * unbounded read wearing a bounded interface.
   */
  readonly limit: number;
}

export interface TracePage {
  /** The case's scope statement, repeated on every page so a page stands alone. */
  readonly provenance: TraceProvenance;
  /** Ascending by sequence, strictly above `afterSequence`, at most `limit` long. */
  readonly nodes: readonly StoredNode[];
  /**
   * True when at least one further node exists after the last one here.
   *
   * Stated by the store rather than inferred from `nodes.length === limit`,
   * because that inference is wrong exactly when the case ends on a page
   * boundary — and being wrong there means a walk that stops one page early on
   * a case whose length happens to be a multiple of the page size, which is the
   * kind of defect that hides for years and then loses the last node of a
   * trace.
   */
  readonly more: boolean;
}

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

/** A node that was written — or, on a deduplicated retry, one that already was. */
export interface Recorded {
  readonly recorded: true;
  readonly node: RecordedNode;
  /**
   * True where this call wrote nothing because an earlier append under the same
   * `idempotencyKey` already existed on this case, and `node` is that earlier
   * node.
   *
   * A caller is entitled to know the difference. "Your node is in the trace" and
   * "your node was already in the trace, from the attempt that crashed" are the
   * same outcome and different stories, and a library that reported only the
   * first would be hiding a retry from the one place that exists to record what
   * happened. Always `false` where no key was supplied.
   */
  readonly deduplicated: boolean;
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
  /**
   * Opt-in. Names *this* append, so a crash-retry returns the first node rather
   * than appending a second beside it.
   *
   * Optional rather than required, because most appends happen inside something
   * that either happened or did not and inventing a key for them would be
   * ceremony. Where it is supplied, reusing it on this case with a **different**
   * payload, tier, parent or telemetry is `IdempotencyKeyConflict` and not a
   * silent return of the first node — a caller who reused a key by mistake must
   * not have their second event quietly disappear.
   *
   * The key is never written into the canonical bytes and never reaches a
   * digest: it is a fact about how a node came to be written, not about what
   * happened. It is also caller data, so it must carry no personal data — the
   * same rule the payload is under, and nothing redacts it.
   */
  readonly idempotencyKey?: string;
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

/**
 * Ceiling on an idempotency key, in characters.
 *
 * Bounded here **and** by a check constraint in
 * `migrations/0007_audit_idempotency.sql`, on the same reasoning as the
 * append-only guarantee: a bound the writer holds alone is a bound a `psql`
 * prompt does not have. 200 characters is a generous three identifiers joined
 * by separators and is not a place to put a payload.
 */
export const MAX_IDEMPOTENCY_KEY_CHARS = 200;

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
  /**
   * The caller's name for this append, or `undefined`.
   *
   * Where present, a store that has already accepted this key **on this case**
   * writes nothing and returns the node it wrote the first time. Where absent,
   * the append is an append: this module derives no key from content, because
   * two identical payloads in one case can be two real events and collapsing
   * them would lose one.
   *
   * Bounded by `MAX_IDEMPOTENCY_KEY_CHARS`, non-empty. See
   * `IdempotencyKeyUnusable`.
   */
  readonly idempotencyKey: string | undefined;
}

/**
 * What a store hands back from `append`.
 *
 * `deduplicated` is a separate field rather than something inferred from the
 * node, because every honest way of inferring it is wrong somewhere. Comparing
 * clock readings fails when a retry lands inside the same millisecond;
 * comparing sequences fails after a restart, when the writer has no memory of
 * what it asked for. Only the store knows whether it wrote a row, so the store
 * says so.
 */
export interface AppendAck {
  readonly node: RecordedNode;
  /**
   * True where an earlier node under the same idempotency key was returned and
   * **nothing was written**. Always false for a keyless append.
   */
  readonly deduplicated: boolean;
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
 *   7. `readPage` is **bounded and ordered**: ascending by sequence, strictly
 *      above the cursor, never longer than the limit, and `more` says whether
 *      anything follows. `createAudit` checks all four on every page and raises
 *      `StoreContractViolated`, because a streaming reader that trusted an
 *      unordered page would compute a digest over an order the store never
 *      assigned.
 *   8. An **idempotency key deduplicates within one case**, inside the same
 *      critical section that writes. A key already accepted on this case returns
 *      the first node with `deduplicated: true` and writes nothing; the same key
 *      offered with a different payload, tier, parent or telemetry raises
 *      `IdempotencyKeyConflict` rather than returning the first node, because a
 *      caller who reused a key by mistake must not have their second event
 *      silently disappear. A check outside the critical section is a race, not a
 *      check: two concurrent retries must produce one node, not two.
 */
export interface TraceStore {
  readonly [traceStoreBrand]: true;
  /**
   * Idempotent on an identical scope statement; raises `ProvenanceConflict` on
   * a contradictory one. Writes the case-level provenance once.
   */
  openCase(correlationId: CorrelationId, provenance: TraceProvenance): Promise<void>;
  append(input: AppendInput): Promise<AppendAck>;
  /** Atomic seal-and-close. Returns the terminal seal node. */
  closeCase(
    correlationId: CorrelationId,
    at: number,
    outcome: UnassistedContainment,
  ): Promise<RecordedNode>;
  /**
   * The whole case. Bounded by `maxNodesPerCase` and materialised — the common
   * path, and the one `replay` uses.
   */
  read(correlationId: CorrelationId): Promise<StoredCase | undefined>;
  /**
   * One bounded window. `undefined` where the case does not exist, which is a
   * different answer from a page with no nodes on it — an open case with
   * nothing recorded yet is real and returns an empty page.
   */
  readPage(request: TracePageRequest): Promise<TracePage | undefined>;
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

// ---------------------------------------------------------------------------
// Reading a case without holding it
// ---------------------------------------------------------------------------

/**
 * What a complete read of a case establishes. Fixed-size whatever the case:
 * this is what lets a 100,000-node case be verified, witnessed or cleared for
 * archive without materialising it.
 */
export interface TraceVerdict {
  readonly correlationId: CorrelationId;
  readonly provenance: TraceProvenance;
  /** How many nodes were read, the seal counted. */
  readonly nodes: number;
  /** True once a seal node has been read. Derived, never a mutable flag. */
  readonly closed: boolean;
  /**
   * The seal's clock reading, or `undefined` on an open case. Retention is
   * measured from here rather than from a database's `inserted_at`, because a
   * trace ordered or aged by a database's own clock is aged by whichever server
   * took the write.
   */
  readonly closedAt: number | undefined;
  /** Digest over the whole case, seal included, in store-assigned order. */
  readonly digest: TraceDigest;
}

export interface WalkLimits {
  /**
   * Nodes fetched per round trip. Bounded on both sides: one node per query is
   * 100,000 round trips, and "no limit" is the unbounded read this exists to
   * replace. Values outside the permitted range are clamped, not rejected — a
   * page size is a performance choice, and refusing an operator's `500_000`
   * outright would leave them with no way to read the case at all.
   */
  readonly pageSize: number;
  /**
   * Ceiling on nodes walked in one pass, above the store's own per-case
   * ceiling. It exists because a store that miscounts `more` would otherwise
   * spin forever, and an operator command that never returns is an outage with
   * no error in it.
   */
  readonly maxNodes: number;
}

// ---------------------------------------------------------------------------
// The external witness
// ---------------------------------------------------------------------------

/** Names the witness that took a record. Stamped on every row it writes. */
export type WitnessId = string & { readonly __brand: "WitnessId" };

/**
 * What is published. Deliberately tiny: a correlation identifier, a digest, a
 * count and a time. **No payload, no node kinds, no personal data** — a witness
 * may be under someone else's custody, and a digest reveals nothing about the
 * case while proving everything about its integrity.
 */
export interface WitnessRecord {
  readonly correlationId: CorrelationId;
  /** The digest of the **whole** case, seal included. */
  readonly digest: TraceDigest;
  /** How many nodes that digest covers, the seal counted. */
  readonly nodes: number;
  /** Milliseconds since epoch, from the injected clock. Our claim, not a notary's. */
  readonly at: number;
  readonly witness: WitnessId;
}

/**
 * The record as the witness now holds it — which may be an **earlier**
 * publication than the one just offered, because publishing is idempotent. A
 * caller can see that from `record.at`, rather than being told a comfortable
 * "yes, done" that hides a republication.
 */
export interface WitnessReceipt {
  readonly record: WitnessRecord;
}

/**
 * Why a replayed case does or does not agree with what was witnessed.
 *
 * Four values rather than a boolean, because the three ways of disagreeing call
 * for three different responses: an incident, a backlog sweep, and a wait.
 */
export type WitnessVerdict =
  | {
      readonly agrees: true;
      readonly digest: TraceDigest;
      readonly witnessed: WitnessRecord;
    }
  /** The alarm. The archive is not the case that was published. */
  | {
      readonly agrees: false;
      readonly reason: "digest-mismatch";
      readonly digest: TraceDigest;
      readonly witnessed: WitnessRecord;
    }
  /** A gap, not a proof. The case was sealed and publication did not happen. */
  | {
      readonly agrees: false;
      readonly reason: "not-witnessed";
      readonly digest: TraceDigest;
    }
  /** Nothing is witnessed until it is sealed. An open case is evidence of nothing. */
  | {
      readonly agrees: false;
      readonly reason: "not-closed";
      readonly digest: TraceDigest;
    };

/**
 * The brand on `Witness`, on the same reasoning as `TraceStore`'s and against
 * the same attack. `{ publish: async () => receipt, lookUp: async () => undefined }`
 * is four lines, would make every case report itself witnessed, and does not
 * typecheck.
 */
declare const witnessBrand: unique symbol;

/**
 * The seam that closes this module's stated blind spot — see `lib/witness.ts`
 * for what it does and does not defeat, in detail and without flattery.
 *
 * Two shipped adapters, `inMemoryWitness` and `postgresWitness`, which is what
 * makes it a real seam. A third, under separate custody, is the one that
 * actually crosses a trust boundary; it is named in `lib/witness.ts` and
 * deliberately not shipped, because shipping it means choosing a custodian for
 * nineteen applications.
 *
 * Every adapter owes three invariants:
 *
 *   1. **Append-only, one record per case.** A second publication of the *same*
 *      digest is accepted and returns the record already held. A second
 *      publication of a *different* digest raises `WitnessConflict` and writes
 *      nothing. A witness that can be overwritten is not a witness.
 *   2. **`lookUp` never invents.** An absent record is `undefined`, never an
 *      empty or optimistic one.
 *   3. **Failures are named.** Anything an adapter cannot classify surfaces as
 *      `WitnessUnavailable`, which is fail-closed.
 */
export interface Witness {
  readonly [witnessBrand]: true;
  readonly id: WitnessId;
  publish(record: WitnessRecord): Promise<WitnessReceipt>;
  lookUp(correlationId: CorrelationId): Promise<WitnessRecord | undefined>;
}

/** Mints the witness brand. Called in exactly the two shipped adapter factories. */
export const asWitness = (impl: Omit<Witness, typeof witnessBrand>): Witness =>
  impl as Witness;

// ---------------------------------------------------------------------------
// Retention: everything the expiry procedure needs, and nothing that performs it
// ---------------------------------------------------------------------------

/**
 * One sealed case that is past its retention period.
 *
 * `digest` is derived from the seal's own bytes, so this is the digest the case
 * claimed for itself at close — not a live recomputation. Clearing a case for
 * removal recomputes it independently; see `Archivist`.
 */
export interface ExpiredCase {
  readonly correlationId: CorrelationId;
  /** The seal's clock reading. Retention runs from here. */
  readonly closedAt: number;
  /** Nodes in the case, the seal counted. */
  readonly nodes: number;
  /** The whole-case digest as the seal attests to it. */
  readonly digest: TraceDigest;
}

export interface RetentionQuery {
  /**
   * Exclusive upper bound on the seal's clock reading. A case sealed at or
   * after this is inside its retention period and is not returned.
   */
  readonly closedBefore: number;
  /**
   * Cursor. Exclusive lower bound on the correlation identifier, so paging is
   * stable across an INSERT-only table: nothing already returned can move, and
   * a case sealed during the sweep sorts wherever its identifier sorts rather
   * than shifting an offset.
   */
  readonly afterCorrelationId: CorrelationId | undefined;
  /** Hard ceiling. There is no "everything past retention" query, by design. */
  readonly limit: number;
}

export interface RetentionPage {
  /** Ascending by correlation identifier, at most `limit` long. */
  readonly cases: readonly ExpiredCase[];
  readonly more: boolean;
}

/**
 * **Read-only, and the absence of a second verb is the design.**
 *
 * There is no `remove`, no `delete`, no `expire` and no `purge` here, and there
 * will not be. The trace tables carry no DELETE grant for the library's writer
 * role, and this interface carries no verb that would want one. A seven-year
 * expiry is a lawful, separately-authorised operation performed by a role this
 * library's migrations do not create, against a runbook a person signs; the
 * library's job is to hand that procedure the two things it cannot safely
 * produce for itself — which cases are due, and whether an archive copy is
 * faithful. See `lib/retention.ts` for the reasoning in full and
 * `migrations/0003_audit_witness.sql` for the half of it that lives in grants.
 *
 * Two adapters, so this is a real seam: the in-memory trace store implements it
 * directly, and `postgresRetentionRegister` reads the seal rows.
 */
export interface RetentionRegister {
  dueForRemoval(query: RetentionQuery): Promise<RetentionPage>;
}

/**
 * An open case. Note the verbs that are absent: no update, no delete, no
 * amend. The guarantee is the shape of this interface, and the database grants
 * carry the other half of it.
 *
 * **Idempotent where the caller names the append, and nowhere else.** Supply
 * `RecordOptions.idempotencyKey` and a retry after a crash returns the first
 * node with `deduplicated: true`, writing nothing — enforced by a partial unique
 * index in `migrations/0007_audit_idempotency.sql` rather than by a cache the
 * writer forgets on restart. Supply no key and an append is an append: this
 * module derives no key from content, because two identical payloads in one case
 * can be two real events. C2's at-most-once requirement is still about
 * *effects*, which `approval` owns.
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
  /**
   * Optional, and the option is the honest part.
   *
   * Wired, `close` publishes the whole-case digest and every witness verb works.
   * Unwired, nothing silently degrades: `witness` and `verifyAgainstWitness`
   * raise `WitnessUnavailable("not-configured")` rather than quietly reporting
   * agreement, because a guarantee that depends on a line of wiring nobody
   * checks is not a guarantee.
   *
   * It is optional rather than required because a witness is only worth having
   * where it is under separate custody, and choosing that custodian is the
   * application's decision to make and answer for — not a default this library
   * can pick on nineteen applications' behalf. `RUNBOOK` says which deployments
   * must have one.
   */
  readonly witness?: Witness;
  /**
   * Where `trace-unavailable-at-high-tier` is raised — the seventh of
   * `docs/CONTEXT.md`'s eight silent conditions, and the strangest one.
   *
   * *"Fail-closed is correct **and** means work has stopped. Correct behaviour
   * is still an incident."* Nothing here is malfunctioning: a high-tier decision
   * could not be traced, so it did not proceed, which is exactly the behaviour
   * this module is built to guarantee. The caller receives `TraceUnavailable`,
   * which is a well-named error that a retry loop will very reasonably catch —
   * and then nineteen applications are quietly not making high-tier decisions
   * while every dashboard stays green.
   *
   * Raised **only at high tier**, and only where the write is refused rather
   * than degraded. A degraded low-tier write is the policy working: the decision
   * proceeds, the gap is recorded, and paging somebody about it would train them
   * to ignore the channel that carries the other seven conditions.
   *
   * Optional, injected, and its absence is written into the returned error's
   * own record rather than assumed — see `AuditDeps.witness` for the same
   * reasoning about a guarantee that depends on a line of wiring nobody checks.
   * A test cannot page anybody through this: no transport is constructed here.
   */
  readonly alerting?: import("../../alerts/index.js").AlertRaiser | undefined;
}

/**
 * The brand on `Audit`, on exactly the reasoning behind `TraceStore`'s and
 * `Witness`'s — and the last of the three to be minted, which is why
 * `README.md` item 8 called `Audit` "the one unbranded witness".
 *
 * The attack it stops is four lines long and was, until now, well-typed:
 *
 * ```ts
 * const audit: Audit = {
 *   open: async () => ({ correlationId, record: async () => ({ recorded: true, node, deduplicated: false }), close: async () => node }),
 *   replay: async () => emptyCase,
 *   walk: ..., witness: ..., verifyAgainstWitness: ...,
 * };
 * ```
 *
 * It acknowledges every write, persists nothing, and satisfies a structural
 * `Audit` completely. `guardrails` compensates at runtime — it checks every
 * acknowledgement and proves its first node by replay, and raises
 * `AuditWitnessUnsound` — but a module that must re-read its own writes to find
 * out whether its recorder is real is paying for a hole in a type. The brand
 * closes it: `declare const` means the symbol exists only in the type system,
 * `index.ts` does not export it, and `lib/` is private to dependency-cruiser, so
 * the object above no longer typechecks anywhere outside this module.
 *
 * **The limits, stated exactly, and they are the same two as `TraceStore`'s.**
 * `as unknown as Audit` compiles in any TypeScript, and spreading a real audit
 * into a decorator copies the brand along with the verbs — deliberately, because
 * a delegating wrapper is a legitimate thing to build. Neither is a regression:
 * `guardrails`' runtime checks stay exactly where they are, and they are what
 * catches both. What the brand removes is the *accident* — the fully-typed
 * object literal a composition root writes in a hurry and nothing complains
 * about.
 */
declare const auditBrand: unique symbol;

export interface Audit {
  readonly [auditBrand]: true;
  open(correlationId: CorrelationId): Promise<CaseTrace>;
  /**
   * The whole case, materialised, with the graph indexed. The common path: a
   * case holds tens of nodes, and a caller who wants `childrenOf` wants the
   * graph in memory anyway.
   */
  replay(correlationId: CorrelationId): Promise<ReplayedCase>;
  /**
   * The same case, a page at a time, for the ones at the ceiling.
   *
   * Yields nodes in store-assigned order and **returns the verdict only to a
   * walk that runs to the end** — a caller who breaks out early gets the nodes
   * they read and no verdict, because a partial walk cannot verify a seal it
   * never reached. Every integrity check `replay` makes is made here too, on
   * the same code; see `lib/stream.ts`.
   */
  walk(
    correlationId: CorrelationId,
    limits?: Partial<WalkLimits>,
  ): AsyncGenerator<RecordedNode, TraceVerdict, undefined>;
  /**
   * Publish a closed case's digest to the injected witness. Idempotent.
   *
   * `close` already does this. This verb is the recovery for the window between
   * seal and publication, and the sweep for cases that fell into it. Streams the
   * case rather than materialising it, so it works at the node ceiling.
   */
  witness(
    correlationId: CorrelationId,
    limits?: Partial<WalkLimits>,
  ): Promise<WitnessReceipt>;
  /**
   * Recompute the whole-case digest and compare it with what the witness holds.
   *
   * This is the check the rows alone cannot make. Streams, so it costs one page
   * of memory whatever the size of the case.
   */
  verifyAgainstWitness(
    correlationId: CorrelationId,
    limits?: Partial<WalkLimits>,
  ): Promise<WitnessVerdict>;
}

/**
 * Mints the `Audit` brand. Called in exactly one place — `createAudit` — which
 * is the whole point: "who is allowed to be an `Audit`" is one grep away, and
 * the answer is "the factory that wires a real store, a real clock and a real
 * redactor".
 */
export const asAudit = (impl: Omit<Audit, typeof auditBrand>): Audit =>
  impl as Audit;
