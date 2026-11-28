import { test } from "node:test"
import assert from "node:assert/strict"
import {
  newFollowUpLines,
  parseFileList,
  activeWorkerWithout,
  serialDispatchConflict,
  expandVerifiedEntry,
  isAdmissibleProof,
  milestoneEscalationProofs,
  proofSignature,
  planTestGapRecords,
  normalizeAgentId,
  isVerdictShape,
  verdictTextOf,
  extractVerdictFromTranscript,
  verdictModuleOf,
} from "./evidence.mjs"

test("newFollowUpLines dedupes against the state and within the text, dropping blanks", () => {
  assert.deepEqual(newFollowUpLines("a\n\n b \na\nc", ["c"]), { added: ["a", "b"], skipped: 2 })
  assert.deepEqual(newFollowUpLines("", []), { added: [], skipped: 0 })
  assert.deepEqual(newFollowUpLines("x", [{ k: 1 }]), { added: ["x"], skipped: 0 }, "non-string entries do not break the dedupe")
})

test("parseFileList: a JSON array or a comma list, de-duplicated; empties refused", () => {
  assert.deepEqual(parseFileList('["a.ts","b.ts","a.ts"]'), ["a.ts", "b.ts"])
  assert.deepEqual(parseFileList("a.ts, b.ts"), ["a.ts", "b.ts"])
  for (const bad of ["", "  ", "[1]", "[]", "[not json", "a.ts,,b.ts", undefined]) assert.throws(() => parseFileList(bad), TypeError, String(bad))
})

test("activeWorkerWithout removes only its own tag", () => {
  assert.equal(activeWorkerWithout({ feature: "ESC-x", lane: null }, "ESC-x"), null)
  assert.deepEqual(activeWorkerWithout({ feature: "ESC-x,ESC-y", lane: "batch" }, "ESC-x"), { feature: "ESC-y", lane: "batch" })
  assert.deepEqual(activeWorkerWithout({ feature: "F-a" }, "ESC-x"), { feature: "F-a" })
  assert.equal(activeWorkerWithout(null, "ESC-x"), null)
  assert.equal(activeWorkerWithout(undefined, "ESC-x"), null)
})

test("serialDispatchConflict: escalations are serial, so another in-progress delegate refuses the dispatch", () => {
  const running = [{ id: "E-a", status: "in-progress", route: "delegate" }]
  assert.match(serialDispatchConflict(running, "E-b"), /E-a is still in progress/)
  assert.equal(serialDispatchConflict(running, "E-a"), null, "re-dispatching itself is not a conflict")
  assert.equal(serialDispatchConflict([{ ...running[0], status: "done" }], "E-b"), null)
  assert.equal(serialDispatchConflict([{ ...running[0], route: "inline" }], "E-b"), null)
  assert.equal(serialDispatchConflict(undefined, "E-b"), null)
})

test("expandVerifiedEntry defaults exit to 0 but never stamps readOnly", () => {
  assert.deepEqual(expandVerifiedEntry({ command: "grep -c x f", evidence: "1", readOnly: true }, 0), { exit: 0, command: "grep -c x f", evidence: "1", readOnly: true })
  assert.throws(() => expandVerifiedEntry({ command: "x", readOnly: true }, 0), /evidence/)
  assert.throws(() => expandVerifiedEntry({ evidence: "e", readOnly: true }, 0), /command/)
  assert.throws(() => expandVerifiedEntry([], 0), /object/)
  assert.throws(() => expandVerifiedEntry({ command: "npm run seed", evidence: "green" }, 0), /readOnly must be stated as true/)
  assert.throws(() => expandVerifiedEntry({ command: "git checkout -- x", evidence: "e", readOnly: false }, 1), /\[1\]\.readOnly/)
})

test("milestoneEscalationProofs: pre-named ids and records of the milestone; only complete readOnly exit-0 records are admissible", () => {
  const s = {
    milestones: [{ id: "M1", escalations: ["E-pre", { id: "E-obj" }] }],
    escalations: [
      { id: "E-obj", milestone: "M1", verifiedBy: [{ cmd: "true", exitCode: 0 }] },
      { id: "E-found", milestone: "M1", verifiedBy: [{ command: "true", exit: 0, readOnly: true, evidence: "ok" }, { command: "touch x", exit: 0, readOnly: false, evidence: "e" }] },
      { id: "E-other", milestone: "M2", verifiedBy: [{ command: "false", exit: 0, readOnly: true, evidence: "e" }] },
    ],
  }
  const proofs = milestoneEscalationProofs(s, "M1")
  assert.deepEqual(proofs, [
    { id: "E-pre", commands: [], inadmissible: [], missing: true },
    { id: "E-obj", commands: [], inadmissible: ["true"], missing: false },
    { id: "E-found", commands: ["true"], inadmissible: ["touch x"], missing: false },
  ])
  assert.equal(isAdmissibleProof({ command: "x", exit: 0, readOnly: true, evidence: "e" }), true)
  assert.equal(isAdmissibleProof({ command: "x", exit: 0, readOnly: true, evidence: "" }), false, "no evidence, nothing to compare")
  assert.equal(isAdmissibleProof({ command: "x", exit: 1, readOnly: true, evidence: "e" }), false)
  assert.equal(isAdmissibleProof({ cmd: "x", exitCode: 0 }), false)
  assert.deepEqual(milestoneEscalationProofs({}, "M1"), [])
  // The signature changes when a proof does, so a mid-run amend is detected.
  const amended = structuredClone(s)
  amended.escalations[1].verifiedBy[0].command = "true # pinned"
  assert.notEqual(proofSignature(milestoneEscalationProofs(amended, "M1")), proofSignature(proofs))
  assert.equal(proofSignature(milestoneEscalationProofs(s, "M1")), proofSignature(proofs))
})

