/**
 * Preemption: the third `Detector` adapter, and the one that can actually stop.
 *
 * ## The reversal, named
 *
 * `lib/safe-pattern.ts` argued at length that a worker thread was **the wrong
 * trade** for closing this residual. That position is reversed here, and the
 * reversal is worth stating plainly rather than quietly shipping the opposite of
 * what the module says.
 *
 * The old argument was: bounding a scan this way means copying the caller's
 * unredacted payload into a second heap this module cannot freeze, deep-copy or
 * prove it has released — to bound a stall that is already bounded. Every clause
 * of that is still true. What changed is the weight of the other side. "Already
 * bounded" is doing more work in that sentence than it can carry: the bound is
 * `maxFieldChars²` *character comparisons for a pattern the analyser can reason
 * about*, and the analyser's own documentation says it cannot prove a pattern
 * linear. `a*a*a*b` carries no backreference, no alternation and no quantified
 * group; the analyser accepts it, correctly by its own rules; and it is
 * superpolynomial. Two hundred characters cost hundreds of milliseconds and two
 * thousand cost hours. A bound nobody can compute in advance is not a bound, and
 * an event loop held for an unknown period on the hot path of every decision is
 * not a stall a regulated deployment should be asked to accept.
 *
 * So the trade is taken, and the old objection is what shapes how:
 *
 *   - **Opt-in per detector.** A worker round trip is tens of microseconds
 *     against a pattern that finishes in one. `deterministicDetector` remains
 *     the default and is untouched; a deployment reaches for this one where it
 *     screens caller-controlled free text at length, and pays for it there only.
 *   - **A bounded pool, never a worker per screening.** A hard ceiling on
 *     workers, a bounded queue in front of them, a bounded heap inside each, and
 *     a bounded number of tasks before one is retired.
 *   - **The timeout terminates the thread.** Rejecting a promise while a thread
 *     spins forever is the failure this exists to fix, so `Worker.terminate` is
 *     called and awaited, and the slot's worker is discarded rather than reused.
 *   - **Only the configured fields cross, and only coordinates come back.** A
 *     worker returns `{rule, field, start, length}` and integers. No matched
 *     text ever crosses back, so the redaction contract is unchanged.
 *
 * ## What still crosses, stated rather than implied
 *
 * The text of the fields this detector is configured for exists in a second heap
 * for the duration of the scan. This module cannot freeze that heap, cannot
 * deep-copy out of it, and cannot prove when the runtime released it. Four
 * things shrink the window and none of them closes it: only configured fields
 * are sent; the worker drops its reference as soon as it has replied; a worker
 * is retired after `maxTasksPerWorker` tasks, which destroys the heap outright;
 * and a preempted worker is terminated immediately, which destroys it sooner.
 * That residue is the price of preemption. It is why this is opt-in per
 * detector rather than the default, and it is the sentence to put in front of a
 * data-protection officer before wiring it onto a field carrying health data.
 *
 * ## Named error modes, every one fail-closed
 *
 * Guardrails fail closed at every tier with no configuration key that changes
 * it, and this adapter inherits that without exception. Each failure below
 * yields `unavailable` — which the engine turns into a screening that recommends
 * abstain — and never a `searched-and-found-none` that would read like a clean
 * payload:
 *
 *   `pool-closed`          The pool was shut down and a screening arrived after.
 *                          Fail-closed. A screening after shutdown is a wiring
 *                          or lifecycle defect, and answering it from a pool
 *                          that no longer exists would be a search nobody ran.
 *   `pool-saturated`       Every worker is busy and the queue is full.
 *                          Fail-closed. The alternative is an unbounded queue,
 *                          which converts a slow detector into a memory incident
 *                          and delays every screening behind it. Refusing to
 *                          look is the honest answer and the cheap one.
 *   `queued-past-budget`   The task waited for a worker until its budget was
 *                          spent and never started. Fail-closed, and it is
 *                          removed from the queue so a freed worker does not
 *                          later run work nobody is waiting for.
 *   `preempted`            The scan overran its budget and the worker was
 *                          terminated. Fail-closed. **This is the condition the
 *                          adapter exists for** — the answer is refused *and*
 *                          the work is stopped.
 *   `worker-spawn-failed`  A worker could not be started at all — a runtime
 *                          without `node:worker_threads`, or a process out of
 *                          threads. Fail-closed.
 *   `worker-errored`       The worker threw outside a scan. Fail-closed, and the
 *                          worker is discarded rather than reused.
 *   `worker-exited`        The worker died mid-scan — a heap ceiling reached, or
 *                          an external kill. Fail-closed.
 *   `match-limit`          One scan matched more sites than `maxMatchesPerScan`.
 *                          Fail-closed, and the reason is redaction rather than
 *                          memory: reporting the first thousand sites and masking
 *                          only those would write the rest of the payload into a
 *                          seven-year archive unmasked. A partial redaction that
 *                          reads as a successful one is precisely the failure
 *                          this module exists to prevent.
 *   `scan-failed`          The worker could not build or run a pattern.
 *                          Fail-closed; a defect rather than an outage, and the
 *                          detail names the rule.
 *   `reply-unrecognised`   A reply arrived that does not match the task it
 *                          answers. Fail-closed. A stale reply from a recycled
 *                          worker answering the wrong payload is the one way this
 *                          design could report findings at coordinates in
 *                          somebody else's text, so it is refused outright.
 *
 * All of them are reported to the engine as `unavailable` with
 * `reason: "declared"`, because a detector may only ever say that its own
 * dependency failed. `"timed-out"` and `"malformed"` are the engine's
 * observations *about* a detector and a detector must not be able to claim them
 * — see `lib/screening.ts`. A worker is this adapter's dependency, so a
 * terminated worker is a declared outage, and the detail names which one.
 *
 * ## Not a seam
 *
 * `ScanPool` has one construction, `preemptiveScanPool`, and there is no second
 * one named. It is a bounded resource, not a place behaviour is meant to vary,
 * and the tests use the real thing because a worker thread is local: there is no
 * live model, no database and no pager to reach, so no fake is needed and none
 * is shipped. Counting it as a seam would be exactly the fudge the seam rule
 * forbids.
 *
 * `preemptiveDetector` **is** a third adapter behind the `Detector` seam, and
 * that is not a fudge either: it shares the shipped pattern packs as content but
 * shares none of its behaviour with `deterministicDetector`. Its failure modes —
 * saturation, preemption, worker death — do not exist in the in-process adapter
 * and cannot be produced by it.
 */

