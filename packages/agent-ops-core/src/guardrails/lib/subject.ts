import { MASK } from "./types.js";
import type { Finding, FindingSite, NonEmpty, Payload, ScreenedPayload, Source, Sources } from "./types.js";

declare const SCREENED_MINT: unique symbol;

/**
 * The frozen view a detector receives, and the masking the module performs on
 * its own copy afterwards.
 *
 * Three separate guarantees live in this file and they are worth keeping apart.
 *
 * **Detectors are pure with respect to the payload, structurally.** The object
 * handed to a detector is `Object.freeze`d, and every module file is an ES
 * module and therefore strict, so an assignment throws rather than being
 * silently dropped. Even if a detector defeats that — via `Reflect`, or by
 * running in a context where the throw is swallowed — the module never reads
 * the subject again: masking, recording and the returned `ScreenedPayload` are
 * all built from `original`, a copy the detector never receives a reference to.
 *
 * **Detectors are pure with respect to the sources too, and this was the hole.**
 * `Sources` used to be handed over by reference: the object, its `items` array
 * and each `Source` were the caller's own, unfrozen. A detector could rewrite
 * the reference material a *sibling* detector was then judged against, and could
 * mutate the caller's array on the way out — a second influence channel the
 * interface said did not exist. `frozenSources` copies and freezes all three
 * levels, so the only thing a detector still has is the `DetectorReport` it
 * returns.
 *
 * **The module is the only redactor.** Detectors report *coordinates*, never
 * matched text, and this file does the masking. That inverts the usual shape:
 * a detector cannot forget to redact what it found, because redacting was never
 * its job, and a detector has no field on which it could carry a name or an
 * account number back out.
 *
 * ## What redaction does and does not cover, exactly
 *
 * Redaction is irreversible within the trace: the masked form is what gets
 * recorded and what a caller receives, and there is no un-writing.
 *
 * **The claim is about detected sites, and only about detected sites.** Text
 * that no detector flagged is recorded verbatim, bounded by
 * `maxRecordedFieldChars`. A free-text narrative carrying a name, an address or
 * a diagnosis in a shape no detector matched reaches the trace in full. That is
 * the residual risk nineteen regulated teams have to hold consciously, and the
 * two things that shrink it are a model-class detector on the same field and
 * `audit`'s deny-by-default `redactAllExcept` on the trace itself — see
 * `GUARDRAILS_TRACE_FIELDS` in `canonical.ts`.
 */

/** A deep-frozen copy. Assignment throws under strict mode; ES modules are strict. */
export const frozenView = (payload: { readonly [f: string]: string }): {
  readonly [f: string]: string;
} => {
  const copy: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of Object.keys(payload)) copy[field] = payload[field] as string;
  return Object.freeze(copy);
};

/**
 * A deep-frozen copy of the reference material.
 *
 * All three levels: the discriminated object, the `items` array, and each
 * `Source`. `text` is a primitive and therefore already immutable. Built once
 * per screening and shared by every detector, so what detector B is judged
 * against cannot depend on what detector A did.
 */
export const frozenSources = (sources: Sources): Sources =>
  sources.available
    ? Object.freeze({
        available: true as const,
        items: Object.freeze(
          sources.items.map((source) => Object.freeze({ id: source.id, text: source.text })),
        ) as unknown as NonEmpty<Source>,
      })
    : Object.freeze({ available: false as const, why: sources.why });

/**
 * Mask every site this module is obliged to mask.
 *
 * Two independent rules, and the second was missing entirely:
 *
 *   - **Every `personal-data` site, at every severity** — including `advisory`.
 *     Severity says what the *caller* should do with the payload it still holds;
 *     it gets no say in what reaches the trace, because there is no un-writing.
 *   - **Every site whose severity is `redact`, in every category.** `redact` is
 *     documented as "the site is masked before anything is recorded or
 *     returned", and it used to be a no-op for `prompt-injection`,
 *     `prohibited-content` and `ungrounded-claim`: three of the four categories
 *     silently recorded the raw text and recommended `allow`.
 *
 * Sites are applied per field, right to left, so an earlier mask does not shift
 * the coordinates of a later one. Overlapping sites are merged rather than
 * double-masked, which keeps the byte output stable however the detectors
 * happened to interleave.
 *
 * The output map has a **null prototype**. `fields["__proto__"] = text` on a
 * plain `{}` hits the prototype setter, creates no own property, and the next
 * read returns `Object.prototype` — which threw an unnamed `TypeError` from a
 * `.slice` further down, after nodes were already in the trace. A payload from
 * `JSON.parse` of untrusted input carries `__proto__` as an ordinary own
 * property, so this is reachable input, not a curiosity.
 */
export const maskFindings = (
  original: { readonly [f: string]: string },
  findings: readonly Finding[],
): {
  readonly fields: { readonly [f: string]: string };
  readonly maskedSites: number;
  /**
   * Code units of the original text that `MASK` replaced. Reported beside the
   * site count because they answer different questions: three sites is three
   * things found, and 41 code units is how much of the payload stopped being
   * readable. `Screening.coverage` needs the second to say how much text went
   * into the trace unmasked.
   */
  readonly maskedCodeUnits: number;
} => {
  const byField = new Map<string, FindingSite[]>();
  for (const finding of findings) {
    if (finding.category !== "personal-data" && finding.severity !== "redact") continue;
    const sites = byField.get(finding.at.field);
    if (sites === undefined) byField.set(finding.at.field, [finding.at]);
    else sites.push(finding.at);
  }

  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  let maskedSites = 0;
  let maskedCodeUnits = 0;
  for (const field of Object.keys(original)) {
    const text = original[field] as string;
    const sites = byField.get(field);
    if (sites === undefined || sites.length === 0) {
      fields[field] = text;
      continue;
    }
    const merged = mergeSites(sites);
    maskedSites += merged.length;
    let out = text;
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const site = merged[i] as { start: number; end: number };
      maskedCodeUnits += site.end - site.start;
      out = out.slice(0, site.start) + MASK + out.slice(site.end);
    }
    fields[field] = out;
  }
  return { fields: Object.freeze(fields), maskedSites, maskedCodeUnits };
};

const mergeSites = (
  sites: readonly FindingSite[],
): readonly { start: number; end: number }[] => {
  const ranges = sites
    .map((s) => ({ start: s.startCodeUnit, end: s.startCodeUnit + s.lengthCodeUnits }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
};

/**
 * Every field value is a string, checked before anything is recorded.
 *
 * `Payload` says `string` in the type, and a payload built by `JSON.parse` of
 * untrusted input is checked by nothing. Returns the offending field and why, or
 * `undefined` when the payload is screenable.
 */
export const unscreenableField = (
  payload: Payload,
): { readonly field: string; readonly detail: string } | undefined => {
  for (const field of Object.keys(payload)) {
    const value: unknown = payload[field];
    if (typeof value !== "string") {
      return { field, detail: `a payload field holds ${describe(value)}, not text` };
    }
  }
  return undefined;
};

const describe = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;

/**
 * The only place a `ScreenedPayload` comes into existence.
 *
 * The brand is a non-exported `unique symbol`, so no external object literal
 * satisfies the type: a caller cannot fabricate a payload that claims to have
 * been screened, and the only route to one is a `Screening`, which only exists
 * once its nodes are in the trace.
 */
export const mintScreenedPayload = (
  fields: { readonly [f: string]: string },
  maskedSites: number,
): ScreenedPayload =>
  Object.freeze({ fields, maskedSites }) as unknown as ScreenedPayload & {
    readonly [SCREENED_MINT]?: never;
  };
