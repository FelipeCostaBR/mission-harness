#!/usr/bin/env node
/**
 * mission-state-cli.mjs — the missions-harness bookkeeping CLI.
 *
 * `contractor state <missionDir> <command> [args]` is the SOLE and SAFE
 * route for every `mission-state.json` write after mission-plan's one-time
 * initial authoring — no raw edit, heredoc, `node -e` or `jq` is sanctioned.
 * Every command: (1) takes an exclusive lock on the prd-dir, (2) loads
 * `<prd-dir>/mission-state.json`, (3) computes the mutated state in memory,
 * (4) requires `checkBookkeeping` to add no new error-severity finding and
 * `resumePlan` to still parse the result, (5) refuses if the file changed since
 * it was read, (6) writes atomically (temp file + rename) ONLY after every
 * check passes — the raw evidence file (a verdict, a merged handoff) BEFORE the
 * derived state, never after — (7) prints one short confirmation line — never
 * the file, never a large slice.
 *
 * `set-assertion <id> passing` carries an extra, non-bypassable check: among
 * the `verdicts/*.json` files that record ANYTHING for `id`, the NEWEST time
 * bucket must be UNANIMOUSLY an unblocked `pass` — a top-level `verdict` of
 * `"fail"`, or a non-empty `boundaryViolations[]`/`missingDefaults[]`, blocks
 * (invariant 9's hard blockers). `record-verdict` re-derives every id it
 * touches through that SAME rule (`decideAssertionFromVerdicts`) after its raw
 * file is in hand, so the two paths cannot disagree: whatever `record-verdict`
 * writes as `passing`, `set-assertion <id> passing` would also accept.
 * `checkBookkeeping` never inspects `assertionStatus`, so without this the CLI
 * would make invariant 9 a one-line bypass. There is no flag that skips it.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  mkdirSync,
  realpathSync,
  statSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
} from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  checkBookkeeping,
  checkHandoffMeta,
  computeAdvanceReadiness,
  decisionRecords,
  NO_DEVICE_STATES,
  HYPOTHESIS_FAILED_STATE,
  MISSION_STATUSES,
  ROUND_TYPES,
  ESCALATION_WORKER_MARKER,
  ORCHESTRATOR_INLINE_MARKER,
  PLAN_DECISION_MILESTONE,
  FEATURE_SURFACES,
  QUEUE_SUBSTRATE_STATUSES,
} from "../rules/bookkeeping.mjs"
import { resumePlan } from "../rules/resume.mjs"

/** The full allowed `assertionStatus` value set, DERIVED from the same source
 *  bookkeeping.mjs and the no-device/hypothesis-gate rules already use, so this
 *  list cannot silently diverge from them. Never re-declare NO_DEVICE_STATES here. */
export const ASSERTION_STATES = Object.freeze([
  "pending",
  "passing",
  "failing",
  "inconclusive",
  HYPOTHESIS_FAILED_STATE,
  ...NO_DEVICE_STATES,
])

export const GATE_TYPES = Object.freeze(["integration", "e2e"])

/** `milestones[].status` values `set-milestone-status` accepts. resumePlan
 *  reads anything but `done` as not-done; a typo would silently look pending. */
export const MILESTONE_STATUSES = Object.freeze(["pending", "in-progress", "done"])

/** `escalations[]` field vocabularies `upsert-escalation` enforces. bookkeeping
 *  check 4b fires only for status done|in-progress, and mission-validate 2a keys
 *  on the exact `escalation-worker` marker, so a misspelling here would silently
 *  switch both off. Legacy states may carry `planned`; it reads like `pending`. */
export const ESCALATION_STATUSES = Object.freeze(["pending", "in-progress", "done", "verified"])
export const ESCALATION_ROUTES = Object.freeze(["inline", "delegate"])
export const ESCALATION_IMPLEMENTERS = Object.freeze([ESCALATION_WORKER_MARKER, ORCHESTRATOR_INLINE_MARKER])

/** The PreCompact hook's breadcrumbs: the CLI keeps only the most recent ones. */
export const COMPACTIONS_KEPT = 10

const APPEND_LISTS = Object.freeze(["followUps", "testGaps", "compactions"])
const TEST_GAP_KINDS = Object.freeze(["mocked-boundary", "behavioral-not-run", "missing-edge-cases", "impl-mirroring"])

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

/** Minimal `--flag value` / `--flag` (boolean) parser. Flags may appear
 *  anywhere; everything else is positional, in encounter order. A flag the
 *  command declares boolean takes a following word only when it is `true` or
 *  `false`, so `--replace` ahead of a positional never swallows it. */
function parseArgs(argv, flagSpecs = {}) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok.startsWith("--")) {
      const name = tok.slice(2)
      const next = argv[i + 1]
      const isBoolean = Boolean(flagSpecs[name]?.boolean)
      if (next !== undefined && !next.startsWith("--") && (!isBoolean || next === "true" || next === "false")) {
        flags[name] = next
        i++
      } else {
        flags[name] = true
      }
    } else {
      positional.push(tok)
    }
  }
  return { positional, flags }
}

const COMMAND_SPECS = {
  "set-assertion": { positionals: ["id", "state"], flags: {} },
  "add-decision": { positionals: ["milestone", "decision"], flags: { why: { required: true } } },
  "add-constraint": { positionals: ["milestone", "constraint"], flags: { impact: { required: true } } },
  "set-procedure": { positionals: ["feature", "text"], flags: {} },
  "record-verdict": { positionals: ["milestone", "path"], flags: { replace: { boolean: true } } },
  "set-gate": { positionals: ["type", "json"], flags: {} },
  "merge-meta": { positionals: ["handoffPath", "json"], flags: {} },
  "bump-round": { positionals: ["milestone"], flags: { type: { required: true }, trigger: {}, seat: {}, note: {} } },
  "set-status": { positionals: ["status"], flags: {} },
  "upsert-escalation": { positionals: ["id", "json"], flags: {} },
  "set-milestone-status": { positionals: ["milestone", "status"], flags: {} },
  "set-milestone-note": { positionals: ["milestone", "text"], flags: { replace: { boolean: true } } },
  append: { positionals: ["list", "json"], flags: {} },
  "set-note": { positionals: ["key", "json"], flags: { replace: { boolean: true } } },
  "set-field": { positionals: ["path", "json"], flags: {} },
  "add-feature": { positionals: ["milestone", "featureId"], flags: { module: {}, surface: {}, pathGlobs: {} } },
  "add-assertion": { positionals: ["milestone", "id"], flags: {} },
}

/** Every command `contractor state` accepts. */
export const COMMAND_NAMES = Object.freeze(Object.keys(COMMAND_SPECS))

/** Surfaces a feature registered mid-mission may take, when the caller passes
 *  none. `contractor state` always passes the config's surfaces{} keys. */
const DEFAULT_SURFACES = FEATURE_SURFACES

/** Set per runCLI call from opts.surfaces; read by applyCommand and the
 *  bookkeeping checks. Module-level because applyCommand predates the option. */
let NEW_FEATURE_SURFACES = DEFAULT_SURFACES

function validateArgShape(command, positional, flags) {
  const spec = COMMAND_SPECS[command]
  if (positional.length !== spec.positionals.length) {
    throw new CliError(
      `${command} expects ${spec.positionals.length} positional arg(s) (${spec.positionals.join(", ")}), got ${positional.length}`,
      2,
    )
  }
  for (const name of Object.keys(flags)) {
    if (!(name in spec.flags)) throw new CliError(`${command}: unknown flag --${name}`, 2)
  }
  for (const [name, def] of Object.entries(spec.flags)) {
    if (def.required && typeof flags[name] !== "string") {
      throw new CliError(`${command}: --${name} <value> is required`, 2)
    }
    if (name in flags && !def.boolean && typeof flags[name] !== "string") {
      throw new CliError(`${command}: --${name} needs a value`, 2)
    }
  }
  const named = {}
  spec.positionals.forEach((n, i) => (named[n] = positional[i]))
  return named
}

function findingKey(f) {
  return `${f.code}::${f.detail}`
}

/** Error-severity findings present in `after` but not in `before` (multiset
 *  diff, so a pre-existing finding repeated the same number of times is never
 *  "new"). This is the "no new error" gate every mutation must clear. */
export function newErrorFindings(before, after) {
  const remaining = new Map()
  for (const f of before) {
    if (f.severity !== "error") continue
    const k = findingKey(f)
    remaining.set(k, (remaining.get(k) ?? 0) + 1)
  }
  const fresh = []
  for (const f of after) {
    if (f.severity !== "error") continue
    const k = findingKey(f)
    const left = remaining.get(k) ?? 0
    if (left > 0) remaining.set(k, left - 1)
    else fresh.push(f)
  }
  return fresh
}

/** Per-assertion `{id: verdictWord}` from every verdict-file shape seen in the
 *  wild: the canonical `verdicts[].{id,verdict}` array (architecture.md — the
 *  majority shape), a bare `assertions[].{id,verdict}` array, the
 *  `assertions{id:{status}}` map, and `assertionsChecked[].{id,verdict}`.
 *  Neither field name nor container is assumed; all four are read, so a call
 *  cannot silently see only the minority shapes a hurried fixture used. */
