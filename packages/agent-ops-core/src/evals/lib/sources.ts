import type { CorrelationId, ReplayedCase } from "../../audit/index.js";
import { canonicalPayloadForm, digestOf } from "./canonical.js";
import { DuplicateCaseRef, LimitOutOfRange, SuiteEmpty, SuiteVersionMismatch } from "./errors.js";
import type {
  CaseDigest,
  CaseRef,
  CaseSource,
  EvalCase,
  EvalPayload,
  ObservationWindow,
  RiskTier,
  SourceDigest,
  Verdict,
} from "./types.js";

/**
 * The two case-source adapters, and the seam between them.
 *
 * **Adapter 1, `goldenSuite`** — golden cases: correct *by construction*,
 * adjudicated deliberately by a named person, held under version control. A
 * passing golden set is a stable regression signal and is **not** evidence that
 * today's traffic is being handled well; the suite is frozen while production
 * drifts.
 *
 * **Adapter 2, `recordedCases`** — a shadow run: real cases replayed with the
 * verdicts having no effect, compared against what humans actually did. The
 * absence of effect is structural (the subject holds a `Client<"read">` and
 * cannot express a write), not a flag someone remembered to set.
 *
 * The report type is derived from which of these produced the cases (graft 7),
 * so agreement-is-not-accuracy is a consequence of provenance rather than a
 * naming convention nineteen teams must remember.
 */

const verdictDigestForm = (verdict: Verdict): EvalPayload => ({
  "verdict.disposition": verdict.disposition,
  "verdict.conclusion": verdict.conclusion,
  "verdict.confidenceBasisPoints": verdict.confidenceBasisPoints,
  "verdict.because": verdict.because,
});

const caseDigestOf = (
  ref: string,
  tier: RiskTier,
  input: EvalPayload,
  expected: Verdict,
): CaseDigest =>
  digestOf([
    JSON.stringify(ref),
    JSON.stringify(tier),
    canonicalPayloadForm(input),
    canonicalPayloadForm(verdictDigestForm(expected)),
  ]) as CaseDigest;

/* --------------------------------------------------------------- golden cases */

export interface GoldenCaseDraft {
  readonly ref: string;
  /** The tier of the decision this case exercises, not of the case. */
  readonly tier: RiskTier;
  /** Flat, integer-only, and already free of personal data. */
  readonly input: EvalPayload;
  /** What the right answer is. An abstention is a legitimate right answer. */
  readonly expected: Verdict;
  /** Who adjudicated it. A golden case with no author is folklore. */
  readonly adjudicatedBy: string;
  readonly adjudicatedAt: number;
}

export interface GoldenSuiteInput {
  readonly cases: readonly GoldenCaseDraft[];
  /**
   * Pin the expected content address. Optional in the type and load-bearing in
   * practice: with it, editing a golden case without re-versioning is a hard
   * error at construction — before the first model call and before any spend.
   */
  readonly expectDigest?: string;
}

/**
 * Content-addresses a suite at construction, so **there is no unversioned suite
 * for a report to be refused against**. Interface fact 4's refusal becomes
 * vacuous rather than a runtime check somebody can skip.
 *
 * Cases are ordered by reference before hashing, so the digest depends on the
 * set of cases and not on the order they were listed in.
 */
export const goldenSuite = (input: GoldenSuiteInput): CaseSource<"golden"> => {
  if (input.cases.length === 0) throw new SuiteEmpty();
  // Refused at construction. Two cases under one reference both execute and both
  // open a `case` node, but the runner keys results by reference — so the report
  // showed `casesRun: 2` with the same node id listed twice and one execution's
  // outcome silently discarded. The trace and the report then disagree about
  // what happened, and the trace is the one thing that must not be arguable.
  const seen = new Set<string>();
  for (const draft of input.cases) {
    if (seen.has(draft.ref)) throw new DuplicateCaseRef(draft.ref);
    seen.add(draft.ref);
  }
  const ordered = [...input.cases].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const cases: EvalCase<"golden">[] = ordered.map((draft) => ({
    ref: draft.ref as CaseRef,
    digest: caseDigestOf(draft.ref, draft.tier, draft.input, draft.expected),
    tier: draft.tier,
    input: draft.input,
    expectation: {
      kind: "correct-by-construction",
      verdict: draft.expected,
      adjudicatedBy: draft.adjudicatedBy,
      adjudicatedAt: draft.adjudicatedAt,
    },
  }));
  const digest = digestOf(cases.map((c) => c.digest)) as SourceDigest;
  if (input.expectDigest !== undefined && input.expectDigest !== digest) {
    throw new SuiteVersionMismatch(input.expectDigest, digest);
  }
  // `selection: null` — this is the whole suite. `preMergeSubset` produces the
  // other shape, with its own digest, so the two can never be confused.
  return { kind: "golden", digest, size: cases.length, cases, provenance: null, selection: null };
};

