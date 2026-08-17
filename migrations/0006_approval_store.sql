-- 0006_approval_store.sql
-- The approval store: durable suspensions and idempotency claims.
--
-- This is the state that lets a process die between the question and the
-- answer. Everything needed to resume a case is a column here or a node in the
-- audit trace; nothing lives in a closure, which is the property that makes a
-- human gate measured in days survivable at all.
--
-- ## Why this table has UPDATE and audit's does not
--
-- A suspension is operational state: awaiting -> answered -> executed, a lease
-- taken and released, a ladder position advanced. That is a state machine and
-- it needs UPDATE. The audit trace is evidence and it does not.
--
-- ## Why this table does not have DELETE
--
-- first_answer_json and final_answer_json hold an approver's own words, kept
-- here rather than in the trace precisely because the trace has no un-writing.
-- Erasing them lawfully is a deliberate, separately authorised operation, not a
-- grant this role carries around waiting to be used by a retention job nobody
-- reviewed.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops_approval_writer') THEN
    CREATE ROLE agent_ops_approval_writer NOLOGIN;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS agent_ops.approval_suspension (
  id                     text        PRIMARY KEY,
  -- The compare-and-set column. Every conditional write in the adapter is
  -- "UPDATE ... WHERE id = $ AND revision = $expected" in ONE statement, so two
  -- writers to one case are correct without a lock -- and no lock is ever held
  -- across the human gate, because a lock held for three days is an outage.
  revision               int         NOT NULL CHECK (revision >= 0),
  correlation_id         text        NOT NULL,
  point_id               text        NOT NULL,
  point_schema_version   int         NOT NULL,
  effect_kind            text        NOT NULL,
  effect_schema_version  int         NOT NULL,
  tier                   text        NOT NULL CHECK (tier IN ('low', 'medium', 'high')),
  seat                   text        NOT NULL CHECK (seat IN ('first', 'second')),
  -- 'held' is NOT terminal: the kill switch stops effects during an incident and
  -- is disengaged after it, so a held case keeps a next_due_at and the sweep
  -- keeps visiting it.
  state                  text        NOT NULL CHECK (state IN
                                       ('awaiting', 'answered', 'refused',
                                        'expired', 'executed', 'held')),
  reserved_json          text        NOT NULL,
  -- text, never jsonb: jsonb reorders keys and normalises numbers, which would
  -- destroy the byte-stable serialisation replay stands on.
  verdict_json           text        NOT NULL,
  effect_payload_json    text        NOT NULL,
  redacted_effect_json   text        NOT NULL,
  brief_body_json        text        NOT NULL,
  do_nothing_json        text        NOT NULL,
  idempotency_key        text        NOT NULL,
  pool                   text        NOT NULL,
  dual_control_required  boolean     NOT NULL,
  licence_valid_for_ms   bigint      NOT NULL CHECK (licence_valid_for_ms > 0),
  awaiting_since_ms      bigint      NOT NULL,
  -- NULL means the brief was never delivered. It is not a formality: measuring
  -- time-to-decision from a presentation that did not happen corrupts the only
  -- anti-rubber-stamping signal this library records.
  presented_at_ms        bigint      NULL,
  offered_to_json        text        NOT NULL,
  last_reminded_at_ms    bigint      NULL,
  -- Never NULL and never a sentinel: the ladder has no position from which
  -- nothing more is owed.
  next_due_at_ms         bigint      NOT NULL,
  -- NULL means indefinite hold. ALWAYS NULL for a reserved decision -- the
  -- expiry branch is deleted, not disabled.
  expires_at_ms          bigint      NULL,
  first_answer_json      text        NULL,
  final_answer_json      text        NULL,
  steps_fired            int         NOT NULL CHECK (steps_fired >= 0),
  cycles_fired           int         NOT NULL CHECK (cycles_fired >= 0),
  lease_until_ms         bigint      NULL,
  lease_owner            text        NULL,
  -- The durable half of a link that is written on both sides. The matching
  -- approval.suspend.begin node in the audit trace carries this suspension's
  -- id, so a crash between the two writes loses a row and never the link.
  suspend_node           text        NOT NULL,
  run_node               text        NOT NULL,
  inserted_at            timestamptz NOT NULL DEFAULT now()
);

-- The sweep's only query. Partial, because settled suspensions are the
-- overwhelming majority of the table after a month and none of them is ever due.
CREATE INDEX IF NOT EXISTS approval_suspension_due
  ON agent_ops.approval_suspension (next_due_at_ms)
  WHERE state IN ('awaiting', 'held');

-- Reconciliation reads by case.
CREATE INDEX IF NOT EXISTS approval_suspension_case
  ON agent_ops.approval_suspension (correlation_id);

CREATE TABLE IF NOT EXISTS agent_ops.approval_idempotency (
  key             text        PRIMARY KEY,
  correlation_id  text        NOT NULL,
  -- Three states, not two. 'not-attempted' means the key was claimed and no
  -- outbound call was made, so a retry is safe. 'unknown' means the call was
  -- made and the outcome is unrecorded, so a retry is NEVER safe -- it goes to a
  -- human. Collapsing them is how one payment becomes two.
  state           text        NOT NULL CHECK (state IN ('not-attempted', 'unknown', 'settled')),
  claimed_at_ms   bigint      NOT NULL,
  lease_until_ms  bigint      NOT NULL,
  outcome_json    text        NULL,
  reason          text        NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The reconciliation queue: effects whose outcome nobody knows. Partial,
-- because it is read on a schedule and is empty on a good day.
CREATE INDEX IF NOT EXISTS approval_idempotency_in_doubt
  ON agent_ops.approval_idempotency (claimed_at_ms)
  WHERE state = 'unknown';

REVOKE ALL ON agent_ops.approval_suspension FROM PUBLIC;
REVOKE ALL ON agent_ops.approval_idempotency FROM PUBLIC;

GRANT USAGE ON SCHEMA agent_ops TO agent_ops_approval_writer;

-- UPDATE, because a suspension is a state machine. No DELETE, on either table:
-- an approver's own words live in this table and a lawful erasure is a
-- separately authorised operation. Nothing here is granted on an audit table.
GRANT SELECT, INSERT, UPDATE ON agent_ops.approval_suspension TO agent_ops_approval_writer;
GRANT SELECT, INSERT, UPDATE ON agent_ops.approval_idempotency TO agent_ops_approval_writer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops') THEN
    GRANT agent_ops_approval_writer TO agent_ops;
  END IF;
END
$$;

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0006_approval_store')
ON CONFLICT (version) DO NOTHING;

COMMIT;
