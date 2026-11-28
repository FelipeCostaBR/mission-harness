/**
 * node:test for mission-state-cli.mjs.
 * Run: node --test .claude/skills/run-prd-multi-agent-architecture/lib/
 *
 * Every case runs against a throwaway prd-dir under os.tmpdir(); no real
 * docs/prd/<feature>/mission-state.json is ever opened by this file.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"
import {
  runCLI,
  ASSERTION_STATES,
  GATE_TYPES,
  newErrorFindings,
  extractPerAssertionRecords,
  decideFromRecords,
  decideAssertionFromVerdicts,
  parseValidatedAt,
  COMPACTIONS_KEPT,
  milestoneVerdictBlockers,
} from "./mission-state.mjs"
import {
  NO_DEVICE_STATES,
  HYPOTHESIS_FAILED_STATE,
  MISSION_STATUSES,
  PLAN_DECISION_MILESTONE,
  checkBookkeeping,
} from "../rules/bookkeeping.mjs"
import { resumePlan } from "../rules/resume.mjs"
import { rehydrationPlan, renderRehydrationBrief } from "../rules/rehydration.mjs"

const CLI_PATH = fileURLToPath(new URL("./mission-state.mjs", import.meta.url))

function baseState(overrides = {}) {
  return {
    missionStatus: "active",
    currentMilestone: "M1",
    assertionStatus: { "A-1": "pending" },
    decisions: [],
    constraints: [],
    roundLog: [],
    correctiveRounds: {},
    procedures: {},
    integrationGate: {},
    escalations: [],
    boundaryNotes: {},
    milestones: [{ id: "M1", order: 1, status: "pending", assertions: ["A-1"] }],
    ...overrides,
  }
}

function makeTempPrd(stateOverrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mscli-test-"))
  const statePath = path.join(dir, "mission-state.json")
  writeFileSync(statePath, JSON.stringify(baseState(stateOverrides), null, 2) + "\n", "utf8")
  return { dir, statePath }
}

/** The fields `upsert-escalation` requires to CREATE a record (a merge into an
 *  existing one accepts a partial payload). */
const ESC_CREATE = Object.freeze({ milestone: "M1", reason: "shared change", files: ["packages/api/src/index.ts"], status: "pending" })

function readRaw(p) {
  return readFileSync(p, "utf8")
}
function readState(statePath) {
  return JSON.parse(readRaw(statePath))
}
function writeJson(p, doc) {
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(doc, null, 2) + "\n", "utf8")
  return p
}
function writeVerdict(dir, name, doc) {
  return writeJson(path.join(dir, "verdicts", name), doc)
}
function writeHandoff(dir, name, doc) {
  return writeJson(path.join(dir, "handoffs", name), doc)
}

function assertSingleLine(stdout) {
  const trimmed = stdout.replace(/\n$/, "")
  assert.equal(trimmed.includes("\n"), false, `expected one line, got: ${JSON.stringify(stdout)}`)
}

// --- ASSERTION_STATES derivation ---------------------------------------

test("ASSERTION_STATES is derived from bookkeeping.mjs, not a second hardcoded list", () => {
  for (const s of NO_DEVICE_STATES) assert.ok(ASSERTION_STATES.includes(s), `missing no-device state ${s}`)
  assert.ok(ASSERTION_STATES.includes(HYPOTHESIS_FAILED_STATE))
  for (const s of ["pending", "passing", "failing", "inconclusive"]) assert.ok(ASSERTION_STATES.includes(s))
  assert.equal(ASSERTION_STATES.length, 4 + NO_DEVICE_STATES.length + 1)
})

// --- set-assertion: state validation ------------------------------------

test("set-assertion rejects a state outside the allowed set (malformed call, file byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-assertion", "A-1", "totally-not-a-state"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-assertion accepts every literal + no-device + hypothesis-failed state without needing a verdict", () => {
  for (const state of ["pending", "failing", "inconclusive", HYPOTHESIS_FAILED_STATE, ...NO_DEVICE_STATES]) {
    const { dir, statePath } = makeTempPrd()
    const r = runCLI([dir, "set-assertion", "A-1", state])
    assert.equal(r.exitCode, 0, `expected ${state} to be accepted: ${r.stderr}`)
    assert.equal(readState(statePath).assertionStatus["A-1"], state)
    assertSingleLine(r.stdout)
  }
})

// --- set-assertion: the verdict-backed refusal (the point of the feature) --

test("set-assertion <id> passing is refused with NO verdicts/ directory at all (byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /verdict/i)
  assert.equal(readRaw(statePath), before)
})

test("set-assertion <id> passing is refused when verdicts/ exists but records no pass for THIS id", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "other.json", { verdict: "pass", assertionsChecked: [{ id: "B-9", verdict: "pass" }] })
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-assertion <id> passing is refused when the only record for this id is a FAIL, not a pass", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "v.json", { verdict: "fail", assertionsChecked: [{ id: "A-1", verdict: "fail" }] })
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-assertion <id> passing succeeds against the assertionsChecked[] verdict shape", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "M1-auth.json", {
    verdict: "pass",
    assertionsChecked: [{ id: "A-1", verdict: "pass", verificationMethod: "unit" }],
  })
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).assertionStatus["A-1"], "passing")
  assertSingleLine(r.stdout)
})

test("set-assertion <id> passing succeeds against the assertions{} map verdict shape", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "M1-notification.json", {
    verdict: "pass",
    assertions: { "A-1": { status: "pass", evidence: "re-ran the gate" } },
  })
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).assertionStatus["A-1"], "passing")
})

