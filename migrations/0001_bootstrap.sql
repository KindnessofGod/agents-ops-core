-- 0001_bootstrap.sql
-- Creates the schema every agent-ops-core module writes into, plus a ledger
-- so a migration runner can tell which files have already been applied.
--
-- Module tables (audit trace, shadow runs, golden cases) arrive in later
-- migrations, once the interfaces they serve have been agreed. This file
-- deliberately contains no module tables: writing them before the interface
-- exists would freeze a data model we have not designed yet.

BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_ops;

CREATE TABLE IF NOT EXISTS agent_ops.schema_migrations (
  version     text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0001_bootstrap')
ON CONFLICT (version) DO NOTHING;

COMMIT;
