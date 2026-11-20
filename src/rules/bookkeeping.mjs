/**
 * bookkeeping.mjs — pure, I/O-free invariants the missions-harness bookkeeping
 * must satisfy. The orchestrator (mission-validate step 5) runs
 * `checkBookkeeping(missionState)` before advancing, and `mission-state-cli.mjs`
 * runs it before AND after every write (a write that adds a new error is
 * refused); the SKILL.md prose says WHEN to call it, this module is the single
 * source of truth for WHAT is checked. Same pattern as `decideSelfHeal` /
 * `partitionDisjoint` / `resumePlan` — a tested rule the prose references, not
 * free-text the orchestrator re-derives.
 *
 * Why this exists: the bookkeeping fields (roundLog, queueSubstrate,
 * behaviorally-gated, handoff _meta) once lived entirely in prose with ZERO
 * test/fixture coverage, so a contradiction or drift could only be caught by
 * hand (and twice was, late). These checks turn that prose into deterministic
 * regression coverage.
 *
 * Findings are returned, never thrown: each is { code, severity, detail }.
 *   severity "error" — a hard inconsistency (unknown status, malformed entry).
 *   severity "warn"  — the non-blocking retro signals (counter ahead of log,
 *                      queueSubstrate unprobed) that surface to boundaryNotes
 *                      but do not block advance (decideSelfHeal reads the
 *                      counter only — this module never gates the breaker).
 */

/** Every missionStatus the harness recognizes. Must match mission-flag.mjs's
 *  disarm allowlist (minus "active", which only `arm` sets). Drift between the
 *  two is itself a bug — keep them in sync. */
export const MISSION_STATUSES = ["active", "halted", "done", "behaviorally-gated"]

/** Non-active statuses (the hook is inert for all of these). */
export const NON_ACTIVE_STATUSES = MISSION_STATUSES.filter((s) => s !== "active")

/** roundLog entry types (corrective = failure-driven; hardening = deliberate rigor;
 *  adversarial = the pre-advance correctness pass on a high-risk milestone — logged
 *  on its OWN `adversarialRounds` counter, never drawn from the corrective cap, so
 *  running it can't trip the circuit breaker; infrastructure-halt = the run stopped
 *  on a seat/session/runner limit rather than on anything the code did. It is
 *  recorded because a resumed milestone otherwise looks like it ran once, and it is
 *  a type of its own because charging a session limit to the corrective cap would
 *  trip the breaker on work that never failed). */
export const ROUND_TYPES = ["corrective", "hardening", "adversarial", "infrastructure-halt"]

/** queueSubstrate.status values (mission-run step 1 probe). */
export const QUEUE_SUBSTRATE_STATUSES = ["live", "unavailable-worktree"]

/** handoff _meta.attribution values (exact = serial worker; batch = parallel upper bound). */
export const META_ATTRIBUTION = ["exact", "batch"]

/** The default features{}.<id>.surface vocabulary, used only when the caller
 *  passes no `opts.surfaces`. The CLI always passes the project's own surface
 *  names (the keys of `contractor.config.json` surfaces{}), so this list only
 *  matters to a caller using the rule without a config. */
export const FEATURE_SURFACES = ["backend", "web", "mobile"]

/** escalations[] marker for a delegated escalation (mission-run step 3.0). The
 *  mission-validate 2a fresh-validator trigger keys on EXACTLY this value, so a
 *  missing/misspelled marker silently disables the creator/verifier restoration —
 *  which has happened: ESC-*.json handoffs on disk, zero escalations[] markers,
 *  zero 2a validators. */
export const ESCALATION_WORKER_MARKER = "escalation-worker"

/** escalations[] marker for the MR-3.1 inline route (mission-run step 3): the
 *  orchestrator implemented the escalation itself, so there is no worker and
 *  no handoff to lose. Paired with `route: "inline"` as the two ways an entry
 *  opts OUT of the handoff-presence check below — either is sufficient. */
export const ORCHESTRATOR_INLINE_MARKER = "orchestrator-inline"

/** escalations[].status values that mean a worker has engaged with the entry
 *  (as opposed to `pending`, not yet dispatched) — the handoff-presence check
 *  below applies to both, not just `done`: a stalled/incomplete escalation
 *  still owes the handoff its worker's last action is supposed to write. */
