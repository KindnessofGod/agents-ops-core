import { describe, expect, it } from "vitest";
import { CASE_A, harness, sameAtEveryTier, setOf, wallClock } from "./fixtures.js";
import type { CorrelationId } from "../../audit/index.js";
import {
  deterministicDetector,
  preemptiveDetector,
  preemptiveScanPool,
  safePattern,
  systemTimer,
  type NonEmpty,
  type ScanPool,
  type ScanPoolSpec,
} from "../index.js";

/**
 * README item 10, closed: **a polynomial detector stall is now preemptible.**
 *
 * `safePattern` refuses every regular expression capable of *exponential*
 * backtracking. It cannot refuse every slow one — nothing short of a different
 * matching engine can prove a pattern linear — so an accepted pattern can still
 * cost far more than its budget on one field, and no in-process timer in this
 * runtime can interrupt central-processing-unit-bound work. That was the module's
 * frankest residual and it is the one closed here.
 *
 * The pattern below is the evidence that the residual is real rather than
 * theoretical. `a*a*a*b` carries no backreference, no alternation and no
 * quantified group, so the analyser accepts it — correctly, by its own stated
 * rules — and it is superpolynomial against a run of `a`s that never reaches a
 * `b`. Two hundred characters cost hundreds of milliseconds; two thousand cost
 * hours.
 *
 * Two tests carry the whole claim, and they are a pair:
 *
 *   - the in-process adapter cannot be preempted, over 200 characters, and the
 *     deadline it is handed does not help because it is only read *between*
 *     scans;
 *   - the worker-backed adapter answers within its budget over 2,000
 *     characters — a scan that would not finish inside this test run, this hour,
 *     or this working day — the screening fails closed, and the process is still
 *     healthy enough to screen again afterwards.
 *
 * Nothing here reaches a model, a database or a pager. A worker thread is local,
 * so these tests use the real one rather than a fake: the hermetic guarantee is
 * about credentials reaching a live dependency, and there is no dependency here
 * to reach.
 */

/** Accepted by `safePattern`, and superpolynomial on a non-matching run. */
const PATHOLOGICAL = () =>
  safePattern({
    rule: "test.pathological",
    match: /a*a*a*b/,
    confidenceBasisPoints: 9_000,
    covers: "personal-data.national-identifier",
  });

const stall = (chars: number) => ({ narrative: "a".repeat(chars) });

const poolOf = (over: Partial<ScanPoolSpec> = {}): ScanPool =>
  preemptiveScanPool({
    timer: systemTimer(),
    maxWorkers: 2,
    maxQueued: 4,
    maxTasksPerWorker: 100,
    maxHeapMb: 64,
    maxTimeoutMs: 5_000,
    ...over,
  });

const packOf = (pool: ScanPool) =>
  preemptiveDetector({
    pool,
    id: "pii.pathological",
    locales: ["en-GB"] as unknown as NonEmpty<string>,
    searches: "a deliberately expensive pattern",
    category: "personal-data",
    severity: "redact",
    patterns: [PATHOLOGICAL()],
  });

describe("the residual this closes is real", () => {
  it("cannot preempt the in-process adapter, and the deadline does not help", async () => {
    const detector = deterministicDetector({
      id: "pii.in-process",
      locales: ["en-GB"] as unknown as NonEmpty<string>,
      searches: "a deliberately expensive pattern",
      category: "personal-data",
      severity: "redact",
      patterns: [PATHOLOGICAL()],
    });
    const h = harness({ detectorSets: sameAtEveryTier(setOf("slow", [detector])) });

    const began = Date.now();
    await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      // Two hundred characters. The budget is two seconds and the deadline is
      // checked before every scan — neither is consulted once the one scan this
      // payload provokes is under way, because nothing in this runtime can
      // interrupt it.
      payload: stall(200),
      });
    const elapsed = Date.now() - began;

    // The event loop was held for far longer than any bound this module states.
    // A conservative floor: the machine that runs this may be much faster than
    // the one it was calibrated on, and the point is the order of magnitude.
    expect(elapsed).toBeGreaterThan(60);
  }, 30_000);
});

