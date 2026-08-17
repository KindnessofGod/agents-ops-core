/**
 * Capability, as a type.
 *
 * This is the highest-leverage requirement in the library, so it is the
 * smallest file in the module and nothing else lives in it.
 *
 * `Client<"read">` and `Client<"write">` are **disjoint in both directions**.
 * Neither is a subtype of the other, because the literal types of the phantom
 * property are incompatible. That is the entire mechanism, and it is why this
 * is not a brand: `approval/minimal`'s brand had `WriteCapableClient extends
 * ReadOnlyClient`, which an adversary compiled and got `TS2430` from. Extension
 * is the wrong relation. Disjointness is the right one.
 *
 * Three compilation facts, all load-bearing and all verified against this
 * repository's own `tsconfig.base.json` (tsc 5.9.3) rather than asserted:
 *
 *  1. `strictFunctionTypes` (on, via `strict: true`) makes function *parameter*
 *     positions contravariant, so a handler that demands more capability than
 *     the seam supplies is rejected.
 *  2. Because the two client types are *mutually* unassignable, the guarantee
 *     survives even in method-shorthand position, where TypeScript compares
 *     parameters bivariantly — a bivariant check passes only if one of the two
 *     directions is assignable, and here neither is. `approval/common-case`
 *     warned that method shorthand "silently deletes the guarantee"; measured,
 *     it does not. We still declare `decide` as a property with a function type
 *     rather than a method, because that is true independent of the mechanism
 *     and costs nothing.
 *  3. The phantom key is a non-exported `unique symbol`, so no code outside
 *     this file can *name* it, and a structural impostor written as an object
 *     literal does not typecheck. Declaration emit re-declares it as an ambient
 *     symbol in the `.d.ts` and does not export it — checked, it compiles.
 *
 * What defeats it, stated plainly rather than hidden: `any`, `as`, and
 * `@ts-expect-error` defeat any type-level guarantee. The runtime backstop is
 * that the read-only client this module hands to `decide` has no `write`
 * property at all, so an `any`-typed handler calling `client.write(...)` throws
 * a `TypeError`, and `approval` records an `approval.adapter-failed` node
 * naming the `spec.decide` seam and the `TypeError` before re-raising
 * fail-closed. That consequence is asserted by a test that runs it, in
 * `tests/adapters-and-trace.test.ts` — it was previously asserted here and
 * was false, because nothing wrapped `spec.decide` at all. The type is the
 * guarantee; the object shape is what happens when someone bypasses the type.
 */

declare const CAPABILITY: unique symbol;

export type Capability = "read" | "write";

/** Evidence is fetched by description, never by URL. The adapter owns transport. */
export interface EvidenceQuery<E> {
  readonly kind: string;
  readonly ref: string;
  /** Phantom, so `read` is typed by the query rather than by the call site. */
  readonly __evidence?: (e: E) => void;
}

interface Reads {
  /**
   * Property with a function type, deliberately. See fact 2 above: the choice
   * is belt-and-braces here, not the mechanism.
   */
  readonly read: <E>(query: EvidenceQuery<E>) => Promise<E>;
}

export interface Client<C extends Capability> extends Reads {
  /**
   * Phantom. Present at the type level only; the runtime object has no such
   * property. Its literal type is what makes the two clients structurally
   * disjoint.
   */
  readonly [CAPABILITY]: C;
}

/** What every `decide` receives, at every tier. There is no other option. */
export type ReadOnlyClient = Client<"read">;

/**
 * Only ever handed to a declared `EffectDeclaration.execute`, only after a
 * licence has been minted and the kill switch read. No `decide` at any tier
 * receives one — that is the deliberate inversion from `FINDINGS.md`, and it
 * closes the highest-severity flaw found anywhere in the design exercise.
 */
export interface WriteCapableClient extends Client<"write"> {
  readonly write: <R>(command: EffectCommand<R>) => Promise<R>;
}

/** An effect command carries its idempotency key so the channel can honour it. */
export interface EffectCommand<R> {
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly __result?: (r: R) => void;
}

/**
 * The only way a client comes into existence. There is no exported
 * constructor, no `new`, and no default — which is what makes hermetic tests
 * structural: in a test you pass `inMemoryClientFactory`, which this module
 * ships and exports, and there is no code path from a decision point to a
 * socket, credentials in the environment or not.
 *
 * Seam accounting, per C5: the in-memory factory is the shipped adapter. The
 * second is each application's own — the factory that reaches its evidence
 * store and its effect channel — and it is the reason this is a seam at all,
 * because nineteen of them differ entirely. That is a real second adapter
 * living outside this package, not a hypothetical one, and it is named here
 * rather than counted from a private test fixture.
 */
export interface ClientFactory {
  readonly readOnly: (scope: ClientScope) => ReadOnlyClient;
  readonly writeCapable: (scope: ClientScope) => WriteCapableClient;
}

/** Every client is bound to the node that owns it. */
export interface ClientScope {
  readonly correlationId: string;
  readonly node: string;
  readonly pointId: string;
}
