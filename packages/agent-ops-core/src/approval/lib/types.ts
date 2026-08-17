import type { Clock, CorrelationId, NodeId } from "../../audit/index.js";
import type {
  ClientFactory,
  EffectCommand,
  ReadOnlyClient,
  WriteCapableClient,
} from "./clients.js";

/**
 * Integer milliseconds since the Unix epoch. Never a `Date`: `Date` does not
 * serialise byte-stably across runtimes, and byte-stable serialisation is what
 * makes replay possible seven years from now.
 */
export type Instant = number;

/** Integer milliseconds. Never a float. */
export type DurationMs = number;

/**
 * A list the type refuses to let you leave empty. Used wherever "none" would
 * otherwise be expressible by omission — which is how a required field ends up
 * wearing an optional field's clothes.
 */
export type NonEmpty<T> = readonly [T, ...T[]];

export type AuthorityId = string & { readonly __brand: "AuthorityId" };
export type AuthorityPoolId = string & { readonly __brand: "AuthorityPoolId" };
export type SuspensionId = string & { readonly __brand: "SuspensionId" };
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" };

/** Consequence of being wrong. Never multiplied with confidence. */
export type Tier = "low" | "medium" | "high";

/**
 * Facts a policy is allowed to see. Flat, scalar, integers only — the same
 * discipline the trace is held to, because these facts are recorded on the
 * classification node and must be readable in 2033.
 */
export type PolicyFacts = Readonly<Record<string, string | number | boolean>>;

/* ------------------------------------------------------------------ authority */

export type Authority =
  | { readonly kind: "human"; readonly id: AuthorityId; readonly role: string }
  | {
      readonly kind: "delegated";
      readonly id: AuthorityId;
      /**
       * Non-optional. "The system approved it" cannot be recorded without
       * saying under whose delegation.
       */
      readonly delegatedBy: AuthorityId;
      readonly delegationRef: string;
      readonly grantedAt: Instant;
    };

export type HumanAuthority = Extract<Authority, { readonly kind: "human" }>;
export type DelegatedAuthority = Extract<Authority, { readonly kind: "delegated" }>;

/** Who a ladder step or a recurrence cycle reaches. */
export type AuthorityRef =
  | { readonly kind: "pool"; readonly pool: AuthorityPoolId }
  | { readonly kind: "authority"; readonly id: AuthorityId };

/* ------------------------------------------------------------------- reserved */

/**
 * Reserved status. Note what is absent: **no boolean and no `undefined`
 * branch.**
 *
 * A `ReservedPolicy` that finds no matching rule must return an explicit,
 * versioned assertion that none matched, and that assertion is recorded as its
 * own node. "We checked and it is not reserved" and "nobody thought about it"
 * are different facts, and this type refuses to let them share a
 * representation.
 */
export type ReservedStatus =
  | {
      readonly reserved: true;
      readonly rule: string;
      readonly citation: string;
      readonly policyVersion: string;
    }
  | {
      readonly reserved: false;
      /** Why the policy concluded no obligation applies. Not optional. */
      readonly basis: string;
      readonly policyVersion: string;
    };

export type Reserved = Extract<ReservedStatus, { readonly reserved: true }>;
export type NotReserved = Extract<ReservedStatus, { readonly reserved: false }>;

/* ------------------------------------------------------- the escalation ladder */

export type EscalationAction = "notify" | "escalate" | "alert" | "page";

export interface EscalationStep {
  /** Offset from the moment the decision began awaiting an authority. */
  readonly after: DurationMs;
  readonly action: EscalationAction;
  readonly to: AuthorityRef;
}

/**
 * The repeating tail of a ladder. Mandatory. Continues until answered.
 *
 * There is no `stop` value, no `maxAttempts`, and no `until`. The type cannot
 * express giving up: a decision that needed a human yesterday still needs one
 * next month, and a system that stops asking has decided by exhaustion, which
 * is the thing reserved decisions exist to prevent.
 */
export interface Recurrence {
  /**
   * Floor interval. Constant, so the cadence **never accelerates** — a
   * recurrence that speeds up floods a channel, the channel gets muted, and the
   * case becomes less likely to be answered than if nothing had been sent.
   * Validated against `limits.minRecurrenceIntervalMs` at declaration.
   */
  readonly every: DurationMs;
  /**
   * Each cycle adds one more recipient from this list and holds the cadence
   * steady — deputy, then line manager, then the accountable executive. The
   * fifteenth reminder to a person who has ignored fourteen is not a plan.
   * Once the list is exhausted every later cycle reaches all of them.
   */
  readonly widenTo: NonEmpty<AuthorityRef>;
}

export interface EscalationLadder {
  readonly steps: NonEmpty<EscalationStep>;
  readonly recurrence: Recurrence;
}

/**
 * What an expiry may settle into. There is exactly one arm, and it is not
 * `approve`. An expiry can never license an effect — "nobody was on shift" is
 * not a lawful basis for moving money.
 */
export type ExpirySettlement = { readonly kind: "refuse"; readonly reason: string };

export interface ExpiryBranch {
  readonly after: DurationMs;
  readonly then: ExpirySettlement;
}

/**
 * What happens if the approver does nothing.
 *
 * Conditional on reserved status: **a reserved decision has no `expire` branch
 * to declare.** `DoNothing<Reserved>` is `{ ladder }` and nothing else, so
 * writing an expiry for a decision known to be reserved is a compile error
 * rather than a policy someone is trusted to follow. Proved by a compile
 * fixture in `tests/`, not asserted in prose.
 *
 * Both arms require the ladder. Removing the expiry branch was necessary and
 * was never sufficient: a decision with neither an expiry nor a ladder does not
 * fail safely, it fails *silently*, which is worse.
 */
export type DoNothing<R extends ReservedStatus = ReservedStatus> = R extends Reserved
  ? { readonly ladder: EscalationLadder }
  : { readonly ladder: EscalationLadder; readonly expire?: ExpiryBranch };

/**
 * The declarable form, used in a `DecisionPointSpec` where reserved status is
 * not yet known — it is computed per case, by a policy, before execution. When
 * the policy returns reserved, the module **deletes** the expiry at runtime and
 * records a node saying it did. The conditional type above is what a caller
 * uses when a point is reserved by construction.
 */
export type DoNothingConsequence = {
  readonly ladder: EscalationLadder;
  readonly expire?: ExpiryBranch;
};

/** What the module served, after any reserved-status override. */
export interface ServedDoNothing {
  readonly ladder: EscalationLadder;
  /** `null` means indefinite hold. Always `null` for a reserved decision. */
  readonly expire: ExpiryBranch | null;
}

/* ---------------------------------------------------------------------- brief */

