import { LadderCadenceTooTight } from "./errors.js";
import type {
  AuthorityRef,
  EscalationAction,
  EscalationLadder,
  Instant,
  Limits,
} from "./types.js";

/**
 * The escalation ladder, as pure functions over plain data.
 *
 * Nothing in here owns a timer, holds state, or reads a clock. That is what
 * lets eleven days of ageing be tested in eleven microseconds, and it is why
 * `sweep` can be re-entrant: two sweepers computing the same schedule from the
 * same record get the same answer.
 *
 * The invariant the shape enforces: **the ladder cannot terminate into
 * silence.** Scheduled steps are followed by a recurrence that repeats until an
 * authority answers. There is no position in this state machine from which the
 * next due time is `null`.
 */

/** Where a suspension has got to. Both counters live in the durable record. */
export interface LadderPosition {
  readonly stepsFired: number;
  readonly cyclesFired: number;
}

export interface LadderFiring {
  readonly phase: "step" | "recurrence";
  /** 1-based within its phase. */
  readonly ordinal: number;
  readonly action: EscalationAction;
  readonly to: readonly AuthorityRef[];
  readonly next: LadderPosition;
}

/**
 * Validate a declared ladder. Called on every `run` that reaches a gate, before
 * anything is suspended, so a bad cadence fails closed at the first case rather
 * than at the first reminder three days later.
 *
 * Two rules:
 *  - scheduled steps are strictly increasing, so a ladder cannot fire twice at
 *    the same instant or run backwards;
 *  - the recurrence interval is at or above the configured floor, so the
 *    cadence is bounded from below.
 *
 * The cadence cannot accelerate by construction: `every` is a single constant,
 * and there is no field that could make the interval shrink over time.
 */
export const assertLadderSound = (
  pointId: string,
  ladder: EscalationLadder,
  limits: Limits,
): void => {
  let previous = -1;
  for (const step of ladder.steps) {
    if (!Number.isSafeInteger(step.after) || step.after <= previous) {
      throw new LadderCadenceTooTight(pointId, step.after, previous + 1);
    }
    previous = step.after;
  }
  if (
    !Number.isSafeInteger(ladder.recurrence.every) ||
    ladder.recurrence.every < limits.minRecurrenceIntervalMs
  ) {
    throw new LadderCadenceTooTight(
      pointId,
      ladder.recurrence.every,
      limits.minRecurrenceIntervalMs,
    );
  }
};

const lastStepOffset = (ladder: EscalationLadder): number => {
  const last = ladder.steps[ladder.steps.length - 1];
  return last === undefined ? 0 : last.after;
};

/**
 * Where the ladder *says* this firing falls, measured from the moment the
 * decision began awaiting an authority. Pure schedule; it knows nothing about
 * what was actually delivered.
 */
const scheduledAt = (
  ladder: EscalationLadder,
  awaitingSince: Instant,
  position: LadderPosition,
): Instant => {
  const step = ladder.steps[position.stepsFired];
  if (step !== undefined) return awaitingSince + step.after;
  return (
    awaitingSince +
    lastStepOffset(ladder) +
    (position.cyclesFired + 1) * ladder.recurrence.every
  );
};

/** The firing immediately before this one, or `null` at the start of the ladder. */
const previousPosition = (position: LadderPosition): LadderPosition | null => {
  if (position.cyclesFired > 0) {
    return { stepsFired: position.stepsFired, cyclesFired: position.cyclesFired - 1 };
  }
  if (position.stepsFired > 0) {
    return { stepsFired: position.stepsFired - 1, cyclesFired: 0 };
  }
  return null;
};

/**
 * When the next reminder is due.
 *
 * Never returns `null`, `Infinity` or a sentinel. A case that has exhausted its
 * scheduled steps is *buried* — an incident, not a state — and it keeps getting
 * a due time forever, because a decision that needed a human yesterday still
 * needs one next month.
 *
 * ## Why `lastRemindedAt` is a parameter
 *
 * Computed from `awaitingSince` alone, every position of a ladder whose
 * schedule is already in the past is due *now*. A sweeper that was down for a
 * month therefore catches up by firing step 1, step 2 and twenty-nine
 * recurrence cycles at a single millisecond, escalating through deputy, line
 * manager and accountable executive in one breath — which is precisely the
 * accelerating cadence `Recurrence` documents as impossible, and it ends with
 * the channel muted and the case *less* likely to be answered.
 *
 * So the due time is floored at `lastRemindedAt + gap`, where `gap` is the
 * interval the ladder itself declares between this firing and the one before
 * it. In normal operation the floor is slack and the schedule wins, so a
 * declared cadence is followed exactly. After downtime the floor binds, and the
 * ladder resumes at its declared interval from the last reminder that was
 * really delivered rather than replaying a month of missed ones.
 *
 * Note what this deliberately does **not** do: it does not skip missed cycles
 * to "catch up" on the position. The audience still widens one cycle at a time,
 * so nobody is escalated past.
 */
export const nextDueAt = (
  ladder: EscalationLadder,
  awaitingSince: Instant,
  position: LadderPosition,
  lastRemindedAt: Instant | null = null,
): Instant => {
  const scheduled = scheduledAt(ladder, awaitingSince, position);
  if (lastRemindedAt === null) return scheduled;
  const previous = previousPosition(position);
  if (previous === null) return scheduled;
  const declaredGap = scheduled - scheduledAt(ladder, awaitingSince, previous);
  return Math.max(scheduled, lastRemindedAt + declaredGap);
};

/**
 * What to send next, and to whom.
 *
 * The recurrence **widens the audience rather than raising the volume**: cycle
 * one reaches the first name on `widenTo`, cycle two the first two, and so on —
 * deputy, then line manager, then the accountable executive — while the
 * interval stays exactly `every`. The fifteenth reminder to a person who has
 * ignored fourteen is not a plan; reaching someone who *can* answer is.
 *
 * Fan-out is bounded by `limits.maxRecipientsPerReminder`.
 */
export const firingAt = (
  ladder: EscalationLadder,
  position: LadderPosition,
  limits: Limits,
): LadderFiring => {
  const step = ladder.steps[position.stepsFired];
  if (step !== undefined) {
    return {
      phase: "step",
      ordinal: position.stepsFired + 1,
      action: step.action,
      to: [step.to],
      next: { stepsFired: position.stepsFired + 1, cyclesFired: position.cyclesFired },
    };
  }
  const cycle = position.cyclesFired + 1;
  const widened = ladder.recurrence.widenTo.slice(
    0,
    Math.min(cycle, ladder.recurrence.widenTo.length, limits.maxRecipientsPerReminder),
  );
  return {
    phase: "recurrence",
    ordinal: cycle,
    // Widening authority is an escalation, not a nudge. The vocabulary is
    // deliberate: `CONTEXT.md` lists "nudge", "chase" and "reminder" under
    // _Avoid_ for the ladder itself.
    action: "escalate",
    to: widened,
    next: { stepsFired: position.stepsFired, cyclesFired: cycle },
  };
};

/** True the first time a suspension crosses from scheduled steps into recurrence. */
export const becomesBuried = (
  ladder: EscalationLadder,
  position: LadderPosition,
): boolean => position.stepsFired >= ladder.steps.length && position.cyclesFired === 0;
