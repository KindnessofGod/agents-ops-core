-- 0002_audit_trace.sql
-- The audit trace: the append-only record of everything that happened under one
-- correlation identifier, sufficient to replay the case.
--
-- Seven-year retention. Written to be read years later by someone hostile.
--
-- ## Append-only is enforced here, not merely intended in the writer
--
-- The TypeScript interface has no update, no delete and no amend. That stops a
-- caller. It does not stop somebody with a psql prompt, which is exactly the
-- reader this trace exists for. So the guarantee is carried four ways:
--
--   1. **Grants.** The writer role gets SELECT and INSERT. No UPDATE, no
--      DELETE, no TRUNCATE, on either table.
--   2. **Triggers.** UPDATE and DELETE raise, so a role that somehow acquires
--      the grant still cannot mutate a row.
--   3. **No mutable state.** Closure is the *existence of a seal row*, never a
--      flag somebody has to be allowed to flip. That is why neither table needs
--      an UPDATE grant for ordinary operation — including the case table.
--   4. **Constraints.** A partial unique index makes a second close impossible;
--      a foreign key plus `parent_sequence < sequence` makes the node graph a
--      DAG within one case; the primary key makes a duplicate sequence
--      impossible under any amount of concurrency.
--
-- ## Retention lives elsewhere, on purpose
--
-- Per docs/design/OPEN-ITEMS-RESOLVED.md item 4, eval nodes go to a SEPARATE
-- physical store with its own grants and its own 90-day retention. Expiring
-- them here would need a DELETE grant on these tables, and a grant that exists
-- is a grant that gets used. These tables are INSERT-only forever. Nothing in
-- this library ever deletes from them; a lawful seven-year expiry is a
-- deliberate, separately-authorised operation by a role this migration does not
-- create.
--
-- ## Byte-stability
--
-- `payload_canonical` and `node_canonical` are `text`, not `jsonb`, and that is
-- the single most important line in this file. `jsonb` reorders keys, drops
-- duplicate keys and normalises numbers — it would destroy the byte-stable
-- serialisation that replay and the content digest both stand on. The
-- queryable fields are lifted into their own columns instead.

