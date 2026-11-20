/**
 * node:test for commit-boundary.mjs .
 * Run: npm test
 *
 * Every expected finding is written out from DEF-boundary-M5's statement in
 * docs/prd/missions-harness-lean-context-and-lanes/validation-contract.json and
 * from FU-46's two rulings (an exact decisions[] match; a retroactive grant
 * blocks until the owner acknowledges it), not computed by the module.
 */
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { commitBoundaryReport, prdAdditiveViolations, runCLI } from "./commit-boundary.mjs"

const LIB_PATH = fileURLToPath(new URL("./commit-boundary.mjs", import.meta.url))

const tempDirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})
const PRD = "docs/prd/m"
const RULES = Object.freeze({
  exempt: [`${PRD}/mission-state.json`, `${PRD}/00-prd.md`, `${PRD}/verdicts/**`, `${PRD}/handoffs/**`],
  forbidden: [".claude/settings.local.json", "apps/backend/app/api/**", "packages/db/**", "apps/mobile/**"],
  forbiddenExceptions: ["apps/mobile/lib/__tests__"],
  archTestGlobs: ["apps/backend/__tests__/architecture/**"],
  prdPath: `${PRD}/00-prd.md`,
  ownerAcceptedPrefixes: ["fix(harness): reconcile the rebase onto main"],
})
const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const SHA_B = "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const DECISION = "M5-C1d's grant gained references/architecture.md (1eed88386)"

const esc = (id, files, extra = {}) => ({ id, files, ...extra })
const state = (escalations = [], decisions = []) => ({ escalations, decisions })
const change = (p, status = "M") => ({ path: p, status })
function commit(sha, files, stateAtParent, extra = {}) {
  return { sha, subject: `feat(harness): ${sha.slice(0, 9)}`, files: files.map((f) => (typeof f === "string" ? change(f) : f)), stateAtParent, ...extra }
}
const rulesOf = (report) => report.violations.map((v) => [v.path, v.rule])

test("a commit claimed through escalations[].commit, touching only its parent-time grant and exempt paths, is clean", () => {
  const parent = state([esc("C1", ["lib/a.mjs", "lib/b/**"])])
  const head = state([esc("C1", ["lib/a.mjs", "lib/b/**"], { commit: SHA_A.slice(0, 9) })])
  const report = commitBoundaryReport([commit(SHA_A, ["lib/a.mjs", "lib/b/c/d.mjs", `${PRD}/mission-state.json`, `${PRD}/verdicts/M5-x.json`], parent)], head, RULES)
  assert.deepEqual(report, {
    ok: true,
    violations: [],
    retroactive: [],
    informational: [],
    commits: [{ sha: SHA_A, subject: `feat(harness): ${SHA_A.slice(0, 9)}`, claims: ["C1"], findings: [] }],
  })
})

test("a path outside every claimed grant is stray, and a trailing-slash grant is named as the reason it matched nothing", () => {
  const parent = state([esc("C1", ["lib/a.mjs", "lib/b/"])])
  const head = state([esc("C1", ["lib/a.mjs", "lib/b/"], { commit: SHA_A })])
  const report = commitBoundaryReport([commit(SHA_A, ["lib/a.mjs", "lib/other.mjs", "lib/b/c.mjs"], parent)], head, RULES)
  assert.equal(report.ok, false)
  assert.deepEqual(rulesOf(report), [["lib/other.mjs", "stray"], ["lib/b/c.mjs", "stray"]])
  assert.match(report.violations[1].detail, /the grant lib\/b\/ ends in a slash, which matches nothing$/)
})

test("a commit no escalation claims may carry exempt paths only", () => {
  const exemptOnly = commitBoundaryReport([commit(SHA_A, [`${PRD}/mission-state.json`, `${PRD}/handoffs/C1.json`], state())], state(), RULES)
  assert.equal(exemptOnly.ok, true)
  const withCode = commitBoundaryReport([commit(SHA_A, [`${PRD}/mission-state.json`, "lib/a.mjs"], state())], state(), RULES)
  assert.deepEqual(rulesOf(withCode), [["lib/a.mjs", "no-claim"]])
})

