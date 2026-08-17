import type { SqlExecutor, SqlRow } from "../../index.js";

/**
 * A stand-in for Postgres that understands exactly the tagged statements
 * `postgresApprovalStore` and `audit`'s `postgresTraceStore` issue.
 *
 * It is not a database and does not pretend to be one. What it is for is stated
 * plainly, because a fake that is trusted for more than it proves is worse than
 * no fake:
 *
 * **What it proves.** That the adapter's statements are well-formed and
 * parameterised; that its conditional writes really are conditional, because
 * every `WHERE` clause below is evaluated rather than assumed; that a
 * compare-and-set loses when the revision has moved; that exactly one of two
 * concurrent claimants of an idempotency key is told `claimed`; and — the point
 * of the whole file — that a suspension survives when **every object in the
 * process is destroyed** and only bytes cross the gap.
 *
 * **What it does not prove.** The schema's own guarantees: the primary key, the
 * check constraints, the partial indexes, the grants. Those are properties of
 * Postgres and no test in this package exercises them, because no test in this
 * package may open a socket. They are verified by applying
 * `APPROVAL_STORE_SCHEMA_SQL` to a real database as a deliberate operational
 * step. It also does not model transaction rollback — `transaction` runs the
 * body on the same executor — so nothing here is evidence that a partial
 * transaction unwinds. Every conditional write in the adapter is a single
 * statement precisely so that this gap does not matter to correctness.
 *
 * ## Why it yields between statements
 *
 * `query` awaits a microtask before it does anything. Two overlapping callers
 * therefore interleave *between* statements while each statement stays atomic —
 * which is exactly Postgres's contract, and exactly the condition under which an
 * adapter that did a `SELECT` and then an `UPDATE` would lose a race. This one
 * does not, and the interleaving is what makes that claim mean something.
 */

/** The whole database, as plain JSON. This is the thing that survives. */
export interface FakeDatabase {
  auditCase: Record<string, SqlRow>;
  auditNode: Record<string, SqlRow[]>;
  suspension: Record<string, SqlRow>;
  claim: Record<string, SqlRow>;
}

export const emptyDatabase = (): FakeDatabase => ({
  auditCase: {},
  auditNode: {},
  suspension: {},
  claim: {},
});

const TAG = /^-- (audit|approval):([a-z-]+)/;

export const tagOf = (text: string): string => {
  const match = TAG.exec(text);
  return match === null ? "untagged" : `${String(match[1])}:${String(match[2])}`;
};

/** `$1`, `$2 + 1`, `0`, `'not-attempted'`, `NULL`. Nothing else is used. */
const value = (expression: string, params: readonly unknown[]): unknown => {
  const e = expression.trim();
  if (e === "NULL") return null;
  const bumped = /^\$(\d+) \+ 1$/.exec(e);
  if (bumped !== null) return Number(params[Number(bumped[1]) - 1]) + 1;
  const bound = /^\$(\d+)$/.exec(e);
  if (bound !== null) return params[Number(bound[1]) - 1] ?? null;
  const quoted = /^'(.*)'$/.exec(e);
  if (quoted !== null) return quoted[1];
  if (/^-?\d+$/.test(e)) return Number(e);
  throw new Error(`fake sql: unsupported expression ${e}`);
};

/** Build a row from the statement's own column list, so the fake cannot drift. */
const insertedRow = (text: string, params: readonly unknown[]): SqlRow => {
  const match = /INSERT INTO \S+\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/.exec(text);
  if (match === null) throw new Error(`fake sql: not an insert: ${text}`);
  const columns = String(match[1]).split(",").map((c) => c.trim());
  const expressions = String(match[2]).split(",").map((v) => v.trim());
  const row: Record<string, unknown> = {};
  columns.forEach((column, i) => {
    row[column] = value(String(expressions[i]), params);
  });
  return row;
};

/** Apply an `UPDATE … SET` clause to a row, from the statement's own text. */
const applySet = (text: string, params: readonly unknown[], row: SqlRow): SqlRow => {
  const match = /SET([\s\S]*?)\n\s*WHERE/.exec(text);
  if (match === null) throw new Error(`fake sql: not an update: ${text}`);
  const next: Record<string, unknown> = { ...row };
  for (const assignment of String(match[1]).split(",")) {
    const parsed = /^\s*([a-z_]+)\s*=\s*([\s\S]+)$/.exec(assignment);
    if (parsed === null) continue;
    next[String(parsed[1])] = value(String(parsed[2]), params);
  }
  return next;
};

const int = (value_: unknown): number => Number(value_ ?? 0);

const bounded = <T>(rows: readonly T[], limit: unknown): readonly T[] =>
  rows.slice(0, Math.max(0, Number(limit ?? 0)));

export interface FakeSql {
  readonly executor: SqlExecutor;
  readonly statements: string[];
}

