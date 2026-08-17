import type { Archivist } from "./retention.js";
import type {
  AppendAck,
  AppendInput,
  Audit,
  CaseTrace,
  CorrelationId,
  Degraded,
  RecordedNode,
  RecordResult,
  RetentionRegister,
  RiskTier,
  StoredCase,
  TracePage,
  TracePageRequest,
  TraceStore,
  TraceProvenance,
  UnassistedContainment,
  UnavailabilityPolicy,
  Witness,
  WitnessRecord,
  WitnessReceipt,
} from "./types.js";

/**
 * Compile-time assertions about this module's load-bearing types.
 *
 * These live in shipped code rather than in `tests/` on purpose: `tsc --build`
 * runs on every commit and typechecks this file, whereas the test folder is
 * excluded from the build. A guarantee that only holds when somebody remembers
 * to run a typecheck-mode test runner is a guarantee held by convention, and
 * this module does not do convention.
 *
 * Nothing here emits a runtime value. None of it is re-exported from
 * `index.ts`; it is private to the module like the rest of `lib/`.
 */

type Assert<T extends true> = T;

/**
 * A high-tier decision cannot be configured to proceed unrecorded. This is the
 * same doctrine as reserved decisions: structural, never a setting.
 */
export type HighTierCannotDegrade = Assert<
  "degrade" extends UnavailabilityPolicy["high"] ? false : true
>;

/** …and the caller must still write it, so a reader confronts the choice. */
export type PolicyIsRequiredForEveryTier = Assert<
  RiskTier extends keyof UnavailabilityPolicy ? true : false
>;

/** At high tier, "it proceeded without a trace" is not a value that exists. */
export type HighTierRecordIsAlwaysRecorded = Assert<
  Degraded extends RecordResult<"high"> ? false : true
>;

/** Below high tier it is, so the caller has to look at it. */
export type LowTierRecordMayBeDegraded = Assert<
  Degraded extends RecordResult<"low"> ? true : false
>;

/** A degraded result can never claim a tier that forbids degrading. */
export type DegradedIsNeverHighTier = Assert<
  Degraded["tier"] extends "high" ? false : true
>;

/**
 * The store seam cannot be impersonated by an object literal.
 *
 * This is the shape an adversarial reviewer supplied — the eight-line
 * `nowhere` store that writes nothing, fabricates its own sequence and returns
 * empty canonical bytes. It typechecked cleanly under this project's own flags
 * and reported `recorded: true` for a £2M `payment.authorised`.
 * `docs/design/OPEN-ITEMS-RESOLVED.md` item 1 declared that resolved by
 * branding; the brand is now actually there, and this assertion fails the build
 * if it is ever removed.
 */
interface StructuralStoreImpostor {
  openCase(correlationId: CorrelationId, provenance: TraceProvenance): Promise<void>;
  append(input: AppendInput): Promise<AppendAck>;
  closeCase(
    correlationId: CorrelationId,
    at: number,
    outcome: UnassistedContainment,
  ): Promise<RecordedNode>;
  read(correlationId: CorrelationId): Promise<StoredCase | undefined>;
  readPage(request: TracePageRequest): Promise<TracePage | undefined>;
}

export type ImpostorStoreDoesNotTypecheck = Assert<
  StructuralStoreImpostor extends TraceStore ? false : true
>;

/**
 * …and a real store still satisfies the interface it is branded with, so the
 * brand is a lock rather than a wall. If this ever fails, the brand has been
 * applied somewhere a legitimate adapter cannot reach.
 */
export type BrandedStoreIsStillAStore = Assert<
  TraceStore extends StructuralStoreImpostor ? true : false
>;

/**
 * The recorder itself cannot be impersonated by an object literal either —
 * `README.md` item 8, "`Audit` is the one unbranded witness", closed.
 *
 * This is the shape that used to typecheck: a fully-typed recorder that
 * acknowledges every write, persists nothing, and replays an empty case.
 * `guardrails` takes one of these as `GuardrailsDeps.audit` and had to prove its
 * first node by replay to discover it was talking to nothing. It still does —
 * the runtime check is the one that catches a deliberate `as unknown as Audit`
 * — but the accidental version no longer compiles.
 */
