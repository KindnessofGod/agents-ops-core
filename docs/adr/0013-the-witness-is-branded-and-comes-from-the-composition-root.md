# 0013 — The recording witness is branded and supplied by the composition root, never by the thing being measured

**Status:** Accepted
**Date:** 2026-08-17

## Context

`evals/common-case` fatal flaw 2. The recorder arrived **inside `SubjectDeps`**
— supplied by the very thing being measured — and was an unbranded plain
interface. An application could pass:

```ts
{ append: async n => ({ ...n, sequence: 0n }) }
```

…and every downstream check still reported success: nodes "acknowledged", digest
computed, report green, nothing written anywhere.

**The audit guarantee is only as strong as the weakest recorder any caller can
supply**, and an unbranded interface makes that weakest recorder a two-line
object literal.

The same reviewer supplied the equivalent for `audit`: an eight-line `nowhere`
store that writes nothing, fabricates its own sequence and returns empty
canonical bytes. It typechecked cleanly under this project's own flags and
reported `recorded: true` for a £2M `payment.authorised`.

This is not a hypothetical threat model. Every one of these forgeries is the
cheapest possible way to make a build green, and — unlike deleting a golden case
— several of them leave no diff.

## Decision

**Brand the witness with a non-exported `unique symbol`, mint it only in the
module's own constructors, and pass it in from the composition root.**

Four rules, all in the shipped code.

### 1. Branded, so a structural impostor does not typecheck

A caller cannot *name* the brand, so an object literal of the right shape is not
assignable. In `packages/agent-ops-core/src`:

| Seam | Brand declared in | Minted by |
|---|---|---|
| `EvalRecorder` | `evals/lib/recorder.ts` | `createEvalRecorder` |
| `EvalNodeStore` | `evals/lib/types.ts` | `inMemoryEvalNodeStore`, `sqlEvalNodeStore` |
| `RunLedger` | `evals/lib/types.ts` | `inMemoryRunLedger`, `sqlRunLedger` |
| `TraceStore` | `audit/lib/types.ts` | the two shipped adapter factories, via one minting function |
| `Witness` | `audit/lib/types.ts` | `inMemoryWitness`, `postgresWitness` |
| `Screening`, `ScreenedPayload` | `guardrails/lib/types.ts` | the screening path only |
| `Licence`, `DecisionPoint` | `approval/lib/types.ts` | `approval` internals, `defineDecisionPoint` |

The runtime errors say what the brand is for rather than that a check failed —
`RecorderNotMinted`: *"the thing being measured does not choose its own
witness"*; `StoreNotMinted`: *"a forged store makes every downstream check report
success while nothing is written"*; `LedgerNotMinted`: *"a forged ledger returns
a report no run produced"*. All three are `incident: true`.

`audit/lib/invariants.ts` holds the assertion as shipped code rather than as a
test — `ImpostorStoreDoesNotTypecheck` and its witness equivalent — because
`tsc --build` runs on every commit and the test folder is excluded from the
build.

`RunLedger` is branded for a sharper reason than the store is: `findCompleted`
returns a report **without executing anything**, so a hand-rolled ledger is the
cheapest possible green build *and it leaves no diff*.

### 2. It never arrives through the subject

`SubjectSpec` has **no `deps` field at all**. The recorder is a parameter of
`run`, supplied by the composition root; the subject receives only a
`NodeContext` derived from it. The thing being measured cannot choose its own
witness.

### 3. Two adapters ship, and the in-memory one is a deliverable

Postgres-backed and in-memory, both exported. The in-memory adapter is what
makes hermetic tests **structural rather than conventional** — it is not a mock,
and it is not a licence for a third implementation of the interface. An
application brings its own database through the injected `SqlExecutor`, not by
implementing the branded interface.

### 4. Acknowledgement carries a store-assigned sequence, and is checked

A recorder that returns without writing cannot fabricate one. `createAudit`
checks **every** acknowledgement against what it asked for — the store-assigned
sequence, the canonical bytes, the payload, the parent, the tier, the clock
reading — and raises `StoreContractViolated` on any disagreement.

## The limit of this, stated plainly

