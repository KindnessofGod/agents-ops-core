# Design It Twice — shared technical brief

Every design agent reads this file. It is the constraint set, not a proposal.
Eight designs will be produced: `evals` and `approval`, each in four radically
different shapes. They must genuinely differ — four variations on one idea is a
failed exercise.

## Required reading, in order

1. `CLAUDE.md` — stack, conventions, repository shape, deep-module discipline.
2. `docs/CONTEXT.md` — **binding**. The ubiquitous language. Every name in your
   design must come from here or be justified as a new term.
3. `docs/design/PHASE-2-INTERFACE-REVIEW.md` — the interface review that
   selected the four surviving modules, including the interface facts already
   established for `evals` and `approval`.
4. `docs/adr/0001-workflows-not-agents.md` — why this library assumes
   predefined code paths.
5. `.agents/skills/codebase-design/SKILL.md` — the vocabulary. Use **module**,
   **interface**, **seam**, **adapter**, **depth**, **leverage**, **locality**
   exactly. Never "component", "service", "API", or "boundary".

## What this library is

Shared operational machinery for nineteen AI decisioning applications —
insurance claims triage, invoice approval, support ticket routing, expense
validation, member verification, underwriting document intake. They differ
entirely in domain and share almost all of their operational machinery.

**A wide, shallow interface poisons all nineteen callers at once.** Interface
design matters more than implementation here. Depth is leverage at the
interface: how much behaviour a caller gets per unit of interface they must
learn.

## Non-negotiable constraints

These bind every design. A design that breaks one has failed, however elegant.

### C1 — Total auditability. Every decision and every node is tracked.

This is the strongest constraint in the brief and the one most likely to be
under-served. The requirement is **not** "the final verdict is logged".

Every **node** in the execution graph is recorded: each decision, each guardrail
screening, each retry, each tier classification, each scorer invocation, each
approval interaction, each suspension and resumption, each abstention, each
tool call, each model call with its inputs and outputs, each error and each
recovery. Node identity, parent, ordering, timing, cost and outcome.

Consequences your design must satisfy:

- **A case's execution is a directed acyclic graph, not a list.** Parent/child
  relationships between nodes are recorded, not inferred.
- **Recording is not optional and not a cross-cutting afterthought.** A caller
  must not be able to construct a valid decision path that skips it. If
  recording is something the caller remembers to do, the design has failed.
  Prefer designs where an unrecorded execution is unrepresentable.
- **Replay by correlation identifier reproduces the graph**, not just the
  answer. Byte-stable serialisation of node payloads.
- **The recorder is injected**, never constructed internally — this is what
  makes tests hermetic and what lets nineteen applications share a trace store.
- Where your interface would make full node capture awkward, say so plainly
  rather than quietly narrowing the requirement.

### C2 — Production grade

Assume regulated industries, real money, real people, seven-year retention.

- **Concurrency**: correct under concurrent writers to one case. Ordering is
  assigned by the store, never the caller.
- **Failure**: every error mode named, with a stated fail-open/fail-closed
  policy and a reason. Partial failure must not corrupt the trace.
- **Idempotency**: an effect executes at most once per key; a repeat returns the
  original outcome rather than re-executing or erroring.
- **Backpressure and bounded resources**: no unbounded concurrency, no unbounded
  queues, no unbounded retries.
- **Observability**: cost, tokens, latency and the price-table version recorded
  per node (`telemetry` was cut; this is where its one surviving requirement
  lives).
- **Schema evolution**: traces written today must be readable in seven years.
  State how the payload versions.
- **Clock injected.** No `Date.now()` inside a module, ever.
- **No secrets, personal data, or unredacted payloads in the trace.** Redaction
  happens before write; there is no un-writing.

### C3 — Hermetic tests, enforced structurally

No network, ever — enforced through dependency injection, not convention and
not an environment variable. No module constructs its own model client, clock,
database handle or HTTP client. **A test must be unable to reach a live model
even with real credentials present in the environment.** If your design needs a
`SKIP_NETWORK` flag, the dependencies are wrong.

### C4 — Module shape

```
packages/agent-ops-core/src/<module>/
  index.ts    ← the interface. Public. Root files only.
  lib/        ← implementation. Private.
  tests/      ← tests + fixtures. Private.
```

Enforced by dependency-cruiser in CI. Tests cross the same seam as callers — a
test reaching past the interface means the module is the wrong shape.

### C5 — The seam rule

One adapter is a hypothetical seam; two adapters is a real one. **Name the
second adapter for every seam you introduce, or mark the seam speculative and
do not build it.** Speculative seams are a stated failure in this project.

## Module briefs

### `approval`

Owns everything between a verdict and an effect: risk-tier routing, reserved
decisions, the human gate, dual control, idempotency, the kill switch, and the
approval brief.

