import {
  ENVELOPE_VERSION,
  assertCanonicalisable,
  canonicalNodeFormOf,
  canonicalPayloadForm,
  digestVersionOf,
  traceDigest,
} from "./canonical.js";
import {
  AuditError,
  NoSuchCase,
  ParentNotOfThisCase,
  PayloadTooLarge,
  RedactionUnsound,
  ReservedNodeKind,
  StoreContractViolated,
  TraceIncoherent,
  TraceTampered,
  TraceUnavailable,
  UnknownEnvelope,
} from "./errors.js";
import { SEAL_KIND, isReservedKind, isSealNode } from "./seal.js";
import type {
  Audit,
  AuditDeps,
  AuditLimits,
  CaseTrace,
  CorrelationId,
  Degraded,
  NodeId,
  NodePayload,
  NodeTelemetry,
  Recorded,
  RecordedNode,
  Redactor,
  ReplayedCase,
  RiskTier,
  StoredCase,
  TraceProvenance,
  UnassistedContainment,
} from "./types.js";

const DEFAULT_LIMITS: AuditLimits = {
  // 64 KiB of canonical bytes. A trace records what happened, not the documents
  // it happened to: a node needs an identifier, a verdict and a few integers,
  // and anything approaching this ceiling is a payload carrying a document.
  maxPayloadBytes: 64 * 1024,
};

// ---------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------

/**
 * Sequences must run 0..n-1 with no duplicate and no hole.
 *
 * The primary key makes a duplicate unreachable through the shipped Postgres
 * adapter, but `TraceStore` is a public seam and a sort by sequence over two
 * equal sequences has an implementation-defined order — and therefore a
 * non-deterministic digest for the same bytes. A hole is what a removed row
 * looks like.
 */
const checkOrder = (
  correlationId: CorrelationId,
  nodes: readonly RecordedNode[],
): void => {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    if (node.sequence === i) continue;
    const previous = nodes[i - 1];
    if (previous !== undefined && previous.sequence === node.sequence) {
      throw new TraceIncoherent(
        correlationId,
        "duplicate-sequence",
        `two nodes claim sequence ${node.sequence}`,
      );
    }
    throw new TraceIncoherent(
      correlationId,
      "sequence-gap",
      `expected sequence ${i}, found ${node.sequence}`,
    );
  }
};

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
 * Read the seal, rather than merely having written one.
 *
 * The seal node has always carried the digest of everything before it and the
 * count of what it sealed. For one release nothing compared either, so a
 * removed row replayed cleanly and a row forged after the seal — which needs
 * only the INSERT grant the writer role legitimately holds — replayed cleanly
 * too. Both are caught here.
 */
const checkSeal = (
  correlationId: CorrelationId,
  nodes: readonly RecordedNode[],
  provenance: TraceProvenance,
): boolean => {
  const sealIndexes = nodes.flatMap((node, index) => (isSealNode(node) ? [index] : []));
  if (sealIndexes.length === 0) return false;
  if (sealIndexes.length > 1) {
    throw new TraceIncoherent(
      correlationId,
      "duplicate-seal",
      `${sealIndexes.length} nodes carry the terminal kind ${SEAL_KIND}`,
    );
  }

  const index = sealIndexes[0] as number;
  const seal = nodes[index] as RecordedNode;
  if (index !== nodes.length - 1) {
    throw new TraceIncoherent(
      correlationId,
      "node-after-seal",
      `${nodes.length - 1 - index} node(s) sit after the terminal seal`,
    );
  }

  const sealed = nodes.slice(0, index);
  const nodesSealed = sealField(correlationId, seal, "nodesSealed");
  if (nodesSealed !== sealed.length) {
    throw new TraceIncoherent(
      correlationId,
      "seal-count-mismatch",
      `the seal counted ${String(nodesSealed)} nodes; ${sealed.length} precede it`,
    );
  }

  const recorded = String(sealField(correlationId, seal, "sealDigest"));
  const version = digestVersionOf(recorded);
  if (version === undefined) {
    throw new UnknownEnvelope(recorded.slice(0, recorded.indexOf(":")), correlationId);
  }
  if (String(traceDigest(sealed, version)) !== recorded) {
    throw new TraceIncoherent(
      correlationId,
      "seal-digest-mismatch",
      "the seal's digest is not the digest of the nodes before it",
    );
  }

  // Seal payload version 1 predates provenance being witnessed. Reading it as
  // if it had those fields would report every old seal as broken, which is the
  // same mistake this module made with the envelope version.
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

  return true;
};

