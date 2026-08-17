# agent-ops-core

Shared operational machinery for nineteen AI decisioning applications — claims
triage, invoice approval, ticket routing, expense validation, member
verification, underwriting document intake. They differ entirely in domain and
share almost all of their operational machinery. This is that machinery.

Five modules. Each is deep: a small interface over a large implementation, so
that nineteen callers learn a little and get a lot.

| Module | What a caller gets | Interface / implementation |
|---|---|---|
| `audit` | An append-only trace, replayable by correlation identifier, sealed at close and witnessed | 386 / 5,404 lines |
| `approval` | Everything between a verdict and an effect: tier routing, reserved decisions, the human gate, the escalation ladder, dual control, durable suspension, idempotency, the kill switch | 357 / 6,222 |
| `guardrails` | Screening before a decision and checking before an effect, with redaction that runs before write | 467 / 5,512 |
| `evals` | Golden suites, shadow runs, judge panels and a continuous-integration gate | 601 / 7,378 |
| `alerts` | The eight silent conditions, a severity model, an ordered sink chain, and heartbeats for an external watchdog | 345 / 3,194 |

76 test files, 707 tests, all hermetic: no network, no database, and no real
clock driving any behaviour under test — `evals/tests/bounds.test.ts` reads the
wall clock twice, as a coarse ceiling on its own runtime, and nothing else does.
That is structural, not conventional — no module constructs its own model
client, database handle, clock or transport, so a test cannot reach a live
model or a real pager with real credentials sitting in the environment.

Read `docs/CONTEXT.md` before naming anything. The vocabulary is binding and
several of its terms overlap in ordinary speech: *unassisted containment* is
not *resolution*, *abstention* is not *escalation*, an *alert* is not an
*escalation*, and bare `containment` is a lint failure.

---

## What isn't finished

The library works and its five modules are implemented. What follows is what it
does **not** do, stated at the top because an overstated guarantee is a
liability the first time a regulator finds the gap.

**You must deploy something this library does not ship.**

1. **The watchdog is external and is not here.** `approval.sweep` fires every
   reminder in the system and emits a heartbeat on every run, including empty
   ones. `alerts` ships the emit side, the store, the verdict
   (`livenessFindings`) and the query (`livenessQuery`). It does **not** ship
   the watcher, and a watchdog that runs inside the process it watches fails
   silently at the exact moment it is needed. Deploy without an external
   watcher and a stopped sweeper stops chasing every waiting case, with nothing
   thrown and no dashboard red, until a customer telephones.
   `EXTERNAL_WATCHDOG_REQUIREMENT` is the sentence to carry verbatim.
2. **Liveness records are held in memory only.** `inMemoryLivenessStore` is the
   one shipped adapter; `postgresLivenessStore` is named and not built, because
   it needs a migration that does not exist. Beat history dies with the
   process, so a watcher polling across a restart sees `never-seen` rather than
   a real gap. That is the safe direction and it is still a limit.
3. **`AlertJournal` also has one adapter**, in memory. The `audit`-backed one is
   named and not built.

**Guarantees that stop short of where they sound like they stop.**

4. **`audit.record` is not idempotent.** A retry after a crash appends a second
   node rather than returning the first. Deduplicating appends needs an
   idempotency-key column and a partial unique index that
   `migrations/0002_audit_trace.sql` does not have. At-most-once is about
   *effects*, and `approval` owns that.
5. **The Postgres schema's own guarantees are not exercised by any test here.**
   The primary key, the one-seal partial unique index, the parent foreign key,
   the immutability triggers and the `INSERT`-only grants are properties of
   Postgres. No test in this package opens a socket, deliberately, so a green
   test run is evidence about the adapters' behaviour and is **not** evidence
   that append-only holds in the database. `sqlExecutorContract` is runnable
   against a live pool from an operational script; nothing runs it in
   continuous integration today.
