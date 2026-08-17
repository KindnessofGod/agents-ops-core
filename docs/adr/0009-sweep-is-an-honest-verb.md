# 0009 — `sweep` is an honest entry point that drives time, and the shape rule that forbade it was wrong

**Status:** Accepted. **Reverses a constraint of the design exercise, not a
design.**
**Date:** 2026-08-17

## Context

`approval` owes a great deal of behaviour to the passage of time: expiry, the
escalation ladder and its recurrence, bounded backoff on brief delivery,
`AuthorityUnavailable` alerting, and idempotency-lease reclamation. The winning
design had two caller-initiated entry points — `run` and `answer` — and
**nothing drove any of it.** That is `approval/common-case` fatal flaw 5.

The `approval/minimal` author conceded the identical thing about their own
design, and their sentence is the whole argument:

> a scheduled sweeper hidden inside another verb `advance({ kind: "due" })`
> "because my assigned shape forbade a fourth entry point, **which is a rule
> about the deliverable rather than a fact about the module.**"

The design exercise imposed a 1–3 verb shape rule to force contrast between the
four shapes. The module needs more. Hiding the sweeper inside `answer` does not
remove it; it makes the interface lie about what the module does, which is the
opposite of what a verb budget is for.

## Decision

**An honest verb: `approval.sweep({ limit })`. Not hidden inside another verb.**

`packages/agent-ops-core/src/approval/lib/approval.ts`:

- **Bounded per invocation.** `sweep` takes a batch limit, clamped to
  `limits.sweepBatch`. There is no "process everything due".
- **Leases what it touches, with a TTL.** `acquireLease` is a compare-and-set on
  the lease that deliberately **does not touch `revision`**, so a sweeper
  holding a lease can still be raced out of its write by an `answer` that
  arrived in the same second. A sweeper dying mid-batch does not freeze the
  cases it claimed.
- **Idempotent and re-entrant.** Two sweepers running concurrently are safe —
  they will be, during a deploy. The ladder is pure functions over plain data in
  `lib/ladder.ts`; nothing in it owns a timer, holds state or reads a clock, so
  two sweepers computing the same schedule from the same record get the same
  answer. Lost races are counted (`skippedLeased`, `raceLost`) and recorded as
  `sweep.race-lost` nodes rather than swallowed.
- **Records its own nodes.** A ladder step firing is a recorded fact with a
  parent, like any other node.
- **The clock is injected**, so the whole of ageing is testable without waiting
  and without a real timer. Eleven days of ageing tests in eleven microseconds.
- **It emits a heartbeat on every run, including empty ones.** See ADR 0012 —
  that half belongs to alerting, and the watcher for it is external.

Two design choices about *when* the beat happens are worth recording because
both are counter-intuitive and both are in the code:

- **After the batch, not before it.** A beat on entry would prove the sweeper
  was started, not that it can complete a pass. A sweeper wedged on a store that
  never answers would beat forever while chasing nobody — a liveness signal that
  lies in the reassuring direction.
- **Not in a `finally`.** A sweep that threw did not complete a run, so it does
  not get to claim one. It goes overdue and an external watcher says so. A false
  alarm costs an operator five minutes; a missed one costs every waiting case.

The sweep also does one thing the resolution document did not anticipate:
**a kill-switch hold is revisited, not buried.** A held suspension keeps a due
time, the sweep keeps visiting it, and when the switch is found disengaged the
case returns to the first seat with the ladder restarted and the sealed answers
cleared. The effect is **never** taken on release — an approval given before an
incident was given against pre-incident evidence, and "the kill switch went off"
is not a lawful basis for moving money. The brief goes back out in the same
visit, because a case returned to the queue that nobody has been told about is
the silent failure this module is arranged against.

## Alternative rejected

**Hide the driver inside an existing verb, or let each application run its own
scheduler against a lower-level interface.**

Hiding it was rejected on the `approval/minimal` author's own reasoning: the
verb budget was a property of the exercise, and honouring it costs the interface
its honesty. A caller reading `answer(suspension, answer, ctx)` has no reason to
suspect that omitting a periodic call to it leaves every waiting case unchased.

Letting each application drive it was rejected for the reason the whole module
exists. `docs/design/PHASE-2-INTERFACE-REVIEW.md` records the ruling that the
library — not the caller — handles waiting on a human approval, "taken on
because the cost is a cliff rather than a slope: surviving one restart and
surviving a week cost the same, so nineteen partial implementations would be
strictly worse than one complete one." Exporting the driving would push the
cliff back to the callers with none of the leasing, bounding or race handling.

## What would change our mind

`docs/design/OPEN-ITEMS-RESOLVED.md` item 2 says **nothing plausible**, and that
is still right: every durable-suspension system needs something to drive time,
and hiding it does not remove it.

Two things would change the *shape* rather than the decision:

1. **An application whose deployment already runs a scheduler with its own
   liveness alerting.** That is satisfied today — `sweep` is called by whatever
   the application schedules, and the heartbeat watcher is external by design.
   It is not a waiver of the requirement.
2. **A sixth verb appearing.** `approval` is at five. If it reaches six, the
   module has stopped being one module and the right response is to split it,
   not to hide the sixth inside the fifth — which is exactly the error this ADR
   reverses.

## Where the code diverges from the design documents

Three divergences, all deliberate and all stated in `approval/index.ts` rather
than left for a reader to find.

1. **`sweep` takes a batch limit and reads `now` from the injected clock. It
   does not take `now` as a parameter**, as `docs/design/OPEN-ITEMS-RESOLVED.md`
   item 2 sketched (`approval.sweep(now)`). A module with two sources of time
   has two clocks, and they disagree on the day it matters. Ageing stays fully
   testable without waiting because the clock is a constructor parameter.
2. **"Four entry points beats three plus a lie" became five.** `Approval` is
   `run`, `answer`, `sweep`, `inDoubt` and `reconcile`. The fifth came from a
   problem none of the eight designs anticipated: a suspension and its trace node
   **cannot share a transaction** — `audit`'s interface exposes none, and a
   transaction spanning `decide` would hold a pooled connection open across a
   model call. So the link is written on both sides, a crash between the two
   writes loses a row rather than the link, and `reconcile` is the bounded query
   that finds the disagreement. That is a real weakening of durability, reported
   rather than dressed up: the window is **detectable and recoverable, not
   absent.**
3. **`reconcile` takes the cases to compare rather than discovering them.**
   Neither seam can enumerate cases — `audit` has no "list every trace" and
   should not — and a store scan would be an unbounded read of a seven-year
   archive. The application holds its own open cases and passes them in,
   bounded.
