/**
 * Fixture: the subject cannot write, and a recorder cannot arrive from outside.
 */
import { defineSubject, determine, subjectVersion } from "../../index.js";
import type {
  EvalNodeStore,
  EvalRecorder,
  ReadOnlyClient,
  WriteCapableClient,
} from "../../index.js";

// The legitimate subject compiles.
void defineSubject({
  version: subjectVersion("v1"),
  purity: "calls-models",
  decide: async (ctx) => {
    await ctx.client.complete({
      model: "m" as never,
      promptVersion: "p" as never,
      prompt: {},
    });
    return determine("duplicate", 9_000);
  },
});

void defineSubject({
  version: subjectVersion("v1"),
  purity: "pure",
  // @ts-expect-error a decide that demands a write-capable client is not assignable
  decide: async (ctx: {
    client: WriteCapableClient;
    node: unknown;
    input: unknown;
    tier: unknown;
    seed: unknown;
    now: unknown;
    signal: unknown;
  }) => {
    await ctx.client.write({ kind: "pay", idempotencyKey: "k", payload: {} });
    return determine("paid", 10_000);
  },
});

// The two client types are disjoint in **both** directions, which is what makes
// the guarantee survive method-shorthand positions too.
declare const readOnly: ReadOnlyClient;
declare const writeCapable: WriteCapableClient;
// @ts-expect-error read-only is not write-capable
const a: WriteCapableClient = readOnly;
// @ts-expect-error and write-capable is not read-only
const b: ReadOnlyClient = writeCapable;
void a;
void b;

// A recorder cannot be supplied by anything but `createEvalRecorder`: the brand
// is a non-exported unique symbol, so a structural impostor does not typecheck.
// @ts-expect-error a hand-rolled no-op recorder is not an EvalRecorder
const impostor: EvalRecorder = { append: async () => ({ sequence: 0 }) };
void impostor;

// And neither is a hand-rolled **store**, which is where the forgery moved to
// once the recorder was branded. A structurally complete store — every method,
// every signature, no cast — produced a green report with nothing written
// anywhere, because `EvalNodeStore` was a plain exported interface. It carries
// its own non-exported unique symbol now, so this does not typecheck either.
// @ts-expect-error a structurally complete store is not an EvalNodeStore
const forgedStore: EvalNodeStore = {
  openRun: async () => undefined,
  append: async () => ({}) as never,
  settle: async () => ({}) as never,
  read: async () => undefined,
  expireBefore: async () => ({ runs: 0, nodes: 0 }),
};
void forgedStore;
