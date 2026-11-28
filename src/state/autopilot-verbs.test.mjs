/**
 * node:test for the autopilot and evidence verbs of `mission state`:
 * set-field autopilot, dispatch-esc, close-esc, rerun-verified,
 * record-testgaps-from-verdicts, append-followups, capture-verdict, and the
 * machine-stamped ts of set-gate / merge-meta / close-esc.
 *
 * Every case runs against a throwaway mission dir under os.tmpdir().
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { runCLI } from "./mission-state.mjs"
import { checkBookkeeping } from "../rules/bookkeeping.mjs"

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
    followUps: [],
    testGaps: [],
    activeWorker: null,
    milestones: [{ id: "M1", order: 1, status: "pending", assertions: ["A-1"], escalations: [] }],
    ...overrides,
  }
}

/** A mission dir inside a fresh git repository (rerun-verified resolves the root). */
function makeMission(overrides = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "autopilot-verbs-")))
  execFileSync("git", ["init", "-q"], { cwd: root })
  const dir = path.join(root, "docs", "prd", "demo")
  mkdirSync(dir, { recursive: true })
  const statePath = path.join(dir, "mission-state.json")
  writeFileSync(statePath, JSON.stringify(baseState(overrides), null, 2) + "\n")
  return { root, dir, statePath }
}
const readState = (p) => JSON.parse(readFileSync(p, "utf8"))
const writeJson = (p, doc) => {
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(doc, null, 2) + "\n")
  return p
}
const approved = (over = {}) => ({
  enabled: true,
  phase: "run-pending",
  approvedBy: "human",
  approvedAt: "2026-01-28T10:00:00Z",
  brief: "Run docs/prd/demo end to end on branch demo/m1.",
  ...over,
})
const nearNow = (ts) => Math.abs(Date.parse(ts) - Date.now()) < 60_000

// ── set-field autopilot ───────────────────────────────────────────────────

