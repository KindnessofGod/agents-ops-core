import type { NodeId, NodePayload, NodeTelemetry, RiskTier } from "../../audit/index.js";
import { GUARDRAILS_PAYLOAD_VERSION as V, NODE, digest, isBasisPoints } from "./canonical.js";
import {
  DetectorReportInvalid,
  ScreeningLimitExceeded,
  ScreeningPayloadInvalid,
} from "./errors.js";
import { SETTLED_NODE } from "./mint.js";
import type { Recorder } from "./recorder.js";
import {
  frozenSources,
  frozenView,
  maskFindings,
  mintScreenedPayload,
  unscreenableField,
} from "./subject.js";
import type {
  Clock,
  Detector,
  DetectorReport,
  DetectorRun,
  DetectorSet,
  DetectorSpend,
  DetectorUnavailableReason,
  Finding,
  FindingDraft,
  Findings,
  Ground,
  Limits,
  Locale,
  NonEmpty,
  Payload,
  RecommendedDisposition,
  Screening,
  ScreeningPhase,
  Sources,
  Timer,
} from "./types.js";

declare const SCREENING_MINT: unique symbol;

export { SETTLED_NODE };

/**
 * What the engine works with, which is wider than what a detector may return.
 *
 * A detector's own `unavailable` may only say `"declared"` — it can report that
 * its dependency is down, and nothing else. `"threw"`, `"timed-out"` and
 * `"malformed"` are the engine's observations *about* a detector, and a
 * detector must not be able to claim them: a detector that reported itself
 * timed out would be describing a race it did not run, and one that reported
 * itself malformed would be choosing its own incident classification.
 *
 * `costTenthCents` and `modelCalls` are `undefined` where the engine genuinely
 * does not know — a detector that threw, or one that never answered. That is
 * **not** the same as zero, and recording it as zero is what made real spend
 * invisible on exactly the paths where money is most likely to have been spent.
 */
type ObservedReport =
  | Exclude<DetectorReport, { outcome: "unavailable" }>
  | {
      readonly outcome: "unavailable";
      readonly reason: DetectorUnavailableReason;
      readonly detail: string;
      readonly costTenthCents: number | undefined;
      readonly modelCalls: number | undefined;
      readonly spend?: DetectorSpend;
    };

/**
 * The engine. One function, run by both entry points.
 *
 * ## How an unrecorded screening is made unrepresentable
 *
 * The order below is the mechanism, not a convention:
 *
 *   1. Bounds and payload shape are checked. An oversized or unscreenable
 *      payload is refused before anything runs.
 *   2. The **opened** node is written. If that write fails, `ScreeningNotRecorded`
 *      is thrown and no detector has run. There is no path on which a detector
 *      executes before its screening exists in the trace.
 *   3. The write is **proven by replay**, once per case per process. A witness
 *      that acknowledges and persists nothing fails here — see
 *      `recorder.proveWrite`, which also states exactly what that proof does not
 *      cover.
 *   4. Each detector runs and its **own** node is written, parented to the opened
 *      node, as it completes. A process that dies mid-screening leaves the
 *      opened node and the detectors that finished — evidence of an incomplete
 *      screening rather than silence. A screening that *fails* writes an
 *      **abandoned** node and stops, so the trace does not keep growing after the
 *      caller has been told it failed.
 *   5. The redacted **payload** node, then the **settled** node, then one node
 *      per reported finding.
 *   6. Only then is a `Screening` minted. Its brand is a non-exported `unique
 *      symbol`, so the caller cannot construct one; and the redacted
 *      `ScreenedPayload` — the only form of the payload this module lets out —
 *      is reachable only through it.
 *
 * A caller that wants the screened payload has therefore already caused every
 * node to be written *and* had the witness that wrote them corroborated.
 *
 * **Where the guarantee stops.** Three limits, all real and none of them
 * papered over. Application code holds the original payload it passed in and can
 * send it anywhere; no type in this package reaches outside this package.
 * Nothing here can see effects, so "checkOutput strictly before any effect" is
 * enforced only as far as `checkOutput` requiring an *input* `Screening` — the
 * effect side belongs to `approval`. And `GuardrailsDeps.audit` is a structural
 * interface: replay corroborates it, a brand would settle it, and that brand is
 * `audit`'s to mint.
 *
 * ## Two passes, and why a model detector runs second
 *
 * Detectors run in two rounds: every `deterministic` detector first, over the
 * caller's text; then masking; then every `model` detector, over the **masked**
 * text. The reason is blunt — a model detector reaches a third party, and
 * masking used to run strictly after every detector returned, so every
 * model-class detector shipped unredacted personal data out of the process on
 * every high-tier screening.
 *
 * What this costs, stated rather than hidden: model detectors no longer overlap
 * with deterministic ones, so a screening's latency is the deterministic round
 * plus the model round rather than the maximum of the two. Deterministic
 * detectors are sub-millisecond, so the cost is small and the alternative was
 * not defensible.
 *
 * What it does not do: the redaction available to the second round is whatever
 * the first round found. A set with no deterministic detector hands the model
 * the original text, and the detector node records which view it saw so a reader
 * never has to guess.
 */

