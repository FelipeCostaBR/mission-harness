import test from "node:test"
import assert from "node:assert/strict"
import {
  checkBookkeeping,
  checkHandoffMeta,
  isBookkeepingClean,
  computeAdvanceReadiness,
  MISSION_STATUSES,
} from "./bookkeeping.mjs"

const codes = (findings) => findings.map((f) => f.code)

test("a minimal well-formed state is clean", () => {
  const findings = checkBookkeeping({ missionStatus: "active", milestones: [] })
  assert.equal(isBookkeepingClean(findings), true)
})

test("an unknown missionStatus is an error", () => {
  const findings = checkBookkeeping({ missionStatus: "finished" })
  assert.ok(codes(findings).includes("unknown-mission-status"))
  assert.equal(isBookkeepingClean(findings), false)
})

test("`gated` is a recognized status, distinct from done", () => {
  assert.deepEqual(MISSION_STATUSES, ["active", "halted", "gated", "done"])
  assert.equal(isBookkeepingClean(checkBookkeeping({ missionStatus: "gated" })), true)
})

test("a counter BEHIND the round log is an error — it disarms the breaker", () => {
  // This is the check that actually bites. decideSelfHeal reads the counter and
  // nothing else, so rounds that were logged but never counted mean the milestone
  // has no circuit breaker at all.
  const findings = checkBookkeeping({
    missionStatus: "active",
    correctiveRounds: { M2: 2 },
    roundLog: [
      { milestone: "M1", round: 1, type: "corrective", at: "2026-01-01T00:00:00Z" },
      { milestone: "M1", round: 2, type: "corrective", at: "2026-01-01T01:00:00Z" },
      { milestone: "M2", round: 1, type: "corrective", at: "2026-01-01T02:00:00Z" },
      { milestone: "M2", round: 2, type: "corrective", at: "2026-01-01T03:00:00Z" },
    ],
  })
  const f = findings.find((x) => x.code === "counter-behind-roundlog")
  assert.ok(f, "M1 has two logged rounds and no counter entry")
  assert.equal(f.severity, "error")
  assert.match(f.detail, /M1/)
})

test("adversarial rounds are NOT counted against the corrective cap", () => {
  // Running the safety net must never trip the breaker.
  const findings = checkBookkeeping({
    missionStatus: "active",
    correctiveRounds: {},
    roundLog: [{ milestone: "M1", round: 1, type: "adversarial", at: "2026-01-01T00:00:00Z" }],
  })
  assert.ok(!codes(findings).includes("counter-behind-roundlog"))
})

test("a log behind the counter is only a warning", () => {
  const findings = checkBookkeeping({
    missionStatus: "active",
    correctiveRounds: { M1: 2 },
    roundLog: [{ milestone: "M1", round: 1, type: "corrective", at: "2026-01-01T00:00:00Z" }],
  })
  const f = findings.find((x) => x.code === "roundlog-behind-counter")
  assert.equal(f.severity, "warn")
})

test("a missing round timestamp warns, a malformed one errors", () => {
  const warn = checkBookkeeping({
    missionStatus: "active",
    correctiveRounds: { M1: 1 },
    roundLog: [{ milestone: "M1", round: 1, type: "corrective" }],
  })
  assert.equal(warn.find((f) => f.code === "roundlog-missing-timestamp").severity, "warn")

  const err = checkBookkeeping({
    missionStatus: "active",
    correctiveRounds: { M1: 1 },
    roundLog: [{ milestone: "M1", round: 1, type: "corrective", at: "not-a-date" }],
  })
  assert.equal(err.find((f) => f.code === "roundlog-bad-timestamp").severity, "error")
})

test("an ESC handoff without its delegation marker is an error", () => {
  // The marker is what the fresh-validator spawn keys on: no marker means the
  // creator/verifier split silently never happened.
  const base = {
    missionStatus: "active",
    escalations: [{ id: "schema-bump" }],
  }
  const findings = checkBookkeeping(base, { handoffFiles: ["ESC-schema-bump.json"] })
  assert.ok(codes(findings).includes("esc-handoff-not-marked-delegated"))

  const ok = checkBookkeeping(
    { ...base, escalations: [{ id: "schema-bump", implementedBy: "escalation-worker" }] },
    { handoffFiles: ["ESC-schema-bump.json"] },
  )
  assert.ok(!codes(ok).includes("esc-handoff-not-marked-delegated"))
})

