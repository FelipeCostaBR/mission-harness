/**
 * mission.test.mjs — the disk-reading half of the rehydration brief:
 * which handoffs count as built, the artifact trail, and verdict presence.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readArtifacts, buildBrief } from "./mission.mjs"
import { rehydrationPlan } from "../rules/rehydration.mjs"

const baseState = () => ({
  missionStatus: "active",
  currentMilestone: "M2",
  milestones: [
    { id: "M1", order: 1, status: "done", features: ["M1-a"], assertions: ["X-1"] },
    { id: "M2", order: 2, status: "in-progress", surface: "web", features: ["M2-a", "M2-b", "M2-c"], assertions: ["X-2"] },
  ],
  assertionStatus: { "X-1": "passing", "X-2": "pending" },
  escalations: [],
})

function makeMission() {
  const root = mkdtempSync(path.join(tmpdir(), "mission-harness-"))
  const rel = "missions/demo"
  const dir = path.join(root, rel)
  mkdirSync(path.join(dir, "handoffs"), { recursive: true })
  mkdirSync(path.join(dir, "verdicts"))
  writeFileSync(path.join(dir, "mission-state.json"), JSON.stringify(baseState(), null, 2))
  writeFileSync(
    path.join(dir, "handoffs", "M2-a.json"),
    JSON.stringify({
      feature: "M2-a",
      completed: [
        "Built the sign-in page at apps/web/app/(account)/sign-in/page.tsx (route group kept).",
        "Added packages/api/src/auth/challenge.ts and its test packages/api/src/auth/challenge.test.ts.",
      ],
      incomplete: ["Copy review for apps/web/messages/pt-BR.json pending."],
    }),
  )
  writeFileSync(path.join(dir, "handoffs", "broken.json"), "{ not json")
  writeFileSync(path.join(dir, "verdicts", "M2-web-account.json"), JSON.stringify({ verdict: "pass" }))
  return { root, rel, dir }
}

const trailOf = (plan) => Object.fromEntries(plan.knowledge.artifactTrail.map((t) => [t.feature, t.files]))

test("built features, the artifact trail (incl. route groups) and verdict presence come from disk", () => {
  const { root, rel } = makeMission()
  const { plan, brief } = buildBrief(root, rel)
  assert.deepEqual(plan.milestone.features.built, ["M2-a"])
  assert.equal(plan.milestone.hasVerdicts, true)
  assert.deepEqual(trailOf(plan)["M2-a"], [
    "apps/web/app/(account)/sign-in/page.tsx",
    "packages/api/src/auth/challenge.ts",
    "packages/api/src/auth/challenge.test.ts",
    "apps/web/messages/pt-BR.json",
  ])
  assert.ok(plan.warnings.some((w) => w.includes('unknown feature "broken"')))
  assert.ok(brief.startsWith("# Mission rehydration brief"))
})

test("a structured filesChanged[] reaches the trail even when the prose names no path", () => {
  const { root, rel, dir } = makeMission()
  writeFileSync(
    path.join(dir, "handoffs", "M2-b.json"),
    JSON.stringify({ feature: "M2-b", completed: ["Wired the seam."], filesChanged: ["src/notify/send.ts"] }),
  )
  const plan = rehydrationPlan(baseState(), readArtifacts(root, rel))
  assert.deepEqual(trailOf(plan)["M2-b"], ["src/notify/send.ts"])
})

test("an ESC-<id>.json handoff is keyed by its stem even when feature is the bare escalation id", () => {
  const { root, rel, dir } = makeMission()
  writeFileSync(
    path.join(dir, "handoffs", "ESC-E-auth.json"),
    JSON.stringify({ feature: "E-auth", filesChanged: ["apps/web/auth/index.ts"] }),
  )
  writeFileSync(path.join(dir, "handoffs", "renamed.json"), JSON.stringify({ feature: "M2-c", filesChanged: ["x/y.ts"] }))
  const plan = rehydrationPlan(baseState(), readArtifacts(root, rel))
  assert.equal(plan.warnings.some((w) => w.includes("E-auth")), false, JSON.stringify(plan.warnings))
  assert.deepEqual(trailOf(plan)["ESC-E-auth"], ["apps/web/auth/index.ts"])
  assert.ok(plan.milestone.features.built.includes("M2-c"))
})