const ESCALATION_HANDOFF_REQUIRED_STATUSES = ["done", "in-progress"]

/** The `milestone` a plan-time decision carries once it is read out of a legacy
 *  `decisions{}` map (see `decisionRecords`). Deliberately NOT a milestone id: it
 *  never satisfies check 5's per-milestone checkpoint, which is correct — a call
 *  taken at plan time is not a milestone boundary's checkpoint. */
export const PLAN_DECISION_MILESTONE = "plan"

/**
 * `decisions` as `{milestone, decision, why}` records, whatever shape it was
 * written in. The canonical shape is an array of those records. Missions planned
 * by an older mission-plan wrote plan-time calls as a flat map instead
 * (`{approvedAt: "2026-10-27", staffAuth: "email-code", ...}`); each key becomes
 * one plan-time record (`milestone: "plan"`, `decision: "<key>: <value>"`) so
 * nothing in it is lost, and nothing in it is hidden from the rehydration brief.
 * Anything else (absent, null, a string, a number) reads as no records. Pure:
 * the caller decides whether to persist the normalized form.
 * @param {unknown} decisions  missionState.decisions
 * @returns {Array<{milestone?:string, decision?:string, why?:string}>}
 */
export function decisionRecords(decisions) {
  if (Array.isArray(decisions)) return decisions.filter((d) => d && typeof d === "object" && !Array.isArray(d))
  if (!decisions || typeof decisions !== "object") return []
  return Object.entries(decisions).map(([key, value]) => ({
    milestone: PLAN_DECISION_MILESTONE,
    decision: `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    why: "plan-time decision (recorded in the legacy decisions{} map)",
  }))
}

/**
 * Check a mission-state object's bookkeeping invariants.
 * @param {object} state parsed mission-state.json
 * @param {{handoffFiles?: string[]}} [opts]  handoffFiles: filenames in the PRD
 *   folder's handoffs/ dir. When provided, every `ESC-*.json` must have a
 *   matching `escalations[]` entry carrying `implementedBy: "escalation-worker"`
 *   — the deterministic guard that the 2a trigger cannot be silently skipped.
 * @returns {Array<{code:string, severity:"error"|"warn", detail:string}>}
 */
export function checkBookkeeping(state, opts = {}) {
  const findings = []
  const surfaces = Array.isArray(opts.surfaces) && opts.surfaces.length ? opts.surfaces : FEATURE_SURFACES
  if (!state || typeof state !== "object") {
    return [{ code: "no-state", severity: "error", detail: "mission-state is not an object" }]
  }

  // 1. missionStatus is a known value (catches the enum-drift class).
  if (state.missionStatus != null && !MISSION_STATUSES.includes(state.missionStatus)) {
    findings.push({
      code: "unknown-mission-status",
      severity: "error",
      detail: `missionStatus "${state.missionStatus}" not in ${MISSION_STATUSES.join("|")}`,
    })
  }

  // 2. roundLog entries are well-formed, and per milestone the log is not
  //    BEHIND the correctiveRounds counter (the retro's "counter ahead of a
  //    non-existent log" signal — non-blocking warn).
  const roundLog = Array.isArray(state.roundLog) ? state.roundLog : []
  const logCountByMilestone = {}
  for (const [i, e] of roundLog.entries()) {
    if (!e || typeof e !== "object") {
      findings.push({ code: "malformed-roundlog-entry", severity: "error", detail: `roundLog[${i}] is not an object` })
      continue
    }
    if (!e.milestone) {
      findings.push({ code: "roundlog-missing-milestone", severity: "error", detail: `roundLog[${i}] has no milestone` })
    }
    if (!ROUND_TYPES.includes(e.type)) {
      findings.push({ code: "roundlog-bad-type", severity: "error", detail: `roundLog[${i}].type "${e.type}" not in ${ROUND_TYPES.join("|")}` })
    }
    // `at` (ISO-8601) makes a retro able to MEASURE elapsed time instead of
    // inferring cost from round counts. Without it the only available signal is
    // "17 rounds", which cannot distinguish a mission that churned for three days
    // from one that ran clean overnight. Warn, never error: every mission logged
    // before this field existed would otherwise be blocked retroactively.
    // (`missionFinalReview` stamps its single occurrence as `ts`; `at` is the
    // per-round field, so the two are not interchangeable.)
    if (e.at === undefined) {
      findings.push({
        code: "roundlog-missing-timestamp",
        severity: "warn",
        detail: `roundLog[${i}] (${e.milestone ?? "?"}/${e.type ?? "?"}) has no \`at\` — retros can count rounds but not measure elapsed time`,
      })
    } else if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) {
      findings.push({
        code: "roundlog-bad-timestamp",
        severity: "error",
        detail: `roundLog[${i}].at must be an ISO-8601 string, got ${JSON.stringify(e.at)}`,
      })
    }
    if (e.milestone) logCountByMilestone[e.milestone] = (logCountByMilestone[e.milestone] ?? 0) + 1
  }
  const corrective = state.correctiveRounds && typeof state.correctiveRounds === "object" ? state.correctiveRounds : {}
  for (const [milestone, count] of Object.entries(corrective)) {
    if (typeof count === "number" && count > 0) {
      const logged = logCountByMilestone[milestone] ?? 0
      if (logged < count) {
        findings.push({
          code: "roundlog-behind-counter",
          severity: "warn",
          detail: `${milestone}: correctiveRounds=${count} but roundLog has ${logged} entr${logged === 1 ? "y" : "ies"} — record round types`,
        })
      }
    }
  }

  // 2b. The INVERSE, and the one that actually bites: the counter BEHIND the log.
  //
  // `decideSelfHeal` reads the counter and nothing else, so a milestone whose
  // corrective rounds were logged but never counted has NO circuit breaker — it
  // can loop past `maxRounds` unchallenged. `resolveWorkerSeat` reads the same
  // field, so the seat escalation silently never fires either: one missed
  // increment disarms BOTH safety mechanisms at once.
  //
  // Check 2 above structurally cannot see this: it iterates
  // `Object.entries(correctiveRounds)`, so a milestone MISSING from the counter
  // entirely is never visited — exactly the shape that has occurred (a roundLog
  // holding a dozen corrective entries across five milestones while
  // correctiveRounds named only the last one, and a middle milestone running
  // FIVE rounds with the cap disarmed).
  //
  // Only `corrective` + `hardening` are compared: `adversarial` is deliberately
  // NOT drawn from the corrective cap (mission-validate 2c), so counting it here
  // would flag every high-risk milestone as inconsistent.
  const CAPPED_ROUND_TYPES = ["corrective", "hardening"]
  const cappedByMilestone = {}
  for (const e of roundLog) {
    if (!e || typeof e !== "object" || !e.milestone) continue
    if (!CAPPED_ROUND_TYPES.includes(e.type)) continue
    cappedByMilestone[e.milestone] = (cappedByMilestone[e.milestone] ?? 0) + 1
  }
  for (const [milestone, logged] of Object.entries(cappedByMilestone)) {
    const counted = typeof corrective[milestone] === "number" ? corrective[milestone] : 0
    if (counted < logged) {
      findings.push({
        code: "counter-behind-roundlog",
        severity: "error",
        detail:
          `${milestone}: roundLog has ${logged} capped round${logged === 1 ? "" : "s"} ` +
          `(corrective+hardening) but correctiveRounds=${counted} — the circuit breaker and ` +
          `the worker-seat escalation both read that counter, so both are disarmed for this ` +
          `milestone. Increment it per mission-validate step 4.`,
      })
    }
  }

  // 3. queueSubstrate: if present, status must be valid; its absence on a
  //    mission that ran is a non-blocking warn (probe was skipped).
  const qs = state.queueSubstrate
  if (qs != null) {
    if (typeof qs !== "object" || !QUEUE_SUBSTRATE_STATUSES.includes(qs.status)) {
      findings.push({
        code: "bad-queue-substrate",
        severity: "error",
        detail: `queueSubstrate.status "${qs && qs.status}" not in ${QUEUE_SUBSTRATE_STATUSES.join("|")}`,
      })
    }
  } else if (roundLog.length > 0 || Object.values(corrective).some((n) => Number(n) > 0)) {
    // Count only rounds that actually RAN: mission-plan seeds correctiveRounds
    // with every milestone at 0, so a key alone says nothing about a probe.
    findings.push({
      code: "queue-substrate-unprobed",
      severity: "warn",
      detail: "queueSubstrate absent though the mission ran rounds — mission-run step 1 probe was skipped",
    })
  }

  // 4. Delegated-escalation lockstep: an ESC-*.json handoff proves an
  //    escalation-worker ran, so escalations[] MUST carry a matching entry with
  //    implementedBy: "escalation-worker" — that marker is what mission-validate
  //    2a keys its fresh validator on. Missing entry or missing marker = the 2a
  //    validator silently never spawns (creator/verifier split stays broken) →
  //    error, not warn.
  const handoffFiles = Array.isArray(opts.handoffFiles) ? opts.handoffFiles : []
  const escalations = Array.isArray(state.escalations) ? state.escalations : []
  for (const f of handoffFiles) {
    const m = /^ESC-(.*?)\.json$/.exec(String(f).split("/").pop())
    if (!m) continue
    // architecture.md documents the file as `handoffs/ESC-<id>.json`, so an
    // id of "E-schema" lands as "ESC-E-schema.json"; some missions instead
    // carried the prefix inside the id itself ("ESC-ci-gate"). Both conventions
    // are live, so match either rather than false-flagging a correct mission.
    const bare = m[1]
    const prefixed = `ESC-${bare}`
    const entry = escalations.find((e) => e && (e.id === bare || e.id === prefixed))
    if (!entry) {
      findings.push({
        code: "esc-handoff-unrecorded",
        severity: "error",
        detail: `handoffs/${prefixed}.json exists but escalations[] has no entry with id "${bare}" or "${prefixed}" — record it with implementedBy: "${ESCALATION_WORKER_MARKER}" so the 2a validator spawns`,
      })
    } else if (entry.implementedBy !== ESCALATION_WORKER_MARKER) {
      findings.push({
        code: "esc-handoff-not-marked-delegated",
        severity: "error",
        detail: `escalations[] entry "${entry.id}" lacks implementedBy: "${ESCALATION_WORKER_MARKER}" (got ${JSON.stringify(entry.implementedBy)}) — the 2a fresh-validator trigger keys on that marker`,
      })
    }
  }

  // 4b. The REVERSE direction from check 4. Check 4 walks handoffFiles and asks
  //     "does escalations[] know about me" — a delegated escalation whose worker
  //     never wrote handoffs/ESC-<id>.json AT ALL is structurally invisible to it
  //     (zero findings, not one). That has happened: several escalations landed
  //     `status: "done"`, their commit messages name "the <id> worker" so a
  //     worker plainly ran, and none had a handoff on disk — the creator/verifier
  //     restoration (mission-validate 2a) silently never triggered for any of
  //     them. This check walks escalations[] instead and asks the opposite
  //     question: "do I have a handoff".
  //
  //     Scope: any entry that is NOT explicitly marked inline (`route:
  //     "inline"` or `implementedBy: "orchestrator-inline"`, MR-3.1 — the
  //     orchestrator's own edit, no worker, nothing to lose) counts as
  //     delegated. Entries hand-added before `upsert-escalation` existed carry
  //     NEITHER field — defaulting an unmarked entry to IN SCOPE, not out, is
  //     the only reading under which this check catches the defect it was
  //     written for.
  //
  //     Severity depends on status, not one blanket rule: `mission-run` MR-3.2
  //     records `route` and `implementedBy` on an escalations[] entry via
  //     `upsert-escalation` AT DISPATCH TIME, before the worker has run — so a
  //     freshly-dispatched `status: "in-progress"` entry with no handoff yet is
  //     the NORMAL state between dispatch and return, not a defect. Treating it
  //     as an error would make the CLI's own no-new-error write gate refuse the
  //     very `upsert-escalation` call that starts every delegated escalation.
  //     `status: "done"` with no handoff is a different claim entirely — the
  //     worker is asserted to have finished, so the evidence is owed now.
  //     `handoffMissing` overrides both to warn, regardless of status, so a
  //     genuinely lost handoff is acknowledged on the record rather than either
  //     blocking forever or being silently invisible. Any other status (an
  //     orchestrator-recorded `verified`, `pending`) is out of scope.
  const handoffBasenames = new Set(handoffFiles.map((f) => String(f).split("/").pop()))
  for (const e of escalations) {
    if (!e || typeof e !== "object" || !e.id) continue
    if (e.route === "inline" || e.implementedBy === ORCHESTRATOR_INLINE_MARKER) continue
    if (!ESCALATION_HANDOFF_REQUIRED_STATUSES.includes(e.status)) continue
    const id = String(e.id)
    // Mirror check 4's two live naming conventions in reverse: a bare id
    // ("E-schema") persists as `ESC-<id>.json`; an id that already carries the
    // `ESC-` prefix ("ESC-ci-gate") persists as `<id>.json`.
    const candidates = id.startsWith("ESC-") ? [`${id}.json`, `ESC-${id}.json`] : [`ESC-${id}.json`]
    if (candidates.some((c) => handoffBasenames.has(c))) continue
    if (e.handoffMissing && typeof e.handoffMissing === "object" && e.handoffMissing.reason) {
      findings.push({
        code: "esc-handoff-missing-acknowledged",
        severity: "warn",
        detail:
          `escalations[] entry "${id}" (status ${e.status}) has no handoffs/${candidates[0]}, ` +
          `acknowledged via handoffMissing: ${JSON.stringify(e.handoffMissing.reason)} — recorded on the ` +
          `record instead of passing silently`,
      })
    } else if (e.status === "done") {
      findings.push({
        code: "esc-escalation-missing-handoff",
        severity: "error",
        detail:
          `escalations[] entry "${id}" (status done, route ${JSON.stringify(e.route ?? null)}, ` +
          `implementedBy ${JSON.stringify(e.implementedBy ?? null)}) has no handoffs/${candidates[0]} — ` +
          `mission-run MR-3.2 requires the escalation-worker to persist one; record ` +
          `handoffMissing: {reason, at} if it is genuinely lost`,
      })
    } else {
      findings.push({
        code: "esc-escalation-handoff-pending",
        severity: "warn",
        detail:
          `escalations[] entry "${id}" (status ${e.status}, route ${JSON.stringify(e.route ?? null)}, ` +
          `implementedBy ${JSON.stringify(e.implementedBy ?? null)}) has no handoffs/${candidates[0]} yet — ` +
          `normal between dispatch and the worker's return (WARN, not ERROR, so it cannot block the ` +
          `dispatching write); record handoffMissing: {reason, at} if the worker returns without one`,
      })
    }
  }

  // 5. Checkpoint knowledge: a milestone that advanced without recording a
  //    decision leaves the next window nothing to inherit but status. Measured:
  //    a status-only brief did NOT reduce fresh-session ramp-to-first-work
  //    (104-132k) because the session re-derived from source anyway. WARN, never
  //    error — the convention post-dates existing missions and must not block a
  //    mid-flight resume. Plan-time records read out of a legacy decisions{} map
  //    (milestone "plan") never count as a milestone's checkpoint.
  const decidedMilestones = new Set(decisionRecords(state.decisions).map((d) => d.milestone).filter(Boolean))
  for (const m of Array.isArray(state.milestones) ? state.milestones : []) {
    if (!m || m.status !== "done" || decidedMilestones.has(m.id)) continue
    findings.push({
      code: "checkpoint-missing-decisions",
      severity: "warn",
      detail: `${m.id} advanced with no decisions[] entry — a later window inherits status but not reasoning; record what was decided and why`,
    })
  }

  // 6. The simplify pass (mission-run step 4) is mandatory in prose and has been
  //    silently skipped entirely on a milestone — the same class of gap as the
  //    missing implementedBy marker. WARN, not error: like the decisions
  //    convention it post-dates live missions.
  const passes = state.simplifyPasses && typeof state.simplifyPasses === "object" ? state.simplifyPasses : {}
  for (const m of Array.isArray(state.milestones) ? state.milestones : []) {
    if (!m || m.status !== "done") continue
    const ran = passes[m.id]
    if (Array.isArray(ran) && ran.length) continue
    findings.push({
      code: "simplify-pass-missing",
      severity: "warn",
      detail: `${m.id} advanced with no simplifyPasses entry — mission-run step 4 spawns one simplify worker per touched module and records them here`,
    })
  }

  // 7. A plan review declared necessary at plan time (mission-plan 4c) that then
  //    never ran. The triggers are contract-shaped, so only the planner can
  //    evaluate them — this check deliberately catches ONLY "declared, then
  //    skipped". An ABSENT planReview stays silent: every mission planned before
  //    4c lacks the field, and warning on those would fire on all of them at once
  //    and train the reader to ignore the code. WARN, never error.
  const pr = state.planReview
  if (pr && typeof pr === "object" && pr.required === true && pr.ran !== true) {
    const triggers = Array.isArray(pr.triggers) && pr.triggers.length ? pr.triggers.join(", ") : "unrecorded"
    findings.push({
      code: "plan-review-skipped",
      severity: "warn",
      detail: `planReview.required is true (triggers: ${triggers}) but it never ran — 4c is the only gate that catches plan-phase defects no grep rule anticipated`,
    })
  }

  // 8. Same shape, per milestone: the deep pre-flight review (mission-run 1b)
  //    declared necessary and then skipped, on a milestone that has since
  //    advanced. Absent stays silent for the same reason as check 7.
  const reviews = state.milestoneReviews && typeof state.milestoneReviews === "object" ? state.milestoneReviews : {}
  for (const m of Array.isArray(state.milestones) ? state.milestones : []) {
    if (!m || m.status !== "done") continue
    const r = reviews[m.id]
    if (!r || typeof r !== "object" || r.required !== true || r.ran === true) continue
    findings.push({
      code: "milestone-review-skipped",
      severity: "warn",
      detail: `${m.id} advanced with milestoneReviews.required true but ran false — 1b reviews the milestone's assertions BEFORE its workers spawn; after the fact it can only become a corrective round`,
    })
  }

  // 9. features{}: the per-feature metadata map `mission-run` reads to build
  //    partitionDisjoint's Feature[] input. `module` is load-bearing for every
  //    caller; `surface` is optional and, when present, must be one of
  //    opts.surfaces (the config's surfaces{} keys; FEATURE_SURFACES when no
  //    config is in play). Extra fields
  //    (owner, milestone, isEscalation, pathGlobs) are the planner's and are not
  //    judged here. Shape-only: whether the whole PLAN is well-formed is the
  //    planner's job, not this check's.
  if (state.features != null) {
    if (typeof state.features !== "object" || Array.isArray(state.features)) {
      findings.push({
        code: "bad-features-map",
        severity: "error",
        detail: `features must be an object keyed by feature id, got ${Array.isArray(state.features) ? "array" : typeof state.features}`,
      })
    } else {
      for (const [id, f] of Object.entries(state.features)) {
        if (!f || typeof f !== "object") {
          findings.push({ code: "feature-malformed", severity: "error", detail: `features["${id}"] is not an object` })
          continue
        }
        if (typeof f.module !== "string" || f.module.length === 0) {
          findings.push({ code: "feature-bad-module", severity: "error", detail: `features["${id}"].module must be a non-empty string` })
        }
        if (f.surface !== undefined && !surfaces.includes(f.surface)) {
          findings.push({
            code: "feature-bad-surface",
            severity: "error",
            detail: `features["${id}"].surface "${f.surface}" not in ${surfaces.join("|")}`,
          })
        }
      }
    }
  }

  return findings
}

