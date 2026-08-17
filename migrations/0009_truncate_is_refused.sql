-- 0009_truncate_is_refused.sql
--
-- Closes the one unguarded path through the append-only guarantee.
--
-- `0002_audit_trace.sql` installs `audit_trace_immutable()` as
-- `BEFORE UPDATE OR DELETE ... FOR EACH ROW`, and its header names the threat
-- model plainly: "somebody with a psql prompt, which is exactly the reader this
-- trace exists for". It also names the trigger's own limit — a superuser can
-- drop it.
--
-- It did not name this one. **Postgres never fires row-level triggers on
-- TRUNCATE.** An adversarial review applied every migration to a fresh
-- database, took the table-owner role, and ran:
--
--     TRUNCATE agent_ops.audit_trace_node;      -- TRUNCATE TABLE, 4 rows -> 0
--     TRUNCATE agent_ops.audit_witness;         -- TRUNCATE TABLE
--
-- The second is worse than the first: `audit_witness` is the table the whole
-- tamper-detection story rests on. Wiping both leaves a consistent, verifiable,
-- empty history. And unlike dropping a trigger, TRUNCATE needs no data
-- definition rights and leaves no dropped-object behind.
--
-- Two things kept it off the blocker list and neither is a reason to leave it:
-- the writer role is already refused TRUNCATE (SQLSTATE 42501, and a test
-- covers it), and the production posture runs applications as a non-owner
-- member of `agent_ops_writer`. So no application could do this. It needed the
-- owner — which is the migration role, which is a human at a prompt, which is
-- the threat this table was built against.
--
-- Statement-level TRUNCATE triggers close it completely. The residual limit is
-- unchanged and still honest: a superuser can drop any trigger. That is a
-- property of Postgres, not of this schema, and it is why the append-only
-- guarantee is stated against roles rather than against everyone.

BEGIN;

CREATE OR REPLACE FUNCTION agent_ops.audit_trace_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'agent_ops.% is append-only; TRUNCATE is refused', TG_TABLE_NAME
    USING ERRCODE = '23514',
          HINT = 'A trace is evidence. Retention is a separately authorised '
                 'procedure against docs/RUNBOOK.md, never a TRUNCATE.';
END;
$$;

COMMENT ON FUNCTION agent_ops.audit_trace_no_truncate() IS
  'Refuses TRUNCATE on append-only tables. Row-level triggers never fire on '
  'TRUNCATE, so BEFORE UPDATE OR DELETE FOR EACH ROW does not cover it.';

DROP TRIGGER IF EXISTS audit_trace_node_no_truncate ON agent_ops.audit_trace_node;
CREATE TRIGGER audit_trace_node_no_truncate
  BEFORE TRUNCATE ON agent_ops.audit_trace_node
  FOR EACH STATEMENT EXECUTE FUNCTION agent_ops.audit_trace_no_truncate();

DROP TRIGGER IF EXISTS audit_trace_case_no_truncate ON agent_ops.audit_trace_case;
CREATE TRIGGER audit_trace_case_no_truncate
  BEFORE TRUNCATE ON agent_ops.audit_trace_case
  FOR EACH STATEMENT EXECUTE FUNCTION agent_ops.audit_trace_no_truncate();

DROP TRIGGER IF EXISTS audit_witness_no_truncate ON agent_ops.audit_witness;
CREATE TRIGGER audit_witness_no_truncate
  BEFORE TRUNCATE ON agent_ops.audit_witness
  FOR EACH STATEMENT EXECUTE FUNCTION agent_ops.audit_trace_no_truncate();

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0009_truncate_is_refused')
ON CONFLICT (version) DO NOTHING;

COMMIT;
