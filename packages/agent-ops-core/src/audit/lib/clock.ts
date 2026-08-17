/**
 * Time is a dependency, not an ambient fact.
 *
 * No module in this library reads the machine clock except through an adapter
 * like the one below. `Date.now()` appears twice in the package, in this
 * `systemClock` and in `alerts`' own, and both are adapters wired at the
 * composition root rather than reached for inside a module. Ageing, escalation
 * ladders and time-to-decision are all testable without waiting because of this
 * interface, and hermetic tests stay structural rather than conventional.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** The only adapter that reads the machine clock. Wire it at the composition root. */
export const systemClock = (): Clock => ({
  now: () => Date.now(),
});
