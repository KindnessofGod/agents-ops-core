/**
 * The adapters at the `AlertSink` seam, and the assertion that says a chain of
 * them is fit for production.
 *
 * Two are real, in the sense `docs/design/OPEN-ITEMS-RESOLVED.md` item 6 names:
 * *"an on-call paging service, and a structured operational stream for the
 * lower-severity conditions."* They have genuinely different bodies, genuinely
 * different urgency, and genuinely different audiences — which is what makes
 * this a seam and not a socket with one plug.
 *
 * The third, `recordingAlertSink`, is a deliverable in exactly the sense
 * `inMemoryTraceStore` is: it is what makes a hermetic test structural rather
 * than conventional. It is also the one thing that must never be wired in
 * production, and `assertProductionAlerting` refuses it by name.
 */

import { asAlertSink, type AlertSink, type OperationalStream, type PageTransport } from "./types.js";
import type { Alert, SinkAck } from "./types.js";
import { AlertingMisconfigured } from "./errors.js";
import { SEVERITY_ORDER, severityRank, type AlertSeverity } from "./severity.js";
import type { AlertSinkId, NonEmpty, OperatorRotaId } from "./primitives.js";

/** Severities a sink takes, defaulting to all four. */
const acceptsOrAll = (accepts: NonEmpty<AlertSeverity> | undefined): NonEmpty<AlertSeverity> =>
  accepts ?? SEVERITY_ORDER;

const ackFor = (alert: Alert, accepts: NonEmpty<AlertSeverity>): SinkAck =>
  accepts.includes(alert.severity)
    ? { accepted: true }
    : { accepted: false, why: "severity-not-accepted" };

/**
 * Adapter 1 — the on-call pager.
 *
 * **No HTTP client is constructed here and no URL, token or routing key is read
 * from the environment.** The transport is a constructor parameter, which is
 * what makes it impossible for a test to reach a real pager even with real
 * credentials present: there is no code path from this package to a network to
 * be disabled, so nothing has to be remembered and no flag has to be trusted.
 * A `SKIP_PAGING` environment variable would be a promise; this is a fact about
 * the call graph.
 *
 * Bounded by construction: one `send` per alert, no internal retry, no internal
 * queue. The ordered chain in `createAlerts` is the redundancy, and the caller's
 * `deliveryTimeoutMs` is the bound on a transport that hangs.
 *
 * `idempotencyKey` is stable per alert, so a transport with at-least-once
 * delivery does not wake the same person twice for one condition.
 */
export const pagingAlertSink = (config: {
  readonly id: AlertSinkId;
  /** Who is woken. Deliberately an operator rota, never an `AuthorityRef`. */
  readonly rota: OperatorRotaId;
  readonly transport: PageTransport;
  /**
   * Which severities are worth waking someone for. Default: `incident` and
   * above, so a population statistic never pages — the routine-volume rule from
   * `docs/CONTEXT.md`, applied inside the alert channel itself.
   */
  readonly accepts?: NonEmpty<AlertSeverity>;
}): AlertSink => {
  const accepts = config.accepts ?? (["incident", "liveness-lost"] as const);
  return asAlertSink({
    id: config.id,
    delivery: "page",
    accepts,
    async deliver(alert) {
      const ack = ackFor(alert, accepts);
      if (!ack.accepted) return ack;
      await config.transport.send({
        sink: config.id,
        rota: config.rota,
        severity: alert.severity,
        severityRank: severityRank(alert.severity),
        condition: alert.condition.kind,
        fingerprint: alert.fingerprint,
        correlationId: alert.correlationId,
        at: alert.at,
        suppressedSinceLastDelivery: alert.suppressedSinceLastDelivery,
        idempotencyKey: `${alert.fingerprint}#${alert.sequence}`,
        detail: alert.payload,
      });
      return { accepted: true };
    },
  });
};

/**
 * Adapter 2 — the structured operational stream.
 *
 * The lower-severity channel, and the fallback when the pager is down. One flat
 * record per alert: greppable now, parseable in 2033, and carrying the same
 * payload the pager got so the two agree when they are read side by side.
 *
 * Like the pager, it constructs nothing. `OperationalStream` is a parameter, so
 * this adapter cannot open a file, a socket or a log shipper of its own.
 *
 * `write` may be synchronous; it is awaited either way, so a stream that returns
 * a promise is bounded by the same delivery deadline as everything else.
 */
export const operationalStreamAlertSink = (config: {
  readonly id: AlertSinkId;
  readonly stream: OperationalStream;
  /** Default: everything. This is the channel of last resort in most chains. */
  readonly accepts?: NonEmpty<AlertSeverity>;
}): AlertSink => {
  const accepts = acceptsOrAll(config.accepts);
  return asAlertSink({
    id: config.id,
    delivery: "operational-stream",
    accepts,
    async deliver(alert) {
      const ack = ackFor(alert, accepts);
      if (!ack.accepted) return ack;
      await config.stream.write({
        stream: "agent-ops-core.alerts",
        sink: config.id,
        severity: alert.severity,
        severityRank: severityRank(alert.severity),
        condition: alert.condition.kind,
        fingerprint: alert.fingerprint,
        correlationId: alert.correlationId,
        at: alert.at,
        sequence: alert.sequence,
        suppressedSinceLastDelivery: alert.suppressedSinceLastDelivery,
        detail: alert.payload,
      });
      return { accepted: true };
    },
  });
};

