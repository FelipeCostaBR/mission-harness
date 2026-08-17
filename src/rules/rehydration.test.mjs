import test from "node:test"
import assert from "node:assert/strict"
import { rehydrationPlan, renderRehydrationBrief } from "./rehydration.mjs"

const state = {
  missionStatus: "active",
  currentMilestone: "M2",
  milestones: [
    { id: "M1", order: 1, status: "done", features: ["F1"], assertions: ["A-1"] },
    { id: "M2", order: 2, status: "pending", features: ["F2", "F3"], assertions: ["A-2", "A-3"] },
  ],
  assertionStatus: { "A-1": "passing", "A-2": "failing" },
  correctiveRounds: { M2: 1 },
  roundLog: [{ milestone: "M2", round: 1, type: "corrective", trigger: ["A-2"], at: "2026-01-01T00:00:00Z" }],
  escalations: [
    { id: "E1", milestone: "M2" },
    { id: "E2", milestone: "M1", verifiedBy: [{ cmd: "npm test", exitCode: 0 }] },
  ],
  integrationGate: { passed: false, scope: "M2", ts: "2026-01-01T00:00:00Z" },
  decisions: [{ milestone: "M1", decision: "kept scaling in the read model", why: "writes persist as-sent" }],
  constraints: [{ milestone: "M1", constraint: "seed data omits totals", impact: "a blank total is not a regression" }],
}

const artifacts = {
  handoffFeatures: ["F1", "F2"],
  verdictMilestonePrefixes: ["M1-billing"],
  handoffIndex: { F1: ["src/billing/a.ts", "src/billing/b.ts"], F2: ["src/auth/c.ts"] },
}

test("reports position inside the focus milestone", () => {
  const plan = rehydrationPlan(state, artifacts)
  assert.equal(plan.focusMilestoneId, "M2")
  assert.deepEqual(plan.milestone.features.built, ["F2"])
  assert.deepEqual(plan.milestone.features.pending, ["F3"])
  assert.equal(plan.milestone.correctiveRounds, 1)
  assert.equal(plan.milestone.hasVerdicts, false)
})

test("a never-validated assertion is `unknown`, never assumed passing", () => {
  const plan = rehydrationPlan(state, artifacts)
  assert.deepEqual(plan.milestone.assertions.failing, ["A-2"])
  assert.deepEqual(plan.milestone.assertions.unknown, ["A-3"])
})

test("only escalations lacking verifiedBy count as open", () => {
  const plan = rehydrationPlan(state, artifacts)
  assert.deepEqual(plan.openEscalations, [{ id: "E1", milestone: "M2" }])
})

test("a currentMilestone that disagrees with the statuses is a warning", () => {
  const plan = rehydrationPlan({ ...state, currentMilestone: "M1" }, artifacts)
  assert.ok(plan.warnings.some((w) => /currentMilestone/.test(w)))
})

test("ESC-* handoffs do not generate unknown-feature noise", () => {
  const plan = rehydrationPlan(state, {
    ...artifacts,
    handoffFeatures: ["F1", "F2", "ESC-schema"],
  })
  assert.ok(!plan.warnings.some((w) => /ESC-schema/.test(w)))
})

test("a genuinely unknown feature handoff IS a warning", () => {
  const plan = rehydrationPlan(state, { ...artifacts, handoffFeatures: ["F1", "F9"] })
  assert.ok(plan.warnings.some((w) => /F9/.test(w)))
})

test("the artifact trail includes handoffs that belong to no milestone", () => {
  // Escalation handoffs touch the highest-stakes files in the mission; excluding
  // them made the trail under-report exactly the work most worth knowing about.
  const plan = rehydrationPlan(state, {
    ...artifacts,
    handoffFeatures: ["F1", "F2", "ESC-schema"],
    handoffIndex: { ...artifacts.handoffIndex, "ESC-schema": ["db/schema.prisma"] },
  })
  assert.ok(plan.knowledge.artifactTrail.some((t) => t.feature === "ESC-schema"))
})

test("the rendered brief carries position AND knowledge", () => {
  const brief = renderRehydrationBrief(rehydrationPlan(state, artifacts))
  assert.match(brief, /status=active/)
  assert.match(brief, /Focus: M2/)
  assert.match(brief, /Open escalations/)
  assert.match(brief, /Constraints still binding/)
  assert.match(brief, /Decisions already taken/)
  assert.match(brief, /Artifact trail/)
  assert.match(brief, /do NOT re-read all artifacts/)
})

test("the brief is hard-capped, and drops knowledge before position", () => {
  const bloated = {
    ...state,
    decisions: Array.from({ length: 40 }, (_, i) => ({
      milestone: "M1",
      decision: `decision ${i} ` + "x".repeat(200),
      why: "y".repeat(200),
    })),
    constraints: Array.from({ length: 40 }, (_, i) => ({
      milestone: "M1",
      constraint: `constraint ${i} ` + "x".repeat(200),
      impact: "z".repeat(200),
    })),
  }
  const brief = renderRehydrationBrief(rehydrationPlan(bloated, artifacts))
  assert.ok(brief.length <= 6000, `brief was ${brief.length} chars`)
  assert.match(brief, /status=active/, "position survives the budget")
  assert.match(brief, /do NOT re-read all artifacts/, "the standing instruction survives")
})

test("an all-done mission says so instead of pointing at a milestone", () => {
  const done = {
    missionStatus: "done",
    milestones: [{ id: "M1", order: 1, status: "done", features: [], assertions: [] }],
  }
  const brief = renderRehydrationBrief(rehydrationPlan(done, {}))
  assert.match(brief, /All milestones done/)
})

test("throws on unusable state", () => {
  assert.throws(() => rehydrationPlan(null), TypeError)
})
