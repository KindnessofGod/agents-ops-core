import { ReportRefused } from "./errors.js";
import type {
  CaseDigest,
  CaseRef,
  EvalNodeId,
  EvalPayload,
  ObservationWindow,
  Redactor,
  RiskTier,
  RunId,
  RunKey,
  ScorerDescriptor,
  Seed,
  SourceDigest,
  SubjectVersion,
  SubsetSelection,
  TraceDigest,
  Verdict,
} from "./types.js";

/**
 * The two report types, and the reason they are not interchangeable.
 *
 * Both are sealed with a **non-exported `unique symbol`**, so neither is
 * assignable to the other in either direction — not by structural accident, not
 * by a widening cast that looks innocent in review, and not even when the field
 * sets coincide.
 *
 * The separation is not a naming convention. It is a consequence of
 * **provenance**: `run` derives the report type from the case source it was
 * given (graft 7). A golden suite asserts verdicts somebody adjudicated on
 * purpose; recorded cases carry whatever a human happened to do. Those are
 * different claims about the world, so they produce different types, and nobody
 * has to remember which function to call.
 *
 * `CONTEXT.md` states the trap plainly: *the baseline is human behaviour
 * including human error. If your reviewers are wrong 8% of the time, a system in
 * perfect agreement with them is wrong 8% of the time — and a system that
 * disagrees on exactly those cases scores 92% while being right.* So
 * `AgreementReport` carries **no field named `correct`, `accuracy` or `score`**,
 * and `AccuracyReport` carries no field named `agreement`. The vocabulary
 * separation is enforced by the absence of the tempting name, not by a comment
 * asking people not to use it.
 */
declare const ACCURACY: unique symbol;
declare const AGREEMENT: unique symbol;

/**
 * What the run's own scorers declared about themselves, **and what was actually
 * checked**.
 *
 * The two halves are separate because they are different kinds of statement and
 * only one of them is evidence. `declared` is an assertion by the scorer
 * adapters' authors. `check` is a measurement this module performed.
 *
 * The declaration alone used to be the whole of it, which is how interface fact
 * 5 — "a run is deterministic given (suite, subject, scorer, seed), or the
 * report declares that it is not" — got satisfied without anything being
 * verified. The half that varies in practice is the **subject**: a temperature
 * setting, an unseeded shuffle, iteration over host-ordered keys, a cache warm
 * on the second call. No scorer descriptor knows about any of those.
 */
export interface Determinism {
  readonly declared: "deterministic" | "non-deterministic";
  /** Why, when declared non-deterministic. Empty otherwise, never absent. */
  readonly reasons: readonly string[];
  readonly check: DeterminismCheck;
}

/**
 * The determinism **check**, and what it does not cover.
 *
 * A seeded sample of this run's own cases is re-executed under the identical
 * seed and the two verdicts are compared byte for byte in canonical form. That
 * is cheap, it is the half that matters, and it is bounded by
 * `Limits.determinismSampleCases`.
 *
 * `compared: "subject-verdict"` is on the artefact so nobody reads more into it
 * than it says. **The scorers are not re-run.** A judge panel is
 * non-deterministic by construction and says so in its descriptor; re-running it
 * would measure the judge's variance, which is a different question, costs n
 * times more, and is already surfaced as `contested`.
 *
 * A sample of 2 over 200 cases proves nothing about the other 198 and is not
 * claimed to. What it catches is the common case, which is a subject that is
 * non-deterministic *everywhere* — and that one is caught on the first sample.
 */
export type DeterminismCheck =
  | { readonly kind: "not-checked"; readonly why: string }
  | {
      readonly kind: "checked";
      readonly compared: "subject-verdict";
      readonly sampled: readonly CaseRef[];
      readonly stable: number;
      /** Re-executed under the same seed and answered differently. */
      readonly unstable: readonly CaseRef[];
    };