/** What a recording sink kept. Bounded by `capacity`; drops are counted. */
export interface RecordingAlertSink extends AlertSink {
  readonly delivered: readonly Alert[];
  readonly dropped: number;
  clear(): void;
}

/**
 * Adapter 3 — the in-memory recorder.
 *
 * A deliverable, not a mock: it is what lets a test assert on the exact alert
 * that would have been delivered without any adapter anywhere being able to
 * reach a pager. Its `delivery` is `"in-memory"`, which is the property
 * `assertProductionAlerting` refuses — a chain that only records is a chain that
 * pages nobody, forever, and it passes every test in this repository.
 *
 * Bounded like everything else: `capacity` rows, oldest dropped, drops counted.
 * A test that leaks alerts should fail on an assertion, not on memory.
 */
export const recordingAlertSink = (config?: {
  readonly id?: AlertSinkId;
  readonly accepts?: NonEmpty<AlertSeverity>;
  readonly capacity?: number;
}): RecordingAlertSink => {
  const accepts = acceptsOrAll(config?.accepts);
  const capacity = config?.capacity ?? 1024;
  const kept: Alert[] = [];
  let dropped = 0;
  // Built as one object with real getters, then branded once. `Object.assign`
  // would copy the getters' current VALUES and hand every test a snapshot taken
  // before the first alert — a fixture that silently always passes.
  const impl = {
    id: config?.id ?? ("sink_recording" as AlertSinkId),
    delivery: "in-memory" as const,
    accepts,
    deliver(alert: Alert): Promise<SinkAck> {
      const ack = ackFor(alert, accepts);
      if (!ack.accepted) return Promise.resolve(ack);
      kept.push(alert);
      while (kept.length > capacity) {
        kept.shift();
        dropped += 1;
      }
      return Promise.resolve({ accepted: true });
    },
    get delivered(): readonly Alert[] {
      return kept;
    },
    get dropped(): number {
      return dropped;
    },
    clear(): void {
      kept.length = 0;
      dropped = 0;
    },
  };
  return asAlertSink(impl) as RecordingAlertSink;
};

/**
 * **Call this at the composition root.** It is the assertion that the wiring is
 * real, and it is deliberately a call rather than a check inside `raise`.
 *
 * `docs/design/OPEN-ITEMS-RESOLVED.md` item 6 asks for exactly this: the alert
 * path is injected so a test cannot page a real engineer, and *because* it is
 * injected, production must assert what it wired rather than assume it. Four
 * things are checked, and each corresponds to a way a plausible-looking chain
 * reaches nobody:
 *
 *   1. **No in-memory sink.** A recording sink in production is silence that
 *      looks like health.
 *   2. **Every severity is covered by some sink.** A chain of one pager that
 *      accepts only `incident` and above discards every `notice` and every
 *      `degraded` — and reports `declined-by-every-sink`, during an incident,
 *      which is far too late to learn it.
 *   3. **At least one sink pages.** A missed heartbeat is every waiting case at
 *      once; a chain that can only write to a stream has nobody reading it at
 *      3am. This is the check that makes the severity ordering mean something
 *      operationally rather than only in the type.
 *   4. **Sink identifiers are distinct.** A degradation names the sink that
 *      failed; two sinks sharing a name make that record ambiguous, and an
 *      ambiguous record of which channel is down is not evidence.
 *
 * Throws `AlertingMisconfigured`. It does not warn, and it does not return a
 * boolean somebody can ignore.
 */
export const assertProductionAlerting = (sinks: NonEmpty<AlertSink>): void => {
  const testSinks = sinks.filter((s) => s.delivery === "in-memory").map((s) => s.id);
  if (testSinks.length > 0) {
    throw new AlertingMisconfigured(
      "test-sink-in-production-chain",
      "an in-memory sink records alerts and delivers none; it is a test deliverable",
      undefined,
      testSinks,
    );
  }

  const ids = sinks.map((s) => s.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new AlertingMisconfigured(
      "duplicate-sink-id",
      "a degradation must be able to name which sink failed",
      undefined,
      [...new Set(duplicates)],
    );
  }

  const uncovered = SEVERITY_ORDER.filter(
    (severity) => !sinks.some((s) => s.accepts.includes(severity)),
  );
  if (uncovered.length > 0) {
    throw new AlertingMisconfigured(
      "severity-uncovered",
      `no sink accepts ${uncovered.join(", ")}; those alerts would reach nobody`,
      uncovered,
      ids,
    );
  }

  const pagers = sinks.filter((s) => s.delivery === "page" && s.accepts.includes("liveness-lost"));
  if (pagers.length === 0) {
    throw new AlertingMisconfigured(
      "no-paging-sink",
      "a missed heartbeat is every waiting case at once and must wake a human; no sink in this chain pages at liveness-lost",
      ["liveness-lost"],
      ids,
    );
  }
};
