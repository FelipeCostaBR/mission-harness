/**
 * config.mjs — locate, load and validate `mission.config.json`.
 *
 * The config is the ONLY place project-specific knowledge lives. Every rule in
 * `src/rules/` is pure and project-blind; every prompt in `prompts/` is written
 * against the config's vocabulary. That separation is what makes the same harness
 * run on a Rails monolith, a Go service mesh and a TypeScript monorepo.
 */

import { readFileSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { DEFAULT_SEAT_TABLE } from "./rules/seat-ladder.mjs"

export const CONFIG_FILENAME = "mission.config.json"
export const STATE_DIRNAME = ".mission"
/** Read when no mission.config.json exists: the package's name before the rename. */
export const LEGACY_CONFIG_FILENAMES = ["contractor.config.json"]

/**
 * Find the project root by walking up from `start` for a mission.config.json.
 * Falls back to the git toplevel, then to `start` itself.
 * @returns {{root: string, configPath: string|null}}
 */
export function findProjectRoot(start = process.cwd()) {
  let dir = resolve(start)
  for (;;) {
    for (const name of [CONFIG_FILENAME, ...LEGACY_CONFIG_FILENAMES]) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return { root: dir, configPath: candidate }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (top) return { root: top, configPath: null }
  } catch {
    // not a git repo — fall through
  }
  return { root: resolve(start), configPath: null }
}

/** The shape `init` scaffolds and `doctor` validates. Every field has a default
 *  so a half-filled config still runs rather than crashing at the worst moment. */
export const DEFAULT_CONFIG = {
  version: 1,
  project: { name: "", description: "" },
  paths: { missions: "docs/prd", specs: "docs/specs" },
  areas: [],
  surfaces: {},
  gates: { pre: [], integration: [] },
  protectedPaths: [],
  unownedPaths: [],
  testGlobs: [],
  additivePairs: [],
  seats: {
    orchestrator: { runtime: "session" },
    worker: { runtime: "subagent" },
    validator: { runtime: "subagent", readOnly: true },
    reviewer: { runtime: "subagent", readOnly: true },
  },
  models: {},
  // null = the built-in ladder (src/rules/seat-ladder.default.json).
  seatLadder: null,
  // Optional: archTestGlobs (existing architecture tests a grant must NAME,
  // not glob), forbiddenExceptions, ownerAcceptedPrefixes, acknowledged.
  commitBoundary: {},
  policy: {
    maxCorrectiveRounds: 2,
    parallelWorkers: true,
    simplifyPass: true,
    commitPerFeature: true,
    commitSubjectTemplate: "feat({area}): {feature}",
  },
  constraints: [],
  liveGate: { enabled: false, runner: "", skipExitCode: 78, areas: {} },
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

/** Shallow-merge defaults so an older or partial config still loads. */
function withDefaults(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...raw }
  for (const key of ["project", "paths", "gates", "seats", "policy", "liveGate"]) {
    cfg[key] = { ...DEFAULT_CONFIG[key], ...(isObj(raw?.[key]) ? raw[key] : {}) }
  }
  return cfg
}

/**
 * Load the config. Throws a human-readable error when it is missing or unparsable
 * — a silent empty config would let a mission run with no areas and no gates,
 * which looks like it is working right up until nothing is verified.
 * @param {string} [cwd]
 * @returns {{config: object, root: string, configPath: string}}
 */
export function loadConfig(cwd = process.cwd()) {
  const { root, configPath } = findProjectRoot(cwd)
  if (!configPath) {
    throw new Error(
      `No ${CONFIG_FILENAME} found in ${root} or any parent.\n` +
        `Run \`mission init\` in your project root to create one.`,
    )
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"))
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${err.message}`)
  }
  return { config: withDefaults(raw), root, configPath }
}

/** area slug -> pathGlobs, the shape `partitionDisjoint` wants. */
export function pathGlobsByArea(config) {
  const out = {}
  for (const a of config.areas ?? []) {
    if (a && typeof a.slug === "string") out[a.slug] = Array.isArray(a.pathGlobs) ? a.pathGlobs : []
  }
  return out
}

/** Find one area by slug. */
export function areaBySlug(config, slug) {
  return (config.areas ?? []).find((a) => a && a.slug === slug) ?? null
}

/**
 * Resolve an abstract seat tier ("frontier") to a concrete model id for a runtime.
 * Falls back to the tier name itself, which is what runtimes with their own tier
 * aliases (e.g. "opus"/"sonnet") want anyway.
 */
export function resolveModel(config, tier, runtime = "default") {
  const entry = config.models?.[tier]
  if (!entry) return tier
  if (typeof entry === "string") return entry
  return entry[runtime] ?? entry.default ?? tier
}

/**
 * The seat-ladder table this project runs on: `seatLadder` from the config when
 * set (a full replacement, validated by `mission doctor`), else the default.
 */
export function seatTable(config) {
  return isObj(config?.seatLadder) ? config.seatLadder : DEFAULT_SEAT_TABLE
}

/**
 * The subset of config `routeEscalation` needs, in the shape it expects.
 */
export function escalationConfig(config) {
  return {
    protectedPaths: config.protectedPaths ?? [],
    testGlobs: config.testGlobs ?? [],
    additivePairs: config.additivePairs ?? [],
  }
}
