/**
 * rehydration.test.mjs — guards the mid-mission rehydration rule.
 * The disk-reading half is covered in src/io/mission.test.mjs.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { rehydrationPlan, renderRehydrationBrief } from "./rehydration.mjs"


const baseState = () => ({
  missionStatus: "active",
  currentMilestone: "M2",
  milestones: [
    { id: "M1", order: 1, status: "done", features: ["M1-a"], assertions: ["X-1"] },
    {
      id: "M2",
      order: 2,
      status: "in-progress",
      surface: "web",
      features: ["M2-a", "M2-b", "M2-c"],
      assertions: ["X-2", "X-3", "X-4", "X-5"],
    },
    { id: "M3", order: 3, status: "pending", features: ["M3-a"], assertions: ["X-6"] },
  ],
  assertionStatus: { "X-1": "passing", "X-2": "passing", "X-3": "failing", "X-5": "hypothesis-failed" },
  correctiveRounds: { M1: 0, M2: 1 },
  roundLog: [
    { milestone: "M2", round: 1, type: "corrective", trigger: ["X-3"] },
    { milestone: "M1", round: 1, type: "adversarial", trigger: ["deep-investigator"] },
  ],
  escalations: [
    { id: "E-1", milestone: "M1", verifiedBy: ["tsc"] },
    { id: "E-2", milestone: "M2" },
  ],
  integrationGate: { passed: false, scope: "M2 boundary", ts: "2026-10-23", commands: [{ cmd: "tsc", exitCode: 1 }] },
  activeWorker: { feature: "M2-b", runId: "wf_abc123" },
})

test("REH-1 mid-milestone position: built vs pending features from handoff presence", () => {
  const plan = rehydrationPlan(baseState(), { handoffFeatures: ["M1-a", "M2-a"] })
  assert.equal(plan.focusMilestoneId, "M2")
  assert.deepEqual(plan.milestone.features.built, ["M2-a"])
  assert.deepEqual(plan.milestone.features.pending, ["M2-b", "M2-c"])
  assert.equal(plan.resume.nextMilestoneId, "M2")
  assert.deepEqual(plan.resume.doneMilestoneIds, ["M1"])
})

test("REH-2 assertion bucketing for the focus milestone only, unknown = unverified", () => {
  const plan = rehydrationPlan(baseState(), {})
  const a = plan.milestone.assertions
  assert.deepEqual(a.passing, ["X-2"])
  assert.deepEqual(a.failing, ["X-3"])
  assert.deepEqual(a["hypothesis-failed"], ["X-5"])
  assert.deepEqual(a.unknown, ["X-4"]) // never validated → a fresh session must not assume it passed
})

test("REH-3 open escalations = entries not closed with verifiedBy evidence (status-less legacy records: proof decides)", () => {
  const plan = rehydrationPlan(baseState(), {})
  assert.deepEqual(plan.openEscalations, [{ id: "E-2", milestone: "M2", status: null }])
})

test("REH-3b an in-progress escalation with ONE verifiedBy entry recorded is still open, and renders with its status", () => {
  const s = baseState()
  s.escalations.push(
    {
      id: "E-webKernel-auth-wiring",
      milestone: "M2",
      status: "in-progress",
      verifiedBy: [{ command: "grep -n x apps/web/lib/auth.ts", exit: 0, evidence: "l12", readOnly: true }],
    },
    { id: "E-done", milestone: "M2", status: "done", verifiedBy: [{ command: "true", exit: 0, evidence: "ok", readOnly: true }] },
    { id: "E-done-unproven", milestone: "M2", status: "done", verifiedBy: [] },
    { id: "E-legacy-verified", milestone: "M1", status: "verified", verifiedBy: [{ cmd: "tsc", exitCode: 0 }] },
    { id: "E-legacy-planned", milestone: "M1", status: "planned", verifiedBy: [{ cmd: "tsc", exitCode: 0 }] },
  )
  const plan = rehydrationPlan(s, {})
  assert.deepEqual(
    plan.openEscalations.map((e) => e.id),
    ["E-2", "E-webKernel-auth-wiring", "E-done-unproven", "E-legacy-planned"],
  )
  const brief = renderRehydrationBrief(plan)
  assert.ok(brief.includes("E-webKernel-auth-wiring@M2 (in-progress)"), brief)
  assert.ok(brief.includes("E-2@M2,") || brief.includes("E-2@M2 "), brief) // no status → no parenthetical
})

test("REH-3c an orchestrator-owned (isEscalation) feature counts as built once the escalation(s) naming it are closed with proof", () => {
  const s = baseState()
  s.milestones[1].features.push("M2-admin-auth")
  s.features = {
    "M2-admin-auth": { module: "adminKernel", surface: "web", owner: "orchestrator", isEscalation: true, milestone: "M2" },
  }
  s.procedures = { "M2-admin-auth": "Staff sign-in; a seed edit is orchestrator-owned (E-adminKernel-staff-sign-in)." }
  // pending while no escalation record names it
  assert.ok(rehydrationPlan(s, {}).milestone.features.pending.includes("M2-admin-auth"))
  // named by the procedure, in progress → still pending
  s.escalations.push({ id: "E-adminKernel-staff-sign-in", milestone: "M2", status: "in-progress" })
  assert.ok(rehydrationPlan(s, {}).milestone.features.pending.includes("M2-admin-auth"))
  // closed with proof → built, even with only an ESC- handoff on disk
  s.escalations[s.escalations.length - 1] = {
    id: "E-adminKernel-staff-sign-in",
    milestone: "M2",
    status: "done",
    verifiedBy: [{ command: "true", exit: 0, evidence: "ok", readOnly: true }],
  }
  const plan = rehydrationPlan(s, { handoffFeatures: ["ESC-E-adminKernel-staff-sign-in"] })
  assert.ok(plan.milestone.features.built.includes("M2-admin-auth"))
  assert.ok(!plan.milestone.features.pending.includes("M2-admin-auth"))
  // a second naming record (via its `feature` field) that is still open keeps it pending
  s.escalations.push({ id: "E-schema-staff", milestone: "M2", status: "in-progress", feature: "M2-admin-auth" })
  assert.ok(rehydrationPlan(s, {}).milestone.features.pending.includes("M2-admin-auth"))
  // a worker-owned feature is never marked built by an escalation record
  s.features["M2-b"] = { module: "web-account", surface: "web", owner: "worker", isEscalation: false }
  s.escalations.push({ id: "E-x", status: "done", feature: "M2-b", verifiedBy: [{ command: "true", exit: 0, evidence: "ok", readOnly: true }] })
  assert.ok(rehydrationPlan(s, {}).milestone.features.pending.includes("M2-b"))
})

test("REH-3d the plan and the brief carry no design-spec mounting (web-only, ADR-0013)", () => {
  const s = baseState()
  s.milestones[1].designSpecPath = "docs/prd/x/design-spec.M2.md" // an archived state may still carry it
  const plan = rehydrationPlan(s, {})
  assert.equal("designSpecPath" in plan.milestone, false)
  assert.equal(renderRehydrationBrief(plan).includes("design-spec"), false)
})

test("REH-4 gate is summarized without raw commands; corrective rounds + round log tail scoped to focus", () => {
  const plan = rehydrationPlan(baseState(), {})
  assert.deepEqual(plan.gate, { passed: false, scope: "M2 boundary", ts: "2026-10-23" })
  assert.equal("commands" in plan.gate, false)
  assert.equal(plan.milestone.correctiveRounds, 1)
  assert.equal(plan.milestone.roundLogTail.length, 1)
  assert.equal(plan.milestone.roundLogTail[0].milestone, "M2")
})

test("REH-5 currentMilestone vs milestone-status mismatch surfaces a warning, statuses win for resume", () => {
  const s = baseState()
  s.currentMilestone = "M3" // stale pointer: M2 is not done yet
  const plan = rehydrationPlan(s, {})
  assert.equal(plan.focusMilestoneId, "M3") // explicit pointer is honored as focus…
  assert.ok(plan.warnings.some((w) => w.includes("currentMilestone (M3)") && w.includes("M2")))
})

test("REH-6 orphan handoff (feature in no milestone) warns instead of being silently dropped", () => {
  const plan = rehydrationPlan(baseState(), { handoffFeatures: ["ghost-feature"] })
  assert.ok(plan.warnings.some((w) => w.includes('unknown feature "ghost-feature"')))
})

test("REH-7 verdict presence is prefix-matched per milestone (M1 must not match M10)", () => {
  const s = baseState()
  s.currentMilestone = null
  s.milestones[1].status = "done"
  s.milestones[2].id = "M10" // focus becomes M10 (first non-done)
  const withM1Only = rehydrationPlan(s, { verdictMilestonePrefixes: ["M1-auth"] })
  assert.equal(withM1Only.focusMilestoneId, "M10")
  assert.equal(withM1Only.milestone.hasVerdicts, false)
  const withM10 = rehydrationPlan(s, { verdictMilestonePrefixes: ["M10-auth"] })
  assert.equal(withM10.milestone.hasVerdicts, true)
})

test("REH-8 all-done mission renders the finish path, and render stays compact", () => {
  const s = baseState()
  for (const m of s.milestones) m.status = "done"
  s.currentMilestone = null
  const plan = rehydrationPlan(s, {})
  assert.equal(plan.resume.allDone, true)
  const brief = renderRehydrationBrief(plan)
  assert.ok(brief.includes("finish bookkeeping"))
  assert.ok(brief.includes("set-status done"))
  // Etros keeps a finished mission's state in place: no archive, no missions index.
  assert.equal(/archive|index/i.test(brief), false)
})

test("REH-9 rendered brief is compact (≤2500 chars) even with noisy free-text fields", () => {
  const s = baseState()
  s.integrationGate.scope = "x".repeat(5000)
  s.roundLog[0].trigger = ["y".repeat(5000)]
  s.activeWorker = { blob: "z".repeat(5000) }
  const brief = renderRehydrationBrief(rehydrationPlan(s, { handoffFeatures: ["M2-a"] }))
  assert.ok(brief.length <= 2500, `brief too big: ${brief.length}`)
  assert.ok(brief.includes("Focus: M2"))
  assert.ok(brief.includes("do NOT re-read all artifacts"))
})

test("REH-10 invalid input throws (same contract as resumePlan)", () => {
  assert.throws(() => rehydrationPlan(null), TypeError)
  assert.throws(() => rehydrationPlan({ milestones: "nope" }), TypeError)
})

// --- knowledge half: the brief must carry WHAT IS KNOWN, not only where we are.
// A status-only brief measured no better than no brief at all (fresh-session
// ramp-to-first-work stayed ~104-132k because the session re-derived from source).

test("REH-11 artifact trail covers done milestones AND the focus milestone, never pending ones", () => {
  const plan = rehydrationPlan(baseState(), {
    handoffFeatures: ["M1-a", "M2-a"],
    handoffIndex: {
      "M1-a": ["packages/api/src/auth/challenge.ts"],
      "M2-a": ["apps/web/app/(account)/sign-in/page.tsx"],
      "M3-a": ["packages/api/src/never-in-scope.ts"], // M3 is pending → must not leak in
    },
  })
  const seen = plan.knowledge.artifactTrail.map((t) => t.feature)
  assert.deepEqual(seen.sort(), ["M1-a", "M2-a"]) // M1 done + M2 focus
  assert.equal(plan.knowledge.artifactTrail.find((t) => t.feature === "M1-a").more, 0)
})

test("REH-12 decisions and constraints survive into the plan and the rendered brief", () => {
  const s = baseState()
  s.decisions = [{ milestone: "M1", decision: "challenge codes live in Postgres", why: "serverless has no shared memory" }]
  s.constraints = [{ milestone: "M1", constraint: "Auth.js reserves /api/auth/*", impact: "own routes live at /api/auth/code/*" }]
  const brief = renderRehydrationBrief(rehydrationPlan(s, {}))
  assert.ok(brief.includes("do NOT relitigate"))
  assert.ok(brief.includes("challenge codes live in Postgres"))
  assert.ok(brief.includes("serverless has no shared memory"))
  assert.ok(brief.includes("Constraints still binding"))
  assert.ok(brief.includes("Auth.js reserves /api/auth/*"))
})

test("REH-13 ESC-* escalation handoffs are not orphan warnings (they live outside features[] by design)", () => {
  const plan = rehydrationPlan(baseState(), { handoffFeatures: ["ESC-ci-gate", "ESC-flow-harden", "real-ghost"] })
  assert.equal(plan.warnings.filter((w) => w.includes("ESC-")).length, 0)
  assert.ok(plan.warnings.some((w) => w.includes('unknown feature "real-ghost"')))
})

test("REH-14 knowledge is capped: a runaway mission cannot grow the brief back into what it replaces", () => {
  const s = baseState()
  s.decisions = Array.from({ length: 60 }, (_, i) => ({ milestone: "M2", decision: `d${i} ${"x".repeat(400)}`, why: "y".repeat(400) }))
  s.constraints = Array.from({ length: 40 }, (_, i) => ({ constraint: `c${i} ${"z".repeat(400)}`, impact: "w".repeat(400) }))
  s.milestones[0].features = Array.from({ length: 40 }, (_, i) => `M1-f${i}`)
  s.milestones[0].status = "done"
  const handoffIndex = {}
  for (const f of s.milestones[0].features)
    handoffIndex[f] = Array.from({ length: 30 }, (_, i) => `packages/api/src/auth/f${i}.ts`)
  const plan = rehydrationPlan(s, { handoffFeatures: s.milestones[0].features, handoffIndex })
  assert.equal(plan.knowledge.decisions.length, 10)
  assert.equal(plan.knowledge.constraints.length, 8)
  assert.ok(plan.knowledge.artifactTrail.length <= 12)
  assert.ok(plan.knowledge.artifactTrail.every((t) => t.files.length <= 5))
  assert.ok(plan.warnings.length <= 7) // 6 + the suppression note
  const brief = renderRehydrationBrief(plan)
  assert.ok(brief.length <= 6000, `brief too big: ${brief.length}`)
})

test("REH-15 a mission with no knowledge recorded renders exactly as before (backward compatible)", () => {
  const brief = renderRehydrationBrief(rehydrationPlan(baseState(), {}))
  assert.equal(brief.includes("Decisions already taken"), false)
  assert.equal(brief.includes("Constraints still binding"), false)
  assert.equal(brief.includes("Artifact trail"), false)
})

test("REH-16 a legacy plan-time decisions{} map still surfaces in the brief, as [plan] records", () => {
  const s = baseState()
  s.decisions = { staffAuth: "email-code", session: "authjs-v5-credentials-jwt", workflowOptIn: true }
  const plan = rehydrationPlan(s, {})
  assert.equal(plan.knowledge.decisions.length, 3)
  const brief = renderRehydrationBrief(plan)
  assert.ok(brief.includes("Decisions already taken (do NOT relitigate)"))
  assert.ok(brief.includes("[plan] staffAuth: email-code"))
  assert.ok(brief.includes("[plan] workflowOptIn: true"))
})

test("REH-19 no-device (e2e environment unavailable) assertions get their own gated bucket, never 'unverified'", () => {
  const s = baseState()
  s.assertionStatus["X-4"] = "inconclusive-no-device"
  const plan = rehydrationPlan(s, {})
  assert.deepEqual(plan.milestone.assertions["no-device"], ["X-4"])
  assert.deepEqual(plan.milestone.assertions.unknown, [])
  const brief = renderRehydrationBrief(plan)
  assert.ok(brief.includes("no-device(gated)=[X-4]"), brief)
  assert.ok(brief.includes("unverified=[]"))
})

test("REH-20 a currentMilestone left on a DONE milestone focuses the first non-done one, with a warning", () => {
  const s = baseState()
  s.currentMilestone = "M1" // done; nothing advanced the pointer at the boundary
  const plan = rehydrationPlan(s, {})
  assert.equal(plan.focusMilestoneId, "M2")
  assert.ok(plan.warnings.some((w) => w.includes("currentMilestone (M1) is already done")))
  assert.ok(renderRehydrationBrief(plan).includes("Focus: M2"))
  // all milestones done: nothing to move to, the pointer stays
  for (const m of s.milestones) m.status = "done"
  assert.equal(rehydrationPlan(s, {}).focusMilestoneId, "M1")
})

test("REH-21 the focus milestone's pre-named escalations with no escalations[] record yet render as planned", () => {
  const s = baseState()
  s.milestones[1].escalations = ["E-2", "E-schema-otp", "E-i18n-signin"]
  const plan = rehydrationPlan(s, {})
  assert.deepEqual(plan.plannedEscalations, ["E-schema-otp", "E-i18n-signin"]) // E-2 already has a record
  assert.ok(renderRehydrationBrief(plan).includes("Planned escalations (not started): E-schema-otp, E-i18n-signin"))
  assert.equal(renderRehydrationBrief(rehydrationPlan(baseState(), {})).includes("Planned escalations"), false)
})

