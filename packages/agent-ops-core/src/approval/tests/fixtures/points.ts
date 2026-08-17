import {
  defineDecisionPoint,
  type AuthorityId,
  type DecisionPoint,
  type EffectDeclaration,
  type EscalationLadder,
} from "../../index.js";
import { POOL, ladder as defaultLadder } from "./harness.js";

/**
 * What a decision cost. Required on every `Determination`: C2 asks for cost,
 * tokens, latency and the price-table version per node, and an optional field
 * would be absent on exactly the decisions nobody instrumented.
 */
const MODEL_SPEND = {
  costTenthCents: 412,
  tokensIn: 3_180,
  tokensOut: 240,
  priceTableVersion: "prices-2026-08",
} as const;

/** Invoice approval, one of the nineteen. Money in minor units, always. */
export interface Invoice {
  readonly id: string;
  readonly amountMinor: number;
  readonly supplier: string;
  readonly account: string;
}

export interface Disbursement {
  readonly amountMinor: number;
  readonly currency: string;
  readonly fromAccount: string;
  readonly toAccount: string;
}

export const disburse = (
  execute?: EffectDeclaration<Disbursement>["execute"],
): EffectDeclaration<Disbursement> => ({
  kind: "disburse",
  schemaVersion: 2,
  // Non-optional. The trace never carries the raw destination account.
  redact: (p) => ({
    amountMinor: p.amountMinor,
    currency: p.currency,
    fromAccount: p.fromAccount,
    toAccountDigest: `sha_${p.toAccount.length}`,
  }),
  execute:
    execute ??
    (async (licence, client, payload) => {
      await client.write({
        kind: "ledger.debit",
        idempotencyKey: licence.idempotencyKey,
        payload: { amountMinor: payload.amountMinor },
      });
      return { kind: "done", reference: `pay_${payload.amountMinor}` };
    }),
});

/** A gated, dual-controlled disbursement. The tail this module exists for. */
export const gatedDisbursement = (options: {
  readonly ladder?: EscalationLadder;
  readonly expireAfter?: number;
  readonly dualControlAtOrAbove?: "low" | "medium" | "high" | "never";
  readonly execute?: EffectDeclaration<Disbursement>["execute"];
  readonly id?: string;
} = {}): DecisionPoint<Invoice, { readonly pay: true }, Disbursement> =>
  defineDecisionPoint({
    id: options.id ?? "invoices.disburse_payment",
    schemaVersion: 3,
    gate: "human",
    maxTier: "high",
    pool: POOL,
    dualControlAtOrAbove: options.dualControlAtOrAbove ?? "high",
    licenceValidFor: 24 * 3_600_000,
    tierFacts: (invoice) => ({ kind: "disburse", moneyAtRiskMinor: invoice.amountMinor }),
    reservedFacts: (invoice) => ({ kind: "disburse", supplier: invoice.supplier }),
    decide: async (client, invoice) => {
      const po = await client.read<{ matched: boolean }>({
        kind: "purchase-order",
        ref: invoice.id,
      });
      return {
        kind: "concluded",
        verdict: { pay: true },
        confidenceBasisPoints: po.matched ? 9_700 : 7_100,
        evidence: [{ kind: "purchase-order", ref: invoice.id }],
        spend: MODEL_SPEND,
        proposes: {
          payload: {
            amountMinor: invoice.amountMinor,
            currency: "GBP",
            fromAccount: "8812",
            toAccount: invoice.account,
          },
        },
      };
    },
    effect: disburse(options.execute),
    doNothing: {
      ladder: options.ladder ?? defaultLadder(),
      ...(options.expireAfter === undefined
        ? {}
        : {
            expire: {
              after: options.expireAfter,
              then: { kind: "refuse", reason: "no approver answered within the window" },
            },
          }),
    },
    brief: ({ verdict, confidenceBasisPoints, evidence }) => ({
      effectInConcreteTerms: "£47,200 leaves account 8812 today.",
      concluded: {
        statement: `Invoice matches purchase order. pay=${String(verdict.pay)}.`,
        evidence: [evidence[0] ?? { kind: "purchase-order", ref: "unknown" }],
      },
      unsureAbout:
        confidenceBasisPoints < 9_000
          ? [
              {
                kind: "open-question",
                question: "Line 4 unit price is 11% above the purchase-order rate.",
                why: "Rate card returned two rates for this stock code.",
              },
            ]
          : [
              {
                kind: "nothing-material",
                because: "Purchase order matched on all lines.",
              },
            ],
      // Never an empty array: an assertion about a search that was performed.
      contrary: {
        searchedAndFoundNone: {
          searched: "payments to this supplier within 5% of this amount, last 90 days",
        },
      },
      couldNotCheck: {
        items: [
          {
            what: "Supplier bank account ownership",
            why: "Account verification provider returned 503 at 09:14 and 09:17.",
          },
        ],
      },
    }),
  });

/** The common caller: no effect, no gate, no brief. Still fully traced. */
export const extraction = (): DecisionPoint<Invoice, string, never> =>
  defineDecisionPoint({
    id: "invoices.extract_fields",
    schemaVersion: 1,
    gate: "never",
    maxTier: "low",
    effect: { kind: "no-effect" },
    tierFacts: () => ({ kind: "extract", moneyAtRiskMinor: 0 }),
    reservedFacts: () => ({ kind: "extract" }),
    decide: async (_client, invoice) => ({
      kind: "concluded",
      verdict: invoice.supplier,
      confidenceBasisPoints: 9_900,
      evidence: [{ kind: "document", ref: invoice.id }],
      spend: MODEL_SPEND,
      proposes: null,
    }),
  });

/** An ungated point that still takes an effect, under a NAMED delegation. */
export const delegatedDisbursement = (
  execute?: EffectDeclaration<Disbursement>["execute"],
): DecisionPoint<Invoice, { readonly pay: true }, Disbursement> =>
  defineDecisionPoint({
    id: "invoices.disburse_small",
    schemaVersion: 1,
    gate: "never",
    maxTier: "low",
    tierFacts: () => ({ kind: "small", moneyAtRiskMinor: 500 }),
    reservedFacts: (invoice) => ({ kind: "small", supplier: invoice.supplier }),
    decide: async (_client, invoice) => ({
      kind: "concluded",
      verdict: { pay: true },
      confidenceBasisPoints: 9_900,
      evidence: [{ kind: "document", ref: invoice.id }],
      spend: MODEL_SPEND,
      proposes: {
        payload: {
          amountMinor: invoice.amountMinor,
          currency: "GBP",
          fromAccount: "8812",
          toAccount: invoice.account,
        },
      },
    }),
    effect: {
      kind: "delegated",
      declaration: disburse(execute),
      delegation: {
        as: "auth_ap_bot" as AuthorityId,
        delegatedBy: "auth_controller" as AuthorityId,
        delegationRef: "DEL-2026-14",
        grantedAt: 1_690_000_000_000,
      },
      licenceValidFor: 3_600_000,
    },
  });

export const INVOICE: Invoice = {
  id: "inv_88213",
  amountMinor: 4_720_000,
  supplier: "acme-ltd",
  account: "GB29NWBK60161331926819",
};
