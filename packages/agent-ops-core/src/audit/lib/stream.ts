import { canonicalNodeFormOf, digestGenesis, digestVersionOf, extendDigest } from "./canonical.js";
import {
  NoSuchCase,
  StoreContractViolated,
  TraceIncoherent,
  TraceTampered,
  TraceUnavailable,
  UnknownEnvelope,
} from "./errors.js";
import { SEAL_KIND, isSealNode } from "./seal.js";
import type {
  CorrelationId,
  RecordedNode,
  TraceDigest,
  TraceProvenance,
  TraceStore,
  TraceVerdict,
  WalkLimits,
} from "./types.js";

/**
 * Reading a case without holding it, and holding one integrity check rather
 * than two.
 *
 * ## Why this file exists
 *
 * `replay` loads the whole case. For the overwhelming majority of cases — tens
 * of nodes — that is the right answer and it stays the default. It is the wrong
 * answer at the ceiling: `maxNodesPerCase` is 100,000, and an operator walking
 * such a case, or a retention sweep verifying one before it is archived, should
 * not have to fit it in memory to do so.
 *
 * ## Why the checks live here and not in `audit.ts`
 *
 * Because there are now two read paths, and this module's own history says what
 * happens when two paths claim the same invariants: "a parent from another case
 * orphaned here and bricked there. Same call, two different disasters, is worse
 * than either." A whole-case replay that checked the seal and a streaming walk
 * that forgot to would be the same defect wearing a new shape — and it would be
 * the streaming path, used by the retention procedure, that skipped the check.
 *
 * So every integrity check is expressed **once**, incrementally, in
 * `traceVerifier` below, and both read paths drive it. `replay` feeds it a
 * materialised array; `walk` feeds it a page at a time. Neither can hold a
 * different opinion about what a valid trace is, because neither has an opinion
 * of its own.
 *
 * Everything the checks need turns out to be foldable:
 *
 *   - sequences run 0..n-1 — compare against a running count;
 *   - no row edited in place — recanonicalise each node as it passes;
 *   - the seal is last — remember having seen it, and refuse what follows;
 *   - the seal's digest is the digest of what precedes it — the digest is a
 *     hash chain, so snapshot it at the seal (see `extendDigest`);
 *   - the seal's count matches — the running count;
 *   - the scope statement matches what the seal witnessed — one comparison at
 *     the end.
 *
 * The one check that is *not* foldable is the sort: a streaming reader cannot
 * reorder what it has already yielded. That is why ordering is an obligation on
 * the store (`TraceStore` invariant 7) and is checked per page rather than
 * repaired.
 */

const sealField = (
  correlationId: CorrelationId,
  seal: RecordedNode,
  field: string,
): string | number | boolean => {
  const value = seal.payload[field];
  if (value === undefined || value === null) {
    throw new TraceIncoherent(
      correlationId,
      "seal-malformed",
      `seal payload has no ${field}`,
    );
  }
  return value;
};

/**
 * The single incremental integrity check, driven by both read paths.
 *
 * Stateful on purpose: it is a fold, and a fold over 100,000 nodes that
 * allocated per node would defeat the point of streaming. It holds four
 * numbers, two digests and one node — the seal — and nothing that grows with
 * the case.
 */
export interface TraceVerifier {
  /** Feed the next node in store-assigned order. Throws on the first defect. */
  accept(node: RecordedNode): void;
  /** No more nodes. Checks everything that can only be known at the end. */
  finish(): TraceVerdict;
}

export const traceVerifier = (
  correlationId: CorrelationId,
  provenance: TraceProvenance,
): TraceVerifier => {
  let count = 0;
  let previousSequence: number | undefined;
  let digest = digestGenesis();
  let digestBeforeSeal: TraceDigest | undefined;
  let seal: RecordedNode | undefined;

  return {
    accept(node) {
      // A node after the terminal seal. This is the attack that needs only the
      // INSERT grant the writer role legitimately holds, so it is the realistic
      // one and it is checked before anything else about the node.
      if (seal !== undefined) {
        throw new TraceIncoherent(
          correlationId,
          isSealNode(node) ? "duplicate-seal" : "node-after-seal",
          isSealNode(node)
            ? `a second node carries the terminal kind ${SEAL_KIND}`
            : "a node sits after the terminal seal",
        );
      }

      if (node.sequence !== count) {
        if (previousSequence === node.sequence) {
          throw new TraceIncoherent(
            correlationId,
            "duplicate-sequence",
            `two nodes claim sequence ${node.sequence}`,
          );
        }
        throw new TraceIncoherent(
          correlationId,
          "sequence-gap",
          `expected sequence ${count}, found ${node.sequence}`,
        );
      }

      // Tamper detection. A row whose stored bytes disagree with the bytes its
      // own fields produce has been edited in place. Each node is
      // canonicalised under *its own* envelope, so a node written before a
      // version bump verifies rather than being reported as tampered.
      if (canonicalNodeFormOf(node) !== node.canonical) {
        throw new TraceTampered(correlationId, node.sequence);
      }

      if (isSealNode(node)) {
        digestBeforeSeal = digest;
        seal = node;
      }
      digest = extendDigest(digest, node);
      previousSequence = node.sequence;
      count += 1;
    },

    finish() {
      if (seal !== undefined) {
        const sealed = count - 1;
        const nodesSealed = sealField(correlationId, seal, "nodesSealed");
        if (nodesSealed !== sealed) {
          throw new TraceIncoherent(
            correlationId,
            "seal-count-mismatch",
            `the seal counted ${String(nodesSealed)} nodes; ${sealed} precede it`,
          );
        }

        const recorded = String(sealField(correlationId, seal, "sealDigest"));
        if (digestVersionOf(recorded) === undefined) {
          throw new UnknownEnvelope(
            recorded.slice(0, Math.max(recorded.indexOf(":"), 0)),
            correlationId,
          );
        }
        if (String(digestBeforeSeal) !== recorded) {
          throw new TraceIncoherent(
            correlationId,
            "seal-digest-mismatch",
            "the seal's digest is not the digest of the nodes before it",
          );
        }

        // Seal payload version 1 predates provenance being witnessed. Reading
        // it as if it had those fields would report every old seal as broken,
        // which is the same mistake this module made with the envelope version.
        if (seal.payloadSchemaVersion >= 2) {
          const witnessed: Record<string, string | number | boolean> = {
            provenanceCapturedVia: provenance.capturedVia,
            provenanceCanonicalForm: provenance.canonicalForm,
            provenanceRedaction: String(provenance.redaction),
            provenanceOpenedAt: provenance.openedAt,
          };
          for (const [field, expected] of Object.entries(witnessed)) {
            if (sealField(correlationId, seal, field) !== expected) {
              throw new TraceIncoherent(
                correlationId,
                "provenance-mismatch",
                `the case's ${field} is not the one the seal witnessed`,
              );
            }
          }
        }
      }

      return {
        correlationId,
        provenance,
        nodes: count,
        closed: seal !== undefined,
        closedAt: seal?.at,
        digest,
      };
    },
  };
};