/**
 * Whether this run executed, resumed, or ran blind because the ledger was down.
 *
 * On the artefact because a resumed run's cost, token counts and node graph
 * describe **only the part that executed today**. A reader comparing two reports
 * of the same suite and finding one at a tenth of the cost is looking at a
 * resume, and the report should say so rather than leave them to work it out.
 *
 * `ledger-unavailable` is the visible half of the one fail-open policy in this
 * module. A fail-open policy nobody can see is indistinguishable from a bug.
 */
export type Memoisation =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "resumed";
      /** Carried forward from an earlier run of the same key, not observed today. */
      readonly cases: readonly CaseRef[];
      readonly fromRuns: readonly string[];
    }
  | { readonly kind: "ledger-unavailable"; readonly detail: string };

/**
 * Whether the trace accounts for the thinking — and, when it does not, why not.
 *
 * Three values, because two of them used to be one and that was flattering.
 *
 *   `"complete"`      Every decision subtree recorded at least one model call,
 *                     and the subject declared `"calls-models"`. The coverage
 *                     figure is **measured**.
 *   `"partial"`       At least one decision subtree contradicted its own
 *                     declaration: `"calls-models"` with no recorded call, or
 *                     `"pure"` with one. Unscored, against the coverage floor,
 *                     and it fails the build.
 *   `"declared-pure"` The subject declared `"pure"` and recorded no model calls,
 *                     which is exactly what a rules engine looks like — and
 *                     exactly what a subject calling a provider SDK out of band
 *                     looks like. **This module cannot tell them apart**, so it
 *                     stops claiming it can. Coverage is `0`: nothing was
 *                     attributed by evidence, and the declaration is an
 *                     assertion by the subject's author, not a check.
 *
 * The value used to be `"complete"` with coverage `10000` for a `"pure"` run,
 * which reads as "we verified where the thinking happened". Nothing had been
 * verified.
 */
export type Attribution = "complete" | "partial" | "declared-pure";

export interface RunFacts {
  readonly runId: RunId;
  readonly runNode: EvalNodeId;
  readonly label: string;
  /**
   * Content address of *what was run*: source digest, subject version, scorer
   * digests, seed, price-table version and limits. Two runs of the same thing
   * share a run key and can be recognised as repeats; the `runId` is unique per
   * execution.
   */
  readonly runKey: RunKey;
  readonly subjectVersion: SubjectVersion;
  readonly subjectPurity: "calls-models" | "pure";
  readonly seed: Seed;
  readonly scorers: readonly ScorerDescriptor[];
  readonly determinism: Determinism;
  /** Whether this run executed, resumed from memo, or ran without a ledger. */
  readonly memoisation: Memoisation;
  readonly attribution: Attribution;
  readonly attributionCoverageBasisPoints: number;
  readonly unattributedCases: readonly CaseRef[];
  /** True when the run stopped early. A partial report can never pass a gate. */
  readonly partial: boolean;
  readonly partialReason: string | null;
  readonly casesRun: number;
  readonly casesDeclared: number;
  readonly costTenthCents: number;
  /** False when a model used had no row in the pinned price table. */
  readonly costComplete: boolean;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly priceTableVersion: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly traceDigest: TraceDigest;
  readonly nodes: number;
  /**
   * Which redactor produced the strings on this artefact.
   *
   * Reports outlive the node graph — the graph expires at 90 days, the report
   * does not — and they used to be the one thing the redactor never touched:
   * `authority` (a named person), `correlationId` and every verdict conclusion
   * travelled unredacted into the long-lived artefact while the short-lived
   * nodes were scrubbed. The same `Redactor` an application wires into `audit`
   * now runs over report contents too, and this names it.
   */
  readonly redaction: string;
  /**
   * The scope of the evidence, stamped onto the artefact. Every node this
   * module mediates is captured; work an application did through its own socket
   * is not, and cannot be. A reader in 2033 learns the limit of the guarantee
   * from the evidence rather than from a wiki that no longer exists.
   */
  readonly capturedVia: "injected-client-only";
}

