import { describe, expect, it } from "vitest";
import {
  SqlContractViolation,
  runSqlExecutorContract,
  sqlExecutorContract,
  type SqlContractStatements,
  type SqlContractSubject,
  type SqlExecutor,
  type SqlRow,
} from "../index.js";

/**
 * The `SqlExecutor` contract, run without a driver.
 *
 * ## What this file is for
 *
 * `postgres-store.test.ts` ends with an honest note: the schema's own guarantees
 * are properties of Postgres and no test in this package exercises them, because
 * no test in this package may open a socket. That is still true.
 *
 * The other half was worse for being invisible. `SqlExecutor` is the one
 * interface every deployment implements itself, in fifteen lines, at a
 * composition root — and until now those fifteen lines were held to nothing. An
 * executor whose `transaction` hands each statement a fresh pooled connection
 * typechecks perfectly and silently reduces the per-case advisory lock to a lock
 * taken and released around one statement; two writers to one case then read the
 * same `MAX(sequence)`.
 *
 * So the contract ships as an executable suite with no test-framework
 * dependency, and this file does two things with it:
 *
 *   1. Runs it against an in-memory executor that genuinely honours the
 *      obligations, proving the suite is **satisfiable** and that the harness
 *      holds. This is the run CI performs.
 *   2. Runs it against three executors that each break one obligation, proving
 *      the suite has **teeth**. A contract suite nothing can fail is a
 *      paragraph with a test runner attached.
 *
 * What neither run says anything about is Postgres. Grants, triggers and
 * constraints are verified by applying the migrations to a real cluster; a green
 * run here is evidence about an executor's behaviour and nothing else.
 */

const STATEMENTS: SqlContractStatements = {
  insert: "INSERT INTO scratch (v) VALUES ($1)",
  countAll: "SELECT count(*) AS n FROM scratch",
  selectByValue: "SELECT v FROM scratch WHERE v = $1",
  invalid: "THIS IS NOT A STATEMENT",
};

type Rows = string[];

/**
 * An in-memory executor that honours every obligation: parameters are values and
 * never text, a transaction runs on its own copy of the state, a rejection
 * discards that copy and rethrows the original error, and transactions are
 * serialised so two in flight cannot see each other's uncommitted work.
 *
 * It is the shape of thing an application writes to test its own wiring, which
 * is exactly why the suite has to be able to check it.
 */
interface Scratch {
  readonly executor: SqlExecutor;
  reset(): Promise<void>;
}