/**
 * Build the replayed graph.
 *
 * Every check that matters happens here, on the read path, because that is
 * where an auditor stands. `roots` and `childrenOf` are answered from an index
 * built once — they used to be linear filters per call, so walking a graph of n
 * nodes cost n² — and the digest is computed at most once however often it is
 * asked for.
 */
const replayedCase = (
  correlationId: CorrelationId,
  stored: StoredCase,
): ReplayedCase => {
  const nodes = [...stored.nodes].sort((a, b) => a.sequence - b.sequence);

  checkOrder(correlationId, nodes);

  // Tamper detection on the read path. A row whose stored bytes disagree with
  // the bytes its own columns produce has been edited in place, which is the
  // one thing the append-only grants exist to prevent. Handing the trace back
  // anyway would launder tampering into evidence. Each node is canonicalised
  // under *its own* envelope, so a node written before a version bump verifies
  // rather than being reported as tampered.
  for (const node of nodes) {
    if (canonicalNodeFormOf(node) !== node.canonical) {
      throw new TraceTampered(correlationId, node.sequence);
    }
  }

  const closed = checkSeal(correlationId, nodes, stored.provenance);

  const roots: RecordedNode[] = [];
  const children = new Map<string, RecordedNode[]>();
  for (const node of nodes) {
    if (node.parent === undefined) {
      roots.push(node);
      continue;
    }
    const bucket = children.get(node.parent);
    if (bucket === undefined) children.set(node.parent, [node]);
    else bucket.push(node);
  }

  let digest: string | undefined;
  const computed = (): string => (digest ??= String(traceDigest(nodes)));

  return {
    correlationId,
    provenance: stored.provenance,
    nodes,
    closed,
    roots: () => roots,
    childrenOf: (id: NodeId) => children.get(id) ?? [],
    digest: () => computed() as ReturnType<ReplayedCase["digest"]>,
    verify: (expected) => {
      const version = digestVersionOf(String(expected));
      // A digest whose construction this release does not implement is not a
      // match and is not an exception either: `verify` answers a yes/no
      // question about a string somebody else is holding.
      if (version === undefined) return false;
      return String(traceDigest(nodes, version)) === String(expected);
    },
  };
};

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

/** Redaction runs before write, and an unsound redactor stops the write. */
const redactOrThrow = (redact: Redactor, payload: NodePayload): NodePayload => {
  const redacted = redact.apply(payload);
  if (redacted.kind !== payload.kind) {
    throw new RedactionUnsound(redact.id, "changed or dropped `kind`");
  }
  if (redacted.v !== payload.v) {
    throw new RedactionUnsound(redact.id, "changed or dropped `v`");
  }
  return redacted;
};

const telemetryAgrees = (
  a: NodeTelemetry | undefined,
  b: NodeTelemetry | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.costTenthCents === b.costTenthCents &&
    a.tokensIn === b.tokensIn &&
    a.tokensOut === b.tokensOut &&
    a.latencyMicros === b.latencyMicros &&
    a.priceTableVersion === b.priceTableVersion
  );
};

interface Asked {
  readonly correlationId: CorrelationId;
  readonly at: number;
  readonly tier: RiskTier;
  readonly payloadCanonical: string;
  readonly payloadSchemaVersion: number;
  readonly redaction: string;
  readonly parent: NodeId | undefined;
  readonly telemetry: NodeTelemetry | undefined;
}

/**
 * Check the acknowledgement against the node we asked to be written.
 *
 * This is the runtime half of `OPEN-ITEMS-RESOLVED.md` item 1. The brand stops
 * an object literal being a store at all; this stops a store that *is* branded
 * — a decorator over a real one, or an `as unknown as` cast — from
 * acknowledging a node it did not form correctly. A `nowhere` store that
 * fabricates `sequence: 0` and returns `canonical: ""` fails on the first
 * append rather than reporting `recorded: true` for a £2M authorisation.
 *
 * What it proves: the store assigned a plausible, unrepeated sequence and
 * produced the exact canonical bytes of the node it claims to have written.
 * What it does not prove: that the bytes reached a disk. Nothing at this seam
 * can. **Replay is the proof of a write**, and the case says so in
 * `provenance.capturedVia` rather than in a comment nobody exports.
 */
