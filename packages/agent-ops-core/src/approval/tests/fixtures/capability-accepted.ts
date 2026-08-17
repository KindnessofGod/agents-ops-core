/**
 * The control. A correctly declared decision point must still compile, or the
 * constraint above is proving nothing more interesting than "this file does not
 * build".
 */
import type { Determination, EscalationLadder, UngatedSpec } from "../../index.js";

export const spec: UngatedSpec<{ id: string }, string, never> = {
  id: "invoices.extract_fields",
  schemaVersion: 1,
  gate: "never",
  maxTier: "low",
  effect: { kind: "no-effect" },
  tierFacts: () => ({ moneyAtRiskMinor: 0 }),
  reservedFacts: () => ({ counterpartyCountry: "GB" }),
  decide: async (client, input) => {
    const fields = await client.read<{ value: string }>({
      kind: "extraction",
      ref: input.id,
    });
    return {
      kind: "concluded",
      verdict: fields.value,
      confidenceBasisPoints: 9_700,
      evidence: [{ kind: "document", ref: input.id }],
      spend: { costTenthCents: 0, tokensIn: 0, tokensOut: 0, priceTableVersion: "none" },
      proposes: null,
    } satisfies Determination<string, never>;
  },
};

export const ladder: EscalationLadder = {
  steps: [
    { after: 3_600_000, action: "notify", to: { kind: "pool", pool: "ap" as never } },
    { after: 14_400_000, action: "escalate", to: { kind: "pool", pool: "ap-leads" as never } },
  ],
  recurrence: {
    every: 86_400_000,
    widenTo: [
      { kind: "pool", pool: "ap-leads" as never },
      { kind: "authority", id: "auth_cfo" as never },
    ],
  },
};
