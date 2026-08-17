# Open items — resolved

The five items `FINDINGS.md` flagged as needing settlement before the first
test, plus a sixth the user found by reading the findings. Each resolution is
a decision, not a survey. Each names what would reverse it.

Promote to ADRs on the way into implementation.

---

## 0. Ageing: a reserved decision must get louder, never quieter

**Found by the user**, reading item 2 against the reserved-decision rule.

> *"does this mean that if somebody was meant to do something, say approve an
> AI automation so it can proceed, it will not, and just remain stale and the
> process ends there buried and unresolved?"*

**As designed: yes, and that was a defect.** Two correct rules combined into an
incorrect system. `approval/flexible` correctly deletes the expiry branch for
reserved decisions, so a decision cannot time out *into* a verdict. But nothing
in any of the eight designs drives ageing, so the case simply stops — no error,
no red dashboard, no queue entry growing old. Silently un-decided.

That is the dangerous quadrant of `CONTEXT.md` reached by a path nobody
designed: not resolved, not honestly contained, and invisible.

### Resolved

Both sides enforced in the type:

```ts
type DoNothing<R extends ReservedStatus> =
  R extends { reserved: true }
    // No expire branch. Nothing terminal without an authority answering.
    ? { readonly ladder: EscalationLadder }
    : { readonly ladder: EscalationLadder
        readonly expire?: { readonly after: Duration; readonly then: Settlement } }

interface EscalationLadder {
  readonly steps: NonEmpty<EscalationStep>
  /** Mandatory. There is no "stop" value and no maximum attempt count. */
  readonly recurrence: Recurrence
}

interface EscalationStep {
  readonly after: Duration
  readonly action: "notify" | "escalate" | "alert" | "page"
  readonly to: AuthorityRef
}

interface Recurrence {
  /** Floor interval. Never accelerates — a flooded channel gets muted. */
  readonly every: Duration
  /** Each cycle adds recipients rather than raising volume to the same one. */
  readonly widenTo: NonEmpty<AuthorityRef>
}
```

**The ladder cannot terminate into silence.** Keep asking, at a steady interval,
until somebody answers — the type has no way to express giving up. A decision
that needed a human yesterday still needs one next month; a system that stops
asking has decided by exhaustion, which is exactly what reserved decisions
exist to prevent.

Two production constraints, the second usually missed. **Cadence is bounded and
never accelerates** — a recurrence that speeds up floods the channel, the
channel gets muted, and the case becomes *less* likely to be answered than if
nothing had been sent. **Recurrence widens the audience rather than raising the
volume**: the fifteenth reminder to someone who ignored fourteen is not a plan,
so each cycle adds deputy, then line manager, then accountable executive, at a
steady cadence. Every reminder sent is a recorded node, so "we chased them" is
evidence rather than an assertion.

A gated decision **cannot be declared without a non-empty ladder**. Declaring a
human gate without saying what happens as it ages does not compile. Removing
the expiry branch is necessary and was never sufficient.

Consequences:

- **`awaiting_authority` is not a terminal state and is never `contained`.** The
  terminal-state union excludes it, so no metric can count a waiting case as
  finished in either direction.
- **Ageing is recorded as nodes.** A case that waited eleven days and escalated
  four times has that written down, not inferred from two timestamps.
- **A buried case** — ladder exhausted, still unanswered — is an **incident**,
  not a state. It stays answerable indefinitely, never self-resolves, never
  disappears from a queue, never acquires a verdict from the passage of time.
  The library refuses to close it; only an authority can.

**What would change our mind:** an application demonstrating a lawful basis for
a reserved decision to complete without an authority. We are not aware of one
and would want to see the statute.

---

## 1. Where the recorder comes from

**The problem** (`evals/common-case` fatal flaw 2): the recorder arrives
*inside* `SubjectDeps` — supplied by the very thing being measured — and is an
unbranded plain interface. An application can pass
`{ append: async n => ({ ...n, sequence: 0n }) }`, and every downstream check
still reports success: nodes "acknowledged", digest computed, report green,
nothing written anywhere.

The audit guarantee is only as strong as the weakest recorder any caller can
supply, and an unbranded interface makes that weakest recorder a two-line
object literal.

### Resolved

1. **The recorder is branded with a non-exported `unique symbol`.** Only
   `audit`'s own constructors mint one. A caller cannot name the brand, so a
   structural impostor does not typecheck.
2. **It never arrives through the subject.** It is a parameter of the runner,
   supplied by the composition root, and the subject receives only a
   `NodeContext` derived from it. The thing being measured cannot choose its own
   witness.
3. **Two adapters, both shipped**: Postgres-backed, and in-memory. The
   in-memory one is a deliverable — it is what makes hermetic tests structural
   rather than conventional — not a mock, and not a licence for a third.
4. **Acknowledgement carries a store-assigned sequence**, so a recorder that
   returns without writing cannot fabricate one.

**What would change our mind:** a legitimate caller needing a recorder we cannot
mint — a compliance archive under separate custody, say. That is an adapter
behind the same brand, not a reason to drop the brand.

---

## 2. What drives time

**The problem** (`approval/common-case` fatal flaw 5): two caller-initiated
entry points, `run` and `answer`, and yet the module owes expiry, the ladder
above, bounded backoff on brief delivery, `AuthorityUnavailable` alerting, and
idempotency-lease reclamation. Nothing drives any of it. `approval/minimal`'s
author conceded the same about their own `advance({ kind: "due" })` — a
scheduled sweeper hidden inside another verb "because my assigned shape forbade
a fourth entry point, which is a rule about the deliverable rather than a fact
about the module."

