import test from "node:test"
import assert from "node:assert/strict"
import { digestFromHandoff, HANDOFF_DIGEST_SCHEMA } from "./handoff-digest.mjs"

const opts = { handoffPath: ".contractor/missions/demo/handoffs/F1.json" }

test("a clean handoff digests to status complete", () => {
  const d = digestFromHandoff(
    {
      feature: "F1",
      completed: ["built the thing"],
      commandsRun: [{ cmd: "npm test", exitCode: 0 }],
      assertionsCovered: ["A-1"],
      proceduresFollowed: true,
    },
    opts,
  )
  assert.equal(d.status, "complete")
  assert.equal(d.handoffPath, opts.handoffPath)
  assert.deepEqual(d.assertionsCovered, ["A-1"])
  assert.equal(d.commandsRunCount, 1)
  assert.deepEqual(d.commandsFailed, [])
})

test("structured escalations survive with their full file lists", () => {
  // The orchestrator feeds these straight into routeEscalation, so truncating
  // the file list here would silently change the routing decision.
  const d = digestFromHandoff(
    {
      feature: "F1",
      escalations: [
        { files: ["db/schema.prisma", "src/shared/a.ts"], reason: "needs a new enum value", additiveOnly: true },
      ],
    },
    opts,
  )
  assert.equal(d.status, "escalated")
  assert.deepEqual(d.escalations[0].files, ["db/schema.prisma", "src/shared/a.ts"])
  assert.equal(d.escalations[0].additiveOnly, true)
})

test("escalations written as incomplete[] prose are recognized too", () => {
  const d = digestFromHandoff(
    { feature: "F1", incomplete: ["escalation: shared kernel change required"] },
    opts,
  )
  assert.equal(d.status, "escalated")
  assert.equal(d.escalations.length, 1)
  // ...and they do not double-count as ordinary incomplete work.
  assert.equal(d.incompleteCount, 0)
})

test("incomplete work without an escalation yields status incomplete", () => {
  const d = digestFromHandoff({ feature: "F1", incomplete: ["ran out of time on the edge case"] }, opts)
  assert.equal(d.status, "incomplete")
  assert.equal(d.incompleteCount, 1)
})

test("only failed commands are carried; green ones are a count", () => {
  const d = digestFromHandoff(
    {
      feature: "F1",
      commandsRun: [
        { cmd: "npm run lint", exitCode: 0 },
        { cmd: "npm test", exitCode: 1 },
      ],
    },
    opts,
  )
  assert.equal(d.commandsRunCount, 2)
  assert.deepEqual(d.commandsFailed, [{ cmd: "npm test", exitCode: 1 }])
})

test("long free text is clipped and overflow is disclosed, not silently dropped", () => {
  const many = Array.from({ length: 30 }, (_, i) => `file-${i}.ts`)
  const d = digestFromHandoff(
    {
      feature: "F1",
      escalations: [{ files: many, reason: "x".repeat(500) }],
      issues: Array.from({ length: 12 }, (_, i) => `issue ${i}`),
    },
    opts,
  )
  assert.equal(d.escalations[0].files.length, 12)
  assert.match(d.escalations[0].reason, /\+18 more files/)
  assert.equal(d.issues.length, 5)
  assert.equal(d.issuesCount, 12, "the true count survives even though the list is clipped")
})

test("proceduresFollowed only reads true when explicitly true", () => {
  assert.equal(digestFromHandoff({ feature: "F1" }, opts).proceduresFollowed, false)
  assert.equal(
    digestFromHandoff({ feature: "F1", proceduresFollowed: "yes" }, opts).proceduresFollowed,
    false,
  )
})

test("the schema requires the fields the orchestrator loop acts on", () => {
  assert.deepEqual(HANDOFF_DIGEST_SCHEMA.required, [
    "feature",
    "handoffPath",
    "handoffWritten",
    "status",
    "assertionsCovered",
  ])
  assert.equal(HANDOFF_DIGEST_SCHEMA.additionalProperties, false)
})

test("malformed input throws", () => {
  assert.throws(() => digestFromHandoff(null, opts), TypeError)
  assert.throws(() => digestFromHandoff({ feature: "" }, opts), TypeError)
  assert.throws(() => digestFromHandoff({ feature: "F1" }, {}), TypeError)
})
