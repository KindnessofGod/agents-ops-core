# 0014 — A deduplicated append is named by the caller, never derived from its content

**Status:** Accepted
**Date:** 2026-08-17

## Context

`audit.record` was not idempotent. A process that crashed between the database
committing an append and the caller observing the acknowledgement had no way to
retry: the retry appended a second node, and the trace then said an event
happened twice when it happened once. `README.md`'s gap list carried this as
item 4 for the whole of the previous release.

Deduplicating an append needs two things the schema did not have: somewhere to
record *which* append this is, and a uniqueness rule the database enforces
rather than the adapter. The question this record settles is what "which append"
means.

## Decision

**The caller supplies an idempotency key.** `RecordOptions` gains an optional
`idempotencyKey`; `migrations/0007_audit_idempotency.sql` adds a nullable
`idempotency_key` column, a bounded-length check constraint, and a partial
unique index on `(correlation_id, idempotency_key) WHERE idempotency_key IS NOT
NULL`. An append carrying a key that already exists on that case returns the
**first** node with `deduplicated: true` and writes no row.

`Recorded` gains a **required** `deduplicated: boolean`. It is required rather
than optional because "your node is in the trace" and "your node was already in
the trace, from the attempt that crashed" are the same outcome and different
stories, and a caller writing a reconciliation report needs to tell them apart.

Two new error modes, both fail-closed, both with the reason stated on the class:

- `IdempotencyKeyUnusable` — empty, or over `MAX_IDEMPOTENCY_KEY_CHARS` (200).
  The empty half is the dangerous one: an empty string is a valid key, so every
  keyless-but-not-really append in a case would collide with every other.
- `IdempotencyKeyConflict` — a key reused for a *different* payload, tier,
  parent or telemetry. It raises rather than returning the first node, because
  silently returning the first node would make the caller's second event vanish
  from the evidence.

## The alternative rejected

**A content-derived digest** — deduplicate on a hash of the payload, tier and
parent, so no caller has to name anything and retries are free.

Rejected because it is lossy in exactly the case that matters. Two genuinely
distinct appends can carry identical payloads: the same field read twice, the
same detector firing twice on one case, the same reminder sent twice under a
recurrence rule that is *supposed* to repeat. A content digest collapses those
into one node and the trace loses a real event. **A trace that loses a real
event to make a retry cheaper is not evidence**, and the seven-year archive is
the one place in this library where being cheap is worth nothing.

The caller-supplied key inverts the default correctly: absent a key, nothing is
deduplicated and a retry appends — visibly, and recoverable by reading the
trace. Present a key, the caller has asserted "these two attempts are one
event", which is a claim only the caller is in a position to make.

## Consequences

- Nineteen applications may adopt this incrementally. `idempotencyKey` is
  optional and the default behaviour is unchanged.
- Both shipped adapters hold the rule through **one** shared expression of it
  (`audit/lib/idempotency.ts`), so the module's oldest defect class — two
  adapters claiming one invariant and holding different ones — cannot recur
  here. A test drives the same assertions through both.
- The clock is not compared on a deduplicated append, in exactly one place:
  `verifyAcknowledgement` relaxes the `at` check *only* when a key was supplied,
  because a crash-retry is a later process whose clock has moved. To stop that
  becoming a hole, a store may only claim `deduplicated: true` for an append
  that carried a key — otherwise "I already had this" becomes a way for an
  adapter to acknowledge anything without writing it, which is the exact hole
  the acknowledgement check exists to close.
- In the Postgres adapter the deduplication lookup runs under the per-case
  advisory lock and **before** the closure check, so a retry of an append that
  already succeeded returns the first node even if the case has since been
  sealed. Without that ordering the two adapters would diverge: the in-memory
  one would deduplicate and the Postgres one would raise `CaseAlreadyClosed`.

## What would change our mind

A caller demonstrating that it genuinely cannot name its own retries — that the
crash boundary is upstream of anywhere a key could be minted. The answer then is
not a content digest but a key minted by whatever *does* own the boundary, and
passed through.