/**
 * Check a single worker handoff's orchestrator-injected _meta telemetry.
 * _meta is optional (older handoffs lack it); when present it must be
 * well-formed so the retro can trust it.
 * @param {object} handoff parsed handoffs/<id>.json
 * @returns {Array<{code:string, severity:"error"|"warn", detail:string}>}
 */
export function checkHandoffMeta(handoff) {
  const findings = []
  const meta = handoff && handoff._meta
  if (meta == null) return findings // optional — no finding
  if (typeof meta !== "object") {
    return [{ code: "bad-meta", severity: "error", detail: "_meta is not an object" }]
  }
  if (typeof meta.tokensSpent !== "number" || meta.tokensSpent < 0) {
    findings.push({ code: "bad-meta-tokens", severity: "error", detail: `_meta.tokensSpent must be a non-negative number (got ${meta.tokensSpent})` })
  }
  if (!META_ATTRIBUTION.includes(meta.attribution)) {
    findings.push({ code: "bad-meta-attribution", severity: "error", detail: `_meta.attribution "${meta.attribution}" not in ${META_ATTRIBUTION.join("|")}` })
  }
  return findings
}

/** Convenience: true iff no error-severity findings (warns are allowed). */
export function isBookkeepingClean(findings) {
  return !findings.some((f) => f.severity === "error")
}

