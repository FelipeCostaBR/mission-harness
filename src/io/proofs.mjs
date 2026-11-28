/**
 * proofs.mjs — the I/O half of the evidence verbs: running the recorded
 * read-only proofs, confining their logs to a temp dir, and finding a seat's
 * transcript. Nothing here writes mission-state.json; `mission state` does,
 * under its lock.
 */

import { existsSync, readdirSync, statSync, openSync, closeSync, mkdirSync, realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { normalizeAgentId } from "../rules/evidence.mjs"

/**
 * Run every ADMISSIBLE proof command with `sh -c` in `cwd`, each one's output
 * to its own log under `logDir` (never into this process's output). An
 * inadmissible or missing proof is a red result that is never executed.
 * Nothing sandboxes an admissible command: its safety rests on the recorder
 * having stated `readOnly: true` when it was written.
 * @returns {Array<{id:string, command:string|null, exit:number|null, ok:boolean, log?:string, reason?:string}>}
 */
export function runProofs(proofs, { cwd, logDir, timeoutMs = 15 * 60_000, env = process.env, spawn = spawnSync } = {}) {
  mkdirSync(logDir, { recursive: true })
  const results = []
  let n = 0
  for (const p of proofs) {
    if (p.missing) {
      results.push({ id: p.id, command: null, exit: null, ok: false, reason: "no verifiedBy" })
      continue
    }
    for (const command of p.inadmissible ?? []) {
      results.push({ id: p.id, command, exit: null, ok: false, reason: "not admissible (needs command, evidence, readOnly:true and exit:0; amend it via upsert-escalation)" })
    }
    for (const command of p.commands) {
      n++
      const log = path.join(logDir, `vb-${n}.log`)
      const fd = openSync(log, "w")
      let exit
      try {
        const r = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", fd, fd], timeout: timeoutMs })
        exit = typeof r.status === "number" ? r.status : 124
      } finally {
        closeSync(fd)
      }
      results.push({ id: p.id, command, exit, ok: exit === 0, log })
    }
  }
  return results
}

/**
 * Resolve a directory argument and refuse it unless it lies under one of the
 * temp roots (the OS temp dir and /tmp by default), by the realpath of its
 * nearest existing ancestor, so a symlink cannot point it into the repository.
 * Returns the resolved (not yet created) path. @throws {Error}
 */
export function confineToTempRoots(input, roots = [tmpdir(), "/tmp"]) {
  const resolved = path.resolve(String(input))
  let existing = resolved
  const tail = []
  while (!existsSync(existing)) {
    const up = path.dirname(existing)
    if (up === existing) break
    tail.unshift(path.basename(existing))
    existing = up
  }
  const real = path.join(realpathSync(existing), ...tail)
  const bases = roots.filter((r) => existsSync(r)).map((r) => realpathSync(r))
  if (!bases.some((b) => real === b || real.startsWith(b + path.sep))) {
    throw new Error(`"${input}" is outside the temp roots (${bases.join(", ")}); logs never go into the repository`)
  }
  return real
}

/**
 * Find `agent-<id>.jsonl` under `dir`: directly in it, else by a bounded walk
 * (depth 4). More than one match is ambiguous and refused, so a verdict is
 * never captured from the wrong session.
 * @returns {string} absolute path @throws {Error}
 */
export function findTranscript(dir, agentId, maxDepth = 4) {
  const name = `agent-${normalizeAgentId(agentId)}.jsonl`
  if (!existsSync(dir)) throw new Error(`transcripts dir not found: ${dir}`)
  const direct = path.join(dir, name)
  if (existsSync(direct)) return direct
  const hits = []
  const walk = (d, depth) => {
    if (depth > maxDepth || hits.length > 1) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isFile() && e.name === name) hits.push(p)
      else if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(p, depth + 1)
    }
  }
  walk(dir, 0)
  if (hits.length === 0) throw new Error(`no ${name} under ${dir}`)
  if (hits.length > 1) throw new Error(`${name} is ambiguous under ${dir}: ${hits.join(", ")} (pass the session's own directory)`)
  if (!statSync(hits[0]).isFile()) throw new Error(`${hits[0]} is not a file`)
  return hits[0]
}