export interface ScreeningRun {
  readonly recorder: Recorder;
  readonly clock: Clock;
  readonly timer: Timer;
  readonly limits: Limits;
  readonly locale: Locale;
  readonly phase: ScreeningPhase;
  readonly tier: RiskTier;
  readonly set: DetectorSet;
  readonly payload: Payload;
  readonly sources: Sources;
  readonly under: NodeId | undefined;
}

export const runScreening = async (run: ScreeningRun): Promise<Screening> => {
  const { recorder, clock, limits, tier, set, payload, phase } = run;

  const fields = Object.keys(payload);
  if (fields.length > limits.maxFields) {
    throw new ScreeningLimitExceeded("maxFields", limits.maxFields, fields.length);
  }
  const unscreenable = unscreenableField(payload);
  if (unscreenable !== undefined) {
    throw new ScreeningPayloadInvalid(unscreenable.field, unscreenable.detail);
  }
  let totalChars = 0;
  for (const field of fields) {
    const length = (payload[field] as string).length;
    if (length > limits.maxFieldChars) {
      throw new ScreeningLimitExceeded("maxFieldChars", limits.maxFieldChars, length);
    }
    totalChars += length;
  }

  // A frozen, copied view of the reference material, built once and shared. A
  // detector cannot rewrite what a sibling is judged against, and the caller's
  // own array is not the one anybody holds.
  const sources = frozenSources(run.sources);
  const detectors = phase === "input" ? set.input : set.output;
  const startedAt = clock.now();

  // Step 2. Nothing runs until this node exists.
  const opened = await recorder.record(
    {
      kind: NODE.opened,
      v: V,
      phase,
      tier,
      locale: run.locale,
      detectorSet: set.id,
      detectorIds: detectors.map((d) => d.id).join(","),
      detectorCount: detectors.length,
      fieldCount: fields.length,
      payloadChars: totalChars,
      sourcesAvailable: sources.available,
      sourceCount: sources.available ? sources.items.length : 0,
      // The scope of the evidence, stamped onto the evidence. `audit` stamps
      // `capturedVia: "injected-trace-store-only"` on the case for the same
      // reason; this is the same sentence one layer up, and it is the honest
      // one: the witness that wrote this node is caller-supplied and structural,
      // and no brand in this package prevents a caller supplying another.
      capturedVia: "caller-supplied-audit-witness",
    },
    tier,
    run.under,
  );

  // Step 3. **Replay is the proof of a write.** Before any detector is asked to
  // search, the case is replayed once and the opened node found in it.
  const witnessProof = await recorder.proveWrite(opened);

  const state: PassState = {
    runs: [],
    drafts: [],
    grounds: [],
    searched: [],
  };

  // ---- Pass 1: the deterministic round, over the caller's text --------------
  const deterministic = detectors.filter((d) => d.costClass !== "model");
  const modelled = detectors.filter((d) => d.costClass === "model");

  const originalView = frozenView(payload);
  await runPass(run, opened.id, deterministic, originalView, "original", sources, state);

  const firstMask = maskFindings(payload, state.drafts);

  // ---- Pass 2: the model round, over the masked text ------------------------
  const secondView = frozenView(firstMask.fields);
  const beforeSecondPass = state.drafts.length;
  await runPass(run, opened.id, modelled, secondView, "post-redaction", sources, state);
  const secondPassDrafts = state.drafts.slice(beforeSecondPass);
  const secondMask = maskFindings(firstMask.fields, secondPassDrafts);

  const masked = {
    fields: secondMask.fields,
    maskedSites: firstMask.maskedSites + secondMask.maskedSites,
  };

  // **Grounds are built from every draft, not from the kept list.** Truncating
  // first and then reading the recommendation off the truncation is how a
  // `block` became an `allow`: the finding list is a report, and a report is not
  // where a disposition comes from.
  const kept = rank(state.drafts).slice(0, limits.maxFindingsPerScreening);
  const truncated = state.drafts.length - kept.length;

  if (phase === "output" && !sources.available) {
    // Cannot check is never pass. This is the engine's own ground, not a
    // detector's, so it holds whether or not a groundedness detector is wired
    // in — "we could not check, so we allowed it" is the failure this module
    // exists to prevent.
    state.grounds.push({ ground: "sources-missing", why: sources.why });
  }
  for (const finding of state.drafts) {
    if (finding.severity === "escalate" || finding.severity === "block") {
      state.grounds.push({
        ground: "finding",
        detector: finding.detector,
        rule: finding.rule,
        category: finding.category,
        severity: finding.severity,
      });
    }
  }

  const findings = summarise(kept, state.drafts.length, state.searched, state.runs.length);
  const recommended = recommend(state.grounds, masked.maskedSites);

  const payloadNode: Record<string, string | number | boolean> = {
    kind: NODE.payload,
    v: V,
    maskedSites: masked.maskedSites,
    fieldCount: fields.length,
    recordedFieldChars: limits.maxRecordedFieldChars,
  };
  for (const field of fields) {
    const value = masked.fields[field] as string;
    // The **detected sites** never reach a store: what is recorded here is the
    // masked form, bounded, and the digest covers the whole masked value so
    // truncation is visible rather than silent. Text no detector flagged is
    // recorded verbatim — see `subject.ts` for that residual risk and the two
    // things that shrink it.
    payloadNode[`f.${field}`] = value.slice(0, limits.maxRecordedFieldChars);
    payloadNode[`d.${field}`] = digest(value);
  }
  await recorder.record(payloadNode as unknown as NodePayload, tier, opened.id);

  const cost = state.runs.reduce(
    (acc, r) => ({
      costTenthCents: acc.costTenthCents + r.costTenthCents,
      latencyMicros: Math.max(acc.latencyMicros, r.latencyMicros),
      modelCalls: acc.modelCalls + r.modelCalls,
      unmeasuredDetectors: acc.unmeasuredDetectors + (r.costMeasured ? 0 : 1),
    }),
    { costTenthCents: 0, latencyMicros: 0, modelCalls: 0, unmeasuredDetectors: 0 },
  );
  const settledAt = clock.now();
  const wallMicros = Math.max(0, settledAt - startedAt) * 1000;

  const settled = await recorder.record(
    {
      kind: NODE.settled,
      v: V,
      phase,
      tier,
      // How the witness that wrote these nodes was proven, so the strength of
      // the evidence is readable from the evidence rather than from prose.
      witnessProof,
      recommend: recommended.recommend,
      findingCount: kept.length,
      findingsTruncated: truncated,
      searched: "searchedAndFoundNone" in findings ? findings.searchedAndFoundNone.searched : "",
      couldNotSearch: "couldNotSearch" in findings ? findings.couldNotSearch.why : "",
      groundKinds: state.grounds.map((g) => g.ground).join(","),
      detectorsRun: state.runs.length,
      detectorsUnavailable: state.runs.filter((r) => r.outcome === "unavailable").length,
      maskedSites: masked.maskedSites,
      costTenthCents: cost.costTenthCents,
      modelCalls: cost.modelCalls,
      // How many detectors could not say what they spent. Zero cost and unknown
      // cost are different sentences and the trace says which one this is.
      costUnmeasuredDetectors: cost.unmeasuredDetectors,
      // Wall-clock across the whole screening, from the injected clock.
      latencyMicros: wallMicros,
    },
    tier,
    opened.id,
    screeningTelemetry(state.runs, cost.costTenthCents, wallMicros),
  );

  for (const finding of kept) {
    await recorder.record(
      {
        kind: NODE.finding,
        v: V,
        detector: finding.detector,
        category: finding.category,
        severity: finding.severity,
        rule: finding.rule,
        // Coordinates, never the matched text. There is no field here that
        // could carry a name or an account number.
        field: finding.at.field,
        startCodeUnit: finding.at.startCodeUnit,
        lengthCodeUnits: finding.at.lengthCodeUnits,
        // Which text those coordinates index into. A model detector sees the
        // masked view, so its coordinates are not coordinates in the caller's
        // string, and a 2033 reader must not have to guess which.
        space: finding.space,
        confidenceBasisPoints: finding.confidenceBasisPoints,
      },
      tier,
      settled.id,
    );
  }

  return Object.freeze({
    [SETTLED_NODE]: settled,
    correlationId: recorder.correlationId,
    phase,
    tier,
    locale: run.locale,
    detectorSet: set.id,
    at: settledAt,
    nodes: Object.freeze({ opened: opened.id, settled: settled.id }),
    detectors: state.runs as unknown as NonEmpty<DetectorRun>,
    findings,
    recommended,
    cost: { ...cost, latencyMicros: wallMicros },
    payload: mintScreenedPayload(masked.fields, masked.maskedSites),
  }) as unknown as Screening & { readonly [SCREENING_MINT]?: never };
};

