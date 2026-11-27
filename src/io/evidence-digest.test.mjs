import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evidenceDigest } from "./evidence-digest.mjs"

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mission-digest-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const folder of ["verdicts/incoming", "reviews"]) mkdirSync(join(dir, folder), { recursive: true })
  return dir
}

test("verdict digest lists blocker counts and bounded IDs while preserving the raw verdict", (t) => {
  const dir = fixture(t)
  const raw = JSON.stringify({
    verdicts: Array.from({ length: 12 }, (_, i) => ({ id: `A-${i}`, verdict: i < 10 ? "inconclusive" : "pass", evidence: "large-evidence".repeat(500) })),
    boundaryViolations: ["do not hide"], missingDefaults: ["do not hide"], testGaps: ["track this"],
    designCompliance: { subjectiveMatch: "inconclusive" },
  }, null, 2)
  const artifact = "verdicts/incoming/M1-users-r1.json"
  writeFileSync(join(dir, artifact), raw)
  const digest = evidenceDigest(dir, artifact)
  assert.deepEqual(digest.needsAttention, { count: 10, first: ["A-0", "A-1", "A-2", "A-3", "A-4"] })
  assert.equal(digest.passing, 2)
  assert.equal(digest.boundaryViolations, 1)
  assert.equal(digest.missingDefaults, 1)
  assert.equal(digest.testGaps, 1)
  assert.equal(digest.designInconclusive, true)
  assert.doesNotMatch(JSON.stringify(digest), /large-evidence/)
  assert.equal(readFileSync(join(dir, artifact), "utf8"), raw)
})

test("review digest keeps rejected findings in the artifact and refuses missing or redirected artifacts", (t) => {
  const dir = fixture(t)
  const artifact = "reviews/M1-review.json"
  writeFileSync(join(dir, artifact), JSON.stringify({
    findings: [{ target: "A-1", problem: "detailed finding" }],
    killed: [{ candidate: "detailed rejected candidate" }],
  }))
  assert.deepEqual(evidenceDigest(dir, artifact), { artifact, findings: { count: 1, first: ["A-1"] }, rejected: 1 })
  assert.throws(() => evidenceDigest(dir, "reviews/not-present.json"), { code: "ENOENT" })
  assert.throws(() => evidenceDigest(dir, "../other.json"), /inside the mission/)
  symlinkSync(join(dir, artifact), join(dir, "verdicts/alias.json"))
  assert.throws(() => evidenceDigest(dir, "verdicts/alias.json"), /assigned mission path/)
  writeFileSync(join(dir, "verdicts/invalid.json"), "{}")
  assert.throws(() => evidenceDigest(dir, "verdicts/invalid.json"), /No verdict records/)
})