test("a verdict file that fails to parse is skipped, not a crash, and does not count as a match", () => {
  const { dir, statePath } = makeTempPrd()
  mkdirSync(path.join(dir, "verdicts"), { recursive: true })
  writeFileSync(path.join(dir, "verdicts", "broken.json"), "{ not json", "utf8")
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// --- add-decision / add-constraint / set-procedure ----------------------

test("add-decision appends {milestone, decision, why} and reports the running count", () => {
  const { dir, statePath } = makeTempPrd()
  const r = runCLI([dir, "add-decision", "M1", "challenge codes live in Postgres", "--why", "serverless has no shared memory"])
  assert.equal(r.exitCode, 0, r.stderr)
  const state = readState(statePath)
  assert.deepEqual(state.decisions, [
    { milestone: "M1", decision: "challenge codes live in Postgres", why: "serverless has no shared memory" },
  ])
  assertSingleLine(r.stdout)
})

test("add-decision without --why is a malformed call (byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "add-decision", "M1", "text with no why"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("add-decision converts a legacy plan-time decisions{} map into plan records, then appends — nothing is lost", () => {
  const legacy = { approvedAt: "2026-10-27", staffAuth: "email-code", workflowOptIn: true }
  const { dir, statePath } = makeTempPrd({ decisions: legacy })
  const r = runCLI([dir, "add-decision", "M1", "Auth.js reserved paths avoided", "--why", "our routes live at /api/auth/code/*"])
  assert.equal(r.exitCode, 0, r.stderr)
  assertSingleLine(r.stdout)
  assert.match(r.stdout, /decisions: 4; converted 3 plan-time entries from the legacy decisions\{\} map/)
  const state = readState(statePath)
  assert.equal(Array.isArray(state.decisions), true)
  assert.deepEqual(
    state.decisions.map((d) => [d.milestone, d.decision]),
    [
      [PLAN_DECISION_MILESTONE, "approvedAt: 2026-10-27"],
      [PLAN_DECISION_MILESTONE, "staffAuth: email-code"],
      [PLAN_DECISION_MILESTONE, "workflowOptIn: true"],
      ["M1", "Auth.js reserved paths avoided"],
    ],
  )
  assert.equal(checkBookkeeping(state).filter((f) => f.severity === "error").length, 0)
  // A second call is an ordinary append: no further conversion.
  const r2 = runCLI([dir, "add-decision", "M1", "second", "--why", "w"])
  assert.equal(r2.exitCode, 0, r2.stderr)
  assert.doesNotMatch(r2.stdout, /converted/)
  assert.equal(readState(statePath).decisions.length, 5)
})

test("add-decision / add-constraint refuse (never clobber) a decisions/constraints value that is neither a list nor a map", () => {
  for (const [field, args] of [
    ["decisions", ["add-decision", "M1", "text", "--why", "reason"]],
    ["constraints", ["add-constraint", "M1", "text", "--impact", "impact"]],
  ]) {
    const { dir, statePath } = makeTempPrd({ [field]: "a hand-written string" })
    const before = readRaw(statePath)
    const r = runCLI([dir, ...args])
    assert.equal(r.exitCode, 1, `${field}: ${r.stderr}`)
    assert.match(r.stderr, new RegExp(`${field} is string, not an array`))
    assert.doesNotMatch(r.stderr, /unexpected error/)
    assert.equal(readRaw(statePath), before)
  }
  // A constraints MAP is not a known legacy shape either: refused, not spread.
  const { dir, statePath } = makeTempPrd({ constraints: { a: "b" } })
  const before = readRaw(statePath)
  assert.equal(runCLI([dir, "add-constraint", "M1", "text", "--impact", "impact"]).exitCode, 1)
  assert.equal(readRaw(statePath), before)
})

test("add-constraint appends {milestone, constraint, impact}", () => {
  const { dir, statePath } = makeTempPrd()
  const r = runCLI([dir, "add-constraint", "M1", "hooks snapshot at session start", "--impact", "M3 needs a fresh session"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(readState(statePath).constraints, [
    { milestone: "M1", constraint: "hooks snapshot at session start", impact: "M3 needs a fresh session" },
  ])
})

test("add-constraint without --impact is a malformed call (byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "add-constraint", "M1", "text with no impact"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-procedure sets, and a second call overwrites, the same feature key", () => {
  const { dir, statePath } = makeTempPrd()
  runCLI([dir, "set-procedure", "WEB-auth-backend", "first draft"])
  assert.equal(readState(statePath).procedures["WEB-auth-backend"], "first draft")
  const r2 = runCLI([dir, "set-procedure", "WEB-auth-backend", "revised text"])
  assert.equal(r2.exitCode, 0)
  assert.equal(readState(statePath).procedures["WEB-auth-backend"], "revised text")
})

// --- record-verdict -------------------------------------------------------

test("record-verdict persists the raw file under verdicts/<source-basename> (never <milestone>.json) as a byte-for-byte copy, and derives pass/fail only", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": "pending", "A-2": "pending", "A-3": "pending" } })
  const srcPath = writeJson(path.join(dir, "M1-scratch-verdict.json"), {
    verdict: "pass-with-findings",
    assertionsChecked: [
      { id: "A-1", verdict: "pass" },
      { id: "A-2", verdict: "fail" },
    ],
    assertions: { "A-3": { status: "pass-with-findings", evidence: "partial" } },
  })
  const r = runCLI([dir, "record-verdict", "M1", srcPath])
  assert.equal(r.exitCode, 0, r.stderr)
  const state = readState(statePath)
  assert.equal(state.assertionStatus["A-1"], "passing")
  assert.equal(state.assertionStatus["A-2"], "failing")
  assert.equal(state.assertionStatus["A-3"], "pending") // ambiguous verdict word: left untouched, never guessed
  const dest = path.join(dir, "verdicts", "M1-scratch-verdict.json")
  assert.ok(existsSync(dest))
  assert.equal(existsSync(path.join(dir, "verdicts", "M1.json")), false) // never <milestone>.json
  assert.equal(readRaw(dest), readRaw(srcPath)) // byte-for-byte, not a re-serialization (invariant 9)
  assertSingleLine(r.stdout)
})

test("record-verdict: two calls in one milestone for two different sources leave TWO verdict files", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": "pending" } })
  const srcA = writeJson(path.join(dir, "M1-src-a.json"), { verdict: "pass", assertionsChecked: [{ id: "A-1", verdict: "pass" }] })
  const srcB = writeJson(path.join(dir, "M1-src-b.json"), { verdict: "pass", assertionsChecked: [{ id: "B-1", verdict: "pass" }] })
  const r1 = runCLI([dir, "record-verdict", "M1", srcA])
  assert.equal(r1.exitCode, 0, r1.stderr)
  const r2 = runCLI([dir, "record-verdict", "M1", srcB])
  assert.equal(r2.exitCode, 0, r2.stderr)
  assert.ok(existsSync(path.join(dir, "verdicts", "M1-src-a.json")))
  assert.ok(existsSync(path.join(dir, "verdicts", "M1-src-b.json")))
  // The first call's derived passing state must still be backed by a real file.
  const r3 = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.equal(r3.exitCode, 0, r3.stderr)
  assert.equal(readState(statePath).assertionStatus["A-1"], "passing")
})

test("record-verdict refuses to overwrite an existing DIFFERENT verdicts/ file without --replace, and byte-copies with it", () => {
  const { dir, statePath } = makeTempPrd()
  const srcPath = writeJson(path.join(dir, "M1-dup.json"), { verdict: "pass", assertionsChecked: [{ id: "A-1", verdict: "pass" }] })
  mkdirSync(path.join(dir, "verdicts"), { recursive: true })
  writeFileSync(path.join(dir, "verdicts", "M1-dup.json"), JSON.stringify({ verdict: "fail" }), "utf8")
  const before = readRaw(statePath)
  const refused = runCLI([dir, "record-verdict", "M1", srcPath])
  assert.notEqual(refused.exitCode, 0)
  assert.equal(readRaw(statePath), before)
  assert.equal(readRaw(path.join(dir, "verdicts", "M1-dup.json")), JSON.stringify({ verdict: "fail" }))
  const replaced = runCLI([dir, "record-verdict", "M1", srcPath, "--replace"])
  assert.equal(replaced.exitCode, 0, replaced.stderr)
  assert.equal(readRaw(path.join(dir, "verdicts", "M1-dup.json")), readRaw(srcPath))
})

test("record-verdict refuses an unknown milestone, and a traversal milestone (path confinement)", () => {
  const { dir, statePath } = makeTempPrd()
  const srcPath = writeJson(path.join(dir, "evil.json"), { verdict: "pass" })
  const before = readRaw(statePath)
  const unknown = runCLI([dir, "record-verdict", "Mnope", srcPath])
  assert.notEqual(unknown.exitCode, 0)
  const traversal = runCLI([dir, "record-verdict", "../mission-state", srcPath])
  assert.notEqual(traversal.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("record-verdict refuses a source path that resolves outside the PRD folder", () => {
  const { dir, statePath } = makeTempPrd()
  const outside = mkdtempSync(path.join(tmpdir(), "mscli-outside-"))
  const outsideSrc = writeJson(path.join(outside, "external.json"), { verdict: "pass" })
  const before = readRaw(statePath)
  const r = runCLI([dir, "record-verdict", "M1", outsideSrc])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("record-verdict refuses a source reached through a symlink that escapes the PRD folder", () => {
  const { dir, statePath } = makeTempPrd()
  const outside = mkdtempSync(path.join(tmpdir(), "mscli-outside-"))
  writeJson(path.join(outside, "external.json"), { verdict: "pass", verdicts: [{ id: "A-1", verdict: "pass" }] })
  symlinkSync(outside, path.join(dir, "escape"))
  const before = readRaw(statePath)
  const r = runCLI([dir, "record-verdict", "M1", "escape/external.json"])
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /outside the PRD folder/)
  assert.equal(readRaw(statePath), before)
})

test("record-verdict: a write failure on the verdict file leaves mission-state.json byte-identical (invariant 9 write order)", () => {
  const { dir, statePath } = makeTempPrd()
  const srcPath = writeJson(path.join(dir, "M1-boom.json"), { verdict: "pass", assertionsChecked: [{ id: "A-1", verdict: "pass" }] })
  // Make the destination a DIRECTORY so the raw-verdict write (EISDIR) fails —
  // it must fail BEFORE mission-state.json is touched, not after.
  mkdirSync(path.join(dir, "verdicts", "M1-boom.json"), { recursive: true })
  const before = readRaw(statePath)
  const r = runCLI([dir, "record-verdict", "M1", srcPath])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before) // byte-identical: the state write never ran because the raw-evidence write failed first
})

test("record-verdict refuses a source that records nothing (no per-assertion records, no blocker arrays), writing NEITHER file", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const [name, doc] of [
    ["empty.json", { module: "auth", validatedAt: "2026-11-02T04:00:00Z", notes: "looked fine" }],
    ["array.json", [{ id: "A-1", verdict: "pass" }]],
    ["null.json", null],
  ]) {
    const srcPath = writeJson(path.join(dir, name), doc)
    const r = runCLI([dir, "record-verdict", "M1", srcPath])
    assert.equal(r.exitCode, 1, name)
    assert.match(r.stderr, /records nothing/, name)
    assert.equal(existsSync(path.join(dir, "verdicts", name)), false, name)
  }
  assert.equal(readRaw(statePath), before)
})

test("record-verdict records the EXACT architecture.md validator verdict schema (no top-level verdict) and derives from it", () => {
  const { dir, statePath } = makeTempPrd({
    milestones: [{ id: "M1", order: 1, status: "pending", assertions: ["A-1", "A-2"] }],
    assertionStatus: { "A-1": "pending", "A-2": "pending" },
  })
  // Field for field the § "Validator verdict schema" example: module,
  // validatedAt, verdicts[], boundaryViolations[], missingDefaults[],
  // informational[], testGaps[]. No top-level `verdict` key anywhere.
  const doc = {
    module: "web-subscribe",
    validatedAt: "2026-11-02T04:00:00Z",
    verdicts: [
      { id: "A-1", verdict: "pass", evidence: "playwright: 6 passed; assert-events SUBSCRIPTION_CREATED=1", notes: "" },
      { id: "A-2", verdict: "fail", evidence: "jest: Tests: 1 failed", notes: "edge case" },
    ],
    boundaryViolations: [],
    missingDefaults: [],
    informational: [{ detail: "predates the mission", pathExisted: true }],
    testGaps: [{ id: "A-1", kind: "mocked-boundary", detail: "…", suggestedFix: "…", resolution: "OPEN" }],
  }
  assert.equal("verdict" in doc, false)
  const rawText = JSON.stringify(doc, null, 2) + "\n"
  writeFileSync(path.join(dir, "M1-web-subscribe.json"), rawText, "utf8")
  const r = runCLI([dir, "record-verdict", "M1", "M1-web-subscribe.json"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readRaw(path.join(dir, "verdicts", "M1-web-subscribe.json")), rawText) // byte-for-byte
  const state = readState(statePath)
  assert.equal(state.assertionStatus["A-1"], "passing")
  assert.equal(state.assertionStatus["A-2"], "failing")
  // and set-assertion agrees with what record-verdict derived
  assert.equal(runCLI([dir, "set-assertion", "A-1", "passing"]).exitCode, 0)
})

test("record-verdict accepts a 2a escalation verdict with an EMPTY verdicts[] and a boundaryViolation, which then bars the milestone's done", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": "passing" } })
  writeVerdict(dir, "M1-auth.json", { module: "auth", validatedAt: "2026-11-02T04:00:00Z", verdicts: [{ id: "A-1", verdict: "pass" }], boundaryViolations: [], missingDefaults: [] })
  const esc = {
    module: "ESC-E-webKernel-auth-wiring",
    validatedAt: "2026-11-02T04:05:00Z",
    verdicts: [],
    boundaryViolations: ["apps/web/app/page.tsx"],
    missingDefaults: [],
  }
  writeJson(path.join(dir, "M1-ESC-E-webKernel-auth-wiring.json"), esc)
  const rec = runCLI([dir, "record-verdict", "M1", "M1-ESC-E-webKernel-auth-wiring.json"])
  assert.equal(rec.exitCode, 0, rec.stderr)
  const before = readRaw(statePath)
  const done = runCLI([dir, "set-milestone-status", "M1", "done"])
  assert.equal(done.exitCode, 1)
  assert.match(done.stderr, /M1-ESC-E-webKernel-auth-wiring\.json \(boundaryViolations=1/)
  assert.equal(readRaw(statePath), before)
  // a corrective round's clean re-review (-r1 suffix, newer) supersedes it
  writeVerdict(dir, "M1-ESC-E-webKernel-auth-wiring-r1.json", { ...esc, validatedAt: "2026-11-02T06:00:00Z", boundaryViolations: [] })
  const after = runCLI([dir, "set-milestone-status", "M1", "done"])
  assert.equal(after.exitCode, 0, after.stderr)
})

test("record-verdict refuses an unparseable source file (byte-identical, no verdicts/ file created)", () => {
  const { dir, statePath } = makeTempPrd()
  const srcPath = path.join(dir, "not-json.json")
  writeFileSync(srcPath, "{ this is not json", "utf8")
  const before = readRaw(statePath)
  const r = runCLI([dir, "record-verdict", "M1", srcPath])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
  assert.equal(existsSync(path.join(dir, "verdicts", "M1.json")), false)
})

test("record-verdict resolves a relative path against prd-dir", () => {
  const { dir, statePath } = makeTempPrd()
  writeJson(path.join(dir, "measurements", "M1-raw.json"), { verdict: "pass", assertionsChecked: [{ id: "A-1", verdict: "pass" }] })
  const r = runCLI([dir, "record-verdict", "M1", "measurements/M1-raw.json"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).assertionStatus["A-1"], "passing")
})

// --- set-gate -------------------------------------------------------------
//
// integrationGate and e2eGate are FLAT objects, never keyed by milestone:
// rehydrationPlan reads `missionState.integrationGate.{passed,scope,ts}` off
// the top level, so a milestone-keyed write reads back as `passed: null` — the
// defect this test suite exists to catch.

test("set-gate integration writes a FLAT integrationGate, and rehydrationPlan (the real consumer) reports it, not null", () => {
  const { dir, statePath } = makeTempPrd()
  const gate = { passed: true, scope: "M1 gate: typecheck, db validate, lint, test", ts: "2026-10-22T00:00:00.000Z", milestone: "M1" }
  const r = runCLI([dir, "set-gate", "integration", JSON.stringify(gate)])
  assert.equal(r.exitCode, 0, r.stderr)
  const state = readState(statePath)
  assert.deepEqual(state.integrationGate, gate) // flat: no milestone-id key wrapping it
  const plan = rehydrationPlan(state)
  assert.deepEqual(plan.gate, { passed: true, scope: gate.scope, ts: gate.ts })
  assertSingleLine(r.stdout)
})

test("set-gate integration over a null integrationGate (a freshly planned mission) writes the flat record with no history", () => {
  const { dir, statePath } = makeTempPrd({ integrationGate: null })
  const gate = { passed: true, scope: "M1", ts: "2026-10-28T00:00:00Z" }
  const r = runCLI([dir, "set-gate", "integration", JSON.stringify(gate)])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(readState(statePath).integrationGate, gate)
})

test("set-gate integration keeps the top level FLAT on every run, and folds the prior record into .history rather than deleting it (never destroys evidence)", () => {
  const { dir, statePath } = makeTempPrd()
  runCLI([dir, "set-gate", "integration", JSON.stringify({ passed: false, scope: "M1 (red)", ts: "2026-10-21T00:00:00Z" })])
  runCLI([dir, "set-gate", "integration", JSON.stringify({ passed: true, scope: "M1 (fixed)", ts: "2026-10-22T00:00:00Z" })])
  const state = readState(statePath)
  assert.equal(state.integrationGate.passed, true)
  assert.equal(state.integrationGate.scope, "M1 (fixed)")
  assert.equal(state.integrationGate.ts, "2026-10-22T00:00:00Z")
  assert.deepEqual(state.integrationGate.history, {
    "2026-10-21T00:00:00Z": { passed: false, scope: "M1 (red)", ts: "2026-10-21T00:00:00Z" },
  })
  // rehydrationPlan reads only the flat fields — the extra history key is harmless.
  const plan = rehydrationPlan(state)
  assert.deepEqual(plan.gate, { passed: true, scope: "M1 (fixed)", ts: "2026-10-22T00:00:00Z" })
})

test("set-gate integration preserves a milestone-KEYED prior gate under .history instead of deleting it", () => {
  const { dir, statePath } = makeTempPrd({
    integrationGate: {
      M1: { passed: true, scope: "M1 gate", ts: "2026-10-01T00:00:00Z" },
      M2: { passed: true, scope: "M2 gate", ts: "2026-10-05T00:00:00Z" },
    },
  })
  const r = runCLI([dir, "set-gate", "integration", JSON.stringify({ passed: true, scope: "M3 gate", ts: "2026-10-22T00:00:00Z" })])
  assert.equal(r.exitCode, 0, r.stderr)
  const state = readState(statePath)
  assert.equal(state.integrationGate.passed, true)
  assert.equal(state.integrationGate.scope, "M3 gate")
  assert.deepEqual(state.integrationGate.history.M1, { passed: true, scope: "M1 gate", ts: "2026-10-01T00:00:00Z" })
  assert.deepEqual(state.integrationGate.history.M2, { passed: true, scope: "M2 gate", ts: "2026-10-05T00:00:00Z" })
})

test("set-gate integration refuses a payload missing passed or scope, or with an unparseable ts (byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const bad of [
    { scope: "s", ts: "2026-01-22T00:00:00Z" }, // no passed
    { passed: true, ts: "2026-01-22T00:00:00Z" }, // no scope
    { passed: true, scope: "s", ts: "t" }, // ts given but not a date
    { passed: true, scope: "s", ts: 5 }, // ts not a string
    { passed: "true", scope: "s", ts: "2026-01-22T00:00:00Z" }, // passed is a string, not boolean
  ]) {
    const r = runCLI([dir, "set-gate", "integration", JSON.stringify(bad)])
    assert.notEqual(r.exitCode, 0, JSON.stringify(bad))
  }
  assert.equal(readRaw(statePath), before)
})

test("set-gate e2e writes a FLAT e2eGate matching {areas, results, unverified, milestone, attempts, ts} (references/architecture.md)", () => {
  const { dir, statePath } = makeTempPrd()
  const gate = {
    milestone: "M1",
    areas: ["apps/web/e2e/auth-otp.spec.ts", "apps/web/e2e/shell-responsive.spec.ts"],
    results: { "apps/web/e2e/auth-otp.spec.ts": "pass", "apps/web/e2e/shell-responsive.spec.ts": "fail" },
    unverified: [],
    attempts: { "apps/web/e2e/auth-otp.spec.ts": 1, "apps/web/e2e/shell-responsive.spec.ts": 2 },
    ts: "2026-10-22T00:00:00.000Z",
  }
  const r = runCLI([dir, "set-gate", "e2e", JSON.stringify(gate)])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(readState(statePath).e2eGate, gate) // flat: no milestone-id key wrapping it
  assertSingleLine(r.stdout)
})

test("set-gate e2e refuses a payload missing areas or results (byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const noAreas = runCLI([dir, "set-gate", "e2e", JSON.stringify({ results: {} })])
  assert.notEqual(noAreas.exitCode, 0)
  const noResults = runCLI([dir, "set-gate", "e2e", JSON.stringify({ areas: ["a"] })])
  assert.notEqual(noResults.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-gate rejects a type outside integration|e2e", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-gate", "smoke", "{}"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-gate rejects invalid JSON and a non-object JSON value", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const bad1 = runCLI([dir, "set-gate", "integration", "{not json"])
  assert.notEqual(bad1.exitCode, 0)
  const bad2 = runCLI([dir, "set-gate", "integration", "[1,2,3]"])
  assert.notEqual(bad2.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// --- merge-meta ---------------------------------------------------------

test("merge-meta creates _meta on a handoff that has none, and never touches mission-state.json", () => {
  const { dir, statePath } = makeTempPrd()
  const handoffPath = writeHandoff(dir, "WEB-auth-backend.json", { feature: "WEB-auth-backend", completed: [] })
  const stateBefore = readRaw(statePath)
  const r = runCLI([dir, "merge-meta", "handoffs/WEB-auth-backend.json", JSON.stringify({ tokensSpent: 41200, attribution: "exact" })])
  assert.equal(r.exitCode, 0, r.stderr)
  const { ts, ...meta } = JSON.parse(readRaw(handoffPath))._meta
  assert.deepEqual(meta, { tokensSpent: 41200, attribution: "exact" })
  assert.ok(Math.abs(Date.parse(ts) - Date.now()) < 60_000, `ts defaults to now when omitted (got ${ts})`)
  assert.equal(readRaw(statePath), stateBefore) // merge-meta's target is the handoff, not mission-state
  assertSingleLine(r.stdout)
})

test("merge-meta merges into an existing _meta rather than replacing it (a given ts is kept as given)", () => {
  const { dir } = makeTempPrd()
  const handoffPath = writeHandoff(dir, "h.json", { feature: "h", _meta: { tokensSpent: 100, attribution: "batch" } })
  runCLI([dir, "merge-meta", "handoffs/h.json", JSON.stringify({ tokensSpent: 200, ts: "2026-01-02T00:00:00Z" })])
  assert.deepEqual(JSON.parse(readRaw(handoffPath))._meta, { tokensSpent: 200, attribution: "batch", ts: "2026-01-02T00:00:00Z" })
})

test("merge-meta refuses a merge that fails checkHandoffMeta, leaving the handoff byte-identical", () => {
  const { dir } = makeTempPrd()
  const handoffPath = writeHandoff(dir, "h.json", { feature: "h" })
  const before = readRaw(handoffPath)
  const r = runCLI([dir, "merge-meta", "handoffs/h.json", JSON.stringify({ tokensSpent: -5, attribution: "exact" })])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(handoffPath), before)
})

test("merge-meta refuses a bad attribution value", () => {
  const { dir } = makeTempPrd()
  const handoffPath = writeHandoff(dir, "h.json", { feature: "h" })
  const before = readRaw(handoffPath)
  const r = runCLI([dir, "merge-meta", "handoffs/h.json", JSON.stringify({ tokensSpent: 10, attribution: "guess" })])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(handoffPath), before)
})

test("merge-meta refuses a target outside prd-dir/handoffs/ (even one inside the PRD folder)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "merge-meta", "mission-state.json", JSON.stringify({ tokensSpent: 1, attribution: "exact" })])
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /handoffs/)
  assert.equal(readRaw(statePath), before)
})

test("merge-meta on a nonexistent handoff file is a malformed call, mission-state untouched", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "merge-meta", "handoffs/does-not-exist.json", JSON.stringify({ tokensSpent: 1, attribution: "exact" })])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// --- bump-round -------------------------------------------------------