interface StructuralAuditImpostor {
  open(correlationId: CorrelationId): Promise<CaseTrace>;
  replay(correlationId: CorrelationId): Promise<import("./types.js").ReplayedCase>;
  walk(
    correlationId: CorrelationId,
    limits?: Partial<import("./types.js").WalkLimits>,
  ): AsyncGenerator<RecordedNode, import("./types.js").TraceVerdict, undefined>;
  witness(
    correlationId: CorrelationId,
    limits?: Partial<import("./types.js").WalkLimits>,
  ): Promise<WitnessReceipt>;
  verifyAgainstWitness(
    correlationId: CorrelationId,
    limits?: Partial<import("./types.js").WalkLimits>,
  ): Promise<import("./types.js").WitnessVerdict>;
}

export type ImpostorAuditDoesNotTypecheck = Assert<
  StructuralAuditImpostor extends Audit ? false : true
>;

/** …and `createAudit`'s return value still satisfies every verb it declares. */
export type BrandedAuditIsStillAnAudit = Assert<
  Audit extends StructuralAuditImpostor ? true : false
>;

/**
 * A deduplicated acknowledgement is a first-class answer, not a boolean bolted
 * onto the node. If `AppendAck` ever loses it, a store can report a write it did
 * not make and `createAudit` has no way to tell.
 */
export type AppendAckStatesWhetherItWrote = Assert<
  AppendAck extends { readonly deduplicated: boolean } ? true : false
>;

/**
 * The vocabulary rule holds in the type name, not only in the field name.
 * `docs/CONTEXT.md` rule 4: bare `containment` is not a valid identifier
 * anywhere, and a type name spreads further than a field name because it is in
 * the signature nineteen callers must learn.
 */
export type OutcomeCarriesTheQualifier = Assert<
  UnassistedContainment extends { readonly unassistedContainment: boolean }
    ? true
    : false
>;

/**
 * Names that would mean removal. Listed once and applied to three interfaces,
 * so the rule is checkable rather than a habit.
 */
type RemovingVerb =
  | "delete"
  | "remove"
  | "purge"
  | "expire"
  | "drop"
  | "truncate"
  | "erase"
  | "destroy";

type HasNoRemovingVerb<T> = Extract<keyof T, RemovingVerb> extends never ? true : false;

/**
 * **The append-only guarantee, as a build failure rather than as a habit.**
 *
 * The trace tables grant no role this library creates the ability to delete, and
 * the reason those grants can stay that way is that no interface here has a verb
 * that would want one. Adding `expire(correlationId)` to `TraceStore` would look
 * like a small convenience and would require a DELETE grant on the role nineteen
 * applications hold all day. This fails the build first.
 */
export type StoreCannotRemove = Assert<HasNoRemovingVerb<TraceStore>>;

/**
 * The same rule where it is most tempting to break it. The retention interfaces
 * exist *because* something eventually has to be removed; the point of them is
 * that the something is a separately-authorised procedure and not this library.
 * See `lib/retention.ts`.
 */
export type RegisterCannotRemove = Assert<HasNoRemovingVerb<RetentionRegister>>;
export type ArchivistCannotRemove = Assert<HasNoRemovingVerb<Archivist>>;

/**
 * The witness seam cannot be impersonated either, and for a sharper reason than
 * the store's: a structural impostor here would not fail loudly, it would report
 * every case as agreeing with a witness that never existed.
 */
interface StructuralWitnessImpostor {
  readonly id: string;
  publish(record: WitnessRecord): Promise<WitnessReceipt>;
  lookUp(correlationId: CorrelationId): Promise<WitnessRecord | undefined>;
}

export type ImpostorWitnessDoesNotTypecheck = Assert<
  StructuralWitnessImpostor extends Witness ? false : true
>;

/** …and a real witness still satisfies the shape it is branded with. */
export type BrandedWitnessIsStillAWitness = Assert<
  Witness extends StructuralWitnessImpostor ? true : false
>;

/**
 * A witness record carries a digest, a count and a time — and no payload. The
 * assertion is here because a witness may be under someone else's custody, and
 * the field that leaks personal data to a third party is the field somebody adds
 * later "just for debugging".
 */
export type WitnessCarriesNoPayload = Assert<
  "payload" extends keyof WitnessRecord ? false : true
>;
