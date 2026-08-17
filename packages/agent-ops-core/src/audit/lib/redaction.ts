import { RedactionUnsound } from "./errors.js";
import type { NodePayload, PayloadField, RedactionId, Redactor } from "./types.js";

/**
 * Redaction runs **before write**. There is no un-writing personal data, so
 * this is not a filter on the read path and not a store adapter's concern: it
 * happens in `audit` itself, and no store adapter ever receives the original
 * payload object.
 *
 * The marker is a fixed string so that redaction does not disturb byte-stable
 * serialisation: the same payload redacted by the same redactor produces the
 * same bytes on every host.
 *
 * `kind` and `v` are structural and are never redactable by any adapter. A node
 * whose discriminant was stripped is uninterpretable in 2033, which is a worse
 * outcome than the node not existing.
 *
 * ## Keys are data too, and the two adapters differ on them
 *
 * `docs/design/.../types.ts` tells a caller who needs structure to flatten it
 * with dotted keys — `"claimant.QQ123456C.amount"`. That instruction puts
 * personal data in a **key**, where redacting values does nothing at all. So
 * the two shipped adapters take genuinely different positions, and choosing
 * between them is choosing between those positions:
 *
 *   - `redactAllExcept` — deny by default, **key and value**. A field outside
 *     the allow list loses its name as well as its contents, because a name
 *     nobody listed is a name nobody reviewed.
 *   - `redactFields` — deny list, **value only**. The caller enumerated the
 *     field set, so the keys are theirs and are assumed reviewed. Weaker by
 *     construction, and it is the caller's job to know which situation they are
 *     in.
 *
 * ## Why the rebuild uses a null-prototype object
 *
 * `out[field] = value` on a plain `{}` is a silent no-op when `field` is
 * `__proto__`: the key vanishes rather than being redacted, so a recorded field
 * disappears from the evidence with no error and no marker, and it does so
 * *after* the payload was proven canonicalisable. `Object.create(null)` has no
 * `__proto__` setter to swallow the assignment.
 */

/** What a removed value is replaced with. Fixed, so the bytes stay stable. */
export const REDACTED = "[redacted]";

/**
 * What a removed **key** is replaced with, followed by its index among the
 * removed keys in sorted order. Deterministic, so byte-stability holds.
 *
 * What this still leaks, stated rather than hidden: the *number* of unlisted
 * fields. That is the price of keeping "a field was here" in the record at all,
 * and losing that would make a redacted node indistinguishable from a node that
 * never carried the field.
 */
export const REDACTED_KEY_PREFIX = "[redacted-field].";

const STRUCTURAL = new Set(["kind", "v"]);

/**
 * Value-only rebuild. `keep` decides which fields survive intact; the rest keep
 * their key and lose their value.
 */
const rebuildValues = (
  payload: NodePayload,
  keep: (field: string) => boolean,
): NodePayload => {
  const out: Record<string, PayloadField | undefined> = Object.create(null);
  for (const field of Object.keys(payload)) {
    const value = payload[field];
    if (value === undefined) continue;
    out[field] = STRUCTURAL.has(field) || keep(field) ? value : REDACTED;
  }
  return out as unknown as NodePayload;
};

/**
 * Key-and-value rebuild. A field outside `allowed` loses both halves. The
 * replacement key is positional in sorted order so the bytes are stable.
 */
const rebuildKeysAndValues = (
  payload: NodePayload,
  id: RedactionId,
  allowed: ReadonlySet<string>,
): NodePayload => {
  const out: Record<string, PayloadField | undefined> = Object.create(null);
  const removed = new Map<string, number>();

  for (const field of Object.keys(payload).sort()) {
    if (payload[field] === undefined) continue;
    if (STRUCTURAL.has(field) || allowed.has(field)) continue;
    removed.set(field, removed.size);
  }

  for (const field of Object.keys(payload)) {
    const value = payload[field];
    if (value === undefined) continue;
    if (STRUCTURAL.has(field) || allowed.has(field)) {
      if (field.startsWith(REDACTED_KEY_PREFIX)) {
        // An allowed field named like a redaction marker would collide with a
        // removed one and silently swallow it. Refuse to write rather than lose
        // a field to a name collision.
        throw new RedactionUnsound(
          id,
          `field ${field} collides with the redacted-key marker`,
        );
      }
      out[field] = value;
      continue;
    }
    out[`${REDACTED_KEY_PREFIX}${removed.get(field) ?? 0}`] = REDACTED;
  }

  return out as unknown as NodePayload;
};

const listId = (adapter: string, fields: readonly string[]): RedactionId =>
  `aoc.redact.${adapter}.v2(${[...fields].sort().join(",")})` as RedactionId;

/**
 * Deny by default, key and value. Only the named fields survive; everything
 * else loses its name and its contents.
 *
 * This is the adapter to reach for on any node whose payload comes from a model
 * or from a document — the fields you did not think of are exactly the ones
 * that carry a name, an account number or a date of birth, and a flattened key
 * carries them just as readily as a value does.
 */
export const redactAllExcept = (allow: readonly string[]): Redactor => {
  const allowed = new Set(allow);
  const id = listId("allow", allow);
  return {
    id,
    apply: (payload) => rebuildKeysAndValues(payload, id, allowed),
  };
};

/**
 * Deny list, value only. Named fields lose their value; everything else
 * survives, keys included.
 *
 * The second real adapter, and the one for structured domain payloads a team
 * fully controls — an invoice node with a known field set, where enumerating
 * what to strip is both possible and reviewable. Weaker than the allow list on
 * two counts rather than one: it does not catch a field nobody anticipated, and
 * it does not touch keys at all.
 */
export const redactFields = (deny: readonly string[]): Redactor => {
  const denied = new Set(deny);
  return {
    id: listId("deny", deny),
    apply: (payload) => rebuildValues(payload, (field) => !denied.has(field)),
  };
};
