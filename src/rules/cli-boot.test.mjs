/**
 * node:test for cli-boot.mjs (PLAT-134 FU-58, FU-72).
 * Run: node --test .claude/skills/run-prd-multi-agent-architecture/lib/cli-boot.test.mjs
 *
 * Each CLI's own suite proves the guard through that CLI, as a real process
 * reached through a symlink; this one pins the helpers' contract directly.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { isMainModule, parseFlags } from "./cli-boot.mjs"

const BOOT_URL = new URL("./cli-boot.mjs", import.meta.url).href

test("isMainModule: the module's own path, a symlink to it and a path containing a space are main; another file, a missing path and no argv[1] are not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cli boot "))
  try {
    const file = path.join(dir, "cli.mjs")
    const other = path.join(dir, "other.mjs")
    const link = path.join(dir, "linked cli.mjs")
    writeFileSync(file, "")
    writeFileSync(other, "")
    symlinkSync(file, link)
    const url = pathToFileURL(file).href
    assert.match(url, /%20/, "control: the URL is percent-encoded where the path has a space")
    assert.equal(isMainModule(url, file), true)
    assert.equal(isMainModule(url, link), true)
    assert.equal(isMainModule(url, other), false)
    assert.equal(isMainModule(url, path.join(dir, "missing.mjs")), false)
    const noArgv1 = spawnSync(process.execPath, ["--input-type=module", "-e", `import { isMainModule } from ${JSON.stringify(BOOT_URL)}; console.log(JSON.stringify([process.argv[1] ?? null, isMainModule(${JSON.stringify(url)})]))`], { encoding: "utf8" })
    assert.deepEqual(JSON.parse(noArgv1.stdout), [null, false], "a node -e child has no argv[1], so the default parameter is what runs")
    assert.equal(isMainModule(url, ""), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("exitWith writes stdout and stderr as given, writes nothing for an empty stream, and exits with the result's code", () => {
  const exitWith = (result) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", `import { exitWith } from ${JSON.stringify(BOOT_URL)}; exitWith(${JSON.stringify(result)})`], { encoding: "utf8" })
  const loud = exitWith({ exitCode: 3, stdout: "out\n", stderr: "err\n" })
  assert.deepEqual([loud.status, loud.stdout, loud.stderr], [3, "out\n", "err\n"])
  const quiet = exitWith({ exitCode: 0, stdout: "", stderr: "" })
  assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, "", ""])
})

test("exitWith: stdout and stderr far past a pipe's buffer reach the reader whole, and the process still exits with the result's code", () => {
  const bytes = 2_000_000
  const big = spawnSync(process.execPath, ["--input-type=module", "-e", `import { exitWith } from ${JSON.stringify(BOOT_URL)}; exitWith({ exitCode: 1, stdout: "x".repeat(${bytes}), stderr: "y".repeat(${bytes}) })`], { encoding: "utf8", maxBuffer: 4 * bytes })
  assert.deepEqual([big.status, big.stdout.length, big.stderr.length], [1, bytes, bytes])
  const viaShellPipe = spawnSync("/bin/sh", ["-c", `"$0" --input-type=module -e "$1" | wc -c`, process.execPath, `import { exitWith } from ${JSON.stringify(BOOT_URL)}; exitWith({ exitCode: 0, stdout: "x".repeat(${bytes}), stderr: "" })`], { encoding: "utf8" })
  assert.equal(Number(viaShellPipe.stdout.trim()), bytes, viaShellPipe.stderr)
})

test("exitWith: awaits a pending result, and refuses with exit 2 a result whose exitCode is not an integer", () => {
  const run = (expression) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", `import { exitWith } from ${JSON.stringify(BOOT_URL)}; exitWith(${expression})`], { encoding: "utf8" })
  const pending = run(`new Promise((resolve) => setTimeout(() => resolve({ exitCode: 1, stdout: "late\\n", stderr: "" }), 50))`)
  assert.deepEqual([pending.status, pending.stdout, pending.stderr], [1, "late\n", ""])
  for (const expression of ["undefined", "{}", `{ exitCode: "0", stdout: "x" }`, "{ exitCode: 1.5 }", "{ exitCode: Promise.resolve(0) }"]) {
    const refused = run(expression)
    assert.equal(refused.status, 2, expression)
    assert.equal(refused.stdout, "", expression)
    assert.match(refused.stderr, /no integer exitCode/, expression)
  }
})

const FLAGS = { "--cwd": "cwd", "--name": "name" }

test("parseFlags: value flags in any order, boolean flags as a Set, and nothing required", () => {
  assert.deepEqual(parseFlags(["--name", "n", "--verify", "--cwd", "/x"], FLAGS, ["--verify"]), { values: { name: "n", cwd: "/x" }, booleans: new Set(["--verify"]) })
  assert.deepEqual(parseFlags([], FLAGS), { values: {}, booleans: new Set() })
})

test("parseFlags: refuses the first word it cannot accept, naming it", () => {
  for (const [argv, booleanFlags, error] of [
    [["--cwd"], [], "--cwd needs a value"],
    [["--cwd", "--name", "n"], [], "--cwd needs a value"],
    [["--cwd", "/x", "--cwd", "/y"], [], "--cwd given twice"],
    [["--verify", "--verify"], ["--verify"], "--verify given twice"],
    [["--verify"], [], 'unexpected argument "--verify"'],
    [["--cwd=/x"], [], 'unexpected argument "--cwd=/x"'],
    [["--cwd", "/x", "extra", "--cwd"], [], 'unexpected argument "extra"'],
    [["--cwd", "/x", "toString", "junk"], [], 'unexpected argument "toString"'],
    [["constructor", "junk"], [], 'unexpected argument "constructor"'],
    [["__proto__", "junk"], [], 'unexpected argument "__proto__"'],
    [["hasOwnProperty", "junk"], [], 'unexpected argument "hasOwnProperty"'],
  ]) {
    assert.deepEqual(parseFlags(argv, FLAGS, booleanFlags), { error }, JSON.stringify(argv))
  }
})

test("parseFlags: a repeatable flag collects its values in order, the same value twice included, and is absent when not given", () => {
  assert.deepEqual(parseFlags(["--name", "a", "--cwd", "/x", "--name", "b", "--name", "a"], FLAGS, [], ["--name"]), { values: { name: ["a", "b", "a"], cwd: "/x" }, booleans: new Set() })
  assert.deepEqual(parseFlags(["--name", "a"], FLAGS, [], ["--name"]), { values: { name: ["a"] }, booleans: new Set() })
  assert.deepEqual(parseFlags(["--cwd", "/x"], FLAGS, [], ["--name"]), { values: { cwd: "/x" }, booleans: new Set() })
})

test("parseFlags: a repeatable flag still needs a value each time, and leaves every other flag refusing a repeat", () => {
  for (const [argv, error] of [
    [["--name", "a", "--name"], "--name needs a value"],
    [["--name", "a", "--name", "--cwd", "/x"], "--name needs a value"],
    [["--name", "a", "--cwd", "/x", "--cwd", "/y"], "--cwd given twice"],
    [["--name=a"], 'unexpected argument "--name=a"'],
  ]) {
    assert.deepEqual(parseFlags(argv, FLAGS, [], ["--name"]), { error }, JSON.stringify(argv))
  }
})
