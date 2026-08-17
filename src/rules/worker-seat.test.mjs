import test from "node:test"
import assert from "node:assert/strict"
import { resolveWorkerSeat, SEAT_LADDER } from "./worker-seat.mjs"

test("the initial build keeps the base seat", () => {
  const d = resolveWorkerSeat({ correctiveRounds: 0 })
  assert.equal(d.seat, "standard")
  assert.equal(d.escalated, false)
})

test("the final corrective round escalates to frontier", () => {
  const d = resolveWorkerSeat({ correctiveRounds: 1 })
  assert.equal(d.seat, "frontier")
  assert.equal(d.escalated, true)
})

test("escalation is capped, never runaway", () => {
  const d = resolveWorkerSeat({ correctiveRounds: 9 })
  assert.equal(d.seat, "frontier")
})

test("a later threshold delays the spend", () => {
  assert.equal(resolveWorkerSeat({ correctiveRounds: 1, escalateAfterRounds: 2 }).seat, "standard")
  assert.equal(resolveWorkerSeat({ correctiveRounds: 2, escalateAfterRounds: 2 }).seat, "frontier")
})

test("an economy base steps up one tier at a time", () => {
  assert.equal(resolveWorkerSeat({ correctiveRounds: 1, baseSeat: "economy" }).seat, "standard")
  assert.equal(resolveWorkerSeat({ correctiveRounds: 2, baseSeat: "economy" }).seat, "frontier")
})

test("a base seat already at the cap reports no escalation possible", () => {
  const d = resolveWorkerSeat({ correctiveRounds: 5, baseSeat: "frontier" })
  assert.equal(d.seat, "frontier")
  assert.equal(d.escalated, false)
  assert.match(d.reason, /no escalation possible/)
})

test("a custom ladder is honoured", () => {
  const ladder = ["small", "large"]
  const d = resolveWorkerSeat({
    correctiveRounds: 1,
    baseSeat: "small",
    maxSeat: "large",
    ladder,
  })
  assert.equal(d.seat, "large")
})

test("the exported ladder is cheapest-first", () => {
  assert.deepEqual(SEAT_LADDER, ["economy", "standard", "frontier"])
})

test("malformed input throws", () => {
  assert.throws(() => resolveWorkerSeat({ correctiveRounds: -1 }), TypeError)
  assert.throws(() => resolveWorkerSeat({ correctiveRounds: 0, baseSeat: "nope" }), TypeError)
  assert.throws(
    () => resolveWorkerSeat({ correctiveRounds: 0, baseSeat: "frontier", maxSeat: "economy" }),
    TypeError,
  )
  assert.throws(() => resolveWorkerSeat({ correctiveRounds: 0, ladder: [] }), TypeError)
})
