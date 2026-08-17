import { EVAL_ENVELOPE_VERSION } from "./canonical.js";
import { UnreadableEnvelope } from "./errors.js";
import type { EvalNode, EvalNodeKind, NodeOutcome } from "./types.js";
import { NODE_KINDS, NODE_OUTCOMES } from "./types.js";

/**
 * The **read** half of the seven-year story, which did not previously exist.
 *
 * `index.ts` said "nothing is ever rewritten in place; upcasting happens on
 * read", and there was no upcasting code anywhere in the module. Three versions
 * were stamped onto every node — envelope, payload schema, artefact schema — and
 * read by nothing. The SQL adapter cast its columns straight through
 * (`text(row["outcome"]) as NodeOutcome`), so a value written by a future build,
 * a different application, or a corrupted row became a plausible-looking node
 * rather than a refusal. A stamp with no reader is not a schema-evolution story;
 * it is a comment.
 *
 * So this file is the reader, and it is deliberately small:
 *
 *  1. **A known envelope passes through.** Today there is exactly one.
 *  2. **A known *older* envelope is upcast** by a function registered here, and
 *     the node it produces is stamped with the envelope it *was written under*,
 *     never with today's. Nothing is rewritten in place; the row on disk is
 *     untouched. `UPCASTERS` is empty because there is only one version — the
 *     registry ships empty rather than absent, so the first bump is a function
 *     added here rather than a design decided under pressure.
 *  3. **An unknown envelope is refused**, and so is an unknown `kind` or
 *     `outcome`. Fail-closed: reinterpreting bytes under rules they were not
 *     written under is exactly how a 2033 reader is misled quietly.
 */

/** Every envelope this build can read. Bump by adding, never by replacing. */
export const READABLE_ENVELOPES: readonly string[] = [EVAL_ENVELOPE_VERSION];

type Upcaster = (node: EvalNode) => EvalNode;

/**
 * Keyed by the envelope a node was written under. Empty today, and that is the
 * honest state: one envelope has ever existed. The first change to the
 * canonicalisation rules adds a version to `READABLE_ENVELOPES` and a function
 * here, and old bytes keep meaning what they meant.
 */
const UPCASTERS: Readonly<Record<string, Upcaster>> = {};

const isKind = (value: string): value is EvalNodeKind =>
  (NODE_KINDS as readonly string[]).includes(value);

const isOutcome = (value: string): value is NodeOutcome =>
  (NODE_OUTCOMES as readonly string[]).includes(value);

/**
 * Decode one stored node. Every store adapter runs this on read, so the refusal
 * is a property of the seam rather than of one adapter.
 */
export const readStoredNode = (node: EvalNode): EvalNode => {
  if (!READABLE_ENVELOPES.includes(node.envelope)) {
    throw new UnreadableEnvelope(
      node.id,
      `envelope ${JSON.stringify(node.envelope)} is not one this build reads (${READABLE_ENVELOPES.join(", ")})`,
    );
  }
  if (!isKind(node.kind)) {
    throw new UnreadableEnvelope(node.id, `unknown node kind ${JSON.stringify(node.kind)}`);
  }
  if (!isOutcome(node.outcome)) {
    throw new UnreadableEnvelope(node.id, `unknown outcome ${JSON.stringify(node.outcome)}`);
  }
  if (!Number.isSafeInteger(node.payloadSchemaVersion) || node.payloadSchemaVersion < 1) {
    throw new UnreadableEnvelope(
      node.id,
      `payload schema version ${String(node.payloadSchemaVersion)} is not a positive integer`,
    );
  }
  const upcast = UPCASTERS[node.envelope];
  return upcast === undefined ? node : upcast(node);
};
