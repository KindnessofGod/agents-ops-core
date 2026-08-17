import { describe, expect, it } from "vitest";
import {
  AlertingMisconfigured,
  assertProductionAlerting,
  operationalStreamAlertSink,
  pagingAlertSink,
  recordingAlertSink,
  severityRank,
  type AlertSink,
} from "../index.js";
import {
  ALL_SEVERITIES,
  ROTA,
  SINK,
  conditions,
  harness,
  productionChain,
  testPageTransport,
  testStream,
} from "./fixtures.js";

/**
 * Requirement (a): a real seam with two real adapters, structurally separate
 * from every escalation path, plus a recording adapter for tests.
 *
 * The property that matters most is negative and cannot be asserted by looking
 * at a call: **no adapter here constructs an HTTP client and none reads a URL,
 * token or routing key from the environment.** So the tests below hold the
 * transport and the stream themselves. There is no code path from this package
 * to a network to disable, which is why no `SKIP_PAGING` flag exists and why
 * none would be trusted if it did.
 */

describe("adapter 1 — the pager, driven entirely by an injected transport", () => {
  it("sends one page per alert, with the payload and nothing else", async () => {
    const transport = testPageTransport();
    const sink = pagingAlertSink({
      id: SINK("sink_pager"),
      rota: ROTA("rota_oncall"),
      transport,
    });
    const h = harness({ sinks: [sink] });

    const result = await h.alerts.raise(conditions.heartbeatMissed("sweeper"));

    expect(result.outcome).toBe("delivered");
    expect(transport.sent).toHaveLength(1);
    const [page] = transport.sent;
    expect(page?.rota).toBe("rota_oncall");
    expect(page?.severity).toBe("liveness-lost");
    expect(page?.severityRank).toBe(severityRank("liveness-lost"));
    expect(page?.condition).toBe("heartbeat-missed");
    expect(page?.correlationId).toBeUndefined();
    expect(page?.detail.component).toBe("sweeper");
  });

  it("carries a stable idempotency key, so a retrying transport wakes one person once", async () => {
    const transport = testPageTransport();
    const sink = pagingAlertSink({ id: SINK("sink_pager"), rota: ROTA("rota_oncall"), transport });
    const h = harness({ sinks: [sink], limits: { suppressionWindowMs: 0 } });

    await h.alerts.raise(conditions.effectUnknown("c_k"));
    await h.alerts.raise(conditions.effectUnknown("c_k"));

    const keys = transport.sent.map((p) => p.idempotencyKey);
    expect(new Set(keys).size).toBe(2); // two genuine occurrences, two keys
    expect(keys[0]).toContain("effect-outcome-unknown");
  });

  it("declines below its floor by default — a population statistic never pages", async () => {
    const transport = testPageTransport();
    const stream = testStream();
    const h = harness({
      sinks: [
        pagingAlertSink({ id: SINK("sink_pager"), rota: ROTA("rota_oncall"), transport }),
        operationalStreamAlertSink({ id: SINK("sink_stream"), stream }),
      ],
    });

    const result = await h.alerts.raise(conditions.rateMoved());

    expect(result.outcome).toBe("delivered");
    if (result.outcome !== "delivered") return;
    expect(result.by).toBe("sink_stream");
    expect(transport.sent).toHaveLength(0);
    // Declining a severity is ROUTING, not failure. No degradation is recorded.
    expect(result.degradations).toHaveLength(0);
    expect(h.alerts.health().degradations).toBe(0);
  });
});

describe("adapter 2 — the structured operational stream", () => {
  it("writes one flat record per alert, agreeing with the pager's payload", async () => {
    const stream = testStream();
    const sink = operationalStreamAlertSink({ id: SINK("sink_stream"), stream });
    const h = harness({ sinks: [sink] });

    await h.alerts.raise(conditions.remindersStopped("c_rs"));

    expect(stream.written).toHaveLength(1);
    const [record] = stream.written;
    expect(record?.stream).toBe("agent-ops-core.alerts");
    expect(record?.severity).toBe("degraded");
    expect(record?.correlationId).toBe("c_rs");
    expect(record?.detail.overdueByMs).toBe(172_800_000);
    for (const value of Object.values(record?.detail ?? {})) {
      if (typeof value === "number") expect(Number.isSafeInteger(value)).toBe(true);
    }
  });

  it("takes every severity by default: it is the channel of last resort", () => {
    const sink = operationalStreamAlertSink({ id: SINK("sink_stream"), stream: testStream() });
    for (const severity of ALL_SEVERITIES) expect(sink.accepts).toContain(severity);
  });
});

