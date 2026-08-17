# agent-ops-core

Shared operational machinery for nineteen AI decisioning applications — claims
triage, invoice approval, ticket routing, expense validation, member
verification, underwriting document intake. They differ entirely in domain and
share almost all of their operational machinery. This is that machinery.

Five modules. Each is deep: a small interface over a large implementation, so
that nineteen callers learn a little and get a lot.

| Module | What a caller gets | Interface / implementation |
|---|---|---|
| `audit` | An append-only trace, replayable by correlation identifier, sealed at close, witnessed, and idempotent where the caller names the append | 412 / 5,888 lines |
| `approval` | Everything between a verdict and an effect: tier routing, reserved decisions, the human gate, the escalation ladder, dual control, durable suspension, idempotency, the tier-scoped kill switch | 385 / 6,690 |
| `guardrails` | Screening before a decision and checking before an effect, with redaction that runs before write and optional preemption of a runaway detector | 570 / 6,533 |
| `evals` | Golden suites, shadow runs, judge panels and a continuous-integration gate | 601 / 7,391 |
| `alerts` | The eight silent conditions, a severity model, an ordered sink chain, and durable heartbeats for an external watchdog | 401 / 4,484 |

87 test files, 825 tests. 786 are hermetic and run everywhere: no network, no
database, no real clock driving behaviour under test. That is structural, not
conventional — no module constructs its own model client, database handle,
clock or transport, so a test cannot reach a live model or a real pager with
real credentials sitting in the environment, and
`audit/tests/hermetic.test.ts` checks that promise against the source on disk
rather than trusting the paragraph you are reading.

The remaining 39 are **gated live-database tests**, one suite each under
`approval`, `audit`, `evals` and `guardrails`. They skip cleanly and load no
driver unless `AGENT_OPS_LIVE_DATABASE_URL` names a throwaway Postgres, so the
default run is unchanged; set it and they attack the schema's own guarantees
and assert which SQLSTATE and which named constraint refused each attempt. See
"Prove it against a real database" below.

Two places read the wall clock, both deliberately:
`guardrails/tests/preemption.test.ts` measures real elapsed time, because the
claim under test is that a runaway thread was really terminated, and a virtual
clock cannot show that; and the gated live suites, which are already talking to
a real server. Everything else drives an injected clock.

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
   ones. `alerts` ships the emit side, both store adapters, the verdict
   (`livenessFindings`) and the query (`livenessQuery`). It does **not** ship
   the watcher, and a watchdog that runs inside the process it watches fails
   silently at the exact moment it is needed. Deploy without an external
   watcher and a stopped sweeper stops chasing every waiting case, with nothing
   thrown and no dashboard red, until a customer telephones.
   `EXTERNAL_WATCHDOG_REQUIREMENT` is the sentence to carry verbatim. A durable
   liveness store makes the watcher's job possible; it does not make the
   watcher exist, and nothing in continuous integration can prove one is
   running — it is a second process on a second host.

**Guarantees that stop short of where they sound like they stop.**

2. **The witness that would cross a trust perimeter is not shipped.**
   `inMemoryWitness` and `postgresWitness` both sit inside our own custody, so
   an adversary holding both sets of credentials defeats both. The third
   adapter — a custodian outside this organisation — is named and deliberately
   unbuilt, because shipping it means choosing a custodian for nineteen
   applications.
3. **Retention is prepared, never performed.** `RetentionRegister` lists sealed
   cases past seven years and `Archivist.clearForRemoval` proves an archive copy
   faithful; every verb on both is a read, and the build fails if a removing
   verb is added. The removal itself is a procedure for a separately-authorised
   role against a runbook a person signs, because an `expire()` verb would mean
   nineteen applications holding a `DELETE` grant all day, every day.
4. **Redaction masks detected sites.** A name, address or diagnosis in a shape
   no pattern matched is recorded in full, bounded by `maxRecordedFieldChars`.
   `Screening.coverage` makes the residue visible — how much was examined,
   masked, and written verbatim — rather than claiming to have closed it.
5. **Preemption moves personal data into a heap this module cannot prove it
   released.** `preemptiveDetector` is opt-in per detector for this reason: the
   configured fields' text crosses into a worker thread that `guardrails`
   cannot freeze, deep-copy or prove it has cleared. Four things shrink the
   window — only configured fields cross, the worker drops its reference on
   reply, workers retire at `maxTasksPerWorker`, and a preempted worker is
   terminated immediately — and none of them closes it. The in-process detector
   remains the default.
