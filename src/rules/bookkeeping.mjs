/**
 * bookkeeping.mjs — pure, I/O-free invariants a mission's state must satisfy.
 *
 * The orchestrator runs `checkBookkeeping(missionState)` before advancing a
 * milestone. The prose says WHEN to call it; this module is the single source of
 * truth for WHAT is checked.
 *
 * Why it exists at all: every field in mission-state was, at some point, a
 * convention that lived only in prose. Conventions that live only in prose drift
 * silently, and the drift is invisible precisely when the mission is longest and
 * the orchestrator's context is thinnest. Each check below corresponds to a real
 * way a run has gone wrong with every individual step looking fine.
 *
 * Findings are RETURNED, never thrown. Each is `{ code, severity, detail }`:
 *   severity "error" — a hard inconsistency; fix before advancing.
 *   severity "warn"  — a signal that surfaces into the milestone notes but does
 *                      not block. This module never gates the circuit breaker;
 *                      `decideSelfHeal` reads the counter and nothing else.
 */

/** Every missionStatus the harness recognizes.
 *  - active : the hook queues edits; the mission is live.
 *  - halted : stopped, resumable (budget out, circuit breaker tripped, human stop).
 *  - gated  : all in-harness checks pass, but a verification step that can only
 *             happen OUTSIDE the harness is still owed (a live device run, a
 *             manual QA pass, an operator migration). Non-active and non-terminal:
 *             it must NOT be reported as done.
 *  - done   : finished and archived.
 *  Must match the disarm allowlist in src/io/flag.mjs. Drift between the two is
 *  itself a bug — keep them in sync. */
export const MISSION_STATUSES = ["active", "halted", "gated", "done"]

/** Non-active statuses (the edit-routing hook is inert for all of these). */
export const NON_ACTIVE_STATUSES = MISSION_STATUSES.filter((s) => s !== "active")

/** roundLog entry types.
 *  - corrective  : failure-driven; drawn from the circuit-breaker cap.
 *  - hardening   : deliberate rigor (closing a test gap); shares the same cap.
 *  - adversarial : the pre-advance correctness hunt on a high-risk milestone. Kept
 *                  on its OWN counter and NOT drawn from the corrective cap, so
 *                  merely running the safety net can never trip the breaker. */
export const ROUND_TYPES = ["corrective", "hardening", "adversarial"]

/** queueSubstrate.status values (probed when the mission is armed). */
export const QUEUE_SUBSTRATE_STATUSES = ["live", "unavailable-worktree"]

/** handoff _meta.attribution values.
 *  exact = a serial worker's own measured delta.
 *  batch = one delta measured around a whole parallel batch and written to every
 *          member: an aggregate UPPER BOUND, never one worker's truth. */
export const META_ATTRIBUTION = ["exact", "batch"]

/** escalations[] marker for a delegated escalation. The fresh-validator spawn at
 *  the milestone boundary keys on EXACTLY this value, so a missing or misspelled
 *  marker silently disables the creator/verifier restoration — the whole point of
 *  delegating the escalation in the first place. Hence: an error, not a warning. */
export const ESCALATION_WORKER_MARKER = "escalation-worker"

/**
 * Check a mission-state object's bookkeeping invariants.
 * @param {object} state parsed mission-state.json
 * @param {{handoffFiles?: string[]}} [opts]  handoffFiles: filenames in the
 *   mission's handoffs/ dir. When provided, every `ESC-*.json` must have a
 *   matching `escalations[]` entry carrying `implementedBy: "escalation-worker"`.
 * @returns {Array<{code:string, severity:"error"|"warn", detail:string}>}
 */
