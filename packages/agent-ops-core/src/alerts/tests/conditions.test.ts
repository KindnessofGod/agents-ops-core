import { describe, expect, it } from "vitest";
import {
  CONDITION_PAYLOAD_VERSION,
  SEVERITY_BY_CONDITION,
  UnknownAlertCondition,
  correlationOf,
  fingerprintOf,
  payloadOf,
  severityOf,
  type AlertCondition,
} from "../index.js";
import { ALL_CONDITION_KINDS, CASE, conditions, oneOfEachCondition } from "./fixtures.js";

/**
 * Requirement (c): the eight silent conditions as a closed, exhaustively-checked
 * union, plus the ninth that outranks them.
 *
 * The compile-time half — adding a condition without handling it must not build
 * — is asserted in `exhaustive.test.ts`, which runs the compiler. These tests
 * assert the runtime consequences: every kind is handled in all four places,
 * every payload is recordable, and the closed union stays closed when a
 * JavaScript caller ignores it.
 */

describe("the union is the eight from CONTEXT.md, plus the heartbeat", () => {
  it("has exactly nine kinds, and the eight silent ones are the documented eight", () => {
    expect(ALL_CONDITION_KINDS).toHaveLength(9);
    expect(Object.keys(SEVERITY_BY_CONDITION).sort()).toEqual([...ALL_CONDITION_KINDS].sort());
    expect(ALL_CONDITION_KINDS).toContain("reserved-decision-completed-unassisted");
    expect(ALL_CONDITION_KINDS).toContain("effect-outcome-unknown");
    expect(ALL_CONDITION_KINDS).toContain("reminders-stopped");
    expect(ALL_CONDITION_KINDS).toContain("case-buried");
    expect(ALL_CONDITION_KINDS).toContain("authority-unavailable");
    expect(ALL_CONDITION_KINDS).toContain("under-recording-detected");
    expect(ALL_CONDITION_KINDS).toContain("trace-unavailable-at-high-tier");
    expect(ALL_CONDITION_KINDS).toContain("rate-moved-sharply");
    expect(ALL_CONDITION_KINDS).toContain("heartbeat-missed");
  });

  it("handles every kind in all four exhaustive places", () => {
    const seen = new Set<string>();
    for (const condition of oneOfEachCondition()) {
      const c = condition as AlertCondition;
      seen.add(c.kind);
      expect(severityOf(c)).toBeTypeOf("string");
      expect(fingerprintOf(c)).toContain(c.kind);
      expect(payloadOf(c).kind).toBe(`alert.${c.kind}`);
      // correlationOf answers for every kind; `undefined` is an answer, and it
      // is the answer requirement (g) turns on.
      expect(["string", "undefined"]).toContain(typeof correlationOf(c));
    }
    expect([...seen].sort()).toEqual([...ALL_CONDITION_KINDS].sort());
  });
});

describe("which conditions are about a case, and which are not", () => {
  it("gives a correlation identifier for the seven that have one", () => {
    expect(correlationOf(conditions.reservedUnassisted("c1"))).toBe(CASE("c1"));
    expect(correlationOf(conditions.effectUnknown("c2"))).toBe(CASE("c2"));
    expect(correlationOf(conditions.remindersStopped("c3"))).toBe(CASE("c3"));
    expect(correlationOf(conditions.buried("c4"))).toBe(CASE("c4"));
    expect(correlationOf(conditions.authorityUnavailable("c5"))).toBe(CASE("c5"));
    expect(correlationOf(conditions.underRecording("c6"))).toBe(CASE("c6"));
    expect(correlationOf(conditions.traceUnavailableHigh("c7"))).toBe(CASE("c7"));
  });

  it("gives none for a missed heartbeat or a population statistic", () => {
    // A missed heartbeat has no case. That is the point of requirement (g): the
    // alert still emits, it simply cannot be a node on a trace it has no place in.
    expect(correlationOf(conditions.heartbeatMissed())).toBeUndefined();
    expect(correlationOf(conditions.rateMoved())).toBeUndefined();
  });
});