test("planTestGapRecords: CLOSED for closed ids, fallback otherwise, unknown kind kept, one-line details, re-runs add nothing", () => {
  const verdicts = [
    {
      file: "M1-web.json",
      doc: {
        testGaps: [
          { id: "A-1", kind: "mocked-boundary", detail: "d1", suggestedFix: "f" },
          { id: "A-2", kind: "weird", detail: "line one\n- line two" },
          { kind: "impl-mirroring", detail: "d3" },
          "not an object",
        ],
      },
    },
    { file: "M1-api.json", doc: { verdicts: [] } },
  ]
  const recs = planTestGapRecords(verdicts, [{ id: "A-9", kind: "impl-mirroring", detail: "x", resolution: "OPEN" }], { closed: new Set(["A-1"]), fallback: "ACCEPTED" })
  assert.deepEqual(recs.map((r) => [r.id, r.kind, r.resolution]), [
    ["A-1", "mocked-boundary", "CLOSED"],
    ["A-2", "missing-edge-cases", "ACCEPTED"],
    ["M1-web.json#2", "impl-mirroring", "ACCEPTED"],
  ])
  assert.equal(recs[1].detail, "[kind: weird] line one - line two")
  assert.equal(recs[0].suggestedFix, "f")
  assert.equal(recs[0].source, "verdicts/M1-web.json")
  assert.deepEqual(planTestGapRecords(verdicts, recs, { fallback: "ACCEPTED" }), [])
})

test("normalizeAgentId and verdictModuleOf: names that become file names are validated", () => {
  assert.equal(normalizeAgentId("agent-abc_1.jsonl"), "abc_1")
  assert.throws(() => normalizeAgentId("../etc"), /not an agent id/)
  assert.throws(() => normalizeAgentId(""), /not an agent id/)
  assert.equal(verdictModuleOf("M1-billing.json", "M1"), "billing")
  assert.equal(verdictModuleOf("M1-billing-r2.json", "M1"), "billing")
  assert.equal(verdictModuleOf("M0-ESC-E-m0-ui.json", "M0"), "ESC-E-m0-ui")
  assert.equal(verdictModuleOf("M10-billing.json", "M1"), null)
  assert.equal(verdictModuleOf("M1-.json", "M1"), null)
})

const VERDICT = JSON.stringify({
  area: "billing",
  validatedAt: "2026-01-28T01:02:03Z",
  verdicts: [{ id: "A-1", verdict: "pass", evidence: "npm test exit 0 — a long evidence string that must not be condensed" }],
  boundaryViolations: [],
  missingDefaults: [],
  testGaps: [],
})

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
const text = (t, role = "assistant") => ({ message: { role, content: [{ type: "text", text: t }] } })
const handback = (message, name = "SubagentHandback") => ({ message: { role: "assistant", content: [{ type: "tool_use", name, input: { message } }] } })

test("extractVerdictFromTranscript: the last hand-back decides, byte-for-byte; drafts are never substituted", () => {
  assert.ok(isVerdictShape(JSON.parse(VERDICT)))
  assert.equal(isVerdictShape({ feature: "x" }), false)
  assert.equal(verdictTextOf("```json\n" + VERDICT + "\n```"), VERDICT)
  const transcript = jsonl([text("validate M1", "user"), text('draft: {"area":"billing","verdicts":[]}'), handback(VERDICT)])
  assert.equal(extractVerdictFromTranscript(transcript), VERDICT)
  assert.equal(extractVerdictFromTranscript(jsonl([text("Here:\n```json\n" + VERDICT + "\n```")])), VERDICT, "no hand-back: the last verdict text")
  assert.equal(extractVerdictFromTranscript(jsonl([handback('{"feature":"x","status":"complete"}')])), null, "a worker digest is not a verdict")
  assert.equal(extractVerdictFromTranscript(jsonl([text("```json\n" + VERDICT + "\n```"), handback("FAIL: see above")])), null, "a non-verdict hand-back beats an earlier draft")
  assert.equal(extractVerdictFromTranscript(jsonl([handback(VERDICT), handback("done")])), null, "only the LAST hand-back counts")
  assert.equal(extractVerdictFromTranscript(jsonl([handback(VERDICT, "Finish")]), { handbackTools: ["Finish"] }), VERDICT, "the hand-back tool name is a parameter")
  assert.equal(extractVerdictFromTranscript(VERDICT), VERDICT, "a plain returned message (no JSONL) is read as is")
  assert.equal(extractVerdictFromTranscript("not json\n"), null)
  assert.equal(extractVerdictFromTranscript(""), null)
})