### Resolved

**An honest fourth entry point: `approval.sweep(now)`.** Not hidden inside
another verb.

- **Idempotent and re-entrant.** Two sweepers running concurrently must be
  safe — they will be, during a deploy.
- **Bounded per invocation.** Takes a batch limit; never "process everything
  due".
- **Leases what it touches**, with a TTL, so a sweeper dying mid-batch does not
  freeze the cases it claimed.
- **Records its own nodes.** A ladder step firing is a recorded fact with a
  parent, like any other node.
- **The clock is injected**, so the whole of ageing is testable without waiting
  and without a real timer.

Four entry points beats three plus a lie. The shape rule said 1–3; the module
needs 4, and the exercise was for contrast, not for a spec.

**What would change our mind:** nothing plausible. Every durable-suspension
system needs something to drive time. Hiding it does not remove it.

---

## 3. In-doubt effects

**The problem**: neither winner has a policy for process death *after* an
idempotency key is claimed and *before* the outcome is recorded. No lease, no
TTL, no reaper, no dead-letter. The classic distributed-systems hole, and here
it is a payment.

### Resolved

Three states, not two. `not-attempted` and `unknown` must never share a
representation — the distinction decides whether a retry is safe.

| State | Meaning | On retry |
|---|---|---|
| `not-attempted` | Key claimed, no outbound call made | Safe to execute |
| `unknown` | Outbound call made, outcome unrecorded | **Never auto-retry** |
| `settled` | Outcome recorded | Return the original outcome |

- The claim is written **before** the outbound call, with a lease and a TTL.
- An expired lease in `unknown` is **not** reclaimed for execution. It goes to a
  reconciliation queue for a human, with the full trace attached.
- **Ambiguity resolves toward not paying twice.** A duplicated payment is a
  clawback, a customer-trust incident and a regulatory conversation; a delayed
  payment is a phone call. These costs are not symmetric and the default must
  not pretend they are.
- `IdempotencyIndeterminate` is a named error mode with `unknown` semantics,
  fail-closed, and it alerts.

**What would change our mind:** an effect channel offering true exactly-once
delivery with a provider-side idempotency key we can pass through. Then
`unknown` collapses to a provider query and the reconciliation queue mostly
empties. Worth asking every effect channel we integrate.

---

## 4. Retention versus append-only

**The problem** (`evals/common-case` fatal flaw 6): eval runs generate on the
order of 10M nodes a day and want 90-day retention. Expiring them needs a
`DELETE` grant on the trace tables. `audit`'s headline invariant is that those
grants withhold `UPDATE`/`DELETE` "so the guarantee holds even against someone
with a psql prompt". Granting `DELETE` to expire eval nodes voids append-only
for all four modules and all nineteen applications — to save disk on test data.

### Resolved

**Separate stores, one interface.** `evals` nodes go to their own physical
store with its own grants and its own retention. `audit` case traces keep
`INSERT`-only grants and the seven-year retention. Same `Recorder` interface,
same brand, same node shape, different store.

- Rejected: partitioning within the same tables. It still requires the grant to
  exist on the role, and a grant that exists is a grant that gets used.
- Rejected: no retention on eval nodes. 10M/day compounding for seven years to
  keep records of tests is not a defensible use of a regulated archive.
- **A trace never spans both stores.** An eval run reading recorded production
  cases *reads* the audit store and *writes* its own. Read one, write the other,
  never interleave.

**What would change our mind:** measured eval volume coming in two orders of
magnitude below the estimate. Then one store with no deletes is simpler and
cheap enough. Measure before the second migration.

---

## 5. Risk tier: per case, or per decision-and-effect?

Outstanding since `CONTEXT.md`, where it was raised against the brief as
written. The design exercise has now made it concrete.

### Resolved: per decision-and-effect

The declarative skeleton settles it. A `DecisionPointSpec` is declared **per
decision point**, not per case. Reading an invoice and paying it are two
declarations, so they carry two tiers naturally, and a case has a **tier
profile** rather than a tier.

Per-case would mean every step of a high-value case running under maximum
guardrails at maximum cost and latency — and teams would respond by splitting
cases to get their throughput back, which fragments the trace. Fragmenting the
trace to work around a tiering decision is a bad trade in a library whose main
product is the trace.

The concession stands: per-case is simpler to explain to an auditor. The answer
is that a tier profile is explainable too, and it is explainable *truthfully*,
which the alternative is not once teams start splitting cases.

**What would change our mind:** an auditor or regulator in any of these markets
requiring a single documented risk classification per case. That is a
presentation requirement, and we would satisfy it by deriving a headline tier —
the maximum across the profile — for reporting, without changing the enforcement
model underneath.

---

## Summary of what changed in the design

| Item | Change |
|---|---|
| 0 | `DoNothing` requires `NonEmpty<EscalationStep>` for every gated decision. `awaiting_authority` is non-terminal and never contained. A buried case is an incident that only an authority can close. |
| 1 | Recorder branded with a non-exported symbol, supplied by the composition root, never through the subject. |
| 2 | Fourth entry point `approval.sweep(now)` — bounded, leased, idempotent, records its own nodes, injected clock. |
| 3 | Three idempotency states. `unknown` never auto-retries; it queues for a human. Ambiguity resolves toward not paying twice. |
| 4 | `evals` nodes get their own store. `audit` keeps `INSERT`-only grants. A trace never spans both. |
| 5 | Tier attaches per decision-and-effect. A case has a tier profile. Headline tier derived for reporting if ever required. |
