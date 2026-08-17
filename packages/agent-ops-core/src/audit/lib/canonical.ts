import { createHash } from "node:crypto";
import { TraceCorrupt, UnknownEnvelope, UnserialisablePayload } from "./errors.js";
import type {
  CorrelationId,
  NodeId,
  NodePayload,
  NodeTelemetry,
  RecordedNode,
  RedactionId,
  RiskTier,
  TraceDigest,
} from "./types.js";

/**
 * Byte-stable serialisation.
 *
 * The same logical node produces identical bytes on every host, every Node
 * version and every release of this library that declares the same envelope
 * version. This is the least visible thing in the module and the thing replay,
 * the digest and any future cross-language reader all stand on.
 *
 * The rules, in full, so they can be reimplemented from this comment alone:
 *
 *   1. **Envelope version.** Every canonical form is produced under a named
 *      envelope, and the name is written *inside the bytes*. Changing any rule
 *      below means a new envelope version, never a silent change to one already
 *      issued. Old nodes keep their old bytes forever.
 *   2. **Objects** render as `{"k":v,...}` with keys sorted ascending by UTF-16
 *      code unit — ECMA-262 relational comparison on strings, which is fully
 *      specified and therefore reproducible outside JavaScript.
 *   3. **Keys whose value is `undefined` are dropped** before sorting, so an
 *      absent key and an explicitly-undefined key are the same bytes. `null` is
 *      preserved and is distinct from absent.
 *   4. **Numbers** must be safe integers. A float, a NaN, an Infinity or an
 *      integer beyond 2^53-1 throws `UnserialisablePayload` before any write.
 *      `-0` normalises to `0`. Integers render via `String`, which is exact.
 *   5. **Strings** render via `JSON.stringify`, whose escaping is specified by
 *      ECMA-262 `QuoteJSONString` including well-formed lone-surrogate escapes.
 *   6. **Arrays and nested objects are rejected inside a payload.** Payloads are
 *      flat. Only the node envelope nests, and only one level, into `payload`
 *      and `telemetry`.
 *   7. **No whitespace anywhere.**
 *
 * Rule 4 is the one graft 6 of `FINDINGS.md` insists on: integers only, cost in
 * tenth-cents, latency in micros, scores in basis points. Floats are how
 * byte-stability dies quietly.
 *
 * ## How a version bump actually works, rather than how it was described
 *
 * A canonicaliser is registered **per envelope version** and old ones are kept.
 * `canonicalNodeForm(node, envelope)` dispatches on the version it is given;
 * replay reads the version out of each node's own stored bytes and recomputes
 * under *that* one. Bumping `ENVELOPE_VERSION` therefore changes what new nodes
 * look like and changes nothing about nodes already written.
 *
 * The same holds for the digest: `traceDigest(nodes, version)` dispatches, and
 * `verify` reads the version out of the digest it is handed. An externally
 * witnessed digest stays reproducible after a bump instead of becoming
 * unverifiable — which is what "an old digest stays checkable" has to mean if
 * it is to mean anything.
 *
 * A version this release does not implement raises `UnknownEnvelope`, which is
 * deliberately **not** `TraceTampered`: "I no longer ship that canonicaliser"
 * and "somebody edited this row" are different sentences to say to an auditor.
 */

/**
 * The envelope new nodes are written under. Never edit the rules of a version
 * already issued — add a version, register it below, and keep the old one.
 */
export const ENVELOPE_VERSION = "aoc.audit.node.v2";

/** The digest construction new digests are written under. Same discipline. */
export const TRACE_DIGEST_VERSION = "aoc.audit.trace.v1";

/**
 * Fixed, not a seam. Algorithm agility here would mean two traces of the same
 * case hashing differently depending on configuration, and C5 is explicit: one
 * adapter is a hypothetical seam. A future algorithm arrives as a new
 * `TRACE_DIGEST_VERSION` registered alongside this one, so an old digest stays
 * verifiable rather than being reinterpreted.
 */
export const DIGEST_ALGORITHM = "sha256";

