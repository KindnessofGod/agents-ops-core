/**
 * Severity that means something, and means it **in the type**.
 *
 * `docs/CONTEXT.md`: *"A missed heartbeat is the highest-severity alert in the
 * system, above any individual case failure. One stalled case is one customer;
 * a stopped sweeper is every waiting case at once, and nobody finds out until
 * somebody telephones."*
 *
 * That sentence is the requirement. A comment saying "keep liveness-lost at the
 * top" is not an implementation of it — comments do not fail builds. So the
 * ordering is a tuple, the ranks are derived from it, the severity of an alert
 * is derived from its condition rather than chosen by the caller, and
 * `LivenessOutranksEveryCaseAlert` below is a compile-time proof that the
 * ordering holds. Reorder the tuple so that a per-case severity outranks
 * `liveness-lost` and this file stops compiling.
 */

/**
 * Ascending. Position **is** rank; there is no second place where the order is
 * written down and could drift.
 */
export const SEVERITY_ORDER = ["notice", "degraded", "incident", "liveness-lost"] as const;

/**
 * What an operator is being told, in four steps.
 *
 *   `notice`        Something moved. Nothing is broken. Look at it in the
 *                   morning; a population statistic is not a page.
 *   `degraded`      The machinery is not doing what it promised for some cases.
 *                   Hours, not days.
 *   `incident`      A guarantee this library exists to hold has already failed
 *                   for a named case — a legal breach, a possibly-doubled
 *                   payment, evidence that is not there. Now.
 *   `liveness-lost` A component that guards *every* waiting case is not running.
 *                   Above all of the above, by construction.
 */
export type AlertSeverity = (typeof SEVERITY_ORDER)[number];

/** The severity reserved to a component that has stopped proving it is alive. */
export type LivenessSeverity = "liveness-lost";

/** Everything that is about one case, one effect, or one population. */
export type CaseSeverity = Exclude<AlertSeverity, LivenessSeverity>;

/**
 * Ranks, total over `AlertSeverity` by `satisfies` — adding a severity to the
 * tuple without ranking it is a compile error here.
 */
export const SEVERITY_RANK = {
  notice: 0,
  degraded: 1,
  incident: 2,
  "liveness-lost": 3,
} as const satisfies Record<AlertSeverity, number>;

/** The rank of a severity, at the type level. */
export type SeverityRank<S extends AlertSeverity> = (typeof SEVERITY_RANK)[S];

// --- the proof ---------------------------------------------------------------
//
// Type-level arithmetic on four small literals. Verbose, and worth it: this is
// the difference between a documented ordering and an enforced one.

type CountTo<N extends number, A extends readonly unknown[] = []> = A["length"] extends N
  ? A
  : CountTo<N, [...A, unknown]>;

type LessThan<A extends number, B extends number> = CountTo<B> extends readonly [
  ...CountTo<A>,
  unknown,
  ...unknown[],
]
  ? true
  : false;

/** Fails to instantiate unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/** Distributes: one `LessThan` check per member of `CaseSeverity`. */
type OutrankedByLiveness<S> = S extends CaseSeverity
  ? LessThan<SeverityRank<S>, SeverityRank<LivenessSeverity>>
  : never;

/**
 * **The load-bearing line of this file.** If any per-case severity ever ranked
 * at or above `liveness-lost`, the distributed union above would include `false`
 * and widen to `boolean`, which does not satisfy `Assert`. Nothing needs to
 * remember to check this; it is checked on every `tsc --build`.
 */
export type LivenessOutranksEveryCaseAlert = Assert<OutrankedByLiveness<CaseSeverity>>;

// --- runtime -----------------------------------------------------------------

/** Numeric rank, for a sink that has to sort or threshold. */
export const severityRank = (severity: AlertSeverity): number => SEVERITY_RANK[severity];

/** Negative if `a` is less severe than `b`, zero if equal, positive if greater. */
export const compareSeverity = (a: AlertSeverity, b: AlertSeverity): number =>
  SEVERITY_RANK[a] - SEVERITY_RANK[b];

/** The more severe of two. */
export const maxSeverity = (a: AlertSeverity, b: AlertSeverity): AlertSeverity =>
  compareSeverity(a, b) >= 0 ? a : b;

/** True only for the severity a per-case condition can never carry. */
export const isLivenessSeverity = (severity: AlertSeverity): severity is LivenessSeverity =>
  severity === "liveness-lost";

/** `true` when `severity` is at or above `floor`. */
export const atLeast = (severity: AlertSeverity, floor: AlertSeverity): boolean =>
  compareSeverity(severity, floor) >= 0;