/**
 * `could-not-evaluate` is the fifth value and the reason this schema is `/2`.
 *
 * It is **not** `unscored`. Unscored means the machinery worked and the case
 * still could not be measured — a judge returned nonsense, a scorer threw, the
 * subject crashed. Could-not-evaluate means the machinery did not get a turn:
 * the provider answered 429, or 503, or the connection reset. One is a fact
 * about the system under test; the other is a fact about ten minutes on a
 * Tuesday, and folding them together made a rate-limit storm arrive as
 * `unscored-rate` on the same red line a genuine regression uses.
 */
export type AccuracyCaseStatus =
  | "correct"
  | "incorrect"
  | "unscored"
  | "contested"
  | "unattributed"
  | "could-not-evaluate";

export interface AccuracyCaseResult {
  readonly ref: CaseRef;
  readonly digest: CaseDigest;
  readonly tier: RiskTier;
  readonly status: AccuracyCaseStatus;
  readonly scoreBasisPoints: number;
  readonly observed: Verdict | null;
  readonly expected: Verdict;
  readonly node: EvalNodeId;
  readonly detail: string | null;
  /**
   * Recorded model calls in this decision's subtree, and what they cost.
   *
   * On the artefact because the attribution check is a **floor of one**: a
   * subject that records a single three-token call and does its real thinking
   * elsewhere satisfies it. That cannot be detected, so it is made *visible* —
   * a reviewer reading "a high-tier underwriting determination, 1 call, 3
   * tokens, 0 tenth-cents" can see the shape of the problem without anyone
   * having to allege it.
   */
  readonly modelCalls: number;
  readonly costTenthCents: number;
}

export interface AccuracyReport extends RunFacts {
  readonly [ACCURACY]: true;
  readonly schema: "report.accuracy/2";
  readonly against: "golden";
  readonly suiteDigest: SourceDigest;
  /**
   * Present and `null` when the run covered the whole suite; populated when it
   * covered a subset. **A green gate over a subset states what it covered**, and
   * this is where it says so.
   */
  readonly selection: SubsetSelection | null;
  readonly correctBasisPoints: number;
  readonly incorrectBasisPoints: number;
  readonly unscoredBasisPoints: number;
  readonly contestedBasisPoints: number;
  /** Its own rate. A provider outage is not a quality signal. */
  readonly couldNotEvaluateBasisPoints: number;
  readonly cases: readonly AccuracyCaseResult[];
}

export type AgreementCaseStatus =
  | "agreed"
  | "disagreed"
  | "unscored"
  | "contested"
  | "unattributed"
  | "could-not-evaluate";

export interface AgreementCaseResult {
  readonly ref: CaseRef;
  readonly digest: CaseDigest;
  readonly tier: RiskTier;
  readonly status: AgreementCaseStatus;
  readonly scoreBasisPoints: number;
  readonly observed: Verdict | null;
  /** What the human did. Not "expected" — nobody adjudicated it. */
  readonly humanVerdict: Verdict;
  readonly authority: string;
  readonly correlationId: string;
  readonly node: EvalNodeId;
  readonly detail: string | null;
  /** See `AccuracyCaseResult.modelCalls`. Same reason, same limit. */
  readonly modelCalls: number;
  readonly costTenthCents: number;
}

export interface Disagreement {
  readonly ref: CaseRef;
  readonly correlationId: string;
  readonly tier: RiskTier;
  readonly humanVerdict: Verdict;
  readonly systemVerdict: Verdict;
  readonly authority: string;
  readonly node: EvalNodeId;
}