/** Separates the running hash from the node bytes. ASCII record separator. */
const SEPARATOR = Buffer.from([0x1e]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
        throw new UnserialisablePayload(
          path,
          `beyond the safe integer range: ${String(value)}`,
        );
      }
      // `value === 0` is true for -0, so this normalises the negative zero that
      // would otherwise round-trip as "0" in some encoders and "-0" in others.
      return String(value === 0 ? 0 : value);
    }
    default:
      throw new UnserialisablePayload(path, `unsupported type ${typeof value}`);
  }
};

const canonicalValue = (value: unknown, path: string, depth: number): string => {
  if (Array.isArray(value)) {
    throw new UnserialisablePayload(
      path,
      "arrays are not canonicalisable here; flatten with dotted keys",
    );
  }
  if (isPlainObject(value)) {
    if (depth === 0) {
      throw new UnserialisablePayload(
        path,
        "payloads are flat; flatten with dotted keys",
      );
    }
    return canonicalObject(value, path, depth - 1);
  }
  return canonicalScalar(value, path);
};

const canonicalObject = (
  object: Record<string, unknown>,
  path: string,
  depth: number,
): string => {
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort();
  const parts = keys.map(
    (key) =>
      `${JSON.stringify(key)}:${canonicalValue(object[key], `${path}.${key}`, depth)}`,
  );
  return `{${parts.join(",")}}`;
};

/**
 * Canonical bytes for a payload alone. Exported so a caller can prove a payload
 * is writable — and prove two payloads are the same — without a store.
 */
export const canonicalPayloadForm = (payload: NodePayload): string =>
  canonicalObject(payload as unknown as Record<string, unknown>, "payload", 0);

/**
 * Rejects a payload that cannot be written byte-stably. Called in `audit`
 * **before** the store is touched, so an unserialisable payload never becomes a
 * half-written node.
 */
export const assertCanonicalisable = (payload: NodePayload): void => {
  canonicalPayloadForm(payload);
};

/** Everything a canonicaliser needs. The bytes are the output, not an input. */
export type NodeForCanonical = Omit<RecordedNode, "canonical">;

const telemetryForm = (
  telemetry: NodeTelemetry | undefined,
): Record<string, unknown> | null =>
  telemetry === undefined
    ? null
    : {
        costTenthCents: telemetry.costTenthCents,
        latencyMicros: telemetry.latencyMicros,
        priceTableVersion: telemetry.priceTableVersion,
        tokensIn: telemetry.tokensIn,
        tokensOut: telemetry.tokensOut,
      };

/**
 * `aoc.audit.node.v1` — the original envelope. Kept, not deleted, because nodes
 * written under it keep their bytes forever and this is the code that reads
 * them. It has no representation for telemetry, so a node carrying telemetry
 * cannot be expressed under it and says so rather than silently dropping it.
 */
const nodeFormV1 = (node: NodeForCanonical): string => {
  if (node.telemetry !== undefined) {
    throw new UnserialisablePayload(
      "node.telemetry",
      "envelope aoc.audit.node.v1 has no representation for telemetry",
    );
  }
  return canonicalObject(
    {
      at: node.at,
      correlationId: node.correlationId,
      envelope: "aoc.audit.node.v1",
      id: node.id,
      parent: node.parent ?? null,
      payload: node.payload as unknown as Record<string, unknown>,
      payloadSchemaVersion: node.payloadSchemaVersion,
      redaction: node.redaction,
      sequence: node.sequence,
      tier: node.tier,
    },
    "node",
    1,
  );
};

/**
 * `aoc.audit.node.v2` — adds `telemetry`, which `BRIEF.md` C2 requires per node
 * and which v1 recorded nowhere. `null` when the node measured nothing, so
 * "not measured" and "measured as zero" are different bytes.
 */
const nodeFormV2 = (node: NodeForCanonical): string =>
  canonicalObject(
    {
      at: node.at,
      correlationId: node.correlationId,
      envelope: "aoc.audit.node.v2",
      id: node.id,
      parent: node.parent ?? null,
      payload: node.payload as unknown as Record<string, unknown>,
      payloadSchemaVersion: node.payloadSchemaVersion,
      redaction: node.redaction,
      sequence: node.sequence,
      telemetry: telemetryForm(node.telemetry),
      tier: node.tier,
    },
    "node",
    1,
  );

