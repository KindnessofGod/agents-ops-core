import { raiseAndRecord } from "../../alerts/index.js";
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
  CaseNotClosed,
  NoSuchCase,
  ParentNotOfThisCase,
  PayloadTooLarge,
  RedactionUnsound,
  ReservedNodeKind,
  StoreContractViolated,
  TraceUnavailable,
  WitnessUnavailable,
} from "./errors.js";
import { SEAL_KIND, isReservedKind } from "./seal.js";
import { traceVerifier, walkCase } from "./stream.js";
import { closedCaseDigest, verifyReceipt, witnessVerdict } from "./witness.js";
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
  TraceDigest,
  TraceVerdict,
  UnassistedContainment,
  WalkLimits,
  WitnessReceipt,
  WitnessRecord,
} from "./types.js";
import { asAudit } from "./types.js";

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
 * Build the replayed graph.
 *
 * Every check that matters happens on the read path, because that is where an
 * auditor stands — but it does not happen *here*. It happens in
 * `lib/stream.ts`'s `traceVerifier`, which this drives with a materialised
 * array and which `walk` drives a page at a time. One expression of the
 * invariants, two readers: a whole-case replay that checked the seal and a
 * streaming walk that forgot to would be this module's oldest defect — two
 * paths claiming the same guarantee and holding different ones — wearing a new
 * shape.
 *
 * The sort is the one thing that cannot be folded, and it stays here. A store
 * is obliged to return `readPage` in order (invariant 7) because a streaming
 * reader cannot reorder what it has already yielded; `read` returns the whole
 * case, so this path can be forgiving and sort defensively.
 *
 * `roots` and `childrenOf` are answered from an index built once — they used to
 * be linear filters per call, so walking a graph of n nodes cost n² — and the
 * digest is the one the verifier already folded.
 */
