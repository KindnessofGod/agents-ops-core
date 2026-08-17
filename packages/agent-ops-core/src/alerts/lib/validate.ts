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

import { AlertPayloadInvalid, UnknownAlertCondition } from "./errors.js";
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
