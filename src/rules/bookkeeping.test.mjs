import { test } from "node:test"
import assert from "node:assert/strict"
import {
  checkBookkeeping,
  checkHandoffMeta,
  isBookkeepingClean,
  computeAdvanceReadiness,
  decisionRecords,
  MISSION_STATUSES,
  NON_ACTIVE_STATUSES,
  NO_DEVICE_STATES,
  HYPOTHESIS_FAILED_STATE,
  ESCALATION_WORKER_MARKER,
  ORCHESTRATOR_INLINE_MARKER,
  FEATURE_SURFACES,
  PLAN_DECISION_MILESTONE,
  ROUND_TYPES,
} from "./bookkeeping.mjs"

test("clean mission-state yields no findings", () => {
  const state = {
    missionStatus: "done",
    correctiveRounds: { M1: 2, M2: 0 },
    roundLog: [
      { milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], at: "2026-10-09T10:31:07.428Z" },
      { milestone: "M1", round: 2, type: "hardening", trigger: ["G-1"], at: "2026-10-09T12:04:55.100Z" },
    ],
    queueSubstrate: { status: "live", scopeSource: "hook-queue" },
  }
  assert.deepEqual(checkBookkeeping(state), [])
  assert.equal(isBookkeepingClean(checkBookkeeping(state)), true)
})

test("MISSION_STATUSES is pinned (mission-flag.mjs's disarm allowlist is the same set minus active)", () => {
  assert.deepEqual(MISSION_STATUSES, ["active", "halted", "done", "behaviorally-gated"])
  assert.deepEqual(NON_ACTIVE_STATUSES, ["halted", "done", "behaviorally-gated"])
})

test("behaviorally-gated is a recognized status (the new value)", () => {
  assert.ok(MISSION_STATUSES.includes("behaviorally-gated"))
  assert.ok(NON_ACTIVE_STATUSES.includes("behaviorally-gated"))
  const findings = checkBookkeeping({ missionStatus: "behaviorally-gated" })
  assert.equal(findings.filter((f) => f.severity === "error").length, 0)
})

test("unknown missionStatus is an error (enum-drift guard)", () => {
  const findings = checkBookkeeping({ missionStatus: "gated-typo" })
  assert.ok(findings.some((f) => f.code === "unknown-mission-status" && f.severity === "error"))
  assert.equal(isBookkeepingClean(findings), false)
})