/**
 * Evidence is carried as a **handle**, never as content. The trace records that
 * the handle was served and to whom; the renderer resolves it live against the
 * application's own store. That is how the brief's evidence stays *reachable*
 * (CONTEXT) while the trace stays free of personal data (C2). Seven years later
 * the trace proves what was shown without being a copy of it.
 */
export interface EvidenceHandle {
  readonly kind: string;
  readonly ref: string;
}

export type Uncertainty =
  | { readonly kind: "open-question"; readonly question: string; readonly why: string }
  | { readonly kind: "nothing-material"; readonly because: string };

export interface UncheckedItem {
  readonly what: string;
  readonly why: string;
}

/**
 * "Nothing to report" as an **assertion about a search performed**, never an
 * empty array. Absence of a finding is not a finding, and a brief that presents
 * only the supporting case is advocacy.
 */
export type ContraryEvidence =
  | { readonly found: NonEmpty<EvidenceHandle> }
  | { readonly searchedAndFoundNone: { readonly searched: string } };

export type CouldNotCheck =
  | { readonly items: NonEmpty<UncheckedItem> }
  | { readonly everythingRequiredWasChecked: { readonly checklist: string } };

/** The five fields the application supplies. Every one is non-optional. */
export interface BriefBody {
  /** 1. The effect in the approver's units. "£47,200 leaves account 8812 today". */
  readonly effectInConcreteTerms: string;
  /** 2. What the system concluded, with evidence reachable rather than summarised. */
  readonly concluded: {
    readonly statement: string;
    readonly evidence: NonEmpty<EvidenceHandle>;
  };
  /** 3. What the system is unsure about. Non-empty: saying nothing is a claim. */
  readonly unsureAbout: NonEmpty<Uncertainty>;
  /** 3b. Contrary evidence, or an assertion about the search that found none. */
  readonly contrary: ContraryEvidence;
  /** 4. What it could not check, and why. */
  readonly couldNotCheck: CouldNotCheck;
}

/**
 * What the second seat is allowed to know about the first.
 *
 * Note what is absent: there is **no `outcome` field**, and no way to add one
 * from outside this module. Dual control where the second person is shown "Jane
 * approved this" is not two decisions; it is Jane's decision with an echo. The
 * exclusion is a missing property, not a rule for whoever builds the screen.
 */
export interface AnswerReceipt {
  readonly by: AuthorityId;
  readonly at: Instant;
  readonly node: NodeId;
}

interface ServedBriefCore extends BriefBody {
  readonly suspension: SuspensionId;
  /** 7. The correlation identifier, so the full trace is one step away. */
  readonly correlationId: CorrelationId;
  readonly tier: Tier;
  /** 5. Whether the decision is reserved, and under which rule or statute. */
  readonly reserved: ReservedStatus;
  /** 6. What happens if the approver does nothing. */
  readonly doNothing: ServedDoNothing;
  /** Stamped by the module's injected clock. Half of time-to-decision. */
  readonly presentedAt: Instant;
}

/**
 * A discriminated union on `seat`, deliberately — **not** a phantom type
 * parameter, which erases at the seam and would let a renderer written against
 * `ServedBrief<"first">` receive a second-seat brief unchanged.
 *
 * There is no `recommendedChoice`, no `defaultAnswer`, no `systemSuggests`.
 * A renderer has nothing to pre-highlight because it is handed nothing to
 * pre-highlight with.
 */
export type ServedBrief =
  | (ServedBriefCore & { readonly seat: "first" })
  | (ServedBriefCore & { readonly seat: "second"; readonly priorAnswer: AnswerReceipt });

export type BriefBuilder<In, V> = (args: {
  readonly input: In;
  readonly verdict: V;
  readonly confidenceBasisPoints: number;
  readonly evidence: readonly EvidenceHandle[];
  readonly tier: Tier;
  readonly reserved: ReservedStatus;
}) => BriefBody;

/* --------------------------------------------------------------------- effects */

export type RedactedPayload = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Whether the effect happened. Three arms, because two are not enough: if the
 * executor *knows* nothing happened the claim survives and a retry is
 * legitimate; if it cannot tell, the claim is left in doubt and no automatic
 * retry occurs. Ambiguity resolves toward not paying twice.
 */