/** Assertion states meaning "couldn't verify because the e2e environment was
 *  unavailable" (no e2e browser or device installed, no reachable non-production
 *  DATABASE_URL) — from EITHER the inline-flows path (`inconclusive-no-device`;
 *  the name is historical and kept so existing verdicts still parse) OR the
 *  area-runner path (`skipped` / `E2E-unverified`). Unified here so both behave
 *  identically. */
export const NO_DEVICE_STATES = ["skipped", "E2E-unverified", "inconclusive-no-device"]

/** The state of a `hypothesisGate` assertion whose in-harness empirical/statistical gate
 *  returned NO-GO — a FALSIFIED hypothesis, NOT a code defect (e.g. a tuning change
 *  that lifted its target metric but regressed a sibling metric past its floor — a
 *  structural tradeoff no in-scope lever fixes). Non-blocking like a no-device state
 *  (so the OTHER assertions still earn real verdicts — never mark them passing from
 *  the handoff, invariant 9), but it SETS `hypothesisFailed`, so the milestone halts
 *  CLEAN and cannot be recorded `done`. Distinct from the circuit-break halt. */
export const HYPOTHESIS_FAILED_STATE = "hypothesis-failed"

/**
 * Decide whether a milestone may advance, and whether it must be flagged
 * behaviorally-gated, from the FINAL per-assertion states. Single source of truth
 * for the no-device semantics that mission-validate steps 4/5/5b describe in prose
 * (previously ambiguous how `skipped` folded into `assertionsAllPassing`).
 *
 * Rules:
 *   passing                              -> non-blocking.
 *   no-device (skipped/E2E-unverified/inconclusive-no-device) -> NON-blocking
 *     (it never counts as failing, so missing infrastructure never burns a
 *     corrective round), but it SETS behaviorallyGated — the milestone cannot be
 *     recorded `done` and the mission disarms to `behaviorally-gated` until a live
 *     e2e run flips it to passing.
 *   hypothesis-failed (a hypothesisGate NO-GO) -> NON-blocking (the OTHER assertions
 *     still earn real verdicts), but it SETS hypothesisFailed — the milestone halts
 *     clean and cannot be recorded `done`.
 *   everything else (failing / generic inconclusive / pending) -> BLOCKING.
 *
 * @param {Record<string,string>} assertionStates  e.g. { "WEB-001": "passing", "WEB-005": "skipped" }
 * @returns {{ assertionsAllPassing: boolean, behaviorallyGated: boolean, hypothesisFailed: boolean, blocking: string[] }}
 */
export function computeAdvanceReadiness(assertionStates) {
  const states = assertionStates && typeof assertionStates === "object" ? assertionStates : {}
  const noDevice = new Set(NO_DEVICE_STATES)
  const blocking = []
  let behaviorallyGated = false
  let hypothesisFailed = false
  for (const [id, st] of Object.entries(states)) {
    if (st === "passing") continue
    if (noDevice.has(st)) {
      behaviorallyGated = true
      continue
    }
    if (st === HYPOTHESIS_FAILED_STATE) {
      hypothesisFailed = true // an in-harness empirical NO-GO: non-blocking, but the
      continue // milestone cannot be recorded `done` (step 5's clean-halt path)
    }
    blocking.push(id) // failing / inconclusive / pending / anything else
  }
  return { assertionsAllPassing: blocking.length === 0, behaviorallyGated, hypothesisFailed, blocking }
}