describe("adapter 3 — the recorder, and why it is a deliverable", () => {
  it("keeps the alert a test wants to assert on, and pages nobody", async () => {
    const h = harness();
    await h.alerts.raise(conditions.buried("c_b"));
    expect(h.recorder.delivered).toHaveLength(1);
    expect(h.recorder.delivered[0]?.condition.kind).toBe("case-buried");
  });

  it("is bounded, and counts what it dropped", async () => {
    const recorder = recordingAlertSink({ id: SINK("sink_small"), capacity: 2 });
    const h = harness({ sinks: [recorder], limits: { suppressionWindowMs: 0 } });
    for (const id of ["a", "b", "c", "d"]) await h.alerts.raise(conditions.buried(`c_${id}`));
    expect(recorder.delivered).toHaveLength(2);
    expect(recorder.dropped).toBe(2);
  });

  it("exposes live state, not a snapshot taken at construction", async () => {
    const h = harness();
    expect(h.recorder.delivered).toHaveLength(0);
    await h.alerts.raise(conditions.buried("c_live"));
    expect(h.recorder.delivered).toHaveLength(1);
  });
});

describe("assertProductionAlerting — the composition root has to prove its wiring", () => {
  it("accepts a pager plus a stream", () => {
    const { sinks } = productionChain();
    expect(() => assertProductionAlerting([sinks[0], sinks[1]])).not.toThrow();
  });

  it("refuses a chain that only records", () => {
    // The exact failure OPEN-ITEMS-RESOLVED item 6 names: a sink that swallows
    // everything is a legitimate test adapter and an illegitimate production
    // one. It passes every test in this repository and pages nobody, forever.
    const recorder = recordingAlertSink();
    try {
      assertProductionAlerting([recorder]);
      expect.unreachable("a recording chain must not pass");
    } catch (error) {
      expect(error).toBeInstanceOf(AlertingMisconfigured);
      expect((error as AlertingMisconfigured).problem).toBe("test-sink-in-production-chain");
    }
  });

  it("refuses a chain where some severity reaches nobody", () => {
    const pager = pagingAlertSink({
      id: SINK("sink_pager"),
      rota: ROTA("rota_oncall"),
      transport: testPageTransport(),
    });
    try {
      assertProductionAlerting([pager]);
      expect.unreachable("an uncovered severity must not pass");
    } catch (error) {
      expect(error).toBeInstanceOf(AlertingMisconfigured);
      const misconfigured = error as AlertingMisconfigured;
      expect(misconfigured.problem).toBe("severity-uncovered");
      expect(misconfigured.severities).toEqual(["notice", "degraded"]);
    }
  });

  it("refuses a chain that cannot wake anybody for a missed heartbeat", () => {
    // A stream nobody reads at 3am is not a channel for the alert that means
    // every waiting case at once.
    const stream = operationalStreamAlertSink({ id: SINK("sink_stream"), stream: testStream() });
    try {
      assertProductionAlerting([stream]);
      expect.unreachable("a chain with no pager must not pass");
    } catch (error) {
      expect((error as AlertingMisconfigured).problem).toBe("no-paging-sink");
    }
  });

  it("refuses two sinks sharing an identifier: a degradation must name which failed", () => {
    const twin = (): AlertSink =>
      pagingAlertSink({
        id: SINK("sink_same"),
        rota: ROTA("rota_oncall"),
        transport: testPageTransport(),
        accepts: ["notice", "degraded", "incident", "liveness-lost"],
      });
    try {
      assertProductionAlerting([twin(), twin()]);
      expect.unreachable("duplicate identifiers must not pass");
    } catch (error) {
      expect((error as AlertingMisconfigured).problem).toBe("duplicate-sink-id");
    }
  });
});

describe("an alert cannot be routed to a business authority", () => {
  it("addresses an operator rota, and carries no brief, verdict or effect", async () => {
    const transport = testPageTransport();
    const h = harness({
      sinks: [pagingAlertSink({ id: SINK("sink_pager"), rota: ROTA("rota_oncall"), transport })],
    });
    await h.alerts.raise(conditions.reservedUnassisted("c_sep"));

    const [page] = transport.sent;
    expect(page?.rota).toBe("rota_oncall");
    // Nothing on a page describes a decision to be made. An alert says the
    // machinery is wrong; it does not transfer authority over anything.
    expect(page).not.toHaveProperty("brief");
    expect(page).not.toHaveProperty("verdict");
    expect(page).not.toHaveProperty("authority");
    expect(page).not.toHaveProperty("effect");
  });
});
