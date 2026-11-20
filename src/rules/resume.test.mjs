/**
 * node:test for resume.mjs (the B4 milestone-level resume rule).
 * Run: node --test .claude/skills/run-prd-multi-agent-architecture/lib/resume.test.mjs
 * Covers RES-1.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { resumePlan } from "./resume.mjs"

const state = (milestones) => ({ milestones })

test("all pending -> next is the first by order, nothing skipped", () => {
  const p = resumePlan(state([
    { id: "M1", order: 1, status: "pending", assertions: ["A1"] },
    { id: "M2", order: 2, status: "pending", assertions: ["B1"] },
  ]))
  assert.equal(p.nextMilestoneId, "M1")
  assert.deepEqual(p.doneMilestoneIds, [])
  assert.deepEqual(p.skipAssertions, [])
  assert.equal(p.allDone, false)
})

test("M1 done -> resume at M2, M1's assertions skipped (passed work not redone)", () => {
  const p = resumePlan(state([
    { id: "M1", order: 1, status: "done", assertions: ["A1", "A2"] },
    { id: "M2", order: 2, status: "pending", assertions: ["B1"] },
  ]))
  assert.equal(p.nextMilestoneId, "M2")
  assert.deepEqual(p.doneMilestoneIds, ["M1"])
  assert.deepEqual(p.remainingMilestoneIds, ["M2"])
  assert.deepEqual(p.skipAssertions.sort(), ["A1", "A2"])
  assert.equal(p.allDone, false)
})

test("all done -> allDone, next is null, all assertions skipped", () => {
  const p = resumePlan(state([
    { id: "M1", order: 1, status: "done", assertions: ["A1"] },
    { id: "M2", order: 2, status: "done", assertions: ["B1"] },
  ]))
  assert.equal(p.nextMilestoneId, null)
  assert.equal(p.allDone, true)
  assert.deepEqual(p.skipAssertions.sort(), ["A1", "B1"])
})

test("respects order, not array position", () => {
  const p = resumePlan(state([
    { id: "M2", order: 2, status: "pending", assertions: ["B1"] },
    { id: "M1", order: 1, status: "done", assertions: ["A1"] },
  ]))
  assert.equal(p.nextMilestoneId, "M2")
  assert.deepEqual(p.doneMilestoneIds, ["M1"])
})

test("a mid-mission done milestone after a pending one still resumes at the pending one", () => {
  const p = resumePlan(state([
    { id: "M1", order: 1, status: "done", assertions: ["A1"] },
    { id: "M2", order: 2, status: "pending", assertions: ["B1"] },
    { id: "M3", order: 3, status: "pending", assertions: ["C1"] },
  ]))
  assert.equal(p.nextMilestoneId, "M2")
  assert.deepEqual(p.remainingMilestoneIds, ["M2", "M3"])
})

test("milestone without assertions is tolerated", () => {
  const p = resumePlan(state([{ id: "M1", order: 1, status: "done" }]))
  assert.deepEqual(p.skipAssertions, [])
  assert.equal(p.allDone, true)
})

test("clean states are not flagged degraded", () => {
  const p = resumePlan(state([
    { id: "M1", order: 1, status: "done", assertions: ["A1"] },
    { id: "M2", order: 2, status: "pending", assertions: ["B1"] },
  ]))
  assert.equal(p.degraded, false)
})

test("throws only on truly malformed input (id is non-negotiable)", () => {
  assert.throws(() => resumePlan(null), TypeError)
  assert.throws(() => resumePlan({}), TypeError) // milestones not an array
  assert.throws(() => resumePlan(state([{ order: 1, status: "done" }])), TypeError) // no id
})

test("C-01: missing order degrades to declaration index (kyc-onboarding case)", () => {
  // has status, no order — must NOT throw; uses array order
  const p = resumePlan(state([
    { id: "M0", status: "done", assertions: ["A0"] },
    { id: "M1", status: "done", assertions: ["A1"] },
    { id: "M2", status: "pending", assertions: ["B1"] },
  ]))
  assert.equal(p.degraded, true)
  assert.equal(p.nextMilestoneId, "M2")
  assert.deepEqual(p.doneMilestoneIds, ["M0", "M1"])
})

test("C-01: missing status degrades to not-done (fee-schedule case)", () => {
  // neither order nor status — must NOT throw; every milestone is not-done -> resume at first
  const p = resumePlan(state([
    { id: "M0", assertions: ["A0"] },
    { id: "M1", assertions: ["A1"] },
  ]))
  assert.equal(p.degraded, true)
  assert.equal(p.nextMilestoneId, "M0")
  assert.deepEqual(p.remainingMilestoneIds, ["M0", "M1"])
  assert.equal(p.allDone, false)
})

test("mixed explicit-order + index fallback stays deterministic", () => {
  const p = resumePlan(state([
    { id: "Mb", status: "done", assertions: ["B"] },          // no order -> index 0
    { id: "Ma", order: 1, status: "pending", assertions: ["A"] }, // order 1
  ]))
  assert.equal(p.degraded, true)
  // Mb effective order 0 (index) < Ma order 1 -> Mb first, then Ma
  assert.equal(p.nextMilestoneId, "Ma")
  assert.deepEqual(p.doneMilestoneIds, ["Mb"])
})
