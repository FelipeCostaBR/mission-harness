/**
 * queue.mjs — the edit-routing queue.
 *
 * When a mission is armed, every file a worker edits is mapped to its owning area
 * and appended here. At the milestone boundary the orchestrator drains the queue
 * to learn exactly which areas need a validator.
 *
 * ⚠️ THE QUEUE IS BEST-EFFORT AND MUST NEVER BE THE SOLE SOURCE OF SCOPE.
 *
 * Two failure modes are structural, not bugs to fix:
 *
 *   1. Worktree binding. Most agent runtimes freeze their "project directory" at
 *      session boot. A mission running in a DIFFERENT worktree than the one the
 *      session booted in resolves its flag and queue against the boot worktree,
 *      so this queue stays empty for the entire run while everything else looks
 *      fine. Probe for it at arm time and record the result, rather than
 *      discovering an empty queue at the boundary and misreading it as "no edits".
 *
 *   2. Concurrency. The queue is read-modify-write, so parallel workers racing on
 *      it lose entries. When a milestone runs a parallel batch, derive scope from
 *      the handoffs (each names its feature → area) instead.
 *
 * In both cases the fallback is the same and is always available: the union of
 * the handoff-declared areas and the areas owning the milestone's committed
 * paths. The queue is a convenience, not the record.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { pathWithinGlobs } from "../rules/boundary.mjs"
import { missionPaths } from "./mission.mjs"

/**
 * Map a repo-relative path to the area that owns it.
 * Returns null for a path no area claims — which is normal and informative:
 * cross-cutting paths (route handlers, shared kernels, generated registries) are
 * deliberately owned by nobody so a path-scoped worker cannot edit them.
 */
export function routeFileToArea(config, relPath) {
  for (const area of config.areas ?? []) {
    if (!area || !Array.isArray(area.pathGlobs)) continue
    if (pathWithinGlobs(relPath, area.pathGlobs)) return area.slug
  }
  return null
}

/** Every path in a change set that no area owns. Feed these to the planner: they
 *  are the escalations a mission will hit, and they are much cheaper batched into
 *  one early milestone than discovered one at a time across five later ones. */
export function unownedPaths(config, relPaths) {
  return relPaths.filter((p) => routeFileToArea(config, p) === null)
}

export function readQueue(root, missionDir) {
  const path = missionPaths(root, missionDir).queue
  if (!existsSync(path)) return { pending: [] }
  try {
    const q = JSON.parse(readFileSync(path, "utf8"))
    return Array.isArray(q.pending) ? q : { pending: [] }
  } catch {
    return { pending: [] }
  }
}

export function writeQueue(root, missionDir, queue) {
  writeFileSync(missionPaths(root, missionDir).queue, JSON.stringify(queue, null, 2) + "\n")
}

/**
 * Append edited paths to the queue, deduped on area+path.
 *
 * Entries are stamped with `mission` and `session`. Those stamps are what make
 * drain-time exclusion MECHANICAL: a second agent session working in the same
 * worktree writes entries that are indistinguishable from yours without them, and
 * excluding foreign entries by eye is exactly the kind of judgement call that
 * gets skipped at 2am on milestone five.
 *
 * @returns {number} how many entries were added or refreshed
 */
export function enqueueEdits(root, missionDir, config, relPaths, { session = null, ts } = {}) {
  const queue = readQueue(root, missionDir)
  const stamp = ts ?? new Date().toISOString()
  let changed = 0
  for (const rel of relPaths) {
    const area = routeFileToArea(config, rel)
    if (!area) continue // unowned path: not this queue's business
    const existing = queue.pending.find((q) => q.area === area && q.path === rel)
    if (existing) {
      existing.ts = stamp
      if (!existing.mission) existing.mission = missionDir
      if (!existing.session && session) existing.session = session
    } else {
      const entry = { area, path: rel, mission: missionDir, ts: stamp }
      if (session) entry.session = session
      queue.pending.push(entry)
    }
    changed++
  }
  if (changed) writeQueue(root, missionDir, queue)
  return changed
}

/**
 * Drain the queue for a mission: return the areas touched, having dropped
 * entries stamped with a different mission.
 * @returns {{areas: string[], byArea: Record<string,string[]>, dropped: number, legacy: number}}
 */
export function drainQueue(root, missionDir, { clear = false } = {}) {
  const queue = readQueue(root, missionDir)
  const byArea = {}
  let dropped = 0
  let legacy = 0
  for (const e of queue.pending) {
    if (!e || typeof e !== "object") continue
    if (e.mission == null) legacy++
    else if (e.mission !== missionDir) {
      dropped++
      continue
    }
    ;(byArea[e.area] ??= []).push(e.path)
  }
  for (const k of Object.keys(byArea)) byArea[k] = [...new Set(byArea[k])].sort()
  if (clear) writeQueue(root, missionDir, { pending: [] })
  return { areas: Object.keys(byArea).sort(), byArea, dropped, legacy }
}