import { Worker } from "node:worker_threads";
import { checkCoverage, type CoverageCategory, type DetectorCoverage } from "./coverage.js";
import { DEFAULT_MAX_MATCHES_PER_SCAN } from "./detectors.js";
import { LimitsInvalid, ScanPoolInvalid } from "./errors.js";
import { assertPatternSafe, type Pattern } from "./safe-pattern.js";
import type { DeterministicDetectorSpec } from "./detectors.js";
import type { Timer } from "./timer.js";
import type {
  Detector,
  DetectorId,
  DetectorReport,
  FindingDraft,
  Locale,
  NonEmpty,
  ScreeningSubject,
} from "./types.js";

/**
 * How a scan is asked for. Private: reachable only from `preemptiveDetector`,
 * behind a symbol this module does not export, so a caller cannot run a scan
 * outside a screening. Same argument as the absent `redact` and `runDetector`
 * verbs on `Guardrails` — a detector cannot be run except through a screening.
 */
const SCAN: unique symbol = Symbol("guardrails.scan");

interface ScanField {
  readonly name: string;
  readonly text: string;
}

interface ScanPattern {
  readonly rule: string;
  readonly source: string;
  readonly flags: string;
}

interface ScanRequest {
  readonly fields: readonly ScanField[];
  readonly patterns: readonly ScanPattern[];
  readonly maxMatches: number;
  /** Milliseconds. Clamped to the pool's own `maxTimeoutMs`. */
  readonly timeoutMs: number;
}

interface ScanHit {
  readonly rule: string;
  readonly field: string;
  readonly start: number;
  readonly length: number;
}