test("counter ahead of roundLog is a non-blocking warn (the retro re-open trigger)", () => {
  const state = {
    correctiveRounds: { M1: 2 },
    roundLog: [{ milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"] }],
  }
  const findings = checkBookkeeping(state)
  const f = findings.find((f) => f.code === "roundlog-behind-counter")
  assert.ok(f, "expected roundlog-behind-counter")
  assert.equal(f.severity, "warn")
  assert.equal(isBookkeepingClean(findings), true) // warn does not block
})

test("a roundLog entry with no `at` warns, so retros can measure elapsed time not just count rounds", () => {
  const findings = checkBookkeeping({
    correctiveRounds: { M1: 1 },
    roundLog: [{ milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"] }],
  })
  const f = findings.find((f) => f.code === "roundlog-missing-timestamp")
  assert.ok(f, "expected roundlog-missing-timestamp")
  assert.equal(f.severity, "warn")
  assert.equal(isBookkeepingClean(findings), true) // pre-`at` missions must not be blocked
})

test("a well-formed `at` is silent; a malformed one is an error", () => {
  const good = checkBookkeeping({
    correctiveRounds: { M1: 1 },
    roundLog: [{ milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], at: "2026-10-09T10:31:07.428Z" }],
  })
  assert.equal(good.filter((f) => f.code.startsWith("roundlog-missing-timestamp")).length, 0)
  assert.equal(good.filter((f) => f.code === "roundlog-bad-timestamp").length, 0)

  const bad = checkBookkeeping({
    correctiveRounds: { M1: 1 },
    roundLog: [{ milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], at: "yesterday" }],
  })
  const f = bad.find((f) => f.code === "roundlog-bad-timestamp")
  assert.ok(f, "expected roundlog-bad-timestamp")
  assert.equal(f.severity, "error")
  assert.equal(isBookkeepingClean(bad), false)
})

test("counter BEHIND the roundLog is an error — the breaker and the seat escalation are both disarmed", () => {
  // The shape that has actually occurred: rounds were logged for milestones
  // absent from the counter entirely, so an Object.entries(correctiveRounds)
  // loop never visited them.
  const state = {
    correctiveRounds: { M5: 2 },
    roundLog: [
      { milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"] },
      { milestone: "M1", round: 2, type: "hardening", trigger: ["gap-1"] },
      { milestone: "M5", round: 1, type: "corrective", trigger: ["A-9"] },
      { milestone: "M5", round: 2, type: "corrective", trigger: ["A-9"] },
    ],
  }
  const findings = checkBookkeeping(state)
  const f = findings.find((f) => f.code === "counter-behind-roundlog")
  assert.ok(f, "expected counter-behind-roundlog for M1")
  assert.equal(f.severity, "error")
  assert.match(f.detail, /^M1:/)
  // M5 is consistent (2 logged, 2 counted) and must NOT be flagged.
  assert.equal(findings.filter((x) => x.code === "counter-behind-roundlog").length, 1)
  assert.equal(isBookkeepingClean(findings), false) // error blocks advance
})

test("adversarial rounds are NOT counted against the corrective cap", () => {
  // mission-validate 2c logs adversarial rounds on their own counter precisely so
  // running the pass cannot trip the breaker; counting them here would flag every
  // high-risk milestone as inconsistent.
  const state = {
    correctiveRounds: { M2: 1 },
    roundLog: [
      { milestone: "M2", round: 1, type: "corrective", trigger: ["A-2"] },
      { milestone: "M2", round: 1, type: "adversarial", trigger: ["deep-investigator"] },
    ],
  }
  const findings = checkBookkeeping(state)
  assert.equal(
    findings.filter((f) => f.code === "counter-behind-roundlog").length,
    0,
    "adversarial round must not count toward the capped total",
  )
})

test("bad roundLog entry type is an error", () => {
  const findings = checkBookkeeping({
    correctiveRounds: { M1: 1 },
    roundLog: [{ milestone: "M1", round: 1, type: "refactor", trigger: [] }],
  })
  assert.ok(findings.some((f) => f.code === "roundlog-bad-type" && f.severity === "error"))
})

test("roundLog[].lane is no longer judged at all (the lanes-with-contracts machinery is not part of this harness)", () => {
  // A lane-tagged entry from an older harness generation must neither error nor
  // warn: every field the harness does not own is ignored, never validated.
  const state = {
    correctiveRounds: { M1: 1 },
    roundLog: [{ milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], at: "2026-10-09T00:00:00Z", lane: "anything" }],
    queueSubstrate: { status: "live" },
  }
  assert.deepEqual(checkBookkeeping(state), [])
})

test("invalid queueSubstrate.status is an error", () => {
  const findings = checkBookkeeping({ queueSubstrate: { status: "maybe" } })
  assert.ok(findings.some((f) => f.code === "bad-queue-substrate" && f.severity === "error"))
})

test("queueSubstrate absent on a mission that ran rounds is a warn", () => {
  const findings = checkBookkeeping({ correctiveRounds: { M1: 1 }, roundLog: [{ milestone: "M1", round: 1, type: "corrective" }] })
  assert.ok(findings.some((f) => f.code === "queue-substrate-unprobed" && f.severity === "warn"))
})

test("a freshly planned mission (correctiveRounds seeded at 0, no roundLog, no queueSubstrate) is not 'unprobed'", () => {
  // mission-plan step 4 seeds correctiveRounds with every milestone at 0; no round has run yet.
  assert.deepEqual(checkBookkeeping({ correctiveRounds: { M1: 0, M2: 0 } }), [])
  assert.deepEqual(checkBookkeeping({ correctiveRounds: { M1: 0 }, roundLog: [] }), [])
  // a counted round with no roundLog entry still warns
  const findings = checkBookkeeping({ correctiveRounds: { M1: 0, M2: 1 } })
  assert.ok(findings.some((f) => f.code === "queue-substrate-unprobed"))
})

test("non-object state is a single error", () => {
  assert.deepEqual(checkBookkeeping(null), [{ code: "no-state", severity: "error", detail: "mission-state is not an object" }])
})

test("handoff _meta is optional — absent yields no finding", () => {
  assert.deepEqual(checkHandoffMeta({ feature: "X" }), [])
})

test("well-formed _meta (exact + batch) passes", () => {
  assert.deepEqual(checkHandoffMeta({ _meta: { tokensSpent: 41200, attribution: "exact" } }), [])
  assert.deepEqual(checkHandoffMeta({ _meta: { tokensSpent: 0, attribution: "batch" } }), [])
})

test("malformed _meta is flagged (bad tokens / bad attribution)", () => {
  const a = checkHandoffMeta({ _meta: { tokensSpent: -5, attribution: "exact" } })
  assert.ok(a.some((f) => f.code === "bad-meta-tokens"))
  const b = checkHandoffMeta({ _meta: { tokensSpent: 10, attribution: "guess" } })
  assert.ok(b.some((f) => f.code === "bad-meta-attribution"))
})

test("computeAdvanceReadiness: all passing -> advance, not gated", () => {
  const r = computeAdvanceReadiness({ "A-1": "passing", "A-2": "passing" })
  assert.deepEqual(r, { assertionsAllPassing: true, behaviorallyGated: false, hypothesisFailed: false, blocking: [] })
})

test("C-10: a skipped behavioral assertion is non-blocking but forces behaviorally-gated", () => {
  const r = computeAdvanceReadiness({ "A-1": "passing", "BE-1": "skipped" })
  assert.equal(r.assertionsAllPassing, true) // advances (a run without the e2e environment is not stalled)
  assert.equal(r.behaviorallyGated, true) // but cannot be recorded done
})

test("C-03: inline inconclusive-no-device behaves identically to area-runner skipped", () => {
  const inline = computeAdvanceReadiness({ "BE-1": "inconclusive-no-device" })
  const area = computeAdvanceReadiness({ "BE-1": "skipped" })
  assert.deepEqual(inline, area)
  assert.equal(inline.behaviorallyGated, true)
  assert.equal(inline.assertionsAllPassing, true)
})

test("E2E-unverified is also a no-device state", () => {
  assert.ok(NO_DEVICE_STATES.includes("E2E-unverified"))
  const r = computeAdvanceReadiness({ "BE-1": "E2E-unverified" })
  assert.equal(r.behaviorallyGated, true)
  assert.equal(r.assertionsAllPassing, true)
})

test("a real failing/inconclusive/pending assertion BLOCKS advance", () => {
  assert.equal(computeAdvanceReadiness({ "A-1": "failing" }).assertionsAllPassing, false)
  assert.equal(computeAdvanceReadiness({ "A-1": "inconclusive" }).assertionsAllPassing, false)
  assert.equal(computeAdvanceReadiness({ "A-1": "pending" }).assertionsAllPassing, false)
  assert.deepEqual(computeAdvanceReadiness({ "A-1": "failing", "A-2": "passing" }).blocking, ["A-1"])
})

test("a failing assertion alongside a skipped one still blocks (and stays gated)", () => {
  const r = computeAdvanceReadiness({ "A-1": "failing", "BE-1": "skipped" })
  assert.equal(r.assertionsAllPassing, false)
  assert.equal(r.behaviorallyGated, true)
})

test("'adversarial' is an accepted roundLog type (its own budget)", () => {
  assert.deepEqual(ROUND_TYPES, ["corrective", "hardening", "adversarial", "infrastructure-halt"])
  const findings = checkBookkeeping({
    roundLog: [{ milestone: "M2", round: 1, type: "adversarial", trigger: ["deep-investigator"] }],
  })
  assert.equal(findings.filter((f) => f.code === "roundlog-bad-type").length, 0)
})

test("'infrastructure-halt' is an accepted roundLog type and is not charged to the corrective cap", () => {
  const findings = checkBookkeeping({
    correctiveRounds: {},
    roundLog: [{ milestone: "M1", round: 0, type: "infrastructure-halt", trigger: ["session-limit"] }],
  })
  assert.equal(findings.filter((f) => f.code === "roundlog-bad-type").length, 0)
  // The cap comparison must ignore it entirely: an empty correctiveRounds against
  // a logged halt is consistent, not a counter running behind the log.
  assert.equal(findings.filter((f) => f.code === "counter-behind-roundlog").length, 0)
})

test("hypothesis-failed is non-blocking but sets hypothesisFailed", () => {
  const r = computeAdvanceReadiness({ "A-1": "passing", "HG-010": HYPOTHESIS_FAILED_STATE })
  assert.equal(r.assertionsAllPassing, true) // the OTHER assertions still earn real verdicts
  assert.equal(r.hypothesisFailed, true) // but the milestone cannot be recorded done
  assert.equal(r.behaviorallyGated, false) // distinct from the no-device gate
})

test("a real failing assertion alongside a hypothesis-failed one still BLOCKS", () => {
  const r = computeAdvanceReadiness({ "A-1": "failing", "HG-010": HYPOTHESIS_FAILED_STATE })
  assert.equal(r.assertionsAllPassing, false)
  assert.equal(r.hypothesisFailed, true)
})

// --- 4: ESC handoff -> escalations[] lockstep -----------------------------

test("ESC handoff with no escalations[] entry is an ERROR", () => {
  const findings = checkBookkeeping(
    { escalations: [] },
    { handoffFiles: ["ESC-flow-harden.json", "WEB-auth-backend.json"] },
  )
  const f = findings.filter((x) => x.code === "esc-handoff-unrecorded")
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, "error")
  assert.ok(f[0].detail.includes("ESC-flow-harden"))
})

test("escalations[] entry without the escalation-worker marker is an ERROR", () => {
  const findings = checkBookkeeping(
    { escalations: [{ id: "ESC-ci-gate", verifiedBy: ["tsc"] }] },
    { handoffFiles: ["ESC-ci-gate.json"] },
  )
  const f = findings.filter((x) => x.code === "esc-handoff-not-marked-delegated")
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, "error")
})

