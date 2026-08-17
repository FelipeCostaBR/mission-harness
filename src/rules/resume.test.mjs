import test from "node:test"
import assert from "node:assert/strict"
import { resumePlan } from "./resume.mjs"

test("picks the first non-done milestone by order", () => {
  const plan = resumePlan({
    milestones: [
      { id: "M2", order: 2, status: "pending", assertions: ["A-2"] },
      { id: "M1", order: 1, status: "done", assertions: ["A-1"] },
      { id: "M3", order: 3, status: "pending", assertions: ["A-3"] },
    ],
  })
  assert.equal(plan.nextMilestoneId, "M2")
  assert.deepEqual(plan.doneMilestoneIds, ["M1"])
  assert.deepEqual(plan.remainingMilestoneIds, ["M2", "M3"])
  assert.deepEqual(plan.skipAssertions, ["A-1"])
  assert.equal(plan.allDone, false)
  assert.equal(plan.degraded, false)
})

test("reports allDone when every milestone is done", () => {
  const plan = resumePlan({
    milestones: [
      { id: "M1", order: 1, status: "done", assertions: ["A-1"] },
      { id: "M2", order: 2, status: "done", assertions: ["A-2"] },
    ],
  })
  assert.equal(plan.allDone, true)
  assert.equal(plan.nextMilestoneId, null)
  assert.deepEqual(plan.skipAssertions.sort(), ["A-1", "A-2"])
})

test("a non-done milestone out of order is still resumed, not skipped", () => {
  // A milestone that failed and was left pending behind a later done one must be
  // picked up again — the conservative direction.
  const plan = resumePlan({
    milestones: [
      { id: "M1", order: 1, status: "pending" },
      { id: "M2", order: 2, status: "done" },
    ],
  })
  assert.equal(plan.nextMilestoneId, "M1")
})

test("degrades on a missing order instead of throwing", () => {
  const plan = resumePlan({
    milestones: [
      { id: "M1", status: "done" },
      { id: "M2", status: "pending" },
    ],
  })
  assert.equal(plan.degraded, true)
  assert.equal(plan.nextMilestoneId, "M2")
})

test("a missing status counts as NOT done", () => {
  // Silently treating an unknown status as done would skip real work.
  const plan = resumePlan({ milestones: [{ id: "M1", order: 1 }] })
  assert.equal(plan.degraded, true)
  assert.equal(plan.nextMilestoneId, "M1")
  assert.deepEqual(plan.doneMilestoneIds, [])
})

test("throws on structurally unusable state", () => {
  assert.throws(() => resumePlan(null), TypeError)
  assert.throws(() => resumePlan({}), TypeError)
  assert.throws(() => resumePlan({ milestones: [{ order: 1 }] }), TypeError)
})