test("a forbidden path fails inside a granted glob, and the mobile exception is a subtree", () => {
  const grant = ["apps/backend/**", "apps/mobile/**", ".claude/**"]
  const parent = state([esc("C1", grant)])
  const head = state([esc("C1", grant, { commit: SHA_A })])
  const files = [
    "apps/backend/app/api/user/x/route.ts",
    "apps/backend/server/x.ts",
    "apps/mobile/components/a.tsx",
    "apps/mobile/lib/__tests__/golden.test.ts",
    ".claude/settings.local.json",
  ]
  const report = commitBoundaryReport([commit(SHA_A, files, parent)], head, RULES)
  assert.deepEqual(rulesOf(report), [
    ["apps/backend/app/api/user/x/route.ts", "forbidden"],
    ["apps/mobile/components/a.tsx", "forbidden"],
    [".claude/settings.local.json", "forbidden"],
  ])
})

test("an existing architecture test must be named literally in a claimed grant; a glob does not name it, and a new one only needs the grant", () => {
  const test1 = "apps/backend/__tests__/architecture/harness-orchestrator-discipline.test.ts"
  const test2 = "apps/backend/__tests__/architecture/new-guard.test.ts"
  const parent = state([esc("C1", ["apps/backend/__tests__/**"])])
  const head = state([esc("C1", ["apps/backend/__tests__/**"], { commit: SHA_A })])
  const unnamed = commitBoundaryReport([commit(SHA_A, [change(test1, "M"), change(test2, "A")], parent)], head, RULES)
  assert.deepEqual(rulesOf(unnamed), [[test1, "unnamed-architecture-test"]])

  const namedParent = state([esc("C1", ["apps/backend/__tests__/**", test1])])
  const named = commitBoundaryReport([commit(SHA_A, [change(test1, "M")], namedParent)], state([esc("C1", [test1], { commit: SHA_A })]), RULES)
  assert.equal(named.ok, true)
})

test("FU-46: a grant counts only as it stood at the commit's parent; one recorded later is retroactive and blocks", () => {
  const parent = state([esc("C1", ["lib/a.mjs"])])
  const head = state([esc("C1", ["lib/a.mjs", "lib/late.mjs"], { commit: SHA_A })])
  const report = commitBoundaryReport([commit(SHA_A, ["lib/a.mjs", "lib/late.mjs"], parent)], head, RULES)
  assert.equal(report.ok, false)
  assert.deepEqual(report.violations, [])
  assert.deepEqual(
    report.retroactive.map((r) => [r.sha, r.path, r.rule, r.feature]),
    [[SHA_A, "lib/late.mjs", "stray", "C1"]],
  )
  assert.deepEqual(report.informational, [])
})

test("FU-46: an escalation first recorded after the commit it claims grants nothing at the parent", () => {
  const head = state([esc("C9", ["lib/a.mjs"], { commit: SHA_A })])
  const report = commitBoundaryReport([commit(SHA_A, ["lib/a.mjs"], state())], head, RULES)
  assert.deepEqual(report.retroactive.map((r) => [r.path, r.feature]), [["lib/a.mjs", "C9"]])
  assert.equal(report.ok, false)
})

test("FU-46: the owner's acknowledgement moves a retroactive grant to informational, for that commit and path only", () => {
  const parent = state([esc("C1", ["lib/a.mjs"])])
  const head = state([esc("C1", ["lib/a.mjs", "lib/late.mjs", "lib/later.mjs"], { commit: SHA_A })])
  const report = commitBoundaryReport([commit(SHA_A, ["lib/late.mjs", "lib/later.mjs"], parent)], head, {
    ...RULES,
    acknowledged: [{ sha: SHA_A.slice(0, 7), path: "lib/late.mjs" }, { sha: SHA_B, path: "lib/later.mjs" }],
  })
  assert.deepEqual(report.informational.map((i) => [i.path, i.rule]), [["lib/late.mjs", "stray-acknowledged"]])
  assert.deepEqual(report.retroactive.map((r) => r.path), ["lib/later.mjs"])
  assert.equal(report.ok, false)
})

