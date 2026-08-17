import type { Timers } from "./types.js";

/**
 * The two `Timers` adapters.
 *
 * The seam exists because *reading* the clock and *waiting* on it are different
 * dependencies, and only the first was injected. Both wall clocks and the retry
 * backoff reached for ambient `setTimeout`, so the one part of this module with
 * real timing behaviour was the one part no test could drive: `bounds.test.ts`
 * was reduced to comparing `Date.now()` against a limit, and the backoff
 * sequence — bounded, jittered, deterministic given the seed — was asserted
 * nowhere at all.
 *
 * Neither adapter can reach a network. `systemTimers` is `setTimeout`;
 * `manualTimers` is a sorted queue advanced by hand.
 */

/**
 * Adapter 1 — production. Unrefs its handles, so a pending deadline never holds
 * a process open past the work it was bounding.
 */
export const systemTimers = (): Timers => ({
  sleep(millis, signal) {
    if (signal.aborted || millis <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(handle);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const handle = setTimeout(done, millis);
      handle.unref?.();
      signal.addEventListener("abort", done, { once: true });
    });
  },
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

export interface ManualTimers extends Timers {
  /** Move virtual time forward, firing everything due. */
  advance(millis: number): void;
  /**
   * Virtual time since these timers were constructed, in milliseconds. Moves
   * only under `advance`.
   *
   * It exists so a test can assert a **runtime ceiling** — "200 cases at
   * concurrency 8 finished inside `runMillis`" — against the same clock the
   * module's own wall-clock deadline is driven from, rather than against
   * `Date.now()`. That comparison was the one place in this package where a
   * real clock drove an assertion, and a coarse ceiling read from the wall is
   * evidence about the machine the test ran on, not about the bound.
   */
  now(): number;
  /** How many deadlines and sleeps are outstanding. Bounded, and assertable. */
  pending(): number;
  /** Every interval slept, in order. This is how a backoff sequence is tested. */
  slept(): readonly number[];
}

interface Waiter {
  readonly dueAt: number;
  readonly fire: () => void;
  cancelled: boolean;
}

/**
 * Adapter 2 — a **shipped deliverable**, not a mock, for the same reason
 * `inMemoryEvalNodeStore` and `scriptedModelBackend` are: it is what makes a
 * bounded-backoff assertion structural rather than a sleep in a test.
 *
 * It does not read a clock. Virtual time starts at zero and moves only when
 * `advance` is called, so a run driven by these timers spends no wall time and
 * a test can assert the exact sequence of intervals a bounded retry produced.
 */
export const manualTimers = (): ManualTimers => {
  let now = 0;
  const waiters: Waiter[] = [];
  const slept: number[] = [];

  const drain = (): void => {
    for (;;) {
      const due = waiters
        .filter((w) => !w.cancelled && w.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (due === undefined) return;
      due.cancelled = true;
      waiters.splice(waiters.indexOf(due), 1);
      due.fire();
    }
  };

  return {
    sleep(millis, signal) {
      slept.push(millis);
      if (signal.aborted || millis <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiter: Waiter = { dueAt: now + millis, fire: resolve, cancelled: false };
        waiters.push(waiter);
        signal.addEventListener(
          "abort",
          () => {
            if (waiter.cancelled) return;
            waiter.cancelled = true;
            resolve();
          },
          { once: true },
        );
      });
    },
    deadline(millis, onDue) {
      const waiter: Waiter = { dueAt: now + Math.max(0, millis), fire: onDue, cancelled: false };
      waiters.push(waiter);
      return () => {
        waiter.cancelled = true;
      };
    },
    advance(millis) {
      now += millis;
      drain();
    },
    now: () => now,
    pending: () => waiters.filter((w) => !w.cancelled).length,
    slept: () => [...slept],
  };
};