test("correctly marked delegated escalation is clean; non-ESC handoffs are ignored", () => {
  const findings = checkBookkeeping(
    { escalations: [{ id: "ESC-ci-gate", implementedBy: ESCALATION_WORKER_MARKER }] },
    { handoffFiles: ["ESC-ci-gate.json", "WEB-sign-in-ui.json", "WEB-notification.json"] },
  )
  assert.equal(findings.filter((x) => x.code.startsWith("esc-")).length, 0)
})

test("the documented `ESC-<id>.json` naming (id WITHOUT the prefix) is clean", () => {
  // architecture.md persists the handoff as `handoffs/ESC-<id>.json`, so an
  // escalation with id "E-schema" lands as ESC-E-schema.json. That correct
  // mission used to false-flag esc-handoff-unrecorded.
  const findings = checkBookkeeping(
    {
      escalations: [
        { id: "E-schema", implementedBy: ESCALATION_WORKER_MARKER },
        { id: "E-env", implementedBy: ESCALATION_WORKER_MARKER },
      ],
    },
    { handoffFiles: ["ESC-E-schema.json", "ESC-E-env.json"] },
  )
  assert.equal(findings.filter((x) => x.code.startsWith("esc-")).length, 0)
})

test("bare-id convention still catches a missing escalation-worker marker", () => {
  const findings = checkBookkeeping(
    { escalations: [{ id: "E-registry", verifiedBy: ["tsc"] }] },
    { handoffFiles: ["ESC-E-registry.json"] },
  )
  const f = findings.filter((x) => x.code === "esc-handoff-not-marked-delegated")
  assert.equal(f.length, 1)
  assert.ok(f[0].detail.includes("E-registry"))
})

