import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url))
const ADAPTER = fileURLToPath(new URL("../adapters/claude-code/.claude/", import.meta.url))
const mission = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" })

test("install claude-code --scope user copies the SAME skills and agents into the target, and never writes settings", () => {
  const target = realpathSync(mkdtempSync(path.join(tmpdir(), "mission-user-scope-")))
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "mission-user-cwd-")))
  const r = mission(cwd, ["install", "claude-code", "--scope", "user", "--target", target])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readdirSync(path.join(target, "skills")).sort(), readdirSync(path.join(ADAPTER, "skills")).sort())
  assert.deepEqual(readdirSync(path.join(target, "agents")).sort(), readdirSync(path.join(ADAPTER, "agents")).sort())
  assert.equal(
    readFileSync(path.join(target, "skills", "write-a-prd", "SKILL.md"), "utf8"),
    readFileSync(path.join(ADAPTER, "skills", "write-a-prd", "SKILL.md"), "utf8"),
  )
  assert.equal(existsSync(path.join(target, "settings.json")), false, "settings are never written")
  assert.equal(existsSync(path.join(target, "mission-harness-settings-snippet.json")), false)
  assert.equal(existsSync(path.join(cwd, ".claude")), false, "nothing lands in the project")
  assert.match(r.stdout, /Settings were NOT changed/)
})

test("install --scope user keeps an edited skill unless --force, and refuses a bad scope or adapter", () => {
  const target = realpathSync(mkdtempSync(path.join(tmpdir(), "mission-user-keep-")))
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "mission-user-cwd-")))
  const mine = path.join(target, "skills", "mission-plan", "SKILL.md")
  mkdirSync(path.dirname(mine), { recursive: true })
  writeFileSync(mine, "my edit\n")
  let r = mission(cwd, ["install", "claude-code", "--scope", "user", "--target", target])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(mine, "utf8"), "my edit\n")
  assert.match(r.stdout, /skills\/mission-plan \(kept: already present\)/)
  r = mission(cwd, ["install", "claude-code", "--scope", "user", "--target", target, "--force"])
  assert.equal(r.status, 0, r.stderr)
  assert.notEqual(readFileSync(mine, "utf8"), "my edit\n")
  assert.equal(mission(cwd, ["install", "claude-code", "--scope", "global"]).status, 1)
  assert.equal(mission(cwd, ["install", "codex", "--scope", "user", "--target", target]).status, 1)
})
