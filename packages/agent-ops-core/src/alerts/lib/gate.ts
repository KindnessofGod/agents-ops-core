/**
 * The bound on concurrent deliveries.
 *
 * Nothing in this module is allowed to be unbounded, and the alerting path is
 * the last place to make an exception: a storm of conditions is exactly when the
 * process is already in trouble, and an unbounded fan-out of sink calls at that
 * moment turns an incident into an outage caused by the incident reporting.
 *
 * Two bounds, both required:
 *
 *   - `maxInFlight` — how many chain walks run at once.
 *   - `maxQueued` — how many raises may *wait* for a slot. Waiting is bounded
 *     too, because an unbounded waiting room is an unbounded queue wearing a
 *     politer name.
 *
 * When both are full, `enter` resolves `false` **immediately** rather than
 * waiting. The caller then records the alert as `delivery-queue-full` in the
 * last-resort ledger, which `health()` publishes. Shedding is not silent: it is
 * counted, ledgered, and returned to the caller. A shed alert that nobody could
 * find out about would be the module failing at its own subject.
 *
 * FIFO, so a storm does not starve the alert that arrived first — which, in a
 * cascade, is usually the cause and not a symptom.
 */

export interface DeliveryGate {
  /** `true` when a slot was taken (release it), `false` when the queue is full. */
  enter(): Promise<boolean>;
  /** Give the slot back, handing it to the longest-waiting caller if any. */
  leave(): void;
  inFlight(): number;
  queued(): number;
  /** The highest concurrent in-flight count since construction. */
  highWater(): number;
}

export const deliveryGate = (limits: {
  readonly maxInFlightDeliveries: number;
  readonly maxQueuedRaises: number;
}): DeliveryGate => {
  const waiting: ((admitted: boolean) => void)[] = [];
  let inFlight = 0;
  let highWater = 0;

  const take = (): void => {
    inFlight += 1;
    if (inFlight > highWater) highWater = inFlight;
  };

  return {
    enter() {
      if (inFlight < limits.maxInFlightDeliveries) {
        take();
        return Promise.resolve(true);
      }
      if (waiting.length >= limits.maxQueuedRaises) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        waiting.push(resolve);
      });
    },
    leave() {
      const next = waiting.shift();
      if (next !== undefined) {
        // The slot is handed straight over; `inFlight` never dips, so the bound
        // holds across the handoff rather than briefly admitting one extra.
        next(true);
        return;
      }
      inFlight -= 1;
    },
    inFlight: () => inFlight,
    queued: () => waiting.length,
    highWater: () => highWater,
  };
};
