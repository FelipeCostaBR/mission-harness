#!/usr/bin/env node
/**
 * commit-boundary.mjs: the per-commit DEF-boundary rule as a tested function
 * (PLAT-134 FU-45, FU-46). Until it existed every boundary validator of
 * missions-harness-lean-context-and-lanes re-implemented the rule in scratch
 * code, round after round, and two validators could read one commit two ways.
 *
 * A commit CLAIMS the features whose `escalations[].commit` names it, a
 * recorded sha or list of shas; the mapping is data, never read from commit
 * subjects. For every path the commit touches:
 *   - an exempt path (the orchestrator-owned PRD files) needs no grant, except
 *     that `prdPath`'s diff may only ADD text (`prdAdditiveViolations`);
 *   - a forbidden path is a violation even inside a grant, unless it sits under
 *     a `forbiddenExceptions` entry;
 *   - an EXISTING architecture test (status other than A) must be named
 *     literally in a claimed feature's grant;
 *   - any other path must sit inside the grant of a claimed feature: its
 *     literal `files[]` plus its `grantExtensions[].path`, expanded by
 *     boundary.mjs's `pathWithinGlobs` (so a trailing slash matches nothing),
 *     and a commit that claims nothing may carry exempt paths only.
 * A grant counts only as it stood in mission-state.json at the commit's
 * PARENT. A grant extension counts only with the {path, at, reason, decision}
 * shape and a `decision` string EXACTLY equal to a `decisions[].decision` at
 * that parent: a reference such as "(Q2)" or a paraphrase is not a match.
 * A path covered only by a grant that first appears after the parent is
 * RETROACTIVE, and blocks like a violation until the owner acknowledges it in
 * `rules.acknowledged`: filing it as information let a validator dispose of a
 * boundary violation on its own say-so (FU-46). A commit whose subject begins
 * with an `ownerAcceptedPrefixes` entry is outside every milestone and only
 * listed.
 *
 * `commitBoundaryReport` and `prdAdditiveViolations` are pure. `runCLI` is the
 * I/O boundary: it reads the commits of a range from git and prints the report.
 */

