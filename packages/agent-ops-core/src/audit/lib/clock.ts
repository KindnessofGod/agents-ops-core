/**
 * Time is a dependency, not an ambient fact.
 *
 * No module in this library calls `Date.now()`. Ageing, escalation ladders and
 * time-to-decision are all testable without waiting because of this interface,
 * and hermetic tests stay structural rather than conventional.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** The only adapter that reads the machine clock. Wire it at the composition root. */
export const systemClock = (): Clock => ({
  now: () => Date.now(),
});