// ---------------------------------------------------------------------------

interface PassState {
  readonly runs: DetectorRun[];
  readonly drafts: Finding[];
  readonly grounds: Ground[];
  readonly searched: string[];
}

/**
 * One round of the fan-out, bounded, recording as it goes.
 *
 * A failure inside the round stops the round: no further detector is started,
 * the round is drained rather than abandoned mid-flight, an **abandoned** node
 * is written, and the original error is rethrown. Before this, `Promise.all`
 * rejected on the first failure while sibling workers carried on writing nodes —
 * so a trace kept growing after the caller had already been handed the error,
 * and nothing in the trace marked the throw.
 *
 * The honest residue: a detector already in flight cannot be cancelled, so its
 * node may still be written before the abandoned node. What is guaranteed is
 * that the trace is complete and marked *by the time the caller sees the error*.
 */
const runPass = async (
  run: ScreeningRun,
  parent: NodeId,
  detectors: readonly Detector[],
  view: { readonly [f: string]: string },
  space: Finding["space"],
  sources: Sources,
  state: PassState,
): Promise<void> => {
  try {
    await boundedForEach(detectors, run.limits.detectorConcurrency, async (detector) => {
      await runOne(run, parent, detector, view, space, sources, state);
    });
  } catch (error) {
    await markAbandoned(run, parent, state, error);
    throw error;
  }
};

