/**
 * handoff-digest.test.mjs — guards the terse-worker-return rule.
 * Run: node --test .claude/skills/run-prd-multi-agent-architecture/lib/handoff-digest.test.mjs
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { digestFromHandoff, HANDOFF_DIGEST_SCHEMA } from "./handoff-digest.mjs"
import { routeEscalation } from "./escalation-route.mjs"

const PATH = "docs/prd/web-foundation/handoffs/WEB-auth-backend.json"
const full = () => ({
  feature: "WEB-auth-backend",
  completed: ["email OTP issue/verify wired", "tests added"],
  incomplete: [],
  commandsRun: [
    { cmd: "pnpm --filter @etros/api test -- src/auth", exitCode: 0 },
    { cmd: "pnpm --filter @etros/api typecheck", exitCode: 0 },
  ],
  issues: [],
  proceduresFollowed: true,
  assertionsCovered: ["AUTH-001", "DEF-auth-boundaries"],
})

test("HD-1 clean handoff → status complete, assertions kept, commands become a count", () => {
  const d = digestFromHandoff(full(), { handoffPath: PATH })
  assert.equal(d.status, "complete")
  assert.deepEqual(d.assertionsCovered, ["AUTH-001", "DEF-auth-boundaries"])
  assert.equal(d.commandsRunCount, 2)
  assert.deepEqual(d.commandsFailed, [])
  assert.deepEqual(d.escalations, [])
  assert.equal(d.escalationsCount, 0)
  assert.equal(d.handoffPath, PATH)
  assert.equal(d.handoffWritten, true)
  assert.equal(d.proceduresFollowed, true)
  assert.ok(JSON.stringify(d).length <= 1200, "typical clean digest should be ~1KB")
})

test("HD-2 structured escalations survive with FULL file lists (routeEscalation input)", () => {
  const h = full()
  h.escalations = [
    {
      files: ["packages/db/prisma/schema.prisma", "packages/api/src/audit/events.ts"],
      reason: "new EventType value + audit payload union entry",
    },
    { files: ["packages/api/src/index.ts"], reason: "re-export issueOtp from the barrel", additiveOnly: true },
  ]
  const d = digestFromHandoff(h, { handoffPath: PATH })
  assert.equal(d.status, "escalated")
  assert.equal(d.escalationsCount, 2)
  assert.equal(routeEscalation(d.escalations[0]).route, "delegate") // the rule consumes the digest entry directly
  assert.equal(d.escalations[1].additiveOnly, true)
  assert.equal(routeEscalation(d.escalations[1]).route, "inline")
})

test("HD-3 legacy 'escalation:'-prefixed incomplete strings are lifted into escalations", () => {
  const h = full()
  h.incomplete = ["escalation: sharedKernel change required: providerSeams email adapter", "flaky test left skipped"]
  const d = digestFromHandoff(h, { handoffPath: PATH })
  assert.equal(d.status, "escalated")
  assert.equal(d.escalations.length, 1)
  assert.ok(d.escalations[0].reason.startsWith("escalation:"))
  assert.deepEqual(d.escalations[0].files, [])
  assert.deepEqual(d.incomplete, ["flaky test left skipped"])
  assert.equal(d.incompleteCount, 1)
})

test("HD-4 incomplete-but-not-escalated → status incomplete", () => {
  const h = full()
  h.incomplete = ["sign-in page renders a stub only"]
  const d = digestFromHandoff(h, { handoffPath: PATH })
  assert.equal(d.status, "incomplete")
  assert.equal(d.incompleteCount, 1)
})

test("HD-5 only failed commands are itemized", () => {
  const h = full()
  h.commandsRun.push({ cmd: "pnpm --filter @etros/web lint", exitCode: 2 })
  const d = digestFromHandoff(h, { handoffPath: PATH })
  assert.equal(d.commandsRunCount, 3)
  assert.deepEqual(d.commandsFailed, [{ cmd: "pnpm --filter @etros/web lint", exitCode: 2 }])
})

test("HD-6 issues are clipped + counted (validator reads the full text from disk)", () => {
  const h = full()
  h.issues = Array.from({ length: 9 }, (_, i) => `issue ${i}: ${"x".repeat(500)}`)
  const d = digestFromHandoff(h, { handoffPath: PATH })
  assert.equal(d.issuesCount, 9)
  assert.equal(d.issues.length, 5)
  assert.ok(d.issues[0].length <= 121)
})

test("HD-7 noisy pathological handoff is still hard-bounded by the caps, and the escalation overflow is counted", () => {
  const h = full()
  h.incomplete = Array.from({ length: 30 }, () => "y".repeat(1000))
  h.issues = Array.from({ length: 30 }, () => "z".repeat(1000))
  h.escalations = Array.from({ length: 20 }, () => ({
    files: Array.from({ length: 40 }, (_, i) => `packages/api/src/seams/f${i}.ts`),
    reason: "w".repeat(2000),
  }))
  h.commandsRun = Array.from({ length: 50 }, () => ({ cmd: "c".repeat(500), exitCode: 1 }))
  const d = digestFromHandoff(h, { handoffPath: PATH })
  // Worst case is bounded by the caps: 6 escalations × (12 files + 200-char
  // reason) dominates — ~7KB vs the 17–23KB unbounded returns; typical is ~1KB (HD-1).
  assert.ok(JSON.stringify(d).length <= 7000, `digest too big: ${JSON.stringify(d).length}`)
  assert.equal(d.escalations.length, 6)
  assert.equal(d.escalationsCount, 20, "the 14 escalations past the cap are still announced")
  assert.ok(d.escalations[0].reason.includes("more files]"))
  assert.ok(d.escalations[0].reason.length <= 201)
  assert.equal(d.commandsFailed.length, 5)
  assert.equal(d.incomplete.length, 5)
  assert.equal(d.incompleteCount, 30)
})

test("HD-8 digest validates against HANDOFF_DIGEST_SCHEMA's own required/enum/key constraints", () => {
  const variants = [full(), { ...full(), incomplete: ["x"] }, { ...full(), escalations: [{ files: ["a.ts"], reason: "r", additiveOnly: false }] }]
  for (const h of variants) {
    const d = digestFromHandoff(h, { handoffPath: PATH })
    for (const k of HANDOFF_DIGEST_SCHEMA.required) assert.ok(k in d, `missing required ${k}`)
    assert.ok(HANDOFF_DIGEST_SCHEMA.properties.status.enum.includes(d.status))
    const allowed = new Set(Object.keys(HANDOFF_DIGEST_SCHEMA.properties))
    for (const k of Object.keys(d)) assert.ok(allowed.has(k), `digest key ${k} not in schema`)
    const escAllowed = new Set(Object.keys(HANDOFF_DIGEST_SCHEMA.properties.escalations.items.properties))
    for (const e of d.escalations) for (const k of Object.keys(e)) assert.ok(escAllowed.has(k), `escalation key ${k} not in schema`)
  }
})

test("HD-9 HANDOFF_DIGEST_SCHEMA's key set is pinned (orchestrator docs reference these names)", () => {
  assert.deepEqual(Object.keys(HANDOFF_DIGEST_SCHEMA.properties), [
    "feature",
    "handoffPath",
    "handoffWritten",
    "status",
    "assertionsCovered",
    "escalations",
    "escalationsCount",
    "incomplete",
    "incompleteCount",
    "issues",
    "issuesCount",
    "commandsRunCount",
    "commandsFailed",
    "proceduresFollowed",
  ])
  assert.deepEqual(HANDOFF_DIGEST_SCHEMA.required, ["feature", "handoffPath", "handoffWritten", "status", "assertionsCovered"])
  assert.equal(HANDOFF_DIGEST_SCHEMA.additionalProperties, false)
})

test("HD-10 an escalation-worker's ESC handoff digests the same way", () => {
  const d = digestFromHandoff(
    { feature: "ESC-E-i18n-shell", assertionsCovered: [], commandsRun: [{ cmd: "pnpm --filter @etros/i18n typecheck", exitCode: 0 }], proceduresFollowed: true },
    { handoffPath: "docs/prd/web-foundation/handoffs/ESC-E-i18n-shell.json" },
  )
  assert.equal(d.status, "complete")
  assert.equal(d.handoffPath, "docs/prd/web-foundation/handoffs/ESC-E-i18n-shell.json")
})

test("HD-11 invalid input throws", () => {
  assert.throws(() => digestFromHandoff(null, { handoffPath: PATH }), TypeError)
  assert.throws(() => digestFromHandoff({}, { handoffPath: PATH }), TypeError)
  assert.throws(() => digestFromHandoff(full(), {}), TypeError)
  assert.throws(() => digestFromHandoff(full()), TypeError)
})

test("HD-12 a present list field that is not an array throws instead of digesting to 'complete'", () => {
  for (const key of ["incomplete", "escalations", "issues", "commandsRun", "assertionsCovered"]) {
    assert.throws(() => digestFromHandoff({ ...full(), [key]: "not an array" }, { handoffPath: PATH }), TypeError, key)
  }
  assert.throws(() => digestFromHandoff({ ...full(), escalations: [null] }, { handoffPath: PATH }), TypeError)
  // Absent or null list fields read as empty.
  const d = digestFromHandoff({ feature: "F", incomplete: null }, { handoffPath: PATH })
  assert.equal(d.status, "complete")
  assert.deepEqual(d.assertionsCovered, [])
})

test("HD-13 a bare-string structured escalation is kept as its reason", () => {
  const d = digestFromHandoff({ ...full(), escalations: ["needs a seams change"] }, { handoffPath: PATH })
  assert.equal(d.status, "escalated")
  assert.deepEqual(d.escalations, [{ files: [], reason: "needs a seams change" }])
})
