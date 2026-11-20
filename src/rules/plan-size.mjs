#!/usr/bin/env node
/**
 * plan-size.mjs: the size tier of a milestone, from how much contract text it
 * has to satisfy. PRD: docs/prd/missions-harness-model-ladder (ML-015). The
 * tier feeds `resolveSeat`'s `sizeTier` input (seat-ladder.mjs).
 *
 *   node plan-size.mjs <prd-dir> <milestone>
 *   node plan-size.mjs <prd-dir> --assertions <comma-separated ids>
 *
 * prints `small`, `normal` or `large` against
 * `<prd-dir>/validation-contract.json` and writes nothing. The first form
 * takes the assertions of `<milestone>` from `<prd-dir>/mission-state.json`;
 * the second takes the ids as given and reads no mission-state.json, so
 * mission-plan can compute a tier before that file exists. `planSizeTier` is
 * pure; `runCLI` returns {exitCode, stdout, stderr} and never exits the
 * process.
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { exitWith, isMainModule } from "./cli-boot.mjs"

/**
 * Below SMALL_BELOW is `small`, SMALL_BELOW up to LARGE_FROM is `normal`, and
 * LARGE_FROM or more is `large`. Both are percentiles of the plan-time spec
 * size of past milestones; the replay command, its input filter, the
 * percentile method and the output are recorded in
 * docs/prd/missions-harness-model-ladder/evidence/size-cutoffs.md, and the
 * frozen input they are computed from is size-cutoffs-input.json beside it.
 * Recut them there, never here.
 */
export const SMALL_BELOW = 1190
export const LARGE_FROM = 4604

/** Statement length in code points, which is what the replay's Python `len` counts (an emoji is 1, not 2). */
const statementLength = (assertion) => {
  const statement = assertion?.statement
  return typeof statement === "string" ? [...statement].length : 0
}

/**
 * The size of a milestone: the statement characters of the contract assertions
 * `milestone.assertions` names, `DEF-` ids excluded (the DEF- assertions are
 * the default gates every milestone carries, so they do not measure the slice). An id the contract does not hold counts 0.
 *
 * @param {{assertions?: string[]}} milestone a mission-state milestones[] entry
 * @param {{assertions?: {id: string, statement?: string}[]}} contract
 * @returns {number}
 */
export function planSize(milestone, contract) {
  const byId = new Map()
  for (const assertion of Array.isArray(contract?.assertions) ? contract.assertions : []) {
    if (assertion && typeof assertion.id === "string") byId.set(assertion.id, assertion)
  }
  const ids = Array.isArray(milestone?.assertions) ? milestone.assertions : []
  let total = 0
  for (const id of ids) {
    if (typeof id !== "string" || id.startsWith("DEF-")) continue
    total += statementLength(byId.get(id))
  }
  return total
}

/**
 * @param {{assertions?: string[]}} milestone a mission-state milestones[] entry
 * @param {{assertions?: {id: string, statement?: string}[]}} contract
 * @returns {"small" | "normal" | "large"}
 */
export function planSizeTier(milestone, contract) {
  const size = planSize(milestone, contract)
  if (size < SMALL_BELOW) return "small"
  if (size >= LARGE_FROM) return "large"
  return "normal"
}

const USAGE =
  "usage: node plan-size.mjs <prd-dir> <milestone>\n" +
  "       node plan-size.mjs <prd-dir> --assertions <comma-separated ids>\n"

const readJson = (file) => {
  if (!existsSync(file)) return { error: `${file} does not exist` }
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) }
  } catch (err) {
    return { error: `${file} is not valid JSON: ${err.message}` }
  }
}

const usage = () => ({ exitCode: 2, stdout: "", stderr: USAGE })
const fail = (message) => ({ exitCode: 1, stdout: "", stderr: `plan-size: ${message}\n` })

const parseIds = (value) =>
  value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)

export function runCLI(argv) {
  if (argv.length === 3 && argv[1] === "--assertions") {
    const [prdDir, , value] = argv
    const ids = parseIds(value)
    if (prdDir.startsWith("--") || value.startsWith("--") || ids.length === 0) return usage()
    const contract = readJson(path.join(prdDir, "validation-contract.json"))
    if (contract.error) return fail(contract.error)
    return { exitCode: 0, stdout: `${planSizeTier({ assertions: ids }, contract.value)}\n`, stderr: "" }
  }
  if (argv.length !== 2 || argv.some((word) => word.startsWith("--"))) return usage()
  const [prdDir, milestoneId] = argv
  const state = readJson(path.join(prdDir, "mission-state.json"))
  if (state.error) return fail(state.error)
  const contract = readJson(path.join(prdDir, "validation-contract.json"))
  if (contract.error) return fail(contract.error)
  const milestones = Array.isArray(state.value?.milestones) ? state.value.milestones : []
  const milestone = milestones.find((m) => m && m.id === milestoneId)
  if (!milestone) return fail(`unknown milestone "${milestoneId}" (not in milestones[].id)`)
  return { exitCode: 0, stdout: `${planSizeTier(milestone, contract.value)}\n`, stderr: "" }
}

if (isMainModule(import.meta.url)) await exitWith(runCLI(process.argv.slice(2)))