const verifyAcknowledgement = (
  asked: Asked,
  node: RecordedNode,
  seen: Set<number>,
): void => {
  const wrong = (detail: string): never => {
    throw new StoreContractViolated(asked.correlationId, detail);
  };

  if (node.correlationId !== asked.correlationId) {
    wrong(`acknowledged a node for case ${String(node.correlationId)}`);
  }
  if (!Number.isSafeInteger(node.sequence) || node.sequence < 0) {
    wrong(`assigned sequence ${String(node.sequence)}, which is not an ordinal`);
  }
  if (seen.has(node.sequence)) {
    wrong(`assigned sequence ${node.sequence} twice on the same case`);
  }
  if (typeof node.canonical !== "string" || node.canonical.length === 0) {
    wrong("acknowledged a node with no canonical bytes");
  }
  if (node.at !== asked.at) wrong("acknowledged a node with a different timestamp");
  if (node.tier !== asked.tier) wrong("acknowledged a node with a different tier");
  if (String(node.redaction) !== asked.redaction) {
    wrong("acknowledged a node with a different redactor");
  }
  if (node.parent !== asked.parent) {
    wrong("acknowledged a node with a different parent");
  }
  if (node.payloadSchemaVersion !== asked.payloadSchemaVersion) {
    wrong("acknowledged a node with a different payload schema version");
  }
  if (!telemetryAgrees(node.telemetry, asked.telemetry)) {
    wrong("acknowledged a node with different telemetry");
  }
  if (canonicalPayloadForm(node.payload) !== asked.payloadCanonical) {
    wrong("acknowledged a node with a different payload");
  }
  if (canonicalNodeFormOf(node) !== node.canonical) {
    wrong("acknowledged bytes that are not the canonical form of the node it returned");
  }

  seen.add(node.sequence);
};

/**
 * Anything that is not an `AuditError` came from an adapter that did not
 * classify its own failure. Treat it as the store being unavailable — that is
 * the only reading available from here — but note that both shipped adapters
 * *do* classify, so a constraint violation or a corrupt column arrives as
 * `StoreContractViolated` or `TraceCorrupt` and is never degradable.
 */
const named = (error: unknown, correlationId: CorrelationId): AuditError =>
  error instanceof AuditError
    ? error
    : new TraceUnavailable("store-failure", correlationId, { cause: error });

/**
 * Every dependency is a parameter. Nothing is constructed in here — no clock,
 * no store, no client, no redactor — which is what makes hermetic tests
 * structural rather than a convention someone remembers to follow.
 *
 * `redact` and `onTraceUnavailable` are required and have no defaults. A
 * default redactor would decide on nineteen applications' behalf what counts as
 * personal data; a default fail policy would decide whether a disbursement may
 * proceed unrecorded. Neither is this library's decision to make quietly.
 */