const markAbandoned = async (
  run: ScreeningRun,
  parent: NodeId,
  state: PassState,
  error: unknown,
): Promise<void> => {
  try {
    await run.recorder.record(
      {
        kind: NODE.abandoned,
        v: V,
        phase: run.phase,
        tier: run.tier,
        error: error instanceof Error ? error.name : "unknown",
        detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        detectorsRecorded: state.runs.length,
      },
      run.tier,
      parent,
    );
  } catch {
    // The abandoned node could not be written either — which is itself a
    // recording failure the caller is about to hear about. The original error
    // is the one that explains the screening, so it is the one that propagates.
  }
};

const runOne = async (
  run: ScreeningRun,
  parent: NodeId,
  detector: Detector,
  view: { readonly [f: string]: string },
  space: Finding["space"],
  sources: Sources,
  state: PassState,
): Promise<void> => {
  const { recorder, clock, tier } = run;
  const began = clock.now();
  const report = await callDetector(detector, run, view, sources);
  // Microseconds, from a clock whose resolution is milliseconds. The unit is
  // chosen for the payload, not for the precision: an integer field that can
  // never carry a fraction is what keeps the trace byte-stable, and a
  // sub-millisecond deterministic detector honestly reads as 0 rather than as
  // a rounded float. A caller wanting real microsecond resolution injects a
  // clock that has it; nothing else changes.
  const latencyMicros = Math.max(0, clock.now() - began) * 1000;
  const overBudget = latencyMicros > run.limits.detectorBudgetMicros;

  const observed: ObservedReport =
    overBudget && report.outcome !== "unavailable"
      ? {
          outcome: "unavailable",
          reason: "timed-out",
          detail: `answered after ${latencyMicros}us against a budget of ${run.limits.detectorBudgetMicros}us`,
          costTenthCents: report.costTenthCents,
          modelCalls: report.modelCalls,
          ...(report.spend === undefined ? {} : { spend: report.spend }),
        }
      : report;

  if (observed.outcome === "unavailable") {
    const measured = observed.costTenthCents !== undefined && observed.modelCalls !== undefined;
    const costTenthCents = observed.costTenthCents ?? 0;
    const modelCalls = observed.modelCalls ?? 0;
    if (measured) validateCosts(detector.id, costTenthCents, modelCalls, observed.spend);
    const node = await recorder.record(
      {
        kind: NODE.detector,
        v: V,
        detector: detector.id,
        costClass: detector.costClass,
        searches: detector.searches,
        view: space,
        outcome: "unavailable",
        reason: observed.reason,
        // Bounded prefix. See `DetectorReport` — this is a contract about
        // what a detector may put here, not something this module can verify.
        detail: observed.detail.slice(0, 200),
        findings: 0,
        costTenthCents,
        // **Zero cost and unknown cost are different facts.** A detector that
        // threw or never answered may well have spent money first, and writing
        // a zero there made real spend invisible on exactly the paths where it
        // is most likely to have been spent.
        costMeasured: measured,
        latencyMicros,
        overBudget,
        modelCalls,
      },
      tier,
      parent,
      detectorTelemetry(observed.spend, costTenthCents, latencyMicros),
    );
    state.runs.push({
      detector: detector.id,
      costClass: detector.costClass,
      node: node.id,
      outcome: "unavailable",
      findings: 0,
      costTenthCents,
      costMeasured: measured,
      latencyMicros,
      modelCalls,
      ...(observed.spend === undefined ? {} : { spend: observed.spend }),
    });
    state.grounds.push({
      ground: "detector-unavailable",
      detector: detector.id,
      reason: observed.reason,
      detail: observed.detail.slice(0, 200),
    });
    // `reason: "malformed"` means a detector produced an unrecordable report.
    // That is a defect in a detector, not an outage in one, so it halts the
    // screening rather than degrading into a cautious-looking abstention.
    if (observed.reason === "malformed") {
      throw new DetectorReportInvalid(detector.id, observed.detail);
    }
    return;
  }

  validateCosts(detector.id, observed.costTenthCents, observed.modelCalls, observed.spend);
  const found = observed.outcome === "found" ? observed.findings : [];
  for (const draft of found) validateDraft(detector.id, draft, view);

  const node = await recorder.record(
    {
      kind: NODE.detector,
      v: V,
      detector: detector.id,
      costClass: detector.costClass,
      searches: detector.searches,
      view: space,
      outcome: observed.outcome,
      findings: found.length,
      costTenthCents: observed.costTenthCents,
      costMeasured: true,
      latencyMicros,
      overBudget,
      modelCalls: observed.modelCalls,
    },
    tier,
    parent,
    detectorTelemetry(observed.spend, observed.costTenthCents, latencyMicros),
  );
  state.runs.push({
    detector: detector.id,
    costClass: detector.costClass,
    node: node.id,
    outcome: observed.outcome,
    findings: found.length,
    costTenthCents: observed.costTenthCents,
    costMeasured: true,
    latencyMicros,
    modelCalls: observed.modelCalls,
    ...(observed.spend === undefined ? {} : { spend: observed.spend }),
  });
  state.searched.push(detector.searches);
  for (const draft of found) state.drafts.push({ ...draft, detector: detector.id, space });
};

