/**
 * Waiting is a dependency, not an ambient fact — the same argument as `Clock`,
 * for the same reason.
 *
 * A detector that never answers is an unbounded wait on the hot path of every
 * decision, twice. Bounding it needs something that can complete a promise on a
 * schedule, and if that something is `setTimeout` reached for directly then the
 * timeout path is untestable without real waiting, which means in practice it is
 * untested.
 *
 * `Timer` is **injected, not seamed**: `systemTimer` is the only shipped
 * adapter and a test supplies its own. Injection is a hermeticism requirement; a
 * seam is a place behaviour genuinely varies with a second shipped adapter.
 * Counting a fake timer as an adapter would let anyone call any injected
 * dependency a seam.
 */
export interface TimerHandle {
  /** Settles once the delay has elapsed. */
  readonly elapsed: Promise<void>;
  /** Releases the handle. Always called, on every path, including the win. */
  cancel(): void;
}

export interface Timer {
  wait(ms: number): TimerHandle;
}

/**
 * The only adapter that reads the machine's timers. Wire it at the composition
 * root.
 *
 * `unref` so a pending guardrail budget never holds a process open — a batch
 * job that has finished its work should exit, not linger for the tail of a
 * detector budget.
 */
export const systemTimer = (): Timer => ({
  wait(ms) {
    let done: () => void = () => {};
    const elapsed = new Promise<void>((resolve) => {
      done = resolve;
    });
    const handle = setTimeout(done, ms);
    if (typeof handle === "object" && handle !== null && "unref" in handle) {
      (handle as { unref(): void }).unref();
    }
    return {
      elapsed,
      cancel() {
        clearTimeout(handle);
        done();
      },
    };
  },
});
