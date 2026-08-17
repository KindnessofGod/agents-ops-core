# 0007 — Drop the low-tier concession: no `decide` receives a write-capable client at any tier

**Status:** Accepted. **Reverses `approval/common-case`'s own design and the
Phase 2 sketch.**
**Date:** 2026-08-17

## Context

The winning design in `docs/design/design-it-twice/FINDINGS.md` optimised for the
common case, and that included a shortened form for low-tier decision points: a
low-tier point could declare no effects and take a write-capable client inside
`decide`, on the grounds that 15 of every 16 executions are low tier and being
wrong there costs almost nothing.

Two things happened.

**First, the adversary found it.** `approval/common-case` fatal flaw 1 — the
highest-severity flaw found anywhere in the exercise — is that a low-tier point
declaring no effects can call `client.write()` inside `decide`, producing an
**untraced effect on the path the design says is 15 of 16 executions**.

**Second, and this is the more valuable output, both winning designs' authors
independently wrote the same self-criticism** about different modules, with no
contact between them:

> *approval:* "I optimised the case that needed the least help. This module's
> entire value is in the tail. The ungated low-tier point — 15 of every 16
> executions — is where being wrong costs almost nothing, while the £2M
> disbursement runs once a week and is the only reason `approval` exists."

> *evals:* "I optimised for the loudest caller, not the most important one. […]
> The questions that actually matter all live on the shadow path, which I
> deliberately made unpleasant."

Two authors, no contact, same diagnosis: **frequency was used as a proxy for
value, and in these two modules the value is in the tail.**

`docs/design/PHASE-2-INTERFACE-REVIEW.md` §2 had encoded the same instinct one
level up, sketching `type ClientFor<T extends Tier> = T extends "high" ?
ReadOnlyClient : T extends "medium" ? ReadOnlyClient : WriteCapableClient` — a
write-capable client at low tier, by construction.

## Decision

**The same declaration shape at every tier, discriminated by type rather than
shortened for the common one. No `decide` receives a write-capable client at any
tier. All effects go through a declared `EffectDeclaration`.**

`packages/agent-ops-core/src/approval/lib/clients.ts` is the smallest file in
the module and holds nothing else, because this is the highest-leverage
requirement in the library. The mechanism:

- `Client<"read">` and `Client<"write">` are **disjoint in both directions** —
  neither is a subtype of the other, because the literal types of a phantom
  property keyed by a non-exported `unique symbol` are incompatible.
- `CommonSpec.decide` is declared as
  `(client: ReadOnlyClient, input: In) => Promise<Determination<V, P>>` — **a
  property with a function type, never a method** — and there is no variant of
  that field that accepts a write-capable client. `ClientFor` does not exist.
- `WriteCapableClient` is handed only to a declared `EffectDeclaration.execute`,
  only after a licence has been minted and the kill switch read.

Three compilation facts are recorded in that file as verified against this
repository's own `tsconfig.base.json` under tsc 5.9.3, not asserted:
`strictFunctionTypes` makes parameter positions contravariant; **mutual**
unassignability means the guarantee survives even in method-shorthand position,
where TypeScript compares bivariantly, because a bivariant check passes only if
one direction is assignable and here neither is; and the phantom key cannot be
named outside the file, so an object-literal impostor does not typecheck.

The claim is checked by compiling fixtures rather than by prose.
`approval/tests/typecheck.ts` runs the repository's own TypeScript over
`tests/fixtures/capability-accepted.ts` and `capability-rejected.ts` and asserts
the diagnostics; a `@ts-expect-error` that stops erroring fails the test via
`TS2578`, so the assertion cannot rot in either direction.

The same inversion was applied to `evals`: the shadow path gets the same care as
the gate path, because per ADR 0001 the shadow path is the only thing that can
ever falsify the workflows-not-agents stance, and making it unpleasant to use
makes that decision unfalsifiable in practice.

## Alternative rejected

**Keep the low-tier concession — a shortened declaration and a write-capable
client where the consequence of error is small.**

The case for it is depth, and depth is this project's stated goal. Fifteen of
sixteen executions taking a two-field declaration instead of an eight-field one
is real leverage for real callers, and a low-tier ticket-routing effect is not a
£2M disbursement.

Rejected for two reasons, and the second is the one that generalises:

1. **It is not actually low tier that is at risk.** The concession is available
   to any point whose classifier returns low, and the classifier is application
   code. An untraced `client.write()` on the 15-of-16 path is an untraced effect
   wherever that path leads.
2. **Frequency is not value.** This module exists for the tail. Optimising the
   interface for the case that needed the least help is how a module ends up
   excellent at the thing nobody needed and awkward at the thing it was built
   for.

One change closes the escape and answers both authors' objection, which is why
`FINDINGS.md` calls it the deliberate inversion rather than a fix.

## What would change our mind

Named, observable triggers:

1. **A measured throughput cost.** If declaring an `EffectDeclaration` for
   trivially reversible low-tier effects measurably slows the hot path — not the
   authoring experience, the execution — that is a real cost to weigh. Nothing
   in the current shape suggests it will; the declaration is data.
2. **Applications routing round it.** If two or more applications take their
   low-tier effects outside the library entirely to avoid declaring them, the
   concession has been reinstated by the callers and we have the worst of both:
   the ceremony and the untraced write. That is a trigger to make declaration
   cheaper, not to hand back the client.
3. **A compiler change that breaks disjointness.** The guarantee rests on three
   verified facts about tsc's variance rules. A TypeScript release that changes
   any of them is a trigger to re-verify, and `tests/typecheck.ts` is what would
   catch it.

What would *not* change our mind: an author finding `EffectDeclaration`
verbose at low tier. That is exactly the argument the inversion reversed.

## Where the code diverges from the design documents

- **`docs/design/PHASE-2-INTERFACE-REVIEW.md` §2's `ClientFor<T>` conditional
  type does not exist**, and the tier-dependent client it describes was
  deliberately removed. Read as history, not as interface.
- **The type guarantee has a stated runtime limit.** `any`, `as` and
  `@ts-expect-error` defeat any type-level guarantee. The backstop is that the
  read-only client handed to `decide` has **no `write` property at all**, so an
  `any`-typed handler calling `client.write(...)` throws a `TypeError`, and
  `approval` records an `approval.adapter-failed` node naming the `spec.decide`
  seam before re-raising fail-closed. `lib/clients.ts` notes that this
  consequence was *previously asserted in that comment and was false*, because
  nothing wrapped `spec.decide` at all; it is now asserted by a test that runs
  it, in `tests/adapters-and-trace.test.ts`.
- **The honest scope of the whole guarantee, per `FINDINGS.md`:** application
  code inside `decide` holds its own closure and can import a payments provider
  directly, and no type in this package reaches outside this package. Every
  node is stamped `capturedVia: "declared-seams-only"`, and `approval/index.ts`
  states the claim as *unrepresentable through this module's seams*, not
  *unrepresentable*. An overstated guarantee is a liability the first time a
  regulator finds the gap.
