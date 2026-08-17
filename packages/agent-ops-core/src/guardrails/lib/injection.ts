import { deterministicDetector } from "./detectors.js";
import { LocaleUnsupported } from "./errors.js";
import { safePattern, type Pattern } from "./safe-pattern.js";
import type { CoverageNote } from "./coverage.js";
import type { Detector, Locale, NonEmpty, Severity } from "./types.js";

/**
 * A deterministic prompt-injection pack — the cheap tier's floor.
 *
 * ## Why it exists
 *
 * Injection screening was reachable only through `modelDetector`, so the low
 * tier — the highest-volume path, the one a model-class detector is deliberately
 * kept off — had **no injection screening at all**. Not weak screening: none.
 * Nineteen applications inherited that, and the gap did not present as a gap,
 * because a payload nobody screened for injection produces `recommend: "allow"`
 * exactly like a clean one.
 *
 * ## Read this before wiring it: deterministic injection detection is weak
 *
 * This is stated first, in the plainest words available, because the failure
 * mode of a weak detector is not a missed attack — it is the **reassurance**. A
 * screening that says `searchedAndFoundNone` over an injection this pack cannot
 * see reads exactly like a screening over harmless text, and a team that has
 * "injection screening" on a wiring diagram stops asking for the expensive kind.
 *
 * What defeats every rule below, without effort and without novelty:
 *
 *   - **Paraphrase.** "ignore previous instructions" is matched; "set aside what
 *     you were told a moment ago" is not, and means the same thing.
 *   - **Another language.** The rules are English. An instruction in Polish or
 *     Japanese passes untouched, and a model will follow it perfectly well.
 *   - **Encoding.** Base-64, hexadecimal, ROT-13, a data URL, or text split by
 *     zero-width characters this pack does not happen to enumerate.
 *   - **Splitting across fields.** Each field is screened alone. An instruction
 *     spread over `subject` and `narrative` is invisible to every rule here.
 *   - **Indirection.** The attack is in a document the model retrieves later,
 *     not in the payload this module was shown. Nothing here screens that.
 *
 * So: a **floor, not a ceiling**. What it honestly buys is three things — the
 * cheap tier gets the crude, high-volume attempts rather than nothing; a
 * deterministic hit is a fast, explainable, replayable finding that costs no
 * model call; and at the higher tiers it corroborates a model detector, which
 * matters because two independent detectors agreeing is evidence and one
 * classifier's score is an opinion. It is **not** a control an application may
 * cite as its injection defence, and `docs/business/WHAT-IT-WILL-NOT-DO.md`
 * should say so in those words.
 *
 * ## Why the default severity is `escalate` rather than `block` or `redact`
 *
 * `redact` masks the matched phrase, which destroys evidence of the attempt and
 * hands the model a payload that no longer says what the attacker wrote — the
 * worst of both. `block` stops the case on a rule that a customer quoting an
 * email can trip. `escalate` moves authority to a named human and records the
 * finding, which is the disposition that matches the strength of the evidence:
 * these rules are suggestive, not conclusive. An application that has measured
 * its false-positive rate should set its own.
 *
 * The false positives are real and worth naming: a claims narrative quoting a
 * customer's own message, a support ticket pasting a chat transcript, or a
 * document that discusses prompt injection will all fire these rules. That is
 * the cost of a floor, and it is visible on the trace rather than silent.
 */

/**
 * Zero-width and bidirectional-control characters.
 *
 * The strongest deterministic signal in the pack, and the only rule here that is
 * hard to write around: text that renders as one thing to a human reviewer and
 * another to a model has no innocent use in a claim, an invoice or a ticket.
 * Left-to-right and right-to-left overrides, zero-width spaces and joiners, and
 * the isolate controls used to reverse rendered order.
 */
const HIDDEN_CHARACTERS =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

