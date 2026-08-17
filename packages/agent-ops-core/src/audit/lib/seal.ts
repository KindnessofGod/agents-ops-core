import { traceDigest } from "./canonical.js";
import type {
  NodePayload,
  RecordedNode,
  RedactionId,
  TraceProvenance,
  UnassistedContainment,
} from "./types.js";

/**
 * Sealing: closing a case appends a terminal node carrying the digest of
 * everything recorded before it.
 *
 * This is what makes the trace self-witnessing — provided somebody reads it,
 * which for one release of this module nobody did. `replay` now checks the seal
 * on every read: the digest against the nodes before it, the sealed count
 * against the nodes before it, the scope statement against the case row, and
 * the requirement that the seal is the last node with sequences running
 * 0..n-1. Without those checks the seal was a number written into a row and
 * never looked at, and the two attacks it exists to stop — a removed row and a
 * row inserted after the seal, the second needing only the INSERT grant the
 * writer role legitimately holds — both succeeded silently.
 *
 * It still does not stop an adversary who rewrites every row and recomputes the
 * seal; nothing inside a single store can. It raises the bar from "edit one
 * cell" to "rewrite the case consistently", and it costs one node.
 *
 * Both store adapters build the seal through this function, so in-memory and
 * Postgres produce byte-identical seal nodes for the same trace. A seal
 * assembled twice, differently, would be two guarantees wearing one name.
 */

/**
 * The prefix reserved to this library. A caller writing a node under any kind
 * beginning `case.` is `ReservedNodeKind`, refused by `audit` and again by both
 * adapters. Left unreserved, `case.closed` let an application forge a terminal
 * node — a false `closed`, a forged `unassistedContainment: true` at low tier,
 * and in Postgres a case bricked at its first node with no way back under
 * INSERT-only grants.
 */
export const RESERVED_KIND_PREFIX = "case.";

/** The seal node's kind. Terminal, exactly once per case, reserved to the library. */
export const SEAL_KIND = "case.closed";

/** Is this a kind only the library may write? */
export const isReservedKind = (kind: string): boolean =>
  kind.startsWith(RESERVED_KIND_PREFIX);

/**
 * The seal payload is written by the library, not by an application, and
 * carries no application data — so no caller redactor runs over it. Stamping
 * that fact on the node is more honest than stamping the case's redactor and
 * implying it was applied.
 */
export const SEAL_REDACTION = "aoc.audit.seal.library-authored.v1" as RedactionId;

/**
 * Seal nodes are recorded at high tier. Unassisted containment without a node
 * behind it is an assertion rather than evidence.
 */
export const SEAL_TIER = "high" as const;

/** Replay and both adapters need to spot the terminal node. */
export const isSealNode = (node: Pick<RecordedNode, "payload">): boolean =>
  node.payload.kind === SEAL_KIND;

/**
 * Payload schema version 2. Version 1 carried the outcome, the count and the
 * digest; version 2 adds the four provenance fields, so the case's scope
 * statement sits inside the digest chain instead of beside it. Exported traces
 * are the reason: once a trace leaves Postgres for a folder of files, the
 * UPDATE trigger protects nothing and a rewritten `capturedVia` used to verify
 * perfectly.
 */
export const SEAL_PAYLOAD_VERSION = 2;

export const sealPayload = (
  outcome: UnassistedContainment,
  sealed: readonly RecordedNode[],
  provenance: TraceProvenance,
): NodePayload => ({
  kind: SEAL_KIND,
  v: SEAL_PAYLOAD_VERSION,
  // The full two-word term. Bare `containment` is a lint failure, because the
  // qualifier is what stops it being read as a quality score.
  unassistedContainment: outcome.unassistedContainment,
  nodesSealed: sealed.length,
  sealDigest: traceDigest(sealed),
  provenanceCapturedVia: provenance.capturedVia,
  provenanceCanonicalForm: provenance.canonicalForm,
  provenanceRedaction: provenance.redaction,
  provenanceOpenedAt: provenance.openedAt,
});
