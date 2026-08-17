import { createHash } from "node:crypto";

import { NonIntegerPayload } from "./errors.js";

/**
 * Byte-stable serialisation.
 *
 * Keys sorted, `undefined` dropped, `null` explicit, and **every number
 * asserted to be a safe integer before it is written**. Money is in minor
 * units, latency in microseconds, confidence in basis points. There is no
 * IEEE-754 anywhere in a payload, because floats are how byte-stability dies
 * quietly: a trace that does not round-trip is not evidence, and nobody
 * discovers that until the year they need it.
 *
 * How payloads version for seven-year readability:
 *
 *   - every node payload carries `v` (the node payload schema version),
 *     `pointId` and `pointSchemaVersion`;
 *   - fields may be **added**; never removed, never retyped, never re-meaninged;
 *   - `kind` and `pointId` are open strings against a documented registry, so a
 *     2026 trace naming a node kind that no longer exists still parses in 2033
 *     rather than throwing at the decoder;
 *   - a semantic change to a decision point takes a new `pointId`, not a
 *     version bump.
 */

export type Canonical =
  | string
  | number
  | boolean
  | null
  | readonly Canonical[]
  | { readonly [key: string]: Canonical };

const assertIntegers = (value: unknown, path: string): void => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new NonIntegerPayload(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertIntegers(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertIntegers(item, path === "" ? key : `${path}.${key}`);
    }
  }
};

const write = (value: unknown): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    default:
      break;
  }
  if (Array.isArray(value)) return `[${value.map(write).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${write(v)}`).join(",")}}`;
};

/** Sorted keys, integers only, `undefined` dropped. Identical bytes everywhere. */
export const canonicalJson = (value: unknown): string => {
  assertIntegers(value, "");
  return write(value);
};

/**
 * A 256-bit digest over canonical bytes, in hex.
 *
 * SHA-256, matching `audit` and `evals`. This replaced four FNV-1a lanes after
 * a security review found three guarantees resting on a construction that could
 * support none of them:
 *
 * 1. **Privacy.** `approval` digests approver reasons and string policy facts —
 *    supplier names, account references — and claimed nobody reading the trace
 *    could learn a string not already known to them. Against a low-entropy
 *    value that was false, and remains false for *any* unkeyed digest: a holder
 *    of `SELECT` enumerates candidate telephone numbers or sort codes offline
 *    and confirms. SHA-256 does not fix that, so the claim is corrected where
 *    it is made rather than left standing next to a stronger hash. The digest
 *    identifies; it does not conceal.
 * 2. **Evidence.** These digests record that a given brief was shown and a
 *    given reason written. A construction without second-preimage resistance
 *    cannot support an auditor proving a candidate string is the one recorded.
 *    SHA-256 can.
 * 3. **The money path.** The effect idempotency key and the suspension
 *    identifier are derived from this. A collision merges two distinct effects
 *    onto one claim, and the second returns the first's outcome without ever
 *    executing — a payment silently not made. Four 32-bit lanes sharing one
 *    multiplier is not a margin worth holding that on.
 *
 * `node:crypto` is a Node built-in, not a dependency any caller can swap for a
 * stub, and SHA-256 is identical across runtimes for the seven years these
 * traces must stay readable — which were the two reasons the hand-rolled
 * version existed.
 */
export const digest = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