/**
 * Cost, tokens, latency and the price table that priced them — C2's one
 * surviving telemetry requirement, as `audit`'s typed `NodeTelemetry` field
 * rather than as free-form payload keys.
 *
 * Absent where the detector reported no `spend`, which is the honest answer for
 * a deterministic detector: recording four zeroes and a made-up price table
 * would make "we spent nothing" indistinguishable from "we did not measure",
 * which is `audit`'s stated reason for making the field optional.
 */
const detectorTelemetry = (
  spend: DetectorSpend | undefined,
  costTenthCents: number,
  latencyMicros: number,
): NodeTelemetry | undefined =>
  spend === undefined
    ? undefined
    : {
        costTenthCents,
        tokensIn: spend.tokensIn,
        tokensOut: spend.tokensOut,
        latencyMicros,
        priceTableVersion: spend.priceTableVersion,
      };

/** The screening's own telemetry: the sum of what its detectors could measure. */
const screeningTelemetry = (
  runs: readonly DetectorRun[],
  costTenthCents: number,
  latencyMicros: number,
): NodeTelemetry | undefined => {
  const spends = runs.flatMap((r) => (r.spend === undefined ? [] : [r.spend]));
  if (spends.length === 0) return undefined;
  const versions = [...new Set(spends.map((s) => s.priceTableVersion))].sort();
  return {
    costTenthCents,
    tokensIn: spends.reduce((n, s) => n + s.tokensIn, 0),
    tokensOut: spends.reduce((n, s) => n + s.tokensOut, 0),
    latencyMicros,
    priceTableVersion: versions.join(","),
  };
};

