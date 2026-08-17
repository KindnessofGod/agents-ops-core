import { DEFAULT_LIMITS } from "./limits.js";
import type {
  Claim,
  Classifier,
  Detector,
  DetectorId,
  DetectorReport,
  FindingDraft,
  Groundedness,
  GroundednessId,
  GroundednessScore,
  GroundednessSubject,
  Locale,
  NonEmpty,
  Payload,
  ScreeningSubject,
  Severity,
  Source,
} from "./types.js";

/**
 * Groundedness — comparing an output against reference material — is
 * implemented **once**, here, and shaped so `evals` can consume it as a
 * `Scorer`. If both modules implemented it we would have built the same thing
 * twice and produced exactly the mediocrity the four-module decision exists to
 * avoid.
 *
 * What makes the shape reusable is what it does *not* take. `score` is a
 * function of `(claims, sources)` returning an integer: no correlation
 * identifier, no recorder, no tier, no clock. A scorer has none of those, and a
 * guardrail can supply them from outside. This module does not import `evals`
 * and never will — the dependency runs `evals` → `guardrails`.
 *
 * `sources: NonEmpty<Source>` on the subject is the load-bearing detail. "We
 * could not check" is handled before this interface and cannot be passed into
 * it, so no implementation has to decide what an empty source set means, and
 * none of them can decide it means "pass".
 *
 * Two adapters ship, which is what makes `Groundedness` a real seam rather than
 * a hypothetical one: `overlapGroundedness` (deterministic) and
 * `judgeGroundedness` (a model, behind an injected `Classifier`).
 */

const STOPWORDS = new Set(
  "a an the and or but if then than that this these those of to in on at by for with from as is are was were be been being it its into over under not no we you they he she i our your their".split(
    " ",
  ),
);

const tokenise = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));

/**
 * Split an output into claims, one per sentence, with the coordinates each
 * occupies in its field.
 *
 * Deterministic and dependency-free, and therefore crude: it splits on sentence
 * terminators and does not understand abbreviations, quotations or lists. The
 * limit is stated rather than hidden — a caller with a better claim extractor
 * builds `Claim`s itself and calls `Groundedness.score` directly, which is
 * exactly the shape `evals` will use.
 */
export const sentenceClaims = (payload: Payload): readonly Claim[] => {
  const claims: Claim[] = [];
  for (const field of Object.keys(payload)) {
    const text = payload[field] as string;
    const pattern = /[^.!?\n]+[.!?]*/g;
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const raw = match[0];
      const leading = raw.length - raw.trimStart().length;
      const body = raw.trim();
      if (tokenise(body).length === 0) continue;
      claims.push({
        id: `${field}@${match.index + leading}`,
        text: body,
        at: {
          field,
          startCodeUnit: match.index + leading,
          lengthCodeUnits: body.length,
        },
      });
    }
  }
  return claims;
};

/**
 * Adapter 1 — deterministic token overlap. Sub-millisecond, no I/O, no model.
 *
 * The headline number is the **weakest** claim, not the mean. One unsupported
 * sentence in an otherwise grounded paragraph is the sentence that matters, and
 * an average is precisely the operation that hides it.
 */
export const overlapGroundedness = (
  options: { readonly id?: string; readonly supportFloorBasisPoints?: number } = {},
): Groundedness => {
  const floor = options.supportFloorBasisPoints ?? 2_000;
  return {
    id: (options.id ?? "groundedness.overlap.v1") as GroundednessId,
    costClass: "deterministic",
    score(subject: GroundednessSubject): GroundednessScore {
      const sourceTokens = subject.sources.map(
        (source) => [source, new Set(tokenise(source.text))] as const,
      );
      const searched = `${subject.sources.length} named sources`;
      const perClaim = subject.claims.map((claim) => {
        const tokens = tokenise(claim.text);
        const supporting: Source[] = [];
        let best = 0;
        for (const [source, bag] of sourceTokens) {
          const hits = tokens.filter((t) => bag.has(t)).length;
          // Integers only. Basis points, floored — never a ratio.
          const bp = tokens.length === 0 ? 0 : Math.floor((hits * 10_000) / tokens.length);
          if (bp > best) best = bp;
          if (bp >= floor) supporting.push(source);
        }
        return supporting.length === 0
          ? {
              claim: claim.id,
              supportedBasisPoints: 0 as const,
              searchedAndFoundNone: { searched },
            }
          : {
              claim: claim.id,
              supportedBasisPoints: best,
              by: supporting.map((s) => s.id) as unknown as NonEmpty<
                Source["id"]
              >,
            };
      });
      return {
        supportedBasisPoints: perClaim.reduce(
          (weakest, c) => Math.min(weakest, c.supportedBasisPoints),
          10_000,
        ),
        claims: perClaim as unknown as GroundednessScore["claims"],
        costTenthCents: 0,
        modelCalls: 0,
      };
    },
  };
};