export function checkBookkeeping(state, opts = {}) {
  const findings = []
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

  // 2. roundLog entries are well-formed, and per milestone the log is not BEHIND
  //    the correctiveRounds counter (rounds happened but their type was never
  //    recorded — a retro can then count rounds but not tell rigor from churn).
  const roundLog = Array.isArray(state.roundLog) ? state.roundLog : []
  const logCountByMilestone = {}
  for (const [i, e] of roundLog.entries()) {
    if (!e || typeof e !== "object") {
      findings.push({
        code: "malformed-roundlog-entry",
        severity: "error",
        detail: `roundLog[${i}] is not an object`,
      })
      continue
    }
    if (!e.milestone) {
      findings.push({
        code: "roundlog-missing-milestone",
        severity: "error",
        detail: `roundLog[${i}] has no milestone`,
      })
    }
    if (!ROUND_TYPES.includes(e.type)) {
      findings.push({
        code: "roundlog-bad-type",
        severity: "error",
        detail: `roundLog[${i}].type "${e.type}" not in ${ROUND_TYPES.join("|")}`,
      })
    }
    // `at` (ISO-8601) is what lets a retro MEASURE elapsed time instead of
    // inferring cost from round counts. Without it the only available signal is
    // "17 rounds", which cannot distinguish a mission that churned for three days
    // from one that ran clean overnight. Warn, never error: missions logged before
    // this field existed would otherwise be blocked retroactively.
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
    if (e.milestone)
      logCountByMilestone[e.milestone] = (logCountByMilestone[e.milestone] ?? 0) + 1
  }
  const corrective =
    state.correctiveRounds && typeof state.correctiveRounds === "object"
      ? state.correctiveRounds
      : {}
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
  // can loop past maxRounds unchallenged. The worker-seat escalation reads the
  // same field, so it silently never fires either: ONE missed increment disarms
  // BOTH safety mechanisms at once.
  //
  // Check 2 above structurally cannot see this, because it iterates the counter's
  // own keys — a milestone missing from the counter entirely is never visited,
  // which is exactly the shape that has occurred in practice (a log holding a
  // dozen corrective entries across five milestones while the counter recorded
  // one milestone at 2, with another milestone running five uncapped rounds).
  //
  // Only corrective + hardening are compared: `adversarial` is deliberately not
  // drawn from the cap, so counting it here would flag every high-risk milestone.
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
          `milestone. Increment it when you log the round.`,
      })
    }
  }

  // 3. queueSubstrate: if present, its status must be valid; its absence on a
  //    mission that has actually run rounds means the probe was skipped, so the
  //    orchestrator does not know whether its edit queue was ever live.
  const qs = state.queueSubstrate
  if (qs != null) {
    if (typeof qs !== "object" || !QUEUE_SUBSTRATE_STATUSES.includes(qs.status)) {
      findings.push({
        code: "bad-queue-substrate",
        severity: "error",
        detail: `queueSubstrate.status "${qs && qs.status}" not in ${QUEUE_SUBSTRATE_STATUSES.join("|")}`,
      })
    }
  } else if (roundLog.length > 0 || Object.keys(corrective).length > 0) {
    findings.push({
      code: "queue-substrate-unprobed",
      severity: "warn",
      detail:
        "queueSubstrate absent though the mission ran rounds — the arm-time probe was skipped, so an empty queue cannot be distinguished from a dead one",
    })
  }

  // 4. Delegated-escalation lockstep. An `ESC-*.json` handoff on disk PROVES an
  //    escalation worker ran, so escalations[] must carry a matching entry with
  //    implementedBy: "escalation-worker" — the marker the fresh-validator spawn
  //    keys on. Missing entry or missing marker means that validator silently
  //    never spawned and the creator/verifier split stayed broken. Error, not warn.
  const handoffFiles = Array.isArray(opts.handoffFiles) ? opts.handoffFiles : []
  const escalations = Array.isArray(state.escalations) ? state.escalations : []
  for (const f of handoffFiles) {
    const m = /^ESC-(.*?)\.json$/.exec(String(f).split("/").pop())
    if (!m) continue
    // The documented filename is `handoffs/ESC-<id>.json`, so an id of "E-schema"
    // lands as "ESC-E-schema.json"; some missions instead carry the prefix inside
    // the id itself ("ESC-ci-gate"). Match either rather than false-flagging a
    // correct mission.
    const bare = m[1]
    const prefixed = `ESC-${bare}`
    const entry = escalations.find((e) => e && (e.id === bare || e.id === prefixed))
    if (!entry) {
      findings.push({
        code: "esc-handoff-unrecorded",
        severity: "error",
        detail: `handoffs/${prefixed}.json exists but escalations[] has no entry with id "${bare}" or "${prefixed}" — record it with implementedBy: "${ESCALATION_WORKER_MARKER}" so the fresh validator spawns`,
      })
    } else if (entry.implementedBy !== ESCALATION_WORKER_MARKER) {
      findings.push({
        code: "esc-handoff-not-marked-delegated",
        severity: "error",
        detail: `escalations[] entry "${entry.id}" lacks implementedBy: "${ESCALATION_WORKER_MARKER}" (got ${JSON.stringify(entry.implementedBy)}) — the fresh-validator trigger keys on that marker`,
      })
    }
  }

  // 5. Checkpoint knowledge. A milestone that advanced without recording a
  //    decision leaves the next context window nothing to inherit but status.
  //    That is not enough in practice: a status-only brief did NOT reduce a fresh
  //    session's ramp-to-first-work, because the session re-derived what it knew
  //    by re-reading source anyway. Warn, never error — the convention post-dates
  //    existing missions and must not block a mid-flight resume.
  const decisions = Array.isArray(state.decisions) ? state.decisions : []
  const decidedMilestones = new Set(decisions.map((d) => d && d.milestone).filter(Boolean))
  for (const m of Array.isArray(state.milestones) ? state.milestones : []) {
    if (!m || m.status !== "done" || decidedMilestones.has(m.id)) continue
    findings.push({
      code: "checkpoint-missing-decisions",
      severity: "warn",
      detail: `${m.id} advanced with no decisions[] entry — a later window inherits status but not reasoning; record what was decided and why`,
    })
  }

  // 6. A context reset is outstanding. The flag is owned by the watcher on BOTH
  //    edges: it clears only when context actually drops back under the threshold,
  //    which is the sole honest proof a reset happened. The orchestrator must ACT
  //    on it and must NOT clear it — an orchestrator that clears its own reset
  //    flag is discharging a signal it cannot verify was acted on.
  const cr = state.contextReset
  if (cr && typeof cr === "object" && cr.requested === true) {
    findings.push({
      code: "context-reset-pending",
      severity: "warn",
      detail: `contextReset requested at ${cr.atPercent ?? "?"}% (milestone ${cr.milestone ?? "?"}) — checkpoint at this boundary and tell the user to clear; do NOT clear the flag yourself`,
    })
  }

  // 7. The simplify pass is mandatory in prose, which means it can be skipped in
  //    practice. Same class of gap as the missing delegation marker. Warn, not
  //    error: like the decisions convention it post-dates live missions.
  const passes =
    state.simplifyPasses && typeof state.simplifyPasses === "object" ? state.simplifyPasses : {}
  for (const m of Array.isArray(state.milestones) ? state.milestones : []) {
    if (!m || m.status !== "done") continue
    const ran = passes[m.id]
    if (Array.isArray(ran) && ran.length) continue
    findings.push({
      code: "simplify-pass-missing",
      severity: "warn",
      detail: `${m.id} advanced with no simplifyPasses entry — one simplify worker per touched area, recorded here (including areas that returned no changes)`,
    })
  }

  // 8. A plan review declared necessary and then never run. The triggers are
  //    contract-shaped, so only the planner can evaluate them — this check
  //    deliberately catches ONLY "declared, then skipped". An ABSENT planReview
  //    stays silent: every mission planned before the gate existed lacks the
  //    field, and warning on all of them at once trains the reader to ignore the
  //    code. Warn, never error.
  const pr = state.planReview
  if (pr && typeof pr === "object" && pr.required === true && pr.ran !== true) {
    const triggers =
      Array.isArray(pr.triggers) && pr.triggers.length ? pr.triggers.join(", ") : "unrecorded"
    findings.push({
      code: "plan-review-skipped",
      severity: "warn",
      detail: `planReview.required is true (triggers: ${triggers}) but it never ran — the adversarial plan review is the only gate that catches plan-phase defects no static rule anticipated`,
    })
  }

  // 9. Same shape, per milestone: the deep pre-flight review declared necessary
  //    and then skipped on a milestone that has since advanced. Absent stays
  //    silent for the same reason as check 8.
  const reviews =
    state.milestoneReviews && typeof state.milestoneReviews === "object"
      ? state.milestoneReviews
      : {}
  for (const m of Array.isArray(state.milestones) ? state.milestones : []) {
    if (!m || m.status !== "done") continue
    const r = reviews[m.id]
    if (!r || typeof r !== "object" || r.required !== true || r.ran === true) continue
    findings.push({
      code: "milestone-review-skipped",
      severity: "warn",
      detail: `${m.id} advanced with milestoneReviews.required true but ran false — the pre-flight review reads the milestone's assertions BEFORE its workers spawn; after the fact it can only become a corrective round`,
    })
  }

  return findings
}