test("set-field autopilot validates the whole record and each sub-field; a half approval is refused byte-identical", () => {
  const { dir, statePath } = makeMission()
  const before = readFileSync(statePath, "utf8")
  assert.equal(runCLI([dir, "set-field", "autopilot.phase", '"running"']).exitCode, 1, "no record yet")
  assert.equal(runCLI([dir, "set-field", "autopilot", JSON.stringify(approved({ approvedBy: "orchestrator" }))]).exitCode, 1)
  assert.equal(runCLI([dir, "set-field", "autopilot", JSON.stringify(approved({ brief: undefined }))]).exitCode, 1)
  assert.equal(readFileSync(statePath, "utf8"), before)
  let r = runCLI([dir, "set-field", "autopilot", JSON.stringify(approved())])
  assert.equal(r.exitCode, 0, r.stderr)
  r = runCLI([dir, "set-field", "autopilot.phase", '"landing"'])
  assert.equal(r.exitCode, 0, r.stderr)
  r = runCLI([dir, "set-field", "autopilot.pr", "42"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(runCLI([dir, "set-field", "autopilot.phase", '"blocked"']).exitCode, 1, "blocked needs blockedOn")
  assert.equal(runCLI([dir, "set-field", "autopilot.phase", '"sprinting"']).exitCode, 1)
  assert.equal(runCLI([dir, "set-field", "autopilot.enabled", "false"]).exitCode, 2, "enabled is not a sub-field")
  assert.equal(runCLI([dir, "set-field", "autopilot.approvedBy", '"human"']).exitCode, 2, "nor is the approval")
  const a = readState(statePath).autopilot
  assert.equal(a.phase, "landing")
  assert.equal(a.pr, 42)
})

// ── machine-stamped time ──────────────────────────────────────────────────

test("set-gate stamps ts now when omitted, and refuses a typed non-ISO ts", () => {
  const { dir, statePath } = makeMission()
  let r = runCLI([dir, "set-gate", "integration", JSON.stringify({ passed: true, scope: "M1: x" })])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.ok(nearNow(readState(statePath).integrationGate.ts))
  r = runCLI([dir, "set-gate", "e2e", JSON.stringify({ areas: [], results: {} })])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.ok(nearNow(readState(statePath).e2eGate.ts))
  assert.equal(runCLI([dir, "set-gate", "integration", JSON.stringify({ passed: true, scope: "s", ts: "yesterday" })]).exitCode, 1)
  assert.equal(runCLI([dir, "set-gate", "integration", JSON.stringify({ passed: true, scope: "s", ts: "2026-01-28" })]).exitCode, 1, "a date with no time is refused")
})

// ── follow-ups ────────────────────────────────────────────────────────────

test("append-followups is idempotent: a second run of the same file adds nothing and leaves the state byte-identical", () => {
  const { dir, statePath, root } = makeMission({ followUps: ["[bug, med] existing"] })
  const file = path.join(root, "fu.txt")
  writeFileSync(file, "[bug, med] existing\n[tech-debt, low] new one\n\n[human] a pricing call\n")
  let r = runCLI([dir, "append-followups", file])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.match(r.stdout, /added 2, skipped 1/)
  assert.deepEqual(readState(statePath).followUps, ["[bug, med] existing", "[tech-debt, low] new one", "[human] a pricing call"])
  const before = readFileSync(statePath, "utf8")
  r = runCLI([dir, "append-followups", file])
  assert.match(r.stdout, /added 0, skipped 3/)
  assert.equal(readFileSync(statePath, "utf8"), before)
  assert.equal(runCLI([dir, "append-followups", path.join(root, "missing.txt")]).exitCode, 2)
})

// ── dispatch-esc / close-esc ──────────────────────────────────────────────

const ESC_CONFIG = { protectedPaths: [{ glob: "packages/core/**", alwaysDelegate: true }], testGlobs: ["test/**"], additivePairs: [] }

test("dispatch-esc routes the files with the config, records a delegate in-progress with its grant, and sets activeWorker in one write", () => {
  const { dir, statePath } = makeMission()
  const r = runCLI([dir, "dispatch-esc", "E-core", "--files", "packages/core/math.ts", "--reason", "shared formula", "--feature", "F-1"], { escalation: ESC_CONFIG })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.match(r.stdout, /route=delegate activeWorker=ESC-E-core/)
  const s = readState(statePath)
  const e = s.escalations.find((x) => x.id === "E-core")
  assert.equal(e.milestone, "M1", "defaults to currentMilestone on create")
  assert.equal(e.status, "in-progress")
  assert.equal(e.route, "delegate")
  assert.equal(e.implementedBy, "escalation-worker")
  assert.equal(e.feature, "F-1")
  assert.deepEqual(e.workerPathGlobs, ["packages/core/math.ts", "packages/core/**", "test/**"], "the config's test globs are granted")
  assert.equal(s.activeWorker.feature, "ESC-E-core")
  assert.ok(nearNow(s.activeWorker.at))
  assert.deepEqual(checkBookkeeping(s, { handoffFiles: [] }).filter((f) => f.severity === "error"), [])
})

test("dispatch-esc: escalations are serial, so a second delegate is refused while the first is in progress", () => {
  const { dir, statePath } = makeMission()
  assert.equal(runCLI([dir, "dispatch-esc", "E-a", "--files", "a/x.ts,a/y.ts", "--reason", "two files"]).exitCode, 0)
  const before = readFileSync(statePath, "utf8")
  const r = runCLI([dir, "dispatch-esc", "E-b", "--files", "b/x.ts,b/y.ts", "--reason", "disjoint, still serial"])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr, /escalations are serial and E-a is still in progress/)
  assert.equal(readFileSync(statePath, "utf8"), before, "a refusal leaves the state byte-identical")
})

test("dispatch-esc: a single additive entry is inline (no activeWorker); create needs --reason; done is never re-dispatched", () => {
  const { dir, statePath } = makeMission()
  let r = runCLI([dir, "dispatch-esc", "E-env", "--files", "src/env.ts", "--additive", "--reason", "one env key"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.match(r.stdout, /route=inline/)
  let s = readState(statePath)
  assert.equal(s.escalations[0].implementedBy, "orchestrator-inline")
  assert.equal(s.activeWorker, null)
  const before = readFileSync(statePath, "utf8")
  assert.equal(runCLI([dir, "dispatch-esc", "E-new", "--files", "a.ts,b.ts"]).exitCode, 1, "create needs --reason")
  assert.equal(runCLI([dir, "dispatch-esc", "E-new", "--files", ""]).exitCode, 2, "no files is a malformed call")
  assert.equal(readFileSync(statePath, "utf8"), before)
  const proof = (extra) => JSON.stringify([{ command: "grep -c KEY src/env.ts", evidence: "1", ...extra }])
  assert.equal(runCLI([dir, "close-esc", "E-env", "--verified", proof({})]).exitCode, 2, "readOnly must be stated")
  r = runCLI([dir, "close-esc", "E-env", "--verified", proof({ readOnly: true })])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.match(r.stdout, /inline, no handoff/)
  assert.equal(runCLI([dir, "dispatch-esc", "E-env", "--files", "src/env.ts", "--additive"]).exitCode, 1, "done is never re-dispatched")
  s = readState(statePath)
  assert.equal(s.escalations[0].status, "done")
})

test("close-esc merges the handoff _meta (ts now), records done plus the proofs, and clears its own activeWorker", () => {
  const { dir, statePath } = makeMission()
  runCLI([dir, "dispatch-esc", "E-a", "--files", "a/x.ts,a/y.ts", "--reason", "two files"])
  const verified = JSON.stringify([{ command: "grep -c x a/x.ts", evidence: "present", readOnly: true }])
  assert.equal(runCLI([dir, "close-esc", "E-a", "--verified", verified, "--tokens", "1200"]).exitCode, 1, "no handoff on disk: the handoffWritten claim is false")
  writeJson(path.join(dir, "handoffs", "ESC-E-a.json"), { feature: "ESC-E-a", status: "complete", filesChanged: ["a/x.ts"] })
  assert.equal(runCLI([dir, "close-esc", "E-a", "--verified", verified]).exitCode, 2, "--tokens needed when the handoff has no _meta")
  assert.equal(runCLI([dir, "close-esc", "E-a", "--verified", "[]", "--tokens", "5"]).exitCode, 1, "no proof at all is refused")
  assert.equal(runCLI([dir, "close-esc", "E-a", "--verified", "{", "--tokens", "5"]).exitCode, 2)
  assert.equal(runCLI([dir, "close-esc", "E-a", "--verified", verified, "--tokens", "5", "--ts", "yesterday"]).exitCode, 1)
  const r = runCLI([dir, "close-esc", "E-a", "--verified", verified, "--tokens", "1200"])
  assert.equal(r.exitCode, 0, r.stderr)
  const h = JSON.parse(readFileSync(path.join(dir, "handoffs", "ESC-E-a.json"), "utf8"))
  assert.equal(h._meta.tokensSpent, 1200)
  assert.equal(h._meta.attribution, "exact")
  assert.ok(nearNow(h._meta.ts))
  const s = readState(statePath)
  const e = s.escalations.find((x) => x.id === "E-a")
  assert.equal(e.status, "done")
  assert.deepEqual(e.verifiedBy, [{ exit: 0, command: "grep -c x a/x.ts", evidence: "present", readOnly: true }])
  assert.equal(s.activeWorker, null)
  assert.equal(runCLI([dir, "close-esc", "E-a", "--verified", verified]).exitCode, 1, "already done")
  assert.equal(runCLI([dir, "close-esc", "E-zz", "--verified", verified]).exitCode, 1, "unrecorded")
  assert.deepEqual(checkBookkeeping(s, { handoffFiles: ["ESC-E-a.json"] }).filter((f) => f.severity === "error"), [])
  // Now that E-a is closed, the next delegate may go.
  assert.equal(runCLI([dir, "dispatch-esc", "E-b", "--files", "b/x.ts,b/y.ts", "--reason", "next"]).exitCode, 0)
})

test("merge-meta keeps an existing _meta.ts when none is given, and refuses a typed non-ISO one", () => {
  const { dir } = makeMission()
  const h = writeJson(path.join(dir, "handoffs", "F-1.json"), { feature: "F-1", _meta: { tokensSpent: 1, attribution: "exact", ts: "2026-01-01T00:00:00Z" } })
  assert.equal(runCLI([dir, "merge-meta", "handoffs/F-1.json", JSON.stringify({ tokensSpent: 2, ts: "soon" })]).exitCode, 1)
  assert.equal(runCLI([dir, "merge-meta", "handoffs/F-1.json", JSON.stringify({ tokensSpent: 2 })]).exitCode, 0)
  assert.equal(JSON.parse(readFileSync(h, "utf8"))._meta.ts, "2026-01-01T00:00:00Z", "a later merge never moves the first stamp")
})

// ── rerun-verified ────────────────────────────────────────────────────────

const inlineEsc = (id, verifiedBy, extra = {}) => ({ id, milestone: "M1", reason: "r", files: ["f"], status: "done", route: "inline", implementedBy: "orchestrator-inline", verifiedBy, ...extra })

test("rerun-verified runs every proof in the repository root, exits 1 on any red or missing one, and --record stores the results", () => {
  const { root, dir, statePath } = makeMission({
    milestones: [{ id: "M1", order: 1, status: "pending", assertions: ["A-1"], escalations: ["E-none"] }],
    escalations: [
      inlineEsc("E-ok", [{ command: "test -f marker.txt", exit: 0, evidence: "e", readOnly: true }]),
      inlineEsc("E-red", [{ command: "grep -q never marker.txt", exit: 0, evidence: "e", readOnly: true }]),
    ],
  })
  writeFileSync(path.join(root, "marker.txt"), "hello\n")
  const logDir = path.join(root, "..", path.basename(root) + "-logs")
  const before = readFileSync(statePath, "utf8")
  let r = runCLI([dir, "rerun-verified", "M1", "--log-dir", logDir])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr, /1\/3 green; RED: E-none \(no verifiedBy\), E-red exit=1/)
  assert.equal(readFileSync(statePath, "utf8"), before, "without --record nothing is written")
  r = runCLI([dir, "rerun-verified", "M1", "--record", "--log-dir", logDir])
  assert.equal(r.exitCode, 1)
  const note = readState(statePath).boundaryNotes["rerunVerified-M1"]
  assert.equal(note.passed, false)
  assert.equal(note.results.length, 3)
  assert.equal(note.results.find((x) => x.id === "E-ok").exit, 0)
  const green = makeMission({ escalations: [inlineEsc("E-ok", [{ command: "true", exit: 0, evidence: "e", readOnly: true }])] })
  r = runCLI([green.dir, "rerun-verified", "M1", "--record", "--log-dir", path.join(green.root, "..", path.basename(green.root) + "-logs")])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readState(green.statePath).boundaryNotes["rerunVerified-M1"].passed, true)
  assert.equal(runCLI([dir, "rerun-verified", "M9"]).exitCode, 1, "unknown milestone")
})

test("rerun-verified never executes an inadmissible entry, and refuses a --log-dir outside the temp roots", () => {
  const { root, dir, statePath } = makeMission({
    escalations: [inlineEsc("E-x", [{ command: "touch planted.txt", exit: 0, evidence: "e", readOnly: false }, { cmd: "touch legacy.txt", exitCode: 0 }])],
  })
  const r = runCLI([dir, "rerun-verified", "M1", "--record", "--log-dir", path.join(root, "..", "logs-x")])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr, /0\/2 green; RED: E-x \(not admissible/)
  assert.equal(existsSync(path.join(root, "planted.txt")), false)
  assert.equal(existsSync(path.join(root, "legacy.txt")), false)
  const before = readFileSync(statePath, "utf8")
  const outside = path.join(homedir(), `.not-a-temp-dir-${process.pid}`)
  assert.equal(runCLI([dir, "rerun-verified", "M1", "--log-dir", outside]).exitCode, 1)
  assert.equal(existsSync(outside), false, "nothing is created outside the temp roots")
  assert.equal(readFileSync(statePath, "utf8"), before)
})

test("rerun-verified refuses to record when the proof set changed while its commands ran", () => {
  const { dir, statePath } = makeMission()
  // The proof (readOnly as far as its record goes) adds a sibling escalation
  // through the CLI while the unlocked run is in progress.
  const late = JSON.stringify({ milestone: "M1", reason: "late", files: ["z"], status: "pending" })
  const sneaky = `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI_PATH)} ${JSON.stringify(dir)} upsert-escalation E-late '${late}'`
  writeFileSync(statePath, JSON.stringify(baseState({ escalations: [inlineEsc("E-x", [{ command: sneaky, exit: 0, evidence: "e", readOnly: true }])] }), null, 2) + "\n")
  const r = runCLI([dir, "rerun-verified", "M1", "--record"])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr, /proof set changed while the commands ran/)
  const s = readState(statePath)
  assert.ok(s.escalations.some((e) => e.id === "E-late"), "the mid-run write landed")
  assert.equal(s.boundaryNotes["rerunVerified-M1"], undefined, "the stale results were not recorded")
})

