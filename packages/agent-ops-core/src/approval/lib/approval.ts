import type { CorrelationId, NodeId, PayloadField, RiskTier } from "../../audit/index.js";
import { canonicalJson, digest } from "./canonical.js";
import {
  AdapterFailed,
  ApprovalError,
  AuthorityNotOffered,
  AuthorityUnavailable,
  DualControlSelfApproval,
  EffectAlreadyInFlight,
  EffectDeclarationDrifted,
  GateDeclarationChanged,
  IdempotencyIndeterminate,
  KillSwitchUnreadable,
  LicenceExpired,
  PointSchemaChanged,
  ReservedDelegationAttempt,
  ReservedFactsEmpty,
  ReservedStepMisdeclared,
  SuspensionAlreadySettled,
  SuspensionNotFound,
  SuspensionRaceLost,
  TierCeilingExceeded,
  TraceNodeNotRecorded,
  UnknownDecisionPoint,
} from "./errors.js";
import { assertLadderSound, becomesBuried, firingAt, nextDueAt } from "./ladder.js";
import { parentIndexes, recorderFor, type Recorder } from "./recorder.js";
import type {
  AnsweringContext,
  Approval,
  ApprovalDeps,
  ApprovalRecord,
  ApproverAnswer,
  Authority,
  AuthorityId,
  BriefBody,
  DecisionPoint,
  DecisionSpend,
  Determination,
  DoNothingConsequence,
  EffectDeclaration,
  EffectOutcome,
  EscalationLadder,
  GatedSpec,
  HumanAuthority,
  IdempotencyKey,
  Instant,
  Licence,
  NonEmpty,
  PolicyFacts,
  ReservedStatus,
  RunContext,
  SealedAnswer,
  ServedBrief,
  ServedDoNothing,
  Settled,
  Suspended,
  SuspensionId,
  SuspensionRecord,
  SweepReport,
  Tier,
} from "./types.js";

/**
 * The phase machine. Nothing in here is reachable from outside the module.
 *
 * Ordering is strictly classify → screen → decide → authorise → execute, and it
 * is internal, so an effect executing before its authorisation is not something
 * a caller can get wrong — there is no call for them to make in the wrong
 * order.
 *
 * Where the auditability guarantee actually stops, stated here rather than in a
 * document that will drift from the code:
 *
 *   - Everything this module mediates is recorded, and skipping it is not
 *     expressible: `run`, `answer` and `sweep` write a node at every phase they
 *     cross, and there is no way to enter a phase except through them. That now
 *     includes **every failure of every injected adapter**: each one is wrapped,
 *     recorded and re-raised as a named `AdapterFailed`, so a policy or a
 *     `decide` body that throws leaves an error node rather than a trace that
 *     simply stops.
 *   - **A `decide` body is application code holding its own closure.** It can
 *     `fetch()` or call a treasury client it captured, and no type reaches
 *     outside this library's surface to stop it. The honest claim is
 *     "unrecorded execution is unrepresentable **through this module's own
 *     seams**", not "unrecorded execution is unrepresentable". Every node this
 *     module writes carries `capturedVia: "declared-seams-only"` so a reader in
 *     2033 learns the scope of the evidence from the evidence.
 *   - **One failure cannot be recorded, and it is named here rather than
 *     hidden**: if `audit.open` itself throws there is no trace to write the
 *     failure to. It surfaces as `AdapterFailed("audit")` and nothing else.
 *     Every other adapter failure has a node.
 *   - A sweeper's own lifecycle is not in any trace, because a trace is
 *     per-case and a sweep spans many. Each *firing* is recorded on the case it
 *     belongs to.
 *   - Telemetry is recorded on every node: `costTenthCents`, `tokensIn`,
 *     `tokensOut`, `priceTableVersion` and `elapsedUs`. The module spends
 *     nothing itself and stamps zeroes, which is a statement rather than a
 *     silence; the `approval.decided` and `approval.abstained` nodes carry the
 *     spend the decision point declared. `elapsedUs` is derived from the
 *     injected clock, whose resolution is one millisecond — recorded alongside
 *     it as `clockResolutionUs` rather than implied by suspiciously round
 *     numbers.
 */

const TIER_ORDER: Record<Tier, number> = { low: 0, medium: 1, high: 2 };

/** Stamped on every node this module writes. See the scope note above. */
const CAPTURED_VIA = "declared-seams-only";

/**
 * Node payload schema version.
 *
 * 2 — telemetry fields added to every node; free human text and adapter error
 * text replaced by `*Digest`/`*Chars` pairs; policy fact string values
 * digested. Fields were added and one class of field stopped being written;
 * nothing was retyped or re-meaninged, and a v1 node still parses.
 */
const NODE_V = 2;

/** What the module itself spends. Nothing: it calls no model and no provider. */
const MODULE_SPEND: DecisionSpend = {
  costTenthCents: 0,
  tokensIn: 0,
  tokensOut: 0,
  priceTableVersion: "none",
};

/** The injected clock is millisecond-resolution, so every latency is too. */
const CLOCK_RESOLUTION_US = 1_000;

type Fields = Readonly<Record<string, PayloadField | undefined>>;

/**
 * What a call site writes. `v`, `capturedVia`, the telemetry fields and
 * `elapsedUs` are added by the writer rather than by every call site, so a node
 * cannot be written without any of them.
 */
type Draft = Fields & { readonly kind: string };

/**
 * Free text, as evidence that text existed rather than as a copy of it.
 *
 * Approver reasons, adapter error messages and executor failure strings are all
 * uncontrolled human or third-party text. Written verbatim they carry names,
 * dates of birth, telephone numbers, account references and live API keys into
 * a seven-year append-only archive with no un-writing, which C2 forbids and
 * which no deny-list redactor can catch in free prose.
 *
 * So the trace records the digest and the length. An auditor holding a
 * candidate string can prove it is the one that was written; nobody reading the
 * trace can learn a string that was not already known to them. The text itself
 * lives where it belongs: an approver's reason in the suspension record under
 * the application's own retention, an adapter's message on the raised error's
 * `cause` for the operator holding the exception.
 */
const textFields = (prefix: string, text: string): Fields => ({
  [`${prefix}Digest`]: digest(text),
  [`${prefix}Chars`]: text.length,
});

const causeClassOf = (cause: unknown): string =>
  cause instanceof Error ? cause.name : `non-error:${typeof cause}`;

const causeTextOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Class name plus digest. Never the message. Safe to put in an error message. */
const causeRef = (cause: unknown): string =>
  `${causeClassOf(cause)}#${digest(causeTextOf(cause))}`;

const causeFields = (prefix: string, cause: unknown): Fields => ({
  [`${prefix}Class`]: causeClassOf(cause),
  ...textFields(prefix, causeTextOf(cause)),
});

/**
 * Policy facts, flattened onto the classification node with a prefix. Payloads
 * are flat by `audit`'s rule: nesting needs canonical rules for array order and
 * key collision, and every one of those is a place a 2033 reader can be misled.
 *
 * **Fact keys are recorded verbatim; string fact values are recorded as
 * digests.** A key is a name chosen by the decision point's author and is part
 * of the declaration. A value is application data pulled off a case, and
 * `supplier`, `memberName` and `accountRef` are all perfectly ordinary fact
 * names. Integers and booleans are written as they are, because the amount of
 * money at risk is the thing tiering is *about* and has to stay legible.
 */
const factsPayload = (prefix: string, facts: PolicyFacts): Fields => {
  const out: Record<string, PayloadField> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (typeof value === "string") {
      out[`${prefix}_${key}`] = `digest:${digest(value)}`;
      out[`${prefix}_${key}_chars`] = value.length;
    } else {
      out[`${prefix}_${key}`] = value;
    }
  }
  return out;
};