test("omitting handoffFiles keeps the old checkBookkeeping behavior (backward compatible)", () => {
  const findings = checkBookkeeping({ escalations: [] })
  assert.equal(findings.filter((x) => x.code.startsWith("esc-")).length, 0)
})

// --- 4b: escalations[] -> handoff presence ---------------------------------
// The REVERSE direction from check 4: a delegated escalation with NO
// handoffs/ESC-<id>.json at all — `status: "done"`, a worker plainly ran, and
// zero handoff evidence on disk. Check 4 (above) is structurally blind to this
// because it iterates `handoffFiles`, never `escalations[]`.

test("a done escalation with no matching handoff is an ERROR", () => {
  const findings = checkBookkeeping(
    { escalations: [{ id: "E-auth-schema", status: "done" }] },
    { handoffFiles: ["ESC-E-unrelated.json"] }, // unrelated handoff present, this one's own is not
  )
  const f = findings.filter((x) => x.code === "esc-escalation-missing-handoff")
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, "error")
  assert.ok(f[0].detail.includes("E-auth-schema"))
  assert.equal(isBookkeepingClean(findings), false)
})

test("route/implementedBy absent (an entry hand-added before upsert-escalation) still defaults to in scope", () => {
  // An unmarked entry must default to IN SCOPE, or the exact defect this check
  // exists for stays invisible.
  const findings = checkBookkeeping(
    { escalations: [{ id: "E-measure", status: "done", reason: "harness escalation (no module owns these paths)" }] },
    { handoffFiles: [] },
  )
  assert.ok(findings.some((x) => x.code === "esc-escalation-missing-handoff"))
})