export interface AgreementReport extends RunFacts {
  readonly [AGREEMENT]: true;
  readonly schema: "report.agreement/2";
  readonly against: "recorded-human-decisions";
  readonly cohortDigest: SourceDigest;
  /** Present and `null` unless the cohort was itself a subset. */
  readonly selection: SubsetSelection | null;
  /** Required and named. A figure with no stated provenance is not evidence. */
  readonly humanDecisionSource: string;
  readonly window: ObservationWindow;
  /**
   * How many cases were offered to `recordedCases` and dropped for having no
   * human decision inside the window.
   *
   * `sources.ts` promised that "the count of dropped cases reaches the report,
   * so an agreement figure computed over a quietly-shrinking cohort is visible
   * rather than flattering", and then returned it on the source object only —
   * not on `CaseSource`, never read by `run`, and absent from this type. The
   * promise is now kept where it was made: an agreement figure of 97% over a
   * cohort that started at 900 cases and finished at 90 reads very differently,
   * and the denominator's history belongs next to the number.
   */
  readonly withoutHumanDecision: number;
  readonly agreementBasisPoints: number;
  readonly disagreedBasisPoints: number;
  readonly unscoredBasisPoints: number;
  readonly contestedBasisPoints: number;
  /** Its own rate. A provider outage is not a disagreement with a human. */
  readonly couldNotEvaluateBasisPoints: number;
  /**
   * Enumerated, not summarised. Every one is a case for **adjudication**, never
   * a defect — the field is not called `failures` and it never will be.
   */
  readonly disagreements: readonly Disagreement[];
  readonly cases: readonly AgreementCaseResult[];
  /**
   * Literal-typed, so it is present in every serialisation, every JSON dump and
   * every dashboard that renders the object naively. One field to make the trap
   * visible everywhere the number goes.
   */
  readonly interpretation: "agreement is not accuracy — the baseline is human behaviour including human error; every disagreement is a case for adjudication, not a defect";
}

export const INTERPRETATION =
  "agreement is not accuracy — the baseline is human behaviour including human error; every disagreement is a case for adjudication, not a defect" as const;

/* ----------------------------------------------------------------- minting */

/* --------------------------------------------------------------- redaction */

/**
 * Redaction of report contents, under the **same policy** that redacted the
 * nodes.
 *
 * Every field is offered to the redactor as a one-key payload whose key is the
 * name the node payloads already use — `authority`, `correlationId`,
 * `conclusion`, `because`, `detail` — so one deny-list configured once covers
 * the short-lived graph and the long-lived artefact together. An application
 * cannot end up with a strict policy on nodes and a lax one on reports, which
 * is exactly the state this module shipped in.
 */
const redactString = (redact: Redactor, key: string, value: string): string => {
  const out: EvalPayload = redact.apply({ [key]: value });
  const field = out[key];
  return typeof field === "string" ? field : "[redacted]";
};

const redactVerdict = (redact: Redactor, verdict: Verdict): Verdict => ({
  disposition: verdict.disposition,
  conclusion: redactString(redact, "conclusion", verdict.conclusion),
  confidenceBasisPoints: verdict.confidenceBasisPoints,
  because: verdict.because === null ? null : redactString(redact, "because", verdict.because),
});

/* ----------------------------------------------------------------- minting */

/**
 * The only producers of the two report types, and they are private to `lib/`.
 * A hand-built object is not assignable, because the brand key cannot be named
 * outside this file — so a report that reached `gate` came out of a run that
 * reached a store.
 *
 * **In this process.** The brand is a phantom `unique symbol`; it does not
 * survive `JSON.stringify`. See `reopenAccuracyReport` below for the honest
 * re-entry, and `index.ts` for the claim stated at its true strength.
 */
export const mintAccuracyReport = (
  facts: RunFacts,
  suiteDigest: SourceDigest,
  selection: SubsetSelection | null,
  rates: {
    readonly correctBasisPoints: number;
    readonly incorrectBasisPoints: number;
    readonly unscoredBasisPoints: number;
    readonly contestedBasisPoints: number;
    readonly couldNotEvaluateBasisPoints: number;
  },
  cases: readonly AccuracyCaseResult[],
  redact: Redactor,
): AccuracyReport =>
  ({
    ...facts,
    schema: "report.accuracy/2",
    against: "golden",
    suiteDigest,
    selection,
    ...rates,
    cases: cases.map((c) => ({
      ...c,
      observed: c.observed === null ? null : redactVerdict(redact, c.observed),
      expected: redactVerdict(redact, c.expected),
      detail: c.detail === null ? null : redactString(redact, "detail", c.detail),
    })),
  }) as unknown as AccuracyReport;