import { readFileSync, existsSync, realpathSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { pathWithinGlobs } from "./boundary.mjs"
import { exitWith, isMainModule } from "./cli-boot.mjs"

const MARKER = /\b(?:SUPERSEDED|AMENDED)\b/
const SHA = /^[0-9a-f]{7,40}$/

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0

/**
 * The requirement lines a unified diff of the PRD deletes or rewrites. Within
 * one hunk, a deleted line is kept only when an added line extends it with a
 * SUPERSEDED or AMENDED marker, so a pure insert passes, and a rewrite, a
 * deletion, a marker set mid-line, plain text appended to a line and a moved
 * line each fail. A deleted blank line holds no requirement.
 * @param {string} diffText  `git show --format= <sha> -- <prd path>`
 * @returns {{line: string, reason: string}[]}
 */
export function prdAdditiveViolations(diffText) {
  const violations = []
  const hunks = []
  let hunk = null
  for (const raw of String(diffText ?? "").split("\n")) {
    if (raw.startsWith("@@")) {
      hunk = { deleted: [], added: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (raw.startsWith("-")) hunk.deleted.push(raw.slice(1))
    else if (raw.startsWith("+")) hunk.added.push(raw.slice(1))
  }
  for (const { deleted, added } of hunks) {
    const unused = [...added]
    for (const line of deleted) {
      if (line.trim() === "") continue
      const at = unused.findIndex((a) => a.length > line.length && a.startsWith(line) && MARKER.test(a.slice(line.length)))
      if (at !== -1) {
        unused.splice(at, 1)
        continue
      }
      violations.push({
        line,
        reason: "deleted or rewritten; the PRD may only gain text, as an AMENDMENT block or a SUPERSEDED/AMENDED marker appended to the line",
      })
    }
  }
  return violations
}

/** One recorded sha names another when the shorter, at least 7 hex digits, is a prefix of the longer. */
function sameCommit(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !SHA.test(a) || !SHA.test(b)) return false
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b)
}

function recordedCommits(escalation) {
  const c = escalation.commit
  if (typeof c === "string") return [c]
  return Array.isArray(c) ? c.filter((x) => typeof x === "string") : []
}

function escalationsOf(state) {
  return isPlainObject(state) && Array.isArray(state.escalations) ? state.escalations.filter(isPlainObject) : []
}

function decisionTexts(state) {
  const decisions = isPlainObject(state) && Array.isArray(state.decisions) ? state.decisions : []
  return new Set(decisions.filter(isPlainObject).map((d) => d.decision).filter((d) => typeof d === "string"))
}

/** Why a grantExtensions[] entry grants nothing under `decisions`, or null when it grants its path. */
function extensionProblem(ext, decisions) {
  if (!isPlainObject(ext)) return "is not an object"
  if (!isNonEmptyString(ext.path)) return "has no path"
  if (typeof ext.at !== "string" || !Number.isFinite(Date.parse(ext.at))) return "has no parseable at"
  if (!isNonEmptyString(ext.reason)) return "has no reason"
  if (!isNonEmptyString(ext.decision)) return "has no decision"
  if (!decisions.has(ext.decision)) return `names the decision ${JSON.stringify(ext.decision)}, which no decisions[] entry states word for word`
  return null
}

/**
 * The grant of feature `id` in `state`: its literal files[], its extensions
 * that grant, and the extensions that do not, with why.
 */
function grantOf(state, id) {
  const entry = escalationsOf(state).find((e) => e.id === id)
  if (!entry) return { entries: [], invalid: [] }
  const decisions = decisionTexts(state)
  const entries = Array.isArray(entry.files) ? entry.files.filter((f) => typeof f === "string") : []
  const invalid = []
  for (const ext of Array.isArray(entry.grantExtensions) ? entry.grantExtensions : []) {
    const problem = extensionProblem(ext, decisions)
    if (problem) invalid.push({ path: isPlainObject(ext) ? ext.path : undefined, problem })
    else entries.push(ext.path)
  }
  return { entries, invalid }
}

const within = (p, entries) => entries.length > 0 && pathWithinGlobs(p, entries)
const namedIn = (p, entries) => entries.includes(p)

/**
 * The DEF-boundary report for `commits`, oldest first.
 * @param {Array<{sha: string, subject: string, files: {path: string, status: string}[], stateAtParent: object|null, prdDiff?: string}>} commits
 *   `files` from `git show --no-renames --name-status`, `stateAtParent` the
 *   mission-state.json at `<sha>^` (null when it did not exist), `prdDiff` the
 *   commit's diff of `rules.prdPath` when it touches it.
 * @param {object} headState  mission-state.json now, whose escalations[].commit says what each commit claims
 * @param {{exempt?: string[], forbidden?: string[], forbiddenExceptions?: string[], archTestGlobs?: string[],
 *   prdPath?: string|null, ownerAcceptedPrefixes?: string[], acknowledged?: {sha: string, path: string}[]}} rules
 * @returns {{ok: boolean, violations: object[], retroactive: object[], informational: object[], commits: object[]}}
 */
export function commitBoundaryReport(commits, headState, rules = {}) {
  if (!Array.isArray(commits)) throw new TypeError("commits must be an array")
  const exempt = rules.exempt ?? []
  const forbidden = rules.forbidden ?? []
  const forbiddenExceptions = rules.forbiddenExceptions ?? []
  const archTestGlobs = rules.archTestGlobs ?? []
  const prefixes = rules.ownerAcceptedPrefixes ?? []
  const acknowledged = Array.isArray(rules.acknowledged) ? rules.acknowledged : []
  const headEscalations = escalationsOf(headState)

  const violations = []
  const retroactive = []
  const informational = []
  const perCommit = []

  for (const commit of commits) {
    const { sha, subject = "" } = commit
    const prefix = prefixes.find((p) => subject.startsWith(p))
    if (prefix) {
      informational.push({ sha, rule: "owner-accepted", detail: `subject begins "${prefix}", accepted as-is by owner ruling` })
      perCommit.push({ sha, subject, claims: [], ownerAccepted: true })
      continue
    }
    const claims = headEscalations.filter((e) => typeof e.id === "string" && recordedCommits(e).some((c) => sameCommit(c, sha))).map((e) => e.id)
    const atParent = claims.map((id) => ({ id, ...grantOf(commit.stateAtParent, id) }))
    const atHead = claims.map((id) => ({ id, ...grantOf(headState, id) }))
    const parentEntries = atParent.flatMap((g) => g.entries)
    const headEntries = atHead.flatMap((g) => g.entries)
    const found = []
    const flag = (list, entry) => {
      list.push({ sha, ...entry })
      found.push(entry.rule)
    }
    const retro = (p, rule, feature) => {
      const ack = acknowledged.find((a) => isPlainObject(a) && a.path === p && sameCommit(a.sha, sha))
      const entry = { path: p, rule, feature, detail: `covered only by a grant of ${feature} recorded after this commit's parent` }
      if (ack) informational.push({ sha, ...entry, rule: `${rule}-acknowledged`, detail: `${entry.detail}; acknowledged by the owner` })
      else flag(retroactive, entry)
    }
    const coveringFeature = (p, grants, test) => grants.find((g) => test(p, g.entries))?.id

    for (const { path: p, status } of Array.isArray(commit.files) ? commit.files : []) {
      if (within(p, exempt)) {
        if (rules.prdPath && p === rules.prdPath) {
          for (const v of prdAdditiveViolations(commit.prdDiff)) flag(violations, { path: p, rule: "prd-rewrite", detail: `${JSON.stringify(v.line.slice(0, 120))} ${v.reason}` })
        }
        continue
      }
      if (within(p, forbidden) && !within(p, forbiddenExceptions)) {
        flag(violations, { path: p, rule: "forbidden", detail: "on the forbidden list, whatever grant covers it" })
        continue
      }
      if (within(p, archTestGlobs) && status !== "A") {
        if (namedIn(p, parentEntries)) continue
        const late = coveringFeature(p, atHead, namedIn)
        if (late) retro(p, "unnamed-architecture-test", late)
        else flag(violations, { path: p, rule: "unnamed-architecture-test", detail: "an existing architecture test no claimed feature names in its files" })
        continue
      }
      if (claims.length === 0) {
        flag(violations, { path: p, rule: "no-claim", detail: "a commit no escalations[].commit claims may carry exempt paths only" })
        continue
      }
      if (within(p, parentEntries)) continue
      const late = coveringFeature(p, atHead, within)
      if (late) {
        retro(p, "stray", late)
        continue
      }
      const unmatched = [...atParent, ...atHead].flatMap((g) => g.invalid.map((x) => ({ ...x, id: g.id }))).find((x) => typeof x.path === "string" && pathWithinGlobs(p, [x.path]))
      const slashed = [...parentEntries, ...headEntries].find((g) => g.endsWith("/") && pathWithinGlobs(p, [g.slice(0, -1)]))
      const why = unmatched
        ? `; the grant extension of ${unmatched.id} for ${unmatched.path} ${unmatched.problem}`
        : slashed
          ? `; the grant ${slashed} ends in a slash, which matches nothing`
          : ""
      flag(violations, { path: p, rule: "stray", detail: `outside the grant of ${claims.join(", ")}${why}` })
    }
    perCommit.push({ sha, subject, claims, findings: [...new Set(found)] })
  }

  return { ok: violations.length === 0 && retroactive.length === 0, violations, retroactive, informational, commits: perCommit }
}

/** git's repo-locating variables, which a git hook exports and which would outrank `-C`. */
const GIT_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]

