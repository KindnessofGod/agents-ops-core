import { digestOf } from "./canonical.js";
import { EvalsError, PanelMisdeclared } from "./errors.js";
import type { ModelBackend, ModelId, ModelRequest, ModelResponse, PromptVersion } from "./clients.js";
import type { ScoreOutcome, Scorer, ScorerDigest, ScorerId, ScoringContext } from "./types.js";

/**
 * The two scorer adapters, and why the seam is real: they differ in determinism,
 * cost, latency and error mode. That is exactly why a judge is an adapter rather
 * than a feature of the runner.
 */

/**
 * Adapter 1 — deterministic. Compares disposition and conclusion.
 *
 * Note what it does *not* special-case: an abstention. Per `CONTEXT.md` an
 * abstention is a verdict and a successful outcome of a working system, so a
 * golden case may assert that abstaining is the correct answer, and a subject
 * that abstains where the case says abstain scores full marks.
 */
export const exactVerdict: Scorer = {
  descriptor: {
    id: "exactVerdict" as ScorerId,
    digest: digestOf(["exactVerdict/1"]) as ScorerDigest,
    determinism: "deterministic",
    judge: null,
  },
  async score(ctx: ScoringContext): Promise<ScoreOutcome> {
    const matched =
      ctx.observed.disposition === ctx.expected.disposition &&
      ctx.observed.conclusion === ctx.expected.conclusion;
    return { kind: "scored", valueBasisPoints: matched ? 10_000 : 0 };
  },
};

export interface JudgePanelInput {
  readonly model: ModelId;
  readonly promptVersion: PromptVersion;
  /** Odd and at least 3. A single judge call is an opinion. */
  readonly panelSize: number;
  /** Spread above which the panel is contested rather than scored. */
  readonly bandBasisPoints: number;
  /** The rubric text. Content-addressed into the scorer digest. */
  readonly rubric: string;
}

/**
 * Adapter 2 — model as judge. Non-deterministic, and it says so in its
 * descriptor rather than leaving the runner to guess.
 *
 * Three things it does that a naive implementation does not:
 *
 *  1. **Records the judge model and prompt version** on every sample, so "which
 *     judge produced this number" is answerable in three years from the trace
 *     rather than from somebody's memory.
 *  2. **Aggregates over n > 1** — odd, at least three, ceiling seven. Enforced at
 *     construction, so a misdeclared panel fails before the run rather than
 *     producing a number.
 *  3. **Surfaces disagreement rather than averaging it away.** A panel that
 *     splits beyond the declared band returns `contested`, carrying every
 *     sample — not a mean. Averaging is the specific dishonesty interface fact 6
 *     forbids: it turns "the ruler disagrees with itself" into a confident
 *     number in the middle.
 *
 * Each sample opens its own node through `ctx.node.child`, and the model call
 * inside it goes through the node-bound client — so a judge scorer that wants to
 * call a model has no client to call it with except the one that records.
 */
export const judgePanel = (input: JudgePanelInput): Scorer => {
  if (input.panelSize < 3 || input.panelSize > 7 || input.panelSize % 2 === 0) {
    throw new PanelMisdeclared(
      `panelSize=${input.panelSize}; must be odd and within 3..7 (a single judge call is an opinion)`,
    );
  }
  if (input.bandBasisPoints < 0 || input.bandBasisPoints > 10_000) {
    throw new PanelMisdeclared(`bandBasisPoints=${input.bandBasisPoints}; must be within 0..10000`);
  }
  return {
    descriptor: {
      id: "judgePanel" as ScorerId,
      digest: digestOf([
        "judgePanel/1",
        input.model,
        input.promptVersion,
        String(input.panelSize),
        input.rubric,
      ]) as ScorerDigest,
      determinism: "non-deterministic",
      judge: {
        model: input.model,
        promptVersion: input.promptVersion,
        panelSize: input.panelSize,
        bandBasisPoints: input.bandBasisPoints,
      },
    },
    async score(ctx: ScoringContext): Promise<ScoreOutcome> {
      const samples: number[] = [];
      for (let member = 0; member < input.panelSize; member += 1) {
        const request: ModelRequest = {
          model: input.model,
          promptVersion: input.promptVersion,
          prompt: {
            rubric: input.rubric,
            member,
            seed: `${ctx.seed}:${String(member)}`,
            "observed.disposition": ctx.observed.disposition,
            "observed.conclusion": ctx.observed.conclusion,
            "expected.disposition": ctx.expected.disposition,
            "expected.conclusion": ctx.expected.conclusion,
          },
        };
        let sample: number | undefined;
        try {
          sample = await ctx.node.child(
            { name: "judge.sample", v: 1, payload: { member, model: input.model } },
            async (child) => parseBasisPoints((await child.client.complete(request)).text),
          );
        } catch (cause) {
          // **An incident is never downgraded to an outcome.** This used to be a
          // bare `catch {}`, and it swallowed two things it had no business
          // swallowing: `EvalStoreUnavailable`, which is fail-closed at every
          // tier with no configuration key, and `SubjectAttemptedWrite`, which
          // aborts the entire run. A store failing only on `judge.sample`
          // produced a green-looking report reading `unscored: judge-unavailable`
          // — an unrecorded eval run presented as a measured one, which is the
          // exact failure this module exists to prevent.
          if (cause instanceof EvalsError && cause.incident) throw cause;
          // A judge that could not be reached, after the runner's bounded
          // retries, makes the case `unscored`. `unscored` is never `passed`:
          // it counts against the gate, because a case nobody could measure is
          // not a case that went well.
          return { kind: "unscored", reason: "judge-unavailable" };
        }
        if (sample === undefined) return { kind: "unscored", reason: "judge-unparseable" };
        samples.push(sample);
      }
      const spread = Math.max(...samples) - Math.min(...samples);
      if (spread > input.bandBasisPoints) {
        return { kind: "contested", samplesBasisPoints: samples, spreadBasisPoints: spread };
      }
      const sorted = [...samples].sort((a, b) => a - b);
      // Median, not mean: an integer drawn from the samples, so no float ever
      // reaches a payload. The panel is within band here, so the median is a
      // fair summary rather than a smoothing-over of disagreement.
      const median = sorted[(sorted.length - 1) / 2] ?? 0;
      return { kind: "scored", valueBasisPoints: median };
    },
  };
};

/** A judge answers with an integer 0..10000. Anything else is unparseable. */
const parseBasisPoints = (text: string): number | undefined => {
  const match = /^\s*(\d{1,5})\s*$/.exec(text);
  if (match?.[1] === undefined) return undefined;
  const value = Number.parseInt(match[1], 10);
  return value >= 0 && value <= 10_000 ? value : undefined;
};

/**
 * A shipped model backend that answers from a script.
 *
 * A **deliverable, not a mock**: it is what makes hermeticity structural rather
 * than conventional. This module contains nothing that can open a socket, so a
 * test wired to this backend cannot reach a live model with real credentials in
 * the environment — there is nothing in here to reach one with.
 */
export const scriptedModelBackend = (input: {
  readonly id: string;
  readonly answer: (request: ModelRequest) => ModelResponse | Promise<ModelResponse>;
}): ModelBackend => ({
  id: input.id,
  async complete(request, signal) {
    if (signal.aborted) throw new DOMException("aborted before dispatch", "AbortError");
    return input.answer(request);
  },
});
