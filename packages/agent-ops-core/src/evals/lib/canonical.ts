import { createHash } from "node:crypto";
import { UnserialisablePayload } from "./errors.js";
import type { EvalPayload } from "./types.js";

/**
 * Byte-stable serialisation for eval nodes, suites and reports.
 *
 * The rules are stated in full so they can be reimplemented from this comment
 * alone by someone in 2033 holding nothing but rows:
 *
 *   1. **Envelope version.** Every canonical form is produced under a named
 *      envelope. Changing any rule below means a **new** version, never a
 *      silent edit to this one. Nodes written under the old envelope keep their
 *      old bytes forever.
 *   2. **Objects** render as `{"k":v,...}` with keys sorted ascending by UTF-16
 *      code unit — ECMA-262 relational comparison, which is fully specified and
 *      therefore reproducible outside JavaScript.
 *   3. **Keys whose value is `undefined` are dropped** before sorting, so an
 *      absent key and an explicitly-undefined key are the same bytes. `null` is
 *      preserved and is distinct from absent.
 *   4. **Numbers must be safe integers.** A float, `NaN`, `Infinity` or an
 *      integer beyond 2^53-1 throws `UnserialisablePayload` before any write.
 *      `-0` normalises to `0`. This is graft 6 of `FINDINGS.md`: cost in
 *      tenth-cents, latency in micros, scores in basis points, and no
 *      IEEE-754 anywhere.
 *   5. **Strings** render via `JSON.stringify`, whose escaping is specified by
 *      ECMA-262 `QuoteJSONString`.
 *   6. **Payloads are flat.** Arrays and nested objects are rejected inside a
 *      payload. Nesting would need canonical rules for array order and for key
 *      collision across levels, and every such rule is a place a 2033 reader
 *      can be misled. Flatten with dotted keys instead.
 *   7. **No whitespace anywhere.**
 *
 * This mirrors `audit`'s canonicalisation deliberately and does not import it:
 * the two modules write to two different stores under two different retention
 * regimes, and a shared canonical form would make one module's envelope bump
 * silently rewrite the other's bytes. The duplication is 60 lines; the coupling
 * would be seven years long.
 */

/** Bump this — never edit the rules above — when the canonical form changes. */
export const EVAL_ENVELOPE_VERSION = "aoc.evals.node.v1";

/** Bump this when digest construction changes. Stamped into every digest. */
export const EVAL_DIGEST_VERSION = "aoc.evals.digest.v1";

/**
 * Fixed, not a seam. Algorithm agility would mean two runs of the same suite
 * hashing differently depending on configuration. A future algorithm arrives as
 * a new `EVAL_DIGEST_VERSION`, stamped into the digest string, so an old digest
 * stays verifiable rather than being reinterpreted.
 */
export const DIGEST_ALGORITHM = "sha256";

/** ASCII record separator, between hashed parts. */
const SEPARATOR = "";

const canonicalScalar = (value: unknown, path: string): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new UnserialisablePayload(path, `not finite: ${String(value)}`);
      }
      if (!Number.isInteger(value)) {
        throw new UnserialisablePayload(
          path,
          `IEEE-754 fraction: ${String(value)}. Use tenth-cents, micros or basis points.`,
        );
      }
      if (!Number.isSafeInteger(value)) {
        throw new UnserialisablePayload(path, `beyond the safe integer range: ${String(value)}`);
      }
      return String(value === 0 ? 0 : value);
    }
    default:
      throw new UnserialisablePayload(path, `unsupported type ${typeof value}`);
  }
};

/**
 * The canonical form of one flat payload. Throws before any write on a float,
 * a nested object or an array — which is the whole point of running it before
 * the store sees anything.
 */
export const canonicalPayloadForm = (payload: EvalPayload, at = "payload"): string => {
  const keys = Object.keys(payload)
    .filter((k) => payload[k] !== undefined)
    .sort();
  const parts = keys.map((k) => {
    const value: unknown = payload[k];
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
      throw new UnserialisablePayload(`${at}.${k}`, "payloads are flat: use dotted keys");
    }
    return `${JSON.stringify(k)}:${canonicalScalar(value, `${at}.${k}`)}`;
  });
  return `{${parts.join(",")}}`;
};

/**
 * A digest over an ordered list of already-canonical strings. Order is part of
 * the input: two runs that recorded the same nodes in a different order are two
 * different traces and hash differently.
 */
export const digestOf = (parts: readonly string[]): string => {
  const hash = createHash(DIGEST_ALGORITHM);
  hash.update(EVAL_DIGEST_VERSION);
  for (const part of parts) {
    hash.update(SEPARATOR);
    hash.update(part, "utf8");
  }
  return `${EVAL_DIGEST_VERSION}:${DIGEST_ALGORITHM}:${hash.digest("hex")}`;
};

/**
 * Basis points, as an integer. The only division in this module.
 *
 * `Math.round` over integer inputs of this magnitude is exact in IEEE-754 and
 * therefore identical on every host — the float never reaches a payload, which
 * is the property that matters. A denominator of zero yields zero rather than
 * `NaN`: nothing measured is zero of nothing, and `NaN` would fail
 * canonicalisation somewhere far from here.
 */
export const basisPoints = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Math.round((numerator * 10_000) / denominator);
