# 0016 — A detector stall is preempted with a worker thread, reversing this module's earlier position

**Status:** Accepted. **Reverses a position previously argued at length in
`guardrails`.**
**Date:** 2026-08-17

## Context

`guardrails` refuses every regular expression `safePattern` can prove capable of
exponential backtracking. It cannot prove a pattern *linear*, and it says so in
its own documentation — so it accepts patterns whose cost is polynomial or
worse. `a*a*a*b` is accepted, correctly by its own rules, and costs roughly
132ms over 180 characters, ~40 seconds over 800, and hours over 2,000.

A synchronous `screen` never yields, so no in-process timer can interrupt it.
This was an unbounded event-loop stall on the hot path of every decision, twice
per decision.

**What this module used to say about it**, in `lib/safe-pattern.ts`,
`lib/detectors.ts`, `lib/limits.ts`, `lib/types.ts` and `index.ts`: that a
worker thread was the wrong trade, and that the stall was acceptable because it
was "bounded by `maxFieldChars²`".

**That premise was wrong.** A module that cannot prove a pattern linear cannot
put a number on what it accepts. `maxFieldChars²` was an assertion about
patterns nobody had characterised, and the measured numbers above are not
quadratic in any useful sense.

## Decision

Ship a **third `Detector` adapter**: `preemptiveDetector` over
`preemptiveScanPool`, built on `node:worker_threads`. Opt-in per detector.

Everything about it is bounded: a hard worker ceiling of 1–64, a bounded queue,
a bounded per-worker heap via `resourceLimits`, a bounded worker lifetime via
`maxTasksPerWorker`, and a bounded per-scan timeout. **The timeout calls and
awaits `Worker.terminate()`** — the thread is stopped, not a promise rejected
beside a thread that is still spinning. That distinction is the whole design,
and it was measured before anything was built: a worker stuck in `a*a*a*b` over
3,000 characters terminated in 3ms with the main thread surviving.

Ten new failure modes, all fail-closed with no configuration key that changes
it: `pool-closed`, `pool-saturated`, `queued-past-budget`, `preempted`,
`worker-spawn-failed`, `worker-errored`, `worker-exited`, `match-limit`,
`scan-failed`, `reply-unrecognised`. All reach the engine as `unavailable /
reason: "declared"`, because a detector may only ever declare that its own
dependency failed — `timed-out` and `malformed` are the *engine's* observations
about a detector, and a detector must not be able to claim them about itself.

`reply-unrecognised` is worth naming separately: a stale reply from a recycled
worker answering a different payload is the one way this design could report
findings at coordinates in someone else's text. Every reply carries a task
token, and a mismatch is refused outright rather than reconciled.

## The alternative rejected

**Keep the in-process detector as the only adapter and tighten
`maxFieldChars`.** Rejected because it does not bound anything: the cost is a
property of the pattern, not only of the field length, and the module has
already admitted it cannot characterise an accepted pattern. Shrinking the input
trades a stall for under-screening — the fields that get truncated are the long
free-text ones most likely to contain a name.

## What survives of the old objection

The reversal is partial, and the part that stands is the *shape*: opt-in per
detector, bounded on every axis, and an explicit statement of what crosses into
the second heap and for how long.

**The residual is real and is not closed.** The configured fields' text lives in
a heap this module cannot freeze, deep-copy or prove it has released. Four
things shrink the window — only configured fields cross, the worker drops its
reference on reply, workers retire at `maxTasksPerWorker`, a preempted worker is
terminated immediately — and **none of them closes it**. That is precisely why
the adapter is opt-in and not the default, and it is item 5 of `README.md`'s gap
list rather than a footnote.

Two further limits, stated rather than smoothed:

- A caller-supplied detector that neither awaits, nor reads its deadline, nor
  runs in a pool is still bounded by nothing this module can offer. Its
  **answer** is refused on time; its **work** is not.
- `preemptiveScanPool` requires the deployment to call `close()` at shutdown.
  Idle workers are unref'd so a process can still exit, but an unclosed pool
  holds threads, and that is not enforceable from here.

## Consequences

- `Detector` now has **three** adapters and was already a real seam at two. The
  third is counted straight, because its failure modes cannot be produced by the
  in-process one.
- `ScanPool` is explicitly marked **not** a seam: one construction, no second
  named, a bounded resource rather than a place behaviour varies.
- The worker body is an inlined source string run with `{ eval: true, env: {} }`
  rather than a separate `scan-worker.js`. Two load-bearing reasons: a worker
  started from a string carries no import of this package, so it cannot reach a
  store, a clock, a classifier or the network even by accident — the hermetic
  guarantee holds *inside* the thread; and `new URL('./scan-worker.js',
  import.meta.url)` would resolve under `src/` to a file that does not exist, so
  the path that shipped would be a path no test ever executed.
- `ScanPoolInvalid` is a separate error class from `LimitsInvalid` on purpose.
  `Limits` bounds arithmetic in this process; these bound threads, heaps and a
  queue. `maxWorkers: 4096` is not a wrong answer, it is a machine that stops
  responding.