/* ------------------------------------------------------------- recorded cases */

/**
 * What a human actually decided, and who they were.
 *
 * The seam has two shipped adapters, and the second is not hypothetical: the
 * bootstrap shadow run for any of the nineteen applications compares against
 * reviewers whose decisions were never in `audit`, because the system did not
 * exist yet.
 */
export interface HumanDecisionSource {
  /** Named, and recorded on the report. A figure with no named source is not evidence. */
  readonly id: string;
  /** Called once per case at source construction. Bounded by `maxCases`. */
  readonly decisionFor: (correlationId: string) => Promise<RecordedHumanDecision | undefined>;
}

export interface RecordedHumanDecision {
  readonly verdict: Verdict;
  /** The named authority. "The system approved it" never appears in a trace. */
  readonly authority: string;
  readonly at: number;
}

/**
 * Adapter 1 — read what the human decided out of the case's own `audit` trace.
 *
 * This is the literal expression of `OPEN-ITEMS-RESOLVED` item 4: an eval run
 * **reads** the audit store and **writes** its own. Nothing here appends to
 * `audit`; a trace never spans both stores.
 *
 * The node it looks for is named by `payloadKind`, and the four fields it reads
 * are named here rather than guessed, because a shadow run whose comparison
 * baseline came from an unstated field is a number nobody can audit.
 */
export const humanDecisionsFromAuditTrace = (input: {
  readonly replay: (correlationId: CorrelationId) => Promise<ReplayedCase>;
  readonly payloadKind: string;
}): HumanDecisionSource => ({
  id: `audit-trace:${input.payloadKind}`,
  async decisionFor(correlationId) {
    const replayed = await input.replay(correlationId as CorrelationId);
    // Last matching node wins: a case re-judged appends a new decision, it never
    // edits the old one, so the final one is the decision that stood.
    let found: RecordedHumanDecision | undefined;
    for (const node of replayed.nodes) {
      if (node.payload["kind"] !== input.payloadKind) continue;
      const disposition = node.payload["disposition"];
      const authority = node.payload["authority"];
      if (disposition !== "determine" && disposition !== "abstain") continue;
      if (typeof authority !== "string") continue;
      const conclusion = node.payload["conclusion"];
      const confidence = node.payload["confidenceBasisPoints"];
      found = {
        verdict: {
          disposition,
          conclusion: typeof conclusion === "string" ? conclusion : "",
          confidenceBasisPoints: typeof confidence === "number" ? confidence : 0,
          because: disposition === "abstain" ? String(node.payload["because"] ?? "") : null,
        },
        authority,
        at: node.at,
      };
    }
    return found;
  },
});

/**
 * Adapter 2 — decisions made before this system existed, exported from a
 * ticketing system, a spreadsheet or a reviewer's queue.
 *
 * Not a mock and not hypothetical. Every one of the nineteen applications has a
 * first shadow run, and at that point there is no `audit` history to compare
 * against — the reviewers were working in whatever they were working in.
 */
export const legacyReviewerExport = (input: {
  readonly id: string;
  readonly rows: readonly {
    readonly correlationId: string;
    readonly verdict: Verdict;
    readonly authority: string;
    readonly at: number;
  }[];
}): HumanDecisionSource => {
  const byId = new Map(input.rows.map((r) => [r.correlationId, r]));
  return {
    id: `legacy-export:${input.id}`,
    async decisionFor(correlationId) {
      const row = byId.get(correlationId);
      return row === undefined
        ? undefined
        : { verdict: row.verdict, authority: row.authority, at: row.at };
    },
  };
};