test("an acknowledged handoffMissing downgrades the same finding to a WARN", () => {
  const findings = checkBookkeeping(
    {
      escalations: [
        {
          id: "E-scout-agent",
          status: "done",
          handoffMissing: { reason: "no worker handoff was ever persisted for this escalation", at: "2026-10-23T00:00:00Z" },
        },
      ],
    },
    { handoffFiles: [] },
  )
  const err = findings.filter((x) => x.code === "esc-escalation-missing-handoff")
  const warn = findings.filter((x) => x.code === "esc-handoff-missing-acknowledged")
  assert.equal(err.length, 0, "must not ALSO fire as an error once acknowledged")
  assert.equal(warn.length, 1)
  assert.equal(warn[0].severity, "warn")
  assert.equal(isBookkeepingClean(findings), true) // warn does not block
})

test("a present handoff (either naming convention) is clean, and status in-progress is covered too", () => {
  const bare = checkBookkeeping(
    { escalations: [{ id: "E-handoff-guard", status: "in-progress", route: "delegate", implementedBy: ESCALATION_WORKER_MARKER }] },
    { handoffFiles: ["ESC-E-handoff-guard.json"] },
  )
  assert.equal(bare.filter((x) => x.code === "esc-escalation-missing-handoff").length, 0)

  const prefixed = checkBookkeeping(
    { escalations: [{ id: "ESC-ci-gate", status: "done", route: "delegate" }] },
    { handoffFiles: ["ESC-ci-gate.json"] },
  )
  assert.equal(prefixed.filter((x) => x.code === "esc-escalation-missing-handoff").length, 0)
})

test('route "inline" (or implementedBy "orchestrator-inline") is out of scope regardless of status or handoff', () => {
  const byRoute = checkBookkeeping(
    { escalations: [{ id: "E-charter-strip", status: "done", route: "inline", implementedBy: "orchestrator-inline" }] },
    { handoffFiles: [] },
  )
  assert.equal(byRoute.filter((x) => x.code.startsWith("esc-escalation-missing-handoff") || x.code.startsWith("esc-handoff-missing-acknowledged")).length, 0)

  const byMarker = checkBookkeeping(
    { escalations: [{ id: "some-inline-fix", status: "done", implementedBy: ORCHESTRATOR_INLINE_MARKER }] },
    { handoffFiles: [] },
  )
  assert.equal(byMarker.filter((x) => x.code === "esc-escalation-missing-handoff").length, 0)
})