export const mintAgreementReport = (
  facts: RunFacts,
  cohortDigest: SourceDigest,
  selection: SubsetSelection | null,
  provenance: {
    readonly humanDecisionSource: string;
    readonly window: ObservationWindow;
    readonly withoutHumanDecision: number;
  },
  rates: {
    readonly agreementBasisPoints: number;
    readonly disagreedBasisPoints: number;
    readonly unscoredBasisPoints: number;
    readonly contestedBasisPoints: number;
    readonly couldNotEvaluateBasisPoints: number;
  },
  disagreements: readonly Disagreement[],
  cases: readonly AgreementCaseResult[],
  redact: Redactor,
): AgreementReport =>
  ({
    ...facts,
    schema: "report.agreement/2",
    against: "recorded-human-decisions",
    cohortDigest,
    selection,
    humanDecisionSource: provenance.humanDecisionSource,
    window: provenance.window,
    withoutHumanDecision: provenance.withoutHumanDecision,
    ...rates,
    disagreements: disagreements.map((d) => ({
      ...d,
      correlationId: redactString(redact, "correlationId", d.correlationId),
      authority: redactString(redact, "authority", d.authority),
      humanVerdict: redactVerdict(redact, d.humanVerdict),
      systemVerdict: redactVerdict(redact, d.systemVerdict),
    })),
    cases: cases.map((c) => ({
      ...c,
      correlationId: redactString(redact, "correlationId", c.correlationId),
      authority: redactString(redact, "authority", c.authority),
      observed: c.observed === null ? null : redactVerdict(redact, c.observed),
      humanVerdict: redactVerdict(redact, c.humanVerdict),
      detail: c.detail === null ? null : redactString(redact, "detail", c.detail),
    })),
    interpretation: INTERPRETATION,
  }) as unknown as AgreementReport;

/* ------------------------------------------------- crossing a process line */

const SHARED_INTEGER_FIELDS = [
  "attributionCoverageBasisPoints",
  "casesRun",
  "casesDeclared",
  "costTenthCents",
  "tokensIn",
  "tokensOut",
  "startedAt",
  "finishedAt",
  "nodes",
  "unscoredBasisPoints",
  "contestedBasisPoints",
  "couldNotEvaluateBasisPoints",
] as const;

const ACCURACY_INTEGER_FIELDS = [
  ...SHARED_INTEGER_FIELDS,
  "correctBasisPoints",
  "incorrectBasisPoints",
] as const;

const AGREEMENT_INTEGER_FIELDS = [
  ...SHARED_INTEGER_FIELDS,
  "agreementBasisPoints",
  "disagreedBasisPoints",
] as const;

const rateOf = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Math.round((numerator * 10_000) / denominator);

/**
 * Every report schema this build can read. Bump by **adding**, never replacing.
 *
 * The module claimed a schema-evolution story for nodes and had none for
 * reports, which is the wrong way round: the node graph expires at 90 days and
 * the report is the seven-year artefact. A `report.accuracy/1` written before
 * `couldNotEvaluateBasisPoints`, `selection` and the determinism *check* existed
 * is still a valid report, and it is upcast on read — the bytes on disk are
 * never touched, and the values the old build could not have known are filled
 * with the honest answer rather than a flattering one.
 */
export const READABLE_REPORT_SCHEMAS: readonly string[] = [
  "report.accuracy/1",
  "report.accuracy/2",
  "report.agreement/1",
  "report.agreement/2",
];

/**
 * Fill in the fields `/1` could not have carried, on read.
 *
 * Note the values. `couldNotEvaluateBasisPoints` becomes `0` — a `/1` run could
 * not distinguish a provider outage from an unscored case, so its outage cases
 * are already inside `unscoredBasisPoints` and moving them would be inventing
 * data. `selection` becomes `null`: subsets did not exist, so the run covered
 * whatever it covered and nothing claims otherwise. The determinism check
 * becomes `not-checked`, **not** stable — an old report is silent about
 * determinism, and silence is not a pass.
 */