/** Every envelope this release can produce and read. Add, never replace. */
const ENVELOPES: Readonly<Record<string, (node: NodeForCanonical) => string>> = {
  "aoc.audit.node.v1": nodeFormV1,
  "aoc.audit.node.v2": nodeFormV2,
};

/** The envelope versions this release implements, oldest first. */
export const KNOWN_ENVELOPES: readonly string[] = Object.keys(ENVELOPES).sort();

/**
 * Canonical bytes for a whole node, under a named envelope. The sequence is in
 * here, which is why the store computes this and not the caller: the bytes are
 * not knowable until the store has assigned the order.
 */
export const canonicalNodeForm = (
  node: NodeForCanonical,
  envelope: string = ENVELOPE_VERSION,
): string => {
  const form = ENVELOPES[envelope];
  if (form === undefined) {
    throw new UnknownEnvelope(envelope, String(node.correlationId));
  }
  return form(node);
};

/** The envelope named inside a node's own bytes, or undefined if unreadable. */
export const envelopeOf = (canonical: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const envelope = parsed["envelope"];
  return typeof envelope === "string" ? envelope : undefined;
};

/**
 * Canonical bytes for a node under **its own** envelope.
 *
 * The current envelope is tried first, so the overwhelmingly common case costs
 * one canonicalisation and no parse. Only when that disagrees does this read
 * the version out of the stored bytes — which is exactly the situation a
 * version bump creates, and exactly the situation the old code turned into
 * `TraceTampered` across the whole estate.
 */
export const canonicalNodeFormOf = (node: RecordedNode): string => {
  const current = canonicalNodeForm(node, ENVELOPE_VERSION);
  if (current === node.canonical) return current;

  const envelope = envelopeOf(node.canonical);
  // Unreadable bytes are not a version problem. Hand back the current form so
  // the caller's comparison fails and reports tampering, which is what
  // unreadable stored bytes are.
  if (envelope === undefined || envelope === ENVELOPE_VERSION) return current;
  return canonicalNodeForm(node, envelope);
};

// ---------------------------------------------------------------------------
// Decoding: the bytes are the record, the columns are the index
// ---------------------------------------------------------------------------

const field = (
  object: Record<string, unknown>,
  key: string,
  correlationId: CorrelationId,
): unknown => {
  const value = object[key];
  if (value === undefined) {
    throw new TraceCorrupt(correlationId, `canonical bytes have no ${key}`);
  }
  return value;
};

const decodedString = (
  object: Record<string, unknown>,
  key: string,
  correlationId: CorrelationId,
): string => {
  const value = field(object, key, correlationId);
  if (typeof value !== "string") {
    throw new TraceCorrupt(correlationId, `canonical ${key} is not text`);
  }
  return value;
};

const decodedInteger = (
  object: Record<string, unknown>,
  key: string,
  correlationId: CorrelationId,
): number => {
  const value = field(object, key, correlationId);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TraceCorrupt(correlationId, `canonical ${key} is not a safe integer`);
  }
  return value;
};

const decodedTelemetry = (
  raw: unknown,
  correlationId: CorrelationId,
): NodeTelemetry | undefined => {
  if (raw === null || raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new TraceCorrupt(correlationId, "canonical telemetry is not an object");
  }
  return {
    costTenthCents: decodedInteger(raw, "costTenthCents", correlationId),
    latencyMicros: decodedInteger(raw, "latencyMicros", correlationId),
    priceTableVersion: decodedString(raw, "priceTableVersion", correlationId),
    tokensIn: decodedInteger(raw, "tokensIn", correlationId),
    tokensOut: decodedInteger(raw, "tokensOut", correlationId),
  };
};