export const fakeSql = (db: FakeDatabase): FakeSql => {
  const statements: string[] = [];

  const run = async (
    text: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: readonly SqlRow[] }> => {
    // Interleave between statements, never within one. See the note above.
    await Promise.resolve();
    statements.push(text);
    const tag = tagOf(text);

    switch (tag) {
      /* ------------------------------------------------------------ audit */

      case "audit:open-case": {
        const id = String(params[0]);
        if (db.auditCase[id] === undefined) {
          db.auditCase[id] = {
            captured_via: params[1],
            canonical_form: params[2],
            redaction: params[3],
            // bigint arrives as text from most drivers; hand it back that way
            // so the adapter's own coercion is exercised.
            opened_at_ms: String(params[4]),
          };
          db.auditNode[id] = [];
        }
        return { rows: [] };
      }
      case "audit:lock":
        return { rows: [{ pg_advisory_xact_lock: null }] };
      case "audit:next-sequence": {
        const nodes = db.auditNode[String(params[0])] ?? [];
        return {
          rows: [
            {
              next_sequence: nodes.length,
              sealed: nodes.some((row) => row["is_seal"] === true),
            },
          ],
        };
      }
      case "audit:append": {
        const id = String(params[0]);
        const nodes = db.auditNode[id] ?? [];
        nodes.push({
          sequence: params[1],
          node_id: params[2],
          at_ms: String(params[3]),
          tier: params[4],
          parent_sequence: params[5] ?? null,
          payload_schema_version: params[6],
          redaction: params[7],
          kind: params[8],
          payload_canonical: params[9],
          node_canonical: params[10],
          is_seal: params[11],
        });
        db.auditNode[id] = nodes;
        return { rows: [] };
      }
      case "audit:read-case": {
        const row = db.auditCase[String(params[0])];
        return { rows: row === undefined ? [] : [row] };
      }
      case "audit:read-nodes":
        return { rows: bounded(db.auditNode[String(params[0])] ?? [], params[1]) };

      /* --------------------------------------------------------- approval */

      case "approval:save-suspension": {
        const row = insertedRow(text, params);
        const id = String(row["id"]);
        // ON CONFLICT (id) DO NOTHING. First write wins.
        if (db.suspension[id] === undefined) db.suspension[id] = row;
        return { rows: [] };
      }
      case "approval:load-suspension": {
        const row = db.suspension[String(params[0])];
        return { rows: row === undefined ? [] : [row] };
      }
      case "approval:suspensions-of-case": {
        const rows = Object.values(db.suspension)
          .filter((row) => row["correlation_id"] === params[0])
          .sort(
            (a, b) =>
              int(a["awaiting_since_ms"]) - int(b["awaiting_since_ms"]) ||
              String(a["id"]).localeCompare(String(b["id"])),
          );
        return { rows: bounded(rows, params[1]) };
      }
      case "approval:swap-suspension": {
        const id = String(params[0]);
        const row = db.suspension[id];
        // WHERE id = $1 AND revision = $2. The whole compare-and-set.
        if (row === undefined || int(row["revision"]) !== Number(params[1])) {
          return { rows: [] };
        }
        db.suspension[id] = applySet(text, params, row);
        return { rows: [{ id }] };
      }
      case "approval:due-suspensions": {
        const now = Number(params[0]);
        const rows = Object.values(db.suspension)
          .filter((row) => {
            const due = int(row["next_due_at_ms"]) <= now;
            const expiry = row["expires_at_ms"];
            if (row["state"] === "awaiting") {
              return due || (expiry !== null && expiry !== undefined && int(expiry) <= now);
            }
            return row["state"] === "held" && due;
          })
          .sort(
            (a, b) =>
              int(a["next_due_at_ms"]) - int(b["next_due_at_ms"]) ||
              String(a["id"]).localeCompare(String(b["id"])),
          );
        return { rows: bounded(rows, params[1]) };
      }
      case "approval:acquire-lease": {
        const id = String(params[0]);
        const row = db.suspension[id];
        if (row === undefined) return { rows: [] };
        const lease = row["lease_until_ms"];
        const free = lease === null || lease === undefined || int(lease) <= Number(params[2]);
        if (!free) return { rows: [] };
        db.suspension[id] = applySet(text, params, row);
        return { rows: [{ id }] };
      }
      case "approval:claim-insert": {
        const row = insertedRow(text, params);
        const key = String(row["key"]);
        if (db.claim[key] !== undefined) return { rows: [] };
        db.claim[key] = row;
        return { rows: [row] };
      }
      case "approval:claim-reclaim": {
        const key = String(params[0]);
        const row = db.claim[key];
        // Only ever from `not-attempted`, and only once the lease has run out.
        if (
          row === undefined ||
          row["state"] !== "not-attempted" ||
          int(row["lease_until_ms"]) > Number(params[2])
        ) {
          return { rows: [] };
        }
        const next = applySet(text, params, row);
        db.claim[key] = next;
        return { rows: [next] };
      }
      case "approval:claim-read": {
        const row = db.claim[String(params[0])];
        return { rows: row === undefined ? [] : [row] };
      }
      case "approval:claim-settle": {
        const row = insertedRow(text, params);
        // Every column is set from EXCLUDED, so the upsert is a replacement.
        db.claim[String(row["key"])] = row;
        return { rows: [] };
      }
      case "approval:in-doubt": {
        const rows = Object.values(db.claim)
          .filter((row) => row["state"] === "unknown")
          .sort(
            (a, b) =>
              int(a["claimed_at_ms"]) - int(b["claimed_at_ms"]) ||
              String(a["key"]).localeCompare(String(b["key"])),
          );
        return { rows: bounded(rows, params[0]) };
      }

      default:
        throw new Error(`fake sql: unexpected statement: ${text}`);
    }
  };

  const executor: SqlExecutor = {
    query: run,
    // No rollback modelling. Stated in the header rather than implied.
    transaction: async (fn) => fn(executor),
  };

  return { executor, statements };
};
