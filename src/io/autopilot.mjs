/**
 * autopilot.mjs (io) — what the session-start hook reads to decide whether a
 * session continues an autopilot mission: the checkout's branch, and the
 * missions whose autopilot still owes work.
 *
 * A mission folder is `<missions>/<id>/` or, for a mission split into one
 * folder per milestone so parallel sessions never share a state file,
 * `<missions>/<id>/<milestone>/`. Both depths are scanned. Read-only.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { autopilotOwesWork, isSafeMissionDir } from "../rules/autopilot.mjs"

const SKIP = new Set(["handoffs", "verdicts", "node_modules"])

/** This checkout's branch name, or null (detached HEAD, not a repository). */
export function currentBranch(root) {
  try {
    const b = execFileSync("git", ["-C", root, "symbolic-ref", "--short", "-q", "HEAD"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return b || null
  } catch {
    return null
  }
}

const dirsOf = (abs) => {
  try {
    return readdirSync(abs, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_") && !SKIP.has(e.name),
    )
  } catch {
    return []
  }
}

/**
 * Every mission under `missionsRel` (relative to `root`) whose autopilot owes
 * work, most recently approved or touched first. A folder name a command line
 * could not safely carry is never returned.
 * @returns {Array<{missionDir: string, state: object}>}
 */
export function findAutopilotMissions(root, missionsRel) {
  const base = path.join(root, missionsRel)
  if (!existsSync(base)) return []
  const rel = String(missionsRel).split(path.sep).join("/").replace(/\/+$/, "")
  const folders = []
  for (const a of dirsOf(base)) {
    folders.push(`${rel}/${a.name}`)
    for (const b of dirsOf(path.join(base, a.name))) folders.push(`${rel}/${a.name}/${b.name}`)
  }
  const found = []
  for (const missionDir of folders) {
    if (!isSafeMissionDir(missionDir)) continue
    const statePath = path.join(root, missionDir, "mission-state.json")
    if (!existsSync(statePath)) continue
    let state
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"))
    } catch {
      continue
    }
    if (!autopilotOwesWork(state)) continue
    let mtime = 0
    try {
      mtime = statSync(statePath).mtimeMs
    } catch {
      mtime = 0
    }
    const approved = Date.parse(state.autopilot.approvedAt)
    found.push({ missionDir, state, at: Math.max(mtime, Number.isFinite(approved) ? approved : 0) })
  }
  return found.sort((x, y) => y.at - x.at).map(({ missionDir, state }) => ({ missionDir, state }))
}