export function extractPerAssertionRecords(verdictDoc) {
  const out = {}
  if (!verdictDoc || typeof verdictDoc !== "object") return out
  if (Array.isArray(verdictDoc.verdicts)) {
    for (const rec of verdictDoc.verdicts) {
      if (rec && typeof rec.id === "string" && typeof rec.verdict === "string") out[rec.id] = rec.verdict
    }
  }
  if (Array.isArray(verdictDoc.assertions)) {
    for (const rec of verdictDoc.assertions) {
      if (rec && typeof rec.id === "string" && typeof rec.verdict === "string") out[rec.id] = rec.verdict
    }
  }
  if (verdictDoc.assertions && typeof verdictDoc.assertions === "object" && !Array.isArray(verdictDoc.assertions)) {
    for (const [id, rec] of Object.entries(verdictDoc.assertions)) {
      if (rec && typeof rec.status === "string") out[id] = rec.status
    }
  }
  if (Array.isArray(verdictDoc.assertionsChecked)) {
    for (const rec of verdictDoc.assertionsChecked) {
      if (rec && typeof rec.id === "string" && typeof rec.verdict === "string") out[rec.id] = rec.verdict
    }
  }
  return out
}

function readJsonFile(filePath, label) {
  let raw
  try {
    raw = readFileSync(filePath, "utf8")
  } catch {
    throw new CliError(`${label}: cannot read ${filePath}`, 2)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new CliError(`${label}: ${filePath} is not valid JSON`, 2)
  }
}

/** True when a verdicts/ entry name should never be considered evidence: a
 *  dotfile (includes this CLI's own `.<name>.<pid>.<ts>.tmp` write-in-progress
 *  artifact) or a `*.tmp` leftover from an interrupted write. */
function isVerdictCandidate(name) {
  return name.endsWith(".json") && !name.startsWith(".") && !name.endsWith(".tmp")
}

/**
 * Invariant 9's hard blockers: a per-assertion "pass" is only a REAL pass when
 * the file's own top-level verdict is not "fail" and it carries no
 * `boundaryViolations[]`/`missingDefaults[]` (a validator can mark one
 * assertion `pass` inside a file whose OWN top-level says `fail`, or that
 * carries an unrelated hard blocker; that must still fail the bound assertion).
 */
function isBlockedVerdict(doc) {
  const topVerdict = typeof doc.verdict === "string" ? doc.verdict : null
  const boundaryViolations = Array.isArray(doc.boundaryViolations) ? doc.boundaryViolations : []
  const missingDefaults = Array.isArray(doc.missingDefaults) ? doc.missingDefaults : []
  return topVerdict === "fail" || boundaryViolations.length > 0 || missingDefaults.length > 0
}

/** `validatedAt` as a timestamp, or null when absent/unparseable. */
export function parseValidatedAt(doc) {
  const t = doc && typeof doc.validatedAt === "string" ? Date.parse(doc.validatedAt) : NaN
  return Number.isFinite(t) ? t : null
}

/** The effective time used to rank verdict files for one assertion id:
 *  `validatedAt` when present and parseable, else the file's mtime (readdir
 *  order otherwise lets an OLDER pass outrank a NEWER fail, or vice-versa, for
 *  the same id across re-validated rounds). */
function effectiveTime(doc, filePath) {
  const validatedAt = parseValidatedAt(doc)
  if (validatedAt !== null) return validatedAt
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

/**
 * The deciding rule, over records ALREADY collected for one assertion id
 * (`{file, word, blocked, time}`). Pure, so the ranking can be tested without
 * a directory on disk.
 *
 * Only the newest time bucket counts — older files are history, never averaged
 * or OR'd together — and that bucket must be UNANIMOUS. Unanimity is what
 * closes the tie hole: `validatedAt` is date-only in most real verdicts
 * ("2026-10-20"), which `Date.parse` collapses to one millisecond, so a
 * same-day pass and fail would otherwise be ranked by readdir (filename) order
 * — an assertion would pass or fail depending on which validator's file name
 * happened to sort first. A bucket that is not unanimously an unblocked pass
 * can never decide `pass`.
 * @returns {{status:"pass"|"fail"|"indeterminate", files:string[], time:number}|null}
 */
export function decideFromRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return null
  const newest = Math.max(...records.map((r) => r.time))
  const bucket = records.filter((r) => r.time === newest)
  const files = bucket.map((r) => r.file)
  if (bucket.every((r) => r.word === "pass" && !r.blocked)) return { status: "pass", files, time: newest }
  if (bucket.some((r) => r.word === "fail" || (r.word === "pass" && r.blocked))) {
    return { status: "fail", files, time: newest }
  }
  return { status: "indeterminate", files, time: newest }
}

/**
 * Collect every verdict record for `id` under `<prdDir>/verdicts/` and decide
 * through `decideFromRecords`. A file that fails to parse is skipped, never a
 * hard error — verdicts/ is written by other agents and this CLI must not
 * become a second point of failure for their formatting.
 *
 * `pending` (`{file, doc, time}`) is the raw verdict a `record-verdict` is
 * about to write. It SHADOWS a same-named file on disk, because `--replace` is
 * about to overwrite that file's content — deriving from the bytes that will
 * not survive the call would decide on evidence no one can read back.
 */
export function decideAssertionFromVerdicts(prdDir, id, pending = null) {
  const records = []
  const push = (file, doc, time) => {
    const word = extractPerAssertionRecords(doc)[id]
    if (word !== undefined) records.push({ file, word, blocked: isBlockedVerdict(doc), time })
  }
  const dir = path.join(prdDir, "verdicts")
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!isVerdictCandidate(f)) continue
      if (pending && f === pending.file) continue
      const filePath = path.join(dir, f)
      let doc
      try {
        doc = JSON.parse(readFileSync(filePath, "utf8"))
      } catch {
        continue
      }
      if (!doc || typeof doc !== "object") continue
      push(f, doc, effectiveTime(doc, filePath))
    }
  }
  if (pending) push(pending.file, pending.doc, pending.time)
  return decideFromRecords(records)
}

/** True when a verdict file name belongs to `milestone`: its stem (without
 *  `.json`) is the milestone id or starts with `<milestone>-`. The single
 *  rule `record-verdict` enforces on the way in and `milestoneVerdictBlockers`
 *  reads on the way out, so a recorded verdict can never escape the re-check
 *  (`M1` never matches `M10-…`). */
export function verdictBelongsToMilestone(name, milestone) {
  const stem = String(name).replace(/\.json$/, "")
  return stem === milestone || stem.startsWith(`${milestone}-`)
}

/** A verdict file name split into its group and corrective round:
 *  `M1-auth-r2.json` → `{base: "M1-auth", round: 2}`; no suffix is round 0. */
function verdictStem(name) {
  const stem = name.replace(/\.json$/, "")
  const m = /^(.+)-r(\d+)$/.exec(stem)
  return m ? { base: m[1], round: Number(m[2]) } : { base: stem, round: 0 }
}

/**
 * The hard blockers a milestone still carries ON DISK, independent of any
 * assertion id: a 2a escalation verdict (`<m>-ESC-<id>.json`) can report
 * `boundaryViolations[]` while recording no assertion at all, so the
 * assertion-state gate alone cannot see it. Verdict files belong to `milestone`
 * when their stem is the milestone id or starts with `<milestone>-`; they are
 * grouped by name with any `-r<n>` round suffix stripped, and only the NEWEST
 * file of each group counts (`validatedAt`, else mtime; a tie goes to the
 * higher round), so a corrective round's clean re-validation supersedes the
 * round it fixed. Returns one line per blocking file, sorted.
 * @returns {string[]}
 */
export function milestoneVerdictBlockers(prdDir, milestone) {
  const dir = path.join(prdDir, "verdicts")
  if (!existsSync(dir)) return []
  const newest = new Map()
  for (const f of readdirSync(dir)) {
    if (!isVerdictCandidate(f)) continue
    if (!verdictBelongsToMilestone(f, milestone)) continue
    const { base, round } = verdictStem(f)
    const filePath = path.join(dir, f)
    let doc
    try {
      doc = JSON.parse(readFileSync(filePath, "utf8"))
    } catch {
      continue
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue
    const time = effectiveTime(doc, filePath)
    const prev = newest.get(base)
    if (!prev || time > prev.time || (time === prev.time && round > prev.round)) newest.set(base, { file: f, doc, time, round })
  }
  const blockers = []
  for (const { file, doc } of newest.values()) {
    const bv = Array.isArray(doc.boundaryViolations) ? doc.boundaryViolations.length : 0
    const md = Array.isArray(doc.missingDefaults) ? doc.missingDefaults.length : 0
    const topFail = doc.verdict === "fail"
    if (bv || md || topFail) {
      blockers.push(`verdicts/${file} (boundaryViolations=${bv}, missingDefaults=${md}${topFail ? ', verdict="fail"' : ""})`)
    }
  }
  return blockers.sort()
}

/** True when a verdict document carries something `record-verdict` can derive
 *  from or gate on: per-assertion records, or the hard-blocker arrays a 2a
 *  escalation verdict uses (its `verdicts[]` may legitimately be empty). */
function isRecordableVerdict(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false
  if (Object.keys(extractPerAssertionRecords(doc)).length > 0) return true
  return Array.isArray(doc.boundaryViolations) || Array.isArray(doc.missingDefaults) || typeof doc.verdict === "string"
}

/** Merge an incoming proof list into the stored one: an entry whose key matches
 *  a stored entry replaces it in place, anything else is appended. Nothing the
 *  caller did not name is ever dropped, so recording proofs one call at a time
 *  keeps every earlier one (mission-validate 2b re-runs the whole list). */
function mergeProofList(stored, incoming, keyOf) {
  const out = Array.isArray(stored) ? [...stored] : []
  for (const item of incoming) {
    const key = keyOf(item)
    const idx = out.findIndex((e) => e && keyOf(e) === key)
    if (idx >= 0) out[idx] = item
    else out.push(item)
  }
  return out
}

const proofCommandOf = (v) => (v && typeof v === "object" ? (v.command ?? v.cmd) : undefined)

function writeAtomic(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, filePath)
}

