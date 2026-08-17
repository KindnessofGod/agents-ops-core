import { canonicalPayloadForm, digestOf, EVAL_ENVELOPE_VERSION } from "./canonical.js";
import {
  EvalStoreUnavailable,
  NodeSettledTwice,
  RecorderNotMinted,
  SubjectAttemptedWrite,
} from "./errors.js";
import { assertMintedStore } from "./store-brand.js";
import type { ModelBackend, ModelRequest, ModelResponse, ReadOnlyClient } from "./clients.js";
import type {
  Clock,
  EvalNode,
  EvalNodeId,
  EvalNodeKind,
  EvalPayload,
  ExpiryResult,
  NodeContext,
  NodeHandle,
  NodeOutcome,
  NodeSpec,
  PriceTable,
  RecorderDeps,
  Redactor,
  RunId,
  StoredEvalRun,
  StoredRunHeader,
  Timers,
  TraceDigest,
} from "./types.js";

/**
 * The recorder brand.
 *
 * `EVAL_RECORDER` is a **non-exported `unique symbol`**, so no code outside this
 * file can name it and a structural impostor — the two-line
 * `{ append: async n => ({ ...n, sequence: 0 }) }` that made every downstream
 * check report success in the design exercise — does not typecheck.
 *
 * Three further facts, and the second is the one that matters most:
 *
 *  1. `EvalRecorder` has **no members at all** at the type level. There is
 *     nothing on it a caller can call, so there is no partial implementation to
 *     write. Everything the runner needs is reached through a module-private
 *     `WeakMap` that only `createEvalRecorder` populates, so a value forced
 *     through with `as` fails at the first lookup with a named error rather than
 *     silently recording nothing.
 *  2. It **never arrives through the subject**. It is a parameter of `run`,
 *     supplied by the composition root; the subject receives only a
 *     `DecisionContext` derived from it. The thing being measured does not
 *     choose its own witness.
 *  3. Acknowledgement carries a **store-assigned sequence**, so a recorder that
 *     returned without writing could not fabricate one.
 */
declare const EVAL_RECORDER: unique symbol;

export interface EvalRecorder {
  readonly [EVAL_RECORDER]: true;
}

/* ------------------------------------------------------------------ internals */

export interface OpenNodeOptions {
  readonly kind: EvalNodeKind;
  readonly name: string;
  readonly v: number;
  readonly payload: EvalPayload;
  readonly signal: AbortSignal;
  /**
   * Set on the `case` node and inherited by everything beneath it, so an
   * incident raised deep in a subtree names the **case** an incident responder
   * has to go and look at. `SubjectAttemptedWrite` used to be constructed from
   * the node name and stored in a field called `caseRef`, so it read `decide` or
   * `exactVerdict`.
   */
  readonly caseRef?: string | undefined;
}

export interface Settlement {
  readonly outcome: NodeOutcome;
  readonly closing: EvalPayload;
}

/**
 * A node that is open. Internal to `lib/` — the *public* surface of a node is
 * `NodeHandle`, which has only `child`.
 */
export interface OpenNode {
  readonly id: EvalNodeId;
  readonly handle: NodeHandle;
  readonly context: NodeContext;
  /** Model calls recorded anywhere in this node's subtree. Drives attribution. */
  modelCalls(): number;
  costTenthCents(): number;
  open(options: OpenNodeOptions): Promise<OpenNode>;
  settle(settlement: Settlement): Promise<void>;
}

interface InternalNode extends OpenNode {
  readonly caseRef: string | undefined;
  bubbleUp(calls: number, cost: number, tokensIn: number, tokensOut: number): void;
}

export interface RunTrace {
  readonly digest: TraceDigest;
  readonly nodes: number;
  readonly unsettled: number;
}

export interface RunScope {
  readonly runId: RunId;
  readonly runNode: OpenNode;
  finish(settlement: Settlement): Promise<RunTrace>;
  read(): Promise<StoredEvalRun>;
}