function gitRunner(cwd) {
  const env = { ...process.env }
  for (const v of GIT_LOCATION_VARS) delete env[v]
  return (args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
}

/**
 * The commits of `range`, oldest first and merges left out, in the shape
 * `commitBoundaryReport` reads. `prdDir` is the mission's PRD folder, whose
 * mission-state.json each commit's parent is read from.
 */
export function collectCommits(range, { prdDir, prdPath = null }) {
  const root = realpathSync(prdDir)
  const top = gitRunner(root)(["rev-parse", "--show-toplevel"]).trim()
  // Run from the top: a pathspec such as prdPath is resolved against git's
  // working directory, while --name-status prints top-relative paths.
  const git = gitRunner(top)
  const stateRel = path.relative(top, path.join(root, "mission-state.json")).split(path.sep).join("/")
  const shas = git(["rev-list", "--reverse", "--no-merges", range]).split("\n").filter(Boolean)
  return shas.map((sha) => {
    const files = git(["show", "--no-renames", "--name-status", "--format=", sha])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split("\t")
        return { status: status.charAt(0), path: rest.join("\t") }
      })
    let stateAtParent = null
    try {
      stateAtParent = JSON.parse(git(["show", `${sha}^:${stateRel}`]))
    } catch {
      stateAtParent = null
    }
    const commit = { sha, subject: git(["show", "-s", "--format=%s", sha]).replace(/\n$/, ""), files, stateAtParent }
    if (prdPath && files.some((f) => f.path === prdPath)) commit.prdDiff = git(["show", "--format=", sha, "--", prdPath])
    return commit
  })
}

const USAGE =
  "usage: commit-boundary.mjs <prd-dir> <rev-range> <rules.json>\n" +
  "  rules.json: {exempt, forbidden, forbiddenExceptions, archTestGlobs, prdPath, ownerAcceptedPrefixes, acknowledged}\n" +
  "  prints the report as JSON; exit 0 clean, 1 on any violation or unacknowledged retroactive grant, 2 on a usage or read error\n"

/**
 * One invocation, returning `{exitCode, stdout, stderr}` rather than exiting,
 * so the tests drive it in-process.
 */
export function runCLI(argv) {
  const [prdDir, range, rulesPath] = argv
  if (!prdDir || !range || !rulesPath) return { exitCode: 2, stdout: "", stderr: USAGE }
  const statePath = path.join(prdDir, "mission-state.json")
  if (!existsSync(statePath)) return { exitCode: 2, stdout: "", stderr: `no mission-state.json under ${prdDir}\n` }
  let rules
  let headState
  try {
    rules = JSON.parse(readFileSync(rulesPath, "utf8"))
    headState = JSON.parse(readFileSync(statePath, "utf8"))
  } catch (e) {
    return { exitCode: 2, stdout: "", stderr: `commit-boundary: cannot read ${rulesPath} or ${statePath}: ${e.message}\n` }
  }
  if (!isPlainObject(rules)) return { exitCode: 2, stdout: "", stderr: `commit-boundary: ${rulesPath} is not a JSON object\n` }
  let commits
  try {
    commits = collectCommits(range, { prdDir, prdPath: rules.prdPath ?? null })
  } catch (e) {
    return { exitCode: 2, stdout: "", stderr: `commit-boundary: git could not read ${range}: ${String(e.stderr || e.message).trim()}\n` }
  }
  const report = commitBoundaryReport(commits, headState, rules)
  return { exitCode: report.ok ? 0 : 1, stdout: JSON.stringify(report, null, 2) + "\n", stderr: "" }
}

if (isMainModule(import.meta.url)) exitWith(runCLI(process.argv.slice(2)))