function clone(state) {
  return JSON.parse(JSON.stringify(state))
}

const hashOf = (s) => createHash("sha256").update(s).digest("hex")

// ── Locking (a silent lost write under concurrent CLI invocations) ──

const LOCK_STALE_MS = 60_000
const LOCK_TIMEOUT_MS = 10_000
const LOCK_RETRY_MS = 40

/** Synchronous sleep. `Atomics.wait` on the main thread is Node-legal (unlike
 *  a browser's UI thread) and keeps the whole CLI single-threaded/synchronous,
 *  matching every other I/O call here — no callback-based retry loop needed. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* engine with no SharedArrayBuffer/Atomics.wait on the main thread: busy-wait fallback */
    }
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code === "EPERM" // exists, owned by someone else
  }
}

/** Exclusive lock, `<prdDir>/.mission-state.lock`, created with `O_EXCL` so
 *  two concurrent CLI invocations against the same prd-dir cannot both enter
 *  the read-validate-write critical section. Retries with backoff up to 10s;
 *  a lock older than 60s whose recorded pid is no longer alive is presumed
 *  abandoned (a killed process) and broken. Always released by the caller's
 *  `finally`, never left for the next invocation to inherit. */
function acquireLock(prdDir) {
  const lockPath = path.join(prdDir, ".mission-state.lock")
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx")
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      closeSync(fd)
      return lockPath
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      let stat
      try {
        stat = statSync(lockPath)
      } catch {
        continue // holder released it between our open() and stat() — retry immediately
      }
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        let holderPid = null
        try {
          holderPid = JSON.parse(readFileSync(lockPath, "utf8")).pid
        } catch {
          /* corrupt/partial lock file — fall through and break it below */
        }
        if (!holderPid || !isPidAlive(holderPid)) {
          try {
            // Break only the SAME lock file judged stale: a racer may already
            // have broken it and taken a fresh lock at this path, and
            // unlinking that one would let two writers into the critical section.
            const now = statSync(lockPath)
            if (now.ino === stat.ino && now.mtimeMs === stat.mtimeMs) unlinkSync(lockPath)
          } catch {
            /* a racer broke it first — fine, just retry */
          }
          continue
        }
      }
      if (Date.now() >= deadline) {
        throw new CliError(
          `refused: could not acquire ${lockPath} within ${LOCK_TIMEOUT_MS}ms (another mission-state-cli invocation holds it — retry)`,
          1,
        )
      }
      sleepSync(LOCK_RETRY_MS)
    }
  }
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath)
  } catch {
    /* already gone (broken as stale by another racer) */
  }
}

// ── Path confinement (a traversal milestone/path could rewrite mission-state.json itself) ──

/**
 * Resolve `inputPath` against `prdDirReal` and refuse (throw) if it lands
 * outside the PRD folder. Walks up to the nearest EXISTING ancestor before
 * calling `realpathSync` (a write target — a fresh verdict, a fresh handoff —
 * may not exist yet), so a symlink escape is caught for both a read and a
 * not-yet-created write target.
 */
function resolveConfined(prdDirReal, inputPath, label) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new CliError(`${label}: path must be a non-empty string`, 2)
  }
  const resolved = path.resolve(prdDirReal, inputPath)
  let existing = resolved
  const tail = []
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    tail.unshift(path.basename(existing))
    existing = parent
  }
  let realExisting
  try {
    realExisting = realpathSync(existing)
  } catch {
    realExisting = existing
  }
  const real = tail.length ? path.join(realExisting, ...tail) : realExisting
  if (real !== prdDirReal && !real.startsWith(prdDirReal + path.sep)) {
    throw new CliError(`${label}: refused — "${inputPath}" resolves outside the PRD folder`, 1)
  }
  return real
}

/** Every milestone-taking command must be given a real `milestones[].id`
 *  (`bump-round M99`, `add-decision Mnope`, and the destination-side
 *  `record-verdict ../mission-state` traversal all used to succeed). A
 *  separator or `..` is rejected outright, before the membership check even
 *  runs. */
function assertKnownMilestone(state, milestone, label) {
  if (typeof milestone !== "string" || milestone.length === 0) {
    throw new CliError(`${label}: milestone must be a non-empty string`, 2)
  }
  if (milestone.includes("/") || milestone.includes("\\") || milestone.includes("..")) {
    throw new CliError(`${label}: milestone "${milestone}" contains a path separator or ".." — refused`, 1)
  }
  const milestones = Array.isArray(state.milestones) ? state.milestones : []
  const idx = milestones.findIndex((m) => m && m.id === milestone)
  if (idx === -1) {
    throw new CliError(`${label}: unknown milestone "${milestone}" (not in milestones[].id)`, 1)
  }
  return idx
}

/** An existing list field as an array to append to: absent/null reads as empty,
 *  an array is kept as-is, and anything else is refused rather than clobbered
 *  (spreading a non-iterable would otherwise surface as an "unexpected error"). */
function existingList(state, key, label) {
  const v = state[key]
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v
  throw new CliError(`${label}: refused — ${key} is ${typeof v}, not an array; it would be overwritten`, 1)
}

// ── set-gate history folding (a wholesale replace would destroy evidence) ──

/**
 * Fold whatever the PREVIOUS gate object held into a `history` bucket before
 * the new flat record lands, so `set-gate` can never silently delete
 * evidence: neither a milestone-keyed `{M1:{...},M2:{...}}` shape, nor a flat
 * gate that ALSO carries per-milestone history siblings, nor an earlier gate of
 * the same milestone (history keys never collide). The top level stays
 * flat — `rehydrationPlan` reads `.passed/.scope/.ts` straight off it —
 * `history` is purely additive.
 */
function foldGateHistory(prevGate, payload, { flatKeys, isFlatRecord }) {
  const prev = prevGate && typeof prevGate === "object" && !Array.isArray(prevGate) ? prevGate : {}
  const priorHistory =
    prev.history && typeof prev.history === "object" && !Array.isArray(prev.history) ? { ...prev.history } : {}
  for (const [k, v] of Object.entries(prev)) {
    if (k === "history" || flatKeys.has(k)) continue
    priorHistory[k] = v // e.g. a milestone-keyed {M1, M2, M3} record set
  }
  if (isFlatRecord(prev)) {
    const base =
      (typeof prev.milestone === "string" && prev.milestone) ||
      (typeof prev.ts === "string" && prev.ts) ||
      `prior-${Object.keys(priorHistory).length}`
    // Corrective rounds run several gates inside ONE milestone: a key that is
    // already taken gets a `#<n>` suffix, so a later gate never overwrites an
    // earlier gate's record (M1, M1#2, M1#3, …).
    let key = base
    for (let n = 2; Object.hasOwn(priorHistory, key); n++) key = `${base}#${n}`
    const record = {}
    for (const k of flatKeys) {
      if (k !== "history" && prev[k] !== undefined) record[k] = prev[k]
    }
    priorHistory[key] = record
  }
  const merged = { ...payload }
  if (Object.keys(priorHistory).length) merged.history = priorHistory
  return merged
}

// ── set-field allowlist ────────────────────────────────────────────────────

const SET_FIELD_DENY_ROOTS = new Set([
  "assertionStatus",
  "correctiveRounds",
  "adversarialRounds",
  "roundLog",
  "integrationGate",
  "milestones",
])

const SET_FIELD_ALLOW_ROOTS = new Set([
  "queueSubstrate",
  "scopeOverride",
  "missionFinalReview",
  "currentMilestone",
  "activeWorker",
  "planReview",
  "haltEvidence",
])

/** The model seats `set-field models.<seat>` may record (architecture.md
 *  "Model seats"). Informational, but D2 leaves the CLI as the only route to
 *  correct a non-canonical value. */
export const MODEL_SEATS = Object.freeze(["orchestrator", "worker", "validator"])

/** `set-field`'s explicit allowlist. Milestone-templated paths
 *  (`simplifyPasses.<m>`, `milestoneReviews.<m>`, `budget.byMilestone.<m>`)
 *  match on SHAPE here; the caller separately checks `<m>` against a real
 *  milestone id. */
