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
 * A deterministic 128-bit-ish digest over canonical bytes, in hex.
 *
 * FNV-1a run over four offset lanes. Not a cryptographic hash and not claimed
 * to be one: it identifies an idempotency key and a brief digest, it does not
 * authenticate anything. It is here rather than `node:crypto` so the module has
 * no dependency a caller could swap for a stub, and so the value is identical
 * across runtimes for seven years.
 */
export const digest = (input: string): string => {
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  const out: string[] = [];
  for (const seed of lanes) {
    let h = seed >>> 0;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= input.charCodeAt(i) >>> 8;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out.push(h.toString(16).padStart(8, "0"));
  }
  return out.join("");
};
