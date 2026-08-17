import { LicenceValidityUnusable } from "./errors.js";
import type { DecisionPoint, DecisionPointSpec } from "./types.js";

/**
 * Declare a decision point.
 *
 * The caller declares; the module drives. `classify`, `handle`, `authorise` and
 * `execute` are not discouraged out of order — they are **absent from the
 * interface**. There is nothing to call in the wrong order and nothing to skip,
 * which is how total auditability holds by absence rather than by discipline.
 *
 * Per the inversion in `FINDINGS.md` there is no shortened low-tier form: both
 * arms of `DecisionPointSpec` are discriminated by type rather than one of them
 * being abbreviated for the common caller, and **no `decide` receives a
 * write-capable client at any tier**. All effects go through a declared
 * `EffectDeclaration`.
 */
const assertLicenceValidity = (pointId: string, declared: number): void => {
  if (!Number.isSafeInteger(declared) || declared <= 0) {
    throw new LicenceValidityUnusable(pointId, declared);
  }
};

export const defineDecisionPoint = <In, V, P>(
  spec: DecisionPointSpec<In, V, P>,
): DecisionPoint<In, V, P> => {
  // Declaration-time, fail-closed. A licence valid for zero milliseconds is
  // expired at the instant it is minted, and a validity nothing can satisfy
  // makes the staleness check vacuous rather than strict.
  if (spec.gate === "human") assertLicenceValidity(spec.id, spec.licenceValidFor);
  else if (spec.effect.kind === "delegated") {
    assertLicenceValidity(spec.id, spec.effect.licenceValidFor);
  }
  return Object.freeze({
    id: spec.id,
    spec,
  }) as DecisionPoint<In, V, P>;
};