const ENGLISH: readonly Pattern[] = [
  safePattern({
    rule: "injection.instruction-override",
    match: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|earlier|above|preceding|all)\b[^.\n]{0,40}\b(?:instruction|instructions|prompt|prompts|rule|rules|direction|directions)\b/gi,
    confidenceBasisPoints: 8_500,
    covers: "prompt-injection.instruction-override",
  }),
  safePattern({
    rule: "injection.role-hijack",
    match: /\b(?:you are now|from now on you|act as if you|pretend (?:to be|you are)|assume the role of|you must now)\b/gi,
    confidenceBasisPoints: 7_500,
    covers: "prompt-injection.role-hijack",
  }),
  safePattern({
    rule: "injection.system-prompt-exfiltration",
    match: /\b(?:reveal|repeat|print|output|show|display|summarise|summarize)\b[^.\n]{0,30}\b(?:your|the)\b[^.\n]{0,20}\b(?:system prompt|system message|instructions|initial prompt|guidelines)\b/gi,
    confidenceBasisPoints: 8_000,
    covers: "prompt-injection.system-prompt-exfiltration",
  }),
  safePattern({
    rule: "injection.delimiter-forgery",
    // Chat-turn and instruction delimiters forged inside a payload field: the
    // control-token vocabularies several model families use, plus a bare
    // "system:" at the start of a line.
    match: /<\|(?:im_start|im_end|system|endoftext|assistant|user)\|>|\[\/?INST\]|\[\/?SYS\]|(?:^|\n)\s{0,8}(?:system|assistant|developer)\s{0,4}:/gi,
    confidenceBasisPoints: 9_000,
    covers: "prompt-injection.delimiter-forgery",
  }),
  safePattern({
    rule: "injection.tool-coercion",
    match: /\b(?:run|execute|invoke|call)\b[^.\n]{0,20}\b(?:the following|this)\b[^.\n]{0,20}\b(?:command|code|script|tool|function|query)\b/gi,
    confidenceBasisPoints: 7_500,
    covers: "prompt-injection.tool-coercion",
  }),
  safePattern({
    rule: "injection.data-exfiltration",
    match: /\b(?:send|forward|post|upload|email|transmit)\b[^.\n]{0,40}\b(?:to|at)\b\s{0,4}(?:https?:\/\/|[\p{L}\p{N}._%+-]{1,64}@)/giu,
    confidenceBasisPoints: 7_000,
    covers: "prompt-injection.data-exfiltration",
  }),
  safePattern({
    rule: "injection.hidden-characters",
    match: HIDDEN_CHARACTERS,
    confidenceBasisPoints: 9_000,
    covers: "prompt-injection.hidden-characters",
  }),
  safePattern({
    rule: "injection.encoded-payload",
    match: /\b(?:base64|rot13|hex)\b[^.\n]{0,30}\b(?:decode|decoded|decoding|then follow|and follow|and execute)\b/gi,
    confidenceBasisPoints: 6_500,
    covers: "prompt-injection.encoded-payload",
  }),
  safePattern({
    rule: "injection.guardrail-defeat",
    match: /\b(?:developer mode|jailbreak|do anything now|without any restrictions|bypass (?:your |the )?(?:safety|filter|guardrail))\b/gi,
    confidenceBasisPoints: 7_500,
    covers: "prompt-injection.role-hijack",
  }),
];

/**
 * The gaps, and they are the larger half. Every one of these is trivially
 * reachable by an attacker who has read this file — or who has not.
 */
const ENGLISH_GAPS: readonly CoverageNote[] = [
  {
    category: "prompt-injection.paraphrase",
    why: "these are literal phrase shapes; the same instruction reworded in any of a thousand ways passes untouched, and rewording costs an attacker nothing",
  },
  {
    category: "prompt-injection.multilingual",
    why: "the rules are English only; an instruction in another language passes untouched and a model will follow it perfectly well",
  },
  {
    category: "prompt-injection.split-across-fields",
    why: "each field is screened alone, so an instruction spread across two fields is invisible to every rule here",
  },
  {
    category: "prompt-injection.indirect",
    why: "an attack carried in a document the model retrieves later is not in the payload this module was shown, and nothing here can see it",
  },
];

const PARTIAL: readonly CoverageNote[] = [
  {
    category: "prompt-injection.encoded-payload",
    why: "only an explicit instruction to decode is matched; the encoded payload itself is not decoded or inspected, so an unannounced base-64 blob passes",
  },
  {
    category: "prompt-injection.instruction-override",
    why: "matched as an English phrase shape; the technique is defeated by paraphrase and this rule should be read as a tripwire rather than a control",
  },
];

/**
 * The markets — really the languages — this pack ships rules for.
 *
 * Keyed by locale because everything in this module is, and because a locale is
 * what a caller already has. The honest caveat: injection is a **language**
 * problem, not a jurisdictional one, so `en-GB` and `en-US` share one identical
 * English pack. A market whose payloads are not in English gets no injection
 * screening from this library, which is why `localeOf("de-DE")` is refused here
 * rather than served the English rules.
 */
const PACKS: Readonly<Record<string, readonly Pattern[]>> = Object.freeze({
  "en-GB": ENGLISH,
  "en-US": ENGLISH,
});

export const SHIPPED_INJECTION_LOCALES: readonly string[] = Object.freeze(Object.keys(PACKS));

/**
 * The first adapter behind deterministic injection screening, and — being
 * deterministic — the one that costs nothing to run at every tier.
 *
 * Throws `LocaleUnsupported` at construction for a locale with no shipped pack.
 * Serving English rules to a market whose payloads are in another language is
 * the same failure as serving one market's personal-data formats to another: a
 * clean screening over patterns that could never have matched.
 */
export const promptInjectionDetector = (options: {
  readonly locale: Locale;
  readonly severity?: Severity;
  readonly id?: string;
  readonly fields?: readonly string[];
}): Detector => {
  const pack = PACKS[options.locale];
  if (pack === undefined) {
    throw new LocaleUnsupported(
      "guardrails.prompt-injection",
      options.locale,
      SHIPPED_INJECTION_LOCALES,
    );
  }
  return deterministicDetector({
    id: options.id ?? `injection.${options.locale}`,
    locales: [options.locale] as unknown as NonEmpty<string>,
    searches: `known prompt-injection phrase shapes and hidden characters for ${options.locale} (${pack.length} patterns); a floor, not a ceiling`,
    category: "prompt-injection",
    // See the file comment: `escalate` matches the strength of the evidence.
    // `redact` would destroy the evidence of the attempt; `block` would stop a
    // case on a rule a quoted customer email can trip.
    severity: options.severity ?? "escalate",
    patterns: pack as unknown as NonEmpty<Pattern>,
    partial: PARTIAL,
    doesNotCover: ENGLISH_GAPS,
    ...(options.fields === undefined ? {} : { fields: options.fields }),
  });
};