Established interface facts you must satisfy — these came out of the interface
review and are not open for redesign, though *how* you express them is entirely
yours:

1. **Type-level capability constraint.** A high-tier handler must be
   *structurally unable* to receive a write-capable client — passing one is a
   **compile error**, not a runtime check a future contributor can bypass. This
   is the highest-leverage requirement in the whole library.
2. **Durable and resumable.** The human gate is unbounded — hours or days. The
   process *will* be redeployed mid-wait. A case suspends, the process dies,
   the case rehydrates when the approver answers. `await approve()` is wrong.
   Show how state is captured and restored, and how the trace spans the gap.
3. **Reserved decisions** — must have a human by law or policy, regardless of
   confidence. Enforced structurally: no configuration key, threshold or
   override makes one automatic. Orthogonal to risk tier and on its own seam,
   so a risk-threshold change cannot delete a legal obligation.
4. **Ordering**: classify → handle → authorise → execute, strictly. An effect
   executing before its authorisation must be unrepresentable.
5. **Dual control**: two distinct authorities; the second's brief structurally
   excludes the first's verdict.
6. **Approval brief**: every required field non-optional in the type, including
   contrary evidence and the do-nothing consequence. The library owns contents;
   applications own the screen.
7. **Kill switch** stops effects, never decisions — checked at execute, not at
   classify.
8. **`classify` is pure and sub-millisecond**, no I/O. It runs on every
   decision.
9. **Anti-rubber-stamping**: time-to-decision recorded on every approval; no
   answer pre-selected. The library records the signal and sets no threshold.

### `evals`

Owns quality measurement: the golden-case runner, scorers including
model-as-judge, the CI regression gate, and — following the merge of `shadow` —
running against recorded production cases.

Established interface facts:

1. **Two case sources, one runner**: prepared golden suites, and recorded
   production cases read from `audit`.
2. **Two incompatible report types.** An agreement report (matching what humans
   did) must **not** be assignable where an accuracy report (matching known
   correct answers) is expected, and the CI gate accepts only the latter.
   Agreement is not accuracy: if reviewers are wrong 8% of the time, perfect
   agreement is 8% wrong.
3. **The subject cannot write.** Structural, and it is the same mechanism that
   gives a shadow run its no-effect guarantee.
4. **Suites are versioned and content-addressed.** A report against an
   unversioned suite is refused.
5. **Determinism** given (suite version, subject version, scorer, seed), or the
   report declares itself non-deterministic.
6. **Judge scorers are non-deterministic**: record judge model and prompt
   version, aggregate over n > 1, surface panel disagreement rather than
   averaging it away.
7. **`BaselineMissing` on a first CI run must be explicit** — a gate that
   silently passes because it had nothing to compare against is worse than no
   gate.
8. Bounded concurrency. Target: 200 golden cases under 5 minutes at concurrency
   8. Subset pre-merge, full suite nightly.
9. **Review rule**: a third entry point on `evals` is a signal to split the
   module, not to extend it.

## The four shapes

Each design takes exactly one. Push it to its honest extreme — the point of the
exercise is contrast, and a design that hedges toward the middle teaches
nothing.

- **Minimal** — 1–3 entry points, maximum leverage each. What can be inferred,
  defaulted, or hidden rather than asked for?
- **Flexible** — maximum extensibility. Many callers, many futures, explicit
  extension points. Then be honest about the depth you traded away.
- **Common-case-optimised** — make the overwhelmingly common caller trivial,
  ideally one call with no configuration, and let the rare caller work harder.
- **Ports and adapters** — organise entirely around the seams. Every
  cross-seam dependency is an explicit port. Then apply C5 ruthlessly to your
  own design and name the second adapter for each port or mark it speculative.

## Deliverable

Write `docs/design/design-it-twice/<module>-<shape>.md` containing:

1. **The interface** — types, entry points, parameters, *plus* invariants,
   ordering constraints, error modes, required configuration, performance
   characteristics. TypeScript sketches are welcome and need not compile, but
   must be precise about types where the type is the guarantee.
2. **Usage example** — a realistic caller from one of the nineteen domains,
   end to end. Show the unhappy path too.
3. **What the implementation hides** behind the seam.
4. **How C1 is satisfied** — the node graph, and specifically how an unrecorded
   execution is made unrepresentable rather than merely discouraged.
5. **Seams and adapters** — each seam, its adapters, and for each, the named
   second adapter or an explicit "speculative, do not build".
6. **Trade-offs** — where leverage is high, where it is thin, what this shape
   makes hard. Be specific about who suffers.
7. **The strongest argument against this design**, written by you. A design
   whose author cannot attack it has not been examined.

Be concrete and opinionated. Do not hedge toward the other three shapes.
