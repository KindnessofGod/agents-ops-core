import type { SqlExecutor, SqlRow } from "./sql.js";

/**
 * The `SqlExecutor` contract, as an executable suite.
 *
 * ## The gap this closes
 *
 * `postgres-store.test.ts` ends with an honest note: the schema's own guarantees
 * — the primary key, the one-seal partial unique index, the parent foreign key,
 * the immutability triggers, the grants — are properties of Postgres and **no
 * test in this package exercises them**, because no test in this package may
 * open a socket. That note is still true and this file does not change it.
 *
 * What it does change is the other half, which was worse for being invisible.
 * `SqlExecutor` is the one interface in this module that every deployment
 * implements itself, in fifteen lines, at a composition root, against whichever
 * driver it already has — and until now those fifteen lines were held to nothing
 * at all. A `transaction` that hands each statement a different pooled
 * connection typechecks perfectly, passes every test in this package, and
 * silently reduces the per-case advisory lock to a lock taken and released
 * around a single statement. Two concurrent writers to one case then both read
 * the same `MAX(sequence)`, and the trace this library exists to guarantee gets
 * a duplicate-key error at best and a lost node at worst.
 *
 * So the contract is shipped as a **suite** rather than as a paragraph. It is:
 *
 *   - **Framework-free.** It imports no test runner. `CLAUDE.md` requires an ADR
 *     for every dependency nineteen applications inherit, and a contract suite
 *     that only runs under one runner is a contract only one team can check.
 *     Each case is a name and an async function that throws.
 *   - **Runnable in CI without a database**, against an in-memory implementation
 *     of the same obligations — which is how the discipline is verified in this
 *     package, and how an application verifies its *own* fake before trusting a
 *     test suite built on it.
 *   - **Runnable against a live pool**, from an operational script, as the step
 *     that proves the fifteen lines at the composition root are correct. That is
 *     the run that matters, and this file is what makes it a five-minute job
 *     rather than a project nobody schedules.
 *
 * ## What it cannot check, said plainly
 *
 * It checks the *executor's* obligations: parameter binding, one connection per
 * transaction, commit on resolve, rollback and rethrow on reject, rejection on a
 * refused statement, array-shaped rows, isolation between concurrent
 * transactions. It does **not** check Postgres. A green suite against an
 * in-memory subject says the suite is satisfiable and that the harness holds; it
 * says nothing whatsoever about grants, triggers or constraints. Only a run
 * against the real cluster says anything about those, and only `migrations/` plus
 * `RUNBOOK` say anything about the grants.
 */

/** Raised when a subject breaks the contract. Carries the case that found it. */
export class SqlContractViolation extends Error {
  override readonly name = "SqlContractViolation";
  constructor(
    readonly contractCase: string,
    detail: string,
  ) {
    super(`SqlExecutor contract — ${contractCase}: ${detail}`);
  }
}

/**
 * The statements the suite needs, in the subject's own dialect.
 *
 * Supplying them is the subject's job because the suite must not assume a
 * dialect: an application on a Postgres-compatible engine, or on a fake, writes
 * whatever its executor understands. The shapes are fixed and tiny.
 */
export interface SqlContractStatements {
  /** One parameter, a text value. Inserts one row into a scratch table. */
  readonly insert: string;
  /** No parameters. Returns exactly one row with an integer column `n`. */
  readonly countAll: string;
  /** One parameter. Returns the rows whose value equals it, in a column `v`. */
  readonly selectByValue: string;
  /** A statement the executor must reject — a syntax error will do. */
  readonly invalid: string;
  /**
   * Optional. A statement that violates an integrity constraint when run twice
   * with the same parameter. Supplied only where a real database is behind the
   * subject; the cases that use it are skipped otherwise, because a fake that
   * invented a SQLSTATE would be checking its own imagination.
   */
  readonly duplicate?: string;
}

export interface SqlContractSubject {
  /** The executor under test. */
  readonly executor: SqlExecutor;
  readonly statements: SqlContractStatements;
  /** Empty the scratch table. Called before every case. */
  reset(): Promise<void>;
}

export interface SqlContractCase {
  readonly name: string;
  /** Throws `SqlContractViolation` — or whatever the subject threw — on failure. */
  run(): Promise<void>;
}