/** Every failure mode this pool can produce. All fail-closed. See the header. */
export type ScanFailure =
  | "pool-closed"
  | "pool-saturated"
  | "queued-past-budget"
  | "preempted"
  | "worker-spawn-failed"
  | "worker-errored"
  | "worker-exited"
  | "match-limit"
  | "scan-failed"
  | "reply-unrecognised";

type ScanOutcome =
  | { readonly ok: true; readonly hits: readonly ScanHit[]; readonly examined: readonly string[] }
  | { readonly ok: false; readonly failure: ScanFailure; readonly detail: string };

/**
 * What an operator can see, and what a test can prove.
 *
 * Counts only — no payload, no field names, no correlation identifier. A pool is
 * shared across every case screened through it, so anything case-shaped here
 * would be a personal-data leak into whatever a deployment does with these
 * numbers.
 */
export interface ScanPoolStats {
  /** The configured ceiling on workers. */
  readonly maxWorkers: number;
  /** Workers alive right now. Never above `maxWorkers`. */
  readonly alive: number;
  /** Slots busy right now. */
  readonly busy: number;
  /** Tasks waiting for a slot right now. Never above `maxQueued`. */
  readonly queued: number;
  /** Workers started since construction. */
  readonly spawned: number;
  /** Scans that returned an answer, found or not. */
  readonly completed: number;
  /** `Worker.terminate` calls: preemptions, retirements and shutdown. */
  readonly terminated: number;
  /** Scans stopped by terminating their worker. The number that matters. */
  readonly preempted: number;
  /** Workers retired at `maxTasksPerWorker`, bounding how long a heap lives. */
  readonly retired: number;
  /** Scans refused because every worker was busy and the queue was full. */
  readonly saturated: number;
  /** Scans that failed for any reason. Every one of them failed closed. */
  readonly failed: number;
}

/**
 * A bounded set of worker threads that can be stopped mid-scan.
 *
 * Constructed once at the composition root and shared by every detector that
 * wants preemption, exactly as `Clock` and `Timer` are. `close()` belongs in
 * whatever the deployment calls shutdown: an unclosed pool holds threads, and a
 * process that will not exit is an operational incident of its own.
 */
export interface ScanPool {
  stats(): ScanPoolStats;
  /** Idempotent. Terminates every worker and fails every queued scan closed. */
  close(): Promise<void>;
  /** @internal Reachable only from `preemptiveDetector`. */
  readonly [SCAN]: (request: ScanRequest) => Promise<ScanOutcome>;
}

export interface ScanPoolSpec {
  /**
   * Injected, never constructed. The pool's timeout is the one thing in this
   * file that must be able to fire against real time in production and against a
   * test's own timer in a test, and this module reads no machine clock.
   */
  readonly timer: Timer;
  /** Hard ceiling on worker threads. 1..64. There is no unbounded setting. */
  readonly maxWorkers: number;
  /**
   * How many scans may wait for a worker. `0` means none: refuse immediately.
   *
   * A queue is not resilience past a point — it converts a slow detector into a
   * memory incident and delays every screening behind it. Screening is on the
   * hot path of a decision, so a short queue and a fast refusal beat a long
   * queue and a slow one.
   */
  readonly maxQueued: number;
  /**
   * Tasks a worker runs before it is retired and replaced.
   *
   * This is a personal-data bound rather than a memory one: a retired worker's
   * heap — and the caller text in it — is destroyed outright.
   */
  readonly maxTasksPerWorker: number;
  /**
   * Old-generation heap ceiling per worker, in megabytes. A worker that exceeds
   * it dies, which this pool reports as `worker-exited` and fails closed.
   */
  readonly maxHeapMb: number;
  /**
   * The longest any single scan may run, whatever budget a screening passes
   * down. The last bound: a caller who configures a ten-minute detector budget
   * should not get a ten-minute thread.
   */
  readonly maxTimeoutMs: number;
}