/**
 * Call one detector, bounded.
 *
 * Three ways a detector can fail and all three land on the same fail-closed
 * path: it throws, it exceeds its budget, or it declares itself unavailable.
 * None of them is retried — see `limits.ts` for why a hidden retry is worse
 * than a visible re-screen.
 *
 * ## What the budget bounds, exactly
 *
 * It bounds the **answer**, not the work. Two limits, both real, and the second
 * used to be undisclosed:
 *
 *   1. Losing the race does not cancel an asynchronous detector's work, because
 *      this module did not start it and holds no handle on it. The budget is
 *      also handed to the detector in `budgetMicros` so a well-behaved one that
 *      owns a client can pass it down.
 *   2. **A synchronous detector cannot be raced at all.** `Detector.screen` may
 *      return a `DetectorReport` rather than a promise, and a synchronous body
 *      never yields, so `Promise.race` is not scheduled until after it has
 *      finished. `deterministicDetector` — the adapter this package ships — is
 *      synchronous, and it compiles caller-supplied regular expressions over
 *      fields of up to `maxFieldChars`. A catastrophically-backtracking pattern
 *      is therefore an unbounded event-loop stall, and no in-process timer of
 *      any design can preempt it. That is a property of the runtime, not of this
 *      module, and it is stated here rather than implied away.
 *
 * What this module *can* do about (2) is refuse the answer: the elapsed time is
 * measured against the injected clock after the call returns, and a detector
 * that took longer than its budget is recorded `unavailable/timed-out` however
 * it got there — so the budget is a deterministic policy rather than a race
 * whose winner depends on microtask ordering. The screening then fails closed.
 */
