/**
 * self-heal.mjs — the milestone-boundary decision rule.
 *
 * This is the SINGLE SOURCE OF TRUTH for what the orchestrator does when a
 * milestone finishes validating. The prose in `prompts/orchestrator/validate.md`
 * says WHEN to call it; this module decides WHAT happens, deterministically.
 *
 * Why it is a module and not a paragraph: "advance / try again / stop and ask a
 * human" is the single most consequential branch in the whole harness, and a
 * model asked to re-derive it under context pressure will eventually rationalise
 * a third corrective round. A tested rule cannot.
 *
 * Pure: no I/O, no Date.now, no randomness.
 *
 * @typedef {Object} SelfHealState
 * @property {boolean} assertionsAllPassing  every bound assertion is `passing`
 * @property {number}  boundaryViolations    count of out-of-area edits (hard blocker)
 * @property {number}  missingDefaults       count of unmet default assertions (hard blocker)
 * @property {boolean} gateGreen             the deterministic integration gate passed
 * @property {number}  correctiveRounds      rounds already spent on THIS milestone
 * @property {number}  [maxRounds=2]         circuit-breaker cap
 *
 * @typedef {Object} SelfHealDecision
 * @property {"advance"|"corrective"|"circuit-break"} action
 * @property {string} reason
 */

/**
 * Decide the milestone-boundary action.
 * @param {SelfHealState} state
 * @returns {SelfHealDecision}
 */
export function decideSelfHeal(state) {
  const {
    assertionsAllPassing,
    boundaryViolations,
    missingDefaults,
    gateGreen,
    correctiveRounds,
    maxRounds = 2,
  } = state ?? {}

  // Validate inputs so a malformed call fails loudly rather than silently
  // advancing on garbage — the exact bug class this module exists to prevent.
  if (typeof assertionsAllPassing !== "boolean")
    throw new TypeError("assertionsAllPassing must be boolean")
  if (typeof gateGreen !== "boolean") throw new TypeError("gateGreen must be boolean")
  if (!Number.isInteger(boundaryViolations) || boundaryViolations < 0)
    throw new TypeError("boundaryViolations must be a non-negative integer")
  if (!Number.isInteger(missingDefaults) || missingDefaults < 0)
    throw new TypeError("missingDefaults must be a non-negative integer")
  if (!Number.isInteger(correctiveRounds) || correctiveRounds < 0)
    throw new TypeError("correctiveRounds must be a non-negative integer")
  if (!Number.isInteger(maxRounds) || maxRounds < 1)
    throw new TypeError("maxRounds must be a positive integer")

  // ADVANCE only when EVERYTHING is clean: every bound assertion passing, zero
  // boundary violations, zero missing defaults, AND the integration gate green.
  // Boundary violations and missing defaults are HARD blockers, not notes — they
  // block even if the assertion verdicts read otherwise.
  const clean =
    assertionsAllPassing && boundaryViolations === 0 && missingDefaults === 0 && gateGreen
  if (clean) {
    return {
      action: "advance",
      reason:
        "all bound assertions passing, no boundary/default violations, integration gate green",
    }
  }

  // Not clean → self-heal. Under the cap, scope a corrective round.
  if (correctiveRounds < maxRounds) {
    return {
      action: "corrective",
      reason: `milestone not clean (round ${correctiveRounds} of ${maxRounds}); scope a follow-up targeting the failing assertions and re-validate`,
    }
  }

  // At/over the cap → circuit-break. Never a third round: a milestone that fails
  // validation twice is stuck (agents arguing, or blindly re-editing the same
  // file to force green), and a third try reliably just burns tokens.
  return {
    action: "circuit-break",
    reason: `corrective rounds exhausted (${correctiveRounds} >= ${maxRounds}); checkpoint to a debug branch, set missionStatus halted, escalate to the human with the failing-verdict + gate evidence`,
  }
}

export default decideSelfHeal