const replayedCase = (
  correlationId: CorrelationId,
  stored: StoredCase,
): ReplayedCase => {
  const nodes = [...stored.nodes].sort((a, b) => a.sequence - b.sequence);

  const verifier = traceVerifier(correlationId, stored.provenance);
  for (const node of nodes) verifier.accept(node);
  const verdict = verifier.finish();
  const closed = verdict.closed;

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

  return {
    correlationId,
    provenance: stored.provenance,
    nodes,
    closed,
    roots: () => roots,
    childrenOf: (id: NodeId) => children.get(id) ?? [],
    digest: () => verdict.digest,
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
  /**
   * Present where the caller named this append. A deduplicated acknowledgement
   * legitimately carries a **different clock reading** from the one we asked
   * for — it is the first node's, from the attempt that crashed — so the `at`
   * check below is relaxed for exactly that case and for no other.
   */
  readonly idempotencyKey: string | undefined;
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
  deduplicated: boolean,
): void => {
  const wrong = (detail: string): never => {
    throw new StoreContractViolated(asked.correlationId, detail);
  };

  // A store may only claim a deduplication where one was asked for. Otherwise
  // "I already had this" becomes a way for an adapter to acknowledge anything
  // at all without writing it — the exact hole the acknowledgement check exists
  // to close, reopened by a boolean.
  if (deduplicated && asked.idempotencyKey === undefined) {
    wrong("claimed to deduplicate an append that carried no idempotency key");
  }

  if (node.correlationId !== asked.correlationId) {
    wrong(`acknowledged a node for case ${String(node.correlationId)}`);
  }
  if (!Number.isSafeInteger(node.sequence) || node.sequence < 0) {
    wrong(`assigned sequence ${String(node.sequence)}, which is not an ordinal`);
  }
  // A deduplicated node is one this process may well have seen before — that is
  // what deduplication means — so a repeated sequence is expected there and is a
  // broken contract everywhere else.
  if (!deduplicated && seen.has(node.sequence)) {
    wrong(`assigned sequence ${node.sequence} twice on the same case`);
  }
  if (typeof node.canonical !== "string" || node.canonical.length === 0) {
    wrong("acknowledged a node with no canonical bytes");
  }
  if (!deduplicated && node.at !== asked.at) {
    wrong("acknowledged a node with a different timestamp");
  }
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
  witness,
  alerting,
}: AuditDeps): Audit => {
  const { maxPayloadBytes } = { ...DEFAULT_LIMITS, ...limits };

  /**
   * Publish one whole-case digest, checking the receipt against what we asked
   * for on exactly the reasoning `verifyAcknowledgement` applies to a store.
   *
   * `sealed` travels into the error because a caller must be able to tell
   * "close failed" from "the case is closed and unwitnessed" — different
   * sentences, and only the second one has an idempotent recovery.
   */
  const publish = async (
    correlationId: CorrelationId,
    digest: TraceDigest,
    nodes: number,
    sealed: boolean,
  ): Promise<WitnessReceipt> => {
    if (witness === undefined) {
      throw new WitnessUnavailable("not-configured", correlationId, { sealed });
    }
    const asked: WitnessRecord = {
      correlationId,
      digest,
      nodes,
      at: clock.now(),
      witness: witness.id,
    };
    let receipt: WitnessReceipt;
    try {
      receipt = await witness.publish(asked);
    } catch (error) {
      if (error instanceof AuditError) throw error;
      throw new WitnessUnavailable("witness-failure", correlationId, {
        cause: error,
        sealed,
      });
    }
    // Outside the catch on purpose: a witness that broke its contract must not
    // be able to have that reported as an outage.
    verifyReceipt(asked, receipt);
    return receipt;
  };

  /**
   * Walk a case to the end and keep only the verdict.
   *
   * Bounded: this is how `witness` and `verifyAgainstWitness` work on a
   * 100,000-node case without materialising it. The nodes are discarded as they
   * pass, which is the whole point — the verdict is fixed-size.
   */
  const verdictOf = async (
    correlationId: CorrelationId,
    limits?: Partial<WalkLimits>,
  ): Promise<TraceVerdict> => {
    const walk = walkCase(store, correlationId, limits);
    for (;;) {
      const step = await walk.next();
      if (step.done) return step.value;
    }
  };

  // `asAudit` mints the brand, and this is the only call site in the library.
  // A structural object that acknowledges every write and persists nothing no
  // longer satisfies `Audit` — README item 8, and the reason `guardrails` had
  // to prove its first node by replay to find out whether its recorder was
  // real. Those runtime checks stay exactly where they are: the brand removes
  // the accident, not the adversary.
  return asAudit({
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
          readonly idempotencyKey?: string;
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
          idempotencyKey: options.idempotencyKey,
        };

        let ack: { readonly node: RecordedNode; readonly deduplicated: boolean };
        try {
          ack = await store.append({
            correlationId,
            at,
            tier: options.tier,
            payload: redacted,
            redaction: redact.id,
            parent: asked.parent,
            telemetry: options.telemetry,
            idempotencyKey: options.idempotencyKey,
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
            // `docs/CONTEXT.md`, seventh silent condition: *"Fail-closed is
            // correct AND means work has stopped. Correct behaviour is still an
            // incident."* Nothing here is broken. A £2M disbursement simply is
            // not happening, and the only outward sign is a well-named error
            // that a retry loop will very reasonably swallow.
            //
            // Raised at HIGH TIER ONLY, and only for an unavailable store — not
            // for a payload defect, which is a bug at the call site rather than
            // an outage, and not at low or medium, where a fail-closed policy is
            // the application's own declared choice about its own latency.
            // Paging an operator about a policy working as declared is how the
            // channel carrying the other seven conditions gets muted.
            if (options.tier === "high" && failure instanceof TraceUnavailable) {
              // The record goes onto the error, because the one place this
              // library normally records an alert — a node on the case's trace —
              // is the thing that just failed. See `TraceUnavailable.alerting`.
              failure.alerting = await raiseAndRecord(alerting, {
                kind: "trace-unavailable-at-high-tier",
                correlationId,
                reason: failure.reason,
              });
            }
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
        verifyAcknowledgement(asked, ack.node, sequencesSeen, ack.deduplicated);
        return { recorded: true, node: ack.node, deduplicated: ack.deduplicated };
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

        // The external witness, published from the seal alone.
        //
        // The seal carries the digest of everything before it, so the whole-case
        // digest is that chain extended by one link — no re-read of a case we
        // have just written, and byte for byte what `replay(...).digest()`
        // produces. Publication is necessarily *after* the seal commits, because
        // the digest does not exist until the seal does. That window is real: a
        // process dying here leaves a sealed, unwitnessed case. It is handled by
        // `Audit.witness`, which is idempotent, rather than pretended away.
        //
        // Fail-closed, with no policy knob, and the reasoning is the opposite of
        // `TraceUnavailable`'s. Degrading a write keeps a decision moving;
        // degrading this keeps nothing moving, because the case is already
        // sealed and the evidence is already written. It would trade a loud,
        // cheap, retryable failure for a permanent silent gap in the one
        // mechanism that catches a total rewrite.
        if (witness !== undefined) {
          const closed = closedCaseDigest(seal);
          if (closed === undefined) {
            throw new StoreContractViolated(
              correlationId,
              "sealed with a payload the whole-case digest cannot be derived from",
            );
          }
          await publish(correlationId, closed.digest, closed.nodes, true);
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

    walk(correlationId, limits) {
      return walkCase(store, correlationId, limits);
    },

    async witness(correlationId, limits) {
      // The recovery path, and the sweep path. Idempotent: republishing an
      // identical digest returns the record the witness already holds, so a
      // sweep over sealed-and-unwitnessed cases can be re-run as often as
      // anyone likes and a crash between seal and publication costs nothing but
      // a later run.
      const verdict = await verdictOf(correlationId, limits);
      if (!verdict.closed) throw new CaseNotClosed(correlationId);
      return publish(correlationId, verdict.digest, verdict.nodes, true);
    },

    async verifyAgainstWitness(correlationId, limits) {
      if (witness === undefined) {
        throw new WitnessUnavailable("not-configured", correlationId);
      }
      const verdict = await verdictOf(correlationId, limits);
      if (!verdict.closed) {
        return { agrees: false, reason: "not-closed", digest: verdict.digest };
      }
      const held = await witness.lookUp(correlationId);
      return witnessVerdict(verdict.digest, held);
    },
  });
};
