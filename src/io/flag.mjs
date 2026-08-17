/**
 * flag.mjs — arm / disarm / check the mission flag, cwd-proof.
 *
 * `.contractor/.active-mission` is what arms the edit-routing hook. Managing it
 * with a bare `rm .contractor/.active-mission` is fragile in a way that has
 * actually bitten: if the shell's working directory has drifted (a `cd` inside an
 * earlier compound command persists across later ones), the relative path
 * resolves under the WRONG directory, `rm -f` exits 0, and the real flag survives
 * undetected. The mission then keeps queueing edits from unrelated later work.
 *
 * So every operation here resolves the project root robustly, operates on an
 * ABSOLUTE path, then VERIFIES its own post-condition and exits non-zero if it
 * did not hold. A silent miss must never be mistakable for success.
 *
 * It also keeps `missionStatus` in mission-state.json in sync, because the hook
 * requires BOTH signals to agree before it queues anything. That is defense in
 * depth: if a disarm ever fails to remove the flag, the hook still goes inert as
 * soon as the milestone is recorded not-active.
 */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { NON_ACTIVE_STATUSES } from "../rules/bookkeeping.mjs"
import { STATE_DIRNAME } from "../config.mjs"

export const FLAG_BASENAME = ".active-mission"

export function flagPath(root) {
  return join(root, STATE_DIRNAME, FLAG_BASENAME)
}

function setMissionStatus(root, missionDir, status) {
  if (!missionDir) return false
  const statePath = join(root, missionDir, "mission-state.json")
  if (!existsSync(statePath)) return false
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    state.missionStatus = status
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n")
    return true
  } catch {
    return false // best-effort; the flag file is the primary switch
  }
}

/**
 * Arm the hook for a mission.
 * @returns {{ok: boolean, flag: string, statusWritten: boolean}}
 */
export function arm(root, missionDir) {
  if (!missionDir) throw new Error("arm requires a mission folder path")
  const flag = flagPath(root)
  mkdirSync(dirname(flag), { recursive: true })
  writeFileSync(flag, String(missionDir).trim() + "\n")
  const statusWritten = setMissionStatus(root, String(missionDir).trim(), "active")
  return { ok: existsSync(flag), flag, statusWritten }
}

/**
 * Disarm the hook and record an honest terminal status.
 *
 * The status matters: a plain disarm defaults to "halted", which would CLOBBER a
 * mission that actually finished, or one that is `gated` on an out-of-harness
 * verification step. Pass the real one.
 * @param {string} root
 * @param {"halted"|"gated"|"done"} [status]
 * @param {string} [missionDirFallback] used when the flag is already gone
 */
export function disarm(root, status = "halted", missionDirFallback = "") {
  if (!NON_ACTIVE_STATUSES.includes(status)) {
    throw new Error(
      `disarm status must be one of ${NON_ACTIVE_STATUSES.join(" | ")} (got "${status}")`,
    )
  }
  const flag = flagPath(root)
  // Prefer the flag (the live source of the mission path); fall back to an
  // explicit argument so a re-run can still set the status when the flag has
  // already been removed. Otherwise the status is silently never written.
  const missionDir = existsSync(flag) ? readFileSync(flag, "utf8").trim() : missionDirFallback
  rmSync(flag, { force: true })
  const statusWritten = setMissionStatus(root, missionDir, status)
  return {
    ok: !existsSync(flag), // post-condition: verify, never assume
    flag,
    missionDir,
    status,
    statusWritten,
    warning:
      !missionDir && status !== "halted"
        ? `flag already gone and no mission folder given — missionStatus="${status}" was NOT written. Re-run: contractor disarm ${status} <missionDir>`
        : null,
  }
}

/** @returns {{armed: boolean, missionDir: string|null, flag: string}} */
export function check(root) {
  const flag = flagPath(root)
  if (!existsSync(flag)) return { armed: false, missionDir: null, flag }
  return { armed: true, missionDir: readFileSync(flag, "utf8").trim(), flag }
}
