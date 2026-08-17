/**
 * Every marked line here is expected to be a compile error. The test asserts
 * this file produces **zero** diagnostics, which — given `@ts-expect-error` —
 * is true only if each marked line errors. If a guarantee ever weakens,
 * `TS2578: Unused '@ts-expect-error' directive` fails the build.
 *
 * A type-level guarantee asserted in prose is exactly the failure the design
 * review caught: a design quoted a compiler error it had never seen. So these
 * are compiled by this repository's own TypeScript under its own strict
 * settings, and the diagnostics are asserted.
 *
 * Literals are kept on one line on purpose: `@ts-expect-error` suppresses the
 * line that follows it, and a multi-line literal scatters its diagnostics
 * across the property lines.
 */
import type {
  ClassifierResponse,
  Detector,
  DetectorReport,
  Findings,
  Guardrails,
  Pattern,
  Screening,
  ScreenedPayload,
  Source,
  Sources,
} from "../../index.js";

declare const guardrails: Guardrails;
declare const source: Source;
declare const real: Screening;

// Correctly branded parts, so the only thing missing below is the brand on the
// `Screening` itself. Even holding every ingredient, a caller cannot assemble one.
declare const correlationId: Screening["correlationId"];
declare const node: Screening["nodes"]["opened"];
declare const detectorSet: Screening["detectorSet"];
declare const locale: Screening["locale"];
declare const detectorRun: Screening["detectors"][number];
declare const findings: Screening["findings"];
declare const screened: ScreenedPayload;

/* 1. A `Screening` cannot be constructed. Its brand is a non-exported `unique
      symbol`, so no external object literal satisfies it — which is what makes
      `checkOutput`'s ordering constraint structural rather than documentary:
      there is no way to check an output that was never preceded by a screened
      input. */
// prettier-ignore
// @ts-expect-error a Screening cannot be constructed outside the module
export const forged: Screening = { correlationId, phase: "input", tier: "low", locale, detectorSet, at: 0, nodes: { opened: node, settled: node }, detectors: [detectorRun], findings, recommended: { recommend: "allow" }, cost: { costTenthCents: 0, latencyMicros: 0, modelCalls: 0 }, payload: screened };

/* 2. Nor can the screened payload, which is the only form of a payload this
      module lets out. A caller cannot fabricate one and claim it was screened. */
// @ts-expect-error a ScreenedPayload has no public constructor
export const fakePayload: ScreenedPayload = { fields: { a: "b" }, maskedSites: 0 };

/* 3. `checkOutput` cannot be called without the input screening. Ordering is
      not a rule a caller remembers; it is a required parameter. */
// prettier-ignore
// @ts-expect-error `after` is required
export const unordered = (): Promise<Screening> => guardrails.checkOutput({ tier: "high", output: { answer: "pay it" }, sources: { available: true, items: [source] } });

/* 4. "No sources" cannot be spelled as an empty array. A caller with nothing to
      check against says so in words, and the screening recommends abstain —
      "we could not check, so we allowed it" is not expressible. */
// @ts-expect-error Sources has no empty-array branch
export const noSources: Sources = { available: true, items: [] };

/* 5. Neither can "nothing found". Absence of a finding is not a finding, and an
      empty array cannot say whether anybody looked. */
// @ts-expect-error Findings has no empty-array branch
export const noFindings: Findings = { found: [] };

/* 6. A detector cannot report a find with nothing in it. */
// prettier-ignore
// @ts-expect-error `found` requires at least one finding
export const emptyFind: DetectorReport = { outcome: "found", findings: [], costTenthCents: 0, modelCalls: 0 };

/* 7. A detector cannot classify its own incident. Only "declared" is available
      to it: "timed-out" and "malformed" are the engine's observations about a
      detector, not claims a detector may make about itself. */
// prettier-ignore
// @ts-expect-error a detector may only declare itself unavailable
export const selfDiagnosis: DetectorReport = { outcome: "unavailable", reason: "timed-out", detail: "not my call to make" };

/* 8. A detector receives no client, no store, no recorder and no clock. There
      is nothing in a subject to have an effect with. `deadline` is the one thing
      added since, and it is a one-bit oracle rather than a clock: it answers
      "is my budget spent" and cannot be asked what time it is. */
export const noCapability: Detector["screen"] = async (subject) => {
  // @ts-expect-error a ScreeningSubject carries no client of any kind
  subject.client;
  // @ts-expect-error nor a recorder
  subject.recorder;
  // @ts-expect-error nor a clock
  subject.clock;
  // @ts-expect-error and the deadline is not one either — no `now`
  subject.deadline.now;
  subject.deadline.expired();
  return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
};

/* 12. A detector cannot be synchronous. A synchronous body never yields, so the
       engine's race against the budget was not scheduled until after it had
       already finished — which made the budget a bound on the answer and on
       nothing else. Requiring a promise does not by itself bound a
       central-processing-unit-bound body, and the interface says so; what it
       does is stop a detector being written in the one shape that cannot be
       raced at all. */
// prettier-ignore
// @ts-expect-error screen must return a promise
export const synchronous: Detector["screen"] = () => ({ outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 });

/* 13. A `Pattern` cannot be written down. `safePattern` is the only mint, and it
       refuses a regular expression capable of exponential backtracking — so a
       pack cannot carry `(a+)+` past the analyser by declaring it as a literal
       instead of minting it. */
// prettier-ignore
// @ts-expect-error a Pattern is branded and only safePattern mints one
export const forgedPattern: Pattern = { rule: "sneaky", match: /(a+)+$/g, confidenceBasisPoints: 9_000, covers: "personal-data.name" };

/* 9. A model call cannot decline to say what it consumed. C2 names four things
      per node — cost, tokens, latency and the price-table version — and a cost
      figure nobody can reprice in 2033 is not evidence. Tokens and the table are
      required on a response, not optional. */
// prettier-ignore
// @ts-expect-error a ClassifierResponse must carry tokens and the price table
export const untraceableCost: ClassifierResponse = { scores: { injection: 100 }, costTenthCents: 45 };

/* 10. A caller cannot name the slot a `Screening` carries its settled node in,
       so `under` still cannot be forged into something that skips a screening.
       The `Screening` form of `under` is the cheap one; a bare `NodeId` is the
       one that costs a replay. Both are accepted, neither is constructible. */
export const reScreen = (): Promise<Screening> =>
  guardrails.screenInput({
    correlationId,
    tier: "low",
    payload: { narrative: "second attempt after redaction" },
    under: real,
  });

/* 11. A real screening is of course accepted — the fixture would prove nothing
       if the parameter simply rejected everything. */
export const accepted = (): Promise<Screening> =>
  guardrails.checkOutput({
    after: real,
    tier: "high",
    output: { answer: "pay it" },
    sources: { available: false, why: "policy store returned 503" },
  });