export const createAudit = ({
  store,
  clock,
  redact,
  onTraceUnavailable,
  limits,
}: AuditDeps): Audit => {
  const { maxPayloadBytes } = { ...DEFAULT_LIMITS, ...limits };

  return {
    async open(correlationId) {
      await store.openCase(correlationId, {
        // The honest scope statement, stamped onto the case rather than asserted
        // in prose. Everything this library mediates is captured; work an
        // application does out of band is not, and the artefact says so.
        capturedVia: "injected-trace-store-only",
        canonicalForm: ENVELOPE_VERSION,
        redaction: redact.id,
        openedAt: clock.now(),
      });

      // Bounded by the store's own `maxNodesPerCase`, which is why that ceiling
      // is part of the interface rather than an implementation detail.
      const sequencesSeen = new Set<number>();

      const record = async (
        payload: NodePayload,
        options: {
          readonly tier: RiskTier;
          readonly parent?: RecordedNode;
          readonly telemetry?: NodeTelemetry;
        },
      ): Promise<Recorded | Degraded> => {
        // Caller defects first, before the redactor and before the store. Each
        // of these throws at every tier: degrading a call-site defect turns a
        // loud bug into a quietly missing node, and the whole point of the
        // tiered policy is to describe an outage, not a mistake.
        if (isReservedKind(payload.kind)) {
          throw new ReservedNodeKind(correlationId, payload.kind);
        }
        if (
          options.parent !== undefined &&
          options.parent.correlationId !== correlationId
        ) {
          throw new ParentNotOfThisCase(correlationId, String(options.parent.id));
        }

        // Redact, then prove the result is byte-stably writable, both before the
        // store is touched. There is no un-writing personal data and no
        // half-writing an unserialisable node.
        const redacted = redactOrThrow(redact, payload);
        assertCanonicalisable(redacted);
        const payloadCanonical = canonicalPayloadForm(redacted);
        const bytes = Buffer.byteLength(payloadCanonical, "utf8");
        if (bytes > maxPayloadBytes) {
          throw new PayloadTooLarge(correlationId, bytes, maxPayloadBytes);
        }

        const at = clock.now();
        const asked: Asked = {
          correlationId,
          at,
          tier: options.tier,
          payloadCanonical,
          payloadSchemaVersion: redacted.v,
          redaction: String(redact.id),
          parent: options.parent?.id,
          telemetry: options.telemetry,
        };

        let node: RecordedNode;
        try {
          node = await store.append({
            correlationId,
            at,
            tier: options.tier,
            payload: redacted,
            redaction: redact.id,
            parent: asked.parent,
            telemetry: options.telemetry,
          });
        } catch (error) {
          const failure = named(error, correlationId);

          // The high-tier check is written out rather than left to the policy
          // lookup on purpose. `UnavailabilityPolicy["high"]` is pinned to
          // "fail-closed" in the type, but a JavaScript caller — or a policy
          // parsed from configuration — can still hand over `{ high: "degrade" }`
          // at runtime. An unrecordable high-tier decision does not proceed: no
          // trace, no effect, whatever the object says.
          if (
            !failure.degradable ||
            options.tier === "high" ||
            onTraceUnavailable[options.tier] === "fail-closed"
          ) {
            throw failure;
          }

          return {
            recorded: false,
            reason: (failure as TraceUnavailable).reason,
            at: clock.now(),
            tier: options.tier as Exclude<RiskTier, "high">,
          };
        }

        // Outside the catch on purpose: a store that broke its contract must
        // not be able to have that reported as an outage and degraded away.
        verifyAcknowledgement(asked, node, sequencesSeen);
        return { recorded: true, node };
      };

      const close = async (
        outcome: UnassistedContainment,
      ): Promise<RecordedNode> => {
        let seal: RecordedNode;
        try {
          seal = await store.closeCase(correlationId, clock.now(), outcome);
        } catch (error) {
          // `close` used to be a bare delegation, so a raw driver error escaped
          // this module un-named and `errors.ts`'s premise — every failure
          // states its policy — did not hold for the one verb that writes the
          // unassisted-containment figure.
          throw named(error, correlationId);
        }

        if (seal.payload.kind !== SEAL_KIND) {
          throw new StoreContractViolated(
            correlationId,
            `closed with a node of kind ${seal.payload.kind} rather than ${SEAL_KIND}`,
          );
        }
        if (seal.payload["unassistedContainment"] !== outcome.unassistedContainment) {
          throw new StoreContractViolated(
            correlationId,
            "sealed a different unassisted-containment figure from the one asked for",
          );
        }
        if (typeof seal.canonical !== "string" || seal.canonical.length === 0) {
          throw new StoreContractViolated(correlationId, "sealed with no canonical bytes");
        }
        if (canonicalNodeFormOf(seal) !== seal.canonical) {
          throw new StoreContractViolated(
            correlationId,
            "sealed with bytes that are not the canonical form of the seal it returned",
          );
        }
        return seal;
      };

      const trace: CaseTrace = {
        correlationId,
        // One cast, in one place, with a reason: the implementation returns the
        // full union while the interface narrows it by tier through a conditional
        // type. TypeScript cannot verify a conditional return from inside, so the
        // narrowing is asserted here rather than smeared across every branch.
        record: record as CaseTrace["record"],

        // Always fail-closed, at every tier and whatever the policy says. A case
        // whose closure was not recorded is not closed, and an
        // unassisted-containment figure with no node behind it is an assertion
        // rather than evidence.
        close,
      };

      return trace;
    },

    async replay(correlationId) {
      const stored = await store.read(correlationId);
      // Fail-closed: an absent case throws rather than returning an empty one.
      // "We have no record" must never be able to masquerade as "nothing
      // happened" — those are very different answers to give an auditor.
      if (stored === undefined) throw new NoSuchCase(correlationId);
      return replayedCase(correlationId, stored);
    },
  };
};