/**
 * Adapter 2 — a model judging each claim against the sources.
 *
 * The second real adapter behind the `Groundedness` seam, and the one `evals`
 * will reach for as a judge scorer. The classifier is **injected**: this module
 * never constructs one, so a test cannot reach a live model even with real
 * credentials in the environment.
 *
 * One model call per claim, **sequential**, which is why `groundednessDetector`
 * bounds the claim count and refuses rather than truncating, and why the
 * subject's `budgetMicros` is divided across the claims rather than handed whole
 * to each. A judge is non-deterministic by nature; the model and prompt version
 * travel on every claim's `by` list so a report can say which judge produced the
 * number.
 *
 * The honest limit, since the calls are sequential and this adapter holds no
 * clock: dividing the budget bounds what each call is *asked* for. It does not
 * cancel a call already in flight, and a classifier that ignores its
 * `budgetMicros` is not bounded by anything here. The engine's own budget check
 * then records the detector as `unavailable/timed-out` and the screening fails
 * closed, which is the outcome — not the prevention.
 */
export const judgeGroundedness = (options: {
  readonly classifier: Classifier;
  readonly id?: string;
  readonly label?: string;
  readonly supportFloorBasisPoints?: number;
}): Groundedness => {
  const label = options.label ?? "supported";
  const floor = options.supportFloorBasisPoints ?? 5_000;
  return {
    id: (options.id ??
      `groundedness.judge.${options.classifier.model}@${options.classifier.promptVersion}`) as GroundednessId,
    costClass: "model",
    async score(subject: GroundednessSubject): Promise<GroundednessScore> {
      const references = subject.sources
        .map((source) => `[${source.id}] ${source.text}`)
        .join("\n");
      const searched = `${subject.sources.length} named sources, judged by ${options.classifier.model}`;
      let costTenthCents = 0;
      let modelCalls = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      const priceTables = new Set<string>();
      // **The budget is divided across the claims, not discarded.** One model
      // call per claim, sequentially, so handing each of them the whole budget
      // — or, as this adapter used to, a hardcoded zero — is a bound that
      // cannot hold. `groundednessDetector` refuses above `maxClaims` rather
      // than truncating, so the count here is bounded before it arrives.
      const perClaim = Math.max(
        1,
        Math.floor(subject.budgetMicros / Math.max(1, subject.claims.length)),
      );
      const supports: GroundednessScore["claims"][number][] = [];
      for (const claim of subject.claims) {
        const response = await options.classifier.classify({
          labels: [label] as unknown as NonEmpty<string>,
          text: `CLAIM: ${claim.text}\nSOURCES:\n${references}`,
          budgetMicros: perClaim,
        });
        modelCalls += 1;
        costTenthCents += response.costTenthCents;
        tokensIn += response.tokensIn;
        tokensOut += response.tokensOut;
        priceTables.add(response.priceTableVersion);
        const bp = response.scores[label] ?? 0;
        supports.push(
          bp >= floor
            ? {
                claim: claim.id,
                supportedBasisPoints: bp,
                by: subject.sources.map((s) => s.id) as unknown as NonEmpty<Source["id"]>,
              }
            : {
                claim: claim.id,
                supportedBasisPoints: 0 as const,
                searchedAndFoundNone: { searched },
              },
        );
      }
      return {
        supportedBasisPoints: supports.reduce(
          (weakest, c) => Math.min(weakest, c.supportedBasisPoints),
          10_000,
        ),
        claims: supports as unknown as GroundednessScore["claims"],
        costTenthCents,
        modelCalls,
        ...(modelCalls === 0
          ? {}
          : {
              spend: {
                tokensIn,
                tokensOut,
                priceTableVersion: [...priceTables].sort().join(","),
              },
            }),
      };
    },
  };
};