export type EffectOutcome =
  | { readonly kind: "done"; readonly reference: string }
  | { readonly kind: "not-attempted"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

declare const LICENCE: unique symbol;

/**
 * The witness that an approval exists. Unconstructible outside this module: the
 * brand is a non-exported `unique symbol`, so no external object literal
 * satisfies it, and there is no public `execute` to hand a forged one to.
 */
export interface Licence {
  readonly [LICENCE]: true;
  readonly correlationId: CorrelationId;
  readonly node: NodeId;
  readonly idempotencyKey: IdempotencyKey;
  readonly approvals: NonEmpty<ApprovalRecord>;
  readonly expiresAt: Instant;
}

export interface ApprovalRecord {
  readonly by: Authority;
  readonly at: Instant;
  readonly node: NodeId;
  readonly reason: string;
  /**
   * Milliseconds between the brief being presented and the answer arriving, or
   * `null` when the brief was never delivered and there is therefore nothing to
   * measure from. An invented zero would read as the fastest possible approval
   * in the one metric that exists to catch rubber-stamping.
   */
  readonly timeToDecisionMs: DurationMs | null;
}

export interface EffectDeclaration<P> {
  readonly kind: string;
  readonly schemaVersion: number;
  /**
   * Non-optional. A decision point that does not declare how its effect payload
   * is redacted does not compile. There is no un-writing.
   */
  readonly redact: (payload: P) => RedactedPayload;
  /**
   * Invoked **only** by this module, **only** with a licence in hand, **only**
   * after the kill switch has been read. This is the one place in the module
   * where a write-capable client exists.
   */
  readonly execute: (
    licence: Licence,
    client: WriteCapableClient,
    payload: P,
  ) => Promise<EffectOutcome>;
}

export type { EffectCommand };

/* ---------------------------------------------------------------- declaration */

/**
 * What the decision cost. **Required, never optional** — this is C2's one
 * surviving requirement from the module that was cut, and an optional field
 * would be absent on exactly the decisions nobody instrumented.
 *
 * Integers only, in the units the rest of the library uses: cost in
 * tenth-cents, never a currency float. A decision point that calls no model
 * still states its spend, and `{ costTenthCents: 0, tokensIn: 0, tokensOut: 0,
 * priceTableVersion: "none" }` is a statement rather than a silence.
 */
export interface DecisionSpend {
  /** Tenth-cents. An integer, because a price is not an IEEE-754 value. */
  readonly costTenthCents: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /**
   * Which price table produced `costTenthCents`. Without it the number cannot
   * be re-derived in 2033 and is therefore not evidence of anything.
   */
  readonly priceTableVersion: string;
}

export type Determination<V, P> =
  | {
      readonly kind: "concluded";
      readonly verdict: V;
      /** Basis points, 0–10000. An integer. No IEEE-754 anywhere near a trace. */
      readonly confidenceBasisPoints: number;
      readonly evidence: NonEmpty<EvidenceHandle>;
      /** `null` means the verdict licenses nothing. */
      readonly proposes: { readonly payload: P } | null;
      /** Required. Recorded on the `approval.decided` node. */
      readonly spend: DecisionSpend;
    }
  | {
      /** A verdict, and a successful outcome of a working system. Not an error. */
      readonly kind: "abstained";
      readonly reason: string;
      readonly evidence: readonly EvidenceHandle[];
      /** Required. An abstention that called a model still cost money. */
      readonly spend: DecisionSpend;
    };

/** Standing delegated authority, for an ungated point that still takes effects. */
export interface DelegationGrant {
  readonly as: AuthorityId;
  readonly delegatedBy: AuthorityId;
  readonly delegationRef: string;
  readonly grantedAt: Instant;
}

/**
 * The effect payload type for a decision point that takes **no** effect.
 *
 * A point declaring `effect: { kind: "no-effect" }` never constructs an
 * `EffectDeclaration`, so its payload parameter is unused and a caller has to
 * put *something* in the third slot of `DecisionPoint<Input, Verdict, P>`. The
 * instinctive spelling is `never` — "there is no payload" — and it does not
 * work: `EffectDeclaration<P>` mentions `P` only in argument position
 * (`redact(payload: P)`, `execute(…, payload: P)`), so it is contravariant in
 * `P`, while `AnyDecisionPoint` — the erased type `ApprovalDeps.points` holds —
 * instantiates it at `any`. `any` is assignable to every type except `never`,
 * so a point parameterised at `never` will not fit the registry it is written
 * for, and the compiler explains it as ten lines of nested variance.
 *
 * `void` fits, and is the same statement. This alias exists so the working
 * spelling has a name and a reason rather than being folklore recovered from a
 * type error — nineteen applications write ungated points, and this is the
 * first thing each of them writes.
 */
export type NoEffectPayload = void;

export type UngatedEffect<P> =
  | { readonly kind: "no-effect" }
  | {
      readonly kind: "delegated";
      readonly declaration: EffectDeclaration<P>;
      /**
       * Non-optional. Automated approval is still approval and is still
       * recorded with a named authority; "the system approved it" must never
       * appear in a trace without saying under whose delegation.
       */
      readonly delegation: DelegationGrant;
      /**
       * How long the minted licence stays valid. Required and validated to be
       * positive: it used to be hardcoded to `0` here, which minted a licence
       * already expired at the instant of minting and then never compared it to
       * anything. A field nothing reads is worse than no field, because it
       * reads as a control.
       */
      readonly licenceValidFor: DurationMs;
    };

interface CommonSpec<In, V, P> {
  /**
   * Stable for the life of the application. A semantic change requires a NEW
   * id, never a version bump — versions describe payload *shape*, ids carry
   * *meaning*. Reusing an id for a changed meaning is how a 2033 auditor reads
   * a 2026 trace wrongly.
   */
  readonly id: string;
  readonly schemaVersion: number;
  /** Pure, sub-millisecond, no I/O. It runs on every decision. */
  readonly tierFacts: (input: In) => PolicyFacts;
  /**
   * A second, separate extractor feeding a second, separate seam. Merging it
   * with `tierFacts` would let a risk-threshold change delete a legal
   * obligation.
   */
  readonly reservedFacts: (input: In) => PolicyFacts;
  /**
   * Declared as a **property with a function type**, never as a method. Takes
   * `ReadOnlyClient` at every tier — there is no variant of this field that
   * accepts a write-capable client, so an effect taken inside `decide` is a
   * compile error and not a code-review note.
   */
  readonly decide: (client: ReadOnlyClient, input: In) => Promise<Determination<V, P>>;
}

export interface UngatedSpec<In, V, P> extends CommonSpec<In, V, P> {
  /** This decision point never transfers authority to a human. */
  readonly gate: "never";
  /** Fail-closed ceiling. A case classified above it halts. */
  readonly maxTier: Tier;
  readonly effect: UngatedEffect<P>;
}

export interface GatedSpec<In, V, P> extends CommonSpec<In, V, P> {
  readonly gate: "human";
  readonly maxTier: Tier;
  readonly effect: EffectDeclaration<P>;
  readonly brief: BriefBuilder<In, V>;
  /**
   * Required, and its `ladder` is required inside it. **Declaring a human gate
   * without saying what happens as it ages does not compile.**
   */
  readonly doNothing: DoNothingConsequence;
  /** Which pool the first seat is drawn from. */
  readonly pool: AuthorityPoolId;
  /** Dual control applies at this tier and above. `"never"` disables it. */
  readonly dualControlAtOrAbove: Tier | "never";
  /**
   * How long a minted licence stays valid, measured from the **earliest**
   * approval in hand rather than from the last one. A stale approval is not
   * approval: an approver who signed on Monday signed against Monday's
   * evidence, and a second seat arriving on Thursday must not resurrect it.
   *
   * Enforced, not decorative. Exceeding it raises `LicenceExpired`, takes no
   * effect, and returns the suspension to the first seat with the ladder
   * restarted, so the case stays answerable. A non-positive value does not
   * compile past `defineDecisionPoint`.
   */
  readonly licenceValidFor: DurationMs;
}

export type DecisionPointSpec<In, V, P> = UngatedSpec<In, V, P> | GatedSpec<In, V, P>;

declare const POINT: unique symbol;

/** Opaque. Produced only by `defineDecisionPoint`, consumed only by `run`. */
export interface DecisionPoint<In, V, P> {
  readonly [POINT]: true;
  readonly id: string;
  readonly spec: DecisionPointSpec<In, V, P>;
}

/* ----------------------------------------------------------------------- seams */

export interface TierPolicy {
  readonly version: string;
  /** Pure. Runs before the expensive work, on facts only. */
  readonly classify: (facts: PolicyFacts) => Tier;
}

export interface ReservedPolicy {
  readonly version: string;
  /**
   * Pure. Must return an explicit assertion either way — the return type has no
   * `undefined` branch, so "no rule matched" is a statement the policy makes.
   */
  readonly screen: (facts: PolicyFacts) => ReservedStatus;
}

export interface AuthorityRequest {
  readonly pool: AuthorityPoolId;
  /** Structural distinctness: the second seat's directory is already narrowed. */
  readonly excluding: readonly AuthorityId[];
  readonly reserved: boolean;
}

export interface AuthorityDirectory {
  readonly candidates: (request: AuthorityRequest) => Promise<readonly HumanAuthority[]>;
  readonly resolve: (ref: AuthorityRef) => Promise<readonly HumanAuthority[]>;
}

export interface Reminder {
  readonly suspension: SuspensionId;
  readonly correlationId: CorrelationId;
  readonly action: EscalationAction;
  /** 1-based. Scheduled steps first, then recurrence cycles. */
  readonly ordinal: number;
  readonly phase: "step" | "recurrence";
  readonly awaitingForMs: DurationMs;
  readonly reserved: boolean;
}

export interface BriefRenderer {
  readonly present: (brief: ServedBrief, to: readonly HumanAuthority[]) => Promise<void>;
  readonly remind: (reminder: Reminder, to: readonly HumanAuthority[]) => Promise<void>;
}

/**
 * What an engaged kill switch stops.
 *
 * `docs/CONTEXT.md`: a kill switch stops effects *"system-wide or per tier"*.
 * This type is the "or", and it is a **closed** type rather than the free
 * string it used to be, for one reason: a scope this module cannot read is a
 * scope this module cannot enforce. The previous shape wrote whatever the
 * reader claimed onto the node and then stopped every effect at every tier
 * regardless — so a switch engaged for high tier alone silently stopped
 * low-tier work too, and the trace faithfully recorded a scope nothing obeyed.
 * A safety control that records its own scope without enforcing it is the most
 * dangerous kind, because it reports that it worked.
 *
 * Two shapes and no third:
 *
 *   `system-wide`  Every effect, at every tier. The incident switch.
 *   `tiers`        Exactly the tiers listed. `["high"]` stops disbursements and
 *                  leaves ticket routing running. There is no "and above":
 *                  an explicit list cannot be misread, and `["medium","high"]`
 *                  says "and above" without needing a second shape to mean it.
 *
 * The scope is evaluated **here**, by this module, against the tier of the
 * effect about to be taken — never by the reader. A reader that answers a
 * per-tier question with its own opinion is the failure this closes.
 */
export type KillSwitchScope =
  | { readonly kind: "system-wide" }
  | { readonly kind: "tiers"; readonly tiers: NonEmpty<Tier> };

export type KillSwitchState =
  | { readonly engaged: false }
  | {
      readonly engaged: true;
      readonly scope: KillSwitchScope;
      readonly by: string;
      readonly at: Instant;
    };

/**
 * What the reader is asked. An object rather than a bare `Tier` so that the
 * question can gain a field without nineteen adapters changing signature.
 *
 * The tier is passed so a reader backed by a control plane that stores one row
 * per tier can answer accurately in one round trip. It is **not** passed so the
 * reader can decide whether the switch applies: the returned `scope` is
 * evaluated against this tier by the module, so a reader that ignores the
 * question entirely and always returns the whole switch is still enforced
 * correctly.
 */
export interface KillSwitchQuery {
  readonly tier: Tier;
}

export type KillSwitchReader = (query: KillSwitchQuery) => Promise<KillSwitchState>;

/* ------------------------------------------------------------- durable storage */

/**
 * Where a suspension has got to.
 *
 * `answered` is the one that is easy to mistake for decoration. It is the state
 * a suspension is committed into **before** the outbound call, and it is what
 * makes the compare-and-set meaningful: once a suspension leaves `awaiting`, no
 * sweeper will touch it and no second `answer` can reach the effect, so the
 * payment happens with the race already resolved. It is not terminal — a case
 * can sit in it if the process dies mid-call, and it is then an entry in the
 * reconciliation queue rather than a case anybody is still chasing.
 *
 * `held` is **not terminal either**, and that is the correction this release
 * makes. The kill switch stops effects without stopping decisions, and it is
 * engaged during an incident and disengaged after it. A hold that settled the
 * case for good would mean every case answered during an incident silently
 * needing a human to notice it and do something — the dangerous quadrant
 * reached by a path nobody designed. So a held suspension keeps a `nextDueAt`,
 * the sweep keeps visiting it, and when the switch is found disengaged the case
 * returns to `awaiting` at the first seat with the ladder restarted and the
 * sealed answers cleared. The effect is never taken automatically on release:
 * an approval given before an incident was given against pre-incident evidence,
 * and a fresh approval is the only thing that licenses money to move.
 */
export type SuspensionState =
  | "awaiting"
  | "answered"
  | "refused"
  | "expired"
  | "executed"
  | "held";

/**
 * A suspended decision, as plain data. Everything needed to resume lives here
 * or in the trace — nothing lives in a closure, which is what lets the process
 * die between the question and the answer.
 */
export interface SuspensionRecord {
  readonly id: SuspensionId;
  readonly revision: number;
  readonly correlationId: CorrelationId;
  readonly pointId: string;
  /**
   * The declaration this case was frozen against. Compared on every `answer`;
   * drift is `PointSchemaChanged` and fails closed, because the payload, brief
   * and verdict held here were serialised under this field set.
   */
  readonly pointSchemaVersion: number;
  /** The effect declaration frozen with it. Drift is `EffectDeclarationDrifted`. */
  readonly effectKind: string;
  readonly effectSchemaVersion: number;
  readonly tier: Tier;
  readonly reserved: ReservedStatus;
  readonly seat: "first" | "second";
  /** Canonical JSON. Byte-stable, integers only, sorted keys. */
  readonly verdictJson: string;
  readonly effectPayloadJson: string;
  readonly redactedEffect: RedactedPayload;
  readonly briefBodyJson: string;
  readonly doNothingJson: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly pool: AuthorityPoolId;
  readonly dualControlRequired: boolean;
  readonly licenceValidFor: DurationMs;
  readonly awaitingSince: Instant;
  /**
   * When the brief was actually delivered to at least one authority, or `null`
   * when it has not been.
   *
   * `null` is not a formality. A directory outage or an on-call gap at suspend
   * time means nobody has the brief, and measuring time-to-decision from a
   * presentation that did not happen corrupts the only anti-rubber-stamping
   * signal the library records. While it is `null` the sweep re-attempts
   * presentation on every visit, and an approval granted against it carries
   * `timeToDecisionMs: null` rather than an invented number.
   */
  readonly presentedAt: Instant | null;
  /**
   * Every authority the directory offered this seat's brief to. The
   * authorisation check in `answer` is membership of this set — not the
   * identity the calling surface asserts.
   *
   * For a second seat it is computed from a directory already narrowed by
   * `excluding: [first approver]`, which is what makes dual-control
   * distinctness structural rather than a string comparison.
   */
  readonly offeredTo: readonly AuthorityId[];
  /**
   * When a reminder was last actually delivered, or `null` if none has been.
   *
   * The ladder's next due time is floored against this, never computed from
   * `awaitingSince` alone. Without it a sweeper that was down for a month
   * catches up by firing every missed cycle at one instant, which is the
   * accelerating cadence `Recurrence` promises is impossible.
   */
  readonly lastRemindedAt: Instant | null;
  /**
   * When the next ladder step or recurrence cycle is due. Never `null` and
   * never a sentinel: the ladder has no position from which nothing more is
   * owed.
   */
  readonly nextDueAt: Instant;
  /** `null` means indefinite hold. Always `null` for a reserved decision. */
  readonly expiresAt: Instant | null;
  /**
   * The first seat's answer, sealed. It is never projected into a
   * `ServedBrief`; the only thing that crosses to the second seat is an
   * `AnswerReceipt`, which has no outcome field.
   */
  readonly firstAnswer: SealedAnswer | null;
  /**
   * The answer that settled the suspension, sealed. Written by the same
   * compare-and-set that moves the state out of `awaiting`, so a terminal
   * record always names who ended it and a retried `run` can report the
   * settlement instead of claiming the case still needs a human.
   */
  readonly finalAnswer: SealedAnswer | null;
  readonly stepsFired: number;
  readonly cyclesFired: number;
  readonly leaseUntil: Instant | null;
  readonly leaseOwner: string | null;
  readonly state: SuspensionState;
  readonly suspendNode: NodeId;
  readonly runNode: NodeId;
}

export interface SealedAnswer {
  readonly by: AuthorityId;
  readonly at: Instant;
  readonly node: NodeId;
  readonly choice: "approve" | "refuse";
  /**
   * The approver's own words. Held **here**, in the application's own durable
   * store under the application's own retention — never on the trace, where it
   * would be free human text in a seven-year append-only archive with no
   * un-writing. The trace carries its digest and its length.
   */
  readonly reason: string;
  /** `null` when the brief was never delivered, so there is nothing to measure from. */
  readonly timeToDecisionMs: DurationMs | null;
}

/** Three states, not two. `not-attempted` and `unknown` never share a shape. */
export type IdempotencyState = "not-attempted" | "unknown" | "settled";

/**
 * The result of claiming a key, as an **atomic transition** rather than a read.
 *
 * `claimed` says whether *this* caller took the claim. It is the difference
 * between "I may execute" and "somebody else is mid-flight", and without it the
 * loser of a race reads `not-attempted`, cannot tell it did not win, and
 * manufactures a reconciliation incident for a double-clicked button.
 */
export interface IdempotencyClaimResult {
  readonly claim: IdempotencyClaim;
  readonly claimed: boolean;
  /**
   * True when the claim was taken over from an expired lease. Only ever
   * possible from `not-attempted`, where no outbound call was made; an expired
   * lease in `unknown` is never reclaimed for execution.
   */
  readonly reclaimed: boolean;
}

export interface IdempotencyClaim {
  readonly key: IdempotencyKey;
  readonly correlationId: CorrelationId;
  readonly state: IdempotencyState;
  readonly claimedAt: Instant;
  readonly leaseUntil: Instant;
  readonly outcome: EffectOutcome | null;
  readonly reason: string | null;
}

/**
 * The durable seam.
 *
 * **Two adapters ship**: `inMemoryApprovalStore` and `postgresApprovalStore`.
 * The second is the one that carries a suspension across process death, and it
 * takes an injected `SqlExecutor` — the same shape `audit`'s `postgresTraceStore`
 * takes, so one pool wired once at the composition root serves both. Neither
 * adapter imports a driver, reads a connection string or opens a socket, which
 * is what keeps hermeticity structural rather than conventional.
 *
 * What the two adapters must agree on, stated here because it is the
 * interesting part of the seam rather than the storage:
 *
 *   - `saveSuspension` is **insert-if-absent**. A second save for an id that
 *     already exists is a no-op, never an overwrite: overwriting would reset
 *     `revision` and turn a lost compare-and-set into a silent clobber.
 *   - `swapSuspension` is a compare-and-set on `revision`, and it must be one
 *     atomic operation. A read followed by a write is not this interface.
 *   - `acquireLease` is a compare-and-set on the lease and **does not touch
 *     `revision`**, so a sweeper holding a lease can still be raced out of its
 *     write by an `answer` that arrived in the same second.
 *   - `dueSuspensions` returns `awaiting` records that are due or expired **and
 *     `held` records that are due**, because a kill-switch hold is resumable —
 *     see `SuspensionState`.
 *   - The three idempotency states never collapse into two, and `unknown` is
 *     never reclaimed for execution at any age.
 */
export interface ApprovalStore {
  /**
   * Insert-if-absent. Returns normally whether or not the row was written; the
   * caller has already read `loadSuspension` and a concurrent `run` for the
   * same case, point and payload is a duplicate, not a conflict.
   */
  readonly saveSuspension: (record: SuspensionRecord) => Promise<void>;
  readonly loadSuspension: (id: SuspensionId) => Promise<SuspensionRecord | undefined>;
  /**
   * Every suspension recorded against one case. Bounded.
   *
   * Exists for `reconcile`, which compares the durable suspensions of a case
   * against the suspension nodes in its trace. Without a read keyed by case,
   * "a suspension whose trace node is missing" is undetectable — the only way
   * in is the suspension id, and the missing side is the side that would have
   * carried it.
   */
  readonly suspensionsOf: (
    correlationId: CorrelationId,
    limit: number,
  ) => Promise<readonly SuspensionRecord[]>;
  /**
   * Conditional update. Returns `false` when `expectedRevision` no longer
   * holds, which is how two writers to one case are made correct without a lock
   * held across a human gate.
   */
  readonly swapSuspension: (
    id: SuspensionId,
    expectedRevision: number,
    next: SuspensionRecord,
  ) => Promise<boolean>;
  /**
   * Bounded. Never "everything due".
   *
   * Returns `awaiting` records whose `nextDueAt` has passed or whose expiry has
   * passed, **and `held` records whose `nextDueAt` has passed**. A kill-switch
   * hold is not a terminal state: the switch is engaged during an incident and
   * disengaged after it, and a case that stopped being visited when the switch
   * went on would be a case nobody ever comes back to.
   */
  readonly dueSuspensions: (now: Instant, limit: number) => Promise<readonly SuspensionRecord[]>;
  /** Compare-and-set on the lease. Two sweepers must be safe; they will be. */
  readonly acquireLease: (
    id: SuspensionId,
    owner: string,
    now: Instant,
    until: Instant,
  ) => Promise<boolean>;
  /**
   * Written **before** the outbound call, with a lease and a TTL, as one atomic
   * transition.
   *
   * Every adapter owes three things here, and they are the interesting part of
   * the seam rather than the storage:
   *
   *   1. `claimed` is true for exactly one concurrent caller per key.
   *   2. A `not-attempted` claim whose lease has expired **is** reclaimable —
   *      no outbound call was made, so re-executing is safe.
   *   3. An `unknown` claim is **never** reclaimed for execution, whatever its
   *      age or its lease. It goes to `inDoubt` and a human resolves it.
   *      Ambiguity resolves toward not paying twice.
   *
   * The lease also separates two things that look identical from outside and
   * are not: an `unknown` claim with a **live** lease is a call in flight right
   * now, and the caller is told `EffectAlreadyInFlight` and may retry; an
   * `unknown` claim whose lease has been **released** — by an executor that
   * threw, or that reported `unknown`, or by the TTL running out on a holder
   * that died — is genuinely in doubt, and the caller is told
   * `IdempotencyIndeterminate`. Neither one re-executes. The lease is the bound
   * on how long "wait and retry" stays the right advice.
   */
  readonly claimIdempotency: (
    key: IdempotencyKey,
    correlationId: CorrelationId,
    now: Instant,
    leaseMs: DurationMs,
  ) => Promise<IdempotencyClaimResult>;
  /** Read without claiming. Used to report a settled outcome, never to execute. */
  readonly readIdempotency: (key: IdempotencyKey) => Promise<IdempotencyClaim | undefined>;
  readonly settleIdempotency: (key: IdempotencyKey, next: IdempotencyClaim) => Promise<void>;
  /** The reconciliation queue. Bounded read. */
  readonly inDoubt: (limit: number) => Promise<readonly IdempotencyClaim[]>;
}

/* ----------------------------------------------------------------------- deps */

/**
 * Bounded resources. Every one is a number and none of the ones touching money
 * has a silent default.
 */
export interface Limits {
  /** Maximum suspensions a single `sweep` may touch. */
  readonly sweepBatch: number;
  /** Lease TTL on a swept suspension, so a sweeper dying does not freeze it. */
  readonly sweepLeaseMs: DurationMs;
  /** Floor a declared recurrence interval may not go below. */
  readonly minRecurrenceIntervalMs: DurationMs;
  /**
   * Lease TTL on an idempotency claim. Read, not merely written: it decides
   * whether a `not-attempted` claim may be reclaimed for execution and whether
   * an `unknown` one reads as in-flight or as in-doubt.
   */
  readonly idempotencyLeaseMs: DurationMs;
  /** Bounded reminder fan-out per cycle. */
  readonly maxRecipientsPerReminder: number;
  /** Bounded read of the reconciliation queue. */
  readonly inDoubtBatch: number;
  /**
   * Maximum cases one `reconcile` may compare, and the ceiling on suspensions
   * read per case. Reconciliation reads a whole trace per case, so an unbounded
   * pass over a backlog is a memory incident dressed as a health check.
   */
  readonly reconcileBatch: number;
  /**
   * Ceiling on entry-point invocations in flight against this instance.
   *
   * Every `run`, `answer`, `sweep` and `reconcile` holds trace writes, store
   * round trips and adapter calls open for its duration. Without a ceiling the
   * queue is the connection pool's, most drivers' pool queues are unbounded,
   * and nothing sheds: the backlog surfaces as latency until the process dies
   * with the work still in it. Over the ceiling, invocations are refused with
   * `ApprovalOverloaded` before anything is started, so a shed call has taken no
   * decision, written no node and moved no money.
   */
  readonly maxInFlight: number;
  /**
   * How many cases' parent indexes are held in memory at once.
   *
   * A case resumed in another process holds identifiers, not nodes, so the
   * first write that needs a parent replays that case once and indexes it.
   * Bounding the number of cases is what stops a sweep of 200 suspensions
   * replaying 200 traces on every pass, forever, for cases that may wait
   * months. Least-recently-used eviction; a case's own index is bounded by the
   * store's per-case node ceiling.
   */
  readonly parentIndexCases: number;
}

/**
 * Type-erased so one registry can hold decision points of nineteen different
 * shapes. `DecisionPoint` is contravariant in its input, so there is no
 * non-`any` supertype to erase to; the erasure is confined to this alias and
 * the registry lookup, and the recovered spec is used only through the fields
 * `answer` needs.
 *
 * The effect payload erases to `never`, **not** to `any`, and the difference is
 * load-bearing rather than stylistic. `EffectDeclaration<P>` mentions `P` only
 * in argument position — `redact(payload: P)` and `execute(…, payload: P)` — so
 * it is contravariant in `P`, and the supertype of every `EffectDeclaration<P>`
 * is therefore `EffectDeclaration<never>`. Erasing to `any` inverts that: it
 * asks for a declaration whose `redact` accepts `any`, and `any` is assignable
 * to every type except `never`, so a point declaring **no effect at all** —
 * spelled `DecisionPoint<Input, Verdict, never>`, which is what an ungated
 * point is — did not fit its own registry.
 *
 * Nothing caught that, because `never` is the one payload the shipped code
 * never constructs and the tests that do construct it were not typechecked
 * until this release wired `src/**\/tests/**` into `npm run check`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDecisionPoint = DecisionPoint<any, any, any>;

/**
 * What a deployment must state before this module can judge that an abstention
 * rate *moved*.
 *
 * `docs/CONTEXT.md`'s eighth silent condition is *"abstention rate, or
 * fail-closed screening rate, moves sharply — every individual case behaved
 * exactly as designed"*. This is the abstention half. It is the only condition
 * in this module that is a property of a **window** rather than of a case: a
 * model that started timing out at noon produces two hundred abstentions that
 * are each individually correct, each a working system declining to guess, and
 * together mean this deployment stopped deciding anything.
 *
 * **None of the three has a default, and the whole object is optional.** The
 * right window for a deployment handling eleven cases an hour and one handling
 * eleven thousand are not the same window, and a default here would be this
 * library deciding on nineteen applications' behalf what counts as a sharp move
 * in their domain. Absent, nothing is counted and no window exists; present, the
 * raise goes through `ApprovalDeps.alerting` like every other condition this
 * module detects — including saying `alerted: "not-configured"` on the node when
 * that is absent, rather than looking monitored.
 */
export interface AbstentionRateTerms {
  /**
   * How long a window is, in integer milliseconds. Windows close **lazily** —
   * by the first determination to arrive after the window's end — so a
   * deployment that stops deciding entirely never closes another window and
   * never raises from here. That is correct: **no decisions at all is not a rate
   * movement**, it is a stopped component, and the sweeper's heartbeat and its
   * external watcher are what detect that. Two mechanisms for two different
   * failures.
   */
  readonly windowMs: number;
  /**
   * How big a move is sharp, in basis points of the abstention rate. A move from
   * 4% to 11% is 700. Absolute, so a rate that *collapses* also raises — a
   * deployment that suddenly stops abstaining is either a fix or a confidence
   * floor that quietly went missing, and an operator should decide which.
   */
  readonly moveBasisPoints: number;
  /**
   * The fewest determinations a window must hold before its rate is believed.
   * **Both** windows must reach it: a quiet night followed by a busy morning is
   * not evidence of anything, and an alert built from noise is an alert that
   * gets muted.
   */
  readonly minSample: number;
}

export interface ApprovalDeps {
  /** The trace. Injected, never constructed here. */
  readonly audit: import("../../audit/index.js").Audit;
  /**
   * Every decision point this deployment can resume.
   *
   * Durable resumption needs both halves: the **data** comes from the store,
   * the **code** comes from the deploy. A suspension naming a point this
   * release no longer declares is a named, fail-closed failure rather than a
   * silently dropped case.
   */
  readonly points: readonly AnyDecisionPoint[];
  readonly store: ApprovalStore;
  readonly tierPolicy: TierPolicy;
  /** A separate seam from `tierPolicy`, on purpose. */
  readonly reservedPolicy: ReservedPolicy;
  readonly authorities: AuthorityDirectory;
  readonly renderer: BriefRenderer;
  readonly clients: ClientFactory;
  /** Injected, and deliberately not called a seam. See `index.ts`. */
  readonly killSwitch: KillSwitchReader;
  readonly clock: Clock;
  readonly limits: Limits;
  /** Identifies this process in a lease. Two sweepers must be distinguishable. */
  readonly sweeperId: string;
  /**
   * Where the five silent conditions this module can see are raised.
   *
   * `docs/CONTEXT.md` tabulates eight failures that produce no error, and this
   * module is the only place five of them are visible: a reserved decision that
   * completed unassisted, an effect whose outcome is unrecorded, reminders that
   * stopped firing, a buried case, and `AuthorityUnavailable`. Every one of them
   * **returns success or returns nothing at all**, so none is reachable by
   * catching an exception and none of them was reaching an operator before this
   * parameter existed.
   *
   * **Injected, so a test cannot page anybody.** There is no code path from this
   * package to a network; a chain of sinks arrives as a parameter or the
   * conditions are recorded and not raised.
   *
   * **Optional, and the absence is written down.** Nineteen applications cannot
   * be recompiled at once, and a required parameter would have been satisfied
   * everywhere with a sink that swallows — which is worse than absence, because
   * it looks wired. Where this is absent the detection still happens, still
   * writes its node, and the node says `alerted: "not-configured"`. See
   * `alerts.assertProductionAlerting`, which is what a composition root calls to
   * refuse a chain that pages nobody.
   */
  readonly alerting?: import("../../alerts/index.js").AlertRaiser | undefined;
  /**
   * The window terms for the **sixth** silent condition this module can see:
   * the abstention rate moving sharply. Absent, nothing is counted.
   *
   * Wired here rather than as its own alert seam because the raise goes through
   * `alerting` above — one module paging two different places about conditions
   * drawn from the same case is how an operator ends up with a channel they
   * trust and a channel they do not.
   */
  readonly abstentionRate?: AbstentionRateTerms | undefined;
  /**
   * ⚠ **The sweeper's dead-man's switch, and the watcher for it is external.**
   *
   * The sweeper is the single point of failure for the whole recurrence
   * guarantee: it is what fires reminders. If it stops, nobody is chased,
   * nothing throws, no dashboard turns red, and every waiting case rots in
   * silence — the system doing precisely what reserved decisions exist to
   * prevent while reporting no problem whatsoever.
   *
   * So `sweep` beats **on every run, including runs with nothing to do**, and
   * `HeartbeatRun` has no way to spell "I did not run" — that is the *absence*
   * of a beat, which only something outside this process can see.
   *
   * **This library cannot deliver that one alert.** A watchdog that depends on
   * the thing it watches fails silently at the exact moment it is needed. Wire
   * `alerts.livenessQuery` into a watcher that runs in a different process, and
   * see `alerts.EXTERNAL_WATCHDOG_REQUIREMENT`, which `docs/RUNBOOK.md` must
   * carry verbatim. It is the single instruction most likely to be skipped at
   * deployment and the most expensive to have skipped.
   */
  readonly heartbeat?: import("../../alerts/index.js").Heartbeat | undefined;
  /**
   * Which component the beat is filed under. Defaults to
   * `DEFAULT_SWEEPER_COMPONENT`.
   *
   * Name it per deployment where more than one sweeper runs against one store:
   * two processes beating under one name are indistinguishable from one process
   * beating twice as often, and the survivor of a partial outage would keep the
   * name alive while half the fleet is dead.
   */
  readonly sweeperComponent?: import("../../alerts/index.js").ComponentId | undefined;
}

/* --------------------------------------------------------------------- results */

export interface RunContext {
  readonly correlationId: CorrelationId;
  /** Optional. Supply it to record caller-side fan-out structure explicitly. */
  readonly parent?: NodeId;
}

export interface AnsweringContext {
  readonly authority: Authority;
}

export type ApproverAnswer =
  | { readonly choice: "approve"; readonly reason: string }
  | { readonly choice: "refuse"; readonly reason: string };

/**
 * `authorityTransferred` is the raw fact — did authority over this decision
 * move to a human. It is deliberately **not** called `unassistedContainment`:
 * unassisted containment is a property of a *case* observed at close, and
 * naming it here would be exactly the conflation `CONTEXT.md` spends four pages
 * preventing.
 */
export type Settled<V> =
  | {
      readonly kind: "executed";
      readonly verdict: V;
      readonly effect: EffectOutcome;
      readonly authorityTransferred: boolean;
      readonly node: NodeId;
    }
  | {
      readonly kind: "no-effect";
      readonly verdict: V;
      readonly authorityTransferred: boolean;
      readonly node: NodeId;
    }
  | {
      readonly kind: "abstained";
      readonly reason: string;
      readonly authorityTransferred: boolean;
      readonly node: NodeId;
    }
  | {
      readonly kind: "refused";
      readonly by: AuthorityId;
      readonly reason: string;
      readonly node: NodeId;
    }
  | {
      /**
       * A non-reserved decision reached its declared expiry with nobody having
       * answered. Its own arm, never folded into `refused`: "nobody decided"
       * and "an authority decided against it" are different facts, and
       * `CONTEXT.md` rule 7 forbids collapsing them. A reserved decision can
       * never reach this arm — the expiry branch is deleted, not disabled.
       */
      readonly kind: "expired";
      readonly reason: string;
      readonly node: NodeId;
    }
  | {
      readonly kind: "held";
      readonly reason: string;
      readonly node: NodeId;
    };

/**
 * Awaiting an authority. **Not terminal, and never contained.** There is no
 * `await` on this value that produces an answer — the human answers through
 * `approval.answer`, in another process, possibly days later.
 *
 * A retried `run` returns this **only** while the suspension really is
 * awaiting. A case that was executed, refused, expired or held comes back as
 * the matching `Settled` arm. Returning `Suspended` for a settled case told
 * nineteen callers' state machines that a human-refused case still needed a
 * human, and `awaiting_authority` is precisely the state that is never
 * terminal and never contained.
 */
export interface Suspended {
  readonly kind: "suspended";
  readonly suspension: SuspensionId;
  readonly seat: "first" | "second";
  readonly pool: AuthorityPoolId;
  /** `null` means indefinite hold. Always `null` for a reserved decision. */
  readonly expiresAt: Instant | null;
  readonly doNothing: ServedDoNothing;
  readonly node: NodeId;
}

export interface SweepReport {
  readonly examined: number;
  readonly remindersSent: number;
  /**
   * Expiries that were **persisted**. A lost compare-and-set is counted in
   * `raceLost` and not here, so this figure never reports an expiry that did
   * not durably happen.
   */
  readonly expired: number;
  /** Briefs delivered by this sweep that had never been delivered before. */
  readonly presented: number;
  /**
   * Kill-switch holds that were **persisted back to `awaiting`** because the
   * switch was found disengaged. Counted only when the compare-and-set held, so
   * this figure never reports a release that did not durably happen.
   */
  readonly holdsReleased: number;
  /** Suspensions another sweeper held a live lease on. Not an error. */
  readonly skippedLeased: number;
  /**
   * Suspensions a concurrent writer changed between this sweep's read and its
   * write. Not an error and not an expiry: the work is simply redone next pass.
   */
  readonly raceLost: number;
  /**
   * One node per case the sweep touched.
   *
   * There is deliberately no single node for the sweep *itself*: a trace is
   * per-correlation-identifier and a sweep spans many cases, so a
   * "sweep started" node would have no case to belong to. The honest scope of
   * the guarantee is therefore: every ladder firing is recorded on the case it
   * belongs to, and the sweeper's own lifecycle is not in any trace. That is
   * stated here rather than papered over.
   */
  readonly nodes: readonly NodeId[];
  /**
   * What became of this run's heartbeat — the sweeper's proof that it is still
   * alive, emitted on **every** run including this one if it found nothing.
   *
   * It is on the report rather than swallowed because a beat that failed is not
   * a small thing: a component that is running but cannot record that it is
   * running will be declared dead by an external watcher, and the operator woken
   * at 3am will find a healthy sweeper and learn to distrust the alert. Naming
   * it here is what lets a caller tell the two apart.
   *
   *   `did-work`         Beat recorded; this sweep touched at least one case.
   *   `nothing-was-due`  Beat recorded; there was nothing to do. **Not the same
   *                      fact as not running**, and that is the whole reason the
   *                      heartbeat exists.
   *   `not-configured`   No `heartbeat` was wired. Nothing is watching this
   *                      sweeper, and the deployment is one process death away
   *                      from every waiting case rotting in silence.
   *   `failed`           The store refused the beat. The sweep still completed;
   *                      the liveness record did not move.
   */
  readonly heartbeat: "did-work" | "nothing-was-due" | "not-configured" | "failed";
}

/* -------------------------------------------------------- reconciling the link */

/**
 * The two ways a suspension and its trace node can disagree.
 *
 * **They can disagree because they do not share a transaction, and they cannot
 * be made to.** A suspension is written through `ApprovalStore`; its nodes are
 * written through `audit`, whose interface exposes no transaction and never
 * will — and even if it did, the transaction would have to span `decide`, which
 * means holding a pooled database connection open across a model call. So the
 * link is written **twice, on both sides**: the durable record carries
 * `suspendNode` and `runNode`, and the `approval.suspend.begin` node carries the
 * suspension identifier. Neither write can invent the other, and a crash
 * between them therefore loses a *row*, never the link itself — which is what
 * makes the disagreement findable instead of silent.
 */
export type LinkDivergenceKind =
  /**
   * The trace records an intent to suspend and no durable suspension exists.
   * The dangerous one: `run` returned a `SuspensionId` nobody can answer,
   * `sweep` will never see it, and nothing errored.
   */
  | "trace-without-suspension"
  /**
   * A durable suspension names a node the trace does not contain. The case is
   * still answerable — but every later node loses its parent, so the ageing of
   * a case that waited eleven days stops being provable from its own trace.
   */
  | "suspension-without-trace";

export interface LinkDivergence {
  readonly kind: LinkDivergenceKind;
  readonly correlationId: CorrelationId;
  readonly suspension: SuspensionId;
  /** The node named by whichever side has one, or `null` when neither does. */
  readonly node: NodeId | null;
  readonly pointId: string;
  /**
   * What closes it.
   *
   * `re-run` — the application calls `run` again for this case and point.
   * `run` is idempotent per (case, point, effect payload), so a re-run either
   * rejoins the existing suspension or recreates the one that was lost, and it
   * cannot ask a second person the same question.
   *
   * `repaired` — this pass fixed it. Only ever the `suspension-without-trace`
   * direction: the divergence node this pass wrote becomes the record's parent,
   * so the case's later nodes are parented again. Nothing in the trace is
   * rewritten; a node is added, which is the only edit an append-only archive
   * permits.
   */
  readonly recovery: "re-run" | "repaired";
}

export interface ReconciliationReport {
  /** Cases compared. Bounded by `limits.reconcileBatch`. */
  readonly examined: number;
  /** Suspensions compared across both sides. */
  readonly compared: number;
  readonly divergences: readonly LinkDivergence[];
  /**
   * Cases whose trace could not be read at all, so no comparison was possible.
   *
   * Reported rather than counted as clean: "we looked and everything agreed"
   * and "we could not look" are different facts, and a reconciliation that
   * collapses them is a green dashboard for an unread archive.
   */
  readonly unreadable: readonly CorrelationId[];
}

export interface Approval {
  run<In, V, P>(
    point: DecisionPoint<In, V, P>,
    input: In,
    ctx: RunContext,
  ): Promise<Settled<V> | Suspended>;
  answer(
    suspension: SuspensionId,
    answer: ApproverAnswer,
    ctx: AnsweringContext,
  ): Promise<Settled<unknown> | Suspended>;
  sweep(request: { readonly limit: number }): Promise<SweepReport>;
  inDoubt(): Promise<readonly IdempotencyClaim[]>;
  /**
   * The reconciliation queue for the **link**, as `inDoubt` is the
   * reconciliation queue for **effects**.
   *
   * Takes the cases to compare rather than discovering them: neither seam can
   * enumerate cases — `audit` has no "list every trace" and it should not, and
   * a store scan would be an unbounded read of a seven-year archive. The
   * application holds its own open cases and passes them in, bounded.
   */
  reconcile(request: {
    readonly cases: readonly CorrelationId[];
  }): Promise<ReconciliationReport>;
}
