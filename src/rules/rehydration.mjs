/**
 * rehydration.mjs — the missions-harness mid-mission orchestrator rehydration rule.
 * (The direct fix for "the orchestrator passes ~40% context by M2 and forces a
 * human handoff".)
 *
 * `resume.mjs` answers WHERE to pick up at the MILESTONE level. This rule answers the
 * finer question a fresh orchestrator session needs mid-mission: where are we INSIDE
 * the current milestone — which features already have handoffs, which assertions are
 * in which state, how many corrective rounds are burned, which escalations are still
 * open, what the last gate said — as one compact, deterministic digest. A fresh
 * session ingests this brief (rendered ≤ 6KB, hard-capped) instead of re-reading raw
 * artifacts, making the mid-mission handoff-to-self lossless and cheap. It is what
 * the SessionStart hook (`mission-context.mjs`) re-injects after a `/clear` or an
 * auto-compact.
 *
 * Pure: no I/O. The caller (or `rehydrate-cli.mjs`, the thin I/O shell) derives
 * `artifacts` from the PRD folder's handoffs/ + verdicts/ listings.
 * Single source of truth; `node --test`-guarded by `rehydration.test.mjs`.
 *
 * @typedef {Object} RehydrationPlan
 * @property {import("./resume.mjs").ResumePlan} resume  milestone-level position
 * @property {string}  missionStatus
 * @property {string|null} focusMilestoneId   currentMilestone if set (unless it is already
 *                                            done and a later milestone remains), else resume.nextMilestoneId
 * @property {Object|null} milestone          intra-milestone detail for the focus milestone
 * @property {Array}   openEscalations        escalations not yet closed (status not done|verified, or no verifiedBy evidence)
 * @property {string[]} plannedEscalations    focus milestone's pre-named escalation ids with no escalations[] record yet
 * @property {Object|null} gate               last integrationGate {passed, scope, ts}
 * @property {*}       activeWorker
 * @property {Object}  knowledge              what the session KNOWS (see below)
 * @property {string[]} warnings              inconsistencies a fresh session must know about
 */

import { resumePlan } from "./resume.mjs"
import { decisionRecords, NO_DEVICE_STATES } from "./bookkeeping.mjs"

const ASSERTION_BUCKETS = ["passing", "failing", "inconclusive", "hypothesis-failed"]
/** The no-device states (e2e environment unavailable) get their OWN bucket: they
 *  make a milestone behaviorally gated, which a fresh session must see, and
 *  lumping them with never-validated ids hid exactly that. */
const NO_DEVICE_BUCKET = "no-device"
const NO_DEVICE = new Set(NO_DEVICE_STATES)

/**
 * Hard caps on the knowledge half. The brief's whole value is that it is cheaper
 * than re-deriving; an uncapped knowledge section would grow back into the thing
 * it replaces. Every list is clipped, never paginated.
 */
const CAPS = { decisions: 10, constraints: 8, features: 12, filesPerFeature: 5, warnings: 6 }

/**
 * Hard ceiling on the RENDERED brief. Enforced structurally in
 * `renderRehydrationBrief` (knowledge lines are dropped until it fits), not
 * merely asserted in a test — this brief is auto-injected on every session
 * start, so an unbounded worst case would be paid on every reset. ~1.5k tokens
 * against a measured ~110k re-derivation ramp is still a ~70x trade.
 */
const MAX_BRIEF_CHARS = 6000

const asRecords = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [])

/** Escalation statuses that close a record (given proof). `pending`,
 *  `in-progress` and the legacy `planned` are still open. */
const CLOSED_ESCALATION_STATUSES = new Set(["done", "verified"])
const hasProof = (e) => (Array.isArray(e.verifiedBy) ? e.verifiedBy.length > 0 : Boolean(e.verifiedBy))

/** An escalation is open until it is BOTH closed by status and carries proof.
 *  A record with no status at all (written before statuses existed) falls back
 *  to proof presence alone. */
export function isOpenEscalation(e) {
  if (!e || typeof e !== "object") return false
  if (e.status === undefined || e.status === null) return !hasProof(e)
  return !CLOSED_ESCALATION_STATUSES.has(e.status) || !hasProof(e)
}

/**
 * An orchestrator-owned feature (features{}.<id>.isEscalation, or owner
 * "orchestrator") is implemented and recorded under escalation id(s), so it
 * never gets a `handoffs/<feature-id>.json` and handoff presence alone would
 * leave it "pending" forever. It counts as built once every escalations[]
 * record that names it is closed with proof. A record names it through its
 * `feature` field, or by being an escalation id the feature's procedure text
 * mentions. No naming record → not built.
 */
