/**
 * mission.mjs — the I/O shell around a mission folder.
 *
 * The rules in `src/rules/` are pure by design. This module is the ONLY place
 * that reads or writes mission artifacts, so the rules stay testable without a
 * filesystem and the artifacts stay the single durable memory of a mission.
 *
 * A mission folder holds:
 *   spec.md                    the input specification (optional; may live elsewhere)
 *   validation-contract.json   what "done" means, written and approved BEFORE code
 *   mission-state.json         position, knowledge, telemetry, bookkeeping
 *   handoffs/<feature>.json    one per worker, written BY the worker itself
 *   verdicts/<area>.json       one per validator, the RAW returned object
 *   .pending-validation.json   the edit-routing queue (machine-local, gitignored)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { rehydrationPlan, renderRehydrationBrief } from "../rules/rehydration.mjs"

export function missionPaths(root, missionDir) {
  const dir = join(root, missionDir)
  return {
    dir,
    state: join(dir, "mission-state.json"),
    contract: join(dir, "validation-contract.json"),
    handoffs: join(dir, "handoffs"),
    verdicts: join(dir, "verdicts"),
    queue: join(dir, ".pending-validation.json"),
  }
}

export function ensureMissionDirs(root, missionDir) {
  const p = missionPaths(root, missionDir)
  mkdirSync(p.handoffs, { recursive: true })
  mkdirSync(p.verdicts, { recursive: true })
  return p
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
}

export function readState(root, missionDir) {
  return readJson(missionPaths(root, missionDir).state, null)
}

export function writeState(root, missionDir, state) {
  writeJson(missionPaths(root, missionDir).state, state)
}

const listJson = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []

/**
 * Extract the repo-relative file paths a handoff mentions.
 *
 * This is deliberately MECHANICAL rather than model-written. Artifact-trail
 * fidelity is the weakest dimension of every summarizer measured — a model asked
 * to list "the files I touched" reliably invents, merges or omits them. A regex
 * over the handoff's own prose is dumber and more truthful.
 */
const PATH_RX = /(?:^|[\s"'`(\[])([\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,8})/g

export function filesMentionedIn(handoff) {
  const text = [...(handoff?.completed ?? []), ...(handoff?.incomplete ?? [])].join("\n")
  const out = new Set()
  for (const m of text.matchAll(PATH_RX)) out.add(m[1])
  return [...out]
}

/** Read every handoff in the mission, returning the shape `rehydrationPlan` wants. */
export function readArtifacts(root, missionDir) {
  const p = missionPaths(root, missionDir)
  const handoffFeatures = []
  const handoffIndex = {}
  const handoffFiles = listJson(p.handoffs)
  for (const f of handoffFiles) {
    const h = readJson(join(p.handoffs, f), null)
    const feature = h?.feature ?? f.replace(/\.json$/, "")
    handoffFeatures.push(feature)
    const files = filesMentionedIn(h)
    if (files.length) handoffIndex[feature] = files
  }
  return {
    handoffFeatures,
    handoffIndex,
    handoffFiles,
    verdictMilestonePrefixes: listJson(p.verdicts).map((f) => f.replace(/\.json$/, "")),
  }
}

/**
 * Build the rehydration brief for a mission — the ≤6KB digest a fresh
 * orchestrator context reads INSTEAD of re-reading every artifact.
 * @returns {{plan: object, brief: string}}
 */
export function buildBrief(root, missionDir) {
  const state = readState(root, missionDir)
  if (!state) throw new Error(`No mission-state.json in ${missionDir}`)
  const artifacts = readArtifacts(root, missionDir)
  const plan = rehydrationPlan(state, artifacts)
  return { plan, brief: renderRehydrationBrief(plan), artifacts }
}

/** A fresh, schema-valid mission-state for `contractor mission new`. */
export function newMissionState(missionDir, { name = "", seats = {} } = {}) {
  return {
    mission: missionDir,
    name,
    missionStatus: "halted",
    milestones: [],
    currentMilestone: null,
    assertionStatus: {},
    activeWorker: null,
    correctiveRounds: {},
    roundLog: [],
    globalConstraints: [],
    procedures: {},
    escalations: [],
    budget: { total: null, byMilestone: {} },
    followUps: [],
    boundaryNotes: {},
    decisions: [],
    constraints: [],
    simplifyPasses: {},
    seats,
  }
}

/** The empty contract `mission-plan` fills in. */
export function newContract(missionDir) {
  return { spec: missionDir, assertions: [] }
}
