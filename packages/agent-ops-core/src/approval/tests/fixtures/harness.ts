import {
  createAudit,
  inMemoryTraceStore,
  redactFields,
  type Audit,
  type Clock,
  type CorrelationId,
  type TraceStore,
} from "../../../audit/index.js";
import {
  DEFAULT_LIMITS,
  createApproval,
  defineDecisionPoint,
  inMemoryApprovalStore,
  type Approval,
  type ApprovalStore,
  type AnyDecisionPoint,
  type AuthorityDirectory,
  type AuthorityId,
  type AuthorityPoolId,
  type BriefRenderer,
  type ClientFactory,
  type EscalationLadder,
  type HumanAuthority,
  type KillSwitchState,
  type Limits,
  type PolicyFacts,
  type Reminder,
  type ReservedPolicy,
  type ReservedStatus,
  type ServedBrief,
  type Tier,
  type TierPolicy,
} from "../../index.js";
import type { AlertRaiser, ComponentId, Heartbeat } from "../../../alerts/index.js";

/**
 * Adapters for the whole module, all in memory.
 *
 * These make the tests hermetic **structurally**: there is no model client, no
 * HTTP client, no database handle and no real clock reachable from a decision
 * point, so these tests cannot touch a network with live credentials sitting in
 * the environment.
 *
 * What they are **not** is "the second adapters that make the seams real". They
 * are private test files, not exported from `index.ts`, and by this project's
 * own standard — where the in-memory store and the in-memory client factory are
 * shipped deliverables — that makes these mocks. The honest seam accounting is
 * in `index.ts`, and it does not count these.
 */

export const CASE = (id: string): CorrelationId => id as CorrelationId;
export const POOL = "ap-approvers" as AuthorityPoolId;

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export const fakeClock = (start: number): FakeClock => {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    set: (ms) => {
      now = ms;
    },
  };
};

/**
 * Evidence answers, keyed by query ref. The client can only read; there is no
 * write method on the object it hands to `decide`, so an `any`-typed handler
 * reaching for one gets a `TypeError` rather than a payment.
 */
export const clientFactory = (
  evidence: Readonly<Record<string, unknown>> = {},
  writes: string[] = [],
): ClientFactory => ({
  readOnly: () => ({
    read: async (query) => evidence[query.ref] as never,
  }),
  writeCapable: () => ({
    read: async (query) => evidence[query.ref] as never,
    write: async (command) => {
      writes.push(`${command.kind}:${command.idempotencyKey}`);
      return { reference: `ref_${writes.length}` } as never;
    },
  }),
});

export const tierBy = (map: Readonly<Record<string, Tier>>, version = "tier-2026-08"): TierPolicy => ({
  version,
  classify: (facts: PolicyFacts) => map[String(facts["kind"] ?? "default")] ?? "low",
});

export const reservedBy = (
  decide: (facts: PolicyFacts) => ReservedStatus,
  version = "reserved-2026-08",
): ReservedPolicy => ({ version, screen: decide });

/** The default: an explicit, versioned assertion that no rule matched. */
export const neverReserved = (version = "reserved-2026-08"): ReservedPolicy =>
  reservedBy(
    () => ({
      reserved: false,
      basis: "no rule in the declared reserved list matches these facts",
      policyVersion: version,
    }),
    version,
  );

export const alwaysReserved = (version = "reserved-2026-08"): ReservedPolicy =>
  reservedBy(
    () => ({
      reserved: true,
      rule: "PSR-2017-reg-90",
      citation: "Payment Services Regulations 2017, reg. 90",
      policyVersion: version,
    }),
    version,
  );

export const human = (id: string, role = "ap-approver"): HumanAuthority => ({
  kind: "human",
  id: id as AuthorityId,
  role,
});

export const directory = (members: readonly HumanAuthority[]): AuthorityDirectory => ({
  candidates: async ({ excluding }) =>
    members.filter((m) => !excluding.includes(m.id)),
  resolve: async (ref) =>
    ref.kind === "authority" ? members.filter((m) => m.id === ref.id) : members,
});

export interface RecordingRenderer extends BriefRenderer {
  readonly presented: { brief: ServedBrief; to: readonly HumanAuthority[] }[];
  readonly reminders: { reminder: Reminder; to: readonly HumanAuthority[] }[];
  failNextRemind(): void;
  failNextPresent(): void;
}

export const recordingRenderer = (): RecordingRenderer => {
  const presented: { brief: ServedBrief; to: readonly HumanAuthority[] }[] = [];
  const reminders: { reminder: Reminder; to: readonly HumanAuthority[] }[] = [];
  let failOnce = false;
  let failPresentOnce = false;
  return {
    presented,
    reminders,
    failNextRemind: () => {
      failOnce = true;
    },
    failNextPresent: () => {
      failPresentOnce = true;
    },
    present: async (brief, to) => {
      if (failPresentOnce) {
        failPresentOnce = false;
        throw new Error("channel unavailable");
      }
      presented.push({ brief, to });
    },
    remind: async (reminder, to) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("channel unavailable");
      }
      reminders.push({ reminder, to });
    },
  };
};

