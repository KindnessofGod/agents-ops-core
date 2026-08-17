/**
 * Capability, as a type — and the reason a subject cannot write.
 *
 * `Client<"read">` and `Client<"write">` are **disjoint in both directions**.
 * Neither is a subtype of the other, because the literal types of the phantom
 * property are incompatible. That is the entire mechanism, and it is why this
 * is not an `extends` brand: extension is the wrong relation and an adversary
 * compiled the extension form in the design exercise and got `TS2430`.
 *
 * Three compilation facts, all load-bearing:
 *
 *  1. `strictFunctionTypes` (on, via `strict`) makes function *parameter*
 *     positions contravariant, so a `decide` that demands more capability than
 *     the seam supplies is rejected.
 *  2. Because the two client types are *mutually* unassignable, the guarantee
 *     survives even in method-shorthand position, where parameters are compared
 *     bivariantly — bivariance passes only if one direction is assignable, and
 *     here neither is. `decide` is still declared as a property with a function
 *     type, because that is true independent of the mechanism and costs nothing.
 *  3. The phantom key is a non-exported `unique symbol`, so no code outside this
 *     file can *name* it, and a structural impostor written as an object literal
 *     does not typecheck.
 *
 * **There is no exported constructor for a `ReadOnlyClient` and no code path in
 * this module that produces one outside a node.** A client is minted by
 * `NodeHandle.child` and by nothing else. So: no node ⇒ no client ⇒ no model
 * call. An unrecorded model call is unrepresentable because the thing that makes
 * model calls does not exist until the node that will record it exists.
 *
 * What defeats it, stated plainly rather than hidden: `any`, `as` and
 * `@ts-expect-error` defeat any type-level guarantee. The runtime backstop is
 * that the read-only client carries a poisoned `write` which records an error
 * node and aborts the whole run with `SubjectAttemptedWrite`. The type is the
 * guarantee; the poisoned property is what happens when someone bypasses it.
 */

declare const CAPABILITY: unique symbol;

export type Capability = "read" | "write";

/** What a model call looks like from a subject or a scorer. Flat and redactable. */
export interface ModelRequest {
  readonly model: ModelId;
  /** Required. "Which prompt produced this number" must be answerable in 2033. */
  readonly promptVersion: PromptVersion;
  /** Flat, integer-only, and redacted before it reaches the store. */
  readonly prompt: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ModelResponse {
  readonly text: string;
  /** Integers. Cost is derived from these and the pinned price table. */
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export type ModelId = string & { readonly __brand: "ModelId" };
export type PromptVersion = string & { readonly __brand: "PromptVersion" };

export const modelId = (value: string): ModelId => value as ModelId;
export const promptVersion = (value: string): PromptVersion => value as PromptVersion;

interface Reads {
  /**
   * Property with a function type, deliberately. See fact 2 above: the choice is
   * belt-and-braces here, not the mechanism.
   *
   * Every call appends a `model.call` node under the node that minted this
   * client, with the redacted request, the redacted response, tokens, cost in
   * tenth-cents, the price-table version and elapsed micros — **before it
   * resolves**. The caller writes no recording code.
   */
  readonly complete: (request: ModelRequest) => Promise<ModelResponse>;
}

export interface Client<C extends Capability> extends Reads {
  /**
   * Phantom. Present at the type level only; the runtime object has no such
   * property. Its literal type is what makes the two clients disjoint.
   */
  readonly [CAPABILITY]: C;
}

/**
 * The only client this module ever hands to a subject or to a scorer, on either
 * path. It is the same mechanism that gives a shadow run its no-effect
 * guarantee: a shadow run has no effects because the thing it runs cannot
 * express one, not because a flag was set.
 */
export type ReadOnlyClient = Client<"read">;

/**
 * Declared **only so the compile error is expressible**. This module never
 * constructs one and has no code path that can produce one. It exists to be the
 * type a mistaken subject author reaches for, so that reaching for it fails at
 * `tsc` rather than at a payment provider.
 */
export interface WriteCapableClient extends Client<"write"> {
  readonly write: <R>(command: EffectCommand<R>) => Promise<R>;
}

export interface EffectCommand<R> {
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly __result?: (r: R) => void;
}

/**
 * The seam behind `complete`. Two adapters: the application's production
 * provider client (nineteen of them, one per application, none shipped here)
 * and `scriptedModelBackend`, which is a **shipped deliverable** rather than a
 * mock — it is what makes hermeticity structural. This module contains nothing
 * that can open a socket, so a test cannot reach a live model with real
 * credentials present in the environment, because there is nothing in here to
 * reach it with.
 */
export interface ModelBackend {
  /** Recorded on every model-call node, so a report names what answered it. */
  readonly id: string;
  readonly complete: (request: ModelRequest, signal: AbortSignal) => Promise<ModelResponse>;
}