const callDetector = async (
  detector: Detector,
  run: ScreeningRun,
  fields: { readonly [f: string]: string },
  sources: Sources,
): Promise<ObservedReport> => {
  const budgetMicros = run.limits.detectorBudgetMicros;
  const handle = run.timer.wait(Math.ceil(budgetMicros / 1000));
  try {
    return await Promise.race([
      (async (): Promise<ObservedReport> => {
        try {
          return shapeOf(
            await detector.screen({
              phase: run.phase,
              locale: run.locale,
              fields,
              sources,
              budgetMicros,
            }),
          );
        } catch (cause) {
          return {
            outcome: "unavailable",
            reason: "threw",
            detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : "threw",
            // Unknown, not zero. A detector that threw may have spent money
            // first and cannot now tell us how much.
            costTenthCents: undefined,
            modelCalls: undefined,
          };
        }
      })(),
      handle.elapsed.then(
        (): ObservedReport => ({
          outcome: "unavailable",
          reason: "timed-out",
          detail: `no answer within ${budgetMicros}us`,
          costTenthCents: undefined,
          modelCalls: undefined,
        }),
      ),
    ]);
  } finally {
    handle.cancel();
  }
};

/**
 * A report that is not one of the three shapes is a **defect**, not an outage.
 *
 * It is carried as `reason: "malformed"` so the run still gets a node before
 * `runScreening` throws `DetectorReportInvalid`. Degrading it to an ordinary
 * abstention would let a broken detector look like a cautious one, and the
 * build would stay green while a whole category stopped being screened.
 */
const shapeOf = (report: DetectorReport): ObservedReport => {
  if (report === null || typeof report !== "object") {
    return malformed(`report is ${typeof report}`);
  }
  switch (report.outcome) {
    case "found":
      return Array.isArray(report.findings) && report.findings.length > 0
        ? report
        : malformed("outcome 'found' with no findings");
    case "searched-and-found-none":
      return report;
    case "unavailable":
      return report.reason === "declared"
        ? {
            outcome: "unavailable",
            reason: "declared",
            detail: report.detail,
            // A detector that declares itself unavailable *can* say what it
            // spent getting there, and a model-class one usually has.
            costTenthCents: report.costTenthCents,
            modelCalls: report.modelCalls,
            ...(report.spend === undefined ? {} : { spend: report.spend }),
          }
        : malformed(`a detector may only declare itself unavailable, not ${String(report.reason)}`);
    default:
      return malformed(`unknown outcome ${String((report as { outcome: string }).outcome)}`);
  }
};

const malformed = (detail: string): ObservedReport => ({
  outcome: "unavailable",
  reason: "malformed",
  detail,
  costTenthCents: undefined,
  modelCalls: undefined,
});

const validateCosts = (
  id: string,
  costTenthCents: number,
  modelCalls: number,
  spend?: DetectorSpend,
): void => {
  if (!Number.isSafeInteger(costTenthCents) || costTenthCents < 0) {
    throw new DetectorReportInvalid(id, `costTenthCents ${costTenthCents} is not a whole tenth-cent`);
  }
  if (!Number.isSafeInteger(modelCalls) || modelCalls < 0) {
    throw new DetectorReportInvalid(id, `modelCalls ${modelCalls} is not a count`);
  }
  if (spend === undefined) return;
  // Telemetry is written as `audit`'s typed `NodeTelemetry`, and `audit` refuses
  // a non-integer there — correctly, since a float is how byte-stability dies.
  // Catching it here names the detector that produced it instead of surfacing
  // an `UnserialisablePayload` about a field the caller never wrote.
  for (const [field, value] of [
    ["tokensIn", spend.tokensIn],
    ["tokensOut", spend.tokensOut],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DetectorReportInvalid(id, `${field} ${String(value)} is not a token count`);
    }
  }
  if (typeof spend.priceTableVersion !== "string" || spend.priceTableVersion.length === 0) {
    throw new DetectorReportInvalid(
      id,
      "spend names no price table; a cost figure nobody can reprice is not evidence",
    );
  }
};

