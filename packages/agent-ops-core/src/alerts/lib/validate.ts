/**
 * The one place a condition is checked before it becomes evidence.
 *
 * Two rules, both from the project's production constraints rather than from
 * taste:
 *
 *   - **Integers only.** Every number crossing into a payload is a safe integer.
 *     Durations in milliseconds, rates in basis points, counts as counts. Floats
 *     are how byte-stable serialisation dies quietly, and a payload that
 *     serialises differently on two hosts is not evidence of anything.
 *   - **Bounded identifiers.** Identifiers are the application's, and an
 *     unbounded one is an unbounded page, an unbounded stream record and an
 *     unbounded node. Bounded here, once, rather than in each of three adapters.
 *
 * Note what is deliberately *not* checked: whether an identifier contains
 * personal data. It cannot be — an opaque identifier is opaque. The structural
 * protection is that no condition in this module has a free-text field, so the
 * only strings that reach a channel are enumerated values this module owns and
 * identifiers the application chose. That limit is stated in `index.ts` rather
 * than papered over with a regular expression that would catch nothing.
 */

import { AlertPayloadInvalid, LivenessBeatUnrecordable, UnknownAlertCondition } from "./errors.js";
import { SEVERITY_BY_CONDITION, type AlertCondition } from "./conditions.js";
import type { AlertPayload } from "./primitives.js";

/**
 * Throws `UnknownAlertCondition` for a kind outside the closed union. The
 * compile-time union is the real guarantee; this catches the JavaScript caller
 * and the deserialised payload, which the type system never saw.
 */
export const assertKnownCondition = (condition: AlertCondition): void => {
  if (!Object.prototype.hasOwnProperty.call(SEVERITY_BY_CONDITION, condition.kind)) {
    throw new UnknownAlertCondition(String((condition as { kind: unknown }).kind));
  }
};

/**
 * Throws `AlertPayloadInvalid` on the first field that cannot be recorded
 * byte-stably or is over the identifier ceiling.
 *
 * Iterating the built payload rather than the condition is deliberate: the
 * payload is what a sink transmits and what the journal records, so checking it
 * checks the thing that actually leaves.
 */
export const assertRecordablePayload = (
  payload: AlertPayload,
  maxIdentifierChars: number,
): void => {
  for (const [field, value] of Object.entries(payload)) {
    if (value === undefined || value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new AlertPayloadInvalid(field, `${String(value)} is not a finite number`);
      }
      if (!Number.isSafeInteger(value)) {
        throw new AlertPayloadInvalid(
          field,
          `${value} is not a safe integer — durations are milliseconds, rates are basis points, and IEEE-754 does not survive replay`,
        );
      }
      continue;
    }
    if (typeof value === "string") {
      if (value.length === 0) {
        throw new AlertPayloadInvalid(field, "identifier is empty");
      }
      if (value.length > maxIdentifierChars) {
        throw new AlertPayloadInvalid(
          field,
          `identifier is ${value.length} characters, over the ${maxIdentifierChars}-character ceiling`,
        );
      }
      continue;
    }
    throw new AlertPayloadInvalid(field, `${typeof value} is not a recordable field type`);
  }
};

/**
 * The same two rules applied to the one write in this module that is not a
 * payload: a beat.
 *
 * A liveness record is compared against an injected clock to decide whether a
 * component is dead, so a fractional or unsafe instant makes that comparison
 * meaningless — and rounding one silently is how a two-minute detection window
 * quietly becomes something else. Kept here rather than in either store so both
 * adapters enforce it identically; obligation 6 of `livenessStoreContract` is
 * what proves they do.
 */
export const assertRecordableBeat = (
  component: string,
  at: number,
  run: { readonly ran: "did-work"; readonly itemsProcessed: number } | { readonly ran: "nothing-was-due" },
): void => {
  if (!Number.isSafeInteger(at)) {
    throw new LivenessBeatUnrecordable(component, "at", `not a safe integer: ${String(at)}`);
  }
  if (run.ran === "did-work" && (!Number.isSafeInteger(run.itemsProcessed) || run.itemsProcessed < 0)) {
    throw new LivenessBeatUnrecordable(
      component,
      "itemsProcessed",
      `not a non-negative safe integer: ${String(run.itemsProcessed)}`,
    );
  }
};

/** The same, for the terms a component is watched on. */
export const assertRecordableWatch = (
  component: string,
  expectedEveryMs: number,
  since: number,
): void => {
  if (!Number.isSafeInteger(expectedEveryMs) || expectedEveryMs <= 0) {
    throw new LivenessBeatUnrecordable(
      component,
      "expectedEveryMs",
      `not a positive safe integer: ${String(expectedEveryMs)} — a cadence of zero means every ` +
        `component is permanently overdue`,
    );
  }
  if (!Number.isSafeInteger(since)) {
    throw new LivenessBeatUnrecordable(component, "since", `not a safe integer: ${String(since)}`);
  }
};
