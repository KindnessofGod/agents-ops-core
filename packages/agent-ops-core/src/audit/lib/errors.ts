/**
 * Named error modes. Every one states its fail policy and the reason for it,
 * because a reader who learns one module's policy will assume the others match
 * and they deliberately do not.
 */

/**
 * Replay was asked for a correlation identifier the store has never seen.
 *
 * Fail-closed: this throws rather than returning an empty case. An empty trace
 * and a missing trace mean very different things to an auditor, and a silent
 * empty result would let "we have no record" masquerade as "nothing happened".
 */
export class NoSuchCase extends Error {
  override readonly name = "NoSuchCase";
  constructor(readonly correlationId: string) {
    super(`no such case: ${correlationId}`);
  }
}

/**
 * A node was recorded against a closed case, or a case was closed twice.
 *
 * Fail-closed: close is terminal. Accepting a late node would put a decision
 * after the outcome that was supposed to summarise it, which makes the ordering
 * of the trace a lie.
 */
export class CaseAlreadyClosed extends Error {
  override readonly name = "CaseAlreadyClosed";
  constructor(readonly correlationId: string) {
    super(`case is already closed: ${correlationId}`);
  }
}
