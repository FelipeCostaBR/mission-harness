import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnStep, runGatePlan, runAlwaysStepsSync, cleanupDataDir, killGroup } from "./gate.mjs"

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("runGatePlan: a failed critical step skips the rest, but the always step still runs", async () => {
  const logDir = tmp("gate-plan-")
  const plan = [
    { name: "db-setup-1", cmd: "x", critical: true },
    { name: "gate-1", cmd: "y" },
    { name: "db-teardown-1", cmd: "z", always: true },
  ]
  const ran = []
  const results = await runGatePlan(plan, { logDir, run: (s) => (ran.push(s.name), s.name === "db-setup-1" ? 1 : 0) })
  assert.deepEqual(ran, ["db-setup-1", "db-teardown-1"])
  assert.equal(results[1].skipped, "an earlier critical step failed")
  assert.equal(results[1].exitCode, null)
  assert.equal(results[2].always, true)
})

test("runGatePlan: ONE overall deadline; each step gets what is left, and past it only always steps run", async () => {
  const logDir = tmp("gate-deadline-")
  let clock = 0
  const timeouts = {}
  const plan = [{ name: "a", cmd: "a" }, { name: "b", cmd: "b" }, { name: "c", cmd: "c" }, { name: "t", cmd: "t", always: true }]
  const results = await runGatePlan(plan, {
    logDir,
    deadline: 10_000,
    now: () => clock,
    run: (s, { timeoutMs }) => {
      timeouts[s.name] = timeoutMs
      clock += 6_000
      return 0
    },
  })
  assert.equal(timeouts.a, 10_000)
  assert.equal(timeouts.b, 4_000)
  assert.equal(results[2].skipped, "the overall deadline passed")
  assert.ok("t" in timeouts, "the teardown still ran")
})

test("runGatePlan: an expect pattern the log does not match reddens a step that exited 0", async () => {
  const logDir = tmp("gate-expect-")
  const plan = [
    { name: "gate-1", cmd: "echo '3 passing'", expect: "\\d+ passing" },
    { name: "gate-2", cmd: "echo 'no tests found'", expect: "\\d+ passing" },
  ]
  const results = await runGatePlan(plan, { logDir, env: process.env, cwd: logDir })
  assert.equal(results[0].exitCode, 0)
  assert.equal(results[0].expectFailed, undefined)
  assert.equal(results[1].exitCode, 0)
  assert.equal(results[1].expectFailed, true)
  assert.equal(readFileSync(results[1].log, "utf8").trim(), "no tests found", "output goes to the step's own log")
})

test("spawnStep: exit codes, a command that cannot start, and a timeout that kills the WHOLE process group", async () => {
  const dir = tmp("gate-spawn-")
  const log = (n) => path.join(dir, `${n}.log`)
  assert.equal(await spawnStep({ cmd: "exit 3" }, { log: log("a"), env: process.env, cwd: dir, timeoutMs: 10_000 }), 3)
  assert.equal(await spawnStep({ argv: [path.join(dir, "no-such-binary")] }, { log: log("b"), env: process.env, cwd: dir, timeoutMs: 10_000 }), 127)
  // The step forks a grandchild that would outlive a plain child.kill().
  const pidFile = path.join(dir, "grandchild.pid")
  const code = await spawnStep(
    { cmd: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait` },
    { log: log("c"), env: process.env, cwd: dir, timeoutMs: 500, killGraceMs: 200 },
  )
  assert.equal(code, 124)
  const pid = Number(readFileSync(pidFile, "utf8"))
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(50)
  assert.equal(alive(pid), false, "no orphaned grandchild")
  killGroup(null)
  killGroup({ pid: undefined })
})

test("runAlwaysStepsSync runs only the always steps and reports whether all were green", () => {
  const dir = tmp("gate-always-")
  const marker = path.join(dir, "ran")
  const plan = [
    { name: "gate-1", cmd: `touch ${JSON.stringify(path.join(dir, "never"))}` },
    { name: "db-teardown-1", cmd: `touch ${JSON.stringify(marker)}`, always: true },
  ]
  assert.equal(runAlwaysStepsSync(plan, { env: process.env, cwd: dir }), true)
  assert.equal(existsSync(marker), true)
  assert.equal(existsSync(path.join(dir, "never")), false)
  assert.equal(runAlwaysStepsSync([{ name: "t", cmd: "exit 1", always: true }], { env: process.env, cwd: dir }), false)
})

test("cleanupDataDir deletes the throwaway database only once it is confirmed down", () => {
  const make = () => {
    const parent = tmp("gate-db-")
    const dataDir = path.join(parent, "data")
    mkdirSync(dataDir)
    writeFileSync(path.join(dataDir, "PG_VERSION"), "17\n")
    return { parent, dataDir }
  }
  const quiet = () => {}
  let d = make()
  assert.equal(cleanupDataDir(d.dataDir, { teardownOk: true, write: quiet }), true)
  assert.equal(existsSync(d.parent), false)
  d = make()
  let said = ""
  assert.equal(cleanupDataDir(d.dataDir, { teardownOk: false, write: (s) => (said += s) }), false)
  assert.equal(existsSync(d.dataDir), true, "a teardown that failed leaves the directory for a manual stop")
  assert.match(said, /may still be running/)
  d = make()
  assert.equal(cleanupDataDir(d.dataDir, { teardownOk: true, stoppedCheck: "exit 1", env: process.env, cwd: d.parent, write: quiet }), false, "the stopped check overrules")
  assert.equal(existsSync(d.dataDir), true)
  assert.equal(cleanupDataDir(d.dataDir, { teardownOk: false, stoppedCheck: "exit 0", env: process.env, cwd: d.parent, write: quiet }), true)
  assert.equal(existsSync(d.parent), false)
  d = make()
  assert.equal(cleanupDataDir(d.dataDir, { teardownOk: true, keep: true, write: quiet }), true)
  assert.equal(existsSync(d.dataDir), true, "--keep-db keeps it")
  assert.equal(cleanupDataDir(null, { teardownOk: true }), true)
})
