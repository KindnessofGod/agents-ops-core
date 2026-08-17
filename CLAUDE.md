# agent-ops-core

Shared operational machinery for AI decisioning applications. Nineteen separate
applications — insurance claims triage, invoice approval, support ticket
routing, expense validation, member verification, underwriting document intake —
depend on this library. They differ entirely in domain and share almost all of
their operational machinery. This is that machinery.

**Interface design matters more than implementation here.** A wide, shallow
interface poisons all nineteen callers at once. Four excellent modules beat
seven mediocre ones.

## Stack

- TypeScript, strict, `NodeNext` modules. Node 20+.
- Vitest for tests.
- npm workspaces. The published package is `packages/agent-ops-core`.
- Postgres 16 via `docker-compose.yml`, migrations in `./migrations`.
- Minimal dependencies. Every added dependency is nineteen applications'
  problem — argue for it in an ADR before adding one.

Commands: `npm run check` (typecheck + boundaries + tests), `npm test`,
`npm run db:up`, `npm run db:reset`.

## Design vocabulary

Use these words exactly. Do not substitute "component", "service", "API", or
"boundary".

- **Module** — anything with an interface and an implementation.
- **Interface** — everything a caller must know to use the module correctly:
  the type signature, but *also* invariants, ordering constraints, error modes,
  required configuration, and performance characteristics.
- **Depth** — leverage at the interface: how much behaviour a caller gets per
  unit of interface they must learn. Deep = small interface, large
  implementation. Deep is the goal.
- **Seam** — a place where behaviour can be altered without editing in that
  place.
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change and bugs concentrate
  in one place.

Two tests applied to every module:

- **The deletion test.** If this module were deleted, does complexity vanish
  (it was a pass-through — cut it) or reappear across nineteen callers (it
  earns its keep)?
- **The seam rule.** One adapter means a hypothetical seam. Two adapters means
  a real one. Name the second adapter or admit the seam is speculative.

## Repository shape

```
packages/agent-ops-core/
  src/
    index.ts            ← published entry point
    <module>/
      index.ts          ← the module's interface. Public.
      lib/              ← implementation. Private.
      tests/            ← tests + fixtures. Private.
```

Everything in a subfolder is private. Outside code reaches a module only
through its root files. This is enforced by `npm run lint:boundaries`
(dependency-cruiser), not by convention — a shallow module fails CI.

Tests cross the same seam as callers. If a test needs to reach past the
interface, the module is the wrong shape.

## Tests are hermetic

No network, ever. Enforced **structurally through dependency injection**, not
by convention and not by an environment variable: no module constructs its own
model client, clock, database handle, or HTTP client — every one is a
constructor parameter. A test must be unable to reach a live model even with
real credentials present in the environment.

If you find yourself adding a `SKIP_NETWORK` flag or an `if (process.env.CI)`
branch to a test, the module's dependencies are wrong. Fix the module.

## Conventions

**Branches.** `feat/`, `fix/`, `docs/`, `refactor/`. Never reference the tool
that wrote the code in a branch name.

**Commits.** State what was *understood*, not what was typed. "Route high-tier
cases through dual control" beats "add approval.ts". When a change reverses
something previously proposed, say so in the body — name the reversal.

**Surface decisions, don't make them silently.** When you hit a fork with a
real trade-off, stop and put both options to the user with the case for each.
Do not pick the safe default and move on. Those forks are the point of this
project, not an interruption to it.

## The builder's log

Decisions go to `docs/DECISIONS.draft.md` via the `/log` skill — never
directly to `docs/DECISIONS.md`. A `SessionEnd` hook also drafts entries from
the session transcript. Drafts are promoted to `docs/DECISIONS.md` only through
`/log-review`, one entry at a time, in the user's own wording.

Rules that hold in both places: if the user overruled a proposal, say so
plainly including where the disagreement stands. Never invent reasoning the
user did not give — mark reconstructions `INFERRED` so they can be corrected.
Nothing of substance decided means nothing written; an empty log day is honest,
a padded one is not.

## Documentation standard

Two tracks. Both mandatory. Both written **from the code that exists**, not
from the plan. Where they diverge, the code is the truth — say where.

**Track A — `docs/`, for engineers.**

- `README.md` — 90-second skim: install, test, one worked example, then
  detail. "What isn't finished" near the top.
- `ARCHITECTURE.md`, `CONTEXT.md` (the ubiquitous language), `RUNBOOK.md`,
  `TESTING.md`, `EVALUATION.md`.
- `docs/adr/NNNN-*.md` — one per significant decision, recording the decision,
  the alternative rejected, and what would change our mind.

**Track B — `docs/business/`, for a finance manager.**

- `OVERVIEW.md`, `THE-PROBLEM.md`, `WHAT-IT-WILL-NOT-DO.md`,
  `WORKED-EXAMPLE.md`, `IMPACT.md`, `FAQ.md`, `GLOSSARY.md`.
- No code. No unexplained acronym — not RAG, not LLM, not API, not MCP. Spell
  every term out on first use.
- Short sentences. Written so the reader can explain the system to their own
  boss afterwards.
- **Every claim carries a number or is explicitly marked an estimate.**

**Diagrams** are Mermaid in fenced code blocks. Never image files. Minimum
five: system context, module diagram, sequence diagram of the main path,
risk-tier routing flowchart, data model. The context diagram and the routing
flowchart appear in *both* tracks.

## Ubiquitous language

`docs/CONTEXT.md` is binding, not decorative. Several of these terms overlap in
ordinary speech and must not overlap here. Three rules carry more weight than
the rest:

- **Unassisted containment and resolution are not the same thing.** A customer
  who abandons a conversation in frustration is contained but not resolved, and
  any metric that counts them as a success is measuring the wrong thing. The
  term is always `unassisted_containment` — bare `containment` is a lint
  failure, because the qualifier is what stops it being read as a quality
  score. It carries no target in this library; it is recorded, never optimised.
- **Reserved decisions are enforced structurally, never by configuration.** A
  decision that must have a human by law or policy cannot be made automatic by
  editing a setting, whatever the model's confidence. Correct unassisted
  containment for a reserved decision is exactly zero.
- **Resolution is unrecordable without a named evidence source and window** —
  quiet, reviewed, or reversed. The library refuses to guess rather than let
  each application invent one.

`docs/business/GLOSSARY.md` is the plain-language companion, covering both our
terms and the industry jargon around them. Keep it in step: a term added to
`CONTEXT.md` that never reaches the glossary is a term only the authors
understand.

## Working agreements

- Read `docs/CONTEXT.md` before naming anything.
- TDD in vertical slices: one seam, one test, one minimal implementation,
  repeat. Never write all the tests first — bulk tests verify imagined
  behaviour.
- Agree the seams before writing the first test.
- Documentation last, from the code.
