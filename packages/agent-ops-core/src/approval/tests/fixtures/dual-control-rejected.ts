/**
 * Dual-control blindness, proved by the compiler.
 *
 * Every marked line must error, so this file is expected to produce zero
 * diagnostics. If someone adds an `outcome` field to `AnswerReceipt`, the
 * `@ts-expect-error` goes unused and the build fails — which is the point: the
 * exclusion is a missing property, not a rule for whoever builds the screen.
 */
import type { AnswerReceipt, ServedBrief } from "../../index.js";

declare const receipt: AnswerReceipt;
declare const brief: ServedBrief;

// @ts-expect-error — there is no `outcome` on an AnswerReceipt.
export const a = receipt.outcome;

// @ts-expect-error — nor a `choice`.
export const b = receipt.choice;

// @ts-expect-error — nor an `approved` flag under another name.
export const c = receipt.approved;

/* The first seat is not handed a prior answer at all: `priorAnswer` exists only
   on the second arm of the discriminated union, so reaching for it without
   narrowing does not compile. A phantom type parameter would have erased at
   this seam and let a renderer read it. */
// @ts-expect-error — `priorAnswer` is not on ServedBrief until `seat` narrows it.
export const d = brief.priorAnswer;

/* No answer is ever pre-selected, so there is nothing on a brief to
   pre-highlight with. */
// @ts-expect-error — no recommendation field exists.
export const e = brief.recommendedChoice;

// @ts-expect-error — nor a default answer.
export const f = brief.defaultAnswer;

/** The control: `seat` narrows, and then the receipt is reachable. */
export const g = (): string =>
  brief.seat === "second" ? String(brief.priorAnswer.by) : "first seat";
