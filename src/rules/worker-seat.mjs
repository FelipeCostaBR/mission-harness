/**
 * worker-seat.mjs — the corrective-round model escalation rule.
 *
 * Feature workers run on the mid tier by default, because most features are
 * ordinary and the frontier tier is expensive. When a milestone comes back dirty,
 * `self-heal.mjs` scopes a CORRECTIVE round (up to the cap, then it hands off to
 * a human). This rule decides WHICH MODEL TIER that round's worker runs on:
 * keep the cheap seat for the first attempt, then escalate to the frontier tier
 * for the FINAL corrective round before the circuit breaker would give up.
 *
 * The bet is narrow and deliberate: spend the expensive seat only on the small
 * fraction of features the cheap seat is visibly struggling with, converting some
 * would-be human escalations into automatic recoveries. Escalating on round one
 * would spend frontier tokens on every transient miss; escalating never means the
 * breaker trips on problems a stronger model would have solved.
 *
 * It hangs off the exact signal `self-heal.mjs` already reads
 * (`correctiveRounds`), so the two rules stay in lockstep: self-heal decides
 * WHETHER to spend another round, this decides HOW STRONG the seat for that round
 * is. It never changes the round count, the cap, or the advance/break decision.
 *
 * Tiers are ABSTRACT ("economy" / "standard" / "frontier") and resolve to real
 * model ids through `models` in contractor.config.json, so the ladder is the same
 * whichever provider you run.
 *
 * Pure: no I/O, no Date.now, no randomness.
 */

/** Cheapest → strongest. Tiers resolve to concrete model ids via the config. */
export const SEAT_LADDER = ["economy", "standard", "frontier"]

/**
 * @typedef {Object} SeatState
 * @property {number}  correctiveRounds         rounds already spent on THIS milestone
 * @property {string}  [baseSeat="standard"]    the default worker tier
 * @property {number}  [escalateAfterRounds=1]  escalate once this many rounds have ALREADY failed
 * @property {string}  [maxSeat="frontier"]     never escalate above this tier
 * @property {string[]}[ladder]                 cheap→strong order (defaults to SEAT_LADDER)
 *
 * @typedef {Object} SeatDecision
 * @property {string}  seat       the tier to run this round's worker on
 * @property {boolean} escalated  true iff seat is stronger than baseSeat
 * @property {string}  reason     human-readable justification (for the round log)
 */

/**
 * Decide the worker model tier for a (corrective) round.
 * @param {SeatState} state
 * @returns {SeatDecision}
 */
export function resolveWorkerSeat(state) {
  const {
    correctiveRounds,
    baseSeat = "standard",
    escalateAfterRounds = 1,
    maxSeat = "frontier",
    ladder = SEAT_LADDER,
  } = state ?? {}

  // Fail loud on garbage — never silently pick a seat from a malformed call.
  if (!Array.isArray(ladder) || ladder.length === 0)
    throw new TypeError("ladder must be a non-empty array")
  if (!Number.isInteger(correctiveRounds) || correctiveRounds < 0)
    throw new TypeError("correctiveRounds must be a non-negative integer")
  if (!Number.isInteger(escalateAfterRounds) || escalateAfterRounds < 0)
    throw new TypeError("escalateAfterRounds must be a non-negative integer")

  const baseIdx = ladder.indexOf(baseSeat)
  if (baseIdx < 0) throw new TypeError(`baseSeat "${baseSeat}" is not on the ladder [${ladder}]`)
  const capIdx = ladder.indexOf(maxSeat)
  if (capIdx < 0) throw new TypeError(`maxSeat "${maxSeat}" is not on the ladder [${ladder}]`)
  if (capIdx < baseIdx)
    throw new TypeError(`maxSeat "${maxSeat}" is weaker than baseSeat "${baseSeat}"`)

  // Below the threshold → the cheap seat still gets this round. The initial build
  // is round 0, so escalateAfterRounds=1 gives the base seat the initial build
  // plus the first corrective round, before the frontier seat takes the last.
  if (correctiveRounds < escalateAfterRounds) {
    return {
      seat: baseSeat,
      escalated: false,
      reason: `correctiveRounds ${correctiveRounds} < escalateAfterRounds ${escalateAfterRounds}: keep base seat "${baseSeat}"`,
    }
  }

  // At/over the threshold → step up one tier per extra failed round, capped.
  const steps = correctiveRounds - escalateAfterRounds + 1
  const targetIdx = Math.min(baseIdx + steps, capIdx)
  const seat = ladder[targetIdx]
  const escalated = targetIdx > baseIdx
  return {
    seat,
    escalated,
    reason: escalated
      ? `correctiveRounds ${correctiveRounds} >= escalateAfterRounds ${escalateAfterRounds}: escalate "${baseSeat}" → "${seat}" (final attempts before circuit-break)`
      : `at threshold but "${baseSeat}" is already the cap "${maxSeat}": no escalation possible`,
  }
}

export default resolveWorkerSeat