export const ladder = (overrides: Partial<EscalationLadder> = {}): EscalationLadder => ({
  steps: [
    { after: 4 * 3_600_000, action: "notify", to: { kind: "pool", pool: POOL } },
    { after: 24 * 3_600_000, action: "escalate", to: { kind: "pool", pool: POOL } },
  ],
  recurrence: {
    every: 24 * 3_600_000,
    widenTo: [
      { kind: "authority", id: "auth_deputy" as AuthorityId },
      { kind: "authority", id: "auth_manager" as AuthorityId },
      { kind: "authority", id: "auth_exec" as AuthorityId },
    ],
  },
  ...overrides,
});

export interface Harness {
  readonly approval: Approval;
  readonly audit: Audit;
  readonly traceStore: TraceStore;
  readonly store: ApprovalStore;
  readonly clock: FakeClock;
  readonly renderer: RecordingRenderer;
  readonly writes: string[];
  /** Rebuild the runtime from the SAME durable stores, discarding this one. */
  readonly restart: (overrides?: Partial<HarnessOptions>) => Harness;
}

export interface HarnessOptions {
  readonly points: readonly AnyDecisionPoint[];
  /**
   * Replaces the whole directory. Used to model a directory that *lies* about
   * identity — the only condition under which `DualControlSelfApproval` is
   * still reachable, now that distinctness is enforced by the offered set.
   */
  readonly authorities?: AuthorityDirectory;
  /** Replaces the durable store. Used to model a store that loses a race. */
  readonly store?: ApprovalStore;
  /** Replaces the trace store. Used to count replays, so a bound is measured. */
  readonly traceStore?: TraceStore;
  readonly tierPolicy?: TierPolicy;
  readonly reservedPolicy?: ReservedPolicy;
  readonly members?: readonly HumanAuthority[];
  readonly killSwitch?: () => Promise<KillSwitchState>;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly limits?: Partial<Limits>;
  readonly startAt?: number;
  readonly sweeperId?: string;
  /**
   * Where the five silent conditions go.
   *
   * A test may only ever pass an in-memory `Alerts` built over
   * `recordingAlertSink`. That is not a convention it is trusted to keep: the
   * `alerts` module constructs no transport and reads no environment, so there
   * is no code path from this package to a pager for a test to reach even with
   * live credentials present. Hermeticism is a fact about the call graph here.
   */
  readonly alerting?: AlertRaiser;
  readonly heartbeat?: Heartbeat;
  readonly sweeperComponent?: ComponentId;
}

const buildOn = (
  options: HarnessOptions,
  baseTraceStore: TraceStore,
  baseStore: ApprovalStore,
  clock: FakeClock,
  renderer: RecordingRenderer,
  writes: string[],
): Harness => {
  const store = options.store ?? baseStore;
  const traceStore = options.traceStore ?? baseTraceStore;
  const audit = createAudit({
    store: traceStore,
    clock,
    // Deny-list redaction: the trace never carries a raw account reference.
    redact: redactFields(["toAccount", "accountRef"]),
    onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "degrade" },
  });
  const approval = createApproval({
    audit,
    points: options.points,
    store,
    tierPolicy: options.tierPolicy ?? tierBy({}),
    reservedPolicy: options.reservedPolicy ?? neverReserved(),
    authorities:
      options.authorities ??
      directory(options.members ?? [human("auth_jane"), human("auth_ravi"), human("auth_deputy")]),
    renderer,
    clients: clientFactory(options.evidence ?? {}, writes),
    killSwitch: options.killSwitch ?? (async () => ({ engaged: false })),
    clock,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    sweeperId: options.sweeperId ?? "sweeper-a",
    alerting: options.alerting,
    heartbeat: options.heartbeat,
    sweeperComponent: options.sweeperComponent,
  });
  return {
    approval,
    audit,
    traceStore,
    store,
    clock,
    renderer,
    writes,
    restart: (overrides) =>
      // A NEW runtime over the SAME durable stores. Everything held in memory
      // by the old one is gone; if a case survives this, it survived a deploy.
      buildOn({ ...options, ...overrides }, baseTraceStore, baseStore, clock, renderer, writes),
  };
};

export const harness = (options: HarnessOptions): Harness =>
  buildOn(
    options,
    inMemoryTraceStore(),
    inMemoryApprovalStore(),
    fakeClock(options.startAt ?? 1_700_000_000_000),
    recordingRenderer(),
    [],
  );

export { defineDecisionPoint };
