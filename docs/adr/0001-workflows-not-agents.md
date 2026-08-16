# 0001 — This library assumes its callers are workflows, not autonomous agents

**Status:** Accepted (provisional — Phase 2 findings not yet ratified)
**Date:** 2026-08-16

## Context

Anthropic's *Building Effective Agents* draws a line between two things that
get called the same word:

- **Workflows** — "systems where LLMs and tools are orchestrated through
  predefined code paths."
- **Agents** — "systems where LLMs dynamically direct their own processes and
  tool usage."

Its core position is that most production systems should be the former. The
guidance is explicit: "Start with simple prompts, optimize them with
comprehensive evaluation, and add multi-step agentic systems only when simpler
solutions fall short." Workflows suit "well-defined tasks" needing
"predictability and consistency"; agents suit cases where "flexibility and
model-driven decision-making are needed at scale," at the price of "higher
costs, and the potential for compounding errors."

Nineteen applications will inherit whatever this library assumes. Claims
triage, invoice approval, ticket routing, expense validation, member
verification and underwriting intake are all classification-and-extraction
problems with regulated outcomes and known decision points. They are, on their
face, the "well-defined tasks" the guidance describes.

## Decision

**`agent-ops-core` is built for workflows.** Every interface assumes the set of
decision points in a case is known before the case runs.

Three concrete consequences, each of which is a constraint rather than a
preference:

1. **Risk tier is assigned before execution.** A tier that gates which model
   runs, which guardrails apply and whether a human must approve is only a gate
   if it is computable in advance. An autonomous agent choosing its own next
   step cannot be tiered ahead of the step it has not chosen yet.
2. **The trace is a record of predefined decision points, not a transcript.**
   Replay by correlation ID assumes the shape of a case is knowable. An
   open-ended agent loop produces a transcript, which is auditable but not
   replayable in the sense `audit` promises.
3. **Effects are gated individually.** The type-level constraint on `approval`
   — a high-tier handler being structurally unable to hold a write-capable
   client — depends on knowing at compile time which handler runs at which
   tier. Dynamic tool selection erases that.

The library does not *forbid* an autonomous caller. It declines to make that
path cheap, and it will not pretend to give it the same guarantees.

## Alternative rejected

**Build for autonomous agents, and let workflow callers use a subset.**

The case for it is real: it is the more general design, and a general design
that also serves the specific case looks like the safer bet when nineteen
unknown futures depend on it. Building the narrow thing now risks a rewrite
when application four wants a genuinely agentic loop.

Rejected because generality here is bought with the exact guarantees that make
the library worth having. You cannot both let a model choose its next tool and
promise that every write-capable client was gated by a compile-time check. An
interface that serves both serves the second badly, and the guidance's own
warning about "compounding errors" applies with particular force in a regulated
setting where the compounding shows up as money moved incorrectly.

The narrower reading is also what the guidance recommends: complexity added
"only when it demonstrably improves outcomes."

## What would change our mind

Named, observable triggers — not "if requirements change":

1. **Route exhaustion.** More than 15% of production cases in any one
   application fall through predefined routes into a catch-all, sustained over
   a month. That is evidence the decision points are not in fact knowable in
   advance.
2. **Mid-case re-tiering.** Cases routinely needing their tier profile
   recomputed more than once mid-flight, in more than one application. Tiering
   ahead of execution would then be a fiction we are maintaining.
3. **A workflow ceiling on quality.** An application demonstrating, on golden
   cases, that an orchestrator-workers or evaluator-optimizer arrangement beats
   its best workflow by a margin that survives the cost and latency comparison
   the guidance asks for. One application clearing this bar is interesting;
   three is a mandate.
4. **The guarantees stop being wanted.** If regulators or auditors in these
   industries come to accept transcript-level evidence in place of replayable
   traces, the main thing purchased by this constraint is no longer worth its
   price.

Trigger 3 is the one to watch. It is also the one nobody will measure unless
`evals` makes it cheap — which is an argument for `evals` existing regardless
of how this decision ages.

## Note on the patterns

Of the guidance's named patterns, **routing** is the one this library
implements directly: risk tier classifies a case's decision and directs it to a
path, including "directing simple queries to smaller models and complex ones to
capable models." **Evaluator-optimizer** is the shape of `evals` with an
LLM-as-judge scorer. **Prompt chaining**, **parallelization** and
**orchestrator-workers** are application concerns; the library neither provides
nor prevents them.

The guidance's point about the agent–computer interface — that tool design
deserves as much effort as the prompt, and that arguments should be shaped so
"it is harder to make mistakes" — is the same argument this project makes about
interface depth, applied one level down. It is the reasoning behind the
`approval` type-level constraint: not a runtime check a future contributor can
bypass, but an argument shape that makes the mistake unrepresentable.