test('status "in-progress" with no handoff is a WARN, never an error — dispatch must not deadlock', () => {
  // mission-run MR-3.2 records route/implementedBy at DISPATCH time, before the
  // worker has run, so a fresh in-progress entry with no handoff yet is the
  // normal gap between dispatch and return. Treating it as an error would make
  // the CLI's no-new-error write gate refuse the very upsert-escalation call
  // that starts every delegated escalation.
  const findings = checkBookkeeping(
    { escalations: [{ id: "E-worker-body-trim", status: "in-progress", route: "delegate", implementedBy: ESCALATION_WORKER_MARKER }] },
    { handoffFiles: [] },
  )
  const f = findings.filter((x) => x.code === "esc-escalation-handoff-pending")
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, "warn")
  assert.equal(findings.filter((x) => x.code === "esc-escalation-missing-handoff").length, 0)
  assert.equal(isBookkeepingClean(findings), true) // a warn must never block the dispatching write
})

test('status "done" with no handoff is an ERROR — the finished-worker claim owes the evidence now', () => {
  const findings = checkBookkeeping(
    { escalations: [{ id: "E-fixer-agent", status: "done", route: "delegate", implementedBy: ESCALATION_WORKER_MARKER }] },
    { handoffFiles: [] },
  )
  const f = findings.filter((x) => x.code === "esc-escalation-missing-handoff")
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, "error")
  assert.equal(findings.filter((x) => x.code === "esc-escalation-handoff-pending").length, 0)
  assert.equal(isBookkeepingClean(findings), false)
})

test('status "pending" (not yet dispatched) and an orchestrator-recorded "verified" are silent even with no handoff', () => {
  const findings = checkBookkeeping(
    {
      escalations: [
        { id: "not-started-yet", status: "pending", route: "delegate" },
        // The shape an orchestrator-built escalation carries (no worker ran).
        { id: "E-registry-web-move", status: "verified", verifiedBy: [{ cmd: "grep -n x agent-routing.json", exitCode: 0 }] },
      ],
    },
    { handoffFiles: [] },
  )
  assert.equal(findings.filter((x) => x.code.startsWith("esc-")).length, 0)
})

test("pre-existing esc- cases (check 4) still pass unchanged", () => {
  const unrecorded = checkBookkeeping({ escalations: [] }, { handoffFiles: ["ESC-flow-harden.json"] })
  assert.equal(unrecorded.filter((x) => x.code === "esc-handoff-unrecorded").length, 1)

  const notMarked = checkBookkeeping(
    { escalations: [{ id: "ESC-ci-gate", verifiedBy: ["tsc"] }] },
    { handoffFiles: ["ESC-ci-gate.json"] },
  )
  assert.equal(notMarked.filter((x) => x.code === "esc-handoff-not-marked-delegated").length, 1)
})

// --- checkpoint knowledge ---------------------------------------------------

test("a done milestone with no decisions[] entry warns, and NEVER errors", () => {
  const f = checkBookkeeping({
    milestones: [
      { id: "M1", order: 1, status: "done" },
      { id: "M2", order: 2, status: "in-progress" }, // not done → not expected to have one yet
    ],
  })
  const hit = f.filter((x) => x.code === "checkpoint-missing-decisions")
  assert.equal(hit.length, 1)
  assert.ok(hit[0].detail.startsWith("M1"))
  // Must never block a mid-flight resume: the convention post-dates live missions.
  assert.equal(hit[0].severity, "warn")
  assert.equal(f.some((x) => x.severity === "error"), false)
})

test("a done milestone WITH a decision is clean", () => {
  const f = checkBookkeeping({
    milestones: [{ id: "M1", order: 1, status: "done" }],
    decisions: [{ milestone: "M1", decision: "challenge codes live in Postgres, not process memory", why: "serverless has no shared memory" }],
  })
  assert.equal(f.filter((x) => x.code === "checkpoint-missing-decisions").length, 0)
})

