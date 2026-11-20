/**
 * self-heal.mjs — the missions-harness milestone-boundary decision rule.
 *
 * This is the SINGLE SOURCE OF TRUTH for what `mission-validate` does at a
 * milestone boundary (SKILL.md steps 4/5 + invariant 11). It was previously
 * only prose; extracting it here makes the decision deterministic and
 * regression-guarded (`self-heal.test.mjs`, run via `node --test`).
 *
 * Pure: no I/O, no Date.now, no randomness. Given the milestone's validation
 * outcome + how many corrective rounds it has already spent, it returns the
 * next action. Keep the mission-validate prose and this rule in agreement.
 */

/**
 * @typedef {Object} SelfHealState
 * @property {boolean} assertionsAllPassing  every bound assertion is `passing`
 * @property {number}  boundaryViolations    count of boundary violations (hard blocker)
 * @property {number}  missingDefaults       count of missing default assertions (hard blocker)
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
  } = state

  // Validate inputs so a malformed call fails loudly rather than silently
  // advancing on garbage (the kind of bug this whole module exists to prevent).
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

  // ADVANCE only when EVERYTHING is clean (mission-validate step 5): every
  // bound assertion passing, zero boundaryViolations, zero missingDefaults, AND
  // the integration gate green. boundaryViolations / missingDefaults are hard
  // blockers, not notes (invariants 9 + 8) — so they block advance even if the
  // assertion verdicts read otherwise.
  const clean =
    assertionsAllPassing &&
    boundaryViolations === 0 &&
    missingDefaults === 0 &&
    gateGreen
  if (clean) {
    return { action: "advance", reason: "all bound assertions passing, no boundary/default violations, integration gate green" }
  }

  // Not clean → self-heal (step 4). Under the cap, scope a corrective round.
  if (correctiveRounds < maxRounds) {
    return {
      action: "corrective",
      reason: `milestone not clean (round ${correctiveRounds} of ${maxRounds}); scope a follow-up targeting the failing assertions and re-validate`,
    }
  }

  // At/over the cap → circuit-break (invariant 11): never a third round. Commit
  // the stuck state to a debug branch, set missionStatus halted, flag the human.
  return {
    action: "circuit-break",
    reason: `corrective rounds exhausted (${correctiveRounds} >= ${maxRounds}); checkpoint to debug/<feature>-<milestone>-stuck, set missionStatus halted, escalate to the human with the failing-verdict + gate evidence`,
  }
}

export default decideSelfHeal