function orchestratorFeatureBuilt(missionState, featureId) {
  const meta = missionState.features?.[featureId]
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false
  if (meta.isEscalation !== true && meta.owner !== "orchestrator") return false
  const procedure = typeof missionState.procedures?.[featureId] === "string" ? missionState.procedures[featureId] : ""
  const naming = (missionState.escalations ?? []).filter(
    (e) =>
      e &&
      typeof e.id === "string" &&
      (e.feature === featureId || (procedure && new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(e.id)}([^A-Za-z0-9_-]|$)`).test(procedure))),
  )
  return naming.length > 0 && naming.every((e) => !isOpenEscalation(e))
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * @param {Object} missionState  parsed mission-state.json
 * @param {{handoffFeatures?: string[], handoffIndex?: Record<string,string[]>, verdictMilestonePrefixes?: string[]}} artifacts
 *   handoffFeatures: `feature` ids that already have a persisted handoff file.
 *   handoffIndex: feature id → repo-relative files that handoff says it touched.
 *   verdictMilestonePrefixes: verdict filename stems (e.g. "M1-auth") —
 *   used only to tell whether the focus milestone has ANY verdict yet.
 * @returns {RehydrationPlan}
 */
export function rehydrationPlan(missionState, artifacts = {}) {
  if (!missionState || typeof missionState !== "object")
    throw new TypeError("missionState must be an object")
  const handoffFeatures = new Set(artifacts.handoffFeatures ?? [])
  const verdictPrefixes = artifacts.verdictMilestonePrefixes ?? []

  const resume = resumePlan(missionState)
  const warnings = []
  if (resume.degraded) warnings.push("resume degraded: a milestone lacked order/status (fallbacks used)")

  const current = missionState.currentMilestone ?? null
  // A pointer left on a milestone that is already `done` (nothing advanced it
  // at the boundary) would focus the brief on finished work after a /clear:
  // move on to the first non-done milestone instead. A pointer to a NOT-done
  // milestone is still honoured as focus, with the mismatch warning below.
  const currentIsDone = Boolean(
    current && (missionState.milestones ?? []).some((m) => m && m.id === current && m.status === "done"),
  )
  const focusMilestoneId = current && !(currentIsDone && resume.nextMilestoneId) ? current : resume.nextMilestoneId
  if (current && resume.nextMilestoneId && current !== resume.nextMilestoneId)
    warnings.push(
      currentIsDone
        ? `currentMilestone (${current}) is already done — focusing the first non-done milestone (${resume.nextMilestoneId}); advance it with set-field currentMilestone`
        : `currentMilestone (${current}) != first non-done milestone (${resume.nextMilestoneId}) — trust milestone statuses, verify currentMilestone`,
    )

  const focus = (missionState.milestones ?? []).find((m) => m && m.id === focusMilestoneId) ?? null

  let milestone = null
  if (focus) {
    const assertionStatus = missionState.assertionStatus ?? {}
    const assertions = { unknown: [], [NO_DEVICE_BUCKET]: [] }
    for (const b of ASSERTION_BUCKETS) assertions[b] = []
    for (const a of focus.assertions ?? []) {
      const s = assertionStatus[a]
      if (ASSERTION_BUCKETS.includes(s)) assertions[s].push(a)
      else if (NO_DEVICE.has(s)) assertions[NO_DEVICE_BUCKET].push(a)
      else assertions.unknown.push(a)
    }
    const features = { built: [], pending: [] }
    for (const f of focus.features ?? []) {
      const built = handoffFeatures.has(f) || orchestratorFeatureBuilt(missionState, f)
      ;(built ? features.built : features.pending).push(f)
    }
    const roundLogTail = (missionState.roundLog ?? [])
      .filter((r) => r && r.milestone === focus.id)
      .slice(-3)
    milestone = {
      id: focus.id,
      status: focus.status ?? "pending",
      surface: focus.surface ?? null,
      features,
      assertions,
      correctiveRounds: (missionState.correctiveRounds ?? {})[focus.id] ?? 0,
      roundLogTail,
      hasVerdicts: verdictPrefixes.some((p) => p === focus.id || p.startsWith(`${focus.id}-`)),
    }
  }

  for (const f of handoffFeatures) {
    // ESC-* handoffs are escalation-worker handoffs. They live outside
    // milestones[].features BY DESIGN, so warning on them is noise that crowds
    // out real inconsistencies (a real mission emitted 7 such lines).
    if (/^ESC-/.test(f)) continue
    const known = (missionState.milestones ?? []).some((m) => (m?.features ?? []).includes(f))
    if (!known) warnings.push(`handoff for unknown feature "${f}" (not in any milestone's features[])`)
  }

  // --- The knowledge half. Status alone made this brief a bookmark, not a
  // handoff: measured ramp-to-first-work in fresh sessions stayed ~104-132k
  // (30-42% of whole-mission orchestrator spend) because the session learned
  // WHERE it was and then re-derived WHAT it knew by re-reading source.
  // Two halves with deliberately different trust models:
  //   decisions/constraints — orchestrator-written prose at milestone boundaries.
  //   artifactTrail — derived MECHANICALLY from handoff files by the caller.
  // The trail is never model-written: artifact-trail fidelity is the weakest
  // dimension of every summarizer measured (2.2-2.5/5), and it is exactly the
  // part a fresh session cannot cheaply re-derive.
  const handoffIndex = artifacts.handoffIndex ?? {}
  const inMilestones = new Set((missionState.milestones ?? []).flatMap((m) => m?.features ?? []))
  const trailScope = new Set([
    ...(missionState.milestones ?? [])
      .filter((m) => m?.status === "done")
      .flatMap((m) => m.features ?? []),
    ...(focus?.features ?? []),
    // Handoffs belonging to no milestone: ESC-* escalation handoffs (shared /
    // Prisma surfaces — the highest-stakes changes in the mission) and plain
    // bookkeeping drift. Both are REAL built artifacts, so excluding them made
    // the trail under-report badly: on a real mission it surfaced 2 of 9
    // handoffs. Trail membership follows what was BUILT, not what was planned.
    ...[...handoffFeatures].filter((f) => !inMilestones.has(f)),
  ])
  const artifactTrail = []
  for (const feature of trailScope) {
    if (artifactTrail.length >= CAPS.features) break
    const files = handoffIndex[feature]
    if (!Array.isArray(files) || !files.length) continue
    artifactTrail.push({
      feature,
      files: files.slice(0, CAPS.filesPerFeature),
      more: Math.max(0, files.length - CAPS.filesPerFeature),
    })
  }
  const knowledge = {
    // Most RECENT entries win a full brief: an early decision that still binds
    // should be restated as a constraint, not left to age out of a tail.
    // `decisionRecords` also reads a legacy plan-time decisions{} map, so a
    // mission planned before decisions[] existed still surfaces its calls.
    decisions: decisionRecords(missionState.decisions).slice(-CAPS.decisions),
    constraints: asRecords(missionState.constraints).slice(-CAPS.constraints),
    artifactTrail,
  }

  if (warnings.length > CAPS.warnings) {
    const suppressed = warnings.length - CAPS.warnings
    warnings.length = CAPS.warnings
    warnings.push(`(+${suppressed} more warnings suppressed)`)
  }

  // Open = not yet closed WITH proof. Keyed on status first: MR-3.3e records
  // verifiedBy one entry per call, so an in-progress escalation with a single
  // proof recorded is still in flight, and keying on `!verifiedBy` alone hid
  // exactly that escalation from the brief after a mid-MR-3.3 compaction.
  const openEscalations = (missionState.escalations ?? [])
    .filter((e) => e && isOpenEscalation(e))
    .map((e) => ({ id: e.id ?? "?", milestone: e.milestone ?? null, status: e.status ?? null }))

  // Escalations the plan pre-named for the focus milestone (milestones[].escalations)
  // that no escalations[] record exists for yet: invisible otherwise until the
  // first upsert, yet they are usually the first thing a milestone runs.
  const recorded = new Set((missionState.escalations ?? []).filter((e) => e && e.id).map((e) => e.id))
  const plannedEscalations = (Array.isArray(focus?.escalations) ? focus.escalations : []).filter(
    (id) => typeof id === "string" && !recorded.has(id),
  )

  const g = missionState.integrationGate
  const gate = g ? { passed: g.passed ?? null, scope: g.scope ?? null, ts: g.ts ?? null } : null

  return {
    resume,
    missionStatus: missionState.missionStatus ?? "unknown",
    focusMilestoneId,
    milestone,
    openEscalations,
    plannedEscalations,
    gate,
    activeWorker: missionState.activeWorker ?? null,
    knowledge,
    warnings,
  }
}

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * Deterministic compact markdown rendering of a RehydrationPlan — the digest a
 * fresh orchestrator session reads INSTEAD of raw artifacts. Hard-capped size:
 * every free-text field is clipped, list-y fields render as counts + ids only.
 * @param {RehydrationPlan} plan
 * @returns {string}
 */
export function renderRehydrationBrief(plan) {
  const L = []
  L.push(`# Mission rehydration brief`)
  L.push(
    `status=${plan.missionStatus} · milestones done=[${plan.resume.doneMilestoneIds.join(", ")}] remaining=[${plan.resume.remainingMilestoneIds.join(", ")}]`,
  )
  const m = plan.milestone
  if (m) {
    L.push(`## Focus: ${m.id} (${m.status}${m.surface ? `, ${m.surface}` : ""})`)
    L.push(`features built=[${m.features.built.join(", ")}] pending=[${m.features.pending.join(", ")}]`)
    const a = m.assertions
    const noDevice = a[NO_DEVICE_BUCKET] ?? []
    L.push(
      `assertions passing=${a.passing.length} failing=[${a.failing.join(", ")}] inconclusive=[${a.inconclusive.join(", ")}] ` +
        `no-device(gated)=[${noDevice.join(", ")}] hypothesis-failed=[${a["hypothesis-failed"].join(", ")}] unverified=[${a.unknown.join(", ")}]`,
    )
    L.push(`correctiveRounds=${m.correctiveRounds} · verdicts-on-disk=${m.hasVerdicts}`)
    for (const r of m.roundLogTail)
      L.push(`round ${r.round} (${r.type ?? "?"}): ${clip((r.trigger ?? []).join("; "), 160)}`)
  } else if (plan.resume.allDone) {
    L.push(`All milestones done — run finish bookkeeping (set-status done; mission-state.json stays in place).`)
  }
  if (plan.openEscalations.length)
    L.push(
      `## Open escalations (not closed with verifiedBy): ${clip(
        plan.openEscalations.map((e) => `${e.id}@${e.milestone ?? "?"}${e.status ? ` (${e.status})` : ""}`).join(", "),
        600,
      )}`,
    )
  if (plan.plannedEscalations?.length)
    L.push(`## Planned escalations (not started): ${clip(plan.plannedEscalations.join(", "), 400)}`)
  if (plan.gate) L.push(`## Last gate: passed=${plan.gate.passed} scope=${clip(plan.gate.scope ?? "", 120)}`)
  if (plan.activeWorker) L.push(`## activeWorker (may be stale): ${clip(JSON.stringify(plan.activeWorker), 200)}`)

  // Knowledge sits at the END, immediately before the standing instruction:
  // it is the part that must actually change behaviour (stop re-deriving), and
  // recency-favoured positions survive attention decay better than the middle.
  const k = plan.knowledge ?? {}
  const K = []
  if (k.constraints?.length) {
    K.push(`## Constraints still binding`)
    for (const c of k.constraints)
      K.push(`- ${clip(c.constraint ?? c.detail ?? "?", 130)}${c.impact ? ` → ${clip(c.impact, 100)}` : ""}`)
  }
  if (k.decisions?.length) {
    K.push(`## Decisions already taken (do NOT relitigate)`)
    for (const d of k.decisions)
      K.push(`- [${d.milestone ?? "?"}] ${clip(d.decision ?? "?", 130)}${d.why ? ` — why: ${clip(d.why, 110)}` : ""}`)
  }
  if (k.artifactTrail?.length) {
    K.push(`## Artifact trail (already built — open these instead of re-deriving)`)
    for (const t of k.artifactTrail)
      K.push(`- ${t.feature}: ${clip(t.files.join(", "), 240)}${t.more ? ` (+${t.more} more)` : ""}`)
  }

  const T = []
  for (const w of plan.warnings) T.push(`⚠ ${w}`)
  T.push(
    `Rehydrate detail on demand only: read the focus milestone's handoffs/verdicts as needed — do NOT re-read all artifacts.`,
  )

  // Structural budget: drop knowledge from the tail (least-recent detail first)
  // until the whole brief fits. Position/status and the standing instruction are
  // never sacrificed — a fresh session that knows less is recoverable, one that
  // does not know WHERE it is is not.
  let dropped = 0
  const size = () => [...L, ...K, ...T].join("\n").length
  while (K.length && size() > MAX_BRIEF_CHARS) {
    K.pop()
    dropped++
  }
  if (dropped) K.push(`… ${dropped} knowledge line(s) dropped to fit the brief budget; read handoffs on demand.`)
  return [...L, ...K, ...T].join("\n").slice(0, MAX_BRIEF_CHARS)
}

export default rehydrationPlan