**Acknowledgement is not proof of a write.** Neither the brand nor the contract
check can prove that bytes reached a disk. A store that forms the node correctly
and discards it is indistinguishable from one that writes it, until you replay.

`audit/index.ts` therefore states the doctrine: **replay is the proof of a
write.** `guardrails` acts on it — the first node of each case is proven by
replay before any detector runs.

## Alternative rejected

**Leave the interfaces structural and rely on review plus a runtime contract
check.**

The case for it: a structural interface is the idiomatic TypeScript answer, it
keeps the seam genuinely open to third-party implementations, and a runtime
contract check catches a no-op store anyway — as `createAudit`'s
`StoreContractViolated` shows.

Rejected because the contract check catches the *lazy* forgery and not the
*coherent* one. A store that maintains a plausible in-memory trace, assigns
monotonic sequences and echoes the canonical bytes passes every check
`createAudit` can make while persisting nothing. Branding does not close that
either — nothing can, short of replay — but it raises the floor from "a two-line
object literal" to "a coherent reimplementation of the store", and that is the
difference between a mistake somebody makes under deadline pressure and a
deliberate act.

The cost is on the record: **the seam is no longer open to third parties.**
`docs/design/OPEN-ITEMS-RESOLVED.md` item 1 anticipated the legitimate case — a
compliance archive under separate custody — and gives the answer: *that is an
adapter behind the same brand, not a reason to drop the brand.*

## What would change our mind

Named, observable triggers:

1. **A legitimate caller needing a recorder we cannot mint.** A compliance
   archive under separate custody is the named example. The response is a new
   shipped adapter behind the same brand, not removal of the brand.
2. **The brand leaking through declaration emit.** The guarantee depends on a
   non-exported `unique symbol` surviving into the `.d.ts` as an ambient,
   non-exported symbol. `approval/lib/clients.ts` records that this was checked
   for the capability phantom and compiles; a TypeScript release that changes
   declaration emit would be a trigger to re-verify every brand in the table
   above.
3. **`any` and `as` proving to be the normal path.** Branding is defeated by a
   cast. If casts around these seams show up in application code, the brand has
   become theatre and the honest response is to say so and find another
   mechanism — not to leave the claim standing.

## Where the code diverges from the design documents

The one gap this decision has **not** closed, and it is in shipped code:

- **`guardrails`' recording witness is caller-supplied and unbranded.**
  `GuardrailsDeps.audit` names `Audit`, a **structural** interface. A fully
  typed object that acknowledges every write and persists nothing satisfies it,
  and a caller holding one used to receive a real branded `Screening` over zero
  persisted bytes. `docs/design/OPEN-ITEMS-RESOLVED.md` item 1 resolved exactly
  this by branding — and the brand landed on `TraceStore`, one layer *below*
  `guardrails`, and on `Screening`, one layer *above*, but **not on `Audit`**.

  What `guardrails` does instead: it checks every acknowledgement against what
  it asked for, and proves the first node of each case **by replay** before any
  detector runs. A two-line impostor fails. A witness that maintains a coherent
  in-memory trace and writes no bytes still passes, exactly as `audit` says of
  its own contract check — so the scope is stamped onto every opened node as
  `capturedVia: "caller-supplied-audit-witness"` rather than asserted away.
  `guardrails/index.ts` reports **a brand on `Audit` as the real fix**, and it
  is not done. This belongs in "what isn't finished".

- **The honest claim, in all four modules, is scoped.** Every module states it
  in its own header rather than letting the stronger version stand:
  *unrepresentable through this module's seams*, not *unrepresentable*.
  Application code inside `decide` or `subject.decide` holds its own closure and
  can call a provider directly, and no type in this package reaches outside this
  package. Each module stamps the scope onto the artefact —
  `capturedVia: "injected-trace-store-only"`, `"declared-seams-only"`,
  `"injected-client-only"`, `"caller-supplied-audit-witness"` — so a reader in
  2033 learns the limit of the evidence from the evidence, not from a wiki that
  no longer exists. That is `FINDINGS.md`'s point 2, and it is the difference
  between an auditable system and one that merely claims to be.