const upcastReport = (record: Record<string, unknown>): Record<string, unknown> => {
  const schema = record["schema"];
  if (schema !== "report.accuracy/1" && schema !== "report.agreement/1") return record;
  const declared = (record["determinism"] as { readonly declared?: unknown } | undefined)?.declared;
  return {
    ...record,
    schema: schema === "report.accuracy/1" ? "report.accuracy/2" : "report.agreement/2",
    couldNotEvaluateBasisPoints: 0,
    selection: null,
    memoisation: record["memoisation"] ?? { kind: "fresh" },
    determinism: {
      declared: declared === "non-deterministic" ? "non-deterministic" : "deterministic",
      reasons:
        (record["determinism"] as { readonly reasons?: readonly string[] } | undefined)?.reasons ??
        [],
      check: {
        kind: "not-checked",
        why: `written under ${String(schema)}, before determinism was verified rather than declared`,
      },
    },
  };
};

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    throw new ReportRefused(`expected an object for ${what}, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
};

const checkIntegers = (
  record: Record<string, unknown>,
  fields: readonly string[],
): void => {
  for (const field of fields) {
    const found = record[field];
    if (typeof found !== "number" || !Number.isSafeInteger(found)) {
      throw new ReportRefused(`${field} is not a safe integer`);
    }
  }
};

const casesOf = (record: Record<string, unknown>): readonly Record<string, unknown>[] => {
  const cases = record["cases"];
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new ReportRefused("cases is empty or missing; a report over no cases passes trivially");
  }
  return cases as readonly Record<string, unknown>[];
};

const checkRates = (
  record: Record<string, unknown>,
  cases: readonly Record<string, unknown>[],
  expected: Readonly<Record<string, number>>,
): void => {
  for (const [field, want] of Object.entries(expected)) {
    if (record[field] !== want) {
      throw new ReportRefused(
        `${field} is ${String(record[field])} but its own ${String(cases.length)} cases give ${String(want)}`,
      );
    }
  }
  if (record["casesRun"] !== cases.length) {
    throw new ReportRefused(
      `casesRun is ${String(record["casesRun"])} but the report carries ${String(cases.length)} cases`,
    );
  }
};

/**
 * Re-enter a report that crossed a process boundary, and refuse anything else.
 *
 * The flow this module exists for is: run in continuous-integration job A,
 * write JSON, gate in job B. The brands are phantom `unique symbol`s, so that
 * flow could previously only re-enter through a cast — and `gate` did no runtime
 * check at all, which meant the disjointness that the whole `AccuracyReport` /
 * `AgreementReport` split is built on evaporated at exactly the boundary it was
 * meant to survive.
 *
 * This is the honest re-entry, and it does four things a cast does not:
 *
 *  1. Checks the literal `schema` and `against`. An agreement report's JSON is
 *     refused here, which is the compile-time guarantee's runtime twin.
 *  2. Checks every figure is a safe integer. No IEEE-754 sneaks in through a
 *     round-trip.
 *  3. **Recomputes the four rates from the cases** and refuses a mismatch. A
 *     report whose headline numbers do not follow from its own contents is the
 *     cheapest possible forgery and the one worth catching.
 *  4. Refuses a report with no cases, which is the zero-case suite wearing a
 *     different hat.
 *
 * What it does not do, stated plainly: it does not prove the run happened. It
 * proves the artefact is internally consistent and of the right kind. Proving
 * the run happened means reading the trace out of the store by `runId` and
 * recomputing `traceDigest`, which needs the store — and is what an auditor
 * does, not what a gate does.
 */
export const reopenAccuracyReport = (value: unknown): AccuracyReport => {
  const raw = asRecord(value, "an accuracy report");
  if (raw["schema"] !== "report.accuracy/1" && raw["schema"] !== "report.accuracy/2") {
    throw new ReportRefused(
      `schema is ${JSON.stringify(raw["schema"])}, not an accuracy report schema this build reads (${READABLE_REPORT_SCHEMAS.filter((s) => s.startsWith("report.accuracy")).join(", ")}) — an agreement report is not an accuracy report, and a continuous-integration gate is not something you build on agreement data`,
    );
  }
  const record = upcastReport(raw);
  if (record["against"] !== "golden") {
    throw new ReportRefused(`against is ${JSON.stringify(record["against"])}, not "golden"`);
  }
  if (record["capturedVia"] !== "injected-client-only") {
    throw new ReportRefused("capturedVia is missing; the artefact must state its own scope");
  }
  checkIntegers(record, ACCURACY_INTEGER_FIELDS);
  const cases = casesOf(record);
  const statuses = cases.map((c) => c["status"]);
  const count = (status: string): number => statuses.filter((s) => s === status).length;
  checkRates(record, cases, {
    correctBasisPoints: rateOf(count("correct"), cases.length),
    incorrectBasisPoints: rateOf(count("incorrect"), cases.length),
    // Unchanged in meaning across `/1` and `/2`: unmeasurable for reasons
    // attributable to the system under test. A provider outage left this bucket
    // when `could-not-evaluate` arrived; it did not change what the bucket means.
    unscoredBasisPoints: rateOf(count("unscored") + count("unattributed"), cases.length),
    contestedBasisPoints: rateOf(count("contested"), cases.length),
    couldNotEvaluateBasisPoints: rateOf(count("could-not-evaluate"), cases.length),
  });
  return record as unknown as AccuracyReport;
};

/**
 * The same honest re-entry for an agreement report.
 *
 * It exists because the ledger stores reports as JSON — a completed shadow run
 * of the same key must come back through a validating door, not a cast — and
 * because a caller doing agreement analysis across a process line was previously
 * offered nothing at all and would have written the cast themselves.
 *
 * **There is deliberately no `gate` that accepts what this returns.** The
 * disjointness is the point: agreement's baseline is human behaviour including
 * human error, so 97% agreement is 97% agreement, and no amount of re-entry
 * turns it into a build verdict.
 */
export const reopenAgreementReport = (value: unknown): AgreementReport => {
  const raw = asRecord(value, "an agreement report");
  if (raw["schema"] !== "report.agreement/1" && raw["schema"] !== "report.agreement/2") {
    throw new ReportRefused(
      `schema is ${JSON.stringify(raw["schema"])}, not an agreement report schema this build reads`,
    );
  }
  const record = upcastReport(raw);
  if (record["against"] !== "recorded-human-decisions") {
    throw new ReportRefused(
      `against is ${JSON.stringify(record["against"])}, not "recorded-human-decisions"`,
    );
  }
  if (record["capturedVia"] !== "injected-client-only") {
    throw new ReportRefused("capturedVia is missing; the artefact must state its own scope");
  }
  if (typeof record["humanDecisionSource"] !== "string" || record["humanDecisionSource"] === "") {
    throw new ReportRefused(
      "humanDecisionSource is missing; an agreement figure with no named source is not evidence of anything",
    );
  }
  checkIntegers(record, AGREEMENT_INTEGER_FIELDS);
  const cases = casesOf(record);
  const statuses = cases.map((c) => c["status"]);
  const count = (status: string): number => statuses.filter((s) => s === status).length;
  checkRates(record, cases, {
    agreementBasisPoints: rateOf(count("agreed"), cases.length),
    disagreedBasisPoints: rateOf(count("disagreed"), cases.length),
    unscoredBasisPoints: rateOf(count("unscored") + count("unattributed"), cases.length),
    contestedBasisPoints: rateOf(count("contested"), cases.length),
    couldNotEvaluateBasisPoints: rateOf(count("could-not-evaluate"), cases.length),
  });
  return record as unknown as AgreementReport;
};