6. **The witness that would cross a trust boundary is not shipped.**
   `inMemoryWitness` and `postgresWitness` both sit inside our own custody, so
   an adversary holding both sets of credentials defeats both. The third
   adapter — a custodian outside this organisation — is named and deliberately
   unbuilt, because shipping it means choosing a custodian for nineteen
   applications.
7. **Retention is prepared, never performed.** `RetentionRegister` lists sealed
   cases past seven years and `Archivist.clearForRemoval` proves an archive copy
   faithful; every verb on both is a read, and the build fails if a removing
   verb is added. The removal itself is a procedure for a separately-authorised
   role against a runbook a person signs, because an `expire()` verb would mean
   nineteen applications holding a `DELETE` grant all day, every day.
8. **`Audit` is the one unbranded witness.** `TraceStore`, `EvalNodeStore`,
   `RunLedger` and `Screening` are branded with non-exported symbols, so
   structural impostors do not typecheck. `GuardrailsDeps.audit` names `Audit`,
   which is structural: a fully-typed object that acknowledges every write and
   persists nothing satisfies it. `guardrails` compensates by checking every
   acknowledgement and proving its first node by replay. A brand on `Audit` is
   the real fix and is not done.
9. **Redaction masks detected sites.** A name, address or diagnosis in a shape
   no pattern matched is recorded in full, bounded by `maxRecordedFieldChars`.
   `Screening.coverage` makes the residue visible — how much was examined,
   masked, and written verbatim — rather than claiming to have closed it.
10. **A polynomial detector stall is still reachable.** `safePattern` refuses
    every regular expression capable of exponential backtracking, but an
    accepted pattern can still cost on the order of `maxFieldChars²` character
    comparisons on one field, and nothing in this runtime can preempt it. The
    bound is computable from `Limits`; true preemption needs a worker thread.
11. **Half of the eighth silent condition is unimplemented.** `docs/CONTEXT.md`
    names it "abstention rate, **or** fail-closed screening rate, moves
    sharply". `AlertCondition.measure` declares both; only
    `fail-closed-screening` is ever produced. Nothing here watches the
    abstention rate.
12. **Kill-switch scope is recorded, not enforced.** `CONTEXT.md` says a kill
    switch stops effects "system-wide or per tier". `KillSwitchReader` takes no
    tier and asks no per-tier question; `scope` is a string written onto the
    node. Per-tier behaviour is the reader's own business, and the trace will
    faithfully record whatever it claims.

**Adapters the applications must bring.** The library ships no domain, so it
ships no `TierPolicy`, `ReservedPolicy`, `AuthorityDirectory` or
`BriefRenderer`; no `Classifier` for the model detector; no `ModelBackend`
beyond `scriptedModelBackend`; and no database driver — `SqlExecutor` arrives as
a parameter, because this package may not take a dependency nineteen
applications inherit.

**Per application, and blocking production rather than the build**: the
entitlement standard, the resolution evidence source and window, and the
reserved-decision list. Until an application supplies them its resolution field
stays empty and its reserved list is empty — honest and visibly incomplete
rather than quietly wrong.

**Not yet wired to each other.** `Groundedness` is implemented once in
`guardrails` and shaped so `evals` can consume it as a scorer, but no shipped
adapter converts one into a `Scorer`; only `guardrails` wraps it today. `evals`
exports `exitCodeFor` and no `bin` wrapper.

---

## Run it

Four commands, no account anywhere:

```bash
git clone https://github.com/kindnessofgod/agents-ops-core.git
cd agents-ops-core && npm install
npm run db:up          # Postgres 16 + migrations, via docker compose
npm run check          # typecheck + module boundaries + 707 tests
```

`npm run db:up` starts Postgres 16 on host port **5433** (not 5432, so it will
not collide with a Postgres you already run) and applies everything in
`./migrations` in filename order the first time the volume is created.
Credentials are `agent_ops` / `agent_ops` / `agent_ops` — identical for
everyone, secret from nobody. Override the port with `AGENT_OPS_PG_PORT`.
`npm run db:reset` drops the volume and re-applies the migrations from scratch.

