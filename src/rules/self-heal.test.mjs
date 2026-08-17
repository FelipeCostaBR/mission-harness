import test from "node:test"
import assert from "node:assert/strict"
import { decideSelfHeal } from "./self-heal.mjs"

const clean = {
  assertionsAllPassing: true,
  boundaryViolations: 0,
  missingDefaults: 0,
  gateGreen: true,
  correctiveRounds: 0,
}

test("advances only when everything is clean", () => {
  assert.equal(decideSelfHeal(clean).action, "advance")
})

test("a failing assertion opens a corrective round", () => {
  const d = decideSelfHeal({ ...clean, assertionsAllPassing: false })
  assert.equal(d.action, "corrective")
})

test("a boundary violation blocks even when every assertion passes", () => {
  // The whole point: a worker that edited outside its area may have satisfied
  // its assertions while breaking someone else's code.
  const d = decideSelfHeal({ ...clean, boundaryViolations: 1 })
  assert.equal(d.action, "corrective")
})

test("a missing default blocks even when every assertion passes", () => {
  const d = decideSelfHeal({ ...clean, missingDefaults: 2 })
  assert.equal(d.action, "corrective")
})

test("a red integration gate blocks even when every assertion passes", () => {
  // Per-area checks cannot see cross-repo breakage; the gate is the real boundary.
  const d = decideSelfHeal({ ...clean, gateGreen: false })
  assert.equal(d.action, "corrective")
})

test("circuit-breaks at the cap instead of trying a third round", () => {
  const d = decideSelfHeal({ ...clean, assertionsAllPassing: false, correctiveRounds: 2 })
  assert.equal(d.action, "circuit-break")
  assert.match(d.reason, /exhausted/)
})

test("the cap is configurable but still terminal", () => {
  assert.equal(
    decideSelfHeal({ ...clean, assertionsAllPassing: false, correctiveRounds: 2, maxRounds: 3 })
      .action,
    "corrective",
  )
  assert.equal(
    decideSelfHeal({ ...clean, assertionsAllPassing: false, correctiveRounds: 3, maxRounds: 3 })
      .action,
    "circuit-break",
  )
})

test("a clean milestone advances even at the cap", () => {
  // Rounds spent are not a reason to keep failing: if it is clean, it ships.
  assert.equal(decideSelfHeal({ ...clean, correctiveRounds: 2 }).action, "advance")
})

test("malformed input throws rather than silently advancing", () => {
  assert.throws(() => decideSelfHeal({ ...clean, assertionsAllPassing: "yes" }), TypeError)
  assert.throws(() => decideSelfHeal({ ...clean, correctiveRounds: -1 }), TypeError)
  assert.throws(() => decideSelfHeal({ ...clean, boundaryViolations: 1.5 }), TypeError)
  assert.throws(() => decideSelfHeal({ ...clean, maxRounds: 0 }), TypeError)
  assert.throws(() => decideSelfHeal(null), TypeError)
})
