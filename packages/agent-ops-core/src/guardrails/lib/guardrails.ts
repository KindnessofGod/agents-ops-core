import {
  DetectorSetEmpty,
  LimitsInvalid,
  LocaleUnsupported,
  OutputCheckOutOfOrder,
} from "./errors.js";
import { createRateWatch } from "./rate-watch.js";
import { recorderFor, witnessLedger } from "./recorder.js";
import { SETTLED_NODE, runScreening } from "./screening.js";
import type { NodeId } from "../../audit/index.js";
import type {
  DetectorSet,
  DetectorSets,
  Guardrails,
  GuardrailsDeps,
  InputScreeningRequest,
  Limits,
  OutputCheckRequest,
  Screening,
} from "./types.js";

/**
 * The composition root's one call.
 *
 * Everything is checked here, at construction, rather than at screening time.
 * The reason is the failure mode: a detector wired into the wrong jurisdiction
 * does not error when it runs, it finds nothing — and finding nothing is
 * indistinguishable from a clean payload unless somebody reads the wiring. So a
 * compliance incident becomes a boot failure, which is the loudest cheap place
 * to put it. The same argument applies to `Limits`: a bound that silently
 * changes an answer — `maxFindingsPerScreening: 0` turning a `block` into an
 * `allow` — is a defect that presents as a clean screening.
 */
export const createGuardrails = (deps: GuardrailsDeps): Guardrails => {
  checkLimits(deps.limits);
  for (const tier of ["low", "medium", "high"] as const) {
    const set = deps.detectorSets[tier];
    checkSet(set, deps);
  }

  const sets: DetectorSets = deps.detectorSets;
  /**
   * Which cases have had their recording witness proven, bounded. Held here so
   * the proof is per constructed `Guardrails` — a second composition root with a
   * second witness proves that witness separately.
   */
  const ledger = witnessLedger();

  /**
   * The fail-closed rate watch, or nothing.
   *
   * Constructed once per `Guardrails` rather than per screening, because the
   * whole point of it is state that outlives a case. A second composition root
   * watches its own windows — which is right: two deployments screening
   * different traffic through different detector sets do not share a baseline.
   */
  const rates =
    deps.rateAlerting === undefined
      ? undefined
      : createRateWatch(deps.rateAlerting);

  /**
   * Every screening passes through here on its way back to the caller.
   *
   * The alert this can raise is `rate-moved-sharply`, and it is the one
   * condition in this library that is **deliberately not recorded as a node**.
   * A rate movement is a property of a window over a population, not of a case,
   * and `alerts.correlationOf` returns `undefined` for it for exactly that
   * reason. Writing it onto whichever case happened to be screening when the
   * window closed would attribute a population fact to one arbitrary claim, and
   * a reader in 2033 would reasonably conclude that claim had something to do
   * with it. The record of the raise lives where the condition lives: in
   * `alerts.health()` and on the operational stream.
   *
   * A failure to observe never costs a screening. The screening is complete and
   * correct by the time this runs; losing it because a counter or a sink misfired
   * would trade a real answer for a statistic about answers.
   */
  const observed = async (screening: Screening): Promise<Screening> => {
    if (rates !== undefined) {
      try {
        await rates.observe(screening, deps.clock.now());
      } catch {
        // `raiseAndRecord` does not throw, so reaching here means the clock or
        // the counter did — a defect, and one that must not eat the screening.
      }
    }
    return screening;
  };

  return {
    async screenInput(request: InputScreeningRequest): Promise<Screening> {
      const recorder = await recorderFor(
        deps.audit,
        request.correlationId,
        ledger,
      );
      // A `Screening` carries its own settled node, so parenting to it costs
      // nothing. A bare `NodeId` costs one replay — see `InputScreeningRequest`.
      let under: NodeId | undefined;
      if (typeof request.under === "string") {
        under = request.under;
      } else if (request.under !== undefined) {
        recorder.index(request.under[SETTLED_NODE]);
        under = request.under.nodes.settled;
      }
      return await observed(
        await runScreening({
          recorder,
          clock: deps.clock,
          timer: deps.timer,
          limits: deps.limits,
          locale: deps.locale,
          phase: "input",
          tier: request.tier,
          set: sets[request.tier],
          payload: request.payload,
          // An input has nothing to be grounded against, and saying so in the
          // same shape the output path uses keeps one code path rather than two.
          sources: {
            available: false,
            why: "not applicable: an input screening has no reference material",
          },
          under,
        }),
      );
    },

    async checkOutput(request: OutputCheckRequest): Promise<Screening> {
      // `after` is required and unforgeable, which is half of what makes the
      // ordering constraint structural. The other half is this check: the brand
      // proves *something* was screened, and the stated invariant is stronger —
      // `screenInput` strictly before the decision, `checkOutput` strictly after
      // it. An output screening chained onto another output screening satisfies
      // the brand and not the invariant, so it is refused rather than accepted
      // and quietly recorded as though the ordering held.
      if (request.after.phase !== "input") {
        throw new OutputCheckOutOfOrder(request.after.phase);
      }
      const recorder = await recorderFor(
        deps.audit,
        request.after.correlationId,
        ledger,
      );
      // The settled node of `after` travels **on** the screening, behind a
      // symbol this module does not export. Without it, every `checkOutput`
      // replayed the whole case to turn one `NodeId` back into the
      // `RecordedNode` that `audit.record` requires as a parent — a read that
      // grows without limit in the size of the case, on the hot path before
      // every effect, in a module whose stated bounds discipline is "no
      // unbounded anything". Passing the node itself is the fix; the replay
      // remains only for a foreign `under`, where there is genuinely nothing
      // else to go on.
      recorder.index(request.after[SETTLED_NODE]);
      return await observed(
        await runScreening({
          recorder,
          clock: deps.clock,
          timer: deps.timer,
          limits: deps.limits,
          locale: deps.locale,
          phase: "output",
          tier: request.tier,
          set: sets[request.tier],
          payload: request.output,
          sources: request.sources,
          under: request.after.nodes.settled,
        }),
      );
    },
  };
};

const checkSet = (set: DetectorSet, deps: GuardrailsDeps): void => {
  for (const phase of ["input", "output"] as const) {
    const detectors = set[phase];
    if (!Array.isArray(detectors) || detectors.length === 0) {
      throw new DetectorSetEmpty(set.id, phase);
    }
    for (const detector of detectors) {
      if (!detector.locales.includes(deps.locale)) {
        throw new LocaleUnsupported(detector.id, deps.locale, detector.locales);
      }
    }
  }
};

/**
 * Every bound is a positive safe integer, checked at construction.
 *
 * Zero is excluded from all of them deliberately, and
 * `maxFindingsPerScreening` is the one that shows why: at zero the finding list
 * truncated to nothing, the grounds were built from the truncated list, and a
 * `block` finding produced a settled node reading `recommend=allow` with
 * `searched=...`. A bound whose extreme value changes the answer rather than
 * the report is not a bound.
 */
const LIMIT_FIELDS: readonly (keyof Limits)[] = [
  "detectorConcurrency",
  "detectorBudgetMicros",
  "maxFields",
  "maxFieldChars",
  "maxRecordedFieldChars",
  "maxFindingsPerScreening",
  "maxClaims",
  "maxSources",
];

const checkLimits = (limits: Limits): void => {
  for (const field of LIMIT_FIELDS) {
    const value: unknown = limits[field];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new LimitsInvalid(field, value);
    }
  }
};