describe("the worker-backed adapter", () => {
  it("terminates a runaway scan, fails the screening closed, and leaves the process healthy", async () => {
    const pool = poolOf({ maxTimeoutMs: 400 });
    try {
      const h = harness({
        detectorSets: sameAtEveryTier(setOf("preemptive", [packOf(pool)])),
        clock: wallClock(),
      });

      const began = Date.now();
      const screening = await h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "high",
        // Two thousand characters of the same shape. In process this scan does
        // not finish inside this test run, this hour, or this working day.
        payload: stall(2_000),
      });
      const elapsed = Date.now() - began;

      // Preempted, not merely abandoned: the answer arrives near the budget.
      expect(elapsed).toBeLessThan(4_000);

      // Fail-closed, at every tier, with the ground naming the detector.
      expect(screening.recommended.recommend).toBe("abstain");
      expect(screening.recommended).toMatchObject({
        grounds: [{ ground: "detector-unavailable", reason: "declared" }],
      });
      expect(screening.detectors[0]?.outcome).toBe("unavailable");
      // Nothing was examined, so coverage says so rather than reading clean.
      expect(screening.coverage.depth).toBe("none");
      expect(screening.coverage.unavailableDetectors).toBe(1);

      // The worker was actually terminated — not a promise rejected while a
      // thread span on. This is the whole difference between this path and the
      // in-process one.
      expect(pool.stats().preempted).toBe(1);
      expect(pool.stats().terminated).toBeGreaterThanOrEqual(1);

      // And the process is healthy: a second screening through the same pool
      // gets a fresh worker and a real answer.
      const clean = await h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "high",
        payload: { narrative: "nothing here matches" },
      });
      expect(clean.recommended.recommend).toBe("allow");
      expect(clean.coverage.depth).toBe("deterministic");
    } finally {
      await pool.close();
    }
  }, 30_000);

  it("finds what the in-process adapter finds, at the same coordinates", async () => {
    const pool = poolOf();
    try {
      const detector = preemptiveDetector({
        pool,
        id: "pii.uk.nin.worker",
        locales: ["en-GB"] as unknown as NonEmpty<string>,
        searches: "United Kingdom national insurance numbers",
        category: "personal-data",
        severity: "redact",
        patterns: [
          safePattern({
            rule: "uk.national-insurance-number",
            match: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g,
            confidenceBasisPoints: 9_500,
            covers: "personal-data.national-identifier",
          }),
        ],
      });
      const h = harness({
        detectorSets: sameAtEveryTier(setOf("worker-nin", [detector])),
        clock: wallClock(),
      });

      const screening = await h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "low",
        payload: { narrative: "claimant AB 12 34 56 C filed on Tuesday" },
      });

      // Masked before anything was recorded, exactly as the in-process adapter
      // masks: the worker returns coordinates and integers, never matched text.
      expect(screening.payload.fields.narrative).toBe("claimant [redacted] filed on Tuesday");
      expect(screening.recommended.recommend).toBe("redact-and-allow");
      expect(screening.coverage.declared.covers).toContain(
        "personal-data.national-identifier",
      );
    } finally {
      await pool.close();
    }
  }, 30_000);

  it("declares itself unavailable rather than reporting a partial redaction", async () => {
    // A pattern that matches every character. Reporting the first thousand
    // sites and masking only those would put the rest of the payload into a
    // seven-year archive unmasked, which is the failure redaction exists to
    // prevent — so the bound fails the screening closed instead.
    const pool = poolOf();
    try {
      const detector = preemptiveDetector({
        pool,
        id: "pii.dense",
        locales: ["en-GB"] as unknown as NonEmpty<string>,
        searches: "a pattern that matches everywhere",
        category: "personal-data",
        severity: "redact",
        maxMatchesPerScan: 16,
        patterns: [
          safePattern({
            rule: "dense",
            match: /x/g,
            confidenceBasisPoints: 5_000,
            covers: "personal-data.name",
          }),
        ],
      });
      const h = harness({
        detectorSets: sameAtEveryTier(setOf("dense", [detector])),
        clock: wallClock(),
      });

      const screening = await h.guardrails.screenInput({
        correlationId: CASE_A,
        tier: "low",
        payload: { narrative: "x".repeat(64) },
      });
      expect(screening.recommended.recommend).toBe("abstain");
      expect(screening.recommended).toMatchObject({
        grounds: [{ ground: "detector-unavailable", reason: "declared" }],
      });
    } finally {
      await pool.close();
    }
  }, 30_000);
});

