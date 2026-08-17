import { describe, expect, it } from "vitest";
import {
  createAudit,
  inMemoryTraceStore,
  redactFields,
  type CorrelationId as AuditCorrelationId,
  type UnavailabilityPolicy,
} from "../../audit/index.js";
import {
  AlertJournalEntryUnrecordable,
  auditBackedAlertJournal,
  createAlerts,
  recordingAlertSink,
  type AlertTraceOpener,
  type CorrelationId,
} from "../index.js";
import { SINK, conditions, manualTimers, testClock, throwingSink } from "./fixtures.js";

/**
 * README item 3, closed: the `audit`-backed `AlertJournal`.
 *
 * ## The direction, which is the whole reason this looks the way it does
 *
 * `audit/lib/audit.ts` imports `alerts.raiseAndRecord`. An `import` of `audit`
 * from inside `alerts` would close that into a cycle, and `npm run
 * lint:boundaries` fails the build on one — correctly, because a cycle would
 * mean neither module could be deployed without the other and nineteen
 * applications would inherit a seven-year archive behind their pager.
 *
 * So `auditBackedAlertJournal` takes the trace as a **parameter**, typed
 * structurally in `alerts`. This test is where the claim "an `Audit` satisfies
 * it with no adapter and no cast" is checked, because a test *may* import
 * another module's entry point — it is a caller, and this is exactly the wiring
 * a composition root does. The shipped module still imports nothing:
 * `production.test.ts` asserts that over every file in `index.ts` and `lib/`.
 */

const CASE = (id: string): CorrelationId => id as CorrelationId;

const strictPolicy: UnavailabilityPolicy = { high: "fail-closed", medium: "fail-closed", low: "fail-closed" };

const auditHarness = (options?: {
  readonly policy?: UnavailabilityPolicy;
  readonly tier?: "low" | "medium" | "high";
}) => {
  const clock = testClock(1_700_000_000_000);
  const store = inMemoryTraceStore();
  const audit = createAudit({
    store,
    clock,
    redact: redactFields([]),
    onTraceUnavailable: options?.policy ?? strictPolicy,
  });
  // The line a composition root writes. No adapter, no cast, no `as`.
  const journal = auditBackedAlertJournal({ trace: audit, tier: options?.tier ?? "high" });
  const recorder = recordingAlertSink({ id: SINK("sink_recorder") });
  const alerts = createAlerts({
    sinks: [recorder],
    clock,
    timers: manualTimers(),
    journal,
  });
  return { alerts, audit, clock, journal, recorder };
};

const nodesOf = async (
  audit: ReturnType<typeof createAudit>,
  id: string,
): Promise<readonly { readonly payload: Record<string, unknown> }[]> => {
  const replayed = await audit.replay(id as unknown as AuditCorrelationId);
  return replayed.nodes as unknown as readonly { readonly payload: Record<string, unknown> }[];
};

describe("an Audit satisfies the journal's parameter with no adapter", () => {
  it("typechecks as an AlertTraceOpener, which is what makes the wiring one line", () => {
    const audit = createAudit({
      store: inMemoryTraceStore(),
      clock: testClock(),
      redact: redactFields([]),
      onTraceUnavailable: strictPolicy,
    });
    // If this assignment ever needs a cast, the two structural declarations have
    // drifted and every composition root is about to find out the hard way.
    const opener: AlertTraceOpener = audit;
    expect(typeof opener.open).toBe("function");
  });
});

