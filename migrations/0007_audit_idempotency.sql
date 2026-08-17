-- 0007_audit_idempotency.sql
-- The column and the partial unique index that make `audit.record` idempotent.
--
-- ## The gap this closes
--
-- `README.md` item 4 and the note in `src/audit/index.ts` both said the same
-- thing: `record` is not idempotent, a retry after a crash appends a SECOND node
-- rather than returning the first, and deduplicating appends needs an
-- idempotency-key column and a partial unique index that
-- `migrations/0002_audit_trace.sql` does not have. This file is that column and
-- that index.
--
-- The trace stays append-only. Nothing here grants UPDATE, nothing here weakens
-- a trigger, and a deduplicated retry writes NO row at all — it loses the insert
-- to the index below and the store reads the first node back. Deduplication is
-- therefore a property of the DATABASE, not of a cache in the writer that a
-- restart forgets.
--
-- ## Why the key is caller-supplied, and why it is optional
--
-- Two rejected alternatives, recorded because the choice is not obvious:
--
--   1. **A content digest as the key.** Free, needs no interface change, and
--      wrong: two genuinely distinct appends carrying identical payloads in the
--      same case — the same retry of the same downstream call, recorded twice
--      because it genuinely happened twice — would silently collapse into one.
--      A trace that quietly loses a real event to make a retry cheap is not
--      evidence. The library refuses to guess which of the two a caller meant,
--      exactly as it refuses to guess a resolution evidence source.
--   2. **A key on every append, required.** It would make every caller invent
--      one, including the overwhelming majority who append inside a transaction
--      that either happens or does not. The column is NULLABLE and the index is
--      PARTIAL for that reason: a node with no key participates in no uniqueness
--      constraint and costs nothing, and only the appends a caller has decided
--      are retryable carry one.
--
-- ## Why the uniqueness is per case, not global
--
-- `(correlation_id, idempotency_key)`. Nineteen applications write into one
-- cluster and each mints keys in its own namespace; a global unique index would
-- make one application's `"attempt-1"` collide with another's, and the failure
-- would arrive as a phantom deduplication — the second application's node
-- silently replaced by the first application's node from a different case. Per
-- case is the only scope in which the key means what the caller meant.
--
-- ## Bounded, like everything else here
--
-- The key is bounded to 200 characters by a check constraint rather than by the
-- writer alone, for the same reason the append-only guarantee is carried by
-- grants and triggers rather than by the TypeScript interface: the constraint
-- has to hold against a `psql` prompt as well as against this library. An empty
-- key is refused too — `''` is what a caller writes when it has no key and has
-- not noticed, and it would make every keyless append in a case collide with
-- every other one.

BEGIN;

-- ---------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------
-- NULL on every row written before this migration, and on every append whose
-- caller supplied no key. That is what makes this migration safe to apply to a
-- table already holding seven years of evidence: it adds a nullable column, it
-- rewrites nothing, it back-fills nothing, and it changes the meaning of no row
-- that already exists.
--
-- The key is NOT part of the canonical node form and never will be. It is an
-- operational fact about how a node came to be written, not part of what
-- happened, and putting it inside the bytes would change every digest this
-- library has ever published.

ALTER TABLE agent_ops.audit_trace_node
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_trace_node_idempotency_key_bounded'
      AND conrelid = 'agent_ops.audit_trace_node'::regclass
  ) THEN
    ALTER TABLE agent_ops.audit_trace_node
      ADD CONSTRAINT audit_trace_node_idempotency_key_bounded
      CHECK (
        idempotency_key IS NULL
        OR (length(idempotency_key) BETWEEN 1 AND 200)
      );
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The partial unique index
-- ---------------------------------------------------------------------------
-- One key, one node, per case. A retry after a crash loses to this index; the
-- store then reads the first node back and returns it, so the caller gets the
-- node that exists rather than a second one beside it.
--
-- Partial, so the rows with no key — which is most of them — are not in the
-- index at all. On a table of a hundred million nodes that is the difference
-- between an index nobody minds and an index somebody eventually drops.

CREATE UNIQUE INDEX IF NOT EXISTS audit_trace_node_idempotency
  ON agent_ops.audit_trace_node (correlation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Grants: unchanged, and stated so the absence is deliberate
-- ---------------------------------------------------------------------------
-- A new column on an existing table is covered by the table-level grants from
-- 0002 — `SELECT, INSERT` for `agent_ops_writer`, `SELECT` for
-- `agent_ops_reader`, and nothing else for anybody. There is no UPDATE grant to
-- widen, and reading a deduplicated node back needs only SELECT, which the
-- writer role already has.

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0007_audit_idempotency')
ON CONFLICT (version) DO NOTHING;

COMMIT;