test("a legacy plan-time decisions{} map is read as plan records: no error, and it never satisfies a milestone checkpoint", () => {
  const f = checkBookkeeping({
    milestones: [{ id: "M0", order: 1, status: "done" }],
    decisions: { approvedAt: "2026-10-27", staffAuth: "email-code", workflowOptIn: true },
  })
  assert.equal(f.some((x) => x.severity === "error"), false)
  const hit = f.filter((x) => x.code === "checkpoint-missing-decisions")
  assert.equal(hit.length, 1)
  assert.ok(hit[0].detail.startsWith("M0"))
})

test("decisionRecords: an array keeps its object records; a legacy map becomes one plan record per key; anything else is empty", () => {
  const records = [{ milestone: "M1", decision: "d", why: "w" }]
  assert.deepEqual(decisionRecords([...records, null, "junk", ["nested"]]), records)
  assert.deepEqual(decisionRecords({ staffAuth: "email-code", workflowOptIn: true, budget: { total: null } }), [
    { milestone: PLAN_DECISION_MILESTONE, decision: "staffAuth: email-code", why: "plan-time decision (recorded in the legacy decisions{} map)" },
    { milestone: PLAN_DECISION_MILESTONE, decision: "workflowOptIn: true", why: "plan-time decision (recorded in the legacy decisions{} map)" },
    { milestone: PLAN_DECISION_MILESTONE, decision: 'budget: {"total":null}', why: "plan-time decision (recorded in the legacy decisions{} map)" },
  ])
  for (const empty of [undefined, null, "a string", 7, true]) assert.deepEqual(decisionRecords(empty), [])
})

test("a done milestone with no simplifyPasses entry warns (a skipped pass)", () => {
  const f = checkBookkeeping({
    milestones: [
      { id: "M1", order: 1, status: "done" },
      { id: "M2", order: 2, status: "pending" },
    ],
    simplifyPasses: {},
  })
  const hit = f.filter((x) => x.code === "simplify-pass-missing")
  assert.equal(hit.length, 1)
  assert.ok(hit[0].detail.startsWith("M1"))
  assert.equal(hit[0].severity, "warn")
})

test("a recorded simplify pass is clean, including a module that changed nothing", () => {
  const f = checkBookkeeping({
    milestones: [{ id: "M1", order: 1, status: "done" }],
    simplifyPasses: { M1: ["auth", "notification"] },
  })
  assert.equal(f.filter((x) => x.code === "simplify-pass-missing").length, 0)
  // An empty array is NOT a recorded pass — it means nothing was spawned.
  const empty = checkBookkeeping({
    milestones: [{ id: "M1", order: 1, status: "done" }],
    simplifyPasses: { M1: [] },
  })
  assert.equal(empty.filter((x) => x.code === "simplify-pass-missing").length, 1)
})

test("4c: a plan review declared then skipped warns, and names its triggers", () => {
  const f = checkBookkeeping({
    milestones: [{ id: "M1", order: 1, status: "done" }],
    planReview: { required: true, ran: false, triggers: ["a", "f"] },
  })
  const hit = f.filter((x) => x.code === "plan-review-skipped")
  assert.equal(hit.length, 1)
  assert.equal(hit[0].severity, "warn")
  assert.ok(hit[0].detail.includes("a, f"))
  assert.equal(f.some((x) => x.severity === "error"), false)
})

test("4c: a review that ran, and one correctly judged not required, are both clean", () => {
  const ran = checkBookkeeping({ planReview: { required: true, ran: true, triggers: ["c"], objections: 5, applied: 3 } })
  assert.equal(ran.filter((x) => x.code === "plan-review-skipped").length, 0)
  const notRequired = checkBookkeeping({ planReview: { required: false } })
  assert.equal(notRequired.filter((x) => x.code === "plan-review-skipped").length, 0)
})

test("4c: an ABSENT planReview is silent — every mission planned before 4c lacks it", () => {
  const f = checkBookkeeping({ milestones: [{ id: "M1", order: 1, status: "done" }] })
  assert.equal(f.filter((x) => x.code === "plan-review-skipped").length, 0)
})

