-- 0004_eval_store.sql
-- The eval node store. A SEPARATE physical store from the audit trace, per
-- docs/design/OPEN-ITEMS-RESOLVED.md item 4: its own role, its own grants, its
-- own 90-day retention. A trace never spans both.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops_eval_writer') THEN
    CREATE ROLE agent_ops_eval_writer NOLOGIN;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS agent_ops.eval_run (
  run_id          text        PRIMARY KEY,
  label           text        NOT NULL,
  opened_at       bigint      NOT NULL,
  source_kind     text        NOT NULL CHECK (source_kind IN ('golden', 'recorded')),
  source_digest   text        NOT NULL,
  subject_version text        NOT NULL,
  seed            text        NOT NULL,
  envelope        text        NOT NULL,
  redaction       text        NOT NULL,
  captured_via    text        NOT NULL CHECK (captured_via IN ('injected-client-only')),
  inserted_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_run_opened_at ON agent_ops.eval_run (opened_at);

CREATE TABLE IF NOT EXISTS agent_ops.eval_node (
  id                     text    PRIMARY KEY,
  run_id                 text    NOT NULL REFERENCES agent_ops.eval_run (run_id),
  -- Assigned by the store inside a per-run advisory lock. The unique index is
  -- what makes a duplicate impossible when two writers race; the lock is what
  -- stops them racing into one.
  sequence               int     NOT NULL CHECK (sequence >= 0),
  parent                 text    NULL REFERENCES agent_ops.eval_node (id),
  kind                   text    NOT NULL,
  name                   text    NOT NULL,
  opened_at              bigint  NOT NULL,
  closed_at              bigint  NULL,
  elapsed_micros         bigint  NOT NULL DEFAULT 0,
  outcome                text    NOT NULL,
  cost_tenth_cents       bigint  NOT NULL DEFAULT 0,
  tokens_in              bigint  NOT NULL DEFAULT 0,
  tokens_out             bigint  NOT NULL DEFAULT 0,
  price_table_version    text    NOT NULL DEFAULT '',
  payload_schema_version int     NOT NULL,
  redaction              text    NOT NULL,
  envelope               text    NOT NULL,
  payload                jsonb   NOT NULL,
  -- text, never jsonb: jsonb reorders keys and normalises numbers, which would
  -- destroy the byte-stable serialisation the trace digest stands on.
  canonical              text    NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS eval_node_run_sequence
  ON agent_ops.eval_node (run_id, sequence);

CREATE INDEX IF NOT EXISTS eval_node_run ON agent_ops.eval_node (run_id);

REVOKE ALL ON agent_ops.eval_run FROM PUBLIC;
REVOKE ALL ON agent_ops.eval_node FROM PUBLIC;

GRANT USAGE ON SCHEMA agent_ops TO agent_ops_eval_writer;

-- UPDATE settles an open node; DELETE expires a run. Neither grant exists on
-- agent_ops.audit_trace_case or agent_ops.audit_trace_node, and neither ever may.
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_ops.eval_run TO agent_ops_eval_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_ops.eval_node TO agent_ops_eval_writer;

GRANT EXECUTE ON FUNCTION pg_advisory_xact_lock(bigint) TO agent_ops_eval_writer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops') THEN
    GRANT agent_ops_eval_writer TO agent_ops;
  END IF;
END
$$;

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0004_eval_store')
ON CONFLICT (version) DO NOTHING;

COMMIT;