export interface GroundednessDetectorSpec {
  readonly id: string;
  readonly locales: NonEmpty<string>;
  readonly groundedness: Groundedness;
  /** A claim below this is reported as a finding. Basis points. */
  readonly minimumSupportBasisPoints: number;
  readonly severity: Severity;
  /** Bounded. Above these the detector refuses rather than truncating. */
  readonly maxClaims?: number;
  readonly maxSources?: number;
}

/**
 * `Groundedness` wrapped as a `Detector`, which is how `guardrails` consumes
 * the one implementation without owning a second entry point for it.
 *
 * Three refusals, all fail-closed and all deliberate:
 *
 *   - **No sources** → `unavailable`. Cannot check is never pass. The engine
 *     raises its own `sources-missing` ground as well, so the abstention holds
 *     whether or not this detector is wired in.
 *   - **Too many claims or sources** → `unavailable`. Truncating would produce a
 *     `Screening` asserting a search over text nobody searched, and the caller
 *     would hold evidence of a check that did not happen.
 *   - **Wired into an input set** → `unavailable`, because an input has nothing
 *     to be grounded against. That is the correct answer to the wiring mistake
 *     rather than a silent clean pass.
 */
export const groundednessDetector = (spec: GroundednessDetectorSpec): Detector => {
  const maxClaims = spec.maxClaims ?? DEFAULT_LIMITS.maxClaims;
  const maxSources = spec.maxSources ?? DEFAULT_LIMITS.maxSources;
  return {
    id: spec.id as DetectorId,
    costClass: spec.groundedness.costClass,
    locales: spec.locales as unknown as NonEmpty<Locale>,
    searches: `claims unsupported by the named sources (${spec.groundedness.id})`,
    async screen(subject: ScreeningSubject): Promise<DetectorReport> {
      if (!subject.sources.available) {
        return {
          outcome: "unavailable",
          reason: "declared",
          detail: `no reference material: ${subject.sources.why}`,
        };
      }
      const sources = subject.sources.items;
      if (sources.length > maxSources) {
        return {
          outcome: "unavailable",
          reason: "declared",
          detail: `${sources.length} sources exceeds the bound of ${maxSources}`,
        };
      }
      const claims = sentenceClaims(subject.fields);
      if (claims.length > maxClaims) {
        return {
          outcome: "unavailable",
          reason: "declared",
          detail: `${claims.length} claims exceeds the bound of ${maxClaims}`,
        };
      }
      if (claims.length === 0) {
        return { outcome: "searched-and-found-none", costTenthCents: 0, modelCalls: 0 };
      }

      const score = await spec.groundedness.score({
        claims: claims as unknown as NonEmpty<Claim>,
        sources,
        // The budget travels down the seam rather than being dropped at it.
        budgetMicros: subject.budgetMicros,
      });
      const byId = new Map(claims.map((c) => [c.id, c]));
      const drafts: FindingDraft[] = [];
      for (const support of score.claims) {
        if (support.supportedBasisPoints >= spec.minimumSupportBasisPoints) continue;
        const claim = byId.get(support.claim);
        if (claim === undefined) continue;
        drafts.push({
          category: "ungrounded-claim",
          severity: spec.severity,
          rule: `${spec.groundedness.id}:below-${spec.minimumSupportBasisPoints}`,
          at: claim.at,
          // How confident we are the claim is *un*grounded, which is the
          // complement of how well it was supported.
          confidenceBasisPoints: 10_000 - support.supportedBasisPoints,
        });
      }
      const spend = score.spend === undefined ? {} : { spend: score.spend };
      return drafts.length === 0
        ? {
            outcome: "searched-and-found-none",
            costTenthCents: score.costTenthCents,
            modelCalls: score.modelCalls,
            ...spend,
          }
        : {
            outcome: "found",
            findings: drafts as unknown as NonEmpty<FindingDraft>,
            costTenthCents: score.costTenthCents,
            modelCalls: score.modelCalls,
            ...spend,
          };
    },
  };
};
