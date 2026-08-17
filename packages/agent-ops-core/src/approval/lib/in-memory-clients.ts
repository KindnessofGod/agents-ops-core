import type {
  ClientFactory,
  ClientScope,
  EffectCommand,
  ReadOnlyClient,
  WriteCapableClient,
} from "./clients.js";

/**
 * In-memory client factory.
 *
 * A shipped deliverable, not a test mock, and the thing `clients.ts` claimed
 * existed before it did: "in a test you pass the in-memory factory" was true of
 * a private fixture and of nothing that a caller could reach.
 *
 * It is what makes hermetic tests **structural** rather than conventional.
 * Wired in, there is no code path from a decision point to a socket, whatever
 * credentials are present in the environment — not because a flag was set but
 * because no adapter here can open one.
 *
 * Two properties worth stating, because they are the ones a caller relies on:
 *
 *   - **The read-only client has no `write` property at runtime**, not merely
 *     no `write` in its type. An `any`-typed handler reaching for one gets a
 *     `TypeError`, which `approval` catches, records as an adapter failure and
 *     re-raises fail-closed. The type is the guarantee; the object shape is
 *     what happens when somebody bypasses the type.
 *   - **Writes are recorded in order, with the idempotency key.** That is what
 *     lets a test assert an effect executed exactly once per key rather than
 *     asserting it did not throw.
 */
export interface InMemoryClients extends ClientFactory {
  /** `"<command kind>:<idempotency key>"`, in the order the writes were made. */
  readonly writes: readonly string[];
  /** Every scope a client was minted for. One per node that owned a client. */
  readonly scopes: readonly ClientScope[];
}

export interface InMemoryClientOptions {
  /**
   * Evidence answers, keyed by `EvidenceQuery.ref`. A query with no answer
   * throws rather than resolving `undefined`: a decision made on evidence that
   * silently was not there is the failure this seam exists to make visible.
   */
  readonly evidence?: Readonly<Record<string, unknown>>;
  /**
   * What a write returns. Defaults to `{ reference: "ref_<n>" }`. Supplied as a
   * function of the command so an effect channel's real reply shape can be
   * imitated without a network.
   */
  readonly onWrite?: (command: EffectCommand<unknown>, ordinal: number) => unknown;
}

export const inMemoryClientFactory = (
  options: InMemoryClientOptions = {},
): InMemoryClients => {
  const evidence = options.evidence ?? {};
  const writes: string[] = [];
  const scopes: ClientScope[] = [];

  const read = async <E>(query: { readonly kind: string; readonly ref: string }): Promise<E> => {
    if (!Object.prototype.hasOwnProperty.call(evidence, query.ref)) {
      throw new Error(`no in-memory evidence for ${query.kind}:${query.ref}`);
    }
    return evidence[query.ref] as E;
  };

  return {
    writes,
    scopes,
    readOnly(scope): ReadOnlyClient {
      scopes.push(scope);
      // No `write` property exists on this object. That is the runtime backstop
      // behind the type-level capability guarantee.
      return { read } as ReadOnlyClient;
    },
    writeCapable(scope): WriteCapableClient {
      scopes.push(scope);
      return {
        read,
        write: async <R>(command: EffectCommand<R>): Promise<R> => {
          writes.push(`${command.kind}:${command.idempotencyKey}`);
          const reply =
            options.onWrite === undefined
              ? { reference: `ref_${writes.length}` }
              : options.onWrite(command as EffectCommand<unknown>, writes.length);
          return reply as R;
        },
      } as WriteCapableClient;
    },
  };
};
