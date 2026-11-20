/**
 * resume.mjs — the missions-harness milestone-level resume rule (B4).
 *
 * On kill + re-invoke, the mission must resume from `mission-state.json` WITHOUT
 * redoing passed work. The Workflow tool's `resumeFromRunId` caches agent
 * RESULTS; this rule decides, at the MILESTONE level, where to pick up: the first
 * milestone not yet `done`, plus the milestones/assertions already complete so
 * they are skipped (not re-validated). Single source of truth; `node --test`-guarded
 * by `resume.test.mjs`.
 *
 * Pure: no I/O. Reads only the provided mission-state object.
 *
 * @typedef {Object} ResumePlan
 * @property {string|null} nextMilestoneId      first non-`done` milestone (by order), or null
 * @property {string[]}    doneMilestoneIds     completed milestones
 * @property {string[]}    remainingMilestoneIds milestones still to run
 * @property {boolean}     allDone              true when every milestone is done
 * @property {string[]}    skipAssertions       bound assertions of done milestones (already passing)
 * @property {boolean}     degraded             true when any milestone lacked order/status and a fallback was used
 */

/**
 * `id` is REQUIRED (it is the milestone identity — there is no safe fallback).
 * `order` and `status` are now schema-required (architecture.md) for new missions,
 * but older mission-states predate that (e.g. fee-schedule has neither,
 * kyc-onboarding has no order). Rather than THROW on those — which made
 * resume impossible for two real missions (retro 2026-06-14 C-01) — degrade
 * gracefully: missing `order` → declaration index; missing `status` → "pending"
 * (not-done, the conservative choice — a milestone is re-picked, never silently
 * skipped). `degraded:true` signals the fallback fired so the orchestrator logs it.
 * @param {{milestones: Array<{id:string, order?:number, status?:string, assertions?:string[]}>}} missionState
 */
export function resumePlan(missionState) {
  if (!missionState || typeof missionState !== "object")
    throw new TypeError("missionState must be an object")
  const milestones = missionState.milestones
  if (!Array.isArray(milestones)) throw new TypeError("missionState.milestones must be an array")

  let degraded = false
  const normalized = milestones.map((m, index) => {
    if (!m || typeof m.id !== "string") throw new TypeError("each milestone needs a string id")
    const order = typeof m.order === "number" ? m.order : (degraded = true, index)
    const status = typeof m.status === "string" ? m.status : (degraded = true, "pending")
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