6. **A caller-supplied detector that never yields is still unbounded.**
   `preemptiveScanPool` bounds the detectors that run in it. A detector that
   neither awaits, nor reads its deadline, nor runs in a pool has its *answer*
   refused on time and its *work* bounded by nothing this module can offer.
   `preemptiveScanPool` also requires the deployment to call `close()` at
   shutdown; idle workers are unref'd so a process can still exit, but an
   unclosed pool holds threads, and that is not enforceable from here.

**Duplication and drift we have named rather than fixed.**

7. **The abstention-rate and screening-rate watches are two implementations of
   one shape.** `guardrails` owns `createRateWatch` and watches the
   fail-closed screening rate; `approval` has a structurally parallel private
   one and watches the abstention rate, because an abstention is a *verdict*
   and only `approval` sees one. They cannot share code without one module
   reaching into the other's `lib/`. The long-term home for the shape is
   `alerts`, which owns the condition. Until it moves, a rule changed in one
   and not the other is a real drift risk.
8. **`auditBackedAlertJournal` never closes a trace, so it can find one already
   closed.** Sealing a case is `audit`'s reserved `case.` node and the alerting
   module has no business doing it. An application whose cases are closed by
   another path will find the journal opening a sealed case; `audit` raises
   `CaseAlreadyClosed`, which surfaces as `journalled: false, why:
   "journal-failed"` on an outcome that still says `delivered`. That is the
   safe direction and it is still a limit.
9. **An eval run identifier can collide between two processes.** `runId` is
   minted from the run key, the opening instant and a counter, so two processes
   opening the same run key in the same millisecond mint the same identifier
   and lose to the `eval_run` primary key. A benign concurrent-build race is
   reported as `EvalStoreUnavailable` — an integrity failure, exit 3. The fix
   is a design fork (a random suffix weakens content-addressing) and is not
   made.

**Release engineering that is guarded but not finished.**

10. **There is no publish pipeline.** `npm run check:package` proves the
    published surface is correct — `dist/` present, no sources, no build state,
    every export target resolving inside the tarball, zero runtime
    dependencies — but nothing tags, publishes, attaches provenance or checks
    the version. The guard exists; the pipeline does not.
11. **Continuous-integration actions are pinned to major tags, not commit
    digests.** `actions/checkout@v4` and `actions/setup-node@v4` are mutable
    references. Digest pinning is the right posture for a regulated library and
    needs someone with registry access to resolve them — a wrong digest is a
    workflow that never runs.
12. **`LICENSE` names no legal entity.** The package declares MIT and now ships
    the licence text, under the collective holder "the agent-ops-core authors".
    The real copyright holder must be confirmed before a first publish.

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
npm run check          # typecheck (sources and tests) + boundaries + vocabulary + 786 tests
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

## Prove it against a real database

`npm run check` is evidence about the adapters. It is **not** evidence that
append-only holds in Postgres, because the primary key, the one-seal partial
unique index, the parent foreign key, the immutability triggers and the
`INSERT`-only grants are properties of the database, not of TypeScript. Four
gated suites and one script close that, and none of them runs unless you point
them at a database:

```bash
npm run db:migrate -- --to postgres://…   # apply ./migrations in filename order
AGENT_OPS_LIVE_DATABASE_URL=postgres://… npm run test:live
AGENT_OPS_LIVE_DATABASE_URL=postgres://… npm run verify:liveness
npm run check:package                      # what the tarball would actually ship
```

Use a **throwaway** database. Every suite refuses one holding rows it did not
write, and `verify:liveness` truncates between groups. The connection must be
the table owner or a superuser: several cases deliberately step out of the
grants, so that the immutability trigger is the only thing left that can refuse
the write — a non-owner connection makes those pass for the wrong reason.

`npm run test:live` inverts the gate on purpose. Once the connection string is
set, a suite that *skips* is a **failure** (`LiveSuiteSkipped`), as is a suite
that reports no test at all. A live run that quietly skips is the false green
this whole arrangement exists to remove. Suites are discovered from
`<module>/tests/live-*.test.ts` rather than listed, so a new one is picked up
without an edit.

`alerts` has no gated suite and this is deliberate:
`alerts/tests/production.test.ts` asserts structurally that **no** file under
`alerts/tests/` reads an environment variable at all, and `alerts` is the module
that can page a real engineer at 03:00, so it holds the strongest hermetic
guarantee here. Its live coverage is `scripts/verify-liveness-store.mjs` —
outside the package, never collected by vitest — which runs the eight
`livenessStoreContract` obligations, the restart proof, six schema attacks and
seven concurrency checks against a real cluster.

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