export interface RecordedCaseDraft {
  readonly correlationId: string;
  readonly tier: RiskTier;
  /** Already redacted — it came out of a store that redacts before write. */
  readonly input: EvalPayload;
}

export interface RecordedCasesInput {
  readonly cases: readonly RecordedCaseDraft[];
  /** Required and named. Mirrors `CONTEXT.md`'s rule for resolution evidence. */
  readonly humanDecisions: HumanDecisionSource;
  /** Required. A window is half of what makes the number readable later. */
  readonly window: ObservationWindow;
  /** Required. A source that cannot bound itself is not a bounded source. */
  readonly maxCases: number;
}

/**
 * Cases replayed from production, paired with what a human actually did.
 *
 * A case with **no** human decision inside the window is dropped rather than
 * scored against nothing, and the count of dropped cases reaches the report —
 * on `provenance`, which `run` reads and stamps onto both a `source` node and
 * `AgreementReport.withoutHumanDecision` — so an agreement figure computed over
 * a quietly-shrinking cohort is visible rather than flattering.
 *
 * ## What this does, stated accurately
 *
 * `index.ts` used to list this among the constructors that "evaluate nothing,
 * open no node and reach no store". That was false in every clause: it is
 * `async`, it calls `humanDecisions.decisionFor` once per case, and the shipped
 * `humanDecisionsFromAuditTrace` adapter replays against the **audit store** —
 * so it performs up to `maxCases` sequential round trips before a run exists.
 *
 * It still records no node, because no run is open yet and a trace never spans
 * both stores. What it *can* do is hand the facts forward: the source carries
 * `considered`, `withoutHumanDecision`, the named adapter and the window, and
 * `run` writes all four onto a `source` node under the run. The cohort's
 * assembly is therefore in the trace even though the I/O that produced it is
 * not — which is the honest version of the claim, and is why it is written here
 * rather than in a summary somewhere.
 */
export const recordedCases = async (
  input: RecordedCasesInput,
): Promise<CaseSource<"recorded">> => {
  if (!Number.isSafeInteger(input.maxCases) || input.maxCases < 1 || input.maxCases > 1_000_000) {
    throw new LimitOutOfRange("recordedCases.maxCases", input.maxCases, "1..1000000 (integer)");
  }
  const taken = input.cases.slice(0, input.maxCases);
  const seen = new Set<string>();
  for (const draft of taken) {
    if (seen.has(draft.correlationId)) throw new DuplicateCaseRef(draft.correlationId);
    seen.add(draft.correlationId);
  }
  const cases: EvalCase<"recorded">[] = [];
  let withoutHumanDecision = 0;
  for (const draft of taken) {
    const decision = await input.humanDecisions.decisionFor(draft.correlationId);
    if (
      decision === undefined ||
      decision.at < input.window.fromInclusive ||
      decision.at >= input.window.toExclusive
    ) {
      withoutHumanDecision += 1;
      continue;
    }
    cases.push({
      ref: draft.correlationId as CaseRef,
      digest: caseDigestOf(draft.correlationId, draft.tier, draft.input, decision.verdict),
      tier: draft.tier,
      input: draft.input,
      expectation: {
        kind: "recorded-human-decision",
        verdict: decision.verdict,
        correlationId: draft.correlationId,
        authority: decision.authority,
      },
    });
  }
  if (cases.length === 0) throw new SuiteEmpty();
  cases.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return {
    kind: "recorded",
    digest: digestOf(cases.map((c) => c.digest)) as SourceDigest,
    size: cases.length,
    cases,
    provenance: {
      humanDecisionSource: input.humanDecisions.id,
      window: input.window,
      withoutHumanDecision,
      considered: taken.length,
    },
    // A cohort is already a bounded slice of production, bounded by `maxCases`
    // and by the window, and both are on `provenance`. Subsetting it again would
    // be a second denominator nobody could read.
    selection: null,
  };
};