/**
 * The scanner, as source rather than as a file.
 *
 * A worker started from a string carries no import of this package, so it cannot
 * reach a store, a clock, a classifier or the network even by accident — the
 * hermetic guarantee holds inside the thread as well as outside it. It also
 * behaves identically under the compiled package and under a test runner reading
 * TypeScript, which a `new URL("./scan-worker.js", import.meta.url)` would not:
 * there is no such file in `src/`, so the path that ships would be a path no
 * test ever executes.
 *
 * It is deliberately tiny, and everything it does is bounded except the one
 * thing that cannot be — the scan itself, which is the entire point of running
 * it here.
 */
const WORKER_SOURCE = `
"use strict";
const { parentPort } = require("node:worker_threads");
if (parentPort === null) throw new Error("guardrails scan worker started with no port");
parentPort.on("message", function (task) {
  var hits = [];
  var scans = 0;
  try {
    for (var f = 0; f < task.fields.length; f += 1) {
      var field = task.fields[f];
      for (var p = 0; p < task.patterns.length; p += 1) {
        var pattern = task.patterns[p];
        var flags = pattern.flags.indexOf("g") === -1 ? pattern.flags + "g" : pattern.flags;
        var re = new RegExp(pattern.source, flags);
        var m;
        while ((m = re.exec(field.text)) !== null) {
          if (m[0].length === 0) { re.lastIndex += 1; continue; }
          if (hits.length >= task.maxMatches) {
            parentPort.postMessage({
              token: task.token, ok: false, failure: "match-limit",
              detail: "rule " + pattern.rule + " matched more than " + task.maxMatches + " sites",
            });
            return;
          }
          hits.push({ rule: pattern.rule, field: field.name, start: m.index, length: m[0].length });
        }
        scans += 1;
      }
    }
  } catch (cause) {
    parentPort.postMessage({
      token: task.token, ok: false, failure: "scan-failed",
      detail: cause && cause.message ? String(cause.message) : "scan failed",
    });
    return;
  }
  var examined = [];
  for (var i = 0; i < task.fields.length; i += 1) examined.push(task.fields[i].name);
  parentPort.postMessage({ token: task.token, ok: true, hits: hits, scans: scans, examined: examined });
  hits = null;
});
`;

interface Slot {
  worker: Worker | undefined;
  tasks: number;
}

interface Waiter {
  resolve(slot: Slot | undefined): void;
  cancelled: boolean;
}

/** Distinguishes "the timer won" from any value a scan could legitimately return. */
const EXPIRED: unique symbol = Symbol("expired");

const checkBound = (setting: string, value: number, low: number, high: number): void => {
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    throw new ScanPoolInvalid(setting, value, `must be a whole number from ${low} to ${high}`);
  }
};

/**
 * The one construction. Bounded on five axes, every one required and every one
 * range-checked here rather than at screening time — a pool misconfigured to
 * four thousand threads should fail at boot, which is the loudest cheap place to
 * put it.
 */