test("1b: a milestone that advanced with its review declared then skipped warns", () => {
  const f = checkBookkeeping({
    milestones: [
      { id: "M1", order: 1, status: "done" },
      { id: "M2", order: 2, status: "pending" }, // not advanced → not yet expected
    ],
    milestoneReviews: { M1: { required: true, ran: false }, M2: { required: true, ran: false } },
  })
  const hit = f.filter((x) => x.code === "milestone-review-skipped")
  assert.equal(hit.length, 1)
  assert.ok(hit[0].detail.startsWith("M1"))
  assert.equal(hit[0].severity, "warn")
  assert.equal(f.some((x) => x.severity === "error"), false)
})

test("1b: a review that ran, one not required, and an absent record are all clean", () => {
  const ms = [{ id: "M1", order: 1, status: "done" }]
  const ran = checkBookkeeping({ milestones: ms, milestoneReviews: { M1: { required: true, ran: true, findings: 2, applied: 2 } } })
  assert.equal(ran.filter((x) => x.code === "milestone-review-skipped").length, 0)
  const notReq = checkBookkeeping({ milestones: ms, milestoneReviews: { M1: { required: false } } })
  assert.equal(notReq.filter((x) => x.code === "milestone-review-skipped").length, 0)
  // Absent is silent — every mission planned before 1b lacks the field.
  assert.equal(checkBookkeeping({ milestones: ms }).filter((x) => x.code === "milestone-review-skipped").length, 0)
})

test("a contextReset field (an older harness generation's statusline flag) is ignored, never a finding", () => {
  assert.deepEqual(checkBookkeeping({ contextReset: { requested: true, atPercent: 41, milestone: "M2" } }), [])
})

test("contracts[] / parallelSurfaces (an older harness generation's lanes-with-contracts fields) are ignored, never a finding", () => {
  assert.deepEqual(checkBookkeeping({ contracts: "not-an-array", parallelSurfaces: "yes" }), [])
})

// --- features{} -------------------------------------------------------------

/** Every finding in `findings` carries exactly `code` — proves a negative
 *  mutation trips ONLY the code under test, not a second one a sibling field
 *  happens to also violate. */
function assertOnlyCode(findings, code) {
  assert.ok(findings.length > 0, `expected at least one "${code}" finding`)
  assert.deepEqual(new Set(findings.map((f) => f.code)), new Set([code]))
}

test("FEATURE_SURFACES is backend|web|mobile (mobile kept only so archived states validate)", () => {
  assert.deepEqual(FEATURE_SURFACES, ["backend", "web", "mobile"])
})

test("a features{} map in the planner's shape (surface/module/owner/milestone/isEscalation/pathGlobs) is clean for every surface", () => {
  const features = {}
  for (const surface of FEATURE_SURFACES) {
    features[`F-${surface}`] = {
      surface,
      module: "web-api",
      owner: "worker",
      milestone: "M1",
      isEscalation: false,
      pathGlobs: ["apps/web/app/api/**"],
    }
  }
  assert.deepEqual(checkBookkeeping({ features }), [])
})

test("features present but not an object keyed by id is an error", () => {
  assertOnlyCode(checkBookkeeping({ features: "not-an-object" }), "bad-features-map")
  assertOnlyCode(checkBookkeeping({ features: ["WEB-move"] }), "bad-features-map")
})

test("a non-object features[] entry is an error", () => {
  assertOnlyCode(checkBookkeeping({ features: { F1: null } }), "feature-malformed")
})

test("features[<id>].module must be a non-empty string", () => {
  assertOnlyCode(checkBookkeeping({ features: { F1: { module: "" } } }), "feature-bad-module")
})

test("features[<id>].surface must be backend|web|mobile when present", () => {
  assertOnlyCode(checkBookkeeping({ features: { F1: { module: "auth", surface: "ios" } } }), "feature-bad-surface")
})

test("features[<id>].dependsOn is no longer judged (contract dependencies are not part of this harness)", () => {
  assert.deepEqual(checkBookkeeping({ features: { F1: { module: "auth", dependsOn: "checkout" } } }), [])
})
