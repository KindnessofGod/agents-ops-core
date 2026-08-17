/**
 * Every line here is expected to be a compile error. The test asserts this file
 * produces **zero** diagnostics, which — given `@ts-expect-error` — is true
 * only if each marked line errors. If the capability constraint ever weakens,
 * `TS2578: Unused '@ts-expect-error' directive` fails the build.
 */
import type {
  Client,
  Determination,
  DoNothing,
  EscalationLadder,
  ReadOnlyClient,
  Reserved,
  UngatedSpec,
  WriteCapableClient,
} from "../../index.js";

declare const ladder: EscalationLadder;
declare const write: WriteCapableClient;
declare const read: ReadOnlyClient;

/* 1. A `decide` demanding write capability, in a spec that supplies read only.
      This is the mistake the whole module exists to make impossible: taking an
      effect inside `decide`, with no licence, no kill-switch read, no
      idempotency claim and no node. */
export const spec: UngatedSpec<{ id: string }, string, never> = {
  id: "invoices.disburse_payment",
  schemaVersion: 1,
  gate: "never",
  maxTier: "low",
  effect: { kind: "no-effect" },
  tierFacts: () => ({}),
  reservedFacts: () => ({}),
  // @ts-expect-error — no `decide` receives a write-capable client, at any tier.
  decide: async (client: WriteCapableClient, _input: { id: string }) => {
    await client.write({ kind: "ledger.debit", idempotencyKey: "k", payload: {} });
    return {
      kind: "abstained",
      reason: "never reached",
      evidence: [],
      spend: { costTenthCents: 0, tokensIn: 0, tokensOut: 0, priceTableVersion: "none" },
    } as Determination<
      string,
      never
    >;
  },
};

/* 2. The other direction: a read-only client where write capability is
      required. Both directions must fail, or a structural subtype relation has
      crept back in and the guarantee has evaporated. */
declare function needsWrite(client: WriteCapableClient): void;
// @ts-expect-error — Client<"read"> is not assignable to Client<"write">.
export const b = () => needsWrite(read);

declare function needsRead(client: ReadOnlyClient): void;
// @ts-expect-error — Client<"write"> is not assignable to Client<"read"> either.
export const c = () => needsRead(write);

/* 3. A structural impostor. The phantom key is a non-exported `unique symbol`,
      so an object literal cannot name it and cannot satisfy the interface. */
// @ts-expect-error — the capability property cannot be named from outside.
export const forged: Client<"write"> = { read: async () => undefined as never };

/* 4. A reserved decision has no expiry branch to declare. `DoNothing<Reserved>`
      is `{ ladder }` and nothing else, so "nobody was on shift" is
      inexpressible rather than merely forbidden. */
export const reservedDoNothing: DoNothing<Reserved> = {
  ladder,
  // @ts-expect-error — `expire` does not exist on DoNothing<Reserved>.
  expire: { after: 1000, then: { kind: "refuse", reason: "timed out" } },
};

/* 5. A gated decision cannot be declared without a ladder, and a ladder cannot
      be declared without a recurrence. There is no `stop` and no
      `maxAttempts` to reach for. */
// @ts-expect-error — `recurrence` is required; there is no way to opt out.
export const noRecurrence: EscalationLadder = {
  steps: [{ after: 3_600_000, action: "notify", to: { kind: "pool", pool: "ap" as never } }],
};

/* 6. `read` is the only capability a ReadOnlyClient has. There is no `write`
      to reach for even by accident. */
// @ts-expect-error — property 'write' does not exist on ReadOnlyClient.
export const d = () => read.write;