export const preemptiveScanPool = (spec: ScanPoolSpec): ScanPool => {
  checkBound("maxWorkers", spec.maxWorkers, 1, 64);
  checkBound("maxQueued", spec.maxQueued, 0, 4_096);
  checkBound("maxTasksPerWorker", spec.maxTasksPerWorker, 1, 1_000_000);
  checkBound("maxHeapMb", spec.maxHeapMb, 8, 4_096);
  checkBound("maxTimeoutMs", spec.maxTimeoutMs, 1, 600_000);
  if (typeof spec.timer?.wait !== "function") {
    throw new ScanPoolInvalid("timer", spec.timer, "must be an injected Timer");
  }

  const slots: Slot[] = [];
  const idle: Slot[] = [];
  const waiting: Waiter[] = [];
  let closed = false;
  let token = 0;

  const counts = {
    spawned: 0,
    completed: 0,
    terminated: 0,
    preempted: 0,
    retired: 0,
    saturated: 0,
    failed: 0,
  };

  const spawn = (): Worker =>
    new Worker(WORKER_SOURCE, {
      eval: true,
      // The heap ceiling. A worker that breaches it exits, which this pool
      // reports as `worker-exited` and fails closed — bounded memory rather than
      // a process the operating system decides to kill at an arbitrary moment.
      resourceLimits: { maxOldGenerationSizeMb: spec.maxHeapMb },
      // Nothing is read from the parent's environment. A worker that could see
      // credentials would be a second place this package might reach a live
      // dependency, and there is deliberately no first.
      env: {},
    });

  const destroy = async (slot: Slot): Promise<void> => {
    const worker = slot.worker;
    slot.worker = undefined;
    slot.tasks = 0;
    if (worker === undefined) return;
    counts.terminated += 1;
    try {
      await worker.terminate();
    } catch {
      // A worker that has already gone is the state we wanted. Nothing here can
      // fail in a way a screening should hear about.
    }
  };

  /** Hand the slot to the next waiter, or park it. Never grows either list. */
  const release = (slot: Slot): void => {
    for (;;) {
      const next = waiting.shift();
      if (next === undefined) break;
      if (next.cancelled) continue;
      next.resolve(slot);
      return;
    }
    slot.worker?.unref();
    idle.push(slot);
  };

  type Admission =
    | { readonly kind: "slot"; readonly slot: Slot }
    | { readonly kind: "saturated" }
    | { readonly kind: "queued"; readonly waiter: Waiter; readonly slot: Promise<Slot | undefined> };

  const acquire = (): Admission => {
    const free = idle.pop();
    if (free !== undefined) return { kind: "slot", slot: free };
    if (slots.length < spec.maxWorkers) {
      const slot: Slot = { worker: undefined, tasks: 0 };
      slots.push(slot);
      return { kind: "slot", slot };
    }
    if (waiting.length >= spec.maxQueued) return { kind: "saturated" };
    let settle: (slot: Slot | undefined) => void = () => {};
    const promise = new Promise<Slot | undefined>((resolve) => {
      settle = resolve;
    });
    const waiter: Waiter = { resolve: settle, cancelled: false };
    waiting.push(waiter);
    return { kind: "queued", waiter, slot: promise };
  };

  const readReply = (reply: unknown, expect: number): ScanOutcome => {
    if (reply === null || typeof reply !== "object") {
      return { ok: false, failure: "reply-unrecognised", detail: `reply is ${typeof reply}` };
    }
    const message = reply as {
      token?: unknown;
      ok?: unknown;
      hits?: unknown;
      examined?: unknown;
      failure?: unknown;
      detail?: unknown;
    };
    if (message.token !== expect) {
      // A reply to a task nobody is waiting for would carry coordinates into
      // somebody else's text. Refused outright rather than reconciled.
      return { ok: false, failure: "reply-unrecognised", detail: "reply answers another scan" };
    }
    if (message.ok !== true) {
      return {
        ok: false,
        failure: message.failure === "match-limit" ? "match-limit" : "scan-failed",
        detail: typeof message.detail === "string" ? message.detail : "no detail",
      };
    }
    if (!Array.isArray(message.hits) || !Array.isArray(message.examined)) {
      return { ok: false, failure: "reply-unrecognised", detail: "reply carries no hit list" };
    }
    return {
      ok: true,
      hits: message.hits as readonly ScanHit[],
      examined: message.examined as readonly string[],
    };
  };

  const runOn = async (
    slot: Slot,
    request: ScanRequest,
    expiry: Promise<typeof EXPIRED>,
  ): Promise<ScanOutcome> => {
    if (slot.worker === undefined) {
      try {
        const fresh = spawn();
        counts.spawned += 1;
        // A worker that dies while parked leaves a handle nothing would notice
        // until the next scan posted into the void and waited out its whole
        // budget. This clears the slot the moment the thread goes, whoever ended
        // it, so the next scan spawns rather than talks to a corpse.
        fresh.once("exit", () => {
          if (slot.worker === fresh) {
            slot.worker = undefined;
            slot.tasks = 0;
          }
        });
        slot.worker = fresh;
      } catch (cause) {
        return {
          ok: false,
          failure: "worker-spawn-failed",
          detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : "spawn failed",
        };
      }
    }
    const worker = slot.worker;
    worker.ref();
    token += 1;
    const mine = token;

    const answered = new Promise<ScanOutcome>((resolve) => {
      const done = (outcome: ScanOutcome): void => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        resolve(outcome);
      };
      const onMessage = (reply: unknown): void => {
        done(readReply(reply, mine));
      };
      const onError = (cause: Error): void => {
        done({ ok: false, failure: "worker-errored", detail: `${cause.name}: ${cause.message}` });
      };
      const onExit = (code: number): void => {
        done({ ok: false, failure: "worker-exited", detail: `worker exited with code ${code}` });
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage({
        token: mine,
        fields: request.fields,
        patterns: request.patterns,
        maxMatches: request.maxMatches,
      });
    });

    const outcome = await Promise.race([answered, expiry]);
    if (outcome === EXPIRED) {
      // **The whole reason this file exists.** Not a rejected promise beside a
      // thread that spins on: the thread is stopped, and the heap holding the
      // caller's text goes with it.
      counts.preempted += 1;
      await destroy(slot);
      return {
        ok: false,
        failure: "preempted",
        detail: `scan terminated after ${request.timeoutMs}ms`,
      };
    }
    if (!outcome.ok && (outcome.failure === "worker-errored" || outcome.failure === "worker-exited")) {
      await destroy(slot);
      return outcome;
    }
    slot.tasks += 1;
    if (slot.tasks >= spec.maxTasksPerWorker) {
      counts.retired += 1;
      await destroy(slot);
    }
    return outcome;
  };

  const scan = async (request: ScanRequest): Promise<ScanOutcome> => {
    if (closed) {
      counts.failed += 1;
      return { ok: false, failure: "pool-closed", detail: "the scan pool is shut down" };
    }
    const timeoutMs = Math.min(Math.max(1, Math.ceil(request.timeoutMs)), spec.maxTimeoutMs);
    const handle = spec.timer.wait(timeoutMs);
    const expiry: Promise<typeof EXPIRED> = handle.elapsed.then(() => EXPIRED);
    let slot: Slot | undefined;
    try {
      const admitted = acquire();
      if (admitted.kind === "saturated") {
        counts.saturated += 1;
        counts.failed += 1;
        return {
          ok: false,
          failure: "pool-saturated",
          detail: `all ${spec.maxWorkers} workers busy and ${spec.maxQueued} queued`,
        };
      }
      if (admitted.kind === "queued") {
        const got = await Promise.race([admitted.slot, expiry]);
        if (got === EXPIRED) {
          // Removed from the queue, so a freed worker is not later handed work
          // nobody is waiting for.
          admitted.waiter.cancelled = true;
          counts.failed += 1;
          return {
            ok: false,
            failure: "queued-past-budget",
            detail: `waited ${timeoutMs}ms for a worker and never started`,
          };
        }
        if (got === undefined) {
          counts.failed += 1;
          return { ok: false, failure: "pool-closed", detail: "the scan pool shut down while queued" };
        }
        slot = got;
      } else {
        slot = admitted.slot;
      }
      const outcome = await runOn(slot, { ...request, timeoutMs }, expiry);
      if (outcome.ok) counts.completed += 1;
      else counts.failed += 1;
      return outcome;
    } finally {
      handle.cancel();
      if (slot !== undefined) release(slot);
    }
  };

  return {
    [SCAN]: scan,
    stats() {
      return {
        maxWorkers: spec.maxWorkers,
        alive: slots.filter((s) => s.worker !== undefined).length,
        busy: slots.length - idle.length,
        queued: waiting.filter((w) => !w.cancelled).length,
        spawned: counts.spawned,
        completed: counts.completed,
        terminated: counts.terminated,
        preempted: counts.preempted,
        retired: counts.retired,
        saturated: counts.saturated,
        failed: counts.failed,
      };
    },
    async close() {
      closed = true;
      for (const waiter of waiting.splice(0)) {
        if (!waiter.cancelled) waiter.resolve(undefined);
      }
      idle.splice(0);
      await Promise.all(slots.map(async (slot) => destroy(slot)));
      slots.splice(0);
    },
  };
};

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface PreemptiveDetectorSpec extends DeterministicDetectorSpec {
  /** The pool this detector's scans run in. Injected; shared; never constructed. */
  readonly pool: ScanPool;
}