/**
 * Check a single worker handoff's orchestrator-injected `_meta` telemetry.
 * `_meta` is optional; when present it must be well-formed so a retro can trust it.
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
    findings.push({
      code: "bad-meta-tokens",
      severity: "error",
      detail: `_meta.tokensSpent must be a non-negative number (got ${meta.tokensSpent})`,
    })
  }
  if (!META_ATTRIBUTION.includes(meta.attribution)) {
    findings.push({
      code: "bad-meta-attribution",
      severity: "error",
      detail: `_meta.attribution "${meta.attribution}" not in ${META_ATTRIBUTION.join("|")}`,
    })
  }
  return findings
}

/** Convenience: true iff no error-severity findings (warns are allowed). */
export function isBookkeepingClean(findings) {
  return !findings.some((f) => f.severity === "error")
}

/** Assertion states meaning "could not verify because the runner/environment was
 *  not available" — a device was not attached, a staging environment was down, a
 *  paid service was not configured. These are SKIPS, not regressions. */
export const UNVERIFIABLE_STATES = ["skipped", "gate-unverified", "inconclusive-no-runner"]

/** The state of a `hypothesisGate` assertion whose in-harness empirical gate
 *  returned NO-GO — a FALSIFIED HYPOTHESIS, not a code defect. No sharpened
 *  procedure fixes a falsified hypothesis, so it must never open a corrective
 *  round. It is non-blocking like an unverifiable state, but it SETS
 *  `hypothesisFailed`, so the milestone halts CLEAN and cannot be recorded done.
 *  Distinct from a circuit-break halt: no debug branch, no round burned. */