test("an ESC handoff with no escalations[] entry at all is an error", () => {
  const findings = checkBookkeeping(
    { missionStatus: "active", escalations: [] },
    { handoffFiles: ["ESC-ghost.json"] },
  )
  assert.ok(codes(findings).includes("esc-handoff-unrecorded"))
})

test("both ESC id conventions are accepted", () => {
  const findings = checkBookkeeping(
    {
      missionStatus: "active",
      escalations: [{ id: "ESC-ci-gate", implementedBy: "escalation-worker" }],
    },
    { handoffFiles: ["ESC-ci-gate.json"] },
  )
  assert.equal(isBookkeepingClean(findings), true)
})

test("a done milestone with no decisions or simplify pass warns but does not block", () => {
  const findings = checkBookkeeping({
    missionStatus: "active",
    milestones: [{ id: "M1", order: 1, status: "done" }],
  })
  assert.ok(codes(findings).includes("checkpoint-missing-decisions"))
  assert.ok(codes(findings).includes("simplify-pass-missing"))
  assert.equal(isBookkeepingClean(findings), true)
})

test("a declared-then-skipped plan review warns; an absent one stays silent", () => {
  const skipped = checkBookkeeping({
    missionStatus: "active",
    planReview: { required: true, ran: false, triggers: ["shared-surface"] },
  })
  assert.ok(codes(skipped).includes("plan-review-skipped"))

  const absent = checkBookkeeping({ missionStatus: "active" })
  assert.ok(!codes(absent).includes("plan-review-skipped"))
})

test("a pending context reset surfaces as a warning", () => {
  const findings = checkBookkeeping({
    missionStatus: "active",
    contextReset: { requested: true, atPercent: 62, milestone: "M2" },
  })
  const f = findings.find((x) => x.code === "context-reset-pending")
  assert.equal(f.severity, "warn")
  assert.match(f.detail, /do NOT clear the flag yourself/)
})

test("an unprobed queue substrate warns only once the mission has run", () => {
  assert.ok(!codes(checkBookkeeping({ missionStatus: "active" })).includes("queue-substrate-unprobed"))
  assert.ok(
    codes(
      checkBookkeeping({
        missionStatus: "active",
        correctiveRounds: { M1: 1 },
        roundLog: [{ milestone: "M1", round: 1, type: "corrective", at: "2026-01-01T00:00:00Z" }],
      }),
    ).includes("queue-substrate-unprobed"),
  )
})

test("handoff _meta is optional but validated when present", () => {
  assert.deepEqual(checkHandoffMeta({ feature: "F1" }), [])
  assert.deepEqual(checkHandoffMeta({ _meta: { tokensSpent: 100, attribution: "exact" } }), [])
  assert.ok(
    checkHandoffMeta({ _meta: { tokensSpent: -1, attribution: "exact" } }).some(
      (f) => f.code === "bad-meta-tokens",
    ),
  )
  assert.ok(
    checkHandoffMeta({ _meta: { tokensSpent: 1, attribution: "guessed" } }).some(
      (f) => f.code === "bad-meta-attribution",
    ),
  )
})

test("advance readiness: all passing", () => {
  const r = computeAdvanceReadiness({ "A-1": "passing", "A-2": "passing" })
  assert.deepEqual(r, {
    assertionsAllPassing: true,
    behaviorallyGated: false,
    hypothesisFailed: false,
    blocking: [],
  })
})

test("an unverifiable assertion advances the milestone but gates the mission", () => {
  // A headless run must not stall on a missing device — but it also must not be
  // reported as done.
  const r = computeAdvanceReadiness({ "A-1": "passing", "A-2": "skipped" })
  assert.equal(r.assertionsAllPassing, true)
  assert.equal(r.behaviorallyGated, true)
})

test("a falsified hypothesis is non-blocking but bars done", () => {
  const r = computeAdvanceReadiness({ "A-1": "passing", "A-2": "hypothesis-failed" })
  assert.equal(r.assertionsAllPassing, true)
  assert.equal(r.hypothesisFailed, true)
})

test("failing, pending and generic inconclusive all block", () => {
  const r = computeAdvanceReadiness({
    "A-1": "failing",
    "A-2": "pending",
    "A-3": "inconclusive",
    "A-4": "passing",
  })
  assert.equal(r.assertionsAllPassing, false)
  assert.deepEqual(r.blocking.sort(), ["A-1", "A-2", "A-3"])
})

test("a non-object state is a single hard error", () => {
  assert.deepEqual(codes(checkBookkeeping(null)), ["no-state"])
})
