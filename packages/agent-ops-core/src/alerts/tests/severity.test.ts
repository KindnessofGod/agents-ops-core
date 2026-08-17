import { describe, expect, it } from "vitest";
import {
  SEVERITY_BY_CONDITION,
  SEVERITY_ORDER,
  SEVERITY_RANK,
  atLeast,
  compareSeverity,
  isLivenessSeverity,
  maxSeverity,
  severityOf,
  severityRank,
  type AlertCondition,
} from "../index.js";
import { ALL_SEVERITIES, conditions, oneOfEachCondition } from "./fixtures.js";

/**
 * Requirement (b): severity must mean something, and the ordering must live in
 * the type rather than in a comment.
 *
 * The compile-time half is proved by the build itself —
 * `LivenessOutranksEveryCaseAlert` in `severity.ts` and the two assertions in
 * `conditions.ts` do not instantiate if the ordering breaks, so `tsc` is the
 * test. What is left for a runtime test is the behaviour that follows from it,
 * and the one property nobody should have to take on trust: **a missed
 * heartbeat outranks every per-case alert, without exception.**
 */

describe("a missed heartbeat outranks every per-case alert", () => {
  it("ranks above every other condition's severity, one by one", () => {
    const heartbeat = severityOf(conditions.heartbeatMissed());
    const others = oneOfEachCondition().filter((c) => c.kind !== "heartbeat-missed");

    expect(others).toHaveLength(8);
    for (const condition of others) {
      const severity = severityOf(condition as AlertCondition);
      expect(compareSeverity(heartbeat, severity)).toBeGreaterThan(0);
      expect(maxSeverity(heartbeat, severity)).toBe(heartbeat);
    }
  });

  it("is the only condition carrying the liveness severity", () => {
    const liveness = Object.entries(SEVERITY_BY_CONDITION)
      .filter(([, severity]) => isLivenessSeverity(severity))
      .map(([kind]) => kind);
    expect(liveness).toEqual(["heartbeat-missed"]);
  });

  it("tops the order, so a sink thresholding on rank cannot exclude it", () => {
    expect(SEVERITY_ORDER[SEVERITY_ORDER.length - 1]).toBe("liveness-lost");
    for (const severity of ALL_SEVERITIES) {
      expect(severityRank("liveness-lost")).toBeGreaterThanOrEqual(severityRank(severity));
    }
  });
});

describe("the order and the ranks cannot drift apart", () => {
  it("ranks are the positions in the declared order", () => {
    SEVERITY_ORDER.forEach((severity, index) => {
      expect(SEVERITY_RANK[severity]).toBe(index);
      expect(severityRank(severity)).toBe(index);
    });
  });

  it("is a total order with no ties", () => {
    const ranks = SEVERITY_ORDER.map(severityRank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("atLeast reads as a floor, inclusive", () => {
    expect(atLeast("incident", "degraded")).toBe(true);
    expect(atLeast("degraded", "degraded")).toBe(true);
    expect(atLeast("notice", "degraded")).toBe(false);
  });
});

describe("severity is derived from the condition, never supplied", () => {
  it("gives the same answer for the same kind whatever the measurements say", () => {
    const mild = { ...conditions.heartbeatMissed(), overdueByMs: 1 };
    const severe = { ...conditions.heartbeatMissed(), overdueByMs: 86_400_000 };
    expect(severityOf(mild)).toBe(severityOf(severe));
    expect(severityOf(mild)).toBe("liveness-lost");
  });

  it("keeps the two legally-loaded conditions at incident", () => {
    // A reserved decision completed unassisted is a breach that reports success;
    // an effect in `unknown` may already be a double payment. Neither is a notice.
    expect(severityOf(conditions.reservedUnassisted())).toBe("incident");
    expect(severityOf(conditions.effectUnknown())).toBe("incident");
  });

  it("keeps a population statistic off the pager", () => {
    // Every individual case behaved exactly as designed. This wants a human to
    // look in the morning, and paging for it is how a channel gets muted.
    expect(severityOf(conditions.rateMoved())).toBe("notice");
  });
});