export interface BeginRun {
  readonly header: Omit<
    StoredRunHeader,
    "envelope" | "redaction" | "capturedVia" | "openedAt" | "runId"
  >;
  /**
   * The run identifier is **assigned here**, from the injected clock plus a
   * per-recorder counter, and never by the caller. It used to be
   * `Math.floor(Math.random() * 0xffffffff)` in two places — the only
   * uninjected non-determinism in the module and unreachable from any test.
   *
   * The honest limit: two processes opening a run for the same prefix in the
   * same millisecond collide, and the collision surfaces as `openRun` refusing a
   * duplicate — fail-closed and visible, rather than two runs quietly sharing an
   * identifier.
   */
  readonly idPrefix: string;
  readonly models: ModelBackend;
  readonly priceTable: PriceTable;
  readonly retries: number;
  readonly signal: AbortSignal;
  readonly runPayload: EvalPayload;
  /** Checked **inside** a case, after every recorded model call. 0 disables. */
  readonly costCeilingTenthCents: number;
  /** Called the moment the ceiling is crossed, not when the case ends. */
  readonly onCostCeiling: (spentTenthCents: number) => void;
}

export interface RecorderInternals {
  beginRun(input: BeginRun): Promise<RunScope>;
  expireBefore(cutoff: number, batchLimit: number): Promise<ExpiryResult>;
  /** So the runner can redact report contents with the policy the nodes used. */
  readonly redact: Redactor;
  readonly clock: Clock;
  readonly timers: Timers;
}

const internals = new WeakMap<EvalRecorder, RecorderInternals>();

/**
 * Reaches the internals of a branded recorder. Throws — fail-closed — when
 * handed anything this module did not mint, which is the runtime half of the
 * brand.
 */
export const recorderInternals = (recorder: EvalRecorder): RecorderInternals => {
  const found = internals.get(recorder);
  if (found === undefined) throw new RecorderNotMinted();
  return found;
};

/* -------------------------------------------------------------- construction */

const priceOf = (
  table: PriceTable,
  model: string,
  tokensIn: number,
  tokensOut: number,
): { readonly tenthCents: number; readonly known: boolean } => {
  const row = table.perModel[model];
  if (row === undefined) return { tenthCents: 0, known: false };
  // Integer arithmetic throughout, rounded up to whole tenth-cents. A cost
  // figure carried as a float is a cost figure that stops being byte-stable the
  // first time it crosses a host.
  const tenthCents =
    Math.ceil((tokensIn * row.inTenthCentsPerMillion) / 1_000_000) +
    Math.ceil((tokensOut * row.outTenthCentsPerMillion) / 1_000_000);
  return { tenthCents, known: true };
};

/** Bounded, jittered backoff. Deterministic given the run seed. */
const backoffMillis = (attempt: number, jitter01: number): number =>
  Math.max(1, Math.floor(Math.min(20 * 2 ** attempt, 2_000) * jitter01));

const errorName = (cause: unknown): string => (cause instanceof Error ? cause.name : typeof cause);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The only constructor of a recorder.
 *
 * Two adapters sit behind `deps.store` — in-memory and SQL — and both write to
 * the **eval** store, never to `audit`'s. A trace never spans both.
 */
