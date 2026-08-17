/**
 * resume.mjs — the milestone-level resume rule.
 *
 * A mission survives being killed. On re-invoke it must pick up without redoing
 * passed work. This rule answers the MILESTONE-level question: where do we start
 * again, and which assertions are already settled so they are SKIPPED rather than
 * re-validated?
 *
 * Pure: no I/O. Reads only the provided mission-state object.
 *
 * @typedef {Object} ResumePlan
 * @property {string|null} nextMilestoneId       first non-`done` milestone (by order), or null
 * @property {string[]}    doneMilestoneIds      completed milestones
 * @property {string[]}    remainingMilestoneIds milestones still to run
 * @property {boolean}     allDone               true when every milestone is done
 * @property {string[]}    skipAssertions        bound assertions of done milestones
 * @property {boolean}     degraded              a milestone lacked order/status and a fallback was used
 */

/**
 * `id` is REQUIRED — it is the milestone identity and there is no safe fallback.
 *
 * `order` and `status` are schema-required for new missions, but hand-authored or
 * older state files miss them. Rather than THROW (which makes resume impossible
 * for exactly the mission that most needs it), degrade gracefully: missing
 * `order` → declaration index; missing `status` → "pending", i.e. NOT done. The
 * conservative direction matters: a milestone is re-picked, never silently
 * skipped. `degraded: true` signals the fallback fired so the orchestrator logs it.
 *
 * @param {{milestones: Array<{id:string, order?:number, status?:string, assertions?:string[]}>}} missionState
 * @returns {ResumePlan}
 */
export function resumePlan(missionState) {
  if (!missionState || typeof missionState !== "object")
    throw new TypeError("missionState must be an object")
  const milestones = missionState.milestones
  if (!Array.isArray(milestones)) throw new TypeError("missionState.milestones must be an array")

  let degraded = false
  const normalized = milestones.map((m, index) => {
    if (!m || typeof m.id !== "string") throw new TypeError("each milestone needs a string id")
    const order = typeof m.order === "number" ? m.order : ((degraded = true), index)
    const status = typeof m.status === "string" ? m.status : ((degraded = true), "pending")
    return { ...m, order, status, _index: index }
  })

  // Sort by effective order, with declaration index as a stable tiebreaker so a
  // mix of explicit-order and index-fallback milestones stays deterministic.
  const ordered = normalized.sort((a, b) => a.order - b.order || a._index - b._index)
  const doneMilestoneIds = []
  const remainingMilestoneIds = []
  const skipAssertions = new Set()

  for (const m of ordered) {
    if (m.status === "done") {
      doneMilestoneIds.push(m.id)
      for (const a of m.assertions ?? []) skipAssertions.add(a)
    } else {
      remainingMilestoneIds.push(m.id)
    }
  }

  return {
    nextMilestoneId: remainingMilestoneIds[0] ?? null,
    doneMilestoneIds,
    remainingMilestoneIds,
    allDone: remainingMilestoneIds.length === 0,
    skipAssertions: [...skipAssertions],
    degraded,
  }
}

export default resumePlan