BEGIN;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- The application connects as a member of agent_ops_writer, which owns nothing.
-- In development the docker user `agent_ops` also owns the tables, and a table
-- owner can drop a trigger — so the dev database is NOT evidence that the
-- append-only guarantee holds. Production runs the application as a non-owner
-- member of agent_ops_writer, with DDL held by a separate migration role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops_writer') THEN
    CREATE ROLE agent_ops_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops_reader') THEN
    CREATE ROLE agent_ops_reader NOLOGIN;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The case, and the scope of what its trace is evidence of
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_ops.audit_trace_case (
  correlation_id  text        PRIMARY KEY,

  -- The honest scope statement, stored with the evidence rather than asserted
  -- in a wiki that will not exist in 2033. Everything the library mediated is
  -- captured; work an application did out of band is not.
  captured_via    text        NOT NULL
                  CHECK (captured_via IN ('injected-trace-store-only')),

  -- Which canonical envelope produced the bytes below. Old cases keep their old
  -- envelope forever; a rule change means a new version, never a rewrite.
  canonical_form  text        NOT NULL,

  -- Which redactor ran before every write on this case.
  redaction       text        NOT NULL,

  -- From the injected clock. Milliseconds since epoch, as an integer, for the
  -- same reason payloads carry no floats: byte-stability.
  opened_at_ms    bigint      NOT NULL,

  -- Wall-clock arrival, for operations only. Never used for ordering or replay,
  -- because a trace ordered by a database's clock is a trace ordered by
  -- whichever server took the write.
  inserted_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The nodes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_ops.audit_trace_node (
  correlation_id          text    NOT NULL
                          REFERENCES agent_ops.audit_trace_case (correlation_id),

  -- Total order within one case, assigned by the store under a per-case
  -- advisory lock. The primary key is what makes a duplicate impossible when
  -- two writers race; the lock is what stops them racing into a retry loop.
  sequence                int     NOT NULL CHECK (sequence >= 0),

  node_id                 text    NOT NULL,

  at_ms                   bigint  NOT NULL,

  -- Consequence of being wrong, per decision-and-effect. A case therefore has a
  -- tier profile readable straight off this column rather than reconstructed.
  tier                    text    NOT NULL CHECK (tier IN ('low', 'medium', 'high')),

  -- Parentage is stored as a sequence, not as a node identifier string, so the
  -- foreign key below can enforce "a node of this case that already exists".
  parent_sequence         int     NULL,

  payload_schema_version  int     NOT NULL,
  redaction               text    NOT NULL,

  -- Lifted out of the payload so the trace is queryable without parsing the
  -- canonical bytes — and without ever storing them as jsonb.
  kind                    text    NOT NULL,

  payload_canonical       text    NOT NULL,
  node_canonical          text    NOT NULL,

  -- The terminal seal node. Not a status flag: a seal row is inserted once and
  -- never edited, which is why this table needs no UPDATE grant.
  is_seal                 boolean NOT NULL,

  inserted_at             timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (correlation_id, sequence),

  -- A parent must be a node of the same case that already exists, and must come
  -- earlier. Together these make the graph acyclic in the database rather than
  -- only in the writer.
  CONSTRAINT audit_trace_node_parent_fk
    FOREIGN KEY (correlation_id, parent_sequence)
    REFERENCES agent_ops.audit_trace_node (correlation_id, sequence),
  CONSTRAINT audit_trace_node_parent_is_earlier
    CHECK (parent_sequence IS NULL OR parent_sequence < sequence)
);

-- Exactly one seal per case, enforced by the database. A second close is
-- impossible even for a writer that ignores the interface.
CREATE UNIQUE INDEX IF NOT EXISTS audit_trace_node_one_seal
  ON agent_ops.audit_trace_node (correlation_id)
  WHERE is_seal;

CREATE INDEX IF NOT EXISTS audit_trace_node_kind
  ON agent_ops.audit_trace_node (kind);

-- ---------------------------------------------------------------------------
-- Immutability triggers
-- ---------------------------------------------------------------------------
-- Belt and braces behind the grants. A trigger fires for superusers too, which
-- grants do not. Its limit, stated rather than implied: a superuser can drop
-- the trigger. Detecting that is a job for the content digest being witnessed
-- somewhere this database cannot write, not for this file.

CREATE OR REPLACE FUNCTION agent_ops.audit_trace_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'agent_ops audit trace is append-only: % on % is not permitted',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END
$$;

DROP TRIGGER IF EXISTS audit_trace_case_immutable ON agent_ops.audit_trace_case;
CREATE TRIGGER audit_trace_case_immutable
  BEFORE UPDATE OR DELETE ON agent_ops.audit_trace_case
  FOR EACH ROW EXECUTE FUNCTION agent_ops.audit_trace_immutable();

DROP TRIGGER IF EXISTS audit_trace_node_immutable ON agent_ops.audit_trace_node;
CREATE TRIGGER audit_trace_node_immutable
  BEFORE UPDATE OR DELETE ON agent_ops.audit_trace_node
  FOR EACH ROW EXECUTE FUNCTION agent_ops.audit_trace_immutable();

-- ---------------------------------------------------------------------------
-- Grants: SELECT and INSERT. Deliberately no UPDATE, no DELETE, no TRUNCATE.
-- ---------------------------------------------------------------------------

REVOKE ALL ON agent_ops.audit_trace_case FROM PUBLIC;
REVOKE ALL ON agent_ops.audit_trace_node FROM PUBLIC;

GRANT USAGE ON SCHEMA agent_ops TO agent_ops_writer, agent_ops_reader;

GRANT SELECT, INSERT ON agent_ops.audit_trace_case TO agent_ops_writer;
GRANT SELECT, INSERT ON agent_ops.audit_trace_node TO agent_ops_writer;

GRANT SELECT ON agent_ops.audit_trace_case TO agent_ops_reader;
GRANT SELECT ON agent_ops.audit_trace_node TO agent_ops_reader;

-- The append path takes a per-case transaction-scoped advisory lock.
GRANT EXECUTE ON FUNCTION pg_advisory_xact_lock(bigint) TO agent_ops_writer;

-- Development convenience only. In production the login role is a member of
-- agent_ops_writer and owns nothing, so it cannot drop the triggers above.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops') THEN
    GRANT agent_ops_writer TO agent_ops;
    GRANT agent_ops_reader TO agent_ops;
  END IF;
END
$$;

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0002_audit_trace')
ON CONFLICT (version) DO NOTHING;

COMMIT;
