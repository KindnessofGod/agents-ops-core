# 0017 — The abstention rate is watched by `approval`, and the duplication that causes is accepted

**Status:** Accepted
**Date:** 2026-08-17

## Context

`docs/CONTEXT.md`'s eighth silent condition is *"abstention rate, **or**
fail-closed screening rate, moves sharply — every individual case behaved
exactly as designed"*. `AlertCondition.measure` declared both arms. Only
`fail-closed-screening` was ever produced, by `guardrails`' rate watch. Nothing
in the library watched the abstention rate, so half a named condition was
declared and unimplemented.

The obvious fix — have `guardrails` watch both — is wrong, and the reason is
vocabulary rather than effort.

## Decision

**`approval` watches the abstention rate. `guardrails` watches the fail-closed
screening rate. They stay separate.**

Per `docs/CONTEXT.md`, an abstention is a **verdict disposition**. `guardrails`
produces no verdict: a screening that recommends `abstain` is a *recommendation*
the decision may overrule in either direction. Counting recommendations under
the name "abstention rate" would name a number after something it does not
measure — exactly the failure the binding vocabulary exists to prevent.
`approval` is the only module that sees a verdict, so it is the only module that
can count one. It observes in `run`, immediately after `spec.decide` returns.

`guardrails/lib/rate-watch.ts` was generalised into `createRateWatch<T>(terms,
spec)` and exported, so the shape is stated once in the library's interface even
though it is instantiated twice.

Wiring is `ApprovalDeps.abstentionRate: AbstentionRateTerms` — `windowMs`,
`moveBasisPoints`, `minSample`, none defaulted, the whole object optional. It is
bounded **by declaration rather than by traffic**: one window per decision point
in `ApprovalDeps.points`, a fixed registry, so no caller-supplied string can
grow the map and nothing is evicted because nothing is created beyond it.

Two deliberate divergences from `guardrails`' shape:

- `AbstentionRateTerms` carries only window terms and raises through the
  `ApprovalDeps.alerting` this module already has for five other silent
  conditions, rather than carrying its own sink the way `guardrails.RateAlerting`
  does. **One module paging two different places about conditions drawn from the
  same case is how an operator ends up with a channel they trust and a channel
  they do not.** With `alerting` absent, detection still happens, still writes
  its node, and the node says `alerted: "not-configured"` — visibly unmonitored
  rather than looking monitored.
- The window keys on the real `pointId`, not on `phase:tier`. `guardrails` can
  only say `input:high` because a screening does not know which decision point
  it guards; `approval` does, so `AlertCondition.decisionPoint` means what it
  says. **Tier is deliberately not in the key**: a point's tier varies case by
  case with money at risk, and splitting by tier would push all three windows
  under `minSample` on exactly the low-volume high-value deployments where an
  abstention run matters most.

## The alternative rejected

**Move the rate watch into `alerts`, which owns the condition, and have both
modules call it.** This is the right long-term home and it is not done here.
`alerts` would have to name a concept it deliberately does not know about — it
imports no other module, and that one-way dependency direction is what stops it
becoming a fifth god object. Doing it properly means designing a measure-neutral
window in `alerts` and moving two callers, which is a change worth its own
record.

## Consequences

- **Accepted duplication, named rather than hidden.** The two rate-watch
  implementations are structurally parallel and independently maintained. They
  cannot share code without one module reaching into the other's private `lib/`,
  which the boundary lint fails on. A rule changed in one and not the other is a
  real drift risk, and it is item 7 of `README.md`'s gap list.
- `guardrails` → `approval` would also be a dependency cycle. `approval` →
  `guardrails` is clean today and no layering rule forbids it, which is why the
  abstention half sits where it does.
- Both watches close windows lazily on arrival and own no timer, so neither adds
  anything a test cannot drive from an injected clock.

## What would change our mind

A third caller needing the same shape. Two instantiations is duplication worth
accepting to keep the vocabulary honest; three is a module of its own that belongs in
`alerts`, and at that point the design work above is owed.
