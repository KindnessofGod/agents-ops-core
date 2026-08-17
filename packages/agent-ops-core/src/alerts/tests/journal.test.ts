import { describe, expect, it } from "vitest";
import { CONDITION_PAYLOAD_VERSION, inMemoryAlertJournal, recordingAlertSink } from "../index.js";
import { SINK, conditions, harness, throwingSink } from "./fixtures.js";

/**
 * Requirement (g): alerts are recorded as nodes where a correlation identifier
 * exists; where none exists the alert still emits.
 *
 * The `audit`-backed adapter is deliberately not built in this module — wiring
 * two modules together is a composition-root job — so what is asserted here is
 * everything that must be true *before* that wiring: the entry is node-shaped,
 * it carries what actually happened rather than what was intended, and nothing
 * about journalling can prevent, delay or fail a delivery.
 */

describe("an alert about a case is recorded against that case", () => {
  it("journals a node-shaped entry with the correlation identifier", async () => {
    const h = harness();
    await h.alerts.raise(conditions.reservedUnassisted("c_journal"));

    expect(h.journal?.entries).toHaveLength(1);
    const [entry] = h.journal?.entries ?? [];
    expect(entry).toMatchObject({
      correlationId: "c_journal",
      severity: "incident",
      condition: "reserved-decision-completed-unassisted",
      outcome: "delivered",
      deliveredBy: "sink_recorder",
    });
    // Node-shaped: a versioned, flat, integer-only payload. An audit-backed
    // adapter is a `record` call, not a translation layer.
    expect(entry?.payload.kind).toBe("alert.reserved-decision-completed-unassisted");
    expect(entry?.payload.v).toBe(CONDITION_PAYLOAD_VERSION);
    for (const value of Object.values(entry?.payload ?? {})) {
      if (typeof value === "number") expect(Number.isSafeInteger(value)).toBe(true);
    }
  });

  it("records what HAPPENED, including the degradations on the way", async () => {
    const h = harness({
      sinks: [
        throwingSink("sink_pager", () => new Error("down")),
        recordingAlertSink({ id: SINK("sink_recorder") }),
      ],
    });
    await h.alerts.raise(conditions.effectUnknown("c_degraded"));

    const [entry] = h.journal?.entries ?? [];
    // Journalled AFTER the chain is walked, so the record is evidence of the
    // delivery rather than an intention to deliver.
    expect(entry?.outcome).toBe("delivered");
    expect(entry?.deliveredBy).toBe("sink_recorder");
    expect(entry?.degradations).toHaveLength(1);
    expect(entry?.degradations[0]?.sink).toBe("sink_pager");
  });

  it("records an undelivered alert too: the failure is itself evidence", async () => {
    const h = harness({ sinks: [throwingSink("sink_only", () => new Error("down"))] });
    await h.alerts.raise(conditions.buried("c_undelivered"));

    const [entry] = h.journal?.entries ?? [];
    expect(entry).toMatchObject({ outcome: "undelivered", deliveredBy: undefined });
  });
});

describe("an alert with no case still emits", () => {
  it("delivers a missed heartbeat and says why it was not journalled", async () => {
    const h = harness();
    const result = await h.alerts.raise(conditions.heartbeatMissed("sweeper"));

    expect(h.recorder.delivered).toHaveLength(1);
    if (result.outcome !== "delivered") throw new Error("expected delivery");
    expect(result.journal).toEqual({ journalled: false, why: "no-correlation-identifier" });
    expect(h.journal?.entries).toHaveLength(0);
  });

  it("does the same for a population statistic", async () => {
    const h = harness();
    const result = await h.alerts.raise(conditions.rateMoved());
    if (result.outcome !== "delivered") throw new Error("expected delivery");
    expect(result.journal).toEqual({ journalled: false, why: "no-correlation-identifier" });
  });
});

describe("journalling can never cost an alert", () => {
  it("delivers first, so a journal that fails cannot stop a page", async () => {
    const order: string[] = [];
    const failing = {
      record() {
        order.push("journal");
        return Promise.reject(new Error("archive is down"));
      },
    } as unknown as ReturnType<typeof inMemoryAlertJournal>;
    const recorder = recordingAlertSink({ id: SINK("sink_recorder") });
    const h = harness({ sinks: [recorder], journal: failing });

    const result = await h.alerts.raise(conditions.traceUnavailableHigh("c_journal_fail"));

    expect(recorder.delivered).toHaveLength(1);
    expect(order).toEqual(["journal"]);
    if (result.outcome !== "delivered") throw new Error("expected delivery");
    // Delivered AND not journalled, said in one value. Not one or the other.
    expect(result.journal).toEqual({
      journalled: false,
      why: "journal-failed",
      detail: "Error",
    });
    expect(h.alerts.health().journalFailures).toBe(1);
  });

  it("works with no journal at all, and says so rather than implying success", async () => {
    const h = harness({ journal: null });
    const result = await h.alerts.raise(conditions.buried("c_nojournal"));

    expect(h.recorder.delivered).toHaveLength(1);
    if (result.outcome !== "delivered") throw new Error("expected delivery");
    expect(result.journal).toEqual({ journalled: false, why: "no-journal-configured" });
  });
});

describe("the in-memory journal is a bounded deliverable", () => {
  it("keeps entries, counts drops, and clears", async () => {
    const journal = inMemoryAlertJournal({ capacity: 2 });
    const h = harness({ journal, limits: { suppressionWindowMs: 0 } });
    for (const id of ["a", "b", "c"]) await h.alerts.raise(conditions.buried(`c_${id}`));

    expect(journal.entries).toHaveLength(2);
    expect(journal.dropped).toBe(1);
    journal.clear();
    expect(journal.entries).toHaveLength(0);
  });
});