/**
 * Adapter 3. The same pattern packs, run somewhere that can be stopped.
 *
 * Identical in what it reports to `deterministicDetector` — coordinates,
 * integers and the fields it examined — and identical in the coverage it
 * derives from its patterns, so a deployment can swap one for the other on a
 * field without changing what a 2033 reader sees except the detector identifier
 * and the failure modes.
 *
 * Where it differs is everything about failure: a scan can be preempted, refused
 * for saturation, or lost with its worker, and every one of those is
 * fail-closed. See the header for the full list with its reasons.
 */
export const preemptiveDetector = (spec: PreemptiveDetectorSpec): Detector => {
  // A cast can defeat the brand; it cannot defeat this. Refused at boot,
  // exactly as the in-process adapter refuses it — a worker bounds the cost of a
  // catastrophic pattern and does not make one acceptable.
  for (const pattern of spec.patterns) assertPatternSafe(pattern);

  const maxMatches = spec.maxMatchesPerScan ?? DEFAULT_MAX_MATCHES_PER_SCAN;
  if (!Number.isSafeInteger(maxMatches) || maxMatches < 1) {
    throw new LimitsInvalid("maxMatchesPerScan" as never, maxMatches);
  }

  const covers = [...new Set(spec.patterns.map((p) => p.covers))].sort() as unknown as NonEmpty<CoverageCategory>;
  const declares: DetectorCoverage = {
    covers,
    ...(spec.partial === undefined ? {} : { partial: spec.partial }),
    ...(spec.doesNotCover === undefined ? {} : { doesNotCover: spec.doesNotCover }),
  };
  checkCoverage(spec.id, declares);

  const confidence = new Map<string, Pattern>(spec.patterns.map((p) => [p.rule, p]));
  const wire: readonly ScanPattern[] = spec.patterns.map((p) => ({
    rule: p.rule,
    source: p.match.source,
    flags: p.match.flags,
  }));

  return {
    id: spec.id as DetectorId,
    costClass: "deterministic",
    locales: spec.locales as unknown as NonEmpty<Locale>,
    searches: spec.searches,
    declares,
    async screen(subject: ScreeningSubject): Promise<DetectorReport> {
      // The engine's own deadline, checked before anything crosses into a second
      // heap. A budget already spent is not a reason to copy a payload anywhere.
      if (subject.deadline.expired()) {
        return {
          outcome: "unavailable",
          reason: "declared",
          detail: "budget spent before the scan was dispatched",
          costTenthCents: 0,
          modelCalls: 0,
        };
      }
      const requested = spec.fields ?? Object.keys(subject.fields);
      // Only the configured fields cross. Everything else stays in this heap,
      // which is the cheapest of the four things that shrink the residue above.
      const fields: ScanField[] = [];
      for (const name of requested) {
        const text = subject.fields[name];
        if (typeof text === "string") fields.push({ name, text });
      }
      const outcome = await spec.pool[SCAN]({
        fields,
        patterns: wire,
        maxMatches,
        timeoutMs: Math.max(1, Math.ceil(subject.budgetMicros / 1000)),
      });
      if (!outcome.ok) {
        return {
          outcome: "unavailable",
          // A detector may only ever declare that its own dependency failed.
          // A worker is this adapter's dependency; `timed-out` and `malformed`
          // belong to the engine. The failure name travels in the detail.
          reason: "declared",
          detail: `${outcome.failure}: ${outcome.detail}`,
          costTenthCents: 0,
          modelCalls: 0,
        };
      }
      const drafts: FindingDraft[] = outcome.hits.map((hit) => ({
        category: spec.category,
        severity: spec.severity,
        rule: hit.rule,
        at: { field: hit.field, startCodeUnit: hit.start, lengthCodeUnits: hit.length },
        confidenceBasisPoints: confidence.get(hit.rule)?.confidenceBasisPoints ?? 0,
      }));
      return drafts.length === 0
        ? {
            outcome: "searched-and-found-none",
            costTenthCents: 0,
            modelCalls: 0,
            examinedFields: outcome.examined,
          }
        : {
            outcome: "found",
            findings: drafts as unknown as NonEmpty<FindingDraft>,
            costTenthCents: 0,
            modelCalls: 0,
            examinedFields: outcome.examined,
          };
    },
  };
};