/** Coordinates are validated against the text the detector was actually shown. */
const validateDraft = (
  id: string,
  draft: FindingDraft,
  view: { readonly [f: string]: string },
): void => {
  const text = view[draft.at.field];
  if (typeof text !== "string") {
    throw new DetectorReportInvalid(id, `finding names field ${draft.at.field}, which was not screened`);
  }
  const { startCodeUnit: start, lengthCodeUnits: length } = draft.at;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1) {
    throw new DetectorReportInvalid(id, `finding site ${start}+${length} is not a range`);
  }
  if (start + length > text.length) {
    throw new DetectorReportInvalid(
      id,
      `finding site ${start}+${length} runs past field ${draft.at.field}`,
    );
  }
  if (!isBasisPoints(draft.confidenceBasisPoints)) {
    throw new DetectorReportInvalid(
      id,
      `confidence ${draft.confidenceBasisPoints} is not basis points`,
    );
  }
  if (typeof draft.rule !== "string" || draft.rule.length === 0) {
    throw new DetectorReportInvalid(id, "finding carries no rule identifier");
  }
};

/** Strictest first, so truncation keeps what matters. Stable within a rank. */
const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  block: 3,
  escalate: 2,
  redact: 1,
  advisory: 0,
});

const rank = (drafts: readonly Finding[]): readonly Finding[] =>
  [...drafts].sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      (a.at.field < b.at.field ? -1 : a.at.field > b.at.field ? 1 : 0) ||
      a.at.startCodeUnit - b.at.startCodeUnit,
  );

/**
 * The result of a search, which is not the same thing as a list of findings.
 *
 * `foundCount` is the number of drafts *before* truncation, and it is here
 * because the alternative is a lie: a screening whose finding list truncated to
 * nothing used to report `searchedAndFoundNone` over a payload where a `block`
 * had fired. "Nothing found" must be an assertion about the search, never an
 * artefact of a bound on the report.
 */
const summarise = (
  kept: readonly Finding[],
  foundCount: number,
  searched: readonly string[],
  detectorsRun: number,
): Findings => {
  if (kept.length > 0) return { found: kept as unknown as NonEmpty<Finding> };
  if (foundCount > 0) {
    return {
      couldNotSearch: {
        why: `${foundCount} findings were reported and the configured finding list holds none of them`,
      },
    };
  }
  if (searched.length === 0) {
    return {
      couldNotSearch: {
        why: `no detector completed a search (${detectorsRun} ran, all unavailable)`,
      },
    };
  }
  // "Nothing found" is an assertion about a search performed, so it names the
  // search. An empty array cannot say whether anybody looked.
  return { searchedAndFoundNone: { searched: [...searched].sort().join("; ") } };
};

/**
 * The strictness ladder: allow < redact-and-allow < escalate < abstain.
 *
 * `abstain` outranks `escalate` because "we could not judge" is a stronger
 * statement than "a human should hold this" — a system that could not conclude
 * has nothing for the human to check. A detector that was unavailable and a
 * source set that was missing both land here, which is the whole of the
 * fail-closed policy: **a detector that errors yields abstain-recommended,
 * never allow.**
 *
 * Taking a maximum loses nothing, because `Screening.findings` and the
 * per-detector nodes are complete either way.
 */
const recommend = (
  grounds: readonly Ground[],
  maskedSites: number,
): RecommendedDisposition => {
  const abstain = grounds.filter((g) => g.ground !== "finding" || g.severity === "block");
  if (abstain.length > 0) {
    return { recommend: "abstain", grounds: abstain as unknown as NonEmpty<Ground> };
  }
  const escalate = grounds.filter((g) => g.ground === "finding" && g.severity === "escalate");
  if (escalate.length > 0) {
    return { recommend: "escalate", grounds: escalate as unknown as NonEmpty<Ground> };
  }
  if (maskedSites > 0) return { recommend: "redact-and-allow", maskedSites };
  return { recommend: "allow" };
};

/**
 * Bounded fan-out. No unbounded concurrency: `limit` workers, each pulling the
 * next detector, so nineteen applications screening at once do not become the
 * classifier's rate-limit incident.
 *
 * **A failure stops the round.** `Promise.all` rejects on the first failure and
 * leaves its siblings running, which meant the caller held an error while the
 * trace was still growing. Here the first failure closes the queue, every worker
 * is drained, and only then is the error rethrown.
 */
const boundedForEach = async <T>(
  items: readonly T[],
  limit: number,
  body: (item: T) => Promise<void>,
): Promise<void> => {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      if (failed) return;
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        await body(item);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
};
