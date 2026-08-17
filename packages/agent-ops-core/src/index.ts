// agent-ops-core — public entry point.
//
// Four modules survive interface review: audit, approval, evals, guardrails.
// See docs/design/PHASE-2-INTERFACE-REVIEW.md for why three of the original
// seven were cut, and docs/design/FINDINGS.md for the interface each took.
//
// Each module is exported as a namespace here, and each also has its own
// subpath: `agent-ops-core/audit`, `/approval`, `/evals`, `/guardrails`.
// The subpaths are the preferred import — a caller who needs approval should
// learn approval's interface and nothing else, which is the whole point of
// keeping these modules deep and separate.
//
// Namespacing is not cosmetic. Three of the four export `DEFAULT_LIMITS`, and
// each means something different: the ceiling on a payload's canonical bytes,
// the bound on concurrent runs, the cap on recorded field characters. Flattening
// them into one surface would silently resolve one caller's limit to another
// module's number, which is exactly the kind of collision a wide interface
// inflicts on nineteen applications at once.

export * as audit from "./audit/index.js";
export * as approval from "./approval/index.js";
export * as evals from "./evals/index.js";
export * as guardrails from "./guardrails/index.js";