test("FU-46: a grant extension grants its path only with {path, at, reason, decision} and a decision stated word for word at the parent", () => {
  const ext = { path: ".claude/skills/x/references/architecture.md", at: "2026-09-27T10:00:00Z", reason: "the doc names the new step", decision: DECISION }
  const file = ext.path
  const run = (extension, decisions) => {
    const parent = state([esc("C1", ["lib/a.mjs"], { grantExtensions: [extension] })], decisions)
    const head = state([esc("C1", ["lib/a.mjs"], { grantExtensions: [extension], commit: SHA_A })], decisions)
    return commitBoundaryReport([commit(SHA_A, [file], parent)], head, RULES)
  }
  const exact = run(ext, [{ milestone: "M5", decision: DECISION, why: "w" }])
  assert.equal(exact.ok, true)

  const decided = [{ milestone: "M5", decision: DECISION, why: "w" }]
  for (const [extension, problem] of [
    [{ ...ext, decision: "(Q2)" }, /names the decision "\(Q2\)", which no decisions\[\] entry states word for word$/],
    [{ ...ext, decision: DECISION.slice(0, 20) }, /which no decisions\[\] entry states word for word$/],
    [{ ...ext, decision: "" }, /has no decision$/],
    [{ ...ext, at: "RETROACTIVE" }, /has no parseable at$/],
    [{ ...ext, reason: " " }, /has no reason$/],
  ]) {
    const report = run(extension, decided)
    assert.deepEqual(rulesOf(report), [[file, "stray"]], JSON.stringify(extension))
    assert.match(report.violations[0].detail, problem)
  }
})

test("FU-46: an extension whose decision is recorded only after the commit is retroactive, not a grant", () => {
  const ext = { path: "lib/extra.mjs", at: "2026-09-27T10:00:00Z", reason: "r", decision: DECISION }
  const parent = state([esc("C1", ["lib/a.mjs"], { grantExtensions: [ext] })], [])
  const head = state([esc("C1", ["lib/a.mjs"], { grantExtensions: [ext], commit: SHA_A })], [{ milestone: "M5", decision: DECISION, why: "w" }])
  const report = commitBoundaryReport([commit(SHA_A, ["lib/extra.mjs"], parent)], head, RULES)
  assert.deepEqual(report.retroactive.map((r) => [r.path, r.rule]), [["lib/extra.mjs", "stray"]])
})

test("a commit is claimed by a recorded list of shas or an abbreviation of at least 7 digits, never by fewer or by another sha", () => {
  const parent = state([esc("C1", ["lib/a.mjs"])])
  const claimsOf = (recorded) => commitBoundaryReport([commit(SHA_A, ["lib/a.mjs"], parent)], state([esc("C1", ["lib/a.mjs"], { commit: recorded })]), RULES).commits[0].claims
  assert.deepEqual(claimsOf(SHA_A), ["C1"])
  assert.deepEqual(claimsOf(SHA_A.slice(0, 7)), ["C1"])
  assert.deepEqual(claimsOf([SHA_B, SHA_A.slice(0, 12)]), ["C1"])
  assert.deepEqual(claimsOf(SHA_A.slice(0, 6)), [])
  assert.deepEqual(claimsOf(SHA_B), [])
  assert.deepEqual(claimsOf("A1B2C3D4E"), [])
})

