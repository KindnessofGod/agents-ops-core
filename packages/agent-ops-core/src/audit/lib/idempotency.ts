import { canonicalPayloadForm } from "./canonical.js";
import { IdempotencyKeyConflict, IdempotencyKeyUnusable } from "./errors.js";
import type { AppendInput, CorrelationId, NodeTelemetry, RecordedNode } from "./types.js";
import { MAX_IDEMPOTENCY_KEY_CHARS } from "./types.js";

/**
 * The rules an idempotency key is held to, expressed **once** and driven by both
 * adapters.
 *
 * That is the whole reason this file exists rather than twelve lines in each
 * store. This module's oldest and most expensive defect has been two adapters
 * claiming one invariant and holding different ones — a parent from another case
 * orphaned in memory and bricked a row in Postgres; a reserved kind produced
 * three seal nodes in one adapter and refused every subsequent write in the
 * other. Deduplication has exactly the same shape of risk and a worse
 * consequence: an adapter that deduplicates loosely loses a real event, and the
 * loss is invisible on replay because the node that would have shown it was
 * never written.
 *
 * So both adapters call the same two functions, and a divergence is a
 * compilation problem rather than a production one.
 */

/**
 * Non-empty, and bounded.
 *
 * Checked before the store is touched, at every tier, and again by a check
 * constraint in `migrations/0007_audit_idempotency.sql`. See
 * `IdempotencyKeyUnusable` for why an empty key is the dangerous half.
 */
export const assertUsableKey = (
  correlationId: CorrelationId,
  key: string | undefined,
): void => {
  if (key === undefined) return;
  if (typeof key !== "string" || key.length === 0) {
    throw new IdempotencyKeyUnusable(correlationId, "the key is empty");
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    throw new IdempotencyKeyUnusable(
      correlationId,
      `the key is ${key.length} characters, over the ${MAX_IDEMPOTENCY_KEY_CHARS}-character ceiling`,
    );
  }
};

const telemetryAgrees = (
  a: NodeTelemetry | undefined,
  b: NodeTelemetry | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.costTenthCents === b.costTenthCents &&
    a.tokensIn === b.tokensIn &&
    a.tokensOut === b.tokensOut &&
    a.latencyMicros === b.latencyMicros &&
    a.priceTableVersion === b.priceTableVersion
  );
};

/**
 * A key names **one** append. Prove that the append now being offered is that
 * same append before returning the node written for it.
 *
 * Everything describing *what happened* is compared — the redacted payload's
 * canonical bytes, the tier, the parent, the telemetry, the redactor. The clock
 * reading is deliberately not: a crash-retry is a later process and its clock
 * has moved, which is precisely the case this exists to serve.
 *
 * A disagreement raises `IdempotencyKeyConflict` rather than returning the
 * first node. Returning it would be the quiet failure: the caller's second
 * event would never have happened as far as the evidence is concerned, and
 * nothing anywhere would say so.
 */
export const assertSameAppend = (
  existing: RecordedNode,
  input: AppendInput,
  key: string,
): void => {
  const conflict = (field: string): never => {
    throw new IdempotencyKeyConflict(String(input.correlationId), key, field);
  };

  if (canonicalPayloadForm(existing.payload) !== canonicalPayloadForm(input.payload)) {
    conflict("payload");
  }
  if (existing.tier !== input.tier) conflict("tier");
  if (existing.parent !== input.parent) conflict("parent");
  if (String(existing.redaction) !== String(input.redaction)) conflict("redactor");
  if (!telemetryAgrees(existing.telemetry, input.telemetry)) conflict("telemetry");
};