export interface SqlContractOutcome {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: unknown;
}

/** A sentinel the suite throws through `transaction`, so a rethrow is provable. */
class ContractSentinel extends Error {
  override readonly name = "ContractSentinel";
}

const countOf = async (
  subject: SqlContractSubject,
  caseName: string,
  on: SqlExecutor = subject.executor,
): Promise<number> => {
  const { rows } = await on.query(subject.statements.countAll, []);
  const row = rows[0];
  if (row === undefined) {
    throw new SqlContractViolation(caseName, "countAll returned no rows");
  }
  const raw = (row as SqlRow)["n"];
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new SqlContractViolation(
      caseName,
      `countAll returned a column 'n' that is not an integer: ${String(raw)}`,
    );
  }
  return n;
};

const expect = (caseName: string, condition: boolean, detail: string): void => {
  if (!condition) throw new SqlContractViolation(caseName, detail);
};

/**
 * Build the suite for one subject.
 *
 * Every case resets the subject first, so cases are independent and may be run
 * in any order, individually, or repeatedly — an application debugging its own
 * executor should be able to run one case in a loop.
 */
export const sqlExecutorContract = (
  subject: SqlContractSubject,
): readonly SqlContractCase[] => {
  const { statements } = subject;
  const cases: SqlContractCase[] = [];

  const contractCase = (name: string, body: () => Promise<void>): void => {
    cases.push({
      name,
      run: async () => {
        await subject.reset();
        await body();
      },
    });
  };

  contractCase("returns rows as an array, empty rather than absent", async () => {
    const name = "returns rows as an array, empty rather than absent";
    const { rows } = await subject.executor.query(statements.selectByValue, [
      "nothing-was-inserted",
    ]);
    expect(name, Array.isArray(rows), "query resolved with a non-array `rows`");
    expect(name, rows.length === 0, "a query matching nothing returned rows");
  });

  contractCase("binds parameters rather than interpolating them", async () => {
    const name = "binds parameters rather than interpolating them";
    // If this value reaches the database as SQL rather than as a value, the
    // statement either fails or does something else entirely. Round-tripping it
    // verbatim is the proof that it was bound. A correlation identifier is
    // caller data, and this is the case that stops it being SQL.
    const hostile = "'); DROP TABLE agent_ops.audit_trace_node; --";
    await subject.executor.query(statements.insert, [hostile]);
    const { rows } = await subject.executor.query(statements.selectByValue, [hostile]);
    expect(name, rows.length === 1, `expected one row back, got ${rows.length}`);
    expect(
      name,
      (rows[0] as SqlRow)["v"] === hostile,
      "the value did not round-trip verbatim, so it was not bound as a value",
    );
    expect(name, (await countOf(subject, name)) === 1, "the scratch table is not intact");
  });

  contractCase("commits the work of a transaction that resolves", async () => {
    const name = "commits the work of a transaction that resolves";
    await subject.executor.transaction(async (tx) => {
      await tx.query(statements.insert, ["committed"]);
    });
    expect(
      name,
      (await countOf(subject, name)) === 1,
      "work done in a transaction that resolved is not visible afterwards",
    );
  });

  contractCase("runs the whole callback on one connection", async () => {
    const name = "runs the whole callback on one connection";
    // The case that catches the fifteen-line executor which acquires a fresh
    // pooled connection per statement. Such an executor cannot see its own
    // uncommitted insert — and it also cannot hold the per-case advisory lock
    // across the sequence read and the append, which is the whole ordering
    // guarantee of this module.
    await subject.executor.transaction(async (tx) => {
      await tx.query(statements.insert, ["same-connection"]);
      const seen = await countOf(subject, name, tx);
      expect(
        name,
        seen === 1,
        "a statement could not see the uncommitted work of an earlier statement " +
          "in the same transaction, so the callback is not running on one connection",
      );
    });
  });

  contractCase("rolls back and rethrows when the callback rejects", async () => {
    const name = "rolls back and rethrows when the callback rejects";
    const sentinel = new ContractSentinel("deliberate");
    let thrown: unknown;
    try {
      await subject.executor.transaction(async (tx) => {
        await tx.query(statements.insert, ["rolled-back"]);
        throw sentinel;
      });
    } catch (error) {
      thrown = error;
    }
    // The identity check, not an `instanceof`: the trace store classifies
    // failures by the driver's SQLSTATE `code`, and an executor that wraps the
    // original error in a fresh one loses `code`. An integrity violation then
    // arrives as `TraceUnavailable` and is degraded away at low tier — a defect
    // reported as an outage, which is the exact inversion `errors.ts` exists to
    // prevent.
    expect(name, thrown === sentinel, "the original error was not rethrown unchanged");
    expect(
      name,
      (await countOf(subject, name)) === 0,
      "work done in a transaction that rejected is still visible: it did not roll back",
    );
  });

  contractCase("rejects a statement the database refuses", async () => {
    const name = "rejects a statement the database refuses";
    let rejected = false;
    try {
      await subject.executor.query(statements.invalid, []);
    } catch {
      rejected = true;
    }
    // "The write did not happen" and "the write happened and returned nothing"
    // are the two answers this module must never confuse: one is an error, the
    // other is a successful append with no returning clause.
    expect(name, rejected, "a refused statement resolved instead of rejecting");
  });

  contractCase("rolls the transaction back when a statement is refused", async () => {
    const name = "rolls the transaction back when a statement is refused";
    try {
      await subject.executor.transaction(async (tx) => {
        await tx.query(statements.insert, ["before-the-failure"]);
        await tx.query(statements.invalid, []);
      });
    } catch {
      // Expected.
    }
    expect(
      name,
      (await countOf(subject, name)) === 0,
      "a transaction containing a refused statement left its earlier work behind",
    );
  });

  contractCase("keeps concurrent transactions from sharing a connection", async () => {
    const name = "keeps concurrent transactions from sharing a connection";
    // Two transactions in flight at once. Neither may see the other's
    // uncommitted work. An executor that hands both the same connection makes
    // the second one's statements part of the first one's transaction, and a
    // rollback then discards work that was reported as committed.
    let firstInserted = (): void => undefined;
    const inserted = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });
    let observed = -1;

    const first = subject.executor.transaction(async (tx) => {
      await tx.query(statements.insert, ["first"]);
      firstInserted();
      // Hold the transaction open while the second one looks.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    const second = (async () => {
      await inserted;
      observed = await countOf(subject, name);
    })();

    await Promise.all([first, second]);
    expect(
      name,
      observed === 0,
      `a concurrent reader saw ${observed} uncommitted row(s) from another transaction`,
    );
  });

  if (statements.duplicate !== undefined) {
    const duplicate = statements.duplicate;
    contractCase("surfaces an integrity violation with its SQLSTATE", async () => {
      const name = "surfaces an integrity violation with its SQLSTATE";
      await subject.executor.query(duplicate, ["once"]);
      let thrown: unknown;
      try {
        await subject.executor.query(duplicate, ["once"]);
      } catch (error) {
        thrown = error;
      }
      expect(name, thrown !== undefined, "a duplicate key did not reject");
      const code =
        typeof thrown === "object" && thrown !== null && "code" in thrown
          ? (thrown as { readonly code: unknown }).code
          : undefined;
      // `postgres-store.ts` reads exactly this to tell a defect from an outage.
      // Without it, a constraint violation is degraded into a missing node.
      expect(
        name,
        typeof code === "string" && code.startsWith("23"),
        `expected a class-23 SQLSTATE on the rejection, got ${String(code)}`,
      );
    });
  }

  return cases;
};

/**
 * Run every case and report. For an operational script against a live pool,
 * where there is no test runner to drive the cases one at a time.
 *
 * Never throws for a failing case — it reports all of them, because an operator
 * proving a new composition root wants the whole list, not the first line of it.
 */
export const runSqlExecutorContract = async (
  subject: SqlContractSubject,
): Promise<readonly SqlContractOutcome[]> => {
  const outcomes: SqlContractOutcome[] = [];
  for (const contractCase of sqlExecutorContract(subject)) {
    try {
      await contractCase.run();
      outcomes.push({ name: contractCase.name, passed: true });
    } catch (error) {
      outcomes.push({ name: contractCase.name, passed: false, error });
    }
  }
  return outcomes;
};