describe("an alert about a case becomes a node on that case's trace", () => {
  it("records the condition AND what became of the alert, in one node", async () => {
    const h = auditHarness();
    await h.alerts.raise(conditions.reservedUnassisted("c_reserved_1"));

    const nodes = await nodesOf(h.audit, "c_reserved_1");
    expect(nodes).toHaveLength(1);
    const payload = nodes[0]?.payload ?? {};

    // The condition, unchanged.
    expect(payload["kind"]).toBe("alert.reserved-decision-completed-unassisted");
    expect(payload["decisionPoint"]).toBe("disburse");
    expect(payload["reservedRule"]).toBe("fca_conc_7_3");

    // And whether anybody was actually told — the half a payload alone omits.
    // The field names are `raiseAndRecord`'s, deliberately, so a node written by
    // a detection site and one written by this journal read identically in 2033.
    expect(payload["alert"]).toBe(true);
    expect(payload["alerted"]).toBe("delivered");
    expect(payload["alertBy"]).toBe("sink_recorder");
    expect(payload["alertSeverity"]).toBe("incident");
    expect(payload["alertDegradations"]).toBe(0);
  });

  it("is flat and integer-only, so it survives seven years of replay", async () => {
    const h = auditHarness();
    await h.alerts.raise(conditions.effectUnknown("c_effect_1"));
    const payload = (await nodesOf(h.audit, "c_effect_1"))[0]?.payload ?? {};
    for (const [field, value] of Object.entries(payload)) {
      expect(["string", "number", "boolean"], `${field} is ${typeof value}`).toContain(
        typeof value,
      );
      if (typeof value === "number") {
        expect(Number.isSafeInteger(value), `${field}=${value}`).toBe(true);
      }
    }
  });

  it("records an undelivered alert too, naming the sink that failed", async () => {
    const clock = testClock(1_700_000_000_000);
    const audit = createAudit({
      store: inMemoryTraceStore(),
      clock,
      redact: redactFields([]),
      onTraceUnavailable: strictPolicy,
    });
    const alerts = createAlerts({
      sinks: [throwingSink("sink_pager", () => new Error("pager down"))],
      clock,
      timers: manualTimers(),
      journal: auditBackedAlertJournal({ trace: audit, tier: "high" }),
    });
    await alerts.raise(conditions.buried("c_buried_1"));

    const payload = (await nodesOf(audit, "c_buried_1"))[0]?.payload ?? {};
    expect(payload["alerted"]).toBe("undelivered");
    expect(payload["alertDegradations"]).toBe(1);
    expect(payload["alertDegradedSink"]).toBe("sink_pager");
    // The exception's NAME only. A message routinely echoes the request that
    // failed, and this node has no un-writing.
    expect(JSON.stringify(payload)).not.toContain("pager down");
  });

  it("puts every alert about one case on that one case, in order", async () => {
    const h = auditHarness();
    await h.alerts.raise(conditions.reservedUnassisted("c_many"));
    await h.alerts.raise(conditions.buried("c_many"));
    await h.alerts.raise(conditions.effectUnknown("c_many"));

    const nodes = await nodesOf(h.audit, "c_many");
    expect(nodes.map((n) => n.payload["kind"])).toEqual([
      "alert.reserved-decision-completed-unassisted",
      "alert.case-buried",
      "alert.effect-outcome-unknown",
    ]);
  });
});

describe("an alert with no case still emits, and writes no node", () => {
  it("delivers a missed heartbeat and says why it was not journalled", async () => {
    const h = auditHarness();
    const result = await h.alerts.raise(conditions.heartbeatMissed("sweeper"));

    expect(h.recorder.delivered).toHaveLength(1);
    if (result.outcome !== "delivered") throw new Error("expected delivery");
    expect(result.journal).toEqual({ journalled: false, why: "no-correlation-identifier" });
    // A missed heartbeat is not a node on any trace, so there is nothing to open.
    await expect(nodesOf(h.audit, "sweeper")).rejects.toThrow();
  });
});