function setFieldPathShape(fieldPath) {
  const segs = String(fieldPath).split(".")
  if (segs.some((s) => s.length === 0)) return null
  const root = segs[0]
  if (SET_FIELD_DENY_ROOTS.has(root)) return null
  if (segs.length === 1) return SET_FIELD_ALLOW_ROOTS.has(root) ? { kind: "scalar" } : null
  if (segs.length === 2) {
    if (root === "simplifyPasses" || root === "milestoneReviews") return { kind: "milestone-keyed", milestoneSeg: 1 }
    if (root === "models" && MODEL_SEATS.includes(segs[1])) return { kind: "model-seat" }
    return null
  }
  if (segs.length === 3 && root === "budget" && segs[1] === "byMilestone") return { kind: "budget", milestoneSeg: 2 }
  return null
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

/** Per-path VALUE shapes for `set-field`. A wrong shape is not cosmetic: a
 *  non-array or EMPTY `simplifyPasses.<m>` reads back as "pass missing" with
 *  no error (bookkeeping check 6 needs a non-empty array), and a malformed
 *  review/probe record silently answers "skipped" to the bookkeeping checks
 *  that read it. */
function assertSetFieldValueShape(fieldPath, value) {
  const root = String(fieldPath).split(".")[0]
  if (root === "simplifyPasses") {
    if (!Array.isArray(value) || value.length === 0 || !value.every((m) => typeof m === "string" && m.length > 0)) {
      throw new CliError(
        "set-field: simplifyPasses.<m> must be a NON-EMPTY array of module slugs (strings): record the modules the pass " +
          "RAN against, even when it changed nothing ([] reads back as 'pass missing')",
        1,
      )
    }
  } else if (root === "models") {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new CliError(`set-field: ${fieldPath} must be a non-empty string (a model alias such as "opus" or "sonnet")`, 1)
    }
  } else if (root === "milestoneReviews" || root === "planReview") {
    if (!isPlainObject(value) || typeof value.required !== "boolean") {
      throw new CliError(`set-field: ${fieldPath} must be an object with a boolean "required"`, 1)
    }
  } else if (root === "queueSubstrate") {
    if (!isPlainObject(value) || !QUEUE_SUBSTRATE_STATUSES.includes(value.status)) {
      throw new CliError(`set-field: queueSubstrate must be an object whose status is one of ${QUEUE_SUBSTRATE_STATUSES.join("|")}`, 1)
    }
    if (typeof value.scopeSource !== "string" || value.scopeSource.length === 0) {
      throw new CliError('set-field: queueSubstrate needs a string "scopeSource" (hook-queue | handoffs+commits)', 1)
    }
  }
}

function setDeepPath(rootObj, fieldPath, value) {
  const segs = fieldPath.split(".")
  let obj = rootObj
  for (let i = 0; i < segs.length - 1; i++) {
    const key = segs[i]
    if (obj[key] === null || obj[key] === undefined || typeof obj[key] !== "object" || Array.isArray(obj[key])) {
      obj[key] = {}
    }
    obj = obj[key]
  }
  obj[segs[segs.length - 1]] = value
}

/**
 * Build the mutated state (and, for the commands that write a second file,
 * that file's target path + content) for one command. Throws CliError on any
 * command-specific refusal. Never performs I/O beyond the reads a command
 * needs to validate itself — writing happens only in `runCLI`, after every
 * check in this function AND the shared bookkeeping/resumePlan/hash gate
 * passes.
 * @param {string} prdDirReal  realpath of the prd-dir (for path confinement)
 */
