import type {
  AppendInput,
  CorrelationId,
  Degraded,
  RecordedNode,
  RecordResult,
  RiskTier,
  StoredCase,
  TraceStore,
  TraceProvenance,
  UnassistedContainment,
  UnavailabilityPolicy,
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
  append(input: AppendInput): Promise<RecordedNode>;
  closeCase(
    correlationId: CorrelationId,
    at: number,
    outcome: UnassistedContainment,
  ): Promise<RecordedNode>;
  read(correlationId: CorrelationId): Promise<StoredCase | undefined>;
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