describe("fingerprints collapse repeats without collapsing distinct conditions", () => {
  it("ignores measurements, so a flapping condition is one fingerprint", () => {
    const early = { ...conditions.heartbeatMissed(), overdueByMs: 1_000 };
    const late = { ...conditions.heartbeatMissed(), overdueByMs: 900_000, beatsObserved: 9 };
    expect(fingerprintOf(early)).toBe(fingerprintOf(late));
  });

  it("separates two cases, two components and two measures", () => {
    expect(fingerprintOf(conditions.buried("c_a"))).not.toBe(fingerprintOf(conditions.buried("c_b")));
    expect(fingerprintOf(conditions.heartbeatMissed("sweeper"))).not.toBe(
      fingerprintOf(conditions.heartbeatMissed("reconciler")),
    );
    expect(fingerprintOf(conditions.rateMoved("screen_input"))).not.toBe(
      fingerprintOf(conditions.rateMoved("determine")),
    );
  });

  it("separates two kinds about the same case", () => {
    expect(fingerprintOf(conditions.remindersStopped("c_same"))).not.toBe(
      fingerprintOf(conditions.underRecording("c_same")),
    );
  });
});

describe("payloads are recordable evidence, not prose", () => {
  it("is flat, versioned, and integers only", () => {
    for (const condition of oneOfEachCondition()) {
      const payload = payloadOf(condition as AlertCondition);
      expect(payload.v).toBe(CONDITION_PAYLOAD_VERSION);
      for (const [field, value] of Object.entries(payload)) {
        expect(["string", "number", "boolean"]).toContain(typeof value);
        if (typeof value === "number") {
          // No IEEE-754 anywhere. Byte-stable serialisation is what makes replay
          // possible seven years later and floats are how it dies quietly.
          expect(Number.isSafeInteger(value), `${field}=${value}`).toBe(true);
        }
      }
    }
  });

  it("loses nothing: every condition field reaches the payload", () => {
    const condition = conditions.underRecording("c_cov");
    const payload = payloadOf(condition);
    expect(payload).toMatchObject({
      correlationId: "c_cov",
      decisionsExamined: 400,
      decisionsWithoutModelCall: 37,
      coverageFloorBasisPoints: 9_500,
      observedCoverageBasisPoints: 9_075,
    });
  });

  it("flattens the never-seen/last-beat pair without collapsing it", () => {
    const stopped = payloadOf(conditions.heartbeatMissed());
    expect(stopped.lastSeen).toBe("beat");
    expect(stopped.lastSeenAt).toBe(1_700_000_000_000);

    const neverStarted = payloadOf({
      ...conditions.heartbeatMissed(),
      lastSeen: { seen: "never", watchingSince: 1_699_000_000_000 },
      beatsObserved: 0,
    });
    // "It stopped" and "it never started" stay different sentences in the record.
    expect(neverStarted.lastSeen).toBe("never");
    expect(neverStarted.lastSeenAt).toBe(1_699_000_000_000);
  });

  it("has no free-text field anywhere, so personal data has nowhere to arrive", () => {
    const declared = new Set([
      "kind",
      "v",
      "correlationId",
      "decisionPoint",
      "reservedRule",
      "tier",
      "effectKind",
      "idempotencyKey",
      "unknownForMs",
      "expectedEveryMs",
      "overdueByMs",
      "remindersSent",
      "awaitingForMs",
      "scheduledStepsSpent",
      "recurrenceCycles",
      "pool",
      "reserved",
      "decisionsExamined",
      "decisionsWithoutModelCall",
      "coverageFloorBasisPoints",
      "observedCoverageBasisPoints",
      "reason",
      "measure",
      "windowMs",
      "baselineBasisPoints",
      "observedBasisPoints",
      "sampleSize",
      "component",
      "beatsObserved",
      "lastSeen",
      "lastSeenAt",
    ]);
    for (const condition of oneOfEachCondition()) {
      for (const field of Object.keys(payloadOf(condition as AlertCondition))) {
        expect(declared.has(field), `undeclared payload field ${field}`).toBe(true);
      }
    }
  });
});

describe("the closed union stays closed at runtime too", () => {
  it("refuses a kind the type system was promised would not exist", () => {
    // A JavaScript caller, or a JSON.parse of something older or newer than this
    // release. Guessing a severity here would invent the one thing this module
    // exists to get right.
    const smuggled = { kind: "everything-is-fine" } as unknown as AlertCondition;
    expect(() => severityOf(smuggled)).not.toThrow(); // lookup misses, no guess
    expect(severityOf(smuggled)).toBeUndefined();
    expect(() => fingerprintOf(smuggled)).toThrow(/unhandled variant/);
    expect(() => payloadOf(smuggled)).toThrow(/unhandled variant/);
    expect(() => correlationOf(smuggled)).toThrow(/unhandled variant/);
  });

  it("is rejected by name at the interface", async () => {
    const { harness } = await import("./fixtures.js");
    const h = harness();
    const smuggled = { kind: "everything-is-fine" } as unknown as AlertCondition;
    await expect(h.alerts.raise(smuggled)).rejects.toBeInstanceOf(UnknownAlertCondition);
  });
});
