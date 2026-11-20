import { test } from "node:test"
import assert from "node:assert/strict"
import { verifiedByRecordProblem, verifiedByProblems } from "./verified-by.mjs"

const good = { command: "npm test -- auth", exit: 0, evidence: "12 passed", readOnly: true }

test("a complete read-only record with exit 0 is a proof", () => {
  assert.equal(verifiedByRecordProblem(good), null)
})

test("each missing or wrong field names its own problem", () => {
  assert.equal(verifiedByRecordProblem(null), "is not an object")
  assert.equal(verifiedByRecordProblem({ ...good, command: "  " }), "has no non-empty command")
  assert.equal(verifiedByRecordProblem({ ...good, exit: 1 }), "did not exit 0")
  assert.equal(verifiedByRecordProblem({ ...good, exit: "0" }), "did not exit 0")
  assert.equal(verifiedByRecordProblem({ ...good, evidence: "" }), "has no non-empty evidence")
  assert.equal(verifiedByRecordProblem({ ...good, readOnly: "true" }), "is not readOnly: true")
})

test("verifiedByProblems indexes every bad record in a list, and accepts a single record", () => {
  assert.deepEqual(verifiedByProblems([good, { ...good, exit: 2 }]), ["verifiedBy[1] did not exit 0"])
  assert.deepEqual(verifiedByProblems(good), [])
  assert.deepEqual(verifiedByProblems(undefined), [])
})