function applyCommand(command, named, flags, state, prdDirReal) {
  const next = clone(state)
  let message
  let extraFile = null
  let stateChanged = true

  switch (command) {
    case "set-assertion": {
      const { id, state: newState } = named
      if (!ASSERTION_STATES.includes(newState)) {
        throw new CliError(`set-assertion: "${newState}" is not one of ${ASSERTION_STATES.join("|")}`, 1)
      }
      if (newState === "passing") {
        const decision = decideAssertionFromVerdicts(prdDirReal, id)
        if (!decision || decision.status !== "pass") {
          throw new CliError(
            `set-assertion: refused — verdicts/ does not record an unblocked pass for "${id}" ` +
              `(only the newest time bucket decides, and EVERY record in it must be an unblocked pass; a top-level ` +
              `"fail", or a non-empty boundaryViolations/missingDefaults, blocks)` +
              (decision ? `: ${decision.files.map((f) => `verdicts/${f}`).join(", ")}` : ""),
            1,
          )
        }
        message = `set-assertion ${id} -> passing (${decision.files.map((f) => `verdicts/${f}`).join(", ")})`
      } else {
        message = `set-assertion ${id} -> ${newState}`
      }
      next.assertionStatus = { ...(next.assertionStatus ?? {}), [id]: newState }
      break
    }

    case "add-decision": {
      const { milestone, decision } = named
      // "plan" files a plan-scoped call (mission-plan 4c, or a contract change
      // taken after approval) — the same milestone value decisionRecords()
      // gives a legacy plan-time map. Every other value must be a real id.
      if (milestone !== PLAN_DECISION_MILESTONE) assertKnownMilestone(next, milestone, "add-decision")
      // A mission planned by the older mission-plan carries plan-time calls as
      // a flat `decisions{}` map, not the `decisions[]` record list. Spreading
      // that map would crash, and refusing would leave the sole write route
      // unable to record any checkpoint for the rest of the mission. So the
      // first add-decision converts it: each key becomes one plan-time record
      // (`decisionRecords`, the same reading the bookkeeping check and the
      // rehydration brief use), then the new record is appended.
      const prior = next.decisions
      let existing
      let migrated = 0
      if (prior !== null && typeof prior === "object" && !Array.isArray(prior)) {
        existing = decisionRecords(prior)
        migrated = existing.length
      } else {
        existing = existingList(next, "decisions", "add-decision")
      }
      next.decisions = [...existing, { milestone, decision, why: flags.why }]
      message =
        `add-decision ${milestone} (decisions: ${next.decisions.length}` +
        (migrated ? `; converted ${migrated} plan-time entr${migrated === 1 ? "y" : "ies"} from the legacy decisions{} map` : "") +
        `)`
      break
    }

    case "add-constraint": {
      const { milestone, constraint } = named
      if (milestone !== PLAN_DECISION_MILESTONE) assertKnownMilestone(next, milestone, "add-constraint")
      next.constraints = [...existingList(next, "constraints", "add-constraint"), { milestone, constraint, impact: flags.impact }]
      message = `add-constraint ${milestone} (constraints: ${next.constraints.length})`
      break
    }

    case "set-procedure": {
      const { feature, text } = named
      next.procedures = { ...(next.procedures ?? {}), [feature]: text }
      message = `set-procedure ${feature} (${text.length} chars)`
      break
    }

    case "record-verdict": {
      const { milestone, path: srcPath } = named
      assertKnownMilestone(next, milestone, "record-verdict")
      const resolvedSrc = resolveConfined(prdDirReal, srcPath, "record-verdict")
      const rawText = (() => {
        try {
          return readFileSync(resolvedSrc, "utf8")
        } catch {
          throw new CliError(`record-verdict: cannot read ${srcPath}`, 2)
        }
      })()
      let raw
      try {
        raw = JSON.parse(rawText)
      } catch {
        throw new CliError(`record-verdict: ${srcPath} is not valid JSON`, 2)
      }
      // The validator verdict schema (architecture.md) has NO top-level
      // `verdict`: a document is recordable when it carries per-assertion
      // records, or the hard-blocker arrays a 2a escalation verdict uses (its
      // `verdicts[]` may be empty). An optional top-level `verdict` is still
      // honoured by isBlockedVerdict ("fail" blocks every pass in the file).
      if (!isRecordableVerdict(raw)) {
        throw new CliError(
          `record-verdict: ${srcPath} records nothing — expected a JSON object with verdicts[] ` +
            `({id, verdict} records), or boundaryViolations[]/missingDefaults[] arrays`,
          1,
        )
      }
      // Destination is the SOURCE's own basename — never `<milestone>.json`
      // (two verdicts recorded in one milestone used to collide into a single
      // file, silently deleting the evidence backing an already-derived
      // "passing").
      const basename = path.basename(resolvedSrc)
      // A name the deciding scan skips (dotfile, `*.tmp`, not `*.json`) would be
      // written as evidence that can never be read back, so the status derived
      // here would be one set-assertion refuses a second later.
      if (!isVerdictCandidate(basename)) {
        throw new CliError(
          `record-verdict: refused — "${basename}" is not a readable verdict name under verdicts/ (must be *.json, not a dotfile or *.tmp)`,
          1,
        )
      }
      // The milestone positional binds the file NAME: set-milestone-status done
      // re-checks hard blockers only in `<m>.json` / `<m>-*.json`
      // (milestoneVerdictBlockers). A 2a verdict filed as `ESC-<id>.json`
      // would carry its boundaryViolations past that re-check unseen.
      if (!verdictBelongsToMilestone(basename, milestone)) {
        throw new CliError(
          `record-verdict: refused — "${basename}" is not named for milestone ${milestone}: ` +
            `use verdicts/${milestone}-<module>[-r<n>].json (a 2a escalation verdict: ${milestone}-ESC-<id>.json), ` +
            `the name set-milestone-status re-checks for hard blockers`,
          1,
        )
      }
      const destPath = path.join(prdDirReal, "verdicts", basename)
      const touchedIds = new Set(Object.keys(extractPerAssertionRecords(raw)))
      if (existsSync(destPath)) {
        let existing
        try {
          existing = readFileSync(destPath, "utf8")
        } catch {
          existing = null
        }
        const isReplace = flags.replace === true || flags.replace === "true"
        if (existing !== null && existing !== rawText && !isReplace) {
          throw new CliError(
            `record-verdict: refused — verdicts/${basename} already exists with different content (pass --replace to overwrite)`,
            1,
          )
        }
        if (existing !== null) {
          try {
            // An id the REPLACED file recorded and the new one does not is also
            // touched: its evidence is being deleted by this very call.
            for (const id of Object.keys(extractPerAssertionRecords(JSON.parse(existing)))) touchedIds.add(id)
          } catch {
            /* unparseable prior file — it decided nothing, so it releases nothing */
          }
        }
      }
      // Derive through the SAME rule set-assertion uses, over verdicts/ WITH
      // this file counted in, not from the source document alone: an older or
      // losing pass must not overwrite a newer fail (the CLI used to write
      // `passing` for an id its own `set-assertion` refused one line later).
      const pending = { file: basename, doc: raw, time: parseValidatedAt(raw) ?? Date.now() }
      const derived = []
      const updated = { ...(next.assertionStatus ?? {}) }
      for (const id of touchedIds) {
        const decision = decideAssertionFromVerdicts(prdDirReal, id, pending)
        if (decision && decision.status === "pass") {
          updated[id] = "passing"
          derived.push(`${id}=passing`)
        } else if (decision && decision.status === "fail") {
          updated[id] = "failing"
          derived.push(`${id}=failing`)
        } else if (updated[id] === "passing") {
          // Nothing under verdicts/ still supports the claim on record: an
          // ambiguous word, a non-unanimous tie, or (on --replace) the id whose
          // only evidence this very call overwrites. Leaving `passing` would
          // leave a state set-assertion itself would refuse.
          updated[id] = "inconclusive"
          derived.push(`${id}=inconclusive`)
        }
      }
      next.assertionStatus = updated
      // Byte-for-byte copy of the source (invariant 9: "the exact JSON it
      // returned, byte-for-byte") — never a re-serialization, which would
      // silently drop the "verbatim" guarantee the raw-persist step exists for.
      extraFile = { path: destPath, content: rawText }
      message = `record-verdict ${milestone} -> verdicts/${basename}${derived.length ? ` (derived ${derived.join(", ")})` : ""}`
      break
    }

    case "set-gate": {
      const { type, json } = named
      if (!GATE_TYPES.includes(type)) throw new CliError(`set-gate: type must be one of ${GATE_TYPES.join("|")}`, 2)
      let payload
      try {
        payload = JSON.parse(json)
      } catch {
        throw new CliError("set-gate: <json> is not valid JSON", 2)
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new CliError("set-gate: <json> must be a JSON object", 2)
      }
      // Flat, never keyed by milestone: rehydrationPlan reads
      // `missionState.integrationGate.{passed,scope,ts}` straight off the top
      // level (a milestone key there reads back as passed:null), and the
      // e2eGate shape in references/architecture.md is likewise flat
      // `{areas, results, unverified, attempts, ts, milestone}`. `milestone`,
      // when present, is a FIELD inside the object, not a keying level.
      // Anything the PRIOR gate held outside that flat schema — a
      // milestone-keyed record set, or a prior flat record — is folded into
      // `.history` rather than dropped (see foldGateHistory).
      if (type === "integration") {
        if (typeof payload.passed !== "boolean") {
          throw new CliError('set-gate integration: <json> needs a boolean "passed" (rehydrationPlan reads it)', 1)
        }
        if (typeof payload.scope !== "string") {
          throw new CliError('set-gate integration: <json> needs a string "scope" (rehydrationPlan reads it)', 1)
        }
        if (typeof payload.ts !== "string") {
          throw new CliError('set-gate integration: <json> needs a string "ts" (rehydrationPlan reads it)', 1)
        }
        next.integrationGate = foldGateHistory(next.integrationGate, payload, {
          flatKeys: new Set(["passed", "scope", "ts", "commands", "milestone"]),
          isFlatRecord: (g) => typeof g.passed === "boolean",
        })
        message = `set-gate integration (passed=${payload.passed})`
      } else {
        if (!Array.isArray(payload.areas)) {
          throw new CliError('set-gate e2e: <json> needs an array "areas" (the Playwright specs/areas run)', 1)
        }
        if (payload.results === null || typeof payload.results !== "object" || Array.isArray(payload.results)) {
          throw new CliError('set-gate e2e: <json> needs an object "results" (area -> outcome)', 1)
        }
        next.e2eGate = foldGateHistory(next.e2eGate, payload, {
          flatKeys: new Set(["areas", "results", "unverified", "attempts", "ts", "milestone"]),
          isFlatRecord: (g) => Array.isArray(g.areas),
        })
        message = `set-gate e2e (areas=${payload.areas.length})`
      }
      break
    }

    case "merge-meta": {
      const { handoffPath, json } = named
      let payload
      try {
        payload = JSON.parse(json)
      } catch {
        throw new CliError("merge-meta: <json> is not valid JSON", 2)
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new CliError("merge-meta: <json> must be a JSON object", 2)
      }
      const resolved = resolveConfined(prdDirReal, handoffPath, "merge-meta")
      const handoffsRoot = path.join(prdDirReal, "handoffs")
      if (resolved !== handoffsRoot && !resolved.startsWith(handoffsRoot + path.sep)) {
        throw new CliError(`merge-meta: refused — "${handoffPath}" must resolve under prd-dir/handoffs/`, 1)
      }
      const handoff = readJsonFile(resolved, "merge-meta")
      const mergedMeta = { ...(handoff._meta ?? {}), ...payload }
      const mergedHandoff = { ...handoff, _meta: mergedMeta }
      const metaFindings = checkHandoffMeta(mergedHandoff)
      if (metaFindings.some((f) => f.severity === "error")) {
        throw new CliError(
          `merge-meta: refused — merged _meta fails checkHandoffMeta: ${metaFindings.map((f) => f.code).join(", ")}`,
          1,
        )
      }
      extraFile = { path: resolved, content: JSON.stringify(mergedHandoff, null, 2) + "\n" }
      message = `merge-meta ${handoffPath} (_meta keys: ${Object.keys(mergedMeta).length})`
      stateChanged = false
      break
    }

    case "bump-round": {
      const { milestone } = named
      assertKnownMilestone(next, milestone, "bump-round")
      const type = flags.type
      if (!ROUND_TYPES.includes(type)) throw new CliError(`bump-round: type must be one of ${ROUND_TYPES.join("|")}`, 1)
      if (type === "adversarial") {
        const adversarialRounds = next.adversarialRounds && typeof next.adversarialRounds === "object" ? next.adversarialRounds : {}
        if (adversarialRounds[milestone] === 1) {
          throw new CliError(
            `bump-round: refused — adversarialRounds.${milestone} is already 1 (mission-validate 2c runs it once per milestone)`,
            1,
          )
        }
      }
      // The roundLog entry, the correctiveRounds increment and (for adversarial)
      // the adversarialRounds marker land in ONE write: a counter bumped without
      // its log entry (or the reverse) is exactly what bookkeeping checks 2/2b
      // exist to catch, so this command never produces either half alone.
      const roundLog = Array.isArray(next.roundLog) ? next.roundLog : []
      const priorRounds = roundLog.filter((e) => e && e.milestone === milestone).map((e) => e.round)
      const round = priorRounds.length ? Math.max(...priorRounds) + 1 : 1
      const entry = { milestone, round, type, at: new Date().toISOString() }
      if (typeof flags.trigger === "string") entry.trigger = flags.trigger.split(",").map((s) => s.trim()).filter(Boolean)
      if (typeof flags.seat === "string") entry.seat = flags.seat
      if (typeof flags.note === "string") entry.note = flags.note
      next.roundLog = [...roundLog, entry]
      const CAPPED_ROUND_TYPES = ["corrective", "hardening"]
      if (CAPPED_ROUND_TYPES.includes(type)) {
        const corrective = { ...(next.correctiveRounds ?? {}) }
        corrective[milestone] = (typeof corrective[milestone] === "number" ? corrective[milestone] : 0) + 1
        next.correctiveRounds = corrective
      }
      if (type === "adversarial") {
        next.adversarialRounds = { ...(next.adversarialRounds ?? {}), [milestone]: 1 }
      }
      message = `bump-round ${milestone} round ${round} (${type})`
      break
    }

    case "set-status": {
      const { status } = named
      if (!MISSION_STATUSES.includes(status)) {
        throw new CliError(`set-status: "${status}" is not one of ${MISSION_STATUSES.join("|")}`, 1)
      }
      // `done` is terminal: it drops the mission out of the SessionStart resume
      // fallback and makes every hook inert for good. So it needs every
      // milestone done, and no milestone whose bound assertions are behaviorally
      // gated or hypothesis-failed (those bar `done`, mission-validate 4/5b). A
      // premature or wrong-mission `disarm done` is refused here, not recorded.
      if (status === "done") {
        let plan
        try {
          plan = resumePlan(next)
        } catch (e) {
          throw new CliError(`set-status: refused — "done" needs a parseable milestones[] (${e.message})`, 1)
        }
        if (!plan.allDone) {
          throw new CliError(
            `set-status: refused — "done" needs every milestone done (remaining: ${plan.remainingMilestoneIds.join(", ")})`,
            1,
          )
        }
        const statuses = next.assertionStatus ?? {}
        for (const m of Array.isArray(next.milestones) ? next.milestones : []) {
          const states = {}
          for (const a of Array.isArray(m?.assertions) ? m.assertions : []) states[a] = statuses[a] ?? "pending"
          const readiness = computeAdvanceReadiness(states)
          if (readiness.behaviorallyGated || readiness.hypothesisFailed) {
            throw new CliError(
              `set-status: refused — "done" while ${m.id} is ` +
                `${readiness.behaviorallyGated ? "behaviorally gated" : "hypothesis-failed"} ` +
                `(use behaviorally-gated or halted instead)`,
              1,
            )
          }
        }
      }
      next.missionStatus = status
      message = `set-status -> ${status}`
      break
    }

    case "upsert-escalation": {
      const { id, json } = named
      if (typeof id !== "string" || id.length === 0) throw new CliError("upsert-escalation: id must be a non-empty string", 2)
      let payload
      try {
        payload = JSON.parse(json)
      } catch {
        throw new CliError("upsert-escalation: <json> is not valid JSON", 2)
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new CliError("upsert-escalation: <json> must be a JSON object", 2)
      }
      if ("id" in payload && payload.id !== id) {
        throw new CliError(`upsert-escalation: payload.id "${payload.id}" does not match positional id "${id}"`, 1)
      }
      // Closed vocabularies: bookkeeping check 4b keys on status done|in-progress,
      // and the 2a validator on the exact escalation-worker marker, so a typo
      // ("complete", "escalation-wroker") would silently switch both off.
      const enumFields = [
        ["status", ESCALATION_STATUSES],
        ["route", ESCALATION_ROUTES],
        ["implementedBy", ESCALATION_IMPLEMENTERS],
      ]
      for (const [field, allowed] of enumFields) {
        if (payload[field] !== undefined && !allowed.includes(payload[field])) {
          throw new CliError(
            `upsert-escalation: ${field} ${JSON.stringify(payload[field])} is not one of ${allowed.join("|")}`,
            1,
          )
        }
      }
      if (payload.milestone !== undefined) assertKnownMilestone(next, payload.milestone, "upsert-escalation")
      // `feature`: the orchestrator-owned (isEscalation) feature this escalation
      // implements, which is how the rehydration brief counts that feature built.
      if (payload.feature !== undefined && (typeof payload.feature !== "string" || payload.feature.length === 0)) {
        throw new CliError("upsert-escalation: feature must be the non-empty id of the feature this escalation implements", 1)
      }
      if (
        payload.workerPathGlobs !== undefined &&
        (!Array.isArray(payload.workerPathGlobs) || !payload.workerPathGlobs.every((g) => typeof g === "string" && g.length > 0))
      ) {
        throw new CliError("upsert-escalation: workerPathGlobs must be an array of non-empty strings (routeEscalation's grant)", 1)
      }
      if (payload.files !== undefined) {
        if (!Array.isArray(payload.files) || !payload.files.every((f) => typeof f === "string")) {
          throw new CliError("upsert-escalation: files must be an array of strings", 1)
        }
        const trailing = payload.files.filter((f) => f.endsWith("/"))
        if (trailing.length) {
          throw new CliError(`upsert-escalation: files[] entries must not have a trailing slash: ${trailing.join(", ")}`, 1)
        }
      }
      if (payload.verifiedBy !== undefined) {
        if (!Array.isArray(payload.verifiedBy)) throw new CliError("upsert-escalation: verifiedBy must be an array", 1)
        payload.verifiedBy.forEach((v, i) => {
          if (!v || typeof v !== "object") throw new CliError(`upsert-escalation: verifiedBy[${i}] must be an object`, 1)
          if (typeof v.command !== "string") throw new CliError(`upsert-escalation: verifiedBy[${i}].command must be a string`, 1)
          if (typeof v.exit !== "number") throw new CliError(`upsert-escalation: verifiedBy[${i}].exit must be a number`, 1)
          if (typeof v.evidence !== "string") throw new CliError(`upsert-escalation: verifiedBy[${i}].evidence must be a string`, 1)
          if (typeof v.readOnly !== "boolean") throw new CliError(`upsert-escalation: verifiedBy[${i}].readOnly must be a boolean`, 1)
          if (v.amends !== undefined && (typeof v.amends !== "string" || v.amends.length === 0)) {
            throw new CliError(`upsert-escalation: verifiedBy[${i}].amends must be the non-empty command it replaces`, 1)
          }
          // mission-validate 2b RE-RUNS these at the boundary, so the list may
          // hold nothing but commands that pass and change nothing: an exit 1
          // advances a milestone carrying a red proof, and a mutating one has a
          // validator editing tracked files to "verify".
          if (v.exit !== 0) {
            throw new CliError(
              `upsert-escalation: verifiedBy[${i}].exit must be 0 — a re-runnable proof; record a red or ` +
                `non-vacuity run under nonVacuityProofs[] ({method, result, at}) instead`,
              1,
            )
          }
          if (v.readOnly !== true) {
            throw new CliError(
              `upsert-escalation: verifiedBy[${i}].readOnly must be true — a validator re-runs this command; ` +
                `record a mutating run (plant-and-restore, ablation) under nonVacuityProofs[] ({method, result, at}) instead`,
              1,
            )
          }
        })
      }
      if (payload.nonVacuityProofs !== undefined) {
        if (!Array.isArray(payload.nonVacuityProofs)) {
          throw new CliError("upsert-escalation: nonVacuityProofs must be an array", 1)
        }
        payload.nonVacuityProofs.forEach((p, i) => {
          if (!p || typeof p !== "object" || Array.isArray(p)) {
            throw new CliError(`upsert-escalation: nonVacuityProofs[${i}] must be an object`, 1)
          }
          for (const field of ["method", "result"]) {
            if (typeof p[field] !== "string" || p[field].trim().length === 0) {
              throw new CliError(`upsert-escalation: nonVacuityProofs[${i}].${field} must be a non-empty string`, 1)
            }
          }
          if (typeof p.at !== "string" || !Number.isFinite(Date.parse(p.at))) {
            throw new CliError(`upsert-escalation: nonVacuityProofs[${i}].at must be a parseable date string`, 1)
          }
          if ("command" in p || "exit" in p) {
            throw new CliError(
              `upsert-escalation: nonVacuityProofs[${i}] must not carry command/exit — it is a RECORD of a run, ` +
                `not something a validator re-runs (that is verifiedBy)`,
              1,
            )
          }
        })
      }
      const escalations = Array.isArray(next.escalations) ? [...next.escalations] : []
      const idx = escalations.findIndex((e) => e && e.id === id)
      // CREATE needs the record's identity. No verb removes an escalation and
      // D2 forbids hand edits, so a mistyped id with a partial payload (say only
      // nonVacuityProofs) would otherwise become a permanent orphan that the
      // brief lists as open for the rest of the mission. A MERGE into an
      // existing record keeps accepting a partial payload.
      if (idx === -1) {
        const missing = []
        if (payload.milestone === undefined) missing.push("milestone (a known milestone id)")
        if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) missing.push("reason (non-empty string)")
        if (!Array.isArray(payload.files) || payload.files.length === 0 || !payload.files.every((f) => typeof f === "string" && f.length > 0)) {
          missing.push("files (non-empty array of repo-relative paths)")
        }
        if (payload.status === undefined) missing.push(`status (${ESCALATION_STATUSES.join("|")})`)
        if (missing.length) {
          throw new CliError(
            `upsert-escalation: refused — "${id}" is not a recorded escalation, and creating one needs ${missing.join(", ")}. ` +
              `If you meant an existing escalation, check the id (escalations: ${
                escalations.map((e) => e?.id).filter(Boolean).join(", ") || "none"
              })`,
            1,
          )
        }
      }
      const prior = idx >= 0 ? escalations[idx] : {}
      const merged = idx >= 0 ? { ...prior, ...payload, id } : { id, ...payload }
      // Proof lists MERGE, never replace: a call that records one more proof
      // keeps every earlier one (the 2b gate re-runs the whole list, and a red
      // proof is AMENDED, never deleted). verifiedBy entries key on `command`
      // (legacy `cmd`); a new entry carrying `amends: "<old command>"` replaces
      // exactly that entry, which is how a proof is pinned or narrowed when its
      // command string changes. nonVacuityProofs entries key on `method`.
      if (payload.verifiedBy !== undefined) {
        let list = Array.isArray(prior.verifiedBy) ? [...prior.verifiedBy] : []
        for (const [i, v] of payload.verifiedBy.entries()) {
          if (v.amends !== undefined) {
            const at = list.findIndex((e) => proofCommandOf(e) === v.amends)
            if (at === -1) {
              throw new CliError(
                `upsert-escalation: verifiedBy[${i}].amends "${v.amends}" names no stored verifiedBy command of ${id}`,
                1,
              )
            }
            list[at] = v
            list = list.filter((e, j) => j === at || proofCommandOf(e) !== v.command)
          } else {
            list = mergeProofList(list, [v], proofCommandOf)
          }
        }
        merged.verifiedBy = list
      }
      if (payload.nonVacuityProofs !== undefined) {
        merged.nonVacuityProofs = mergeProofList(prior.nonVacuityProofs, payload.nonVacuityProofs, (p) => p?.method)
      }
      if (
        (merged.route === "inline" && merged.implementedBy === ESCALATION_WORKER_MARKER) ||
        (merged.route === "delegate" && merged.implementedBy === ORCHESTRATOR_INLINE_MARKER)
      ) {
        throw new CliError(
          `upsert-escalation: route "${merged.route}" contradicts implementedBy "${merged.implementedBy}" ` +
            `(inline ⇒ orchestrator-inline, delegate ⇒ escalation-worker)`,
          1,
        )
      }
      if (idx >= 0) escalations[idx] = merged
      else escalations.push(merged)
      next.escalations = escalations
      message = `upsert-escalation ${id} (${idx >= 0 ? "merged" : "added"}; escalations: ${escalations.length})`
      break
    }

    case "set-milestone-status": {
      const { milestone, status } = named
      const idx = assertKnownMilestone(next, milestone, "set-milestone-status")
      if (typeof status !== "string" || status.length === 0) {
        throw new CliError("set-milestone-status: status must be a non-empty string", 2)
      }
      if (!MILESTONE_STATUSES.includes(status)) {
        throw new CliError(`set-milestone-status: "${status}" is not one of ${MILESTONE_STATUSES.join("|")}`, 1)
      }
      if (status === "done") {
        // Zero boundaryViolations/missingDefaults is an advance condition in its
        // own right (mission-validate step 5): a 2a escalation verdict can carry
        // them while recording no assertion, so the assertion gate below cannot
        // see it. Re-checked here from the raw files.
        const blockers = milestoneVerdictBlockers(prdDirReal, milestone)
        if (blockers.length) {
          throw new CliError(
            `set-milestone-status: refused — ${milestone} still has hard blockers on disk: ${blockers.join("; ")}`,
            1,
          )
        }
        const m = next.milestones[idx]
        const boundAssertions = Array.isArray(m.assertions) ? m.assertions : []
        const states = {}
        for (const a of boundAssertions) states[a] = (next.assertionStatus ?? {})[a] ?? "pending"
        const readiness = computeAdvanceReadiness(states)
        if (!readiness.assertionsAllPassing || readiness.behaviorallyGated || readiness.hypothesisFailed) {
          throw new CliError(
            `set-milestone-status: refused — ${milestone} is not advance-ready ` +
              `(assertionsAllPassing=${readiness.assertionsAllPassing}, behaviorallyGated=${readiness.behaviorallyGated}, ` +
              `hypothesisFailed=${readiness.hypothesisFailed}, blocking=${readiness.blocking.join(",") || "none"})`,
            1,
          )
        }
      }
      next.milestones = next.milestones.map((m, i) => (i === idx ? { ...m, status } : m))
      message = `set-milestone-status ${milestone} -> ${status}`
      break
    }

    // The sanctioned route for `milestones[].doneNote`, the one milestone write
    // mission-validate MANDATES (e.g. flagging a visual/design check that could
    // not be verified) that no other command could express — set-field denies
    // the `milestones` root outright, so without this the "sole route" rule
    // would be unfollowable for it. Every OTHER `milestones` write stays
    // denied: this command reaches `doneNote` and nothing else.
    case "set-milestone-note": {
      const { milestone, text } = named
      const idx = assertKnownMilestone(next, milestone, "set-milestone-note")
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new CliError("set-milestone-note: text must be a non-empty string", 2)
      }
      const current = next.milestones[idx].doneNote
      const isReplace = flags.replace === true || flags.replace === "true"
      if (typeof current === "string" && current !== text && !isReplace) {
        throw new CliError(
          `set-milestone-note: ${milestone} already has a doneNote — pass --replace to overwrite`,
          1,
        )
      }
      next.milestones = next.milestones.map((m, i) => (i === idx ? { ...m, doneNote: text } : m))
      message = `set-milestone-note ${milestone} (${text.length} chars)`
      break
    }

    case "append": {
      const { list, json } = named
      if (!APPEND_LISTS.includes(list)) throw new CliError(`append: list must be one of ${APPEND_LISTS.join("|")}`, 2)
      let item
      try {
        item = JSON.parse(json)
      } catch {
        throw new CliError("append: <json> is not valid JSON", 2)
      }
      if (list === "followUps") {
        if (typeof item !== "string" || item.trim().length === 0) {
          throw new CliError("append followUps: <json> must be a non-empty string", 1)
        }
      } else if (list === "compactions") {
        // The PreCompact hook's breadcrumb (mission-context.mjs): exactly
        // {at: currentMilestone|null, reason, session: session_id|null}.
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw new CliError("append compactions: <json> must be an object {at, reason, session}", 1)
        }
        const extra = Object.keys(item).filter((k) => !["at", "reason", "session"].includes(k))
        if (extra.length) throw new CliError(`append compactions: unknown key(s) ${extra.join(", ")}`, 1)
        if (!("at" in item) || (item.at !== null && typeof item.at !== "string")) {
          throw new CliError("append compactions: at must be a milestone id string or null", 1)
        }
        if (typeof item.reason !== "string" || item.reason.trim().length === 0) {
          throw new CliError("append compactions: reason must be a non-empty string", 1)
        }
        if (!("session" in item) || (item.session !== null && typeof item.session !== "string")) {
          throw new CliError("append compactions: session must be a string or null", 1)
        }
      } else {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw new CliError("append testGaps: <json> must be an object", 1)
        }
        if (typeof item.id !== "string" || item.id.length === 0) {
          throw new CliError("append testGaps: id must be a non-empty string", 1)
        }
        if (!TEST_GAP_KINDS.includes(item.kind)) {
          throw new CliError(`append testGaps: kind must be one of ${TEST_GAP_KINDS.join("|")}`, 1)
        }
        if (typeof item.detail !== "string" || item.detail.length === 0) {
          throw new CliError("append testGaps: detail must be a non-empty string", 1)
        }
        if (item.resolution !== undefined) {
          const ok = ["OPEN", "CLOSED", "ACCEPTED"].includes(item.resolution) || /^DEFERRED-TO-/.test(item.resolution)
          if (!ok) throw new CliError("append testGaps: resolution must be OPEN|CLOSED|ACCEPTED|DEFERRED-TO-<milestone>", 1)
        }
      }
      let arr = [...(Array.isArray(next[list]) ? next[list] : []), item]
      if (list === "compactions") arr = arr.slice(-COMPACTIONS_KEPT)
      next[list] = arr
      message = `append ${list} (${arr.length} total)`
      break
    }

    case "set-note": {
      const { key, json } = named
      if (typeof key !== "string" || key.length === 0) throw new CliError("set-note: key must be a non-empty string", 2)
      let value
      try {
        value = JSON.parse(json)
      } catch {
        throw new CliError("set-note: <json> is not valid JSON", 2)
      }
      const notes =
        next.boundaryNotes && typeof next.boundaryNotes === "object" && !Array.isArray(next.boundaryNotes)
          ? { ...next.boundaryNotes }
          : {}
      const isReplace = flags.replace === true || flags.replace === "true"
      if (Object.prototype.hasOwnProperty.call(notes, key) && !isReplace && JSON.stringify(notes[key]) !== JSON.stringify(value)) {
        throw new CliError(`set-note: "${key}" already exists in boundaryNotes — pass --replace to overwrite`, 1)
      }
      notes[key] = value
      next.boundaryNotes = notes
      message = `set-note ${key}`
      break
    }

    case "set-field": {
      const { path: fieldPath, json } = named
      const shape = setFieldPathShape(fieldPath)
      if (!shape) {
        throw new CliError(
          `set-field: "${fieldPath}" is not on the allowlist (queueSubstrate, scopeOverride, simplifyPasses.<m>, ` +
            `milestoneReviews.<m>, budget.byMilestone.<m>, models.<${MODEL_SEATS.join("|")}>, missionFinalReview, ` +
            `currentMilestone, activeWorker, planReview, haltEvidence)`,
          2,
        )
      }
      let value
      try {
        value = JSON.parse(json)
      } catch {
        throw new CliError("set-field: <json> is not valid JSON", 2)
      }
      if (shape.milestoneSeg !== undefined) {
        const milestoneSeg = fieldPath.split(".")[shape.milestoneSeg]
        assertKnownMilestone(next, milestoneSeg, "set-field")
      }
      if (shape.kind === "budget" && typeof value !== "number") {
        throw new CliError("set-field: budget.byMilestone.<m> must be a number", 1)
      }
      assertSetFieldValueShape(fieldPath, value)
      if (fieldPath === "currentMilestone" && value !== null) {
        if (typeof value !== "string") throw new CliError("set-field: currentMilestone must be a string milestone id or null", 1)
        assertKnownMilestone(next, value, "set-field")
      }
      setDeepPath(next, fieldPath, value)
      message = `set-field ${fieldPath}`
      break
    }

    case "add-feature": {
      const { milestone, featureId } = named
      const idx = assertKnownMilestone(next, milestone, "add-feature")
      if (typeof featureId !== "string" || featureId.length === 0) {
        throw new CliError("add-feature: featureId must be a non-empty string", 2)
      }
      const milestones = Array.isArray(next.milestones) ? next.milestones : []
      const alreadyListed = milestones.some((m) => Array.isArray(m?.features) && m.features.includes(featureId))
      if (alreadyListed) {
        throw new CliError(`add-feature: "${featureId}" is already listed in a milestone's features[]`, 1)
      }
      // An escalation is never a feature: its handoff is handoffs/ESC-<id>.json,
      // so a feature entry under its id would read as never built forever. An
      // escalation is recorded with upsert-escalation (milestone on the record).
      // Both homes count: a recorded escalations[] entry AND an id the plan
      // pre-named in some milestones[].escalations before upsert-escalation ran.
      const isEscalationId = Array.isArray(next.escalations) && next.escalations.some((e) => e && e.id === featureId)
      const preNamedIn = milestones.find(
        (m) => Array.isArray(m?.escalations) && m.escalations.some((e) => e === featureId || (e && e.id === featureId)),
      )
      if (isEscalationId || preNamedIn) {
        const where = isEscalationId ? "an escalations[] id" : `pre-named in ${preNamedIn.id}'s milestones[].escalations`
        throw new CliError(
          `add-feature: refused — "${featureId}" is ${where}; record escalations with upsert-escalation ` +
            `(its "milestone" field binds it), never as a milestone feature`,
          1,
        )
      }
      const hasProcedure =
        next.procedures && typeof next.procedures === "object" && typeof next.procedures[featureId] === "string"
      if (!hasProcedure) {
        throw new CliError(
          `add-feature: refused — procedures["${featureId}"] does not exist yet (set-procedure first)`,
          1,
        )
      }
      // The features{} entry is what mission-run builds the worker's grant from
      // and mission-validate the validator's pathGlobs from. A feature scoped
      // mid-mission (corrective, hardening) without one runs "unregistered":
      // its module and grant would live only in conversation, lost on a /clear.
      const featuresMap =
        next.features && typeof next.features === "object" && !Array.isArray(next.features) ? next.features : null
      const existingMeta = featuresMap ? featuresMap[featureId] : undefined
      const wantsMeta = flags.module !== undefined || flags.surface !== undefined || flags.pathGlobs !== undefined
      let registered = false
      if (wantsMeta) {
        if (existingMeta !== undefined) {
          throw new CliError(`add-feature: refused — features["${featureId}"] already exists; it is not overwritten`, 1)
        }
        if (typeof flags.module !== "string" || flags.module.length === 0) {
          throw new CliError("add-feature: --module <slug> is required when registering a feature", 2)
        }
        if (!NEW_FEATURE_SURFACES.includes(flags.surface)) {
          throw new CliError(
            `add-feature: --surface must be one of ${NEW_FEATURE_SURFACES.join("|")} `,
            1,
          )
        }
        let pathGlobs
        if (flags.pathGlobs !== undefined) {
          try {
            pathGlobs = JSON.parse(flags.pathGlobs)
          } catch {
            throw new CliError("add-feature: --pathGlobs is not valid JSON", 2)
          }
          if (!Array.isArray(pathGlobs) || !pathGlobs.every((g) => typeof g === "string" && g.length > 0)) {
            throw new CliError("add-feature: --pathGlobs must be a JSON array of non-empty strings (the feature's grant)", 1)
          }
        }
        if (next.features != null && !featuresMap) {
          throw new CliError("add-feature: refused — features is not an object keyed by feature id; it would be overwritten", 1)
        }
        next.features = {
          ...(featuresMap ?? {}),
          [featureId]: {
            module: flags.module,
            surface: flags.surface,
            owner: "worker",
            milestone,
            isEscalation: false,
            ...(pathGlobs ? { pathGlobs } : {}),
          },
        }
        registered = true
      } else if (existingMeta === undefined) {
        throw new CliError(
          `add-feature: refused — "${featureId}" has no features{} entry; pass --module <slug> --surface <${NEW_FEATURE_SURFACES.join("|")}> ` +
            `[--pathGlobs '<json array>'] so its worker grant and validator scope survive a reset`,
          1,
        )
      }
      next.milestones = milestones.map((m, i) =>
        i === idx ? { ...m, features: [...(Array.isArray(m.features) ? m.features : []), featureId] } : m,
      )
      message =
        `add-feature ${milestone} -> ${featureId} (features: ${next.milestones[idx].features.length}` +
        (registered ? `; registered features{} module=${flags.module}` : "") +
        `)`
      break
    }

    // Binds an assertion id to a milestone after approval (mission-run 1b, or a
    // corrective re-scope). set-field denies the `milestones` root, and an id
    // that is only in assertionStatus is never handed to a validator nor gated
    // by set-milestone-status, so this is the one route that makes it count.
    case "add-assertion": {
      const { milestone, id } = named
      const idx = assertKnownMilestone(next, milestone, "add-assertion")
      if (typeof id !== "string" || id.length === 0) {
        throw new CliError("add-assertion: id must be a non-empty string", 2)
      }
      const milestones = Array.isArray(next.milestones) ? next.milestones : []
      if (milestones[idx]?.status === "done") {
        throw new CliError(`add-assertion: refused — ${milestone} is already done; bind the assertion to a milestone still to run`, 1)
      }
      const contractPath = path.join(prdDirReal, "validation-contract.json")
      let contract
      try {
        contract = JSON.parse(readFileSync(contractPath, "utf8"))
      } catch {
        throw new CliError("add-assertion: refused — validation-contract.json is missing or not valid JSON", 1)
      }
      const contractAssertions = Array.isArray(contract?.assertions) ? contract.assertions : []
      if (!contractAssertions.some((a) => a && a.id === id)) {
        throw new CliError(`add-assertion: refused — "${id}" is not an assertion in validation-contract.json (add it there first)`, 1)
      }
      const boundTo = milestones.find((m) => Array.isArray(m?.assertions) && m.assertions.includes(id))
      if (boundTo) {
        throw new CliError(`add-assertion: refused — "${id}" is already bound to milestone ${boundTo.id}`, 1)
      }
      next.milestones = milestones.map((m, i) =>
        i === idx ? { ...m, assertions: [...(Array.isArray(m.assertions) ? m.assertions : []), id] } : m,
      )
      const statuses = { ...(next.assertionStatus ?? {}) }
      if (statuses[id] === undefined) statuses[id] = "pending"
      next.assertionStatus = statuses
      message = `add-assertion ${milestone} -> ${id} (assertions: ${next.milestones[idx].assertions.length}; status ${statuses[id]})`
      break
    }

    default:
      throw new CliError(`unknown command "${command}"`, 2)
  }

  return { next, message, extraFile, stateChanged }
}