test("an owner-accepted commit is only listed, whatever it touches", () => {
  const c = commit(SHA_A, ["apps/backend/app/api/x/route.ts", "CLAUDE.md"], state(), { subject: "fix(harness): reconcile the rebase onto main (#950)" })
  const report = commitBoundaryReport([c], state(), RULES)
  assert.equal(report.ok, true)
  assert.deepEqual(report.informational.map((i) => [i.sha, i.rule]), [[SHA_A, "owner-accepted"]])
})

test("the PRD is exempt from grants but not from the additive-only rule", () => {
  const rewrite = "@@ -3 +3 @@\n-- The CLI refuses landed.\n+- The CLI accepts landed.\n"
  const marker = "@@ -3 +3 @@\n-- The CLI refuses landed.\n+- The CLI refuses landed. **[SUPERSEDED, see AMENDMENT 2026-09-22.]**\n"
  const at = (prdDiff) => commitBoundaryReport([commit(SHA_A, [`${PRD}/00-prd.md`], state(), { prdDiff })], state(), RULES)
  assert.equal(at(marker).ok, true)
  assert.deepEqual(rulesOf(at(rewrite)), [[`${PRD}/00-prd.md`, "prd-rewrite"]])
})

test("prdAdditiveViolations: a pure insert and a marker appended to a line pass; a rewrite, a deletion, a mid-line marker, plain appended text and a moved line fail", () => {
  const header = "diff --git a/p.md b/p.md\nindex 1..2 100644\n--- a/p.md\n+++ b/p.md\n"
  const cases = [
    ["pure insert", "@@ -4,0 +5,3 @@\n+## AMENDMENT 2026-09-22\n+\n+The scout is optional.\n", []],
    ["marker append", "@@ -7 +7 @@\n-R1 the scout runs first.\n+R1 the scout runs first. **[SUPERSEDED on omitClaudeMd, see AMENDMENT 2026-09-22.]**\n", []],
    ["AMENDED marker", "@@ -7 +7 @@\n-R2 x.\n+R2 x. [AMENDED 2026-09-27]\n", []],
    ["true rewrite", "@@ -7 +7 @@\n-R1 the scout runs first.\n+R1 the scout runs last.\n", ["R1 the scout runs first."]],
    ["deletion", "@@ -7,2 +7 @@\n-R1 the scout runs first.\n R2 stays.\n", ["R1 the scout runs first."]],
    ["mid-line marker", "@@ -7 +7 @@\n-R1 the scout runs first.\n+R1 the scout [SUPERSEDED] runs first.\n", ["R1 the scout runs first."]],
    ["plain appended text", "@@ -7 +7 @@\n-R1 the scout runs first.\n+R1 the scout runs first, unless it is late.\n", ["R1 the scout runs first."]],
    ["moved line, one hunk", "@@ -7,3 +7,3 @@\n-R1 first.\n R2 second.\n+R1 first.\n", ["R1 first."]],
    ["moved line, two hunks", "@@ -7 +6,0 @@\n-R1 first.\n@@ -20,0 +20 @@\n+R1 first.\n", ["R1 first."]],
    ["deleted blank line", "@@ -7,2 +7 @@\n-\n R2 stays.\n", []],
    ["one marker line cannot cover two deleted lines", "@@ -7,2 +7 @@\n-R1 x.\n-R1 x.\n+R1 x. [AMENDED]\n", ["R1 x."]],
    ["no-newline notice is not a line", "@@ -7 +7,2 @@\n R1 x.\n+R3 new.\n\\ No newline at end of file\n", []],
  ]
  for (const [name, hunks, expected] of cases) {
    assert.deepEqual(prdAdditiveViolations(header + hunks).map((v) => v.line), expected, name)
  }
  assert.deepEqual(prdAdditiveViolations(""), [])
  assert.deepEqual(prdAdditiveViolations(undefined), [])
})

// ── the CLI against a real repository ─────────────────────────────────────

const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")))
function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
  }).trim()
}
function write(root, rel, text) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text, "utf8")
}

