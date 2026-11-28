/**
 * gate.mjs (io) — runs the milestone gate plan that `src/rules/gate.mjs`
 * builds from the config.
 *
 * Every step runs in its own process group with its output in its own log
 * (never in this process's output: one line per step, the log path, the exit
 * code). One overall deadline bounds the run: each step gets at most what is
 * left, a step past it has its whole group killed, and once the deadline has
 * passed only the `always` steps (the database teardown) still run. On a
 * signal the running step's group is killed and the teardown runs
 * synchronously; the throwaway data directory is deleted only once the
 * teardown (or `stoppedCheck`) confirms the database is down.
 */

import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { stepTimeout } from "../rules/gate.mjs"

const argvOf = (step) => (Array.isArray(step.argv) ? step.argv : ["sh", "-c", step.cmd])

/** Kill a detached child's whole process group (a runner and its workers). */
export function killGroup(child, signal = "SIGTERM") {
  if (!child || !child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

/** The step currently running, so a signal handler can kill its group. */
export const liveStep = { child: null }

/**
 * Spawn one step detached (its own process group), output to its log, with a
 * timeout that kills the GROUP (SIGTERM, then SIGKILL after 10 s). Resolves to
 * the exit code: 124 on a timeout, 127 when it cannot start, 128+n on a signal.
 */
export function spawnStep(step, { log, env, cwd, timeoutMs, killGraceMs = 10_000 }) {
  return new Promise((resolve) => {
    const fd = openSync(log, "w")
    const [cmd, ...args] = argvOf(step)
    let child
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", fd, fd], detached: true })
    } catch {
      closeSync(fd)
      return resolve(127)
    }
    liveStep.child = child
    let timedOut = false
    let hard = null
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child, "SIGTERM")
      hard = setTimeout(() => killGroup(child, "SIGKILL"), killGraceMs)
    }, timeoutMs)
    let settled = false
    const done = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (hard) clearTimeout(hard)
      if (liveStep.child === child) liveStep.child = null
      try {
        closeSync(fd)
      } catch {
        /* closed */
      }
      if (timedOut) return resolve(124)
      if (typeof code === "number") return resolve(code)
      return resolve(signal === "SIGKILL" ? 137 : signal === "SIGINT" ? 130 : 143)
    }
    child.on("error", () => done(127, null))
    child.on("close", done)
  })
}

/**
 * Run the plan with an injectable runner (`run` returns an exit code or a
 * promise of one). After a step with `expect`, its log must match the pattern
 * or the step is red (`expectFailed`). A failed `critical` step, or the
 * deadline passing, skips every later non-`always` step.
 */
export async function runGatePlan(plan, { run = spawnStep, logDir, env, cwd, onStep = () => {}, deadline = Infinity, now = Date.now }) {
  const results = []
  let skipRest = null
  for (const [i, step] of plan.entries()) {
    const log = path.join(logDir, `${String(i + 1).padStart(2, "0")}-${step.name}.log`)
    const cmd = step.cmd ?? argvOf(step).join(" ")
    const t = now()
    if (!step.always && !skipRest && deadline - t <= 0) skipRest = "the overall deadline passed"
    if (skipRest && !step.always) {
      results.push({ name: step.name, cmd, exitCode: null, skipped: skipRest, log: null })
      onStep(results.at(-1))
      continue
    }
    const exitCode = await run(step, { log, env, cwd, timeoutMs: stepTimeout(deadline, t) })
    const r = { name: step.name, cmd, exitCode, log, ...(step.always ? { always: true } : {}) }
    if (exitCode === 0 && typeof step.expect === "string") {
      let text = ""
      try {
        text = readFileSync(log, "utf8")
      } catch {
        text = ""
      }
      if (!new RegExp(step.expect, "m").test(text)) r.expectFailed = true
    }
    results.push(r)
    onStep(r)
    if (exitCode !== 0 && step.critical) skipRest = "an earlier critical step failed"
  }
  return results
}

/** The signal path: run every `always` step synchronously (the teardown). */
export function runAlwaysStepsSync(plan, { env, cwd, run = spawnSync }) {
  let ok = true
  for (const step of plan.filter((s) => s.always)) {
    const [cmd, ...args] = argvOf(step)
    const r = run(cmd, args, { cwd, env, stdio: "ignore", timeout: 60_000 })
    if (r.status !== 0) ok = false
  }
  return ok
}

/**
 * Delete the throwaway data directory's temp parent once the database is
 * confirmed down: `stoppedCheck` exits 0, or (with no check configured) the
 * teardown reported green. Otherwise the path is reported for a manual stop.
 * @returns {boolean} true when it was removed (or kept on request)
 */
export function cleanupDataDir(dataDir, { stoppedCheck, teardownOk, keep = false, env, cwd, run = spawnSync, write = (s) => process.stderr.write(s) }) {
  if (!dataDir || !existsSync(path.dirname(dataDir))) return true
  let down = teardownOk
  if (typeof stoppedCheck === "string" && stoppedCheck.trim()) {
    down = run("sh", ["-c", stoppedCheck], { cwd, env, stdio: "ignore", timeout: 30_000 }).status === 0
  }
  if (!down) {
    write(`mission gate: the gate database at ${dataDir} may still be running; stop it by hand, then delete the directory\n`)
    return false
  }
  if (!keep) rmSync(path.dirname(dataDir), { recursive: true, force: true })
  return true
}
