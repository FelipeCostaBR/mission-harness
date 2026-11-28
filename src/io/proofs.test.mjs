import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, symlinkSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import path from "node:path"
import { runProofs, confineToTempRoots, findTranscript } from "./proofs.mjs"

const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)))

test("runProofs runs admissible commands only, one log each; missing and inadmissible proofs are red and never run", () => {
  const cwd = tmp("proofs-cwd-")
  const logDir = path.join(tmp("proofs-logs-"), "logs")
  writeFileSync(path.join(cwd, "marker.txt"), "hello\n")
  const results = runProofs(
    [
      { id: "E-ok", commands: ["test -f marker.txt", "grep -q nope marker.txt"], inadmissible: [], missing: false },
      { id: "E-legacy", commands: [], inadmissible: ["touch planted.txt"], missing: false },
      { id: "E-none", commands: [], inadmissible: [], missing: true },
    ],
    { cwd, logDir },
  )
  assert.deepEqual(results.map((r) => [r.id, r.exit, r.ok]), [
    ["E-ok", 0, true],
    ["E-ok", 1, false],
    ["E-legacy", null, false],
    ["E-none", null, false],
  ])
  assert.match(results[2].reason, /not admissible/)
  assert.equal(results[3].reason, "no verifiedBy")
  assert.equal(existsSync(path.join(cwd, "planted.txt")), false, "an inadmissible command is never executed")
  assert.ok(existsSync(results[0].log))
  assert.equal(readFileSync(results[1].log, "utf8"), "")
})

test("runProofs reports a timed-out command as 124", () => {
  const cwd = tmp("proofs-timeout-")
  const [r] = runProofs([{ id: "E-slow", commands: ["sleep 5"], inadmissible: [], missing: false }], { cwd, logDir: path.join(cwd, "l"), timeoutMs: 200 })
  assert.equal(r.exit, 124)
})

test("confineToTempRoots: inside a temp root (even not yet created) is fine; outside, or a symlink out, is refused", () => {
  const base = tmp("confine-")
  assert.equal(confineToTempRoots(path.join(base, "a", "b")), path.join(base, "a", "b"))
  assert.equal(confineToTempRoots(base, [base]), base)
  const outside = path.join(homedir(), `.not-a-temp-dir-${process.pid}`)
  assert.throws(() => confineToTempRoots(outside), /outside the temp roots/)
  assert.equal(existsSync(outside), false)
  const repoLike = tmp("confine-repo-")
  const link = path.join(base, "escape")
  symlinkSync(repoLike, link)
  assert.throws(() => confineToTempRoots(path.join(link, "logs"), [base]), /outside the temp roots/)
})

test("findTranscript: the direct file, a bounded walk, and ambiguity refused", () => {
  const base = tmp("transcripts-")
  const sub = path.join(base, "proj", "sess", "subagents")
  mkdirSync(sub, { recursive: true })
  writeFileSync(path.join(sub, "agent-abc123.jsonl"), "")
  assert.equal(findTranscript(sub, "abc123"), path.join(sub, "agent-abc123.jsonl"))
  assert.equal(findTranscript(base, "agent-abc123"), path.join(sub, "agent-abc123.jsonl"))
  mkdirSync(path.join(base, "proj", "sess2", "subagents"), { recursive: true })
  writeFileSync(path.join(base, "proj", "sess2", "subagents", "agent-abc123.jsonl"), "")
  assert.throws(() => findTranscript(base, "abc123"), /ambiguous/)
  assert.throws(() => findTranscript(base, "nope"), /no agent-nope/)
  assert.throws(() => findTranscript(path.join(base, "missing"), "x"), /not found/)
  assert.throws(() => findTranscript(base, "../etc"), /not an agent id/)
})
