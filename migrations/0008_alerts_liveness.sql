-- 0008_alerts_liveness.sql
-- The liveness store: one row per watched component, and the reason a heartbeat
-- means anything after a restart.
--
-- ## Why this table exists at all
--
-- `alerts` emits a heartbeat on every run of a component, INCLUDING runs with
-- nothing to do, because "nothing was due" and "I did not run" must not share a
-- representation. Held in memory, that history died with the process: a watcher
-- polling across a deploy read `never-seen`, which is the same thing it reads
-- for a component that was deployed and never started. Two different problems
-- with two different fixes, collapsed into one status on every restart, so an
-- operator learns to read `never-seen` as "we just deployed" and then reads a
-- genuine death that way too.
--
-- With this table the record outlives the process: a component that beat
-- yesterday and died overnight reads `overdue`, with a real last-seen instant
-- and a real beat count behind it.
--
-- ## Why this table has UPDATE and audit's does not
--
-- A liveness record is operational state, not evidence: it is a counter and a
-- high-water mark, rewritten on every beat, and it carries no decision, no
-- approver's words and no customer's anything. The audit trace is evidence and
-- has no UPDATE. These are different tables with different grants on purpose.
--
-- ## Why this table has no DELETE grant
--
-- Nothing in `alerts` removes a liveness row, and no verb on `LivenessStore`
-- can. Un-watching a component is a deployment change — the component stops
-- being deployed and its row stops mattering — and a DELETE grant carried around
-- all day is how a "tidy up stale components" job silently unmonitors the one
-- that had stopped beating. Removing a row is a separately authorised operation
-- against a runbook a person signs, exactly as retention removal is.
--
-- ## Why every time column is bigint and not timestamptz
--
-- Every instant in this library is milliseconds since the epoch, from an
-- INJECTED clock, and is compared against a watcher's OWN clock. A timestamptz
-- would invite the server's `now()` into a comparison the design deliberately
-- keeps in the caller's hands, and it would round-trip through a driver's date
-- parsing, which is not byte-stable. Integers only, here as everywhere.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops_alerts_writer') THEN
    CREATE ROLE agent_ops_alerts_writer NOLOGIN;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS agent_ops.alerts_liveness_component (
  -- One row per watched component. The primary key is what makes `watch`
  -- idempotent: two composition roots registering the same sweeper conflict on
  -- this key rather than creating two rows that each look half-alive.
  component          text     PRIMARY KEY,

  -- The agreed cadence. Never overwritten -- the adapter's upsert assigns this
  -- column to itself on conflict, so the FIRST writer's terms win and a second
  -- writer offering different terms is told so (`LivenessTermsConflict`).
  -- Silently taking a later value is how a deploy widens a two-minute detection
  -- window to an hour with nothing recorded and nobody asked.
  expected_every_ms  bigint   NOT NULL CHECK (expected_every_ms > 0),

  -- When watching began. This is what makes `never-seen` a real finding rather
  -- than an absence: a component registered nine milliseconds ago has not
  -- failed to beat yet, and alerting on it would page somebody at every deploy.
  watching_since     bigint   NOT NULL,

  beats              bigint   NOT NULL DEFAULT 0 CHECK (beats >= 0),
  -- Counted apart on purpose. A sweeper reporting `nothing-was-due` forever is
  -- alive and idle; one reporting work forever is alive and behind. Both are
  -- alive, and an operator wants to tell them apart without reading a log.
  empty_beats        bigint   NOT NULL DEFAULT 0 CHECK (empty_beats >= 0),
  working_beats      bigint   NOT NULL DEFAULT 0 CHECK (working_beats >= 0),
  items_processed    bigint   NOT NULL DEFAULT 0 CHECK (items_processed >= 0),

  -- NULL means never seen. Not zero, and not `watching_since`: a component that
  -- has never beaten and one that beat at the epoch are different facts, and a
  -- sentinel that is also a valid instant is how they stop being different.
  -- Written only through GREATEST(COALESCE(last_seen_at, $n), $n), so a beat
  -- arriving late or from a host with a skewed clock can never move it
  -- backwards and make a live component look overdue.
  last_seen_at       bigint   NULL,

  -- The `HeartbeatRun` union, in two columns. The union's shape is the whole
  -- design: `nothing-was-due` has NO item count, so "I did nothing" cannot be
  -- spelled as "I did zero things" and later be read as a component processing
  -- empty batches. The CHECK below is what stops a row spelling it the second
  -- way -- the one place a durable store could quietly reintroduce the
  -- distinction the union exists to prevent. The adapter's decoder checks the
  -- same pairing on the way out; two independent checks, deliberately.
  last_run_kind      text     NULL CHECK (last_run_kind IN ('did-work', 'nothing-was-due')),
  last_run_items     bigint   NULL CHECK (last_run_items >= 0),

  -- Store-assigned, monotonic per component, incremented inside the same row
  -- lock that writes the beat -- exactly as audit assigns node sequences.
  sequence           bigint   NOT NULL DEFAULT 0 CHECK (sequence >= 0),

  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- The union, enforced by the database rather than by the adapter alone.
  CONSTRAINT alerts_liveness_run_shape CHECK (
    (last_run_kind IS NULL            AND last_run_items IS NULL) OR
    (last_run_kind = 'nothing-was-due' AND last_run_items IS NULL) OR
    (last_run_kind = 'did-work'        AND last_run_items IS NOT NULL)
  ),

  -- A row with beats and no last-seen instant, or the reverse, is not decodable
  -- and the adapter refuses it. Refusing it here as well means it cannot be
  -- written by hand from a psql prompt either.
  CONSTRAINT alerts_liveness_seen_shape CHECK (
    (beats = 0 AND last_seen_at IS NULL) OR (beats > 0 AND last_seen_at IS NOT NULL)
  ),

  CONSTRAINT alerts_liveness_beats_add_up CHECK (beats = empty_beats + working_beats)
);

-- The snapshot an external watcher reads is `ORDER BY component`, which the
-- primary key already serves. No further index: this table holds components,
-- not cases -- tens of rows, not millions -- and an index nobody uses is a write
-- cost on the hot path of every beat.

REVOKE ALL ON agent_ops.alerts_liveness_component FROM PUBLIC;

GRANT USAGE ON SCHEMA agent_ops TO agent_ops_alerts_writer;

-- SELECT, INSERT, UPDATE. No DELETE, ever -- see the header. The watcher may be
-- given a SELECT-only role of its own; it never writes.
GRANT SELECT, INSERT, UPDATE ON agent_ops.alerts_liveness_component TO agent_ops_alerts_writer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops') THEN
    GRANT agent_ops_alerts_writer TO agent_ops;
  END IF;
END
$$;

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0008_alerts_liveness')
ON CONFLICT (version) DO NOTHING;

COMMIT;