Tests need no database and no network. `npm run db:up` is for running the
system, not for `npm test`.

---

## Worked example

An invoice, traced end to end. This compiles against the shipped interface and
the output below is what it prints.

```ts
import {
  createAudit,
  inMemoryTraceStore,
  redactFields,
  systemClock,
  type CorrelationId,
} from "agent-ops-core/audit";

// One composition root. Every dependency is a parameter: nothing below
// constructs a clock, a database handle or a network client, which is why a
// test cannot reach a live model or a real database with real credentials
// sitting in the environment.
const audit = createAudit({
  store: inMemoryTraceStore(), // postgresTraceStore(sql) in production
  clock: systemClock(),
  redact: redactFields(["supplierAccount"]),
  // Required, with no default. `high` is pinned to "fail-closed" by the type:
  // no configuration change makes a high-tier decision proceed untraced.
  onTraceUnavailable: { high: "fail-closed", medium: "fail-closed", low: "degrade" },
});

const invoice = "inv_88214" as CorrelationId;
const trace = await audit.open(invoice);

// Reading the invoice is low risk. At low tier the policy above permits a
// degraded write, so the result type makes you look at it.
const extracted = await trace.record(
  { kind: "invoice.extracted", v: 1, lines: 14, totalMinor: 4_720_000 },
  { tier: "low" },
);
if (!extracted.recorded) throw new Error(`trace degraded: ${extracted.reason}`);

// Paying it is high risk. Same case, same minute — which is why tier attaches
// to a decision-and-its-effect and a case has a tier profile. At high tier
// `record` cannot return a degraded result, so there is no branch to write.
const determined = await trace.record(
  {
    kind: "invoice.determined",
    v: 1,
    verdict: "pay",
    confidenceBasisPoints: 9_700, // basis points, never a float
    supplierAccount: "60-16-13 41234567", // redacted before any store sees it
  },
  {
    tier: "high",
    parent: extracted.node,
    telemetry: {
      costTenthCents: 412,
      tokensIn: 3_180,
      tokensOut: 240,
      latencyMicros: 1_284_000,
      priceTableVersion: "prices-2026-08",
    },
  },
);

// A named human approved the payment, so the case was not unassisted. Note
// what cannot be written here: there is no `success` field and no `resolution`
// field, because resolution needs evidence gathered after close.
await trace.close({ unassistedContainment: false });

const replayed = await audit.replay(invoice);
console.log(replayed.nodes.length);                                  // 3
console.log(replayed.childrenOf(extracted.node.id).map((n) => n.payload["kind"]));
console.log(replayed.closed, replayed.verify(replayed.digest()));    // true true
console.log(determined.node.payload["supplierAccount"]);             // [redacted]
```

```
3
[ 'invoice.determined' ]
true true
[redacted]
```

Four things in twelve lines of output, and each is an invariant rather than a
behaviour you configured:

- **Three nodes, not two.** `close` appends a seal — the digest of everything
  before it, the count it sealed, and the case's scope statement — and `replay`
  reads the seal rather than trusting it.
- **A graph, not a list.** The determination names the extraction as its
  parent, and a parent from another case is refused before either store adapter
  sees it.
- **The digest verifies against itself.** Wire a `Witness` and `close` publishes
  it, so `verifyAgainstWitness` can check the archive against what was published
  rather than only against itself.
- **The account number never reached the store.** Redaction runs before write,
  because there is no un-writing.

What this example does *not* show is the human gate. `audit` records; it never
routes. Suspending a case until a named authority answers, chasing them on a
ladder that cannot terminate into silence, and licensing the payment exactly
once is `approval`'s job — see `docs/ARCHITECTURE.md` for the whole path.

