# 0006 — The caller declares a decision point; the module drives every phase

**Status:** Accepted
**Date:** 2026-08-17

## Context

`docs/design/design-it-twice/FINDINGS.md` records an exercise: eight interfaces
for two modules, designed in parallel in four shapes — minimal, flexible,
common-case-optimised, ports-and-adapters — each stress-tested by an independent
adversary who did not write it.

One result held across both modules by the same margin. **Common-case-optimised
won on depth, 7 against 6, 4 and 3,** and the mechanism was identical in both:
the caller *declares* rather than *drives*, so the phases are **absent from the
interface** rather than merely documented in the right order. Flexible lost on
depth in both modules and was outright rejected for `approval` — maximum
extensibility bought thirteen and eleven seams, most of them speculative, and
the depth nineteen callers actually need was the currency it was bought with.

The finding that mattered more than the ranking is the reason this shape was
chosen rather than merely preferred. **No design achieved the total-recording
constraint, and the ceiling was 6/10.** The adversaries converged independently
on why: a handler is application code holding its own closure, it can call a
payments provider directly, and no type in a library can reach outside that
library. The achievable guarantee is not "unrecorded execution is impossible" —
it is that *skipping the library's own recording is a compile error rather than
a discipline*, and that the scope of the claim is stamped onto the artefact.

An interface with orderable verbs cannot deliver even that. If a caller can call
`classify`, `handle`, `authorise` and `execute`, then calling them out of order,
or skipping one, is a runtime check at best.

## Decision

**The caller hands over a declaration; the module owns every phase.** The phases
are not discouraged out of order — they are not reachable.

`packages/agent-ops-core/src/approval/lib/define.ts` is the whole of the
declaration surface: `defineDecisionPoint(spec)` returns an opaque
`DecisionPoint` carrying a `unique symbol`, produced only by that function and
consumed only by `run`. There is **no `classify`, no `handle`, no `authorise`,
no `execute`, no `suspend` and no `resume`** in `approval`'s interface. There is
no `register` verb. The five verbs on `Approval` are `run`, `answer`, `sweep`,
`inDoubt` and `reconcile`, and none of them is a phase.

`GatedSpec` and `UngatedSpec` are a discriminated union rather than one shape
with optional fields, which is what makes the declaration affordable:
`UngatedSpec` cannot express a `brief`, and `GatedSpec` requires one
non-optionally, along with `doNothing`, `pool`, `dualControlAtOrAbove` and
`licenceValidFor`. Neither is an optional field wearing a required field's
clothes.

`evals` takes the same skeleton. `run(spec)` owns the phases; `NodeHandle`
exposes only `child(spec, body)` — **no `open` and no `close`** — so the
`try/finally`, the abort path and the throw path are written by the library and
not by the caller. `ReadOnlyClient` has no exported constructor and is
obtainable only from a `NodeContext`, which only `child` produces, giving the
chain `no node ⇒ no client ⇒ no model call`. A subject that never calls
`child()` still emits a complete graph having written zero recording code.

`guardrails` states the same property in its own terms: there is no `redact`, no
`runDetector` and no `score` verb, a detector cannot be run except through a
screening, and a screening cannot happen without its nodes being written first.

**That absence is the auditability mechanism, not an omission** — and every one
of the three module headers says so in those words, because a reader who sees a
small verb list will otherwise read it as an unfinished one.

## Alternative rejected

**Expose the phases, and document the ordering.**

The case for it is real. Orderable phases are the flexible shape, and the
flexible shape is what a caller reaches for when their case does not fit: an
application that wants to classify now and decide in twenty minutes, or to
authorise against a brief it rendered itself, can do that with phases and cannot
do it with a declaration. The exercise scored that flexibility honestly and it
lost anyway — depth 3, thirteen seams for `approval`, fourteen fatal flaws,
rejected outright.

Rejected because ordering documented is ordering unenforced, and because the
recording guarantee this project exists for is the same guarantee. With phases,
"every node is recorded" is a property of caller discipline across nineteen
applications. With a declaration, it is a property of there being nothing else
to call.

The cost is on the record and it is not small: a caller whose flow genuinely
does not fit the declaration has no supported path. `docs/design/design-it-twice/
FINDINGS.md` also records a deferred idea for exactly this pressure —
`evals/flexible`'s demand algebra, where generators yield typed `Demand`s so
that recording *is* the fulfilment rather than a wrapper around it. It is
**deferred, not rejected**, and is the thing to reach for if the declaration
proves too rigid.

## What would change our mind

Named, observable triggers:

1. **Applications routinely defeating the declaration.** Two or more of the
   nineteen wrapping `run` in machinery that re-implements a phase — splitting
   one logical decision into several decision points purely to get control of
   ordering — is evidence the declaration does not fit the domain. One
   application is a conversation; two is a design signal.
2. **A declaration that cannot express a lawful flow.** A concrete case, from a
   named application, where the required sequence is legal, ordinary, and
   inexpressible. That is when the deferred demand algebra gets built.
3. **The verb count growing anyway.** `approval` is at five and `evals` at two
   executing verbs. If either grows past that under pressure to expose a phase,
   the declaration has already failed and we should stop paying for it.

What would *not* change our mind: a caller finding the declaration verbose.
`GatedSpec` is deliberately long because every field on it is one the review
found gets omitted otherwise.

## Where the code diverges from the design documents

- **`docs/design/PHASE-2-INTERFACE-REVIEW.md` §2 sketches `register` and
  `execute` as public verbs, with `execute(auth, effect, key)` taking a token
  only the gate can mint.** Neither exists. The token idea survives in a
  different place — a `Licence` is minted internally and checked twice, once in
  `answer` before settlement and once at the instant of execution against the
  injected clock — but it is never handed to a caller, because there is no
  caller-facing verb to hand it to.
- **`approval` has five verbs, not the "1–3" the design exercise's shape rule
  imposed and not the four `docs/design/OPEN-ITEMS-RESOLVED.md` item 2
  settled on.** `inDoubt` and `reconcile` are both reconciliation queues and are
  discussed in ADR 0009 and ADR 0010. The shape rule was a rule about the
  deliverable rather than a fact about the module, and it was abandoned
  knowingly.