const honestExecutor = (): Scratch => {
  let committed: Rows = [];
  let queue: Promise<unknown> = Promise.resolve();

  const runOn = async (
    rows: Rows,
    text: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: readonly SqlRow[] }> => {
    if (text === STATEMENTS.insert) {
      rows.push(String(params[0]));
      return { rows: [] };
    }
    if (text === STATEMENTS.countAll) return { rows: [{ n: rows.length }] };
    if (text === STATEMENTS.selectByValue) {
      return { rows: rows.filter((v) => v === params[0]).map((v) => ({ v })) };
    }
    // Anything else is refused, which is what a database does with a statement
    // it cannot parse — it does not resolve with an empty row set.
    throw Object.assign(new Error(`syntax error: ${text}`), { code: "42601" });
  };

  const executor: SqlExecutor = {
    query: (text, params) => runOn(committed, text, params),
    transaction: async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
      const run = queue.then(async () => {
        const draft = [...committed];
        const tx: SqlExecutor = {
          query: (text, params) => runOn(draft, text, params),
          transaction: async (inner) => inner(tx),
        };
        const result = await fn(tx);
        committed = draft;
        return result;
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return {
    executor,
    // The stand-in for `TRUNCATE scratch`. Every case resets first, so cases are
    // independent and may be run in any order, singly, or in a loop.
    reset: async () => {
      await queue;
      committed = [];
    },
  };
};

/**
 * Wrap a scratch executor — or a deliberately broken decorator over one — as a
 * contract subject. `reset` always reaches the underlying state, so a broken
 * decorator is measured against a clean table like any other subject.
 */
const subjectOver = (
  scratch: Scratch,
  executor: SqlExecutor = scratch.executor,
): SqlContractSubject => ({
  executor,
  statements: STATEMENTS,
  reset: () => scratch.reset(),
});

describe("audit — the SqlExecutor contract is satisfiable without a driver", () => {
  // One subject, every case, driven by the runner the rest of this package
  // uses. The suite itself imports no test framework — that is what lets the
  // same cases run against a live pool from an operational script.
  for (const contractCase of sqlExecutorContract(subjectOver(honestExecutor()))) {
    it(contractCase.name, async () => {
      await contractCase.run();
    });
  }

  it("skips the SQLSTATE case where no real database backs the subject", () => {
    const withoutDuplicate = sqlExecutorContract(subjectOver(honestExecutor()));
    const withDuplicate = sqlExecutorContract({
      ...subjectOver(honestExecutor()),
      statements: { ...STATEMENTS, duplicate: "INSERT INTO unique_scratch (v) VALUES ($1)" },
    });

    // A fake that invented a SQLSTATE would be checking its own imagination, so
    // the case appears only when a subject supplies the statement — and it is
    // the case that matters most against a live pool, because `postgres-store.ts`
    // reads exactly that code to tell a defect from an outage.
    expect(withDuplicate.length).toBe(withoutDuplicate.length + 1);
  });
});

describe("audit — the contract has teeth", () => {
  const failures = async (
    scratch: Scratch,
    broken: SqlExecutor,
  ): Promise<readonly string[]> => {
    const outcomes = await runSqlExecutorContract(subjectOver(scratch, broken));
    // A failure is reported, never thrown: an expiry-style run over a whole
    // suite must be able to record every refusal and continue.
    return outcomes.filter((o) => !o.passed).map((o) => o.name);
  };

  it("catches an executor whose transaction does not roll back", async () => {
    const scratch = honestExecutor();
    // The commonest fifteen-line mistake: `transaction` is a passthrough. Work
    // is applied immediately and a rejection leaves it behind.
    const noRollback: SqlExecutor = {
      query: (text, params) => scratch.executor.query(text, params),
      transaction: async (fn) => fn(scratch.executor),
    };

    const failed = await failures(scratch, noRollback);
    expect(failed).toContain("rolls back and rethrows when the callback rejects");
    expect(failed).toContain("rolls the transaction back when a statement is refused");
  });

  it("catches an executor that wraps the original error", async () => {
    const scratch = honestExecutor();
    const wrapping: SqlExecutor = {
      query: (text, params) => scratch.executor.query(text, params),
      transaction: async (fn) => {
        try {
          return await scratch.executor.transaction(fn);
        } catch (error) {
          // Looks tidy, loses `code`, and turns every integrity violation into
          // something `postgres-store.ts` reads as an outage — which is then
          // degraded away at low tier into a silently missing node.
          throw new Error(`transaction failed: ${String(error)}`);
        }
      },
    };

    const failed = await failures(scratch, wrapping);
    expect(failed).toContain("rolls back and rethrows when the callback rejects");
  });

  it("catches an executor that resolves a statement the database would refuse", async () => {
    const scratch = honestExecutor();
    const swallowing: SqlExecutor = {
      query: async (text, params) => {
        try {
          return await scratch.executor.query(text, params);
        } catch {
          // "The write did not happen" reported as "the write happened and
          // returned nothing" — the two answers this module must never confuse.
          return { rows: [] };
        }
      },
      transaction: (fn) => scratch.executor.transaction(fn),
    };

    const failed = await failures(scratch, swallowing);
    expect(failed).toContain("rejects a statement the database refuses");
    // And a violation is what it reports, with the case that found it.
    const outcomes = await runSqlExecutorContract(subjectOver(scratch, swallowing));
    const refused = outcomes.find((o) => o.name === "rejects a statement the database refuses");
    expect(refused?.error).toBeInstanceOf(SqlContractViolation);
  });

  it("catches an executor that gives every statement its own transaction", async () => {
    const scratch = honestExecutor();
    // Autocommit per statement — what you get when `transaction` acquires a
    // connection for the BEGIN and then issues the callback's statements on the
    // pool. Note which cases catch it and which do not: the work *is* visible
    // to a later statement in the callback, because it was committed. What it
    // cannot do is roll back, or keep its work to itself while it runs — and in
    // this module that means the per-case advisory lock is released before the
    // append that depends on it.
    const perStatement: SqlExecutor = {
      query: (text, params) => scratch.executor.query(text, params),
      transaction: async (fn) => {
        const tx: SqlExecutor = {
          query: (text, params) =>
            scratch.executor.transaction(async (t) => t.query(text, params)),
          transaction: async (nested) => nested(tx),
        };
        return fn(tx);
      },
    };

    const failed = await failures(scratch, perStatement);
    expect(failed).toContain("rolls back and rethrows when the callback rejects");
    expect(failed).toContain("keeps concurrent transactions from sharing a connection");
  });
});