test("bump-round appends a roundLog entry and increments correctiveRounds for a corrective round", () => {
  const { dir, statePath } = makeTempPrd()
  const r = runCLI([dir, "bump-round", "M1", "--type", "corrective", "--trigger", "WEB-004,DEF-auth-audit", "--seat", "opus", "--note", "found in review"])
  assert.equal(r.exitCode, 0, r.stderr)
  const state = readState(statePath)
  assert.equal(state.roundLog.length, 1)
  assert.equal(state.roundLog[0].milestone, "M1")
  assert.equal(state.roundLog[0].round, 1)
  assert.equal(state.roundLog[0].type, "corrective")
  assert.deepEqual(state.roundLog[0].trigger, ["WEB-004", "DEF-auth-audit"])
  assert.equal(state.roundLog[0].seat, "opus")
  assert.equal(state.roundLog[0].note, "found in review")
  assert.equal(typeof state.roundLog[0].at, "string")
  assert.equal(Number.isNaN(Date.parse(state.roundLog[0].at)), false)
  assert.equal(state.correctiveRounds.M1, 1)
  assertSingleLine(r.stdout)
})

test("bump-round numbers rounds per-milestone independently and keeps counting across calls", () => {
  const { dir, statePath } = makeTempPrd({
    milestones: [
      { id: "M1", order: 1, status: "pending", assertions: ["A-1"] },
      { id: "M2", order: 2, status: "pending", assertions: [] },
    ],
  })
  runCLI([dir, "bump-round", "M1", "--type", "corrective"])
  runCLI([dir, "bump-round", "M2", "--type", "corrective"])
  runCLI([dir, "bump-round", "M1", "--type", "hardening"])
  const state = readState(statePath)
  const m1Rounds = state.roundLog.filter((e) => e.milestone === "M1").map((e) => e.round)
  const m2Rounds = state.roundLog.filter((e) => e.milestone === "M2").map((e) => e.round)
  assert.deepEqual(m1Rounds, [1, 2])
  assert.deepEqual(m2Rounds, [1])
  assert.equal(state.correctiveRounds.M1, 2)
  assert.equal(state.correctiveRounds.M2, 1)
})

test("bump-round does NOT charge adversarial or infrastructure-halt rounds to the corrective cap", () => {
  const { dir, statePath } = makeTempPrd()
  runCLI([dir, "bump-round", "M1", "--type", "adversarial", "--trigger", "deep-investigator"])
  runCLI([dir, "bump-round", "M1", "--type", "infrastructure-halt", "--trigger", "session-limit"])
  const state = readState(statePath)
  assert.equal(state.roundLog.length, 2)
  assert.equal(state.correctiveRounds.M1 ?? 0, 0)
})

test("bump-round rejects a type outside ROUND_TYPES (malformed, byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "bump-round", "M1", "--type", "refactor"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("bump-round without --type is a malformed call", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "bump-round", "M1"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("bump-round alone changes correctiveRounds and roundLog: every other top-level field is untouched", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readState(statePath)
  runCLI([dir, "bump-round", "M1", "--type", "corrective", "--trigger", "A-1"])
  const after = readState(statePath)
  for (const key of Object.keys(before)) {
    if (key === "correctiveRounds" || key === "roundLog") continue
    assert.deepEqual(after[key], before[key], `unexpected change to ${key}`)
  }
  const afterKeys = new Set(Object.keys(after))
  for (const key of Object.keys(before)) assert.ok(afterKeys.has(key))
})

test("bump-round writes the log entry and the counter increment atomically: the result is always bookkeeping-consistent", () => {
  const { dir, statePath } = makeTempPrd({ queueSubstrate: { status: "live" } })
  for (const type of ["corrective", "hardening", "corrective"]) {
    assert.equal(runCLI([dir, "bump-round", "M1", "--type", type]).exitCode, 0)
    const state = readState(statePath)
    const capped = state.roundLog.filter((e) => e.type === "corrective" || e.type === "hardening").length
    assert.equal(state.correctiveRounds.M1, capped)
    assert.deepEqual(
      checkBookkeeping(state).filter((f) => f.code === "counter-behind-roundlog" || f.code === "roundlog-behind-counter"),
      [],
    )
  }
})

// --- set-status ---------------------------------------------------------

test("set-status accepts every MISSION_STATUSES value (done once every milestone is done)", () => {
  for (const status of MISSION_STATUSES) {
    const { dir, statePath } = makeTempPrd({
      milestones: [{ id: "M1", order: 1, status: "done", assertions: ["A-1"] }],
      assertionStatus: { "A-1": "passing" },
    })
    const r = runCLI([dir, "set-status", status])
    assert.equal(r.exitCode, 0, r.stderr)
    assert.equal(readState(statePath).missionStatus, status)
  }
})

test("set-status done is refused while a milestone is not done, or one is behaviorally gated / hypothesis-failed (byte-identical)", () => {
  const pendingMilestone = makeTempPrd()
  const before = readRaw(pendingMilestone.statePath)
  const r = runCLI([pendingMilestone.dir, "set-status", "done"])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr, /remaining: M1/)
  assert.equal(readRaw(pendingMilestone.statePath), before)
  // the non-terminal statuses stay unrestricted on the same state
  for (const status of ["halted", "behaviorally-gated", "active"]) {
    assert.equal(runCLI([pendingMilestone.dir, "set-status", status]).exitCode, 0, status)
  }

  for (const [st, why] of [["inconclusive-no-device", /behaviorally gated/], [HYPOTHESIS_FAILED_STATE, /hypothesis-failed/]]) {
    const gated = makeTempPrd({
      milestones: [{ id: "M1", order: 1, status: "done", assertions: ["A-1"] }],
      assertionStatus: { "A-1": st },
    })
    const g = runCLI([gated.dir, "set-status", "done"])
    assert.equal(g.exitCode, 1, st)
    assert.match(g.stderr, why)
  }
})

test("set-status rejects an unknown status (malformed call, byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-status", "on-fire"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// --- generic malformed-call handling -------------------------------------

test("missing prd-dir, a nonexistent prd-dir, and an unknown command all exit non-zero", () => {
  assert.notEqual(runCLI([]).exitCode, 0)
  assert.notEqual(runCLI([path.join(tmpdir(), "does-not-exist-" + Date.now())]).exitCode, 0)
  const { dir } = makeTempPrd()
  assert.notEqual(runCLI([dir, "delete-everything"]).exitCode, 0)
})

test("a prd-dir with no mission-state.json exits non-zero and creates nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mscli-empty-"))
  const r = runCLI([dir, "set-status", "halted"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(existsSync(path.join(dir, "mission-state.json")), false)
})

test("a mission-state.json that is not a JSON object (an array) is refused", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mscli-arr-"))
  const statePath = path.join(dir, "mission-state.json")
  writeFileSync(statePath, "[]", "utf8")
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-status", "halted"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("wrong positional-argument counts and unknown flags are malformed calls", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const tooFew = runCLI([dir, "set-assertion", "A-1"])
  assert.notEqual(tooFew.exitCode, 0)
  const tooMany = runCLI([dir, "set-assertion", "A-1", "passing", "extra"])
  assert.notEqual(tooMany.exitCode, 0)
  const unknownFlag = runCLI([dir, "add-decision", "M1", "text", "--why", "reason", "--bogus", "x"])
  assert.notEqual(unknownFlag.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// --- the verbs and flags this harness does NOT carry ---------------------
// The lanes-with-contracts machinery
// (set-contract-status, add-amendment, bump-round --lane) and the statusline
// context-reset flag were deliberately not ported. They must fail as unknown,
// never be half-honoured.

test("usage lists exactly the ported commands: no set-contract-status, no add-amendment", () => {
  const { dir } = makeTempPrd()
  const r = runCLI([dir, "no-such-command"])
  assert.equal(r.exitCode, 2)
  const line = r.stderr.split("\n").find((l) => l.startsWith("commands: "))
  const listed = line.slice("commands: ".length).split(", ")
  assert.deepEqual(listed, [
    "set-assertion",
    "add-decision",
    "add-constraint",
    "set-procedure",
    "record-verdict",
    "set-gate",
    "merge-meta",
    "bump-round",
    "set-status",
    "upsert-escalation",
    "set-milestone-status",
    "set-milestone-note",
    "append",
    "set-note",
    "set-field",
    "add-feature",
    "add-assertion",
    "dispatch-esc",
    "close-esc",
    "rerun-verified",
    "record-testgaps-from-verdicts",
    "append-followups",
    "capture-verdict",
  ])
})

test("set-contract-status and add-amendment are unknown commands (exit 2, byte-identical)", () => {
  const { dir, statePath } = makeTempPrd({ contracts: [{ id: "checkout", status: "planned", amendments: [] }] })
  const before = readRaw(statePath)
  for (const args of [
    ["set-contract-status", "checkout", "landed"],
    ["add-amendment", "checkout", JSON.stringify({ milestone: "M1", change: { kind: "rename" }, reason: "r" })],
  ]) {
    const r = runCLI([dir, ...args])
    assert.equal(r.exitCode, 2, args[0])
    assert.match(r.stderr, /^usage:/)
  }
  assert.equal(readRaw(statePath), before)
})

test("bump-round --lane is an unknown flag (exit 2, byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "bump-round", "M1", "--type", "corrective", "--lane", "backend"])
  assert.equal(r.exitCode, 2)
  assert.match(r.stderr, /unknown flag --lane/)
  assert.equal(readRaw(statePath), before)
})

test("set-field contextReset.* is refused: the statusline context-reset flag is not part of this harness", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const fieldPath of ["contextReset", "contextReset.readyToClear", "contextReset.requested"]) {
    const r = runCLI([dir, "set-field", fieldPath, JSON.stringify(true)])
    assert.equal(r.exitCode, 2, fieldPath)
    assert.match(r.stderr, /not on the allowlist/)
  }
  assert.equal(readRaw(statePath), before)
})

// --- the checkBookkeeping / resumePlan gate itself ------------------------

test("newErrorFindings ignores a finding repeated the same number of times (not new), and counts a genuinely extra repeat", () => {
  const f = (code, detail) => ({ code, severity: "error", detail })
  const before = [f("x", "d")]
  const sameCount = [f("x", "d")]
  assert.deepEqual(newErrorFindings(before, sameCount), [])
  const oneExtra = [f("x", "d"), f("x", "d")]
  assert.deepEqual(newErrorFindings(before, oneExtra), [f("x", "d")])
  const brandNew = [f("x", "d"), f("y", "e")]
  assert.deepEqual(newErrorFindings(before, brandNew), [f("y", "e")])
})

test("newErrorFindings never flags a warn, only error severity", () => {
  const warn = [{ code: "w", severity: "warn", detail: "d" }]
  assert.deepEqual(newErrorFindings([], warn), [])
})

test("a command still succeeds when a PRE-EXISTING unrelated bookkeeping error is already on the file (only NEW errors block)", () => {
  const { dir, statePath } = makeTempPrd({
    missionStatus: "not-a-real-status", // pre-existing unknown-mission-status error, unrelated to add-decision
  })
  const preFindings = checkBookkeeping(readState(statePath))
  assert.ok(preFindings.some((f) => f.code === "unknown-mission-status" && f.severity === "error"))
  const r = runCLI([dir, "add-decision", "M1", "text", "--why", "reason"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).missionStatus, "not-a-real-status") // untouched, and did not block
})

test("a command is refused when it would ADD a bookkeeping error (byte-identical)", () => {
  // A done escalation with no handoff on disk is an error; recording that claim
  // must be refused, not written and flagged later.
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "upsert-escalation", "E-auth-schema", JSON.stringify({ ...ESC_CREATE, status: "done", route: "delegate", implementedBy: "escalation-worker" })])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr, /new bookkeeping error\(s\): esc-escalation-missing-handoff/)
  assert.equal(readRaw(statePath), before)
})

test("a command is refused when resumePlan can no longer parse the resulting file", () => {
  const { dir, statePath } = makeTempPrd({ milestones: [{ order: 1, status: "pending" }] })
  assert.throws(() => resumePlan(readState(statePath)))
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-status", "halted"])
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /resumePlan/)
  assert.equal(readRaw(statePath), before)
})

test("extractPerAssertionRecords reads both real-world verdict shapes and ignores malformed entries", () => {
  assert.deepEqual(extractPerAssertionRecords({ assertionsChecked: [{ id: "A", verdict: "pass" }, { id: "B" }] }), { A: "pass" })
  assert.deepEqual(extractPerAssertionRecords({ assertions: { A: { status: "pass" }, B: {} } }), { A: "pass" })
  assert.deepEqual(extractPerAssertionRecords({}), {})
  assert.deepEqual(extractPerAssertionRecords(null), {})
})

test("GATE_TYPES is exactly integration and e2e", () => {
  assert.deepEqual([...GATE_TYPES], ["integration", "e2e"])
})

// --- output discipline: no command prints the file -----------------------

test("every successful command prints exactly one short line, never the state or a verdict body", () => {
  const { dir } = makeTempPrd()
  writeVerdict(dir, "v.json", { verdict: "pass", assertionsChecked: [{ id: "A-1", verdict: "pass" }] })
  const calls = [
    ["set-assertion", "A-1", "passing"],
    ["add-decision", "M1", "text", "--why", "reason"],
    ["add-constraint", "M1", "text", "--impact", "impact"],
    ["set-procedure", "feat", "procedure text"],
    ["set-gate", "integration", JSON.stringify({ passed: true, scope: "M1", ts: "2026-10-22T00:00:00Z" })],
    ["bump-round", "M1", "--type", "hardening"],
    ["set-status", "halted"],
  ]
  for (const args of calls) {
    const r = runCLI([dir, ...args])
    assert.equal(r.exitCode, 0, `${args.join(" ")}: ${r.stderr}`)
    assertSingleLine(r.stdout)
    assert.ok(r.stdout.length < 300, `stdout suspiciously long for ${args[0]}: ${r.stdout.length} chars`)
    assert.ok(!r.stdout.includes('"milestones"'), "must never print the file")
  }
})

// --- end-to-end smoke test of the actual CLI entrypoint -------------------

test("the CLI file itself runs as a subprocess: node mission-state-cli.mjs <dir> set-status halted", () => {
  const { dir, statePath } = makeTempPrd()
  const result = spawnSync(process.execPath, [CLI_PATH, dir, "set-status", "halted"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assertSingleLine(result.stdout)
  assert.equal(readState(statePath).missionStatus, "halted")
})

test("the CLI subprocess exits non-zero on a malformed call and prints to stderr, not stdout", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const result = spawnSync(process.execPath, [CLI_PATH, dir, "set-status", "on-fire"], { encoding: "utf8" })
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, "")
  assert.ok(result.stderr.length > 0)
  assert.equal(readRaw(statePath), before)
})

// ── locking ─────────────────────────────────────────────────────────────

