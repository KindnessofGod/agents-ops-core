# Design It Twice — findings and recommendation

Eight interfaces designed in parallel, each stress-tested by an independent
adversary who did not write it. 16 agents, ~1.59M tokens, 58 minutes.

Sources: `BRIEF.md` (the shared constraint set) and the eight design documents
in this directory.

## Scoreboard

Adversary scores, 1–10. Depth = leverage per unit of interface a caller must
learn. Audit = constraint C1, every node tracked and unrecorded execution
unrepresentable. Prod = constraint C2.

| Module | Shape | Depth | Audit | Prod | Σ | Verdict | Real seams | Speculative | Fatal flaws |
|---|---|---|---|---|---|---|---|---|---|
| approval | **common-case** | **7** | 6 | 5 | **18** | viable-with-fixes | 6 | 6 | 10 |
| evals | **common-case** | **7** | 6 | 5 | **18** | viable-with-fixes | 8 | 3 | 11 |
| approval | minimal | 6 | 6 | 5 | 17 | viable-with-fixes | 8 | 3 | 12 |
| evals | minimal | 6 | 5 | 4 | 15 | viable-with-fixes | 4 | 6 | 5 |
| approval | ports-adapters | 4 | 6 | 4 | 14 | viable-with-fixes | 9 | **9** | 5 |
| evals | ports-adapters | 4 | 5 | 5 | 14 | viable-with-fixes | 6 | **7** | 8 |
| approval | flexible | 3 | 6 | 4 | 13 | **reject** | 13 | 6 | 14 |
| evals | flexible | 3 | 6 | 4 | 13 | viable-with-fixes | 11 | 8 | 5 |

Three results are consistent across both modules and worth more than the
ranking itself.

**Common-case-optimised wins on depth, in both modules, by the same margin.**
Not marginally — 7 against 6, 4, 3. The mechanism is identical in both: the
caller *declares* rather than *drives*, so the phases are absent from the
interface rather than merely documented in the right order.

**Flexible loses on depth, in both modules, by the same margin.** Depth 3, and
outright rejected for `approval`. This is the exercise working: maximum
extensibility bought thirteen and eleven seams, most of them speculative, and
the depth the nineteen callers actually need was the currency it was bought
with.

**Ports-and-adapters committed exactly the failure it was warned about.** Nine
speculative seams in `approval`, seven in `evals` — the most of any shape, in
the shape explicitly instructed to hunt its own design for them. Sockets for
plugs nobody owns. It still produced the single best audit mechanism in the
exercise (below), which is the argument for running the shape at all.

## The finding that matters more than the ranking

**No design achieved constraint C1, and the ceiling was 6/10.** Every audit
score landed at 5 or 6. Only two of eight claimed unrecorded execution is
structurally impossible, and both claims were partly falsified on review.

The adversaries converged, independently, on why — and it is not a defect any
of the eight could have fixed:

> A handler is application code holding its own closure. It can call
> `treasuryApi.pay(invoice)` or `fetch()` directly, moving £47,200 with no node
> of any kind. Types cannot reach outside the library's own surface.

The `approval/minimal` adversary put it precisely: the honest claim is
"unrepresentable **through `EffectChannel`**", not "unrepresentable". That
design closed a narrow hole (a write-capable client during `handle`) while
leaving the wide one open and undeclared, which is worse than leaving both open
and saying so.

**This is the one place the user's instruction — "every single decision, node
must be tracked" — cannot be met absolutely, and must not be claimed.** The
achievable guarantee is:

1. **Every node the library mediates is captured**, and skipping it is a compile
   error rather than a discipline.
2. **The scope of the guarantee is stamped onto the artefact itself** —
   `capturedVia: "injected-client-only"` — so a reader in 2033 learns what the
   evidence covers from the evidence, not from a wiki that no longer exists.
3. **Out-of-band work is detected, not merely regretted**: a decision subtree
   with no recorded model call, where the subject has not declared itself pure,
   is `unscored`, counts against a coverage floor, and fails the build. Silent
   under-recording becomes a red build instead of a quiet green one.

