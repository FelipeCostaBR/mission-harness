import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { currentBranch, findAutopilotMissions } from "./autopilot.mjs"

const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)))
const ap = (over = {}) => ({ enabled: true, phase: "running", approvedBy: "human", approvedAt: "2026-01-01T00:00:00Z", branch: "x", ...over })

function writeState(root, rel, state) {
  mkdirSync(path.join(root, rel), { recursive: true })
  writeFileSync(path.join(root, rel, "mission-state.json"), JSON.stringify(state))
}

test("findAutopilotMissions scans both depths, keeps only missions that owe work, newest approval first", () => {
  const root = tmp("ap-scan-")
  writeState(root, "docs/prd/one", { autopilot: ap({ approvedAt: "2026-01-01T00:00:00Z" }) })
  writeState(root, "docs/prd/split/m2", { autopilot: ap({ approvedAt: "2030-01-01T00:00:00Z", branch: "split/m2" }) })
  writeState(root, "docs/prd/finished", { autopilot: ap({ phase: "done" }) })
  writeState(root, "docs/prd/plain", { missionStatus: "active" })
  writeState(root, "docs/prd/bad name", { autopilot: ap() })
  writeState(root, "docs/prd/split/handoffs", { autopilot: ap() })
  mkdirSync(path.join(root, "docs/prd/broken"), { recursive: true })
  writeFileSync(path.join(root, "docs/prd/broken/mission-state.json"), "{not json")
  const found = findAutopilotMissions(root, "docs/prd")
  assert.deepEqual(found.map((f) => f.missionDir), ["docs/prd/split/m2", "docs/prd/one"])
  assert.equal(found[0].state.autopilot.branch, "split/m2")
  assert.deepEqual(findAutopilotMissions(root, "nowhere"), [])
})

test("currentBranch names the checked-out branch, and null outside a repository", () => {
  const repo = tmp("ap-branch-")
  execFileSync("git", ["init", "-q", "-b", "feature/x"], { cwd: repo })
  assert.equal(currentBranch(repo), "feature/x")
  assert.equal(currentBranch(tmp("ap-norepo-")), null)
})