---

## The rules that are not negotiable

Every one of these is enforced by a type, a grant or a build step rather than by
review.

- **Append-only.** No `update`, no `delete`, no `amend` — in the interface or in
  the database grants. Re-judging a case appends a node.
- **Integers only in payloads.** Money in minor units, cost in tenth-cents,
  latency in microseconds, confidence and scores in basis points. Byte-stable
  serialisation is what makes replay possible, and IEEE-754 is how it dies
  quietly.
- **The clock is injected.** `Date.now()` appears only inside `systemClock`
  adapters — two of them, `audit`'s and `alerts`' — never inside a module. That is what makes an eleven-day escalation ladder
  testable in a millisecond.
- **Reserved decisions are structural.** No setting, threshold or override makes
  one automatic, whatever the model's confidence. Their correct unassisted
  containment is exactly zero — not low, nil.
- **A gated decision cannot be declared without a non-empty ladder** and a
  recurrence that has no stop value and no maximum attempt count. Declaring a
  human gate without saying what happens as it ages does not compile.
- **`awaiting_authority` is not terminal and is never contained.** A buried case
  stays answerable indefinitely; only an authority closes it.
- **Effects are never auto-retried out of doubt.** Three idempotency states —
  `not-attempted`, `unknown`, `settled` — and ambiguity resolves toward not
  paying twice.
- **Fail-closed by default, and where it is not, the type says so.** Exactly one
  error mode in `audit` is degradable; `guardrails` and `evals` have none at any
  tier. 86 named error modes across the five modules, each with a policy and a
  reason.
- **No personal data in an alert.** No condition carries a free-text field, and
  a sink failure records the exception's name only — never its message, which
  routinely echoes the request that failed.

---

## Layout

```
packages/agent-ops-core/src/    the library; one folder per module
  <module>/index.ts             the module's interface. Public.
  <module>/lib/                 implementation. Private.
  <module>/tests/               tests + fixtures. Private.
migrations/                     SQL, applied in filename order
docs/                           Track A — for engineers
docs/business/                  Track B — for everyone else
docs/adr/                       one record per significant decision
docs/DECISIONS.md               the builder's log
```

`npm run lint:boundaries` (dependency-cruiser) fails the build if anything
outside a module reaches into its subfolders — including `src/index.ts` itself,
and including a module's own tests, which cross the same seam as the nineteen
callers. If a test needs to reach past the interface, the module is the wrong
shape.

Each module is also a published subpath: `agent-ops-core/audit`,
`/approval`, `/guardrails`, `/evals`, `/alerts`. Those are the preferred
imports. The root namespace export exists, but four of the five modules export
a `DEFAULT_LIMITS` and each means something different — bytes per payload,
concurrent runs, recorded field characters, an alert suppression window — so
flattening them would silently resolve one caller's limit to another module's
number.

---

## Documentation

`docs/CONTEXT.md` is the ubiquitous language and is binding on code, column
names, metrics and both documentation tracks. `docs/ARCHITECTURE.md` is the
engineering picture: five diagrams, each module's interface in full, and where
each guarantee stops. `docs/RUNBOOK.md` is the operational one, and it carries
`EXTERNAL_WATCHDOG_REQUIREMENT` verbatim — read section 0 before deploying
anything.

`docs/design/OPEN-ITEMS-RESOLVED.md` records seven decisions that shaped the
build — the escalation ladder that cannot stop, the branded recorder, the
sweeper as an honest fourth entry point, three idempotency states, a separate
store for eval nodes, tier per decision-and-effect, and the alerting seam. Each
has been promoted into `docs/adr/`, which now holds thirteen records, and
decisions reach
`docs/DECISIONS.md` only through `/log-review`, in the user's own wording.

Both tracks are written from the code that exists rather than from the plan.
Where a design document and the code disagree, the code is the truth and
`docs/ARCHITECTURE.md` says where.
