# 0011 — Eval nodes get their own physical store; `audit` keeps `INSERT`-only grants

**Status:** Accepted
**Date:** 2026-08-17

## Context

`evals/common-case` fatal flaw 6. Eval runs generate on the order of **10M nodes
a day** and want **90-day retention**. Expiring them needs a `DELETE` grant on
the tables the nodes live in.

`audit`'s headline invariant is that its grants withhold `UPDATE` and `DELETE`
**so the guarantee holds even against someone with a psql prompt** — not only
against someone using the interface. Granting `DELETE` to expire eval nodes
would void append-only for all four modules and all nineteen applications, to
save disk on test data.

The trade is stark once written down that way, but the pressure is real: 10M
nodes a day compounding for seven years to keep records of tests is not a
defensible use of a regulated archive either.

## Decision

**Separate stores, one interface.** `evals` nodes go to their own physical store
with its own grants and its own retention. `audit` case traces keep
`INSERT`-only grants and the seven-year retention. Same node discipline, same
branding, different store.

The separation is in the migrations, not in a convention:

| | `audit` trace tables | `evals` tables |
|---|---|---|
| Migration | `migrations/0002_audit_trace.sql` | `migrations/0004_eval_store.sql`, `0005_eval_ledger.sql` |
| Role | `agent_ops_writer` | `agent_ops_eval_writer` |
| Grants | `SELECT, INSERT` | `SELECT, INSERT, UPDATE, DELETE` |

Two **different roles**, not one role with two grant sets. A grant that exists
on a role is a grant that can be used against every table that role can reach.

In the code:

- `packages/agent-ops-core/src/evals/lib/types.ts` gives `EvalNodeStore` an
  `expireBefore(cutoff, batchLimit)` verb and states in the comment that *that
  verb is the whole reason this seam exists rather than reusing
  `audit.TraceStore`.* The batch limit is **required and range-checked
  (1..10,000)**: "delete everything older than 90 days" against 10M nodes a day
  holds a lock for minutes and materialises a result set nobody reads, so the
  caller loops on `runs > 0` instead. There is no unbounded verb on the
  interface. `RunLedger` carries the same bounded `expireBefore` for the same
  reason.
- `audit` has no removing verb at all, and the absence is **checked by the
  compiler on every build**.
  `packages/agent-ops-core/src/audit/lib/invariants.ts` lists the eight names
  that would mean removal — `delete`, `remove`, `purge`, `expire`, `drop`,
  `truncate`, `erase`, `destroy` — once, and applies them to three interfaces as
  `StoreCannotRemove`, `RegisterCannotRemove` and `ArchivistCannotRemove`. Its
  comment states the mechanism the decision rests on: *adding
  `expire(correlationId)` to `TraceStore` would look like a small convenience
  and would require a DELETE grant on the role nineteen applications hold all
  day. This fails the build first.* That file lives in *shipped code rather than
  in `tests/`* precisely
  because `tsc --build` runs on every commit while the test folder is excluded
  from the build. A guarantee that holds only when somebody remembers to run a
  typecheck-mode test is a guarantee held by convention.
- **A trace never spans both stores.** An eval run reading recorded production
  cases *reads* the audit store and *writes* its own. Read one, write the other,
  never interleave. `evals/index.ts` states this and it is why `recordedCases`
  opens no node: no run exists yet, and a trace cannot cross the boundary.

`audit`'s seven-year expiry is therefore **not a library function**, and
`audit/index.ts` explains why in one line: an `expire(correlationId)` verb needs
a `DELETE` grant on the writer role, and nineteen applications would then hold,
all day and every day, the one permission the whole design exists to withhold.
What the library ships instead is the preparation for a removal it cannot
perform — `RetentionRegister` lists sealed cases past retention;
`Archivist.clearForRemoval` re-reads the live case, recomputes its digest, and
clears it only if the archive copy **and** the external witness both agree,
checked on the day of the removal rather than the day of the export. The removal
itself is a documented procedure run by a separately-authorised role against a
runbook a person signs.

## Alternatives rejected

**1. Partitioning eval nodes within the same tables.**

The case for it: one schema, one adapter, one set of indexes, and partition-drop
is the cheapest possible expiry. It is the textbook answer for time-series data
with a retention window.

Rejected because it still requires the `DELETE` grant to exist on the role, and
**a grant that exists is a grant that gets used** — by a migration, by an
incident script, by somebody with a psql prompt at 2am. The guarantee `audit`
sells is precisely that no such grant exists.

**2. No retention on eval nodes — keep everything.**

The case for it: one store, no deletes anywhere, maximum simplicity, and disk is
cheap.

Rejected on arithmetic. 10M nodes a day compounding for seven years, to keep
records of tests, is not a defensible use of a regulated archive — and the cost
is not only storage. Every backup, every restore drill, every retention review
and every subject-access search would cross an archive dominated by eval data
that no regulation requires us to hold.

## What would change our mind

A specific, measurable trigger:

**Measured eval volume coming in two orders of magnitude below the estimate.**
If real eval traffic is on the order of 100K nodes a day rather than 10M, one
store with no deletes is simpler and cheap enough, and the second store is
complexity we are paying for on the strength of a guess.

`docs/design/OPEN-ITEMS-RESOLVED.md` item 4 attaches the operational
instruction: **measure before the second migration.** The 10M figure is an
estimate and is named as one.

Two things that would *not* change our mind: eval retention becoming
inconvenient to operate, and a request to "just add a DELETE grant temporarily".

## Where the code diverges from the design documents

- **The eval retention story is two stores deep, not one.** The resolution
  document speaks of "eval nodes"; the shipped code expires both the **node
  store** (`0004_eval_store.sql`) and the **run ledger**
  (`0005_eval_ledger.sql`), each with its own bounded `expireBefore`. A caller
  who expires only the nodes leaves the memoisation ledger growing.
- **Eval *reports* are seven-year artefacts even though the node graph behind
  them is not**, and this is not in any design document. `evals/index.ts` states
  it: the graph expires at 90 days, the reports outlive it, so redaction is
  applied to **reports as well as nodes** under the policy the nodes used, with
  `redaction` stamped on the report. Before that, reports carried `authority` —
  a named person — the correlation identifier and every verdict conclusion
  unredacted into the long-lived artefact. That is a personal-data exposure the
  separate-store decision created and did not, by itself, close.
- **`EvalNodeStore` is branded, and the reason is not retention.** A genuine
  recorder over an object-literal store that echoed the header and returned
  `{ header, nodes: [] }` produced `correctBasisPoints: 10000`, attribution
  `complete`, a valid-looking trace digest and a passing gate, **with no cast
  anywhere**. See ADR 0013.
