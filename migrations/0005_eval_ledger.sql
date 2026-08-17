-- 0005_eval_ledger.sql
-- The run ledger: idempotency and resume for eval runs. Same role, same grants
-- and the same 90-day retention as the eval node store; a trace never spans the
-- audit store and these tables.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_ops.eval_run_memo (
  run_key      text        PRIMARY KEY,
  run_id       text        NOT NULL,
  completed_at bigint      NOT NULL,
  schema       text        NOT NULL,
  source_kind  text        NOT NULL CHECK (source_kind IN ('golden', 'recorded')),
  -- text, never jsonb: jsonb reorders keys and normalises numbers, and the
  -- report is re-entered by recomputing its rates from its own bytes.
  report_json  text        NOT NULL,
  inserted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_run_memo_completed_at
  ON agent_ops.eval_run_memo (completed_at);

CREATE TABLE IF NOT EXISTS agent_ops.eval_case_memo (
  run_key            text   NOT NULL,
  case_ref           text   NOT NULL,
  case_digest        text   NOT NULL,
  from_run_id        text   NOT NULL,
  from_node          text   NOT NULL,
  recorded_at        bigint NOT NULL,
  status             text   NOT NULL CHECK (status IN
                       ('matched','mismatched','unscored','contested','unattributed')),
  score_basis_points int    NOT NULL,
  observed_json      text   NOT NULL,
  detail             text   NULL,
  model_calls        int    NOT NULL,
  cost_tenth_cents   bigint NOT NULL,
  PRIMARY KEY (run_key, case_ref)
);

CREATE INDEX IF NOT EXISTS eval_case_memo_recorded_at
  ON agent_ops.eval_case_memo (recorded_at);

REVOKE ALL ON agent_ops.eval_run_memo FROM PUBLIC;
REVOKE ALL ON agent_ops.eval_case_memo FROM PUBLIC;

GRANT SELECT, INSERT, DELETE ON agent_ops.eval_run_memo TO agent_ops_eval_writer;
GRANT SELECT, INSERT, DELETE ON agent_ops.eval_case_memo TO agent_ops_eval_writer;

-- No UPDATE grant, on purpose. A memo is written once and read forever or
-- expired; rewriting one in place would let a green result be edited onto a key
-- that never produced it, and nothing downstream would ever look again.

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0005_eval_ledger')
ON CONFLICT (version) DO NOTHING;

COMMIT;