export const createEvalRecorder = (deps: RecorderDeps): EvalRecorder => {
  // Fail-closed, at construction, before a run can open. The store's brand is
  // the other half of the recorder's: a genuine recorder over a forged store
  // produced a green report with nothing written anywhere.
  const store = assertMintedStore(deps.store);
  const recorder = {} as EvalRecorder;
  let runCounter = 0;

  const beginRun = async (input: BeginRun): Promise<RunScope> => {
    const openedAt = deps.clock.now();
    runCounter += 1;
    const runId = `${input.idPrefix}-${openedAt.toString(16)}-${runCounter.toString(16).padStart(4, "0")}` as RunId;
    const header: StoredRunHeader = {
      ...input.header,
      runId,
      openedAt,
      envelope: EVAL_ENVELOPE_VERSION,
      redaction: deps.redact.id,
      capturedVia: "injected-client-only",
    };
    await store.openRun(header);
    let spentTenthCents = 0;
    let ceilingAnnounced = false;

    // Deterministic jitter: same seed, same backoff sequence, same trace.
    let jitterState = 1;
    for (const ch of input.header.seed) jitterState = (jitterState * 31 + ch.charCodeAt(0)) >>> 0;
    const nextJitter = (): number => {
      jitterState = (jitterState * 1_664_525 + 1_013_904_223) >>> 0;
      return jitterState / 4_294_967_296;
    };

    const makeNode = async (
      parent: InternalNode | undefined,
      options: OpenNodeOptions,
    ): Promise<InternalNode> => {
      const payload = deps.redact.apply(options.payload);
      // Validate before any write. A float, an array or a nested object throws
      // `UnserialisablePayload` here, so an unserialisable node never exists.
      canonicalPayloadForm(payload);

      const nodeOpenedAt = deps.clock.now();
      const caseRef = options.caseRef ?? parent?.caseRef;
      let stored: EvalNode;
      try {
        stored = await store.append({
          runId: header.runId,
          parent: parent?.id,
          kind: options.kind,
          name: options.name,
          openedAt: nodeOpenedAt,
          payloadSchemaVersion: options.v,
          redaction: deps.redact.id,
          envelope: EVAL_ENVELOPE_VERSION,
          payload,
        });
      } catch (cause) {
        throw cause instanceof EvalStoreUnavailable
          ? cause
          : new EvalStoreUnavailable("append", cause);
      }

      let subtreeCalls = 0;
      let subtreeCost = 0;
      let subtreeTokensIn = 0;
      let subtreeTokensOut = 0;
      let closed = false;

      const bubbleUp = (calls: number, cost: number, tin: number, tout: number): void => {
        subtreeCalls += calls;
        subtreeCost += cost;
        subtreeTokensIn += tin;
        subtreeTokensOut += tout;
        parent?.bubbleUp(calls, cost, tin, tout);
      };

      const settle = async (settlement: Settlement): Promise<void> => {
        // `EvalNodeStore` says settling twice is an error, not a no-op. This
        // used to `return` — so the contract held at the store and was silently
        // contradicted one layer above it, and a node closed twice kept
        // whichever outcome arrived first. Every settle path in this file now
        // runs exactly once by construction; this is what happens if that stops
        // being true.
        if (closed) throw new NodeSettledTwice(stored.id);
        closed = true;
        const closedAt = deps.clock.now();
        const closing = deps.redact.apply(settlement.closing);
        const merged: EvalPayload = { ...payload, ...closing };
        const cost = subtreeCost;
        const tokensIn = subtreeTokensIn;
        const tokensOut = subtreeTokensOut;
        const canonical =
          "{" +
          [
            `"envelope":${JSON.stringify(EVAL_ENVELOPE_VERSION)}`,
            `"id":${JSON.stringify(stored.id)}`,
            `"seq":${String(stored.sequence)}`,
            `"parent":${parent === undefined ? "null" : JSON.stringify(parent.id)}`,
            `"kind":${JSON.stringify(options.kind)}`,
            `"name":${JSON.stringify(options.name)}`,
            `"outcome":${JSON.stringify(settlement.outcome)}`,
            `"pv":${String(options.v)}`,
            `"redaction":${JSON.stringify(deps.redact.id)}`,
            `"priceTable":${JSON.stringify(input.priceTable.version)}`,
            `"cost":${String(cost)}`,
            `"tokensIn":${String(tokensIn)}`,
            `"tokensOut":${String(tokensOut)}`,
            `"payload":${canonicalPayloadForm(merged)}`,
          ].join(",") +
          "}";
        try {
          await store.settle({
            runId: header.runId,
            id: stored.id,
            closedAt,
            // Millisecond clock × 1000, so the unit is micros everywhere and the
            // number stays an integer.
            elapsedMicros: Math.max(0, (closedAt - nodeOpenedAt) * 1_000),
            outcome: settlement.outcome,
            costTenthCents: cost,
            tokensIn,
            tokensOut,
            priceTableVersion: input.priceTable.version,
            closing,
            canonical,
          });
        } catch (cause) {
          throw cause instanceof EvalStoreUnavailable
            ? cause
            : new EvalStoreUnavailable("settle", cause);
        }
      };

      /**
       * The node-bound client. It exists only here and only for the lifetime of
       * this node. No node ⇒ no client ⇒ no model call.
       */
      const client = {
        complete: async (request: ModelRequest): Promise<ModelResponse> => {
          const flatPrompt: Record<string, string | number | boolean | null> = {};
          for (const [k, v] of Object.entries(request.prompt)) flatPrompt[`prompt.${k}`] = v;
          const callNode = await makeNode(node, {
            kind: "model.call",
            name: request.model,
            v: 1,
            payload: {
              model: request.model,
              promptVersion: request.promptVersion,
              backend: input.models.id,
              ...flatPrompt,
            },
            signal: options.signal,
          });

          let lastError: unknown;
          let attempts = 0;
          for (let attempt = 0; attempt <= input.retries; attempt += 1) {
            attempts = attempt + 1;
            if (options.signal.aborted) {
              await callNode.settle({ outcome: "timeout", closing: { attempt } });
              throw new DOMException("case budget spent", "AbortError");
            }
            let response: ModelResponse;
            try {
              response = await input.models.complete(request, options.signal);
            } catch (cause) {
              // An incident is never a retry candidate and never becomes an
              // ordinary model failure. A store that cannot accept a write, or
              // a write attempt from the thing being measured, aborts the run.
              if (cause instanceof EvalStoreUnavailable || cause instanceof SubjectAttemptedWrite) {
                throw cause;
              }
              lastError = cause;
              if (attempt === input.retries) break;
              // Each retry is its own recorded fact with a parent, not a log line.
              const retryNode = await makeNode(callNode, {
                kind: "retry",
                name: request.model,
                v: 1,
                payload: { attempt, "error.name": errorName(cause) },
                signal: options.signal,
              });
              await retryNode.settle({ outcome: "ok", closing: {} });
              // Bounded, jittered, and driven by the **injected** timers, so a
              // test asserts the sequence instead of waiting for it.
              await deps.timers.sleep(backoffMillis(attempt, nextJitter()), options.signal);
              continue;
            }
            // The success path is deliberately outside the `try`: a settle that
            // throws must not be caught by the retry arm and settled a second
            // time, which is how a store failure used to become a retry.
            const price = priceOf(
              input.priceTable,
              request.model,
              response.tokensIn,
              response.tokensOut,
            );
            // The cost lands on the model-call node and bubbles to every
            // ancestor, so a case node's cost is the whole case's cost. The
            // call also counts itself, which is what makes a decision
            // subtree's model-call count meaningful for attribution.
            callNode.bubbleUp(0, price.tenthCents, response.tokensIn, response.tokensOut);
            callNode.bubbleUp(1, 0, 0, 0);
            await callNode.settle({
              outcome: "ok",
              closing: {
                attempt,
                "response.chars": response.text.length,
                "price.known": price.known,
              },
            });
            // The cost ceiling, checked **here** rather than between cases. It
            // used to be checked only after a case finished, so one chatty case
            // spent forty billion tenth-cents against a ceiling of one before
            // the check was ever reached. A budget only bounds what it is
            // checked against.
            spentTenthCents += price.tenthCents;
            if (
              input.costCeilingTenthCents > 0 &&
              spentTenthCents > input.costCeilingTenthCents &&
              !ceilingAnnounced
            ) {
              ceilingAnnounced = true;
              input.onCostCeiling(spentTenthCents);
            }
            return response;
          }
          await callNode.settle({
            outcome: "error",
            closing: { attempts, "error.name": errorName(lastError) },
          });
          throw lastError;
        },
        /**
         * The runtime backstop for a subject typed through `any`. The compile
         * error is primary; this is what happens when someone defeats it. It
         * aborts the whole **run**, not the case: a subject that reached for an
         * effect may have completed one through a channel this module does not
         * own, so every remaining case is suspect.
         */
        write: (): never => {
          // The case, then the node. An incident responder needs the case
          // reference to reach the trace; the node name alone ("decide",
          // "exactVerdict") tells them nothing about which case moved money.
          throw new SubjectAttemptedWrite(caseRef ?? "<no case>", options.name);
        },
      } as unknown as ReadOnlyClient;

      const handle: NodeHandle = {
        async child<T>(spec: NodeSpec, body: (ctx: NodeContext) => Promise<T>): Promise<T> {
          const childNode = await makeNode(node, {
            kind: "span",
            name: spec.name,
            v: spec.v,
            payload: spec.payload,
            signal: options.signal,
          });
          // The try/finally, the abort path and the throw path live here, in the
          // library. That is the whole mechanism: a caller cannot leave a node
          // dangling and cannot forget to record a failure, because neither is
          // code they write.
          //
          // Note the shape: **exactly one settle runs on every path.** The abort
          // branch used to settle and then throw *inside* the try, so its own
          // catch settled the same node a second time — invisible only because
          // the recorder silently swallowed a second settle. Both are fixed
          // together; neither fix is safe alone.
          if (options.signal.aborted) {
            await childNode.settle({ outcome: "aborted", closing: {} });
            throw new DOMException("case budget spent", "AbortError");
          }
          let value: T;
          try {
            value = await body(childNode.context);
          } catch (cause) {
            await childNode.settle({
              outcome: options.signal.aborted ? "timeout" : "error",
              closing: { "error.name": errorName(cause), "error.message": errorMessage(cause) },
            });
            throw cause;
          }
          await childNode.settle({ outcome: "ok", closing: {} });
          return value;
        },
      };

      const node: InternalNode = {
        id: stored.id,
        caseRef,
        handle,
        context: {
          node: handle,
          client,
          now: () => deps.clock.now(),
          signal: options.signal,
        },
        modelCalls: () => subtreeCalls,
        costTenthCents: () => subtreeCost,
        open: (childOptions) => makeNode(node, childOptions),
        settle,
        bubbleUp,
      };

      return node;
    };

    const runNode = await makeNode(undefined, {
      kind: "run",
      name: input.header.label,
      v: 1,
      payload: input.runPayload,
      signal: input.signal,
    });

    const readRun = async (): Promise<StoredEvalRun> => {
      const stored = await store.read(header.runId);
      if (stored === undefined) {
        throw new EvalStoreUnavailable("read", `run ${header.runId} vanished`);
      }
      return stored;
    };

    return {
      runId,
      runNode,
      async finish(settlement) {
        await runNode.settle(settlement);
        const stored = await readRun();
        const parts = stored.nodes.map(
          (n) => n.canonical ?? `{"unsettled":${JSON.stringify(n.id)}}`,
        );
        return {
          digest: digestOf(parts) as TraceDigest,
          nodes: stored.nodes.length,
          unsettled: stored.nodes.filter((n) => n.canonical === null).length,
        };
      },
      read: readRun,
    };
  };

  internals.set(recorder, {
    beginRun,
    expireBefore: (cutoff, batchLimit) => store.expireBefore(cutoff, batchLimit),
    redact: deps.redact,
    clock: deps.clock,
    timers: deps.timers,
  });
  return recorder;
};