function scratchRepo() {
  const root = tempDir("commit-boundary ")
  git(root, "init", "-q", "-b", "main")
  const plan = state([esc("F1", ["src/a.txt"])])
  write(root, `${PRD}/mission-state.json`, JSON.stringify(plan, null, 2))
  write(root, `${PRD}/00-prd.md`, "# PRD\n\nR1 the scout runs first.\nR2 the fixer runs second.\n")
  write(root, "src/a.txt", "a\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "chore: plan")
  const base = git(root, "rev-parse", "HEAD")
  write(root, "src/a.txt", "a2\n")
  write(root, "src/b.txt", "b\n")
  write(root, `${PRD}/00-prd.md`, "# PRD\n\nR1 the scout runs first. **[SUPERSEDED, see AMENDMENT 2026-09-30.]**\nR2 the fixer runs third.\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "feat(harness): F1")
  const f1 = git(root, "rev-parse", "HEAD")
  write(root, `${PRD}/mission-state.json`, JSON.stringify(state([esc("F1", ["src/a.txt"], { commit: f1.slice(0, 9) })]), null, 2))
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "chore: record F1's commit")
  const rulesPath = path.join(tempDir("commit-boundary-rules-"), "rules.json")
  writeFileSync(rulesPath, JSON.stringify(RULES), "utf8")
  return { root, base, f1, rulesPath, prdDir: path.join(root, PRD) }
}

test("CLI: reads the range from git and reports a stray path and a rewritten PRD line, exit 1; the report is JSON on stdout", () => {
  const { base, f1, rulesPath, prdDir } = scratchRepo()
  const r = runCLI([prdDir, `${base}..HEAD`, rulesPath])
  assert.equal(r.exitCode, 1, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.deepEqual(
    report.violations.map((v) => [v.sha, v.path, v.rule]),
    [
      [f1, `${PRD}/00-prd.md`, "prd-rewrite"],
      [f1, "src/b.txt", "stray"],
    ],
  )
  assert.match(report.violations[0].detail, /^"R2 the fixer runs second\." deleted or rewritten/)
  assert.deepEqual(report.commits.map((c) => c.claims), [["F1"], []])
})

test("CLI: a clean range exits 0", () => {
  const { base, rulesPath, prdDir, root } = scratchRepo()
  git(root, "reset", "-q", "--hard", base)
  write(root, "src/a.txt", "a3\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "feat(harness): F1 again")
  const sha = git(root, "rev-parse", "HEAD")
  write(root, `${PRD}/mission-state.json`, JSON.stringify(state([esc("F1", ["src/a.txt"], { commit: sha })]), null, 2))
  const r = runCLI([prdDir, `${base}..HEAD`, rulesPath])
  assert.equal(r.exitCode, 0, r.stdout + r.stderr)
  assert.equal(JSON.parse(r.stdout).ok, true)
})

test("CLI: missing arguments, a missing mission-state.json, unreadable rules and a range git cannot read each exit 2 with no report", () => {
  const { rulesPath, prdDir } = scratchRepo()
  const empty = tempDir("commit-boundary-empty-")
  const badRules = path.join(empty, "rules.json")
  writeFileSync(badRules, "[1]", "utf8")
  for (const argv of [[], [prdDir, "HEAD~1..HEAD"], [empty, "HEAD~1..HEAD", rulesPath], [prdDir, "HEAD~1..HEAD", path.join(empty, "none.json")], [prdDir, "HEAD~1..HEAD", badRules], [prdDir, "nope..HEAD", rulesPath]]) {
    const r = runCLI(argv)
    assert.equal(r.exitCode, 2, JSON.stringify(argv))
    assert.equal(r.stdout, "")
  }
})

test("CLI wiring: the file runs as a subprocess and exits 2 with usage when given nothing", () => {
  const r = spawnSync(process.execPath, [LIB_PATH], { encoding: "utf8" })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /^usage: commit-boundary\.mjs <prd-dir> <rev-range> <rules\.json>/)
})
