/**
 * rehydration.mjs — the mid-mission orchestrator rehydration rule.
 *
 * `resume.mjs` answers WHERE to pick up at the milestone level. This rule answers
 * the finer question a fresh orchestrator context needs: where are we INSIDE the
 * current milestone — which features already have handoffs, which assertions are
 * in which state, how many corrective rounds are burned, which escalations are
 * still open, what the last gate said — as one compact deterministic digest.
 *
 * Why this is the highest-leverage rule in the harness:
 *
 * A mission does not fit in one context window, and it never will. Across real
 * multi-window missions the ceiling was never the failure — the TOLL was. Most of
 * what a fresh window spends goes on re-orientation: re-reading source to
 * rediscover what the previous window already knew.
 *
 * A status-only brief did NOT fix that. Sessions given one learned WHERE they were
 * and then re-derived WHAT they knew anyway. So the brief carries two halves with
 * deliberately different trust models:
 *   - decisions[] / constraints[] — prose the orchestrator writes at each
 *     milestone boundary. This is the reasoning a later window would otherwise
 *     relitigate.
 *   - artifactTrail — derived MECHANICALLY from the handoff files by the caller,
 *     never model-written. Artifact-trail fidelity is the weakest dimension of a
 *     model-written summary, and it is exactly the part a fresh session cannot
 *     cheaply re-derive.
 *
 * Pure: no I/O. The caller (`src/io/mission.mjs`) supplies `artifacts` from the
 * mission folder's handoffs/ and verdicts/ listings.
 *
 * @typedef {Object} RehydrationPlan
 * @property {import("./resume.mjs").ResumePlan} resume  milestone-level position
 * @property {string}      missionStatus
 * @property {string|null} focusMilestoneId  currentMilestone if set, else resume.nextMilestoneId
 * @property {Object|null} milestone         intra-milestone detail for the focus milestone
 * @property {Array}       openEscalations   escalations with no verifiedBy evidence
 * @property {Object|null} gate              last integrationGate {passed, scope, ts}
 * @property {*}           activeWorker
 * @property {Object}      knowledge         what the session KNOWS (see above)
 * @property {string[]}    warnings          inconsistencies a fresh session must know about
 */

import { resumePlan } from "./resume.mjs"

const ASSERTION_BUCKETS = ["passing", "failing", "inconclusive", "hypothesis-failed"]

/**
 * Hard caps on the knowledge half. The brief's whole value is that it is cheaper
 * than re-deriving; an uncapped knowledge section grows back into the thing it
 * replaces. Every list is clipped, never paginated.
 */
const CAPS = { decisions: 10, constraints: 8, features: 12, filesPerFeature: 5, warnings: 6 }

/**
 * Hard ceiling on the RENDERED brief, enforced structurally in
 * `renderRehydrationBrief` (knowledge lines are dropped until it fits) rather
 * than merely asserted in a test. This brief is auto-injected on every session
 * start, so an unbounded worst case would be paid on every single reset. Roughly
 * 1.5k tokens against a re-derivation ramp orders of magnitude larger.
 */
const MAX_BRIEF_CHARS = 6000

const asRecords = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [])

/**
 * @param {Object} missionState  parsed mission-state.json
 * @param {Object} artifacts
 * @param {string[]} [artifacts.handoffFeatures]  feature ids that have a persisted handoff
 * @param {string[]} [artifacts.verdictMilestonePrefixes]  verdict filename stems
 * @param {Record<string,string[]>} [artifacts.handoffIndex]  feature id -> files it touched
 * @returns {RehydrationPlan}
 */