Point 2 is the difference between an auditable system and one that merely
claims to be. A guarantee whose limits are documented is evidence; a guarantee
overstated is a liability the first time a regulator finds the gap.

## Recommendation: a hybrid, with one deliberate inversion

### Skeleton — `common-case`'s "declare, never drive", for both modules

The caller hands over a `DecisionPointSpec`; the module owns every phase.
`classify`, `handle`, `authorise` and `execute` are not discouraged out of
order — they are **absent from the interface**. There is nothing to call in the
wrong order and nothing to skip.

This is why it wins on depth in both modules, and it is the same reason C1 holds
by *absence* rather than by caller discipline. It also makes the discriminated
spec affordable: `UngatedSpec` cannot express a `brief`, `GatedSpec` requires
one non-optionally, and neither is an optional field wearing a required field's
clothes.

### The inversion — drop the low-tier concession

Both winning designs' authors, writing their own strongest objection
independently and about different modules, said the same thing:

> *approval:* "I optimised the case that needed the least help. This module's
> entire value is in the tail. The ungated low-tier point — 15 of every 16
> executions — is where being wrong costs almost nothing, while the £2M
> disbursement runs once a week and is the only reason `approval` exists."

> *evals:* "I optimised for the loudest caller, not the most important one. A
> pre-merge gate on a frozen golden suite is close to the least informative
> thing this module does. The questions that actually matter all live on the
> shadow path, which I deliberately made unpleasant."

They are right, and this is the most valuable output of the exercise. Two
authors, no contact, same diagnosis: **frequency was used as a proxy for value,
and in these two modules the value is in the tail.**

So take the declarative structure and drop the concession:

- **`approval`** — the same declaration shape at every tier, discriminated by
  type rather than shortened for the common one. This deletes the
  highest-severity flaw found anywhere in the exercise (`approval/common-case`
  fatal flaw 1: a low-tier point may declare no effects and call
  `client.write()` inside `decide`, producing an untraced effect on the path
  the design says is 15 of 16 executions). **No `decide` receives a
  write-capable client at any tier.** All effects go through declared
  `EffectDeclaration`s. One change; closes the escape and answers the author's
  objection.
- **`evals`** — the shadow path gets the same care as the gate path. Per
  ADR 0001, shadow is the only thing that can ever falsify the
  workflows-not-agents stance; making it a fourteen-field object with no
  defaults makes that decision unfalsifiable in practice.

### Grafts

Each was named by the adversary that found it as shape-independent and worth
stealing. All eight are compatible with the skeleton.

| # | Take | From | Why |
|---|---|---|---|
| 1 | `kernel(state, inbound): { next, nodes: NonEmpty<NodeDraft>, commands }` — a pure kernel returning I/O as *data*, where a step function that changes state and records nothing does not compile | approval/ports-adapters | The only mechanism in the exercise that makes an unrecorded **state transition** genuinely unrepresentable. Recording enforced by a return type, not a lint rule. Orthogonal to its shape. |
| 2 | The node handle **is** the capability: `NodeHandle` exposes only `child(spec, body)` — no `open`, no `close`; `ReadOnlyClient` has no exported constructor and comes only from a `NodeContext` that only `child` produces | evals/common-case | No node ⇒ no client ⇒ no model call. A subject that never calls `child()` still emits a complete graph having written zero recording code. Library writes the try/finally, the abort path and the throw path. |
| 3 | Phantom-literal `Client<"read">` / `Client<"write">` disjointness | approval/common-case | **Compiled and confirmed** by the adversary to error in both directions under `strictFunctionTypes`. Use this, **not** `approval/minimal`'s brand — see below. |
| 4 | `ReservedStatus` with no boolean and no `undefined` branch; `DoNothing<R>` conditionally deletes the `expire` branch when `R extends { reserved: true }` | approval/flexible | "We checked and it is not reserved" and "nobody thought about it" cannot share a representation. A reserved decision has no default to time out into, so "nobody was on shift" becomes inexpressible rather than forbidden. The best work in a rejected design. |
| 5 | `AnswerReceipt` with `by`, `at`, `node` and deliberately **no** `outcome` field | approval/minimal | Dual-control blindness becomes a *missing property* rather than a rule for whoever builds the screen. Take as a discriminated union `Brief<_,"first"> \| Brief<_,"second">`, not the phantom-parameter form, which erases at the seam. |
| 6 | Integers only in payloads — cost in tenth-cents, latency in micros, scores in basis points. No IEEE-754 anywhere | evals/common-case | Byte-stable serialisation is where replay dies quietly, and floats are how. |
| 7 | Derive the report type from the **case source**, not from which function was called | evals/ports-adapters | Agreement-is-not-accuracy becomes a consequence of provenance rather than a naming convention nineteen teams must remember. |
| 8 | "Nothing to report" as an **assertion about a search performed** — `searchedAndFoundNone: { searched: string }` — never an empty array | approval/common-case | Absence of a finding is not a finding. Applies directly to the approval brief's contrary-evidence field. |

