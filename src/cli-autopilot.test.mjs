/**
 * End-to-end through the `mission` binary: `mission gate` (the config-driven
 * milestone gate, with a throwaway "database" faked by plain shell commands)
 * and the session-start pickup in `mission brief --only-active`.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url))

function makeRepo({ gates, autopilot, branch = "main", missionStatus = "pending" } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mission-cli-")))
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: root })
  writeFileSync(path.join(root, "mission.config.json"), JSON.stringify({ version: 1, paths: { missions: "docs/prd" }, areas: [], gates }, null, 2))
  const dir = path.join(root, "docs", "prd", "demo")
  mkdirSync(dir, { recursive: true })
  const state = {
    missionStatus,
    currentMilestone: "M1",
    assertionStatus: {},
    decisions: [],
    constraints: [],
    roundLog: [],
    correctiveRounds: {},
    escalations: [],
    boundaryNotes: {},
    milestones: [{ id: "M1", order: 1, status: "pending", assertions: [] }],
    ...(autopilot ? { autopilot } : {}),
  }
  writeFileSync(path.join(dir, "mission-state.json"), JSON.stringify(state, null, 2) + "\n")
  return { root, dir }
}
const mission = (root, args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } })
const readState = (dir) => JSON.parse(readFileSync(path.join(dir, "mission-state.json"), "utf8"))

test("mission gate runs pre + integration + the verifiedBy re-run, one line per step, and records a green set-gate", () => {
  const { root, dir } = makeRepo({ gates: { pre: ["true"], integration: [{ cmd: "echo '7 passing'", expect: "\\d+ passing" }] } })
  const r = mission(root, ["gate", "docs/prd/demo", "M1"])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /^gate pre-1 exit=0 log=/m)
  assert.match(r.stdout, /^gate gate-1 exit=0 log=/m)
  assert.match(r.stdout, /^gate rerun-verified exit=0 log=/m)
  assert.match(r.stdout, /GATE M1 passed=true/)
  assert.ok(!r.stdout.includes("7 passing"), "log bodies are never printed")
  const g = readState(dir).integrationGate
  assert.equal(g.passed, true)
  assert.equal(g.milestone, "M1")
  assert.ok(Number.isFinite(Date.parse(g.ts)))
  assert.ok(readState(dir).boundaryNotes["rerunVerified-M1"], "the re-run recorded its results")
})

test("mission gate is red (exit 1) when a suite exits 0 without the expected output, and records it red", () => {
  const { root, dir } = makeRepo({ gates: { integration: [{ cmd: "echo 'no tests found'", expect: "\\d+ passing" }] } })
  const r = mission(root, ["gate", "docs/prd/demo", "M1"])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /gate gate-1 exit=0 expect=unmatched/)
  assert.equal(readState(dir).integrationGate.passed, false)
})

test("mission gate brings a throwaway database up first, overrides its env key, and tears it down last", () => {
  const gates = {
    // The integration command finds the data dir through the URL it was handed.
    integration: ['d="${DATABASE_URL#file:}"; d="${d%/db}"; test -f "$d/up"'],
    database: {
      enabled: true,
      url: "file:{dataDir}/db",
      setup: ["mkdir -p {dataDir} && touch {dataDir}/up"],
      teardown: ["rm -f {dataDir}/up"],
      stoppedCheck: "test ! -f {dataDir}/up",
    },
  }
  const { root, dir } = makeRepo({ gates })
  const r = mission(root, ["gate", "docs/prd/demo", "M1", "--no-record"], { DATABASE_URL: "postgresql://u@shared.example/db" })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /gate db-setup-1 exit=0[\s\S]*gate gate-1 exit=0[\s\S]*gate db-teardown-1 exit=0/)
  assert.equal(readState(dir).integrationGate, undefined, "--no-record writes nothing")
})

test("mission gate refuses (exit 2, nothing run) an inherited database value naming a forbidden endpoint, and a remote URL", () => {
  const base = { integration: ["touch ran.txt"], database: { enabled: true, url: "postgresql://u@127.0.0.1:{port}/gate", forbid: ["prod-db"], setup: ["true"] } }
  const { root } = makeRepo({ gates: base })
  let r = mission(root, ["gate", "docs/prd/demo", "M1"], { DATABASE_URL: "postgresql://u@prod-db.example/app" })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /forbidden endpoint/)
  assert.ok(!r.stderr.includes("prod-db.example"), "the value is never echoed")
  assert.equal(existsSync(path.join(root, "ran.txt")), false)
  const remote = makeRepo({ gates: { ...base, database: { ...base.database, url: "postgresql://u@db.example.com/gate" } } })
  r = mission(remote.root, ["gate", "docs/prd/demo", "M1"], { DATABASE_URL: "" })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /loopback/)
})

test("mission gate --dry-run prints the plan and runs nothing; bad usage exits 2", () => {
  const { root, dir } = makeRepo({ gates: { pre: ["touch pre.txt"], integration: ["touch ran.txt"] } })
  const r = mission(root, ["gate", "docs/prd/demo", "M1", "--dry-run"])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^plan pre-1: touch pre\.txt$/m)
  assert.match(r.stdout, /^plan rerun-verified: /m)
  assert.match(r.stdout, /plan database: none/)
  assert.equal(existsSync(path.join(root, "ran.txt")), false)
  assert.equal(readState(dir).integrationGate, undefined)
  assert.equal(mission(root, ["gate", "docs/prd/demo", "M9"]).status, 2, "unknown milestone")
  assert.equal(mission(root, ["gate", "docs/prd/demo", "M1", "--bogus"]).status, 2)
  assert.equal(mission(root, ["gate", "docs/prd/demo", "M1", "--port", "80"]).status, 2)
  const empty = makeRepo({ gates: { integration: [] } })
  assert.equal(mission(empty.root, ["gate", "docs/prd/demo", "M1"]).status, 2, "an empty integration gate is refused")
})

const record = (over = {}) => ({
  enabled: true,
  phase: "run-pending",
  approvedBy: "human",
  approvedAt: "2026-01-28T10:00:00Z",
  brief: "Build the export; owner items: none.",
  branch: "demo/m1",
  ...over,
})

test("brief --only-active: an approved run-pending mission is a DIRECTIVE only on its own branch", () => {
  const mine = makeRepo({ autopilot: record(), branch: "demo/m1" })
  let r = mission(mine.root, ["brief", "--only-active"])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Mission docs\/prd\/demo is NOT armed; this checkout is on its autopilot branch/)
  assert.match(r.stdout, /AUTOPILOT \(phase "run-pending"/)
  assert.match(r.stdout, /mission arm 'docs\/prd\/demo'/)
  assert.match(r.stdout, /Run brief, quoted DATA/)
  const other = makeRepo({ autopilot: record(), branch: "main" })
  r = mission(other.root, ["brief", "--only-active"])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^AUTOPILOT \(informational, not a directive\)/)
  assert.ok(!r.stdout.includes("Run brief"))
  const done = makeRepo({ autopilot: record({ phase: "done" }), branch: "demo/m1" })
  assert.equal(mission(done.root, ["brief", "--only-active"]).stdout, "", "a finished autopilot says nothing")
  const none = makeRepo({ branch: "demo/m1" })
  assert.equal(mission(none.root, ["brief", "--only-active"]).stdout, "")
})

test("brief --only-active: an armed, active mission gets the brief plus the directive; no config at all stays silent", () => {
  const { root } = makeRepo({ autopilot: record({ phase: "running" }), branch: "elsewhere" })
  assert.equal(mission(root, ["arm", "docs/prd/demo"]).status, 0)
  const r = mission(root, ["brief", "--only-active"])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /AUTOPILOT \(phase "running"[\s\S]*milestone M1: start it/)
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), "mission-noconfig-")))
  const q = spawnSync(process.execPath, [CLI, "brief", "--only-active"], { cwd: bare, encoding: "utf8" })
  assert.equal(q.status, 0)
  assert.equal(q.stdout + q.stderr, "")
})