// ── test gaps ─────────────────────────────────────────────────────────────

test("record-testgaps-from-verdicts records terminal gaps and ACCEPTED follow-ups once, from this milestone's verdicts only", () => {
  const { dir, statePath } = makeMission({ milestones: [{ id: "M1", order: 1, status: "pending", assertions: ["A-1"] }, { id: "M2", order: 2, status: "pending", assertions: [] }] })
  writeJson(path.join(dir, "verdicts", "M1-web.json"), { area: "web", verdicts: [{ id: "A-1", verdict: "pass" }], testGaps: [{ id: "A-1", kind: "mocked-boundary", detail: "mocks the seam" }, { id: "A-1b", kind: "behavioral-not-run", detail: "no browser runner" }] })
  writeJson(path.join(dir, "verdicts", "M2-web.json"), { area: "web", verdicts: [], testGaps: [{ id: "Z", kind: "impl-mirroring", detail: "not M1" }] })
  let r = runCLI([dir, "record-testgaps-from-verdicts", "M1", "--default", "ACCEPTED", "--closed", "A-1"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.match(r.stdout, /2 terminal record\(s\) \(CLOSED 1, ACCEPTED 1; followUps \+1\)/)
  let s = readState(statePath)
  assert.deepEqual(s.testGaps.map((g) => [g.id, g.resolution]), [["A-1", "CLOSED"], ["A-1b", "ACCEPTED"]])
  assert.equal(s.followUps.length, 1)
  assert.match(s.followUps[0], /^\[test-gap, low\] M1 testGap A-1b \(behavioral-not-run\) ACCEPTED/)
  r = runCLI([dir, "record-testgaps-from-verdicts", "M1", "--default", "ACCEPTED", "--closed", "A-1"])
  assert.match(r.stdout, /0 terminal record/)
  s = readState(statePath)
  assert.equal(s.testGaps.length, 2)
  assert.equal(s.followUps.length, 1)
  assert.equal(runCLI([dir, "record-testgaps-from-verdicts", "M1", "--default", "OPEN"]).exitCode, 1)
  assert.equal(runCLI([dir, "record-testgaps-from-verdicts", "M1", "--default", "DEFERRED-TO-M7"]).exitCode, 1, "unknown milestone")
  assert.equal(runCLI([dir, "record-testgaps-from-verdicts", "M2", "--default", "DEFERRED-TO-M2"]).exitCode, 0)
})

test("record-testgaps-from-verdicts: only the newest -r<n> round of an area counts, and a multi-line detail is one follow-up", () => {
  const { dir, statePath } = makeMission()
  writeJson(path.join(dir, "verdicts", "M1-web.json"), { area: "web", verdicts: [], testGaps: [{ id: "G-old", kind: "mocked-boundary", detail: "fixed by the hardening round" }] })
  writeJson(path.join(dir, "verdicts", "M1-web-r1.json"), { area: "web", verdicts: [], testGaps: [{ id: "G-1", kind: "missing-edge-cases", detail: "Route X untested:\n- 401 path\n- 409 path" }] })
  writeJson(path.join(dir, "verdicts", "M1-api.json"), { area: "api", verdicts: [], testGaps: [{ id: "G-api", kind: "impl-mirroring", detail: "mirror" }] })
  const r = runCLI([dir, "record-testgaps-from-verdicts", "M1", "--default", "ACCEPTED"])
  assert.equal(r.exitCode, 0, r.stderr)
  const s = readState(statePath)
  assert.deepEqual(s.testGaps.map((g) => g.id).sort(), ["G-1", "G-api"], "G-old was superseded by M1-web-r1")
  assert.equal(s.testGaps.find((g) => g.id === "G-1").detail, "Route X untested: - 401 path - 409 path")
  assert.equal(s.followUps.length, 2)
})

// ── capture-verdict ───────────────────────────────────────────────────────

const VERDICT = JSON.stringify({ area: "web", validatedAt: "2026-01-28T01:02:03Z", verdicts: [{ id: "A-1", verdict: "pass", evidence: "npm test exit 0 — a long evidence string that must not be condensed" }], boundaryViolations: [], missingDefaults: [], testGaps: [] })
const transcript = (message) =>
  [
    { message: { role: "user", content: [{ type: "text", text: "validate M1" }] } },
    { message: { role: "assistant", content: [{ type: "text", text: 'draft: {"area":"web","verdicts":[]}' }] } },
    { message: { role: "assistant", content: [{ type: "tool_use", name: "SubagentHandback", input: { message } }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n"

test("capture-verdict writes the validator's return byte-for-byte to verdicts/ and derives through record-verdict's rule", () => {
  const { root, dir, statePath } = makeMission()
  const sub = path.join(root, "..", path.basename(root) + "-transcripts")
  mkdirSync(sub, { recursive: true })
  writeFileSync(path.join(sub, "agent-v1.jsonl"), transcript(VERDICT))
  writeFileSync(path.join(sub, "agent-w1.jsonl"), transcript('{"feature":"x"}'))
  let r = runCLI([dir, "capture-verdict", "M1", "--agent", "v1", "--as", "M1-web.json", "--transcripts", sub])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.match(r.stdout, /capture-verdict M1 -> verdicts\/M1-web\.json \(derived A-1=passing\)/)
  assert.equal(readFileSync(path.join(dir, "verdicts", "M1-web.json"), "utf8"), VERDICT)
  assert.equal(readState(statePath).assertionStatus["A-1"], "passing")
  assert.equal(runCLI([dir, "capture-verdict", "M1", "--agent", "v1", "--as", "M1-web.json", "--transcripts", sub]).exitCode, 0, "identical bytes are idempotent")
  assert.equal(runCLI([dir, "capture-verdict", "M1", "--agent", "w1", "--as", "M1-other.json", "--transcripts", sub]).exitCode, 1, "no verdict in a worker transcript")
  assert.equal(runCLI([dir, "capture-verdict", "M1", "--agent", "v1", "--as", "ESC-x.json", "--transcripts", sub]).exitCode, 1, "the name must belong to the milestone")
  assert.equal(runCLI([dir, "capture-verdict", "M1", "--agent", "v1", "--as", "../M1-x.json", "--transcripts", sub]).exitCode, 1, "a name, not a path")
  assert.equal(runCLI([dir, "capture-verdict", "M1", "--agent", "zz", "--as", "M1-zz.json", "--transcripts", sub]).exitCode, 1)
  assert.equal(runCLI([dir, "capture-verdict", "M1", "--agent", "v1", "--as", "M1-web.json"]).exitCode, 2, "--agent needs --transcripts")
  assert.equal(runCLI([dir, "capture-verdict", "M1", "--as", "M1-web.json"]).exitCode, 2, "one source is required")
  const r2 = runCLI([dir, "capture-verdict", "M1", "--agent", "v1", "--as", "M1-api.json", "--transcripts", sub])
  assert.equal(r2.exitCode, 1)
  assert.match(r2.stderr, /area is "web" but --as M1-api\.json names "api"/)
  assert.equal(existsSync(path.join(dir, "verdicts", "M1-api.json")), false)
})

test("capture-verdict --transcript reads a plain returned message too (a runtime with no JSONL transcript)", () => {
  const { root, dir } = makeMission()
  const file = path.join(root, "..", path.basename(root) + "-returned.txt")
  writeFileSync(file, VERDICT)
  const r = runCLI([dir, "capture-verdict", "M1", "--transcript", file, "--as", "M1-web.json"])
  assert.equal(r.exitCode, 0, r.stderr)
  assert.equal(readFileSync(path.join(dir, "verdicts", "M1-web.json"), "utf8"), VERDICT)
  assert.equal(runCLI([dir, "capture-verdict", "M1", "--transcript", path.join(root, "nope"), "--as", "M1-web.json"]).exitCode, 1)
})
