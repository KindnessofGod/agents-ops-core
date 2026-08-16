# agent-ops-core

Shared operational machinery for AI decisioning applications — evaluation,
audit, approval routing, telemetry, guardrails. Nineteen applications across
different industries depend on it; they differ entirely in domain and share
almost all of their operational machinery.

## What isn't finished

**Almost all of it.** As of this commit the repository is scaffolding plus a
domain model. There is no implementation code.

- ✅ Toolchain, workspace, Postgres, test harness, boundary enforcement
- ✅ `docs/CONTEXT.md` — the ubiquitous language
- ✅ `docs/design/PHASE-2-INTERFACE-REVIEW.md` — interface design for the
  seven candidate modules, with a recommendation on which survive
- ⬜ Which modules survive — **awaiting a decision**
- ⬜ Every module implementation
- ⬜ Track A and Track B documentation (written last, from the code)

`packages/agent-ops-core` exports nothing yet, deliberately. Publishing a
placeholder surface would be the exact mistake this project exists to avoid.

## Run it

Four commands, no account anywhere:

```bash
git clone https://github.com/kindnessofgod/agents-ops-core.git
cd agents-ops-core && npm install
npm run db:up          # Postgres 16 + migrations, via docker compose
npm run check          # typecheck + module boundaries + tests
```

`npm run db:up` starts Postgres 16 on host port **5433** (not 5432, so it will
not collide with a Postgres you already run) and applies everything in
`./migrations` in filename order. Credentials are `agent_ops` / `agent_ops` /
`agent_ops` — identical for everyone, secret from nobody. Override the port
with `AGENT_OPS_PG_PORT`. `npm run db:reset` drops the volume and re-applies
the migrations from scratch.

Tests are hermetic and need no database and no network. `npm run db:up` is for
running the system, not for `npm test`.

## Worked example

Not yet. A worked example belongs in the README once there is code to work
through, and this README is written from the code that exists rather than the
code that is planned. See `docs/design/PHASE-2-INTERFACE-REVIEW.md` for the
interfaces under consideration.

## Layout

```
packages/agent-ops-core/src/    the library; one folder per module
migrations/                     SQL, applied in filename order
docs/                           Track A — for engineers
docs/business/                  Track B — for everyone else
docs/adr/                       one record per significant decision
docs/DECISIONS.md               the builder's log
```

Inside the library, a module's root files are its interface and everything in a
subfolder is private. `npm run lint:boundaries` enforces that — a module whose
callers must know its internals fails CI rather than merely looking wrong in
review.

## Documentation

Start with `docs/CONTEXT.md`: the terms in this library are precise and several
of them overlap in ordinary speech. Containment and resolution especially.

For a non-technical read, `docs/business/` covers the same system with no code
and no unexplained acronyms.