/**
 * Rebuild a node from its own canonical bytes.
 *
 * `index.ts` claims a reader in 2033 needs three things and all three are in the
 * row: the envelope version, the payload version and the bytes. This is the
 * function that makes that true rather than aspirational — the Postgres adapter
 * reconstructs every node from `node_canonical` and then proves the indexed
 * columns agree with it, instead of reconstructing from columns and hoping the
 * bytes still match. It is also what lets a new envelope field reach a reader
 * without a migration for every field.
 *
 * The rebuilt node is re-canonicalised and compared with the input, so bytes
 * that are not the exact canonical form of what they decode to are refused.
 */
export const decodeNode = (
  canonical: string,
  correlationId: CorrelationId,
): RecordedNode => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    throw new TraceCorrupt(correlationId, "canonical bytes are not parseable");
  }
  if (!isPlainObject(parsed)) {
    throw new TraceCorrupt(correlationId, "canonical bytes are not an object");
  }

  const envelope = decodedString(parsed, "envelope", correlationId);
  if (ENVELOPES[envelope] === undefined) {
    throw new UnknownEnvelope(envelope, correlationId);
  }

  const payload = field(parsed, "payload", correlationId);
  if (!isPlainObject(payload)) {
    throw new TraceCorrupt(correlationId, "canonical payload is not an object");
  }
  const parent = parsed["parent"];
  if (parent !== null && typeof parent !== "string") {
    throw new TraceCorrupt(correlationId, "canonical parent is neither null nor text");
  }
  const tier = decodedString(parsed, "tier", correlationId);
  if (tier !== "low" && tier !== "medium" && tier !== "high") {
    throw new TraceCorrupt(correlationId, `canonical tier ${tier} is not a risk tier`);
  }

  const skeleton: NodeForCanonical = {
    id: decodedString(parsed, "id", correlationId) as NodeId,
    correlationId: decodedString(parsed, "correlationId", correlationId) as CorrelationId,
    sequence: decodedInteger(parsed, "sequence", correlationId),
    at: decodedInteger(parsed, "at", correlationId),
    tier: tier as RiskTier,
    ...(parent === null ? {} : { parent: parent as NodeId }),
    payloadSchemaVersion: decodedInteger(parsed, "payloadSchemaVersion", correlationId),
    redaction: decodedString(parsed, "redaction", correlationId) as RedactionId,
    payload: payload as unknown as NodePayload,
    ...(() => {
      const telemetry = decodedTelemetry(parsed["telemetry"], correlationId);
      return telemetry === undefined ? {} : { telemetry };
    })(),
  };

  if (canonicalNodeForm(skeleton, envelope) !== canonical) {
    throw new TraceCorrupt(
      correlationId,
      `bytes at sequence ${skeleton.sequence} are not the canonical form of what they decode to`,
    );
  }

  return { ...skeleton, canonical };
};

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