describe("the pool is bounded, and every bound has a name", () => {
  it("refuses at construction rather than at screening time", () => {
    expect(() => poolOf({ maxWorkers: 0 })).toThrow(/maxWorkers/);
    expect(() => poolOf({ maxWorkers: 4_096 })).toThrow(/maxWorkers/);
    expect(() => poolOf({ maxQueued: -1 })).toThrow(/maxQueued/);
    expect(() => poolOf({ maxTasksPerWorker: 0 })).toThrow(/maxTasksPerWorker/);
    expect(() => poolOf({ maxHeapMb: 0 })).toThrow(/maxHeapMb/);
    expect(() => poolOf({ maxTimeoutMs: 0 })).toThrow(/maxTimeoutMs/);
  });

  it("never spawns more workers than its ceiling, however many screenings arrive", async () => {
    const pool = poolOf({ maxWorkers: 2, maxQueued: 32, maxTimeoutMs: 5_000 });
    try {
      const h = harness({
        detectorSets: sameAtEveryTier(setOf("bounded", [packOf(pool)])),
        clock: wallClock(),
      });
      await Promise.all(
        Array.from({ length: 8 }, async (_unused, i) =>
          h.guardrails.screenInput({
            // One case each: concurrent screenings of the *same* case would be
            // testing `audit`'s concurrency rather than this pool's ceiling.
            correlationId: `case-pool-${String(i)}` as CorrelationId,
            tier: "low",
            payload: { narrative: `nothing to find ${String(i)}` },
          }),
        ),
      );
      expect(pool.stats().spawned).toBeLessThanOrEqual(2);
      expect(pool.stats().completed).toBe(8);
    } finally {
      await pool.close();
    }
  }, 30_000);

  it("fails closed when the queue is full rather than growing it", async () => {
    // One worker, no queue at all, and a scan that will hold that worker for
    // the whole timeout. Every other screening is refused immediately — a
    // refusal is an abstention, and an unbounded queue is a memory incident
    // wearing the costume of resilience.
    const pool = poolOf({ maxWorkers: 1, maxQueued: 0, maxTimeoutMs: 600 });
    try {
      const h = harness({
        detectorSets: sameAtEveryTier(setOf("saturating", [packOf(pool)])),
        clock: wallClock(),
      });
      const screenings = await Promise.all(
        ["a", "b", "c"].map(async (name) =>
          h.guardrails.screenInput({
            correlationId: `case-saturating-${name}` as CorrelationId,
            tier: "low",
            payload: stall(2_000),
          }),
        ),
      );
      for (const screening of screenings) {
        expect(screening.recommended.recommend).toBe("abstain");
      }
      expect(pool.stats().saturated).toBeGreaterThanOrEqual(2);
    } finally {
      await pool.close();
    }
  }, 30_000);

  it("fails closed once closed, and closing twice is not an error", async () => {
    const pool = poolOf();
    const h = harness({
      detectorSets: sameAtEveryTier(setOf("closed", [packOf(pool)])),
      clock: wallClock(),
    });
    await pool.close();
    await pool.close();

    const screening = await h.guardrails.screenInput({
      correlationId: CASE_A,
      tier: "low",
      payload: { narrative: "anything at all" },
    });
    expect(screening.recommended.recommend).toBe("abstain");
    expect(screening.recommended).toMatchObject({
      grounds: [{ ground: "detector-unavailable", reason: "declared" }],
    });
  }, 30_000);

  it("recycles a worker after its task ceiling, so no heap holds caller text for long", async () => {
    const pool = poolOf({ maxWorkers: 1, maxTasksPerWorker: 2, maxQueued: 8 });
    try {
      const h = harness({
        detectorSets: sameAtEveryTier(setOf("recycling", [packOf(pool)])),
        clock: wallClock(),
      });
      for (let i = 0; i < 5; i += 1) {
        await h.guardrails.screenInput({
          correlationId: CASE_A,
          tier: "low",
          payload: { narrative: `ordinary ${String(i)}` },
        });
      }
      // Five tasks, two per worker: at least two retirements.
      expect(pool.stats().retired).toBeGreaterThanOrEqual(2);
      expect(pool.stats().completed).toBe(5);
    } finally {
      await pool.close();
    }
  }, 30_000);
});

describe("wiring mistakes are boot failures, as everywhere else in this module", () => {
  it("refuses a pattern the analyser refuses, even behind a worker", async () => {
    const pool = poolOf();
    try {
      // A worker bounds the cost of a catastrophic pattern. It does not make one
      // acceptable — the brand is defeated by a cast and this is what stops it.
      expect(() =>
        preemptiveDetector({
          pool,
          id: "pii.unsafe",
          locales: ["en-GB"] as unknown as NonEmpty<string>,
          searches: "an unsafe pattern",
          category: "personal-data",
          severity: "redact",
          patterns: [
            { ...PATHOLOGICAL(), match: /(a+)+$/ } as unknown as ReturnType<typeof PATHOLOGICAL>,
          ],
        }),
      ).toThrow(/catastrophic/);
    } finally {
      await pool.close();
    }
  });
});
