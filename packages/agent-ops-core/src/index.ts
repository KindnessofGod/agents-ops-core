// agent-ops-core — public entry point.
//
// Four modules survived interface review: audit, approval, evals, guardrails.
// See docs/design/PHASE-2-INTERFACE-REVIEW.md for why three of the original
// seven were cut, and docs/design/design-it-twice/FINDINGS.md for the interface each
// took.
//
// A fifth, `alerts`, was added afterwards and did not come from that review. It
// came from a question — *are the right engineers notified on failure, long
// before a client or an employee makes contact?* — whose honest answer was no.
// See docs/design/OPEN-ITEMS-RESOLVED.md item 6. It is a module by the same
// tests as the other four: deleting it does not make complexity vanish, it makes
// nineteen applications each invent a severity model and a paging integration.
//
// Each module is exported as a namespace here, and each also has its own
// subpath: `agent-ops-core/audit`, `/approval`, `/evals`, `/guardrails`,
// `/alerts`. The subpaths are the preferred import — a caller who needs approval
// should learn approval's interface and nothing else, which is the whole point
// of keeping these modules deep and separate.
//
// The dependency direction between them is one-way and worth stating here,
// because it is the thing a composition root gets wrong first: the four
// detecting modules take an optional `alerting` parameter and call
// `alerts.raiseAndRecord` at the sites where they can see a silent condition.
// `alerts` imports none of them. Wiring is done at the composition root, by
// constructing one `Alerts` and passing it to all four.
//
// Namespacing is not cosmetic. Four of the five export `DEFAULT_LIMITS`, and
// each means something different: the ceiling on a payload's canonical bytes,
// the bound on concurrent runs, the cap on recorded field characters, the
// suppression window on a flapping alert. Flattening them into one surface
// would silently resolve one caller's limit to another module's number, which
// is exactly the kind of collision a wide interface inflicts on nineteen
// applications at once. The collisions are real and they are not only
// `DEFAULT_LIMITS`: `AuthorityPoolId`, `CorrelationId`, `RiskTier`, `Clock` and
// `SqlExecutor` are each declared in more than one module.

export * as audit from "./audit/index.js";
export * as approval from "./approval/index.js";
export * as evals from "./evals/index.js";
export * as guardrails from "./guardrails/index.js";
export * as alerts from "./alerts/index.js";