const hash = (chunks: readonly (Buffer | string)[]): Buffer => {
  const digest = createHash(DIGEST_ALGORITHM);
  for (const chunk of chunks) {
    digest.update(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return digest.digest();
};

/**
 * A digest construction, expressed as a **fold** rather than as a function over
 * a whole array.
 *
 * That is not a stylistic choice. Splitting the construction into a genesis
 * value and a single step is what makes three things possible at once, all with
 * byte-identical results:
 *
 *   - `traceDigest(nodes)` — the whole-case digest, unchanged.
 *   - `walk` — a 100,000-node case digested incrementally, holding one page of
 *     nodes rather than the case (see `lib/stream.ts`).
 *   - `extendDigest` — the digest of a sealed case computed from the seal alone,
 *     because the seal already carries the digest of everything before it. That
 *     is what lets `close` publish a whole-case digest to a witness without
 *     reading back the case it has just written.
 *
 * A construction that could only be evaluated over a materialised array would
 * force the third to re-read the case under the close lock, which is the cost
 * the streaming work exists to remove.
 */
interface DigestConstruction {
  /** The digest of zero nodes. "No nodes" is a verifiable claim, not a gap. */
  genesis(): Buffer;
  /** One link of the chain. */
  step(running: Buffer, node: RecordedNode): Buffer;
}

/**
 * `aoc.audit.trace.v1` — a hash chain in store-assigned sequence order, seeded
 * with the version string, each node separated by an ASCII record separator.
 */
const traceDigestV1: DigestConstruction = {
  genesis: () => hash(["aoc.audit.trace.v1"]),
  step: (running, node) => hash([running, SEPARATOR, canonicalNodeFormOf(node)]),
};

const DIGESTS: Readonly<Record<string, DigestConstruction>> = {
  "aoc.audit.trace.v1": traceDigestV1,
};

/** The digest constructions this release implements. */
export const KNOWN_DIGEST_VERSIONS: readonly string[] = Object.keys(DIGESTS).sort();

/** `version:algorithm:hex`. The version is inside the string, always. */
const renderDigest = (version: string, running: Buffer): TraceDigest =>
  `${version}:${DIGEST_ALGORITHM}:${running.toString("hex")}` as TraceDigest;

const constructionOf = (version: string, context: string): DigestConstruction => {
  const construction = DIGESTS[version];
  if (construction === undefined) throw new UnknownEnvelope(version, context);
  return construction;
};

/**
 * Content digest over a trace, so tampering is detectable.
 *
 * A hash chain in **store-assigned sequence order**, which is what makes it
 * stable under concurrency: two writers racing decide who gets sequence 4 and
 * who gets 5, but once the store has decided, every reader on every host
 * computes the same digest from the same rows.
 *
 * The bytes hashed are recomputed from each node's own fields under each node's
 * own envelope, never taken from a stored `canonical` column. A tamperer who
 * edits a payload and leaves the stored bytes alone changes the digest; one who
 * edits both is caught by `TraceTampered` on read instead.
 *
 * An empty trace has a digest — the genesis value — rather than an empty
 * string, so "no nodes" is a verifiable claim rather than a missing one.
 */
export const traceDigest = (
  nodes: readonly NodeForDigest[],
  version: string = TRACE_DIGEST_VERSION,
): TraceDigest => {
  const construction = constructionOf(
    version,
    String(nodes[0]?.correlationId ?? "(empty)"),
  );
  const ordered = [...nodes].sort((a, b) => a.sequence - b.sequence);
  let running = construction.genesis();
  for (const node of ordered) running = construction.step(running, node);
  return renderDigest(version, running);
};

/**
 * `traceDigest` accepts any node-shaped value the canonicaliser can read. It is
 * spelled out rather than left as `RecordedNode` so that a caller holding a
 * decoded node — one rebuilt from bytes by an independent auditor, say — can
 * recompute without first satisfying an interface it has no reason to know.
 */
export type NodeForDigest = RecordedNode;

/** The digest of a case with no nodes yet, under a named construction. */
export const digestGenesis = (
  version: string = TRACE_DIGEST_VERSION,
): TraceDigest => renderDigest(version, constructionOf(version, "(empty)").genesis());

/**
 * Extend a digest by one node, producing the digest of the same nodes plus that
 * one. `extendDigest(traceDigest(ns), n)` is `traceDigest([...ns, n])`, byte for
 * byte, provided `n` sorts last — which for a seal it always does.
 *
 * The version is read out of the digest handed in, never assumed, so a chain
 * begun under an older construction is continued under that same construction
 * rather than silently switched to whatever this release currently writes.
 */
export const extendDigest = (
  digest: TraceDigest,
  node: RecordedNode,
): TraceDigest => {
  const parts = String(digest).split(":");
  const [version, algorithm, hex] = parts;
  const context = String(node.correlationId);
  if (parts.length !== 3 || version === undefined || hex === undefined) {
    throw new UnknownEnvelope(String(digest).slice(0, 32), context);
  }
  const construction = constructionOf(version, context);
  if (algorithm !== DIGEST_ALGORITHM) {
    throw new UnknownEnvelope(`${version}:${String(algorithm)}`, context);
  }
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new UnknownEnvelope(version, context);
  }
  return renderDigest(version, construction.step(Buffer.from(hex, "hex"), node));
};

/** The construction named inside a digest string, if this release knows it. */
export const digestVersionOf = (digest: string): string | undefined => {
  const version = digest.slice(0, digest.indexOf(":"));
  return DIGESTS[version] === undefined ? undefined : version;
};
