import type { Subject, SubjectSpec } from "./types.js";

/**
 * The only constructor of a `Subject`.
 *
 * `Subject` is opaque — its brand is a non-exported `unique symbol` declared in
 * `types.ts` — so `run` cannot be handed a stand-in assembled from an object
 * literal. That matters less than what the spec **does not contain**: there is
 * no `deps` field, no recorder, no store, no clock and no model client on a
 * `SubjectSpec`. The subject is the thing being measured, and the thing being
 * measured does not supply its own witness, its own clock or its own network.
 *
 * Everything the subject can do arrives through the `DecisionContext` the runner
 * derives from the recorder: a node handle, a node-bound read-only client, the
 * injected clock and an abort signal. A subject that never calls `child()` still
 * emits a complete graph, having written zero recording code.
 *
 * `purity` is the declaration that makes `UnattributedDecision` detectable. See
 * `Purity` in `types.ts`: a decision subtree with no recorded model call is
 * either a genuine rules engine or a subject that thought somewhere this module
 * cannot see, and those must not share a representation.
 */
export const defineSubject = (spec: SubjectSpec): Subject =>
  ({
    version: spec.version,
    purity: spec.purity,
    decide: spec.decide,
  }) as Subject;