function listHandoffFiles(prdDirReal) {
  const dir = path.join(prdDirReal, "handoffs")
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => !f.startsWith("."))
  } catch {
    return []
  }
}

/**
 * Run one CLI invocation against a real prd-dir on disk. Never calls
 * process.exit — returns `{exitCode, stdout, stderr}` so tests can drive it
 * in-process. `argv` is everything after the script path
 * (`[prdDir, command, ...rest]`).
 */
export function runCLI(argv, opts = {}) {
  let lockPath = null
  NEW_FEATURE_SURFACES = Array.isArray(opts.surfaces) && opts.surfaces.length ? opts.surfaces : DEFAULT_SURFACES
  try {
    const [prdDirArg, command, ...rest] = argv
    if (!prdDirArg || !existsSync(prdDirArg)) {
      throw new CliError(`no such prd-dir: ${prdDirArg ?? "(missing)"}`, 2)
    }
    const prdDir = realpathSync(prdDirArg)
    if (!command || !(command in COMMAND_SPECS)) {
      throw new CliError(
        `usage: contractor state <missionDir> <command> [args]\ncommands: ${Object.keys(COMMAND_SPECS).join(", ")}`,
        2,
      )
    }
    const statePath = path.join(prdDir, "mission-state.json")
    if (!existsSync(statePath)) throw new CliError(`no mission-state.json under ${prdDir}`, 2)

    const { positional, flags } = parseArgs(rest, COMMAND_SPECS[command].flags)
    const named = validateArgShape(command, positional, flags)

    lockPath = acquireLock(prdDir)

    const beforeRaw = readFileSync(statePath, "utf8")
    const beforeHash = hashOf(beforeRaw)
    let before
    try {
      before = JSON.parse(beforeRaw)
    } catch {
      throw new CliError("mission-state-cli: mission-state.json is not valid JSON", 2)
    }
    if (typeof before !== "object" || before === null || Array.isArray(before)) {
      throw new CliError("mission-state.json is not a JSON object", 2)
    }

    const { next, message, extraFile, stateChanged } = applyCommand(command, named, flags, before, prdDir)

    const handoffFiles = listHandoffFiles(prdDir)
    const findingsBefore = checkBookkeeping(before, { handoffFiles, surfaces: NEW_FEATURE_SURFACES })
    const findingsAfter = checkBookkeeping(next, { handoffFiles, surfaces: NEW_FEATURE_SURFACES })
    const fresh = newErrorFindings(findingsBefore, findingsAfter)
    if (fresh.length) {
      throw new CliError(
        `refused: this mutation introduces ${fresh.length} new bookkeeping error(s): ${fresh.map((f) => f.code).join(", ")}`,
        1,
      )
    }
    try {
      resumePlan(next)
    } catch (e) {
      throw new CliError(`refused: resumePlan no longer parses the result (${e.message})`, 1)
    }

    // Belt-and-suspenders alongside the lock: refuse if the file changed since
    // we read it (a writer that bypassed the CLI entirely — a hand edit — is
    // the one race the lock alone cannot see).
    const currentRaw = readFileSync(statePath, "utf8")
    if (hashOf(currentRaw) !== beforeHash) {
      throw new CliError("refused: mission-state.json changed since it was read (concurrent writer) — retry", 1)
    }

    // Raw evidence BEFORE derived state (invariant 9's write order): if the
    // evidence write fails, the state must never have already changed.
    if (extraFile) writeAtomic(extraFile.path, extraFile.content)
    if (stateChanged) writeAtomic(statePath, JSON.stringify(next, null, 2) + "\n")

    return { exitCode: 0, stdout: `OK ${message}\n`, stderr: "" }
  } catch (e) {
    if (e instanceof CliError) return { exitCode: e.exitCode, stdout: "", stderr: `${e.message}\n` }
    return { exitCode: 1, stdout: "", stderr: `unexpected error: ${e.message}\n` }
  } finally {
    if (lockPath) releaseLock(lockPath)
  }
}

// realpath on both sides so a symlinked invocation (a symlinked
// CLAUDE_PROJECT_DIR) or a path containing a space still resolves as "main"
// (the old `path.resolve(argv[1]) === path.resolve(new URL(...).pathname)`
// compared a raw fs path against a URL-encoded one, so EITHER shape made every
// write and every refusal a silent no-op).
const isMain = (() => {
  const argvPath = process.argv[1]
  if (!argvPath) return false
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) {
  const result = runCLI(process.argv.slice(2))
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.exitCode)
}