### Explicitly rejected

- **`approval/minimal`'s capability brand.** The adversary compiled it against
  tsc 5.9.3: `error TS2430: Interface 'WriteCapableClient' incorrectly extends
  interface 'ReadOnlyClient'`. The single highest-leverage requirement in the
  library, expressed in five lines that do not build — and the document quotes
  a compiler error it never saw. Graft 3 is the working equivalent.
- **`approval/flexible` wholesale.** Depth 3, thirteen seams, fourteen fatal
  flaws, rejected. Take graft 4 and leave the rest.
- **The eight-port width of `ports-adapters`**, in both modules. Take graft 1
  and leave the sockets.
- **`evals/flexible`'s twelve-socket plan.** Its demand algebra (generators
  yielding typed `Demand`s, so recording *is* the fulfilment rather than a
  wrapper around it) is arguably the strongest C1 idea in the exercise, and its
  own adversary noted it works with three entry points and two seams. **Deferred,
  not rejected** — it is a larger bet than the rest of the hybrid and would be
  the thing to reach for if graft 2 proves insufficient in practice.

## Open, and worth deciding before the first test

1. **Where the recorder comes from.** `evals/common-case` fatal flaw 2: the
   recorder is supplied by the thing being measured and is unbranded, so a
   caller-supplied no-op passes every downstream check. The recorder must be
   branded and must not arrive through the subject.
2. **What drives time.** `approval/common-case` fatal flaw 5: two
   caller-initiated entry points, and yet the design owes expiry, the
   do-nothing consequence, bounded backoff on brief delivery, and licence
   leases. Nothing drives them. A sweeper is needed and should be an honest
   fourth entry point rather than hidden inside another — `approval/minimal`'s
   author conceded exactly this about their own `advance({kind:"due"})`.
3. **In-doubt effects.** Neither winner has a policy for process death *after*
   an idempotency key is claimed and *before* the outcome is recorded. Needs a
   lease, a TTL and a reaper, resolving toward not paying twice.
4. **Retention versus append-only.** `evals/common-case` fatal flaw 6: expiring
   eval nodes requires a `DELETE` grant on trace tables, which breaks `audit`'s
   headline invariant for all four modules. Eval nodes need their own store or
   their own partition.
5. **Risk tier per case or per decision-and-effect** — still outstanding from
   `CONTEXT.md`, and now concrete: the declarative skeleton makes per-decision
   natural, since a spec is declared per decision point rather than per case.

## Method note

The exercise is worth repeating. Its highest-value outputs were not the designs
but three things the designs could not have produced alone: two authors
independently diagnosing the same strategic error in their own winning work; an
adversary compiling the code and falsifying a guarantee stated in prose; and
the discovery that the constraint the project cares most about has a hard
ceiling that must be documented rather than claimed.
