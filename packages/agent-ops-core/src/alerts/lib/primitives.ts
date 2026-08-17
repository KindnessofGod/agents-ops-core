/**
 * The small vocabulary everything else in `alerts` is built from.
 *
 * Kept in one file with no dependencies of its own so that `conditions.ts` and
 * `types.ts` can both reach it without a cycle — dependency-cruiser forbids
 * cycles, and a cycle here would be a genuine design smell rather than a
 * tooling irritation.
 */

/**
 * Milliseconds since the Unix epoch, always an integer, always from an injected
 * `Clock`. `Date.now()` does not appear anywhere in this module.
 */
export type Instant = number;

/** Milliseconds. Integer. Never a fraction — see `AlertPayloadInvalid`. */
export type DurationMs = number;

/**
 * Hundredths of a percent. A rate that moved from 4% to 11% is 400 to 1100.
 *
 * Integers only, here and in every payload field. Byte-stable serialisation is
 * what makes replay possible seven years later, and IEEE-754 is how it dies
 * quietly: `0.1 + 0.2` is a different string on a different day.
 */
export type BasisPoints = number;

/** Identifies one component that proves liveness. `sweeper`, `reconciler`. */
export type ComponentId = string & { readonly __brand: "ComponentId" };

/**
 * Ties an alert to the case it is about.
 *
 * The brand string matches `audit`'s deliberately: an alert carrying a case's
 * correlation identifier is meant to become a node on that case's trace, and
 * the wiring agent that joins the two modules should not need a cast to do it.
 */
export type CorrelationId = string & { readonly __brand: "CorrelationId" };

/** Which declared decision point the condition was observed at. */
export type DecisionPointId = string & { readonly __brand: "DecisionPointId" };

/** The statute or standing policy that reserves a decision. Never free text. */
export type ReservedRuleId = string & { readonly __brand: "ReservedRuleId" };

/** The kind of effect, not its content. `disbursement`, `policy-cancellation`. */
export type EffectKindId = string & { readonly __brand: "EffectKindId" };

/** The idempotency key of an effect whose outcome is unrecorded. */
export type IdempotencyKeyId = string & { readonly __brand: "IdempotencyKeyId" };

/** A pool of authorities — a role, a rota, a queue. Never a person. */
export type AuthorityPoolId = string & { readonly __brand: "AuthorityPoolId" };

/**
 * Who an alert wakes. **Deliberately not an `AuthorityRef`.**
 *
 * An escalation goes to a business authority because a *decision* needs a human.
 * An alert goes to an operator because the *machinery* is wrong. `docs/CONTEXT.md`
 * is explicit that these never share a channel, and this is where that separation
 * stops being a convention: an authority identifier does not typecheck where an
 * operator rota is required, so the two audiences cannot be crossed by a caller
 * reaching for the identifier that happened to be in scope.
 */
export type OperatorRotaId = string & { readonly __brand: "OperatorRotaId" };

/** Names one sink in the ordered chain, so a degradation can say which failed. */
export type AlertSinkId = string & { readonly __brand: "AlertSinkId" };

/**
 * The dedupe key. Derived from a condition's *identity* fields only, never from
 * its measurements, so a heartbeat that is 30s overdue and the same heartbeat
 * 90s overdue collapse into one flapping condition rather than two alerts.
 */
export type AlertFingerprint = string & { readonly __brand: "AlertFingerprint" };

/** Identity of one raised alert. Assigned by this module, never by a caller. */
export type AlertId = string & { readonly __brand: "AlertId" };

/**
 * The consequence of being wrong, as `audit` and `approval` classify it. Carried
 * on the conditions that have one so an operator reading a page knows whether a
 * disbursement or a ticket-routing decision is behind it.
 */
export type RiskTier = "low" | "medium" | "high";

/**
 * Reserved status, as a closed pair rather than a boolean.
 *
 * `docs/CONTEXT.md`: "we checked and it is not reserved" and "nobody thought
 * about it" must not share a representation. A boolean gives them one, because
 * `undefined` reads as `false` at every call site that forgets.
 */
export type ReservedStatus = "reserved" | "not-reserved";

/** A list that cannot be empty. Absence of a sink is not a chain. */
export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * The only value types an alert payload field may hold. Same shape as `audit`'s
 * `PayloadField`, so a payload built here can be recorded as a node without
 * translation — and same rule: integers only, flat, no nesting.
 */
export type AlertField = string | number | boolean | null;

/**
 * What gets written to the journal and handed to a sink. Flat, integer-only,
 * versioned, and — importantly — **closed**: there is no free-text field on any
 * condition, so there is nowhere for a customer's name, address or claim
 * narrative to arrive. Every string in a payload is either an enumerated value
 * this module owns or an identifier the application chose.
 */
export interface AlertPayload {
  readonly kind: string;
  /** Payload schema version. Bumped when a field set or a meaning changes. */
  readonly v: number;
  readonly [field: string]: AlertField | undefined;
}

/**
 * Time is a dependency, not an ambient fact. Structurally identical to `audit`'s
 * `Clock`, so one composition root can hand the same adapter to both.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** The only adapter that reads the machine clock. Wire it at the composition root. */
export const systemClock = (): Clock => ({
  now: () => Date.now(),
});

/**
 * *Waiting* on the clock is a different dependency from *reading* it, and only
 * the second is `Clock`. A sink that hangs must not hang the case that raised
 * the alert, so delivery is bounded by a deadline — and a deadline that reached
 * for ambient `setTimeout` would be the one piece of timing behaviour no test
 * could drive.
 *
 * **Injected, not seamed.** One shipped adapter. The manual adapter tests use
 * lives in `tests/` and is not a deliverable, so by this project's own rule
 * (C5: two adapters or it is not a seam) this is a hermeticism requirement and
 * not a seam. Counting a fake timer as an adapter would let anything injected
 * be called a seam.
 */
export interface AlertTimers {
  /**
   * Call `onDue` after `millis`. Returns a cancel function that is safe to call
   * more than once and after firing.
   */
  deadline(millis: DurationMs, onDue: () => void): () => void;
}

/** The one adapter that touches the runtime's timer wheel. */
export const systemAlertTimers = (): AlertTimers => ({
  deadline(millis, onDue) {
    const handle = setTimeout(onDue, Math.max(0, millis));
    handle.unref?.();
    let cancelled = false;
    return () => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(handle);
    };
  },
});

/**
 * The exhaustiveness enforcer.
 *
 * Every switch over a closed union in this module ends here. Add a ninth
 * condition to `AlertCondition` without handling it and the value reaching this
 * function is no longer `never`, which is a compile error at the call site — not
 * a runtime surprise on the night the ninth condition first occurs.
 *
 * It also throws, because a JavaScript caller (or a `JSON.parse`) can hand us a
 * kind the type system was promised would not exist.
 */
export const assertNever = (value: never, context: string): never => {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
};
