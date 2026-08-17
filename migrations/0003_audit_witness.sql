-- 0003_audit_witness.sql
-- The external witness, and the reading half of the seven-year expiry.
--
-- Two things arrive here, and they are the same thing seen from two ends: a
-- place to publish a case's digest where the writer of the case cannot revise
-- it, and a way to prove — years later, on the day of a removal — that an
-- archive copy is the case that was published.
--
-- ## Why a separate table with a separate role
--
-- migrations/0002 closes every hole it can close from inside one store. Grants
-- withhold UPDATE and DELETE, triggers raise on both, closure is the existence
-- of a seal row rather than a flag, and the seal carries the digest of
-- everything before it. What none of that reaches is the adversary who rewrites
-- the whole case and recomputes the seal: every check is derived from the rows,
-- and that adversary owns the rows.
--
-- The only answer is a copy of the digest under a different authority. So:
--
--   * `agent_ops.audit_witness` is INSERT-only, one row per case, with the
--     correlation identifier as the primary key. A second, DIFFERENT digest for
--     a case cannot be written at all — the insert loses to the key, the library
--     reads the row back and raises `WitnessConflict`. Republishing the SAME
--     digest is idempotent, which is what makes recovery from a crash between
--     seal and publication safe to re-run.
--   * INSERT on it is granted to `agent_ops_witness` and DELIBERATELY NOT to
--     `agent_ops_writer`. The application's everyday role can read the witness
--     and cannot write it. A composition root that wires the trace pool into
--     `postgresWitness` therefore fails on the first close, loudly, instead of
--     producing a witness nobody should believe.
--
-- ## What this arrangement does NOT achieve, stated here as well as in the code
--
-- Two tables in one cluster is one trust domain with two roles in it. Anyone who
-- owns the host owns both, and a superuser can drop a trigger or a table. This
-- raises the cost of a consistent rewrite from "hold the writer credential" to
-- "hold two credentials" — a real increase, and not a trust boundary. Crossing
-- one needs a witness under different custody: another organisation's
-- append-only log, a timestamping authority, a customer-held copy. The library's
-- `Witness` interface takes such an adapter without change. Nothing in this file
-- can substitute for it, and it is deployment's decision whether the data
-- warrants one.
--
-- ## Retention: this file creates NO role that can delete a trace row
--
-- That is the point of it, and it is worth saying in the file where somebody
-- will look for the expiry job.
--
-- The trace tables hold seven years of evidence. Something must eventually
-- remove a case that has been held for seven years, and that something is a
-- PROCEDURE performed by a person, not a function in a library:
--
--   1. `agent_ops_reader` — SELECT only, no INSERT, no UPDATE, no DELETE, on
--      anything — is the role the retention survey runs as. Deciding what may be
--      destroyed should not happen on a connection that could destroy it.
--   2. The survey (`postgresRetentionRegister`) lists sealed cases whose seal is
--      older than the retention period. The index below is what makes that
--      cheap.
--   3. For each case, `Archivist.clearForRemoval` re-reads the LIVE case in
--      full, recomputes its digest from the nodes, and clears it only if the
--      archive copy's digest AND the witness record both agree — checked on the
--      day of the removal, not the day of the export. A case that fails any of
--      the three is not cleared, and a case whose rows are tampered or
--      incoherent raises rather than returning a verdict.
--   4. ONLY THEN does a human, under an authorised change, grant DELETE on the
--      trace tables to a dedicated expiry role, run the deletion for the cleared
--      identifiers, and revoke the grant. That grant is deliberately not issued
--      by this migration and must not be made permanent: for the overwhelming
--      majority of the seven years there should be no role on this cluster able
--      to delete a trace row at all.
--
-- The witness rows are NOT removed with the case they attest to. They are tiny —
-- an identifier, a digest, a count, a timestamp — they contain no personal data
-- by construction, and keeping them is what lets a question asked after the
-- expiry ("did case X exist, and did it digest to this?") still be answered from
-- the archive copy. A retention policy that removes the witness first removes
-- the only thing that could have checked the removal.