describe("journalling can never cost an alert", () => {
  it("a trace that refuses the write leaves the alert delivered and says the node is missing", async () => {
    const clock = testClock(1_700_000_000_000);
    const exploding: AlertTraceOpener = {
      open: () => Promise.reject(new Error("archive unreachable")),
    };
    const recorder = recordingAlertSink({ id: SINK("sink_recorder") });
    const alerts = createAlerts({
      sinks: [recorder],
      clock,
      timers: manualTimers(),
      journal: auditBackedAlertJournal({ trace: exploding, tier: "high" }),
    });

    const result = await alerts.raise(conditions.remindersStopped("c_reminders_1"));
    expect(recorder.delivered).toHaveLength(1);
    if (result.outcome !== "delivered") throw new Error("expected delivery");
    expect(result.journal).toMatchObject({ journalled: false, why: "journal-failed" });
  });

  it("does not memoise a failed open: the next alert on that case tries again", async () => {
    let attempts = 0;
    const store = inMemoryTraceStore();
    const clock = testClock(1_700_000_000_000);
    const audit = createAudit({
      store,
      clock,
      redact: redactFields([]),
      onTraceUnavailable: strictPolicy,
    });
    const flaky: AlertTraceOpener = {
      open: (id) => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("transient"))
          : (audit.open(id as unknown as AuditCorrelationId) as unknown as ReturnType<
              AlertTraceOpener["open"]
            >);
      },
    };
    const alerts = createAlerts({
      sinks: [recordingAlertSink({ id: SINK("sink_recorder") })],
      clock,
      timers: manualTimers(),
      journal: auditBackedAlertJournal({ trace: flaky, tier: "high" }),
    });

    // Two DIFFERENT conditions on one case: an identical pair would collapse in
    // suppression and never reach the journal a second time.
    await alerts.raise(conditions.buried("c_flaky"));
    await alerts.raise(conditions.effectUnknown("c_flaky"));
    expect(attempts).toBe(2);
    // A memoised rejection would have made one outage a permanent hole in the
    // evidence for this case.
    expect(await nodesOf(audit, "c_flaky")).toHaveLength(1);
  });

  it("reports a DEGRADED write as not journalled — never as journalled", async () => {
    // This is the dishonesty the adapter exists to refuse. At a degradable tier
    // `record` can return `recorded: false`: the archive was down and the
    // policy permitted continuing. No node was written, and saying otherwise
    // would give an auditor a figure with nothing behind it.
    const degrading: AlertTraceOpener = {
      open: () =>
        Promise.resolve({
          record: () => Promise.resolve({ recorded: false }),
        }),
    };
    const journal = auditBackedAlertJournal({ trace: degrading, tier: "low" });
    const error = await journal
      .record({
        alertId: "alert_1" as never,
        correlationId: CASE("c_degraded"),
        at: 1_700_000_000_000,
        severity: "incident",
        condition: "case-buried",
        fingerprint: "fp_1" as never,
        payload: { kind: "alert.case-buried", v: 1 },
        deliveredBy: undefined,
        degradations: [],
        outcome: "delivered",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlertJournalEntryUnrecordable);
  });

  it("refuses to overwrite a payload field rather than silently winning", async () => {
    const journal = auditBackedAlertJournal({
      trace: { open: () => Promise.resolve({ record: () => Promise.resolve({ recorded: true }) }) },
      tier: "high",
    });
    const error = await journal
      .record({
        alertId: "alert_1" as never,
        correlationId: CASE("c_collide"),
        at: 1_700_000_000_000,
        severity: "notice",
        condition: "case-buried",
        fingerprint: "fp_1" as never,
        // A payload that already owns a journal field name.
        payload: { kind: "alert.case-buried", v: 1, alerted: "something-else" },
        deliveredBy: undefined,
        degradations: [],
        outcome: "delivered",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlertJournalEntryUnrecordable);
    expect(error).toMatchObject({ field: "alerted" });
  });

  it("sheds a journal write over the ceiling, and never an alert", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const journal = auditBackedAlertJournal({
      trace: {
        open: () => Promise.resolve({ record: async () => (await gate, { recorded: true }) }),
      },
      tier: "high",
      limits: { maxPendingWrites: 1 },
    });
    const entry = (id: string) =>
      ({
        alertId: "alert_1" as never,
        correlationId: CASE(id),
        at: 1_700_000_000_000,
        severity: "notice" as const,
        condition: "case-buried" as const,
        fingerprint: "fp_1" as never,
        payload: { kind: "alert.case-buried", v: 1 },
        deliveredBy: undefined,
        degradations: [],
        outcome: "delivered" as const,
      });

    const first = journal.record(entry("c_a"));
    const shed = await journal.record(entry("c_b")).catch((e: unknown) => e);
    expect(shed).toBeInstanceOf(AlertJournalEntryUnrecordable);
    release?.();
    await first;
  });
});