export const HYPOTHESIS_FAILED_STATE = "hypothesis-failed"

/**
 * Decide whether a milestone may advance, and whether it must be flagged as
 * gated, from the FINAL per-assertion states. Single source of truth for the
 * semantics the validate prose describes.
 *
 * Rules:
 *   passing            → non-blocking.
 *   unverifiable       → NON-blocking, so a headless run advances instead of
 *                        stalling on a missing device — but it SETS
 *                        `behaviorallyGated`, and a gated mission may NOT be
 *                        recorded `done` until a real run flips it to passing.
 *   hypothesis-failed  → NON-blocking (the OTHER assertions still earn real
 *                        verdicts), but it SETS `hypothesisFailed`, so the
 *                        milestone halts clean and cannot be recorded `done`.
 *   everything else    → BLOCKING (failing / generic inconclusive / pending).
 *
 * @param {Record<string,string>} assertionStates  e.g. { "A-001": "passing", "A-009": "skipped" }
 * @returns {{ assertionsAllPassing: boolean, behaviorallyGated: boolean, hypothesisFailed: boolean, blocking: string[] }}
 */
export function computeAdvanceReadiness(assertionStates) {
  const states =
    assertionStates && typeof assertionStates === "object" ? assertionStates : {}
  const unverifiable = new Set(UNVERIFIABLE_STATES)
  const blocking = []
  let behaviorallyGated = false
  let hypothesisFailed = false
  for (const [id, st] of Object.entries(states)) {
    if (st === "passing") continue
    if (unverifiable.has(st)) {
      behaviorallyGated = true
      continue
    }
    if (st === HYPOTHESIS_FAILED_STATE) {
      hypothesisFailed = true
      continue
    }
    blocking.push(id) // failing / inconclusive / pending / anything else
  }
  return {
    assertionsAllPassing: blocking.length === 0,
    behaviorallyGated,
    hypothesisFailed,
    blocking,
  }
}
