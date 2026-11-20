/**
 * node:test for self-heal.mjs (the missions-harness boundary decision rule).
 * Run: node --test .claude/skills/run-prd-multi-agent-architecture/lib/
 *
 * Covers SH-1 (all six decision cases) + SH-2 (corrective/circuit-break
 * boundary exactness vs maxRounds). Pure unit tests, no I/O.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { decideSelfHeal } from "./self-heal.mjs"

/** A clean milestone: everything green, no rounds spent. */
const CLEAN = {
  assertionsAllPassing: true,
  boundaryViolations: 0,
  missingDefaults: 0,
  gateGreen: true,
  correctiveRounds: 0,
}

test("advance: clean milestone advances", () => {
  assert.equal(decideSelfHeal(CLEAN).action, "advance")
})

test("corrective: a failing assertion at round 0 scopes a corrective round", () => {
  const d = decideSelfHeal({ ...CLEAN, assertionsAllPassing: false, correctiveRounds: 0 })
  assert.equal(d.action, "corrective")
})

test("corrective: a failing assertion at round 1 still scopes a corrective round", () => {
  const d = decideSelfHeal({ ...CLEAN, assertionsAllPassing: false, correctiveRounds: 1 })
  assert.equal(d.action, "corrective")
})

test("circuit-break: a failing assertion at round 2 trips the breaker", () => {
  const d = decideSelfHeal({ ...CLEAN, assertionsAllPassing: false, correctiveRounds: 2 })
  assert.equal(d.action, "circuit-break")
})

test("boundaryViolations block advance even when assertions all pass", () => {
  const d = decideSelfHeal({ ...CLEAN, boundaryViolations: 1 })
  assert.equal(d.action, "corrective") // round 0 -> corrective, NOT advance
})

test("missingDefaults block advance even when assertions all pass", () => {
  const d = decideSelfHeal({ ...CLEAN, missingDefaults: 1 })
  assert.equal(d.action, "corrective")
})

test("a red integration gate blocks advance even when assertions all pass", () => {
  const d = decideSelfHeal({ ...CLEAN, gateGreen: false })
  assert.equal(d.action, "corrective")
})

test("SH-2 boundary exactness: corrective for 0..maxRounds-1, circuit-break at maxRounds (maxRounds=2)", () => {
  const failing = { ...CLEAN, assertionsAllPassing: false }
  assert.equal(decideSelfHeal({ ...failing, correctiveRounds: 0 }).action, "corrective")
  assert.equal(decideSelfHeal({ ...failing, correctiveRounds: 1 }).action, "corrective")
  assert.equal(decideSelfHeal({ ...failing, correctiveRounds: 2 }).action, "circuit-break")
  assert.equal(decideSelfHeal({ ...failing, correctiveRounds: 3 }).action, "circuit-break")
})

test("SH-2 boundary exactness honours a custom maxRounds=1 (break at the first failure round)", () => {
  const failing = { ...CLEAN, assertionsAllPassing: false, maxRounds: 1 }
  assert.equal(decideSelfHeal({ ...failing, correctiveRounds: 0 }).action, "corrective")
  assert.equal(decideSelfHeal({ ...failing, correctiveRounds: 1 }).action, "circuit-break")
})

test("malformed input throws (fails loud, never silently advances on garbage)", () => {
  assert.throws(() => decideSelfHeal({ ...CLEAN, assertionsAllPassing: "yes" }), TypeError)
  assert.throws(() => decideSelfHeal({ ...CLEAN, boundaryViolations: -1 }), TypeError)
  assert.throws(() => decideSelfHeal({ ...CLEAN, correctiveRounds: 1.5 }), TypeError)
  assert.throws(() => decideSelfHeal({ ...CLEAN, maxRounds: 0 }), TypeError)
})

test("every decision carries a non-empty reason", () => {
  for (const s of [
    CLEAN,
    { ...CLEAN, assertionsAllPassing: false, correctiveRounds: 0 },
    { ...CLEAN, assertionsAllPassing: false, correctiveRounds: 2 },
  ]) {
    const d = decideSelfHeal(s)
    assert.ok(typeof d.reason === "string" && d.reason.length > 0)
  }
})