const factKeysOf = (facts: PolicyFacts): string => Object.keys(facts).sort().join(",");

const reservedPayload = (reserved: ReservedStatus): Fields =>
  reserved.reserved
    ? {
        reserved: true,
        rule: reserved.rule,
        citation: reserved.citation,
        policyVersion: reserved.policyVersion,
      }
    : {
        reserved: false,
        basis: reserved.basis,
        policyVersion: reserved.policyVersion,
      };

declare const LICENCE_TAG: unique symbol;

const mintLicence = (
  correlationId: CorrelationId,
  node: NodeId,
  idempotencyKey: IdempotencyKey,
  approvals: NonEmpty<ApprovalRecord>,
  expiresAt: Instant,
): Licence =>
  // The only place a licence comes into existence. The brand is a
  // non-exported unique symbol, so no external object literal satisfies the
  // type, and there is no public `execute` to hand a forged one to.
  Object.freeze({
    correlationId,
    node,
    idempotencyKey,
    approvals,
    expiresAt,
  }) as unknown as Licence & { readonly [LICENCE_TAG]?: never };

/**
 * Writes nodes for one entry-point invocation.
 *
 * It exists so that `v`, `capturedVia`, the four telemetry fields and
 * `elapsedUs` are impossible to omit: there is no other way to reach the
 * recorder from the phase machine.
 */
interface Writer {
  readonly write: (payload: Draft, parent?: NodeId) => Promise<NodeId>;
  readonly at: (tier: RiskTier) => Writer;
}

