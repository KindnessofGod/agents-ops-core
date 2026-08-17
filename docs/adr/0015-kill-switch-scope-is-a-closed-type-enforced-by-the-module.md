# 0015 — Kill-switch scope is a closed type, and the module decides whether it stops the effect

**Status:** Accepted
**Date:** 2026-08-17

## Context

`docs/CONTEXT.md` says a kill switch stops effects "system-wide **or per tier**".
The code did not. `KillSwitchReader` was `() => Promise<KillSwitchState>`, taking
no tier and asking no per-tier question, and `KillSwitchState.scope` was a bare
`string` written onto the trace node.

That is worse than an unimplemented feature. The trace faithfully recorded
whatever the reader claimed — `scope: "high-tier only"` — while the module
stopped *every* effect regardless, or an operator wired a reader that returned
`scope: "high"` and assumed low-tier payments were still flowing when they were
not. A field that describes behaviour it does not control is a field that lies
in a seven-year archive, and it lies most convincingly during the incident that
made someone engage the switch.

## Decision

**`KillSwitchScope` is a closed type**, replacing the free string:

```ts
type KillSwitchScope =
  | { readonly kind: "system-wide" }
  | { readonly kind: "tiers"; readonly tiers: NonEmpty<Tier> };
```

`KillSwitchReader` now takes `{ tier }`. `scopeStops(scope, tier)` — a pure
function **owned by this module, never by the reader** — decides whether the
switch covers the effect in hand, and it is enforced at `executeEffect` and at
hold-release in `sweep`.

The trace node says what the module concluded, not what the reader claimed:
`approval.kill-switch-read` carries `tier`, `scopeKind`, `scopeTiers`,
`appliesToTier` and `stopped`, and `approval.hold-continues` /
`approval.hold-released` carry the same. A hold that continued is provably a
hold the scope actually covered.

**An unreadable kill switch stops every tier**, recorded as `scopeKind:
"unreadable"`, `stopped: true`, reason `kill-switch-unreadable`. An unreadable
scope is a guess, and per-tier scope is the last place in this library to guess.

## The alternative rejected

**Keep `scope: string` and add a parallel structured field.** Non-breaking:
nineteen `KillSwitchReader` implementations keep compiling, and the module reads
the new field when it is present.

Rejected because it leaves the lying field in place. Two fields describing one
thing, one of which is enforced and one of which is free text, is the shape that
produced the problem — and the free one is the one that reads well in a report.
A breaking change that deletes the lie is cheaper than a compatible change that
keeps it next to the truth.

## Consequences

- **This is breaking for all nineteen applications.** Every `KillSwitchReader`
  implementation changes signature *and* return shape. There is no shim, on
  purpose: a shim would have to invent a scope for a reader that never had one.
- `KillSwitchScope` deliberately has **no `at-or-above` shape**.
  `{kind:"tiers", tiers:["medium","high"]}` expresses it, and one shape cannot
  be misread. An operator wanting literal "and above" semantics — which would
  widen automatically when a fourth tier is added in 2029 — is asking for a
  second shape, and that is a decision for a deployment to bring rather than for
  this library to assume.
- The sweep's kill-switch read is keyed by tier and bounded: a `Map<Tier, …>`
  with at most three entries ever, so a batch of two hundred held cases is at
  most three reads of a control plane that is already having an incident.
- `KillSwitchReader` remains **injected, not seamed**. Making it tier-aware does
  not turn it into a seam, and counting a fake reader as an adapter would let
  anyone call any injected dependency a seam.

## What would change our mind

A fourth risk tier arriving, plus evidence that deployments are routinely
enumerating every tier above a threshold by hand and getting it wrong. That is
the case for an `at-or-above` arm — added as a *third* variant, never by
loosening `tiers` back towards a string.