// ---------------------------------------------------------------------------
// The streaming read
// ---------------------------------------------------------------------------

const DEFAULT_WALK_LIMITS: WalkLimits = {
  pageSize: 1_000,
  maxNodes: 1_000_000,
};

const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 10_000;

const clampPageSize = (requested: number): number => {
  if (!Number.isSafeInteger(requested)) return DEFAULT_WALK_LIMITS.pageSize;
  return Math.min(Math.max(requested, MIN_PAGE_SIZE), MAX_PAGE_SIZE);
};

const sameProvenance = (a: TraceProvenance, b: TraceProvenance): boolean =>
  a.capturedVia === b.capturedVia &&
  a.canonicalForm === b.canonicalForm &&
  String(a.redaction) === String(b.redaction) &&
  a.openedAt === b.openedAt;

/**
 * Walk a case a page at a time, yielding nodes in store-assigned order and
 * returning the verdict once the walk completes.
 *
 * **The return value is only produced by a walk that runs to the end**, and that
 * asymmetry is deliberate rather than an artefact of generators. A partial walk
 * cannot verify a seal it has not reached, so a caller who breaks out early gets
 * the nodes they read and no verdict at all — rather than a verdict that quietly
 * means "nothing was wrong with the part I looked at".
 *
 * Memory is one page of nodes plus the verifier's fixed state, whatever the size
 * of the case. Round trips are `ceil(n / pageSize) + 1`.
 */
export async function* walkCase(
  store: TraceStore,
  correlationId: CorrelationId,
  limits: Partial<WalkLimits> = {},
): AsyncGenerator<RecordedNode, TraceVerdict, undefined> {
  const merged = { ...DEFAULT_WALK_LIMITS, ...limits };
  const pageSize = clampPageSize(merged.pageSize);
  const maxNodes = Math.max(merged.maxNodes, 1);

  const wrong = (detail: string): never => {
    throw new StoreContractViolated(correlationId, detail);
  };

  let afterSequence: number | undefined;
  let provenance: TraceProvenance | undefined;
  let verifier: TraceVerifier | undefined;
  let walked = 0;

  for (;;) {
    const page = await store.readPage({ correlationId, afterSequence, limit: pageSize });
    if (page === undefined) {
      // Fail-closed on the first page: an absent case throws rather than
      // yielding nothing, because "we have no record" must never be able to
      // masquerade as "nothing happened". Later pages cannot report a case as
      // absent at all — an INSERT-only store does not stop holding one halfway
      // through a walk — so that is a contract violation instead.
      if (verifier === undefined) throw new NoSuchCase(correlationId);
      return wrong("stopped answering for a case it was already answering for");
    }

    if (provenance === undefined) {
      provenance = page.provenance;
      verifier = traceVerifier(correlationId, provenance);
    } else if (!sameProvenance(provenance, page.provenance)) {
      wrong("changed the case's scope statement between two pages of one walk");
    }

    if (page.nodes.length > pageSize) {
      wrong(`returned ${page.nodes.length} nodes for a page limited to ${pageSize}`);
    }
    if (page.more && page.nodes.length === 0) {
      // A store that says "more" and hands back nothing would spin this loop
      // forever. Refuse rather than hang: an operator command that never
      // returns is the silent-failure quadrant with a progress bar on it.
      wrong("claimed more nodes follow but returned an empty page");
    }

    for (const node of page.nodes) {
      if (afterSequence !== undefined && node.sequence <= afterSequence) {
        wrong(
          `returned sequence ${node.sequence} for a page after ${afterSequence}`,
        );
      }
      walked += 1;
      if (walked > maxNodes) {
        throw new TraceUnavailable("capacity", correlationId);
      }
      (verifier as TraceVerifier).accept(node);
      afterSequence = node.sequence;
      yield node;
    }

    if (!page.more) break;
  }

  return (verifier as TraceVerifier).finish();
}