export function rehydrationPlan(missionState, artifacts = {}) {
  if (!missionState || typeof missionState !== "object")
    throw new TypeError("missionState must be an object")
  const handoffFeatures = new Set(artifacts.handoffFeatures ?? [])
  const verdictPrefixes = artifacts.verdictMilestonePrefixes ?? []

  const resume = resumePlan(missionState)
  const warnings = []
  if (resume.degraded)
    warnings.push("resume degraded: a milestone lacked order/status (fallbacks used)")

  const current = missionState.currentMilestone ?? null
  const focusMilestoneId = current ?? resume.nextMilestoneId
  if (current && resume.nextMilestoneId && current !== resume.nextMilestoneId)
    warnings.push(
      `currentMilestone (${current}) != first non-done milestone (${resume.nextMilestoneId}) — trust milestone statuses, verify currentMilestone`,
    )

  const focus = (missionState.milestones ?? []).find((m) => m && m.id === focusMilestoneId) ?? null

  let milestone = null
  if (focus) {
    const assertionStatus = missionState.assertionStatus ?? {}
    const assertions = { unknown: [] }
    for (const b of ASSERTION_BUCKETS) assertions[b] = []
    for (const a of focus.assertions ?? []) {
      const s = assertionStatus[a]
      if (ASSERTION_BUCKETS.includes(s)) assertions[s].push(a)
      else assertions.unknown.push(a)
    }
    const features = { built: [], pending: [] }
    for (const f of focus.features ?? []) {
      ;(handoffFeatures.has(f) ? features.built : features.pending).push(f)
    }
    const roundLogTail = (missionState.roundLog ?? [])
      .filter((r) => r && r.milestone === focus.id)
      .slice(-3)
    milestone = {
      id: focus.id,
      status: focus.status ?? "pending",
      surface: focus.surface ?? null,
      designSpecPath: focus.designSpecPath ?? null,
      features,
      assertions,
      correctiveRounds: (missionState.correctiveRounds ?? {})[focus.id] ?? 0,
      roundLogTail,
      hasVerdicts: verdictPrefixes.some((p) => p === focus.id || p.startsWith(`${focus.id}-`)),
    }
  }

  for (const f of handoffFeatures) {
    // ESC-* handoffs come from escalation workers. They live outside
    // milestones[].features BY DESIGN, so warning on them is noise that crowds
    // out real inconsistencies.
    if (/^ESC-/.test(f)) continue
    const known = (missionState.milestones ?? []).some((m) => (m?.features ?? []).includes(f))
    if (!known)
      warnings.push(`handoff for unknown feature "${f}" (not in any milestone's features[])`)
  }

  // --- The knowledge half.
  const handoffIndex = artifacts.handoffIndex ?? {}
  const inMilestones = new Set((missionState.milestones ?? []).flatMap((m) => m?.features ?? []))
  const trailScope = new Set([
    ...(missionState.milestones ?? [])
      .filter((m) => m?.status === "done")
      .flatMap((m) => m.features ?? []),
    ...(focus?.features ?? []),
    // Handoffs belonging to no milestone: ESC-* escalation handoffs (the shared
    // surfaces — the highest-stakes changes in the mission) and plain bookkeeping
    // drift. Both are REAL built artifacts, so excluding them made the trail
    // under-report badly. Trail membership follows what was BUILT, not what was
    // planned.
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
    decisions: asRecords(missionState.decisions).slice(-CAPS.decisions),
    constraints: asRecords(missionState.constraints).slice(-CAPS.constraints),
    artifactTrail,
  }

  if (warnings.length > CAPS.warnings) {
    const suppressed = warnings.length - CAPS.warnings
    warnings.length = CAPS.warnings
    warnings.push(`(+${suppressed} more warnings suppressed)`)
  }

  const openEscalations = (missionState.escalations ?? [])
    .filter((e) => e && !e.verifiedBy)
    .map((e) => ({ id: e.id ?? "?", milestone: e.milestone ?? null }))

  const g = missionState.integrationGate
  const gate = g ? { passed: g.passed ?? null, scope: g.scope ?? null, ts: g.ts ?? null } : null

  return {
    resume,
    missionStatus: missionState.missionStatus ?? "unknown",
    focusMilestoneId,
    milestone,
    openEscalations,
    gate,
    activeWorker: missionState.activeWorker ?? null,
    knowledge,
    warnings,
  }
}

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * Deterministic compact markdown rendering of a RehydrationPlan — the digest a
 * fresh orchestrator context reads INSTEAD of raw artifacts. Hard-capped: every
 * free-text field is clipped and list-y fields render as counts plus ids.
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
    if (m.designSpecPath) L.push(`design-spec: ${m.designSpecPath}`)
    L.push(
      `features built=[${m.features.built.join(", ")}] pending=[${m.features.pending.join(", ")}]`,
    )
    const a = m.assertions
    L.push(
      `assertions passing=${a.passing.length} failing=[${a.failing.join(", ")}] inconclusive=[${a.inconclusive.join(", ")}] hypothesis-failed=[${a["hypothesis-failed"].join(", ")}] unverified=[${a.unknown.join(", ")}]`,
    )
    L.push(`correctiveRounds=${m.correctiveRounds} · verdicts-on-disk=${m.hasVerdicts}`)
    for (const r of m.roundLogTail)
      L.push(`round ${r.round} (${r.type ?? "?"}): ${clip((r.trigger ?? []).join("; "), 160)}`)
  } else if (plan.resume.allDone) {
    L.push(`All milestones done — run finish bookkeeping (status, archive, index).`)
  }
  if (plan.openEscalations.length)
    L.push(
      `## Open escalations (no verifiedBy): ${plan.openEscalations.map((e) => `${e.id}@${e.milestone ?? "?"}`).join(", ")}`,
    )
  if (plan.gate)
    L.push(`## Last gate: passed=${plan.gate.passed} scope=${clip(plan.gate.scope ?? "", 120)}`)
  if (plan.activeWorker)
    L.push(`## activeWorker (may be stale): ${clip(JSON.stringify(plan.activeWorker), 200)}`)

  // Knowledge sits at the END, immediately before the standing instruction: it is
  // the part that must actually change behaviour (stop re-deriving), and recency
  // positions survive attention decay better than the middle.
  const k = plan.knowledge ?? {}
  const K = []
  if (k.constraints?.length) {
    K.push(`## Constraints still binding`)
    for (const c of k.constraints)
      K.push(
        `- ${clip(c.constraint ?? c.detail ?? "?", 130)}${c.impact ? ` → ${clip(c.impact, 100)}` : ""}`,
      )
  }
  if (k.decisions?.length) {
    K.push(`## Decisions already taken (do NOT relitigate)`)
    for (const d of k.decisions)
      K.push(
        `- [${d.milestone ?? "?"}] ${clip(d.decision ?? "?", 130)}${d.why ? ` — why: ${clip(d.why, 110)}` : ""}`,
      )
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

  // Structural budget: drop knowledge from the tail until the whole brief fits.
  // Position/status and the standing instruction are never sacrificed — a fresh
  // session that knows less is recoverable, one that does not know WHERE it is
  // is not.
  let dropped = 0
  const size = () => [...L, ...K, ...T].join("\n").length
  while (K.length && size() > MAX_BRIEF_CHARS) {
    K.pop()
    dropped++
  }
  if (dropped)
    K.push(`… ${dropped} knowledge line(s) dropped to fit the brief budget; read handoffs on demand.`)
  return [...L, ...K, ...T].join("\n").slice(0, MAX_BRIEF_CHARS)
}

export default rehydrationPlan
