# 0003 — Reserved decisions are enforced structurally and kept orthogonal to risk tier

**Status:** Accepted
**Date:** 2026-08-17

## Context

Some decisions must be made by a person, by law or by standing policy, whatever
the model concludes and however confident it is. `docs/CONTEXT.md` names these
**reserved decisions** and draws three consequences: confidence is never a
reason to skip one; reserved status is orthogonal to risk tier; and for a
reserved decision the correct unassisted containment is exactly **zero** — not
low, nil.

The concept entered the project from a question the user asked while reading the
containment framing — *aren't there parts where it's important humans don't
automate, functionally and legally?* — and `docs/CONTEXT.md` records that it is
the reason the containment argument could finally be settled: a number whose
target is *as high as possible* for some case types and *exactly zero* for
others is plainly not a scoreboard.

Two failure modes were in front of us, and both are ordinary organisational
behaviour rather than malice:

1. **Configuration.** If reserved status is a setting, it gets edited at 4pm on
   a Friday by someone chasing a throughput target. A preference that can be
   switched off is not an obligation.
2. **Merging with tier.** If reserved status is the top rung of the risk ladder,
   a business removes a legal obligation by adjusting a risk threshold, and the
   change looks like a routine tuning commit. A £50 decision may be reserved and
   a £2M decision may not be.

## Decision

**Reserved status is a separate seam, computed from separate facts, with no
override anywhere in the interface.**

Four mechanisms, all in
`packages/agent-ops-core/src/approval/lib/types.ts` and `lib/approval.ts`:

1. **`ReservedStatus` has no boolean and no `undefined` branch.** It is a
   discriminated union of *reserved with a rule, a citation and a policy
   version* and *not reserved with an explicit basis and a policy version*.
   "We checked and it is not reserved" and "nobody thought about it" cannot
   share a representation, and both are recorded as nodes.
2. **`ReservedPolicy` is its own seam, fed by its own extractor.** `CommonSpec`
   declares `tierFacts` and `reservedFacts` as two separate functions. The
   comment on `reservedFacts` states the reason in one line: merging it with
   `tierFacts` would let a risk-threshold change delete a legal obligation.
   `TierPolicy.classify` and `ReservedPolicy.screen` are two interfaces with two
   version strings.
3. **`DoNothing<R>` deletes the expiry branch when `R extends Reserved`.**
   `DoNothing<Reserved>` is `{ ladder }` and nothing else, so writing an expiry
   for a decision known to be reserved does not compile. Proved by a compile
   fixture, not asserted in prose:
   `approval/tests/fixtures/capability-rejected.ts` carries a
   `@ts-expect-error` on the `expire` property, and
   `approval/tests/typecheck.ts` compiles the fixture with this repository's own
   TypeScript under this repository's own strict settings and asserts the
   diagnostics. A fixture whose expected error *disappears* fails the test too,
   via `TS2578`.
4. **`ExpirySettlement` has exactly one arm, and it is not `approve`.** Even for
   a non-reserved gated decision, an expiry can only settle into
   `{ kind: "refuse" }`. "Nobody was on shift" is not a lawful basis for moving
   money at any tier.

Beyond the types, two runtime refusals and one alert:

- A point declaring `gate: "never"` whose policy returns reserved raises
  `ReservedStepMisdeclared`, records an `approval.halted` node, and throws.
- A reserved decision reaching a terminal state with
  `authorityTransferred: false` writes an
  `approval.reserved-completed-unassisted` node and raises the
  `reserved-decision-completed-unassisted` alert. `lib/approval.ts` documents
  why this check exists when the type system already forbids it, and the answer
  is the interesting part: two paths still reach it — the system **abstained**
  (a terminal verdict with no human on a decision a human was required to make)
  and the decision **proposed no effect** (the system concluded there was
  nothing to do and ended the case). The second is the quietest possible breach,
  because no money moved and nothing downstream notices.

There is no threshold, no configuration key, and no confidence value anywhere in
`approval` that makes a reserved decision automatic.

## Alternative rejected

**Reserved as the top risk tier — a fourth value on `Tier`, or a
`requiresHuman: true` flag on the tier table.**

The case for it is real and it is what most systems do. One ladder is simpler to
explain, simpler to configure, and simpler to render on a screen. Two orthogonal
classifications mean two policies to write per application, two versions to
track, and two facts extractors on every decision point — visible cost at
nineteen call sites.

Rejected because the merge makes the obligation adjustable by the people with
the strongest incentive to adjust it. Tier measures *consequence of error* and
is a business judgement that should be tuned. Reserved is a legal or policy
obligation and must not be. Merging them puts a statutory requirement behind a
number a team is measured on, and the resulting change is a one-line diff that
reads like tuning.

`docs/design/PHASE-2-INTERFACE-REVIEW.md` §2 recorded this as *"two seams, on
purpose, against the usual instinct to unify"*, and that is still the right
description of the cost.

## What would change our mind

Named, observable triggers:

1. **The two policies agree completely, in production, across applications.**
   If in three or more applications every reserved decision is also high tier
   and every high-tier decision is also reserved, sustained over a quarter with
   no counterexample, the orthogonality is a distinction the domain does not
   make and we are paying for it nineteen times.
2. **A statute or regulator requires a single documented classification per
   decision.** Same answer as risk tier in ADR 0004: satisfy it by deriving a
   combined classification for *reporting*, not by merging the enforcement.
3. **A lawful basis for a reserved decision to complete without an authority.**
   `docs/design/OPEN-ITEMS-RESOLVED.md` item 0 says we are not aware of one and
   would want to see the statute. That remains the position.

What would *not* change our mind: an application finding the two policies
tedious to write, or a model reaching a confidence high enough that a team
believes the human step is waste. Point 1 of `docs/CONTEXT.md`'s reserved entry
exists precisely to close that argument.

## Where the code diverges from the design documents

- **The compile-time deletion of `expire` only applies where reserved status is
  known statically, and in the normal flow it is not.** `DoNothing<R>` is the
  conditional type a caller uses when a point is reserved *by construction*. A
  `DecisionPointSpec` declares `doNothing: DoNothingConsequence` — the
  *declarable* form, which still carries an optional `expire`, because reserved
  status is computed per case by a policy that has not run at declaration time.
  When the policy returns reserved, the module **deletes the expiry at runtime**
  and records a node saying it did; `ServedDoNothing.expire` is `null`, and its
  comment states that it is always `null` for a reserved decision.

  This is a real weakening of the headline and it is stated here rather than
  smoothed: for a point that is *sometimes* reserved, the guarantee is a runtime
  override plus a recorded node, not a compile error. The compile error is
  available and tested, and it applies to points a caller declares as reserved
  up front.
- **`docs/design/PHASE-2-INTERFACE-REVIEW.md` §2 claims a reserved decision's
  handler "is registered against a type that has no automatic branch to
  return".** There is no `register` verb in the shipped module — see ADR 0006 —
  and the mechanism is the one described above instead.