export const createApproval = (deps: ApprovalDeps): Approval => {
  const {
    audit,
    store,
    tierPolicy,
    reservedPolicy,
    authorities,
    renderer,
    clients,
    killSwitch,
    clock,
    limits,
    sweeperId,
  } = deps;

  const registry = new Map(deps.points.map((point) => [point.id, point]));
  const indexes = parentIndexes(limits.parentIndexCases);

  const writerOn = (recorder: Recorder, startedAt: Instant): Writer => ({
    async write(payload, parent) {
      const node = await recorder.record(
        {
          ...MODULE_SPEND,
          ...payload,
          elapsedUs: (clock.now() - startedAt) * 1_000,
          clockResolutionUs: CLOCK_RESOLUTION_US,
          v: NODE_V,
          capturedVia: CAPTURED_VIA,
        },
        parent,
      );
      return node.id;
    },
    at: (tier) => writerOn(recorder.at(tier), startedAt),
  });

  /**
   * Open a writer for a case. The one adapter failure with nowhere to be
   * recorded, named in the scope note above.
   */
  const openWriter = async (correlationId: CorrelationId, tier: Tier): Promise<Writer> => {
    const startedAt = clock.now();
    try {
      return writerOn(await recorderFor(audit, correlationId, tier, indexes), startedAt);
    } catch (cause) {
      if (cause instanceof ApprovalError) throw cause;
      throw new AdapterFailed("audit", cause, causeClassOf(cause));
    }
  };

  /* --------------------------------------------------------- adapter seams */

  /**
   * Every call into an injected adapter goes through here.
   *
   * **Fail-closed, and recorded before it is raised.** Before this existed, a
   * `tierPolicy` that threw left a trace containing `approval.run` and nothing
   * else, and a `decide` that threw left one ending at `approval.deciding` —
   * fifteen module-raised errors were named and zero adapter-raised ones were.
   */
  const guard = async <T>(
    writer: Writer,
    parent: NodeId | undefined,
    seam: string,
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (cause) {
      // Our own errors are already recorded at the site that raised them, and
      // a trace-write failure has nowhere to be recorded by definition.
      if (cause instanceof TraceNodeNotRecorded) throw cause;
      if (cause instanceof ApprovalError) throw cause;
      const failure = new AdapterFailed(seam, cause, causeClassOf(cause));
      await writer.write(
        {
          kind: "approval.adapter-failed",
          seam,
          error: failure.name,
          fatal: true,
          alert: true,
          incident: failure.incident,
          ...causeFields("cause", cause),
        },
        parent,
      );
      throw failure;
    }
  };

  /**
   * The two seams where a failure is **not** fatal: reaching an approver.
   *
   * Failing to deliver a brief or a reminder leaves the case suspended and the
   * ladder running, because failing to chase somebody is not a reason to stop
   * chasing them. Recorded, alerted, and retried on the next sweep.
   */
  const guardSoft = async <T>(
    writer: Writer,
    parent: NodeId | undefined,
    seam: string,
    fn: () => T | Promise<T>,
  ): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> => {
    try {
      return { ok: true, value: await fn() };
    } catch (cause) {
      if (cause instanceof TraceNodeNotRecorded) throw cause;
      await writer.write(
        {
          kind: "approval.adapter-failed",
          seam,
          error: new AdapterFailed(seam, cause, causeClassOf(cause)).name,
          fatal: false,
          alert: true,
          incident: false,
          ...causeFields("cause", cause),
        },
        parent,
      );
      return { ok: false };
    }
  };

  const deriveIdempotencyKey = (
    correlationId: CorrelationId,
    pointId: string,
    pointSchemaVersion: number,
    effectKind: string,
    effectSchemaVersion: number,
    redacted: unknown,
  ): IdempotencyKey =>
    `idm_${digest(
      canonicalJson({
        correlationId,
        pointId,
        pointSchemaVersion,
        effectKind,
        effectSchemaVersion,
        redacted,
      }),
    )}` as IdempotencyKey;

  const deriveSuspensionId = (
    correlationId: CorrelationId,
    pointId: string,
    key: IdempotencyKey,
  ): SuspensionId =>
    `sus_${digest(canonicalJson({ correlationId, pointId, key }))}` as SuspensionId;

  /* ------------------------------------------------------------- executing */

  const executeEffect = async <P>(
    writer: Writer,
    correlationId: CorrelationId,
    pointId: string,
    parent: NodeId,
    declaration: EffectDeclaration<P>,
    payload: P,
    idempotencyKey: IdempotencyKey,
    approvals: NonEmpty<ApprovalRecord>,
    licenceExpiresAt: Instant,
  ): Promise<
    | { readonly outcome: EffectOutcome; readonly node: NodeId }
    | { readonly held: NodeId; readonly reason: string }
  > => {
    // The kill switch is read HERE — at execute, never at classify. A killed
    // run still records its whole decision, which is the point: the evidence of
    // what the system would have done during the incident is preserved.
    let engaged = true;
    let heldReason = "kill-switch";
    let killPayload: Draft = {
      kind: "approval.kill-switch-read",
      engaged: true,
      readable: false,
    };
    try {
      const state = await killSwitch();
      engaged = state.engaged;
      killPayload = state.engaged
        ? {
            kind: "approval.kill-switch-read",
            engaged: true,
            readable: true,
            scope: state.scope,
            by: state.by,
            at: state.at,
          }
        : { kind: "approval.kill-switch-read", engaged: false, readable: true };
    } catch (cause) {
      // Fail-closed: an unreadable kill switch is treated as engaged. Cheap;
      // the alternative is paying during an incident.
      //
      // The error is CONSTRUCTED and recorded rather than thrown, and the
      // reason it was unreadable goes onto the node instead of being discarded
      // by a bare `catch {}`. The caller can tell the two apart: `held` for a
      // switch that was read and engaged, `kill-switch-unreadable` for one that
      // could not be read at all.
      const failure = new KillSwitchUnreadable(causeRef(cause), cause);
      engaged = true;
      heldReason = "kill-switch-unreadable";
      killPayload = {
        kind: "approval.kill-switch-read",
        engaged: true,
        readable: false,
        error: failure.name,
        ...causeFields("cause", cause),
      };
    }
    const killNode = await writer.write(killPayload, parent);
    if (engaged) return { held: killNode, reason: heldReason };

    const now = clock.now();
    const licenceNode = await writer.write(
      {
        kind: "approval.licence-minted",
        idempotencyKey,
        approvals: approvals.length,
        expiresAt: licenceExpiresAt,
        validForMs: licenceExpiresAt - now,
        effectKind: declaration.kind,
        effectSchemaVersion: declaration.schemaVersion,
      },
      killNode,
    );
    const licence = mintLicence(
      correlationId,
      licenceNode,
      idempotencyKey,
      approvals,
      licenceExpiresAt,
    );

    const claimed = await guard(writer, licenceNode, "store.claimIdempotency", () =>
      store.claimIdempotency(idempotencyKey, correlationId, now, limits.idempotencyLeaseMs),
    );
    const claim = claimed.claim;

    if (!claimed.claimed) {
      if (claim.state === "settled" && claim.outcome !== null) {
        // Not an error. A repeat returns the original outcome; it does not
        // re-execute and does not throw.
        const node = await writer.write(
          {
            kind: "effect.idempotent-replay",
            idempotencyKey,
            outcome: claim.outcome.kind,
          },
          licenceNode,
        );
        return { outcome: claim.outcome, node };
      }

      if (claim.state === "unknown" && claim.leaseUntil <= now) {
        // The lease is released, so nobody is holding this call: it really is
        // in doubt. Recorded under its own kind because this attempt did not
        // create the ambiguity, it ran into it.
        await writer.write(
          {
            kind: "effect.blocked-in-doubt",
            idempotencyKey,
            autoRetried: false,
            alert: true,
            incident: true,
          },
          licenceNode,
        );
        throw new IdempotencyIndeterminate(idempotencyKey, "claim already in doubt");
      }

      // Somebody else is holding a live lease — either `not-attempted` between
      // the claim and the call, or `unknown` with the outbound call actually in
      // flight right now. A double-clicked approve button, not a reconciliation
      // incident. It becomes in-doubt if and when the lease runs out, which is
      // the bound on how long "wait and retry" stays the right advice.
      await writer.write(
        {
          kind: "effect.already-in-flight",
          idempotencyKey,
          claimState: claim.state,
          leaseUntil: claim.leaseUntil,
          alert: false,
          incident: false,
        },
        licenceNode,
      );
      throw new EffectAlreadyInFlight(idempotencyKey);
    }

    if (claimed.reclaimed) {
      // Only ever reachable from `not-attempted`: no outbound call was made,
      // so re-executing is safe. An expired lease in `unknown` is never
      // reclaimed, at any age.
      await writer.write(
        {
          kind: "effect.claim-reclaimed",
          idempotencyKey,
          fromState: "not-attempted",
        },
        licenceNode,
      );
    }

    // The claim moves to `unknown` BEFORE the outbound call. If this process
    // dies mid-call, what survives says "we may have paid" rather than "we
    // never tried" — and the difference is the whole point of three states.
    await guard(writer, licenceNode, "store.settleIdempotency", () =>
      store.settleIdempotency(idempotencyKey, {
        ...claim,
        state: "unknown",
        reason: "outbound call in flight",
      }),
    );
    const attemptNode = await writer.write(
      { kind: "effect.attempting", idempotencyKey, effectKind: declaration.kind },
      licenceNode,
    );

    const client = clients.writeCapable({ correlationId, node: attemptNode, pointId });
    let outcome: EffectOutcome;
    try {
      outcome = await declaration.execute(licence, client, payload);
    } catch (cause) {
      // The claim stays `unknown`. No retry, at any tier, ever. It goes to a
      // human with the trace attached.
      // The lease is RELEASED with it: this caller is no longer holding the
      // call, so a later attempt sees a genuine in-doubt rather than "somebody
      // is mid-flight". It is still never auto-retried.
      await store.settleIdempotency(idempotencyKey, {
        ...claim,
        state: "unknown",
        leaseUntil: clock.now(),
        reason: causeRef(cause),
      });
      await writer.write(
        {
          kind: "effect.in-doubt",
          idempotencyKey,
          autoRetried: false,
          alert: true,
          incident: true,
          ...causeFields("cause", cause),
        },
        attemptNode,
      );
      throw new IdempotencyIndeterminate(idempotencyKey, causeRef(cause));
    }

    if (outcome.kind === "done") {
      await store.settleIdempotency(idempotencyKey, { ...claim, state: "settled", outcome });
      const node = await writer.write(
        { kind: "effect.done", idempotencyKey, ...textFields("reference", outcome.reference) },
        attemptNode,
      );
      return { outcome, node };
    }

    if (outcome.kind === "not-attempted") {
      // The executor asserts nothing happened, so the claim goes back and a
      // later retry is legitimate. This is the only path that reopens a claim,
      // and the lease is released with it — a claim nobody is holding must not
      // look like one somebody is.
      await store.settleIdempotency(idempotencyKey, {
        ...claim,
        state: "not-attempted",
        leaseUntil: clock.now(),
        reason: outcome.reason,
      });
      const node = await writer.write(
        { kind: "effect.not-attempted", idempotencyKey, ...textFields("reason", outcome.reason) },
        attemptNode,
      );
      return { outcome, node };
    }

    await store.settleIdempotency(idempotencyKey, {
      ...claim,
      state: "unknown",
      leaseUntil: clock.now(),
      reason: outcome.reason,
    });
    await writer.write(
      {
        kind: "effect.in-doubt",
        idempotencyKey,
        autoRetried: false,
        alert: true,
        incident: true,
        ...textFields("reason", outcome.reason),
      },
      attemptNode,
    );
    throw new IdempotencyIndeterminate(idempotencyKey, `executor reported unknown`);
  };

  /* ------------------------------------------------------------ suspending */

  const servedDoNothingFor = (
    declared: DoNothingConsequence,
    reserved: ReservedStatus,
  ): ServedDoNothing =>
    reserved.reserved
      ? // The expiry is DELETED, not overridden by configuration. A reserved
        // decision has no default to time out into: "nobody was on shift" is
        // not a lawful basis for an automated decision.
        { ladder: declared.ladder, expire: null }
      : { ladder: declared.ladder, expire: declared.expire ?? null };

  /**
   * Offer the brief, and report what was actually offered and when.
   *
   * The return value is the whole point. It becomes `offeredTo` and
   * `presentedAt` on the durable record, which is what `answer` authorises
   * against and what time-to-decision is measured from. An offer that did not
   * happen produces an empty set and a `null`, so nobody can answer a brief
   * they were never sent and no duration is invented for a presentation that
   * did not occur.
   */
  const presentTo = async (
    writer: Writer,
    brief: ServedBrief,
    pool: SuspensionRecord["pool"],
    reserved: boolean,
    excluding: readonly AuthorityId[],
    at: Instant,
    parent: NodeId,
  ): Promise<{
    readonly offeredTo: readonly AuthorityId[];
    readonly presentedAt: Instant | null;
  }> => {
    const looked = await guardSoft(writer, parent, "authorities.candidates", () =>
      authorities.candidates({ pool, excluding, reserved }),
    );
    if (!looked.ok) return { offeredTo: [], presentedAt: null };
    const candidates = looked.value;

    if (candidates.length === 0) {
      // Never fail-open. The case stays suspended, the ladder keeps running,
      // and — unlike before — the next sweep tries the offer again, so a
      // directory outage or an on-call gap at suspend time is a delay rather
      // than a brief that is never delivered at all.
      await writer.write(
        {
          kind: "approval.authority-unavailable",
          pool,
          reserved,
          alert: true,
          retriedOnNextSweep: true,
          error: new AuthorityUnavailable(pool, reserved).name,
        },
        parent,
      );
      return { offeredTo: [], presentedAt: null };
    }

    const delivered = await guardSoft(writer, parent, "renderer.present", () =>
      renderer.present(brief, candidates),
    );
    if (!delivered.ok) {
      await writer.write(
        {
          kind: "approval.brief-undelivered",
          pool,
          reserved,
          seat: brief.seat,
          candidates: candidates.length,
          alert: true,
          retriedOnNextSweep: true,
        },
        parent,
      );
      return { offeredTo: [], presentedAt: null };
    }

    await writer.write(
      {
        kind: "approval.brief-presented",
        seat: brief.seat,
        recipients: candidates.length,
        presentedAt: at,
        briefDigest: digest(canonicalJson(brief)),
        // Honest limit, recorded on the node rather than left to a wiki: this
        // is time since notification, not time on screen. A dashboard adapter
        // can narrow the gap by presenting lazily at first view; an email
        // adapter cannot.
        timeToDecisionMeasuredFrom: "notification",
      },
      parent,
    );
    return { offeredTo: candidates.map((c) => c.id), presentedAt: at };
  };

  /**
   * Write the offer onto the durable record.
   *
   * Deliberately a second write rather than part of the first: the suspension
   * becomes durable *before* the brief is offered, so a process dying between
   * the two leaves a case that is answerable-by-nobody and re-offered by the
   * next sweep, rather than an approver holding a brief for a suspension that
   * does not exist.
   */
  const commitOffer = async (
    writer: Writer,
    id: SuspensionId,
    offer: { readonly offeredTo: readonly AuthorityId[]; readonly presentedAt: Instant | null },
    parent: NodeId,
  ): Promise<void> => {
    if (offer.presentedAt === null && offer.offeredTo.length === 0) return;
    const fresh = await store.loadSuspension(id);
    if (fresh === undefined || fresh.state !== "awaiting") return;
    const swapped = await store.swapSuspension(id, fresh.revision, {
      ...fresh,
      offeredTo: offer.offeredTo,
      presentedAt: offer.presentedAt,
    });
    if (!swapped) {
      await writer.write(
        {
          kind: "approval.offer-not-committed",
          suspension: id,
          alert: true,
          retriedOnNextSweep: true,
        },
        parent,
      );
    }
  };

  const buildServedBrief = (
    core: {
      readonly suspension: SuspensionId;
      readonly correlationId: CorrelationId;
      readonly tier: Tier;
      readonly reserved: ReservedStatus;
      readonly doNothing: ServedDoNothing;
      readonly presentedAt: Instant;
      readonly body: BriefBody;
    },
    seat: "first" | "second",
    firstAnswer: SuspensionRecord["firstAnswer"],
  ): ServedBrief => {
    const common = {
      ...core.body,
      suspension: core.suspension,
      correlationId: core.correlationId,
      tier: core.tier,
      reserved: core.reserved,
      doNothing: core.doNothing,
      presentedAt: core.presentedAt,
    };
    if (seat === "first" || firstAnswer === null) return { ...common, seat: "first" };
    // Everything the second seat learns about the first. `AnswerReceipt` has no
    // outcome field, so the screen cannot render one — the exclusion is a
    // missing property, not a rule for whoever builds the screen.
    return {
      ...common,
      seat: "second",
      priorAnswer: { by: firstAnswer.by, at: firstAnswer.at, node: firstAnswer.node },
    };
  };

  /* ------------------------------------------------------------------ run */

  const run = async <In, V, P>(
    point: DecisionPoint<In, V, P>,
    input: In,
    ctx: RunContext,
  ): Promise<Settled<V> | Suspended> => {
    const spec = point.spec;
    // Nodes written before classification are stamped with the DECLARED
    // ceiling, which is the strongest consequence this point can carry and is
    // known without running anything. After classification the writer is
    // re-bound to the tier the policy actually assigned, so the case's tier
    // profile reads straight off the trace.
    let writer = await openWriter(ctx.correlationId, spec.maxTier);

    const runNode = await writer.write(
      {
        kind: "approval.run",
        pointId: spec.id,
        pointSchemaVersion: spec.schemaVersion,
        gate: spec.gate,
      },
      ctx.parent,
    );

    // classify — pure, no I/O, runs on every decision.
    const tierFacts = await guard(writer, runNode, "spec.tierFacts", () => spec.tierFacts(input));
    const tier = await guard(writer, runNode, "tierPolicy.classify", () =>
      tierPolicy.classify(tierFacts),
    );
    await writer.write(
      {
        kind: "approval.classified",
        tier,
        policyVersion: tierPolicy.version,
        maxTier: spec.maxTier,
        factCount: Object.keys(tierFacts).length,
        factKeys: factKeysOf(tierFacts),
        ...factsPayload("fact", tierFacts),
      },
      runNode,
    );
    writer = writer.at(tier);
    if (TIER_ORDER[tier] > TIER_ORDER[spec.maxTier]) {
      const error = new TierCeilingExceeded(spec.id, spec.maxTier, tier);
      await writer.write(
        { kind: "approval.halted", error: error.name, alert: true, incident: error.incident },
        runNode,
      );
      throw error;
    }

    // reserved screen — its OWN node, on its OWN seam, ALWAYS, including when
    // the answer is "not reserved". That node is the difference between "we
    // checked" and "nobody thought about it".
    const reservedFacts = await guard(writer, runNode, "spec.reservedFacts", () =>
      spec.reservedFacts(input),
    );
    if (Object.keys(reservedFacts).length === 0) {
      // Screening on nothing produces "no rule matched these facts" from an
      // empty fact set, and at the node — the only artefact an auditor has in
      // 2033 — that is byte-identical to a real screening. The type promises
      // those two cannot share a representation; this is what keeps the
      // promise at the artefact rather than only in TypeScript.
      const error = new ReservedFactsEmpty(spec.id);
      await writer.write(
        { kind: "approval.halted", error: error.name, alert: true, incident: error.incident },
        runNode,
      );
      throw error;
    }
    const reserved = await guard(writer, runNode, "reservedPolicy.screen", () =>
      reservedPolicy.screen(reservedFacts),
    );
    const screenNode = await writer.write(
      {
        ...reservedPayload(reserved),
        kind: "approval.reserved-screened",
        // What was actually submitted for screening. Without these two fields a
        // point declaring `reservedFacts: () => ({})` produced a node
        // indistinguishable from a real screening.
        factCount: Object.keys(reservedFacts).length,
        factKeys: factKeysOf(reservedFacts),
        ...factsPayload("fact", reservedFacts),
      },
      runNode,
    );
    if (reserved.reserved && spec.gate === "never") {
      const error = new ReservedStepMisdeclared(spec.id, reserved.rule);
      await writer.write(
        { kind: "approval.halted", error: error.name, alert: true, incident: true },
        screenNode,
      );
      throw error;
    }
    if (spec.gate === "human") assertLadderSound(spec.id, spec.doNothing.ladder, limits);

    // decide — read-only client, at every tier.
    const decideNode = await writer.write(
      { kind: "approval.deciding", tier, reserved: reserved.reserved },
      runNode,
    );
    const decideStartedAt = clock.now();
    const client = clients.readOnly({
      correlationId: ctx.correlationId,
      node: decideNode,
      pointId: spec.id,
    });
    const determination: Determination<V, P> = await guard(
      writer,
      decideNode,
      "spec.decide",
      () => spec.decide(client, input),
    );
    const decideLatencyUs = (clock.now() - decideStartedAt) * 1_000;

    if (determination.kind === "abstained") {
      const node = await writer.write(
        {
          kind: "approval.abstained",
          ...determination.spend,
          latencyUs: decideLatencyUs,
          evidence: determination.evidence.length,
          ...textFields("reason", determination.reason),
        },
        decideNode,
      );
      // An abstention is a verdict and a successful outcome of a working
      // system. It is returned, never thrown.
      return { kind: "abstained", reason: determination.reason, authorityTransferred: false, node };
    }

    const decidedNode = await writer.write(
      {
        kind: "approval.decided",
        ...determination.spend,
        latencyUs: decideLatencyUs,
        confidenceBasisPoints: determination.confidenceBasisPoints,
        evidence: determination.evidence.length,
        proposesEffect: determination.proposes !== null,
      },
      decideNode,
    );

    /* ---------------------------------------------------- ungated points */

    if (spec.gate === "never") {
      if (spec.effect.kind === "no-effect" || determination.proposes === null) {
        return {
          kind: "no-effect",
          verdict: determination.verdict,
          authorityTransferred: false,
          node: decidedNode,
        };
      }
      const { declaration, delegation, licenceValidFor } = spec.effect;
      const payload = determination.proposes.payload;
      const redacted = declaration.redact(payload);
      const key = deriveIdempotencyKey(
        ctx.correlationId,
        spec.id,
        spec.schemaVersion,
        declaration.kind,
        declaration.schemaVersion,
        redacted,
      );
      const now = clock.now();
      const authority: Authority = {
        kind: "delegated",
        id: delegation.as,
        delegatedBy: delegation.delegatedBy,
        delegationRef: delegation.delegationRef,
        grantedAt: delegation.grantedAt,
      };
      // Automated approval is still approval, and it is recorded with a named
      // authority. "The system approved it" never appears in a trace here
      // without saying under whose delegation.
      const approvalNode = await writer.write(
        {
          kind: "approval.granted",
          authorityKind: "delegated",
          authority: delegation.as,
          delegatedBy: delegation.delegatedBy,
          delegationRef: delegation.delegationRef,
          timeToDecisionMs: 0,
          timeToDecisionMeasurable: true,
        },
        decidedNode,
      );
      const approvals: NonEmpty<ApprovalRecord> = [
        {
          by: authority,
          at: now,
          node: approvalNode,
          reason: `standing delegation ${delegation.delegationRef}`,
          timeToDecisionMs: 0,
        },
      ];
      const result = await executeEffect(
        writer,
        ctx.correlationId,
        spec.id,
        approvalNode,
        declaration,
        payload,
        key,
        approvals,
        now + licenceValidFor,
      );
      if ("held" in result) {
        return { kind: "held", reason: result.reason, node: result.held };
      }
      return {
        kind: "executed",
        verdict: determination.verdict,
        effect: result.outcome,
        authorityTransferred: false,
        node: result.node,
      };
    }

    /* ------------------------------------------------------ gated points */

    if (determination.proposes === null) {
      return {
        kind: "no-effect",
        verdict: determination.verdict,
        authorityTransferred: false,
        node: decidedNode,
      };
    }

    const payload = determination.proposes.payload;
    const redacted = spec.effect.redact(payload);
    const key = deriveIdempotencyKey(
      ctx.correlationId,
      spec.id,
      spec.schemaVersion,
      spec.effect.kind,
      spec.effect.schemaVersion,
      redacted,
    );
    const suspensionId = deriveSuspensionId(ctx.correlationId, spec.id, key);

    const existing = await store.loadSuspension(suspensionId);
    if (existing !== undefined) {
      // `run` is idempotent per (case, point, effect payload). A retried run
      // rejoins the suspension it already created rather than opening a second
      // one and asking two people the same question — **and reports its actual
      // state**. Reporting a settled case as `suspended` told nineteen callers'
      // state machines that a human-refused case still needed a human.
      return await rejoin(existing, determination.verdict, spec.doNothing);
    }

    const body = await guard(writer, decidedNode, "spec.brief", () =>
      spec.brief({
        input,
        verdict: determination.verdict,
        confidenceBasisPoints: determination.confidenceBasisPoints,
        evidence: determination.evidence,
        tier,
        reserved,
      }),
    );
    const doNothing = servedDoNothingFor(spec.doNothing, reserved);
    const briefNode = await writer.write(
      {
        kind: "approval.brief-built",
        fields: 7,
        briefDigest: digest(canonicalJson(body)),
        contrary: "found" in body.contrary ? "found" : "searched-and-found-none",
        couldNotCheck: "items" in body.couldNotCheck ? "items" : "everything-checked",
      },
      decidedNode,
    );
    if (reserved.reserved && spec.doNothing.expire !== undefined) {
      await writer.write(
        {
          kind: "approval.expiry-deleted-reserved",
          rule: reserved.rule,
          declaredAfterMs: spec.doNothing.expire.after,
        },
        briefNode,
      );
    }

    const now = clock.now();
    const dualControlRequired =
      spec.dualControlAtOrAbove !== "never" &&
      TIER_ORDER[tier] >= TIER_ORDER[spec.dualControlAtOrAbove];
    const expiresAt = doNothing.expire === null ? null : now + doNothing.expire.after;

    // The crash window is bracketed by two nodes, on purpose. A process dying
    // between them leaves a recorded intent to suspend with no durable
    // suspension — visible in the trace and reconcilable — rather than a case
    // in a state with no record of entering it.
    const beginNode = await writer.write(
      {
        kind: "approval.suspend.begin",
        suspension: suspensionId,
        seat: "first",
        tier,
        reserved: reserved.reserved,
        expiresAt,
        dualControlRequired,
      },
      briefNode,
    );

    const suspension: SuspensionRecord = {
      id: suspensionId,
      revision: 0,
      correlationId: ctx.correlationId,
      pointId: spec.id,
      pointSchemaVersion: spec.schemaVersion,
      effectKind: spec.effect.kind,
      effectSchemaVersion: spec.effect.schemaVersion,
      tier,
      reserved,
      seat: "first",
      verdictJson: canonicalJson(determination.verdict),
      effectPayloadJson: canonicalJson(payload),
      redactedEffect: redacted,
      briefBodyJson: canonicalJson(body),
      doNothingJson: canonicalJson(doNothing),
      idempotencyKey: key,
      pool: spec.pool,
      dualControlRequired,
      licenceValidFor: spec.licenceValidFor,
      awaitingSince: now,
      // Nobody has it yet. The offer is a second, separate write.
      presentedAt: null,
      offeredTo: [],
      lastRemindedAt: null,
      nextDueAt: nextDueAt(doNothing.ladder, now, { stepsFired: 0, cyclesFired: 0 }, null),
      expiresAt,
      firstAnswer: null,
      finalAnswer: null,
      stepsFired: 0,
      cyclesFired: 0,
      leaseUntil: null,
      leaseOwner: null,
      state: "awaiting",
      suspendNode: beginNode,
      runNode,
    };
    await guard(writer, beginNode, "store.saveSuspension", () =>
      store.saveSuspension(suspension),
    );
    const durableNode = await writer.write(
      {
        kind: "approval.suspend.durable",
        suspension: suspensionId,
        nextDueAt: suspension.nextDueAt,
        ladderSteps: doNothing.ladder.steps.length,
        recurrenceEveryMs: doNothing.ladder.recurrence.every,
        // There is no stop value and no maximum attempt count to record,
        // because the type cannot express one.
        recurrenceWidensTo: doNothing.ladder.recurrence.widenTo.length,
      },
      beginNode,
    );

    const offer = await presentTo(
      writer,
      buildServedBrief(
        {
          suspension: suspensionId,
          correlationId: ctx.correlationId,
          tier,
          reserved,
          doNothing,
          presentedAt: now,
          body,
        },
        "first",
        null,
      ),
      spec.pool,
      reserved.reserved,
      [],
      now,
      durableNode,
    );
    await commitOffer(writer, suspensionId, offer, durableNode);

    return {
      kind: "suspended",
      suspension: suspensionId,
      seat: "first",
      pool: spec.pool,
      expiresAt,
      doNothing,
      node: beginNode,
    };
  };

  /**
   * What a retried `run` sees when the suspension it would have created already
   * exists. `awaiting` is the only state that is still a suspension.
   */
  const rejoin = async <V>(
    existing: SuspensionRecord,
    verdict: V,
    declared: DoNothingConsequence,
  ): Promise<Settled<V> | Suspended> => {
    const served = servedDoNothingFor(declared, existing.reserved);
    if (existing.state === "awaiting") {
      return {
        kind: "suspended",
        suspension: existing.id,
        seat: existing.seat,
        pool: existing.pool,
        expiresAt: existing.expiresAt,
        doNothing: served,
        node: existing.suspendNode,
      };
    }
    if (existing.state === "refused" && existing.finalAnswer !== null) {
      return {
        kind: "refused",
        by: existing.finalAnswer.by,
        reason: existing.finalAnswer.reason,
        node: existing.finalAnswer.node,
      };
    }
    if (existing.state === "expired") {
      return {
        kind: "expired",
        reason: "the declared expiry was reached with no authority answering",
        node: existing.suspendNode,
      };
    }
    if (existing.state === "held") {
      return { kind: "held", reason: "kill-switch", node: existing.suspendNode };
    }
    if (existing.state === "executed") {
      const claim = await store.readIdempotency(existing.idempotencyKey);
      if (claim?.state === "settled" && claim.outcome !== null) {
        return {
          kind: "executed",
          verdict,
          effect: claim.outcome,
          authorityTransferred: true,
          node: existing.suspendNode,
        };
      }
    }
    // `answered` (an outbound call in flight or a process that died mid-call),
    // or `executed` with no settled claim to report. Fail-closed and named:
    // it is not awaiting an authority, and this module will not guess.
    throw new SuspensionAlreadySettled(existing.id, existing.state);
  };

  /* --------------------------------------------------------------- answer */

  const answer = async (
    suspensionId: SuspensionId,
    approverAnswer: ApproverAnswer,
    ctx: AnsweringContext,
  ): Promise<Settled<unknown> | Suspended> => {
    const current = await store.loadSuspension(suspensionId);
    if (current === undefined) throw new SuspensionNotFound(suspensionId);
    if (current.state !== "awaiting") {
      throw new SuspensionAlreadySettled(suspensionId, current.state);
    }

    const writer = await openWriter(current.correlationId, current.tier);
    const point = registry.get(current.pointId);
    if (point === undefined) throw new UnknownDecisionPoint(current.pointId, suspensionId);
    const spec = point.spec;
    if (spec.gate !== "human") throw new GateDeclarationChanged(current.pointId, suspensionId);
    const gated = spec as GatedSpec<unknown, unknown, unknown>;

    /* --------------- the declaration this case was frozen against still holds */

    if (gated.schemaVersion !== current.pointSchemaVersion) {
      const error = new PointSchemaChanged(
        current.pointId,
        suspensionId,
        current.pointSchemaVersion,
        gated.schemaVersion,
      );
      await writer.write(
        {
          kind: "approval.declaration-drifted",
          what: "pointSchemaVersion",
          frozen: current.pointSchemaVersion,
          declared: gated.schemaVersion,
          error: error.name,
          alert: true,
          incident: error.incident,
        },
        current.suspendNode,
      );
      throw error;
    }
    if (
      gated.effect.kind !== current.effectKind ||
      gated.effect.schemaVersion !== current.effectSchemaVersion
    ) {
      const error = new EffectDeclarationDrifted(
        current.pointId,
        suspensionId,
        `${current.effectKind}@${current.effectSchemaVersion}`,
        `${gated.effect.kind}@${gated.effect.schemaVersion}`,
      );
      await writer.write(
        {
          kind: "approval.declaration-drifted",
          what: "effect",
          frozen: `${current.effectKind}@${current.effectSchemaVersion}`,
          declared: `${gated.effect.kind}@${gated.effect.schemaVersion}`,
          error: error.name,
          alert: true,
          incident: error.incident,
        },
        current.suspendNode,
      );
      throw error;
    }

    /* ------------------------------------------- the answerer is authorised */

    // A delegated authority may never answer a reserved decision. Confidence is
    // not an argument and neither is a standing delegation. Checked first
    // because it is the more specific refusal.
    if (current.reserved.reserved && ctx.authority.kind === "delegated") {
      const error = new ReservedDelegationAttempt(suspensionId, ctx.authority.id);
      await writer.write(
        {
          kind: "approval.reserved-delegation-refused",
          authority: ctx.authority.id,
          rule: current.reserved.rule,
          alert: true,
          incident: true,
        },
        current.suspendNode,
      );
      throw error;
    }

    // The primary authorisation check, and the one that was missing: membership
    // of the durable set the directory offered this seat's brief to. Before
    // this, `ctx.authority` was whatever the calling surface asserted, and two
    // invented identifiers satisfied dual control.
    if (!current.offeredTo.includes(ctx.authority.id)) {
      const error = new AuthorityNotOffered(suspensionId, ctx.authority.id, current.seat);
      await writer.write(
        {
          kind: "approval.authority-not-offered",
          suspension: suspensionId,
          seat: current.seat,
          attempted: ctx.authority.id,
          offered: current.offeredTo.length,
          alert: true,
          incident: error.incident,
        },
        current.suspendNode,
      );
      throw error;
    }

    // Backstop only. `offeredTo` for a second seat is computed from a directory
    // already narrowed by `excluding: [first]`, so a well-behaved directory
    // makes this unreachable. It catches a directory that lies about identity.
    if (
      current.seat === "second" &&
      current.firstAnswer !== null &&
      current.firstAnswer.by === ctx.authority.id
    ) {
      const error = new DualControlSelfApproval(current.firstAnswer.by, ctx.authority.id);
      await writer.write(
        {
          kind: "approval.self-approval-refused",
          attempted: ctx.authority.id,
          alert: true,
          backstop: true,
        },
        current.suspendNode,
      );
      // The suspension stays open and is re-served to a different authority.
      throw error;
    }

    const now = clock.now();
    // `null` rather than a number when the brief was never delivered. An
    // invented zero reads as the fastest possible approval in the one metric
    // that exists to catch rubber-stamping.
    const timeToDecisionMs = current.presentedAt === null ? null : now - current.presentedAt;
    const answerNode = await writer.write(
      {
        kind: "approval.answered",
        suspension: suspensionId,
        seat: current.seat,
        choice: approverAnswer.choice,
        authority: ctx.authority.id,
        authorityKind: ctx.authority.kind,
        // The approver's own words are NOT written here. See `textFields`.
        ...textFields("reason", approverAnswer.reason),
        // Recorded on every approval. The library sets NO threshold: a £200
        // expense and a £2M disbursement do not share a plausible reading time,
        // and only the application knows which it is holding.
        timeToDecisionMs,
        timeToDecisionMeasurable: timeToDecisionMs !== null,
        reserved: current.reserved.reserved,
      },
      current.suspendNode,
    );

    const sealed: SealedAnswer = {
      by: ctx.authority.id,
      at: now,
      node: answerNode,
      choice: approverAnswer.choice,
      reason: approverAnswer.reason,
      timeToDecisionMs,
    };

    if (approverAnswer.choice === "refuse") {
      const swapped = await store.swapSuspension(suspensionId, current.revision, {
        ...current,
        state: "refused",
        finalAnswer: sealed,
        leaseUntil: null,
        leaseOwner: null,
      });
      if (!swapped) throw new SuspensionRaceLost(suspensionId);
      return {
        kind: "refused",
        by: ctx.authority.id,
        reason: approverAnswer.reason,
        node: answerNode,
      };
    }

    /* ------------------------------------------ dual control, second seat */

    if (current.seat === "first" && current.dualControlRequired) {
      const doNothing = JSON.parse(current.doNothingJson) as ServedDoNothing;
      const next: SuspensionRecord = {
        ...current,
        seat: "second",
        firstAnswer: sealed,
        awaitingSince: now,
        // Nobody holds the second brief yet. The offer is a second write.
        presentedAt: null,
        offeredTo: [],
        lastRemindedAt: null,
        // The ladder restarts for the second seat: the second approver has not
        // been waited on yet, and inheriting the first seat's ageing would page
        // an executive about a case that has been open for four minutes.
        stepsFired: 0,
        cyclesFired: 0,
        nextDueAt: nextDueAt(doNothing.ladder, now, { stepsFired: 0, cyclesFired: 0 }, null),
        expiresAt:
          current.reserved.reserved || doNothing.expire === null
            ? null
            : now + doNothing.expire.after,
        leaseUntil: null,
        leaseOwner: null,
      };
      const swapped = await store.swapSuspension(suspensionId, current.revision, next);
      if (!swapped) throw new SuspensionRaceLost(suspensionId);

      const secondNode = await writer.write(
        {
          kind: "approval.suspend.begin",
          suspension: suspensionId,
          seat: "second",
          tier: current.tier,
          reserved: current.reserved.reserved,
          expiresAt: next.expiresAt,
          excludes: ctx.authority.id,
        },
        answerNode,
      );
      const offer = await presentTo(
        writer,
        buildServedBrief(
          {
            suspension: suspensionId,
            correlationId: current.correlationId,
            tier: current.tier,
            reserved: current.reserved,
            doNothing,
            presentedAt: now,
            body: JSON.parse(current.briefBodyJson) as BriefBody,
          },
          "second",
          sealed,
        ),
        current.pool,
        current.reserved.reserved,
        // Structural distinctness: the directory is narrowed before it is
        // asked, and what it returns becomes the set `answer` authorises
        // against — so the first approver is not merely un-notified, they are
        // unable to answer.
        [ctx.authority.id],
        now,
        secondNode,
      );
      await commitOffer(writer, suspensionId, offer, secondNode);

      return {
        kind: "suspended",
        suspension: suspensionId,
        seat: "second",
        pool: current.pool,
        expiresAt: next.expiresAt,
        doNothing,
        node: secondNode,
      };
    }

    /* --------------------------------------------------------- authorised */

    const approvals: NonEmpty<ApprovalRecord> =
      current.firstAnswer === null
        ? [
            {
              by: ctx.authority,
              at: now,
              node: answerNode,
              reason: approverAnswer.reason,
              timeToDecisionMs,
            },
          ]
        : [
            {
              by: { kind: "human", id: current.firstAnswer.by, role: "first-seat" },
              at: current.firstAnswer.at,
              node: current.firstAnswer.node,
              reason: current.firstAnswer.reason,
              timeToDecisionMs: current.firstAnswer.timeToDecisionMs,
            },
            {
              by: ctx.authority,
              at: now,
              node: answerNode,
              reason: approverAnswer.reason,
              timeToDecisionMs,
            },
          ];

    // A stale approval is not approval. The licence runs from the EARLIEST
    // approval in hand, not from the last one: an approver who signed on Monday
    // signed against Monday's evidence, and a second seat arriving on Thursday
    // must not resurrect it.
    const licenceExpiresAt =
      Math.min(...approvals.map((a) => a.at)) + current.licenceValidFor;
    if (now > licenceExpiresAt) {
      const error = new LicenceExpired(suspensionId, licenceExpiresAt, now);
      await writer.write(
        {
          kind: "approval.licence-expired",
          suspension: suspensionId,
          expiredAt: licenceExpiresAt,
          licenceValidFor: current.licenceValidFor,
          approvals: approvals.length,
          alert: true,
          incident: error.incident,
          returnedToSeat: "first",
        },
        answerNode,
      );
      const doNothing = JSON.parse(current.doNothingJson) as ServedDoNothing;
      // Still answerable, and back at the first seat with the ladder restarted.
      // The case is not closed, not expired and not lost — it simply needs
      // approval again, which is what "a stale approval is not approval" means.
      await store.swapSuspension(suspensionId, current.revision, {
        ...current,
        seat: "first",
        firstAnswer: null,
        presentedAt: null,
        offeredTo: [],
        lastRemindedAt: null,
        awaitingSince: now,
        stepsFired: 0,
        cyclesFired: 0,
        nextDueAt: nextDueAt(doNothing.ladder, now, { stepsFired: 0, cyclesFired: 0 }, null),
        leaseUntil: null,
        leaseOwner: null,
      });
      throw error;
    }

    /* ------------ commit the settlement BEFORE the outbound call, not after */

    // This is the compare-and-set that matters. Previously the effect ran first
    // and the swap came after, holding a revision read before the kill-switch
    // read, the idempotency claim and the whole payment: a concurrent sweeper
    // bumping the revision meant money moved, `SuspensionRaceLost` reached the
    // caller, the suspension stayed `awaiting`, and a second authority could
    // answer the same already-paid case.
    //
    // Committing first means a lost race happens with nothing moved and nothing
    // to reconcile, and `awaiting` is a state no second answer can reach.
    const committed = await store.swapSuspension(suspensionId, current.revision, {
      ...current,
      state: "answered",
      finalAnswer: sealed,
      leaseUntil: null,
      leaseOwner: null,
    });
    if (!committed) throw new SuspensionRaceLost(suspensionId);
    await writer.write(
      {
        kind: "approval.settlement-committed",
        suspension: suspensionId,
        state: "answered",
        beforeOutboundCall: true,
      },
      answerNode,
    );

    const claimedRecord = await store.loadSuspension(suspensionId);
    const payload = JSON.parse(current.effectPayloadJson) as unknown;
    const result = await executeEffect(
      writer,
      current.correlationId,
      current.pointId,
      answerNode,
      gated.effect,
      payload,
      current.idempotencyKey,
      approvals,
      licenceExpiresAt,
    );

    /**
     * Settle the terminal state. Never throws: past this point either money has
     * moved or the kill switch withheld it, and raising `SuspensionRaceLost` at
     * a caller who has already paid is how one payment acquires two
     * authorisation chains.
     */
    const settle = async (state: "executed" | "held", parent: NodeId): Promise<void> => {
      const base = claimedRecord ?? current;
      const swapped = await store.swapSuspension(base.id, base.revision, {
        ...base,
        state,
        finalAnswer: sealed,
        leaseUntil: null,
        leaseOwner: null,
      });
      if (!swapped) {
        // Nothing else can legitimately have touched a suspension in
        // `answered`, so this is a store fault rather than a race. It is an
        // incident and it is recorded as one; the idempotency claim is settled,
        // so a repeat returns the original outcome rather than paying again.
        await writer.write(
          {
            kind: "approval.settlement-not-committed",
            suspension: base.id,
            state,
            alert: true,
            incident: true,
            effectAlreadyTaken: state === "executed",
          },
          parent,
        );
      }
    };

    if ("held" in result) {
      await settle("held", result.held);
      return { kind: "held", reason: result.reason, node: result.held };
    }

    await settle("executed", result.node);

    return {
      kind: "executed",
      verdict: JSON.parse(current.verdictJson) as unknown,
      effect: result.outcome,
      // Authority moved to a human. `audit` computes unassisted containment at
      // case close from facts like this one; this module does not name it here,
      // because unassisted containment is a property of a case, not a step.
      authorityTransferred: true,
      node: result.node,
    };
  };

  /* ---------------------------------------------------------------- sweep */

  const sweep = async (request: { readonly limit: number }): Promise<SweepReport> => {
    const bounded = Math.max(0, Math.min(request.limit, limits.sweepBatch));
    const now = clock.now();
    const due = await store.dueSuspensions(now, bounded);

    let remindersSent = 0;
    let expired = 0;
    let presented = 0;
    let skippedLeased = 0;
    let raceLost = 0;
    const nodes: NodeId[] = [];

    for (const suspension of due) {
      // Compare-and-set. Two sweepers running during a deploy is the normal
      // case; the loser skips, it does not block and it does not duplicate.
      const leased = await store.acquireLease(
        suspension.id,
        sweeperId,
        now,
        now + limits.sweepLeaseMs,
      );
      if (!leased) {
        skippedLeased += 1;
        continue;
      }

      const writer = await openWriter(suspension.correlationId, suspension.tier);
      const doNothing = JSON.parse(suspension.doNothingJson) as ServedDoNothing;
      const ladder: EscalationLadder = doNothing.ladder;

      const visitNode = await writer.write(
        {
          kind: "sweep.visited",
          suspension: suspension.id,
          sweeper: sweeperId,
          awaitingForMs: now - suspension.awaitingSince,
          stepsFired: suspension.stepsFired,
          cyclesFired: suspension.cyclesFired,
          presented: suspension.presentedAt !== null,
        },
        suspension.suspendNode,
      );
      nodes.push(visitNode);

      /* ------------- a brief that was never served is served again here */

      if (suspension.presentedAt === null) {
        // An on-call gap or a directory outage at suspend time used to mean the
        // brief was never delivered — ever — while the ladder escalated people
        // about a brief they had not received. `presentTo` is now reachable from
        // the sweep, so the offer is retried for as long as the case waits.
        const offer = await presentTo(
          writer,
          buildServedBrief(
            {
              suspension: suspension.id,
              correlationId: suspension.correlationId,
              tier: suspension.tier,
              reserved: suspension.reserved,
              doNothing,
              presentedAt: now,
              body: JSON.parse(suspension.briefBodyJson) as BriefBody,
            },
            suspension.seat,
            suspension.firstAnswer,
          ),
          suspension.pool,
          suspension.reserved.reserved,
          suspension.firstAnswer === null ? [] : [suspension.firstAnswer.by],
          now,
          visitNode,
        );
        if (offer.presentedAt !== null) {
          presented += 1;
          const swapped = await store.swapSuspension(suspension.id, suspension.revision, {
            ...suspension,
            offeredTo: offer.offeredTo,
            presentedAt: offer.presentedAt,
            leaseUntil: null,
            leaseOwner: null,
          });
          if (!swapped) raceLost += 1;
          // The ladder is not advanced on a pass that finally delivered the
          // brief: the approver has had it for zero milliseconds.
          continue;
        }
      }

      if (suspension.expiresAt !== null && suspension.expiresAt <= now) {
        // Only reachable for a NON-reserved decision: a reserved one has no
        // expiry to reach, because the expiry branch was deleted, not disabled.
        const settlement = doNothing.expire?.then ?? { kind: "refuse", reason: "expired" };
        // The compare-and-set comes FIRST, so `SweepReport.expired` never
        // reports an expiry that was not persisted.
        const swapped = await store.swapSuspension(suspension.id, suspension.revision, {
          ...suspension,
          state: "expired",
          leaseUntil: null,
          leaseOwner: null,
        });
        if (!swapped) {
          raceLost += 1;
          await writer.write(
            { kind: "sweep.race-lost", suspension: suspension.id, intended: "expired" },
            visitNode,
          );
          continue;
        }
        await writer.write(
          {
            kind: "ladder.expired",
            suspension: suspension.id,
            settlement: settlement.kind,
            ...textFields("reason", settlement.reason),
            // An expiry can never license an effect. There is no "approve" arm.
            licensedEffect: false,
          },
          visitNode,
        );
        expired += 1;
        continue;
      }

      const position = {
        stepsFired: suspension.stepsFired,
        cyclesFired: suspension.cyclesFired,
      };
      if (becomesBuried(ladder, position)) {
        // An incident, not a state. The ladder has failed, and the failure is
        // of the organisation, not of the case. The chasing does not stop.
        await writer.write(
          {
            kind: "approval.buried",
            suspension: suspension.id,
            awaitingForMs: now - suspension.awaitingSince,
            alert: true,
            incident: true,
            stillAnswerable: true,
          },
          visitNode,
        );
      }

      const firing = firingAt(ladder, position, limits);
      const resolved: HumanAuthority[] = [];
      const seen = new Set<string>();
      for (const ref of firing.to) {
        const looked = await guardSoft(writer, visitNode, "authorities.resolve", () =>
          authorities.resolve(ref),
        );
        if (!looked.ok) continue;
        for (const authority of looked.value) {
          if (seen.has(authority.id)) continue;
          seen.add(authority.id);
          resolved.push(authority);
          if (resolved.length >= limits.maxRecipientsPerReminder) break;
        }
        if (resolved.length >= limits.maxRecipientsPerReminder) break;
      }

      const sent = await guardSoft(writer, visitNode, "renderer.remind", () =>
        renderer.remind(
          {
            suspension: suspension.id,
            correlationId: suspension.correlationId,
            action: firing.action,
            ordinal: firing.ordinal,
            phase: firing.phase,
            awaitingForMs: now - suspension.awaitingSince,
            reserved: suspension.reserved.reserved,
          },
          resolved,
        ),
      );
      if (!sent.ok) {
        // Delivery failed. The position does NOT advance, so the next sweep
        // tries again: failing to chase is not a reason to stop chasing.
        await writer.write(
          {
            kind: "ladder.reminder-undeliverable",
            suspension: suspension.id,
            phase: firing.phase,
            ordinal: firing.ordinal,
          },
          visitNode,
        );
        const released = await store.swapSuspension(suspension.id, suspension.revision, {
          ...suspension,
          leaseUntil: null,
          leaseOwner: null,
        });
        if (!released) raceLost += 1;
        continue;
      }

      // Every reminder sent is a recorded node, so "we chased them" is evidence
      // rather than an assertion.
      await writer.write(
        {
          kind: "ladder.reminder",
          suspension: suspension.id,
          phase: firing.phase,
          ordinal: firing.ordinal,
          action: firing.action,
          recipients: resolved.length,
          awaitingForMs: now - suspension.awaitingSince,
          intervalMs: ladder.recurrence.every,
        },
        visitNode,
      );
      remindersSent += 1;

      const advanced = await store.swapSuspension(suspension.id, suspension.revision, {
        ...suspension,
        stepsFired: firing.next.stepsFired,
        cyclesFired: firing.next.cyclesFired,
        lastRemindedAt: now,
        // Floored against the reminder that was actually delivered, never
        // computed from `awaitingSince` alone — see `nextDueAt`.
        nextDueAt: nextDueAt(ladder, suspension.awaitingSince, firing.next, now),
        leaseUntil: null,
        leaseOwner: null,
      });
      if (!advanced) {
        raceLost += 1;
        await writer.write(
          { kind: "sweep.race-lost", suspension: suspension.id, intended: "ladder-advanced" },
          visitNode,
        );
      }
    }

    return {
      examined: due.length,
      remindersSent,
      expired,
      presented,
      skippedLeased,
      raceLost,
      nodes,
    };
  };

  return {
    run,
    answer,
    sweep,
    inDoubt: () => store.inDoubt(limits.inDoubtBatch),
  };
};