test("parallel CLI invocations against the same prd-dir lose nothing (the lock serializes read-validate-write)", async () => {
  const { dir, statePath } = makeTempPrd()
  const N = 8
  const runs = Array.from({ length: N }, (_, i) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, dir, "add-decision", "M1", `decision-${i}`, "--why", `why-${i}`])
      let stderr = ""
      child.stderr.on("data", (d) => (stderr += d))
      child.on("error", reject)
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${i} exited ${code}: ${stderr}`))))
    }),
  )
  await Promise.all(runs)
  const state = readState(statePath)
  assert.equal(state.decisions.length, N)
  const seen = new Set(state.decisions.map((d) => d.decision))
  for (let i = 0; i < N; i++) assert.ok(seen.has(`decision-${i}`), `missing decision-${i}`)
})

test("a stale lock (older than 60s, whose pid is dead) is broken automatically rather than blocking the CLI", () => {
  const { dir, statePath } = makeTempPrd()
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"])
  const lockPath = path.join(dir, ".mission-state.lock")
  writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, at: new Date(Date.now() - 120_000).toISOString() }), "utf8")
  const past = new Date(Date.now() - 120_000)
  utimesSync(lockPath, past, past)
  const r = runCLI([dir, "set-status", "halted"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).missionStatus, "halted")
  assert.equal(existsSync(lockPath), false) // released after our own run completes
})

test("the lock is always released, even after a refused command", () => {
  const { dir } = makeTempPrd()
  runCLI([dir, "set-status", "not-a-real-status"]) // refused
  assert.equal(existsSync(path.join(dir, ".mission-state.lock")), false)
})

test("isMain resolves through a symlinked invocation of the CLI file", () => {
  const { dir, statePath } = makeTempPrd()
  const linkDir = mkdtempSync(path.join(tmpdir(), "mscli-link-"))
  const linkPath = path.join(linkDir, "mission-state-cli-link.mjs")
  symlinkSync(CLI_PATH, linkPath)
  const result = spawnSync(process.execPath, [linkPath, dir, "set-status", "halted"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readState(statePath).missionStatus, "halted")
})

test("isMain resolves through an invocation path containing a space", () => {
  // A COPY (not a symlink) of the CLI + its sibling modules into a
  // space-containing directory — a `new URL(...).pathname` compare leaves
  // "%20" un-decoded against argv[1]'s raw space, so this failed even with no
  // symlink involved. The copied set is also the CLI's whole import closure:
  // it must not need any module beyond these.
  const { dir, statePath } = makeTempPrd()
  const srcDir = path.dirname(path.dirname(CLI_PATH))
  const spacedDir = mkdtempSync(path.join(tmpdir(), "mscli space "))
  mkdirSync(path.join(spacedDir, "state"))
  mkdirSync(path.join(spacedDir, "rules"))
  mkdirSync(path.join(spacedDir, "io"))
  for (const name of [
    "state/mission-state.mjs",
    "rules/bookkeeping.mjs",
    "rules/resume.mjs",
    "rules/escalation-route.mjs",
    "rules/boundary.mjs",
    "rules/autopilot.mjs",
    "rules/evidence.mjs",
    "rules/verified-by.mjs",
    "io/proofs.mjs",
  ]) {
    writeFileSync(path.join(spacedDir, name), readFileSync(path.join(srcDir, name), "utf8"), "utf8")
  }
  const spacedCli = path.join(spacedDir, "state", "mission-state.mjs")
  const result = spawnSync(process.execPath, [spacedCli, dir, "set-status", "halted"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readState(statePath).missionStatus, "halted")
})

// ── every milestone-taking command validates against milestones[].id ──

test("add-decision / add-constraint / bump-round / set-milestone-status / add-feature all refuse an unknown milestone, byte-identical", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const args of [
    ["add-decision", "Mnope", "text", "--why", "reason"],
    ["add-constraint", "Mnope", "text", "--impact", "impact"],
    ["bump-round", "Mnope", "--type", "corrective"],
    ["set-milestone-status", "Mnope", "in-progress"],
    ["add-feature", "Mnope", "SomeFeature"],
  ]) {
    const r = runCLI([dir, ...args])
    assert.notEqual(r.exitCode, 0, args.join(" "))
  }
  assert.equal(readRaw(statePath), before)
})

test("a milestone argument containing a path separator or '..' is refused outright, before the membership check", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const bad of ["../mission-state", "M1/../../etc", "a/b"]) {
    const r = runCLI([dir, "add-decision", bad, "text", "--why", "reason"])
    assert.notEqual(r.exitCode, 0, bad)
  }
  assert.equal(readRaw(statePath), before)
})

// ── every verdict shape, invariant-9 hard blockers, newest-file-wins ──

test("set-assertion <id> passing succeeds against the canonical verdicts[] shape (references/architecture.md)", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "M1-web-api.json", { verdict: "pass", verdicts: [{ id: "A-1", verdict: "pass", evidence: "..." }] })
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).assertionStatus["A-1"], "passing")
})

test("set-assertion <id> passing succeeds against a bare assertions[] list shape", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "v.json", { verdict: "pass", assertions: [{ id: "A-1", verdict: "pass" }] })
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.equal(r.exitCode, 0, r.stderr)
})

test("record-verdict derives from the canonical verdicts[] shape too (it used to derive nothing)", () => {
  const { dir, statePath } = makeTempPrd()
  const srcPath = writeJson(path.join(dir, "M1-canonical.json"), {
    verdict: "pass",
    verdicts: [
      { id: "A-1", verdict: "pass" },
      { id: "A-2", verdict: "fail" },
    ],
  })
  const r = runCLI([dir, "record-verdict", "M1", srcPath])
  assert.equal(r.exitCode, 0, r.stderr)
  const state = readState(statePath)
  assert.equal(state.assertionStatus["A-1"], "passing")
  assert.equal(state.assertionStatus["A-2"], "failing")
})

test("set-assertion passing is refused when the deciding file's per-assertion word is pass but the top-level verdict is fail", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "auth.json", { verdict: "fail", assertionsChecked: [{ id: "A-1", verdict: "pass" }] })
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-assertion passing is refused when the deciding file carries a non-empty boundaryViolations[]", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "v.json", {
    verdict: "pass-with-findings",
    assertionsChecked: [{ id: "A-1", verdict: "pass" }],
    boundaryViolations: ["packages/validation/src/fee-schedule.ts"],
  })
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-assertion passing is refused when the deciding file carries a non-empty missingDefaults[]", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "v.json", {
    verdict: "pass-with-findings",
    assertionsChecked: [{ id: "A-1", verdict: "pass" }],
    missingDefaults: [{ id: "A-1", detail: "no emitEvent call" }],
  })
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("record-verdict derives failing (not passing) when the per-assertion word is pass but the file is blocked", () => {
  const { dir, statePath } = makeTempPrd()
  const srcPath = writeJson(path.join(dir, "M1-blocked.json"), {
    verdict: "fail",
    assertionsChecked: [{ id: "A-1", verdict: "pass" }],
  })
  const r = runCLI([dir, "record-verdict", "M1", srcPath])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).assertionStatus["A-1"], "failing")
})

test("the NEWEST verdict file (by validatedAt) decides, not the first one found: a newer fail beats an older pass", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "a-round1.json", { verdict: "pass", validatedAt: "2026-10-01T00:00:00Z", assertionsChecked: [{ id: "A-1", verdict: "pass" }] })
  writeVerdict(dir, "b-round2.json", { verdict: "fail", validatedAt: "2026-10-02T00:00:00Z", assertionsChecked: [{ id: "A-1", verdict: "fail" }] })
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("...and the reverse: a newer pass is accepted even though an OLDER file recorded a fail for the same id", () => {
  const { dir } = makeTempPrd()
  writeVerdict(dir, "a-round1.json", { verdict: "fail", validatedAt: "2026-10-01T00:00:00Z", assertionsChecked: [{ id: "A-1", verdict: "fail" }] })
  writeVerdict(dir, "b-round2.json", { verdict: "pass", validatedAt: "2026-10-02T00:00:00Z", assertionsChecked: [{ id: "A-1", verdict: "pass" }] })
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.match(r.stdout, /b-round2\.json/)
})

test("dotfiles and *.tmp entries under verdicts/ are ignored when deciding an assertion", () => {
  const { dir, statePath } = makeTempPrd()
  mkdirSync(path.join(dir, "verdicts"), { recursive: true })
  // A pass recorded ONLY in a dotfile/.tmp leftover must not count as evidence.
  writeFileSync(path.join(dir, "verdicts", ".v.json"), JSON.stringify({ verdict: "pass", assertionsChecked: [{ id: "A-1", verdict: "pass" }] }), "utf8")
  writeFileSync(path.join(dir, "verdicts", "v.json.123.tmp"), JSON.stringify({ verdict: "pass", assertionsChecked: [{ id: "A-1", verdict: "pass" }] }), "utf8")
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// ── bump-round --type adversarial ──────────────────────────────────

test("bump-round --type adversarial sets adversarialRounds[milestone] = 1 and refuses a second run", () => {
  const { dir, statePath } = makeTempPrd()
  const r1 = runCLI([dir, "bump-round", "M1", "--type", "adversarial", "--trigger", "deep-investigator"])
  assert.equal(r1.exitCode, 0, r1.stderr)
  assert.equal(readState(statePath).adversarialRounds.M1, 1)
  const before = readRaw(statePath)
  const r2 = runCLI([dir, "bump-round", "M1", "--type", "adversarial"])
  assert.notEqual(r2.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// ── the no-new-error gate is given handoffFiles ────────────────────

test("checkBookkeeping is given handoffFiles: an ESC-* handoff whose escalations[] entry lacks implementedBy is a NEW blocking error", () => {
  const { dir, statePath } = makeTempPrd()
  writeHandoff(dir, "ESC-shared-thing.json", { feature: "ESC-shared-thing", completed: [] })
  const before = readRaw(statePath)
  const create = { ...ESC_CREATE, reason: "shared surface", files: ["packages/validation/src/x.ts"] }
  const refused = runCLI([dir, "upsert-escalation", "shared-thing", JSON.stringify(create)])
  assert.notEqual(refused.exitCode, 0)
  assert.match(refused.stderr, /bookkeeping error/)
  assert.equal(readRaw(statePath), before)
  const ok = runCLI([dir, "upsert-escalation", "shared-thing", JSON.stringify({ ...create, implementedBy: "escalation-worker" })])
  assert.equal(ok.exitCode, 0, ok.stderr)
})

// ── upsert-escalation ────────────────────────────────────────────────

test("upsert-escalation adds a new entry, then merges into it by id on a second call", () => {
  const { dir, statePath } = makeTempPrd()
  const create = { milestone: "M1", reason: "new OtpChallenge model", files: ["packages/db/prisma/schema.prisma"], status: "pending" }
  const r1 = runCLI([dir, "upsert-escalation", "E-otp-schema", JSON.stringify(create)])
  assert.equal(r1.exitCode, 0, r1.stderr)
  assert.deepEqual(readState(statePath).escalations, [{ id: "E-otp-schema", ...create }])
  const r2 = runCLI([
    dir,
    "upsert-escalation",
    "E-otp-schema",
    JSON.stringify({ implementedBy: "escalation-worker", verifiedBy: [{ command: "grep OtpChallenge schema.prisma", exit: 0, evidence: "line found", readOnly: true }] }),
  ])
  assert.equal(r2.exitCode, 0, r2.stderr)
  const entry = readState(statePath).escalations[0]
  assert.equal(entry.reason, "new OtpChallenge model") // merged, not replaced
  assert.equal(entry.implementedBy, "escalation-worker")
  assert.equal(entry.verifiedBy.length, 1)
})

test("upsert-escalation refuses files[] entries with a trailing slash", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ ...ESC_CREATE, files: ["packages/validation/src/"] })])
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /trailing slash/)
  assert.equal(readRaw(statePath), before)
})

test("upsert-escalation CREATE requires milestone (known id), a non-empty reason, non-empty files[] and status; refused byte-identical", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const without = (k) => Object.fromEntries(Object.entries(ESC_CREATE).filter(([key]) => key !== k))
  for (const [why, payload, pattern] of [
    ["the finding's repro: proofs only", { nonVacuityProofs: [{ method: "plant-and-restore", result: "fired", at: "2026-10-28T01:00:00Z" }] }, /creating one needs milestone/],
    ["no milestone", without("milestone"), /milestone/],
    ["unknown milestone", { ...ESC_CREATE, milestone: "M9" }, /M9/],
    ["no reason", without("reason"), /reason/],
    ["blank reason", { ...ESC_CREATE, reason: "  " }, /reason/],
    ["no files", without("files"), /files/],
    ["empty files", { ...ESC_CREATE, files: [] }, /files/],
    ["no status", without("status"), /status/],
  ]) {
    const r = runCLI([dir, "upsert-escalation", "E-typo", JSON.stringify(payload)])
    assert.equal(r.exitCode, 1, `${why}: ${r.stdout}`)
    assert.match(r.stderr, pattern, why)
  }
  assert.equal(readRaw(statePath), before)
  // The full create succeeds; a later PARTIAL payload merges into it unchanged.
  assert.equal(runCLI([dir, "upsert-escalation", "E-1", JSON.stringify(ESC_CREATE)]).exitCode, 0)
  const merge = runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ nonVacuityProofs: [{ method: "m", result: "r", at: "2026-10-28" }] })])
  assert.equal(merge.exitCode, 0, merge.stderr)
  const entry = readState(statePath).escalations[0]
  assert.equal(entry.reason, ESC_CREATE.reason)
  assert.equal(entry.nonVacuityProofs.length, 1)
  assert.equal(readState(statePath).escalations.length, 1)
})

test("upsert-escalation refuses a malformed verifiedBy entry (missing command/exit/evidence/readOnly)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const bad of [
    [{ exit: 0, evidence: "e", readOnly: true }], // no command
    [{ command: "x", evidence: "e", readOnly: true }], // no exit
    [{ command: "x", exit: 0, readOnly: true }], // no evidence
    [{ command: "x", exit: 0, evidence: "e" }], // no readOnly
  ]) {
    const r = runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ ...ESC_CREATE, verifiedBy: bad })])
    assert.notEqual(r.exitCode, 0, JSON.stringify(bad))
    assert.match(r.stderr, /verifiedBy\[0\]/, JSON.stringify(bad))
  }
  assert.equal(readRaw(statePath), before)
})

test("upsert-escalation refuses a payload.id that does not match the positional id", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ id: "E-2" })])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// ── set-milestone-status ────────────────────────────────────────────

test("set-milestone-status sets a non-done status freely, with no readiness gate", () => {
  const { dir, statePath } = makeTempPrd()
  const r = runCLI([dir, "set-milestone-status", "M1", "in-progress"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).milestones[0].status, "in-progress")
})

test("set-milestone-status refuses 'done' unless computeAdvanceReadiness is clean for that milestone's bound assertions", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": "failing" } })
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-milestone-status", "M1", "done"])
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /not advance-ready/)
  assert.equal(readRaw(statePath), before)
})

test("set-milestone-status refuses 'done' when the milestone is behaviorally-gated (an e2e-environment-unavailable assertion)", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": "skipped" } })
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-milestone-status", "M1", "done"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-milestone-status refuses 'done' when a bound assertion is hypothesis-failed", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": HYPOTHESIS_FAILED_STATE } })
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-milestone-status", "M1", "done"])
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /hypothesisFailed=true/)
  assert.equal(readRaw(statePath), before)
})

test("set-milestone-status accepts 'done' once every bound assertion is passing", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": "passing" } })
  const r = runCLI([dir, "set-milestone-status", "M1", "done"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).milestones[0].status, "done")
})

// ── append (followUps | testGaps) ───────────────────────────────────

test("append followUps appends a string entry", () => {
  const { dir, statePath } = makeTempPrd()
  const r = runCLI([dir, "append", "followUps", JSON.stringify("M2 subjective design-fidelity unverified")])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(readState(statePath).followUps, ["M2 subjective design-fidelity unverified"])
})

test("append followUps refuses a non-string entry", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "append", "followUps", JSON.stringify({ not: "a string" })])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("append testGaps appends a well-formed gap object", () => {
  const { dir, statePath } = makeTempPrd()
  const gap = { id: "WEB-004", kind: "mocked-boundary", detail: "the unit mocks the Prisma boundary", suggestedFix: "use describeIfDb", resolution: "OPEN" }
  const r = runCLI([dir, "append", "testGaps", JSON.stringify(gap)])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(readState(statePath).testGaps, [gap])
})

test("append testGaps accepts a DEFERRED-TO-<milestone> resolution", () => {
  const { dir } = makeTempPrd()
  const gap = { id: "WEB-005", kind: "missing-edge-cases", detail: "no boundary values", resolution: "DEFERRED-TO-M2" }
  const r = runCLI([dir, "append", "testGaps", JSON.stringify(gap)])
  assert.equal(r.exitCode, 0, r.stderr)
})

test("append testGaps refuses an unknown kind and a missing detail", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const badKind = runCLI([dir, "append", "testGaps", JSON.stringify({ id: "X", kind: "vibes", detail: "d" })])
  assert.notEqual(badKind.exitCode, 0)
  const noDetail = runCLI([dir, "append", "testGaps", JSON.stringify({ id: "X", kind: "impl-mirroring" })])
  assert.notEqual(noDetail.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("append refuses a list outside followUps|testGaps", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "append", "decisions", JSON.stringify("x")])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// ── set-note (boundaryNotes) ─────────────────────────────────────────

test("set-note writes a new boundaryNotes key", () => {
  const { dir, statePath } = makeTempPrd()
  const r = runCLI([dir, "set-note", "M1", JSON.stringify({ queueDrift: true, scopeSource: "handoffs" })])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(readState(statePath).boundaryNotes.M1, { queueDrift: true, scopeSource: "handoffs" })
})

test("set-note refuses to overwrite an existing DIFFERENT value without --replace, but --replace overwrites", () => {
  const { dir, statePath } = makeTempPrd({ boundaryNotes: { M1: "first note" } })
  const before = readRaw(statePath)
  const refused = runCLI([dir, "set-note", "M1", JSON.stringify("second note")])
  assert.notEqual(refused.exitCode, 0)
  assert.equal(readRaw(statePath), before)
  const ok = runCLI([dir, "set-note", "M1", JSON.stringify("second note"), "--replace"])
  assert.equal(ok.exitCode, 0, ok.stderr)
  assert.equal(readState(statePath).boundaryNotes.M1, "second note")
})

test("set-note is idempotent for the SAME value, no --replace needed", () => {
  const { dir } = makeTempPrd({ boundaryNotes: { M1: "same note" } })
  const r = runCLI([dir, "set-note", "M1", JSON.stringify("same note")])
  assert.equal(r.exitCode, 0, r.stderr)
})

// ── set-field (allowlist + explicit deny) ────────────────────────────

test("set-field writes every allowlisted path shape", () => {
  const { dir, statePath } = makeTempPrd()
  const cases = [
    ["queueSubstrate", { status: "live", scopeSource: "hook-queue" }],
    ["scopeOverride", { milestone: "M1", modules: ["auth"], source: "parallel-handoffs" }],
    ["simplifyPasses.M1", ["auth", "notification"]],
    ["milestoneReviews.M1", { required: true, ran: true, findings: 2, applied: 2 }],
    ["budget.byMilestone.M1", 41200],
    ["missionFinalReview", { ran: true, findings: 0, ts: "2026-10-22T00:00:00Z" }],
    ["currentMilestone", "M1"],
    ["activeWorker", { feature: "WEB-auth-backend" }],
    ["planReview", { required: true, ran: true, triggers: ["a"], objections: 1, applied: 1 }],
    ["haltEvidence", { reason: "circuit breaker" }],
  ]
  for (const [fieldPath, value] of cases) {
    const r = runCLI([dir, "set-field", fieldPath, JSON.stringify(value)])
    assert.equal(r.exitCode, 0, `${fieldPath}: ${r.stderr}`)
  }
  const state = readState(statePath)
  assert.equal(state.queueSubstrate.status, "live")
  assert.deepEqual(state.scopeOverride.modules, ["auth"])
  assert.deepEqual(state.simplifyPasses.M1, ["auth", "notification"])
  assert.equal(state.milestoneReviews.M1.findings, 2)
  assert.equal(state.budget.byMilestone.M1, 41200)
  assert.equal(state.missionFinalReview.ran, true)
  assert.equal(state.currentMilestone, "M1")
  assert.equal(state.activeWorker.feature, "WEB-auth-backend")
  assert.equal(state.planReview.objections, 1)
  assert.equal(state.haltEvidence.reason, "circuit breaker")
})

test("set-field currentMilestone and activeWorker accept null (clearing the pointer)", () => {
  const { dir, statePath } = makeTempPrd({ activeWorker: { feature: "x" } })
  assert.equal(runCLI([dir, "set-field", "activeWorker", "null"]).exitCode, 0)
  assert.equal(runCLI([dir, "set-field", "currentMilestone", "null"]).exitCode, 0)
  const state = readState(statePath)
  assert.equal(state.activeWorker, null)
  assert.equal(state.currentMilestone, null)
})

test("set-field refuses every explicitly denied root: assertionStatus, correctiveRounds, adversarialRounds, roundLog, integrationGate, milestones", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const fieldPath of ["assertionStatus", "assertionStatus.A-1", "correctiveRounds", "correctiveRounds.M1", "adversarialRounds", "roundLog", "integrationGate", "milestones"]) {
    const r = runCLI([dir, "set-field", fieldPath, JSON.stringify("x")])
    assert.notEqual(r.exitCode, 0, fieldPath)
  }
  assert.equal(readRaw(statePath), before)
})

test("set-field refuses a path not on the allowlist", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-field", "someRandomField", JSON.stringify("x")])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-field refuses an unknown milestone segment in a milestone-templated path", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "set-field", "simplifyPasses.Mnope", JSON.stringify(["auth"])])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("set-field refuses a non-string or unknown currentMilestone and a non-number budget", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  assert.notEqual(runCLI([dir, "set-field", "currentMilestone", JSON.stringify("Mnope")]).exitCode, 0)
  assert.notEqual(runCLI([dir, "set-field", "currentMilestone", JSON.stringify(7)]).exitCode, 0)
  assert.notEqual(runCLI([dir, "set-field", "budget.byMilestone.M1", JSON.stringify("lots")]).exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// ── add-feature ─────────────────────────────────────────────────────

test("add-feature appends a feature id to milestones[<m>].features and registers its features{} entry (module, surface, grant)", () => {
  const { dir, statePath } = makeTempPrd()
  runCLI([dir, "set-procedure", "WEB-new-thing", "Covers A-1."])
  const r = runCLI([
    dir,
    "add-feature",
    "M1",
    "WEB-new-thing",
    "--module",
    "web-account",
    "--surface",
    "web",
    "--pathGlobs",
    JSON.stringify(["apps/web/app/(account)/**", "apps/web/e2e/account.spec.ts"]),
  ])
  assert.equal(r.exitCode, 0, r.stderr)
  const state = readState(statePath)
  assert.deepEqual(state.milestones[0].features, ["WEB-new-thing"])
  assert.deepEqual(state.features["WEB-new-thing"], {
    module: "web-account",
    surface: "web",
    owner: "worker",
    milestone: "M1",
    isEscalation: false,
    pathGlobs: ["apps/web/app/(account)/**", "apps/web/e2e/account.spec.ts"],
  })
  assert.deepEqual(checkBookkeeping(state).filter((f) => f.severity === "error"), [])
})

test("add-feature refuses an unregistered feature (no features{} entry, no --module): its grant would live only in conversation", () => {
  const { dir, statePath } = makeTempPrd()
  runCLI([dir, "set-procedure", "WEB-new-thing", "Covers A-1."])
  const before = readRaw(statePath)
  const r = runCLI([dir, "add-feature", "M1", "WEB-new-thing"])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr, /no features\{\} entry/)
  assert.equal(readRaw(statePath), before)
  // a feature whose features{} entry already exists needs no flags (and the entry is never overwritten)
  const planned = makeTempPrd({ features: { "WEB-planned": { module: "auth", surface: "backend" } } })
  runCLI([planned.dir, "set-procedure", "WEB-planned", "Covers A-1."])
  assert.equal(runCLI([planned.dir, "add-feature", "M1", "WEB-planned"]).exitCode, 0)
  const again = makeTempPrd({ features: { "WEB-planned": { module: "auth", surface: "backend" } } })
  runCLI([again.dir, "set-procedure", "WEB-planned", "Covers A-1."])
  const clobber = runCLI([again.dir, "add-feature", "M1", "WEB-planned", "--module", "web-account", "--surface", "web"])
  assert.equal(clobber.exitCode, 1)
  assert.equal(readState(again.statePath).features["WEB-planned"].module, "auth")
})

test("add-feature refuses a bad registration: no --module, a mobile or unknown --surface, non-array --pathGlobs", () => {
  const { dir, statePath } = makeTempPrd()
  runCLI([dir, "set-procedure", "WEB-new-thing", "Covers A-1."])
  const before = readRaw(statePath)
  for (const args of [
    ["--surface", "web"],
    ["--module", "web-account"],
    ["--module", "mobile-browse", "--surface", "mobile"],
    ["--module", "web-account", "--surface", "desktop"],
    ["--module", "web-account", "--surface", "web", "--pathGlobs", JSON.stringify("apps/web/**")],
    ["--module", "web-account", "--surface", "web", "--pathGlobs", JSON.stringify([""])],
  ]) {
    const r = runCLI([dir, "add-feature", "M1", "WEB-new-thing", ...args], { surfaces: ["backend", "web"] })
    assert.notEqual(r.exitCode, 0, args.join(" "))
  }
  assert.equal(readRaw(statePath), before)
})

test("add-feature refuses an escalation id: escalations are recorded with upsert-escalation, never as a milestone feature", () => {
  const { dir, statePath } = makeTempPrd()
  assert.equal(runCLI([dir, "upsert-escalation", "ESC-shared-enum", JSON.stringify({ ...ESC_CREATE, reason: "shared enum" })]).exitCode, 0)
  runCLI([dir, "set-procedure", "ESC-shared-enum", "even with a procedure"])
  const before = readRaw(statePath)
  const r = runCLI([dir, "add-feature", "M1", "ESC-shared-enum", "--module", "auth", "--surface", "backend"])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr, /escalations\[\] id/)
  assert.equal(readRaw(statePath), before)
})

test("add-feature refuses an id the plan only PRE-NAMED in some milestones[].escalations (no escalations[] record yet)", () => {
  const { dir, statePath } = makeTempPrd({
    milestones: [
      { id: "M1", order: 1, status: "pending", assertions: ["A-1"], features: [] },
      { id: "M2", order: 2, status: "pending", assertions: [], features: [], escalations: ["E-webKernel-pwa"] },
    ],
  })
  assert.equal(runCLI([dir, "set-procedure", "E-webKernel-pwa", "x"]).exitCode, 0)
  const before = readRaw(statePath)
  // The finding's repro: listing it under ANOTHER milestone than the one that pre-named it.
  for (const m of ["M1", "M2"]) {
    const r = runCLI([dir, "add-feature", m, "E-webKernel-pwa", "--module", "webKernel", "--surface", "web"])
    assert.equal(r.exitCode, 1, `${m}: ${r.stdout}`)
    assert.match(r.stderr, /pre-named in M2's milestones\[\]\.escalations/)
  }
  assert.equal(readRaw(statePath), before)
  assert.equal(readState(statePath).escalations.length, 0)
})

// ── add-assertion ───────────────────────────────────────────────────

function writeContract(dir, ids) {
  writeJson(path.join(dir, "validation-contract.json"), {
    prd: "docs/prd/demo/",
    assertions: ids.map((id) => ({ id, statement: "…", modules: ["auth"], verificationMethod: "unit", status: "pending" })),
  })
}

test("add-assertion binds a contract assertion to a milestone and seeds it pending, so validators and the done-gate see it", () => {
  const { dir, statePath } = makeTempPrd()
  writeContract(dir, ["A-1", "A-NEW-9"])
  const r = runCLI([dir, "add-assertion", "M1", "A-NEW-9"])
  assert.equal(r.exitCode, 0, r.stderr)
  assertSingleLine(r.stdout)
  const state = readState(statePath)
  assert.deepEqual(state.milestones[0].assertions, ["A-1", "A-NEW-9"])
  assert.equal(state.assertionStatus["A-NEW-9"], "pending")
  // the done-gate now counts it: M1 cannot be done while A-NEW-9 is pending
  writeVerdict(dir, "M1-auth.json", { module: "auth", validatedAt: "2026-11-02T04:00:00Z", verdicts: [{ id: "A-1", verdict: "pass" }], boundaryViolations: [], missingDefaults: [] })
  assert.equal(runCLI([dir, "set-assertion", "A-1", "passing"]).exitCode, 0)
  const done = runCLI([dir, "set-milestone-status", "M1", "done"])
  assert.equal(done.exitCode, 1)
  assert.match(done.stderr, /A-NEW-9/)
})

test("add-assertion refuses an id missing from the contract, one already bound anywhere, a done milestone, and no contract file", () => {
  const { dir, statePath } = makeTempPrd({
    milestones: [
      { id: "M0", order: 0, status: "done", assertions: [] },
      { id: "M1", order: 1, status: "pending", assertions: ["A-1"] },
    ],
  })
  const before = readRaw(statePath)
  assert.equal(runCLI([dir, "add-assertion", "M1", "A-2"]).exitCode, 1) // no contract file
  writeContract(dir, ["A-1", "A-2"])
  assert.equal(runCLI([dir, "add-assertion", "M1", "A-404"]).exitCode, 1) // not in the contract
  assert.equal(runCLI([dir, "add-assertion", "M1", "A-1"]).exitCode, 1) // already bound
  assert.equal(runCLI([dir, "add-assertion", "M0", "A-2"]).exitCode, 1) // milestone done
  assert.equal(runCLI([dir, "add-assertion", "Mnope", "A-2"]).exitCode, 1) // unknown milestone
  assert.equal(readRaw(statePath), before)
})

// ── record-verdict: the file name binds the milestone ──────────────────

test("record-verdict refuses a verdict whose name is not <milestone>.json / <milestone>-*.json (an ESC-x.json would escape the done re-check)", () => {
  const { dir, statePath } = makeTempPrd({
    milestones: [
      { id: "M1", order: 1, status: "pending", assertions: ["A-1"] },
      { id: "M10", order: 2, status: "pending", assertions: [] },
    ],
  })
  const before = readRaw(statePath)
  const esc = { module: "ESC-E-x", validatedAt: "2026-11-02T04:05:00Z", verdicts: [], boundaryViolations: ["packages/db/prisma/schema.prisma"], missingDefaults: [] }
  for (const name of ["ESC-E-x.json", "auth.json", "M10-auth.json", "M1auth.json"]) {
    writeJson(path.join(dir, name), esc)
    const r = runCLI([dir, "record-verdict", "M1", name])
    assert.equal(r.exitCode, 1, name)
    assert.match(r.stderr, /not named for milestone M1/, name)
    assert.equal(existsSync(path.join(dir, "verdicts", name)), false, name)
  }
  assert.equal(readRaw(statePath), before)
  // M10-auth.json is fine for M10, and M1.json for M1
  writeJson(path.join(dir, "M1.json"), esc)
  assert.equal(runCLI([dir, "record-verdict", "M1", "M1.json"]).exitCode, 0)
  assert.equal(runCLI([dir, "record-verdict", "M10", "M10-auth.json"]).exitCode, 0)
})

test("record-verdict: an M1-ESC-x.json carrying a boundaryViolation blocks set-milestone-status M1 done", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": "passing" } })
  writeVerdict(dir, "M1-auth.json", { module: "auth", validatedAt: "2026-11-02T04:00:00Z", verdicts: [{ id: "A-1", verdict: "pass" }], boundaryViolations: [], missingDefaults: [] })
  writeJson(path.join(dir, "M1-ESC-x.json"), {
    module: "ESC-x",
    validatedAt: "2026-11-02T04:05:00Z",
    verdicts: [],
    boundaryViolations: ["packages/db/prisma/schema.prisma"],
    missingDefaults: [],
  })
  assert.equal(runCLI([dir, "record-verdict", "M1", "M1-ESC-x.json"]).exitCode, 0)
  const before = readRaw(statePath)
  const done = runCLI([dir, "set-milestone-status", "M1", "done"])
  assert.equal(done.exitCode, 1)
  assert.match(done.stderr, /M1-ESC-x\.json \(boundaryViolations=1/)
  assert.equal(readRaw(statePath), before)
})

// ── set-field value shapes ──────────────────────────────────────────

test("set-field refuses a wrong value shape for simplifyPasses, milestoneReviews, planReview and queueSubstrate", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const [fieldPath, value] of [
    ["simplifyPasses.M1", "marketing"],
    ["simplifyPasses.M1", { auth: true }],
    ["simplifyPasses.M1", ["auth", 7]],
    ["simplifyPasses.M1", []], // bookkeeping check 6 reads [] as "pass missing": refuse it at the write
    ["milestoneReviews.M1", { ran: true }],
    ["milestoneReviews.M1", ["required"]],
    ["milestoneReviews.M1", null],
    ["planReview", { required: "yes" }],
    ["planReview", null],
    ["queueSubstrate", { status: "maybe", scopeSource: "hook-queue" }],
    ["queueSubstrate", { status: "live" }],
    ["queueSubstrate", "live"],
    ["queueSubstrate", null],
  ]) {
    const r = runCLI([dir, "set-field", fieldPath, JSON.stringify(value)])
    assert.equal(r.exitCode, 1, `${fieldPath}=${JSON.stringify(value)}: ${r.stdout}`)
  }
  assert.equal(readRaw(statePath), before)
  // the documented shapes still pass
  assert.equal(runCLI([dir, "set-field", "milestoneReviews.M1", JSON.stringify({ required: false })]).exitCode, 0)
  assert.equal(runCLI([dir, "set-field", "simplifyPasses.M1", JSON.stringify(["auth"])]).exitCode, 0)
  assert.equal(
    runCLI([dir, "set-field", "queueSubstrate", JSON.stringify({ status: "unavailable-worktree", scopeSource: "handoffs+commits", flagResolves: false })]).exitCode,
    0,
  )
})

test("set-field models.<orchestrator|worker|validator> takes a non-empty string (the D2 route to correct a non-canonical seat); other paths and shapes are refused", () => {
  const { dir, statePath } = makeTempPrd({ models: { orchestrator: "fable (this session: claude-fable-5-1)", worker: "sonnet", validator: "opus" } })
  const r = runCLI([dir, "set-field", "models.orchestrator", JSON.stringify("opus")])
  assert.equal(r.exitCode, 0, r.stderr)
  assertSingleLine(r.stdout)
  assert.deepEqual(readState(statePath).models, { orchestrator: "opus", worker: "sonnet", validator: "opus" })
  for (const seat of ["worker", "validator"]) assert.equal(runCLI([dir, "set-field", `models.${seat}`, JSON.stringify("sonnet")]).exitCode, 0, seat)
  const before = readRaw(statePath)
  for (const [fieldPath, value, code] of [
    ["models.orchestrator", "", 1],
    ["models.orchestrator", "   ", 1],
    ["models.worker", 7, 1],
    ["models.validator", null, 1],
    ["models.validator", { alias: "opus" }, 1],
    ["models.scout", "sonnet", 2], // not a seat
    ["models", { orchestrator: "opus" }, 2], // the whole map is not settable
    ["models.orchestrator.alias", "opus", 2],
  ]) {
    const res = runCLI([dir, "set-field", fieldPath, JSON.stringify(value)])
    assert.equal(res.exitCode, code, `${fieldPath}=${JSON.stringify(value)}: ${res.stderr}`)
  }
  assert.equal(readRaw(statePath), before)
})

test("upsert-escalation accepts a `feature` naming the orchestrator-owned feature it implements, and refuses a non-string one", () => {
  const { dir, statePath } = makeTempPrd()
  assert.equal(runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ ...ESC_CREATE, feature: "WEB-admin-auth" })]).exitCode, 0)
  assert.equal(readState(statePath).escalations[0].feature, "WEB-admin-auth")
  const before = readRaw(statePath)
  assert.equal(runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ feature: 7 })]).exitCode, 1)
  assert.equal(runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ feature: "" })]).exitCode, 1)
  assert.equal(readRaw(statePath), before)
})

test("add-feature refuses an unknown milestone", () => {
  const { dir, statePath } = makeTempPrd()
  runCLI([dir, "set-procedure", "WEB-new-thing", "Covers A-1."])
  const before = readRaw(statePath)
  const r = runCLI([dir, "add-feature", "Mnope", "WEB-new-thing"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("add-feature refuses a feature already listed in ANY milestone's features[]", () => {
  const { dir, statePath } = makeTempPrd({
    milestones: [
      { id: "M1", order: 1, status: "pending", assertions: ["A-1"] },
      { id: "M2", order: 2, status: "pending", assertions: [], features: ["WEB-existing"] },
    ],
  })
  runCLI([dir, "set-procedure", "WEB-existing", "Covers something."])
  const before = readRaw(statePath)
  const r = runCLI([dir, "add-feature", "M1", "WEB-existing"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

test("add-feature refuses a feature id with neither a procedures[] entry nor an escalations[] entry", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([dir, "add-feature", "M1", "WEB-unheard-of"])
  assert.notEqual(r.exitCode, 0)
  assert.equal(readRaw(statePath), before)
})

// ── the deciding rule, shared by set-assertion and record-verdict ──
//
// decideFromRecords is the pure half: given the records collected for one id,
// which way does the evidence fall? Ranking is tested here rather than through
// a directory, so a case can state the exact times and words it means.

test("decideFromRecords: no records at all decides nothing", () => {
  assert.equal(decideFromRecords([]), null)
  assert.equal(decideFromRecords(undefined), null)
  assert.equal(decideFromRecords(null), null)
})

test("decideFromRecords: a lone unblocked pass passes; a lone fail and a lone BLOCKED pass both fail", () => {
  assert.equal(decideFromRecords([{ file: "a.json", word: "pass", blocked: false, time: 10 }]).status, "pass")
  assert.equal(decideFromRecords([{ file: "a.json", word: "fail", blocked: false, time: 10 }]).status, "fail")
  assert.equal(decideFromRecords([{ file: "a.json", word: "pass", blocked: true, time: 10 }]).status, "fail")
})

test("decideFromRecords: only the newest bucket counts — an older record never overrides or rescues it", () => {
  const olderFail = { file: "old.json", word: "fail", blocked: false, time: 1 }
  const newerPass = { file: "new.json", word: "pass", blocked: false, time: 2 }
  const decided = decideFromRecords([olderFail, newerPass])
  assert.equal(decided.status, "pass")
  assert.deepEqual(decided.files, ["new.json"]) // the older file is history, not evidence
  const reverse = decideFromRecords([
    { file: "old.json", word: "pass", blocked: false, time: 1 },
    { file: "new.json", word: "fail", blocked: false, time: 2 },
  ])
  assert.equal(reverse.status, "fail")
  assert.deepEqual(reverse.files, ["new.json"])
})

test("decideFromRecords: a TIE must be unanimous — one fail, or one blocked pass, in the newest bucket fails it", () => {
  const pass = { file: "aaa.json", word: "pass", blocked: false, time: 5 }
  const fail = { file: "zzz.json", word: "fail", blocked: false, time: 5 }
  const blockedPass = { file: "mmm.json", word: "pass", blocked: true, time: 5 }
  assert.equal(decideFromRecords([pass, fail]).status, "fail")
  assert.equal(decideFromRecords([fail, pass]).status, "fail") // argument order cannot decide it
  assert.equal(decideFromRecords([pass, blockedPass]).status, "fail")
  assert.equal(decideFromRecords([pass, { ...pass, file: "bbb.json" }]).status, "pass") // unanimous tie still passes
  assert.deepEqual(decideFromRecords([pass, { ...pass, file: "bbb.json" }]).files, ["aaa.json", "bbb.json"])
})

test("decideFromRecords: a bucket with no pass and no fail is indeterminate, never a silent pass", () => {
  const cases = [
    [{ file: "a.json", word: "inconclusive", blocked: false, time: 3 }],
    [{ file: "a.json", word: "skipped", blocked: false, time: 3 }],
    [{ file: "a.json", word: "partial", blocked: true, time: 3 }],
    // a pass that is NOT unanimous but carries no explicit fail either
    [
      { file: "a.json", word: "pass", blocked: false, time: 3 },
      { file: "b.json", word: "inconclusive", blocked: false, time: 3 },
    ],
  ]
  for (const records of cases) assert.equal(decideFromRecords(records).status, "indeterminate", JSON.stringify(records))
})

test("decideFromRecords: an older fail cannot drag a newer indeterminate bucket to failing", () => {
  const decided = decideFromRecords([
    { file: "old.json", word: "fail", blocked: false, time: 1 },
    { file: "new.json", word: "inconclusive", blocked: false, time: 9 },
  ])
  assert.equal(decided.status, "indeterminate")
})

test("parseValidatedAt: date-only and full ISO both parse; anything else is null (the mtime fallback's trigger)", () => {
  assert.equal(parseValidatedAt({ validatedAt: "2026-10-20" }), Date.parse("2026-10-20"))
  assert.equal(parseValidatedAt({ validatedAt: "2026-10-20T06:19:43Z" }), Date.parse("2026-10-20T06:19:43Z"))
  // Two date-only stamps on the same day collapse to ONE millisecond — the tie
  // the unanimity rule above exists for, and the shape most real verdicts use.
  assert.equal(parseValidatedAt({ validatedAt: "2026-10-20" }), parseValidatedAt({ validatedAt: "2026-10-20" }))
  for (const bad of [{}, { validatedAt: "" }, { validatedAt: "not a date" }, { validatedAt: 17 }, null])
    assert.equal(parseValidatedAt(bad), null)
})

test("decideAssertionFromVerdicts reads the real directory and applies the same rule, with a pending record shadowing its file", () => {
  const { dir } = makeTempPrd()
  writeVerdict(dir, "older-pass.json", { verdict: "pass", validatedAt: "2026-10-01", verdicts: [{ id: "A-1", verdict: "pass" }] })
  assert.equal(decideAssertionFromVerdicts(dir, "A-1").status, "pass")
  writeVerdict(dir, "newer-fail.json", { verdict: "fail", validatedAt: "2026-10-02", verdicts: [{ id: "A-1", verdict: "fail" }] })
  assert.equal(decideAssertionFromVerdicts(dir, "A-1").status, "fail")
  assert.equal(decideAssertionFromVerdicts(dir, "B-9"), null)
  const pending = {
    file: "newer-fail.json",
    doc: { verdict: "pass", validatedAt: "2026-10-02", verdicts: [{ id: "A-1", verdict: "pass" }] },
    time: Date.parse("2026-10-02"),
  }
  assert.equal(decideAssertionFromVerdicts(dir, "A-1", pending).status, "pass")
})

// ── record-verdict derives through the SAME rule as set-assertion ──

test("record-verdict of an OLDER, losing pass derives failing, not passing (the newest record still decides)", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "modB.json", { verdict: "fail", validatedAt: "2026-10-23T10:00:00Z", verdicts: [{ id: "A-1", verdict: "fail" }] })
  const srcPath = writeJson(path.join(dir, "M1-modA.json"), {
    verdict: "pass",
    validatedAt: "2026-10-23T02:00:00Z",
    verdicts: [{ id: "A-1", verdict: "pass" }],
  })
  const r = runCLI([dir, "record-verdict", "M1", srcPath])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).assertionStatus["A-1"], "failing")
  assert.match(r.stdout, /A-1=failing/)
  // The two paths agree: what record-verdict refused to call passing,
  // set-assertion refuses too (before the fix these disagreed, one line apart).
  assert.notEqual(runCLI([dir, "set-assertion", "A-1", "passing"]).exitCode, 0)
})

test("record-verdict and set-assertion agree on a same-day (date-only) tie, whichever way the files are named", () => {
  const outcomes = []
  for (const [passName, failName] of [
    ["M1-aaa-pass.json", "M1-zzz-fail.json"],
    ["M1-zzz-pass.json", "M1-aaa-fail.json"],
  ]) {
    const { dir, statePath } = makeTempPrd()
    writeVerdict(dir, failName, { verdict: "fail", validatedAt: "2026-10-20", verdicts: [{ id: "A-1", verdict: "fail" }] })
    const srcPath = writeJson(path.join(dir, passName), { verdict: "pass", validatedAt: "2026-10-20", verdicts: [{ id: "A-1", verdict: "pass" }] })
    const recorded = runCLI([dir, "record-verdict", "M1", srcPath])
    const set = runCLI([dir, "set-assertion", "A-1", "passing"])
    outcomes.push({
      recordedExit: recorded.exitCode,
      derived: readState(statePath).assertionStatus["A-1"],
      setExit: set.exitCode,
    })
  }
  assert.deepEqual(outcomes[0], { recordedExit: 0, derived: "failing", setExit: 1 })
  assert.deepEqual(outcomes[0], outcomes[1]) // filename order decides nothing
})

test("a same-day tie that is UNANIMOUSLY passing is still accepted (the rule blocks ties, not same-day evidence)", () => {
  const { dir, statePath } = makeTempPrd()
  writeVerdict(dir, "aaa.json", { verdict: "pass", validatedAt: "2026-10-20", verdicts: [{ id: "A-1", verdict: "pass" }] })
  writeVerdict(dir, "zzz.json", { verdict: "pass", validatedAt: "2026-10-20", verdicts: [{ id: "A-1", verdict: "pass" }] })
  const r = runCLI([dir, "set-assertion", "A-1", "passing"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).assertionStatus["A-1"], "passing")
  assert.match(r.stdout, /aaa\.json.*zzz\.json/) // both cited, not just the winner of a sort
  assertSingleLine(r.stdout)
})

test("record-verdict never leaves a `passing` that set-assertion would refuse, across a mixed corpus", () => {
  const scenarios = [
    {
      name: "newer-fail-elsewhere",
      others: [{ verdict: "fail", validatedAt: "2026-10-24", verdicts: [{ id: "A-1", verdict: "fail" }] }],
      src: { verdict: "pass", validatedAt: "2026-10-23", verdicts: [{ id: "A-1", verdict: "pass" }] },
    },
    {
      name: "same-day-fail",
      others: [{ verdict: "fail", validatedAt: "2026-10-20", verdicts: [{ id: "A-1", verdict: "fail" }] }],
      src: { verdict: "pass", validatedAt: "2026-10-20", verdicts: [{ id: "A-1", verdict: "pass" }] },
    },
    {
      name: "blocked-source",
      others: [],
      src: { verdict: "pass", validatedAt: "2026-10-20", missingDefaults: [{ id: "A-1", detail: "no @feature tag" }], verdicts: [{ id: "A-1", verdict: "pass" }] },
    },
    {
      name: "same-day-inconclusive",
      others: [{ verdict: "pass", validatedAt: "2026-10-20", verdicts: [{ id: "A-1", verdict: "inconclusive" }] }],
      src: { verdict: "pass", validatedAt: "2026-10-20", verdicts: [{ id: "A-1", verdict: "pass" }] },
    },
    { name: "clean-pass", others: [], src: { verdict: "pass", validatedAt: "2026-10-20", verdicts: [{ id: "A-1", verdict: "pass" }] } },
  ]
  for (const s of scenarios) {
    const { dir, statePath } = makeTempPrd()
    s.others.forEach((doc, i) => writeVerdict(dir, `other-${i}.json`, doc))
    const srcPath = writeJson(path.join(dir, "M1-src.json"), s.src)
    assert.equal(runCLI([dir, "record-verdict", "M1", srcPath]).exitCode, 0, s.name)
    const derived = readState(statePath).assertionStatus["A-1"]
    const set = runCLI([dir, "set-assertion", "A-1", "passing"])
    if (derived === "passing") assert.equal(set.exitCode, 0, `${s.name}: derived passing but set-assertion refused`)
    else assert.notEqual(set.exitCode, 0, `${s.name}: derived ${derived} yet set-assertion accepted passing`)
  }
})

test("record-verdict downgrades a STALE passing to inconclusive when the newest bucket no longer supports it", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": "passing" } })
  writeVerdict(dir, "round1.json", { verdict: "pass", validatedAt: "2026-10-01", verdicts: [{ id: "A-1", verdict: "pass" }] })
  const srcPath = writeJson(path.join(dir, "M1-round2.json"), {
    verdict: "pass-with-findings",
    validatedAt: "2026-10-02",
    verdicts: [{ id: "A-1", verdict: "inconclusive" }],
  })
  const r = runCLI([dir, "record-verdict", "M1", srcPath])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).assertionStatus["A-1"], "inconclusive")
  assert.notEqual(runCLI([dir, "set-assertion", "A-1", "passing"]).exitCode, 0)
})

test("record-verdict leaves a PENDING id alone when the newest bucket is indeterminate (an ambiguous word is never guessed)", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": "pending" } })
  const srcPath = writeJson(path.join(dir, "M1-ambiguous.json"), {
    verdict: "pass",
    verdicts: [{ id: "A-1", verdict: "pass on mechanism, with an OWNER DECISION attached" }],
  })
  assert.equal(runCLI([dir, "record-verdict", "M1", srcPath]).exitCode, 0)
  assert.equal(readState(statePath).assertionStatus["A-1"], "pending")
})

test("record-verdict --replace re-derives an id the REPLACED file recorded and the new one drops (its evidence is being deleted)", () => {
  const { dir, statePath } = makeTempPrd({ assertionStatus: { "A-1": "pending", "A-2": "pending" } })
  const first = writeJson(path.join(dir, "M1-v.json"), {
    verdict: "pass",
    validatedAt: "2026-10-01",
    verdicts: [
      { id: "A-1", verdict: "pass" },
      { id: "A-2", verdict: "pass" },
    ],
  })
  assert.equal(runCLI([dir, "record-verdict", "M1", first]).exitCode, 0)
  assert.equal(readState(statePath).assertionStatus["A-2"], "passing")
  writeJson(path.join(dir, "M1-v.json"), { verdict: "pass", validatedAt: "2026-10-02", verdicts: [{ id: "A-1", verdict: "pass" }] })
  const r = runCLI([dir, "record-verdict", "M1", path.join(dir, "M1-v.json"), "--replace"])
  assert.equal(r.exitCode, 0, r.stderr)
  const state = readState(statePath)
  assert.equal(state.assertionStatus["A-1"], "passing")
  // A-2's only evidence was the file just overwritten: its passing claim must not survive it.
  assert.equal(state.assertionStatus["A-2"], "inconclusive")
  assert.notEqual(runCLI([dir, "set-assertion", "A-2", "passing"]).exitCode, 0)
})

// ── set-milestone-note — the sanctioned route for milestones[].doneNote ──

test("set-milestone-note writes milestones[<m>].doneNote and touches nothing else on the milestone", () => {
  const { dir, statePath } = makeTempPrd({
    milestones: [
      { id: "M1", order: 1, status: "in-progress", assertions: ["A-1"], features: ["F-1"] },
      { id: "M2", order: 2, status: "pending", assertions: [] },
    ],
  })
  const note = "M1 flagged design-fidelity-unverified: the bottom-tab safe-area inset needs a live phone-webkit screenshot pass"
  const r = runCLI([dir, "set-milestone-note", "M1", note])
  assert.equal(r.exitCode, 0, r.stderr)
  const state = readState(statePath)
  assert.deepEqual(state.milestones[0], {
    id: "M1",
    order: 1,
    status: "in-progress",
    assertions: ["A-1"],
    features: ["F-1"],
    doneNote: note,
  })
  assert.deepEqual(state.milestones[1], { id: "M2", order: 2, status: "pending", assertions: [] })
  assertSingleLine(r.stdout)
})

test("set-milestone-note refuses an unknown milestone, a traversal milestone, and empty text (byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const args of [
    ["set-milestone-note", "Mnope", "note"],
    ["set-milestone-note", "../mission-state", "note"],
    ["set-milestone-note", "M1", "   "],
    ["set-milestone-note", "M1"],
  ]) {
    assert.notEqual(runCLI([dir, ...args]).exitCode, 0, args.join(" "))
  }
  assert.equal(readRaw(statePath), before)
})

test("set-milestone-note refuses to clobber a DIFFERENT existing doneNote without --replace, and is idempotent for the same text", () => {
  const { dir, statePath } = makeTempPrd({
    milestones: [{ id: "M1", order: 1, status: "done", assertions: ["A-1"], doneNote: "the long M1 close-out note" }],
  })
  const before = readRaw(statePath)
  assert.notEqual(runCLI([dir, "set-milestone-note", "M1", "a different note"]).exitCode, 0)
  assert.equal(readRaw(statePath), before)
  assert.equal(runCLI([dir, "set-milestone-note", "M1", "the long M1 close-out note"]).exitCode, 0)
  const ok = runCLI([dir, "set-milestone-note", "M1", "a different note", "--replace"])
  assert.equal(ok.exitCode, 0, ok.stderr)
  assert.equal(readState(statePath).milestones[0].doneNote, "a different note")
})

test("set-milestone-note reaches doneNote ONLY: every other milestones path is still denied to set-field", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const fieldPath of [
    "milestones",
    "milestones.M1",
    "milestones.M1.doneNote",
    "milestones.M1.status",
    "milestones.M1.assertions",
    "milestones.M1.features",
    "milestones.0.status",
  ]) {
    const r = runCLI([dir, "set-field", fieldPath, JSON.stringify("x")])
    assert.notEqual(r.exitCode, 0, fieldPath)
  }
  assert.equal(readRaw(statePath), before)
})

// ── verifiedBy is re-runnable proof; everything else is nonVacuityProofs ──

test("upsert-escalation refuses a verifiedBy entry with a non-zero exit, byte-identical, whatever readOnly says", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const bad of [
    { command: "non-vacuity: plant a violation into the boundary test, run it, restore", exit: 1, evidence: "detector fired; restored", readOnly: false },
    { command: "pnpm --filter @etros/api test -- auth", exit: 1, evidence: "1 failed", readOnly: true },
    { command: "pnpm typecheck --force", exit: 2, evidence: "type errors", readOnly: true },
    { command: "jest", exit: -1, evidence: "killed", readOnly: true },
  ]) {
    const r = runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ verifiedBy: [bad] })])
    assert.notEqual(r.exitCode, 0, JSON.stringify(bad))
    assert.match(r.stderr, /nonVacuityProofs/)
  }
  assert.equal(readRaw(statePath), before)
})

test("upsert-escalation refuses a MUTATING verifiedBy entry even when it exited 0 (a validator re-runs these)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const r = runCLI([
    dir,
    "upsert-escalation",
    "E-1",
    JSON.stringify({
      verifiedBy: [{ command: "sed -i '' 's/x/y/' agent-routing.json && git checkout -- .", exit: 0, evidence: "planted and restored", readOnly: false }],
    }),
  ])
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /readOnly/)
  assert.equal(readRaw(statePath), before)
})

test("upsert-escalation accepts a read-only verifiedBy entry that exited 0 (the only shape that survives)", () => {
  const { dir, statePath } = makeTempPrd()
  const r = runCLI([
    dir,
    "upsert-escalation",
    "E-1",
    JSON.stringify({
      ...ESC_CREATE,
      verifiedBy: [{ command: "git diff --quiet origin/main -- packages/validation/src/fee-schedule.ts", exit: 0, evidence: "untouched", readOnly: true }],
    }),
  ])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(statePath).escalations[0].verifiedBy.length, 1)
})

test("an escalation carrying a legacy red verifiedBy entry can still be AMENDED to a correct one", () => {
  const { dir, statePath } = makeTempPrd({
    escalations: [
      {
        id: "E-boundary-detectors",
        reason: "detectors",
        verifiedBy: [{ command: "plant-and-restore", exit: 1, evidence: "detectors fired", readOnly: false }],
      },
    ],
  })
  const r = runCLI([
    dir,
    "upsert-escalation",
    "E-boundary-detectors",
    JSON.stringify({
      verifiedBy: [
        {
          command: "pnpm --filter @etros/web test -- boundary",
          exit: 0,
          evidence: "Tests: 12 passed",
          readOnly: true,
          amends: "plant-and-restore",
        },
      ],
      nonVacuityProofs: [
        {
          method: "plant a cross-module import into apps/web/lib, run the boundary test, restore",
          result: "detector fired (1 failed, 11 passed); file restored to the identical sha256",
          at: "2026-10-23",
        },
      ],
    }),
  ])
  assert.equal(r.exitCode, 0, r.stderr)
  const entry = readState(statePath).escalations[0]
  assert.equal(entry.reason, "detectors") // merged, not replaced
  assert.deepEqual(
    entry.verifiedBy.map((v) => [v.exit, v.readOnly]),
    [[0, true]],
  )
  assert.equal(entry.nonVacuityProofs.length, 1)
  assert.match(entry.nonVacuityProofs[0].result, /identical sha256/)
})

test("upsert-escalation refuses a malformed nonVacuityProofs entry (byte-identical), and accepts the well-formed one", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const good = { method: "plant and restore", result: "detector fired", at: "2026-10-23" }
  for (const bad of [
    { payload: { nonVacuityProofs: "not an array" }, why: "not an array" },
    { payload: { nonVacuityProofs: [{ ...good, method: "" }] }, why: "empty method" },
    { payload: { nonVacuityProofs: [{ ...good, result: 7 }] }, why: "non-string result" },
    { payload: { nonVacuityProofs: [{ method: good.method, result: good.result }] }, why: "no at" },
    { payload: { nonVacuityProofs: [{ ...good, at: "whenever" }] }, why: "unparseable at" },
    { payload: { nonVacuityProofs: [{ ...good, command: "rm -rf /", exit: 1 }] }, why: "carries command/exit" },
    { payload: { nonVacuityProofs: ["a string"] }, why: "not an object" },
  ]) {
    const r = runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ ...ESC_CREATE, ...bad.payload })])
    assert.notEqual(r.exitCode, 0, bad.why)
    assert.match(r.stderr, /nonVacuityProofs/, bad.why)
  }
  assert.equal(readRaw(statePath), before)
  assert.equal(runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ ...ESC_CREATE, nonVacuityProofs: [good] })]).exitCode, 0)
})

test("record-verdict refuses a source whose basename the deciding scan would ignore (dotfile, *.tmp, non-json)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  const doc = { verdict: "pass", verdicts: [{ id: "A-1", verdict: "pass" }] }
  for (const name of ["raw.txt", ".hidden.json", "leftover.json.tmp"]) {
    const srcPath = path.join(dir, name)
    writeFileSync(srcPath, JSON.stringify(doc, null, 2), "utf8")
    const r = runCLI([dir, "record-verdict", "M1", srcPath])
    assert.notEqual(r.exitCode, 0, name)
    assert.equal(existsSync(path.join(dir, "verdicts", name)), false, name)
  }
  assert.equal(readRaw(statePath), before)
})

// ── compatibility: a mission-state planned by the pre-package harness ──
//
// The shape of a real mid-flight mission (planned before this harness
// generation): a plan-time decisions{} MAP, a features{} map in the planner's
// shape, orchestrator-recorded escalations with status "verified" and
// {cmd, exitCode} proofs, integrationGate null, globalConstraints[], no
// constraints[]. Every routine boundary write must succeed on it unchanged,
// and the rehydration brief must read it.

function legacyState() {
  return {
    prd: "docs/prd/web-foundation/",
    missionStatus: "active",
    milestones: [
      { id: "M0", order: 1, status: "done", features: ["WEB-move"], assertions: ["WEB-001"], escalations: ["E-registry-web-move"], gate: "pnpm typecheck green" },
      { id: "M1", order: 2, status: "pending", features: ["WEB-auth-backend"], assertions: ["WEB-004"] },
      { id: "M2", order: 3, status: "pending", features: ["WEB-ci"], assertions: ["WEB-011"] },
    ],
    currentMilestone: "M1",
    features: {
      "WEB-move": { surface: "web", module: "marketing", owner: "orchestrator", milestone: "M0", isEscalation: true, pathGlobs: ["apps/web/**"] },
      "WEB-auth-backend": { surface: "backend", module: "auth", owner: "worker", milestone: "M1", isEscalation: false, pathGlobs: ["packages/api/src/auth/**"] },
      "WEB-ci": { surface: "web", module: "webKernel", owner: "orchestrator", milestone: "M2", isEscalation: true, pathGlobs: [".github/workflows/ci.yml"] },
    },
    assertionStatus: { "WEB-001": "passing", "WEB-004": "pending", "WEB-011": "pending" },
    activeWorker: null,
    correctiveRounds: { M0: 0, M1: 0, M2: 0 },
    roundLog: [],
    globalConstraints: ["Clients are web-only (ADR-0013)."],
    procedures: { "WEB-auth-backend": "Covers WEB-004." },
    budget: { total: null, byMilestone: { M0: 0, M1: 0, M2: 0 } },
    escalations: [
      {
        id: "E-registry-web-move",
        reason: "registry update",
        files: ["agent-routing.json"],
        verifiedBy: [{ cmd: "grep -n 'apps/web' agent-routing.json", exitCode: 0 }],
        status: "verified",
      },
    ],
    integrationGate: null,
    queueSubstrate: { status: "unavailable-worktree", scopeSource: "handoffs+commits" },
    followUps: ["a pre-existing follow-up"],
    boundaryNotes: {},
    testGaps: [],
    decisions: { approvedAt: "2026-10-27", staffAuth: "email-code", session: "authjs-v5-credentials-jwt", workflowOptIn: true },
  }
}

test("compat: a legacy mission-state carries no bookkeeping error, and every routine boundary write succeeds on it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mscli-legacy-"))
  const statePath = writeJson(path.join(dir, "mission-state.json"), legacyState())
  assert.deepEqual(checkBookkeeping(readState(statePath)).filter((f) => f.severity === "error"), [])
  const calls = [
    ["add-decision", "M0", "M0 ran orchestrator-only", "--why", "foundation work, no workers"],
    ["add-constraint", "M1", "Auth.js reserves /api/auth/*", "--impact", "own routes live at /api/auth/code/*"],
    ["set-milestone-status", "M1", "in-progress"],
    ["bump-round", "M1", "--type", "corrective", "--trigger", "WEB-004"],
    ["set-gate", "integration", JSON.stringify({ passed: true, scope: "M1", ts: "2026-10-28T00:00:00Z" })],
    [
      "upsert-escalation",
      "E-otp-schema",
      JSON.stringify({
        milestone: "M1",
        reason: "new OtpChallenge model",
        files: ["packages/db/prisma/schema.prisma"],
        route: "delegate",
        implementedBy: "escalation-worker",
        status: "in-progress",
      }),
    ],
    ["set-field", "simplifyPasses.M0", JSON.stringify(["marketing"])],
    ["append", "followUps", JSON.stringify("a new follow-up")],
    ["set-note", "M1", JSON.stringify({ scopeSource: "handoffs+commits" })],
  ]
  for (const args of calls) {
    const r = runCLI([dir, ...args])
    assert.equal(r.exitCode, 0, `${args[0]}: ${r.stderr}`)
    assertSingleLine(r.stdout)
  }
  const state = readState(statePath)
  assert.equal(state.decisions.length, 5) // 4 converted plan-time records + the new one
  assert.equal(state.escalations[0].status, "verified") // untouched legacy entry
  assert.deepEqual(state.globalConstraints, ["Clients are web-only (ADR-0013)."]) // untouched
  assert.deepEqual(checkBookkeeping(state).filter((f) => f.severity === "error"), [])
  const brief = renderRehydrationBrief(rehydrationPlan(state))
  assert.ok(brief.includes("Focus: M1"))
  assert.ok(brief.includes("staffAuth: email-code"))
  assert.ok(brief.includes("M0 ran orchestrator-only"))
})

// ── append compactions (the PreCompact hook's breadcrumb) ──────────────

test("append compactions accepts the hook's {at, reason, session} shape, null at/session included", () => {
  const { dir, statePath } = makeTempPrd()
  for (const crumb of [
    { at: "M1", reason: "auto", session: "s-1" },
    { at: null, reason: "manual", session: null },
  ]) {
    const r = runCLI([dir, "append", "compactions", JSON.stringify(crumb)])
    assert.equal(r.exitCode, 0, r.stderr)
    assertSingleLine(r.stdout)
  }
  assert.deepEqual(readState(statePath).compactions, [
    { at: "M1", reason: "auto", session: "s-1" },
    { at: null, reason: "manual", session: null },
  ])
})

test("append compactions refuses a malformed breadcrumb (byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const bad of [
    "a string",
    ["M1"],
    { reason: "auto", session: null }, // no at
    { at: 1, reason: "auto", session: null }, // at not a string
    { at: "M1", reason: "", session: null }, // empty reason
    { at: "M1", reason: "auto" }, // no session
    { at: "M1", reason: "auto", session: 7 },
    { at: "M1", reason: "auto", session: null, contextReset: true }, // unknown key
  ]) {
    const r = runCLI([dir, "append", "compactions", JSON.stringify(bad)])
    assert.equal(r.exitCode, 1, JSON.stringify(bad))
  }
  assert.equal(readRaw(statePath), before)
})

test(`append compactions keeps only the last ${COMPACTIONS_KEPT} (11 appends leave 10, oldest dropped)`, () => {
  const { dir, statePath } = makeTempPrd()
  for (let i = 0; i < COMPACTIONS_KEPT + 1; i++) {
    const r = runCLI([dir, "append", "compactions", JSON.stringify({ at: "M1", reason: `auto-${i}`, session: null })])
    assert.equal(r.exitCode, 0, r.stderr)
  }
  const crumbs = readState(statePath).compactions
  assert.equal(crumbs.length, COMPACTIONS_KEPT)
  assert.equal(crumbs[0].reason, "auto-1")
  assert.equal(crumbs.at(-1).reason, `auto-${COMPACTIONS_KEPT}`)
})

// ── upsert-escalation: closed vocabularies + merging proof lists ───────

test("upsert-escalation refuses a status/route/implementedBy outside its vocabulary, and an unknown milestone (byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const bad of [
    { status: "complete" },
    { status: "planned" },
    { route: "delgate" },
    { implementedBy: "escalation-wroker" },
    { implementedBy: 7 },
    { milestone: "M9" },
    { milestone: "../x" },
    { route: "inline", implementedBy: "escalation-worker" }, // contradiction
    { route: "delegate", implementedBy: "orchestrator-inline" },
  ]) {
    const r = runCLI([dir, "upsert-escalation", "E-1", JSON.stringify({ ...ESC_CREATE, ...bad })])
    assert.equal(r.exitCode, 1, JSON.stringify(bad))
  }
  assert.equal(readRaw(statePath), before)
  const ok = runCLI([
    dir,
    "upsert-escalation",
    "E-1",
    JSON.stringify({ ...ESC_CREATE, route: "delegate", implementedBy: "escalation-worker", status: "pending" }),
  ])
  assert.equal(ok.exitCode, 0, ok.stderr)
  assert.equal(readState(statePath).escalations[0].milestone, "M1")
})

test("upsert-escalation APPENDS verifiedBy across calls (never drops an earlier proof); the same command replaces in place", () => {
  const { dir, statePath } = makeTempPrd()
  const proof = (command, evidence = "ok") => ({ command, exit: 0, evidence, readOnly: true })
  const up = (payload) => runCLI([dir, "upsert-escalation", "E-1", JSON.stringify(payload)])
  assert.equal(up({ ...ESC_CREATE, reason: "r", files: ["a.ts"], verifiedBy: [proof("grep a a.ts")] }).exitCode, 0)
  assert.equal(up({ verifiedBy: [proof("grep b b.ts")] }).exitCode, 0)
  assert.equal(up({ verifiedBy: [proof("grep a a.ts", "re-run, still there")] }).exitCode, 0)
  const entry = readState(statePath).escalations[0]
  assert.deepEqual(
    entry.verifiedBy.map((v) => [v.command, v.evidence]),
    [
      ["grep a a.ts", "re-run, still there"],
      ["grep b b.ts", "ok"],
    ],
  )
  assert.equal(entry.reason, "r") // not re-stated, still there
})

test("upsert-escalation: `amends` replaces exactly the named proof (pin/narrow), and refuses one that names nothing", () => {
  const { dir, statePath } = makeTempPrd()
  const proof = (command, extra = {}) => ({ command, exit: 0, evidence: "ok", readOnly: true, ...extra })
  const up = (payload) => runCLI([dir, "upsert-escalation", "E-1", JSON.stringify(payload)])
  assert.equal(up({ ...ESC_CREATE, verifiedBy: [proof("grep X a.ts"), proof("pnpm typecheck --force")] }).exitCode, 0)
  const pinned = "git show abc123:a.ts | grep X"
  assert.equal(up({ verifiedBy: [proof(pinned, { amends: "grep X a.ts" })] }).exitCode, 0)
  const entry = readState(statePath).escalations[0]
  assert.deepEqual(entry.verifiedBy.map((v) => v.command), [pinned, "pnpm typecheck --force"])
  assert.equal(entry.verifiedBy[0].amends, "grep X a.ts") // provenance kept: amended, never deleted

  const before = readRaw(statePath)
  const r = up({ verifiedBy: [proof("grep Y a.ts", { amends: "no such command" })] })
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr, /names no stored verifiedBy command/)
  assert.equal(readRaw(statePath), before)
})

test("upsert-escalation: `amends` matches a legacy {cmd, exitCode} proof too", () => {
  const { dir, statePath } = makeTempPrd({
    escalations: [{ id: "E-1", verifiedBy: [{ cmd: "pnpm --filter @etros/web exec playwright test", exitCode: 0 }], status: "verified" }],
  })
  const r = runCLI([
    dir,
    "upsert-escalation",
    "E-1",
    JSON.stringify({
      verifiedBy: [{ command: "grep -n touch packages/ui/tailwind-preset.ts", exit: 0, evidence: "token present", readOnly: true, amends: "pnpm --filter @etros/web exec playwright test" }],
    }),
  ])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(readState(statePath).escalations[0].verifiedBy.map((v) => v.command ?? v.cmd), [
    "grep -n touch packages/ui/tailwind-preset.ts",
  ])
})

test("upsert-escalation appends nonVacuityProofs across calls, keyed on method", () => {
  const { dir, statePath } = makeTempPrd()
  const p = (method, result) => ({ method, result, at: "2026-11-02T00:00:00Z" })
  const up = (payload) => runCLI([dir, "upsert-escalation", "E-1", JSON.stringify(payload)])
  assert.equal(up({ ...ESC_CREATE, nonVacuityProofs: [p("plant and restore", "fired")] }).exitCode, 0)
  assert.equal(up({ nonVacuityProofs: [p("gap-guard flip", "red then green")] }).exitCode, 0)
  assert.equal(up({ nonVacuityProofs: [p("plant and restore", "fired again")] }).exitCode, 0)
  assert.deepEqual(
    readState(statePath).escalations[0].nonVacuityProofs.map((x) => [x.method, x.result]),
    [
      ["plant and restore", "fired again"],
      ["gap-guard flip", "red then green"],
    ],
  )
})

test("upsert-escalation: the documented dispatch → done sequence feeds bookkeeping check 4b (status done needs the handoff)", () => {
  const { dir, statePath } = makeTempPrd()
  const dispatch = runCLI([
    dir,
    "upsert-escalation",
    "E-auth",
    JSON.stringify({ milestone: "M1", reason: "r", files: ["a.ts", "b.ts"], route: "delegate", implementedBy: "escalation-worker", status: "in-progress" }),
  ])
  assert.equal(dispatch.exitCode, 0, dispatch.stderr) // in-progress with no handoff yet: a warn, never a refusal
  const before = readRaw(statePath)
  const early = runCLI([dir, "upsert-escalation", "E-auth", JSON.stringify({ status: "done" })])
  assert.equal(early.exitCode, 1) // done without handoffs/ESC-E-auth.json
  assert.match(early.stderr, /esc-escalation-missing-handoff/)
  assert.equal(readRaw(statePath), before)
  writeHandoff(dir, "ESC-E-auth.json", { feature: "ESC-E-auth", status: "complete" })
  assert.equal(runCLI([dir, "upsert-escalation", "E-auth", JSON.stringify({ status: "done" })]).exitCode, 0)
})

// ── set-gate: several gates in ONE milestone keep every record ────────

test("set-gate integration run three times in one milestone keeps BOTH earlier records in history", () => {
  const { dir, statePath } = makeTempPrd()
  const gate = (passed, scope, ts) => runCLI([dir, "set-gate", "integration", JSON.stringify({ passed, scope, ts, milestone: "M1", commands: [{ cmd: "pnpm typecheck --force", exitCode: passed ? 0 : 2 }] })])
  assert.equal(gate(true, "M1 first", "2026-11-01T00:00:00Z").exitCode, 0)
  assert.equal(gate(false, "M1 rerun", "2026-11-02T00:00:00Z").exitCode, 0)
  assert.equal(gate(true, "M1 fixed", "2026-11-03T00:00:00Z").exitCode, 0)
  const g = readState(statePath).integrationGate
  assert.equal(g.scope, "M1 fixed")
  assert.deepEqual(Object.keys(g.history).sort(), ["M1", "M1#2"])
  assert.equal(g.history.M1.scope, "M1 first")
  assert.deepEqual(g.history.M1.commands, [{ cmd: "pnpm typecheck --force", exitCode: 0 }])
  assert.equal(g.history["M1#2"].scope, "M1 rerun")
})

// ── set-milestone-status: closed vocabulary ───────────────────────────

test("set-milestone-status refuses a status outside pending|in-progress|done (byte-identical)", () => {
  const { dir, statePath } = makeTempPrd()
  const before = readRaw(statePath)
  for (const bad of ["bogus", "complete", "passed"]) {
    const r = runCLI([dir, "set-milestone-status", "M1", bad])
    assert.equal(r.exitCode, 1, bad)
  }
  assert.equal(readRaw(statePath), before)
})

test("milestoneVerdictBlockers: newest file per round-suffix group decides; M1 never matches M10; unparseable files are skipped", () => {
  const { dir } = makeTempPrd()
  writeVerdict(dir, "M1-auth.json", { validatedAt: "2026-11-01T00:00:00Z", verdicts: [], missingDefaults: ["README"] })
  writeVerdict(dir, "M1-auth-r1.json", { validatedAt: "2026-11-02T00:00:00Z", verdicts: [], missingDefaults: [] })
  writeVerdict(dir, "M1-web-api.json", { validatedAt: "2026-11-02T00:00:00Z", verdicts: [], boundaryViolations: ["x.ts"] })
  writeVerdict(dir, "M10-auth.json", { validatedAt: "2026-11-02T00:00:00Z", verdicts: [], boundaryViolations: ["y.ts"] })
  writeFileSync(path.join(dir, "verdicts", "M1-broken.json"), "{ nope", "utf8")
  assert.deepEqual(milestoneVerdictBlockers(dir, "M1"), ["verdicts/M1-web-api.json (boundaryViolations=1, missingDefaults=0)"])
  assert.deepEqual(milestoneVerdictBlockers(dir, "M10"), ["verdicts/M10-auth.json (boundaryViolations=1, missingDefaults=0)"])
})

// ── add-decision / add-constraint: plan-scoped records ─────────────────

test('add-decision / add-constraint accept the plan-scoped milestone "plan", and still refuse any other unknown id', () => {
  const { dir, statePath } = makeTempPrd()
  assert.equal(runCLI([dir, "add-decision", "plan", "staff sign-in is email-code", "--why", "owner ruling 1b"]).exitCode, 0)
  assert.equal(runCLI([dir, "add-constraint", "plan", "Auth.js owns /api/auth/*", "--impact", "OTP routes at /api/auth/code/*"]).exitCode, 0)
  const s = readState(statePath)
  assert.equal(s.decisions.at(-1).milestone, PLAN_DECISION_MILESTONE)
  assert.equal(s.constraints.at(-1).milestone, PLAN_DECISION_MILESTONE)
  for (const verb of [["add-decision", "--why"], ["add-constraint", "--impact"]]) {
    const r = runCLI([dir, verb[0], "Mplan", "x", verb[1], "y"])
    assert.equal(r.exitCode, 1, verb[0])
  }
})