BEGIN;

-- ---------------------------------------------------------------------------
-- The witness role
-- ---------------------------------------------------------------------------
-- Separate from agent_ops_writer on purpose. The whole value of the witness is
-- that the credential which writes the trace cannot write the witness.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops_witness') THEN
    CREATE ROLE agent_ops_witness NOLOGIN;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The witness table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_ops.audit_witness (
  -- One row per case. This key is the enforcement: a second, different digest
  -- for a case is impossible rather than merely discouraged.
  correlation_id    text        PRIMARY KEY,

  -- `version:algorithm:hex`. The construction is named inside the string, so a
  -- digest published in 2026 stays checkable by a 2033 binary that has moved on
  -- — the same discipline as the node envelope.
  digest            text        NOT NULL CHECK (digest <> ''),

  -- How many nodes the digest covers, the seal counted.
  nodes_witnessed   int         NOT NULL CHECK (nodes_witnessed > 0),

  -- From the library's injected clock. OUR claim about when we published, not a
  -- notary's. A witness that issues its own trusted timestamp is the third
  -- adapter described above.
  witnessed_at_ms   bigint      NOT NULL,

  -- Who held it. Name the custodian, not the software: in 2033 the question is
  -- whose custody it was in.
  witness_id        text        NOT NULL CHECK (witness_id <> ''),

  -- Wall-clock arrival, for operations only. Never used for ordering.
  inserted_at       timestamptz NOT NULL DEFAULT now()
);

-- Deliberately NO foreign key to audit_trace_case.
--
-- A witness record must be able to outlive the case it attests to — that is the
-- point of retaining it past expiry — and it must be able to be held in a
-- database that has no trace tables at all, which is what the third adapter
-- looks like. A reference here would forbid both.

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------
-- Same belt and braces as the trace tables, and the same stated limit: a trigger
-- fires for superusers where grants do not, and a superuser can drop the
-- trigger. Detecting that is a job for custody, not for SQL.

DROP TRIGGER IF EXISTS audit_witness_immutable ON agent_ops.audit_witness;
CREATE TRIGGER audit_witness_immutable
  BEFORE UPDATE OR DELETE ON agent_ops.audit_witness
  FOR EACH ROW EXECUTE FUNCTION agent_ops.audit_trace_immutable();

-- ---------------------------------------------------------------------------
-- Retention survey support
-- ---------------------------------------------------------------------------
-- The survey asks: which cases have a seal older than a cut-off? Without this
-- index that is a sequential scan of every node ever written, which is why an
-- expiry sweep would be run rarely, in a hurry, and with the limit turned off.
-- A partial index over seal rows only is a few thousand entries per million
-- nodes.

CREATE INDEX IF NOT EXISTS audit_trace_node_seal_age
  ON agent_ops.audit_trace_node (at_ms, correlation_id)
  WHERE is_seal;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON agent_ops.audit_witness FROM PUBLIC;

GRANT USAGE ON SCHEMA agent_ops TO agent_ops_witness;

-- The witness role: SELECT and INSERT on the witness table, and nothing on the
-- trace at all. It cannot read a payload, which is correct — a witness needs a
-- digest and never needs the evidence.
GRANT SELECT, INSERT ON agent_ops.audit_witness TO agent_ops_witness;

-- The application's everyday role: it may READ the witness — `verifyAgainstWitness`
-- needs that — and may NOT write it. This asymmetry is the mechanism.
GRANT SELECT ON agent_ops.audit_witness TO agent_ops_writer;

-- The survey role: SELECT only, everywhere.
GRANT SELECT ON agent_ops.audit_witness TO agent_ops_reader;

-- Development convenience only, exactly as in 0002. In production the login
-- roles are separate and own nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops') THEN
    GRANT agent_ops_witness TO agent_ops;
  END IF;
END
$$;

INSERT INTO agent_ops.schema_migrations (version)
VALUES ('0003_audit_witness')
ON CONFLICT (version) DO NOTHING;

COMMIT;
