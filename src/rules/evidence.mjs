/**
 * evidence.mjs — the pure halves of the evidence verbs: follow-up lines,
 * escalation dispatch and close, the verifiedBy re-run set, test-gap
 * dispositions and verdict capture from a seat's transcript.
 *
 * Each of these was once a throwaway script an orchestrator wrote mid-mission
 * (a dispatch helper, a close helper, a verdict extractor, a follow-up adder),
 * untested and re-written per milestone. They live here so `mission state`
 * verbs share one tested definition. See docs/protocol.md § Autopilot.
 *
 * Pure: no I/O, no clock.
 */

import { verifiedByRecordProblem } from "./verified-by.mjs"

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

// ── follow-ups ─────────────────────────────────────────────────────────────

/** The lines of a bulk follow-up text: trimmed, blanks dropped, de-duplicated
 *  against `existing` (entries already in followUps[]) and within the text. */
export function newFollowUpLines(text, existing = []) {
  const have = new Set((Array.isArray(existing) ? existing : []).map((x) => (typeof x === "string" ? x : JSON.stringify(x))))
  const added = []
  let skipped = 0
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (have.has(line)) {
      skipped++
      continue
    }
    have.add(line)
    added.push(line)
  }
  return { added, skipped }
}

// ── escalation dispatch / close ────────────────────────────────────────────

/** `--files` as a JSON array or a comma-separated list, de-duplicated.
 *  @throws {TypeError} when it names no file */
export function parseFileList(value) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("--files needs a JSON array or a comma-separated list")
  const v = value.trim()
  let list
  if (v.startsWith("[")) {
    try {
      list = JSON.parse(v)
    } catch {
      throw new TypeError("--files is not a valid JSON array")
    }
  } else {
    list = v.split(",").map((s) => s.trim())
  }
  if (!Array.isArray(list) || list.length === 0 || !list.every((f) => typeof f === "string" && f.length > 0)) {
    throw new TypeError("--files must list at least one non-empty repo-relative path")
  }
  return [...new Set(list)]
}

/** `activeWorker` once one tag finishes: the tag is removed from a (possibly
 *  comma-joined) marker, null when nothing is left. A marker naming only other
 *  work is returned unchanged. */
export function activeWorkerWithout(activeWorker, tag) {
  if (!isPlainObject(activeWorker) || typeof activeWorker.feature !== "string") return activeWorker ?? null
  const parts = activeWorker.feature.split(",").map((s) => s.trim()).filter(Boolean)
  if (!parts.includes(tag)) return activeWorker
  const rest = parts.filter((p) => p !== tag)
  return rest.length ? { ...activeWorker, feature: rest.join(",") } : null
}

/**
 * Escalations are serial (invariant 12): a delegated escalation may not be
 * dispatched while ANOTHER delegated escalation is still in progress. Returns
 * the refusal reason, or null when the dispatch may proceed.
 */
export function serialDispatchConflict(escalations, id) {
  const running = (Array.isArray(escalations) ? escalations : []).filter(
    (e) => e && e.id !== id && e.status === "in-progress" && e.route === "delegate",
  )
  if (!running.length) return null
  return `escalations are serial and ${running.map((e) => e.id).join(", ")} is still in progress; close it first`
}

/**
 * One `--verified` entry for close-esc. `exit` defaults to 0 (the caller states
 * it ran green), but `readOnly: true` must be STATED per entry: it is the one
 * guard keeping a mutating command out of the blind re-run, so it is never
 * stamped on the caller's behalf.
 * @throws {TypeError}
 */
export function expandVerifiedEntry(v, i) {
  if (!isPlainObject(v)) throw new TypeError(`--verified[${i}] must be an object`)
  if (typeof v.command !== "string" || v.command.trim().length === 0) throw new TypeError(`--verified[${i}].command must be a non-empty string`)
  if (typeof v.evidence !== "string" || v.evidence.trim().length === 0) throw new TypeError(`--verified[${i}].evidence must be a non-empty string`)
  if (v.readOnly !== true) {
    throw new TypeError(
      `--verified[${i}].readOnly must be stated as true: only a command that changes nothing may be re-run blind ` +
        `(a mutating or red-on-purpose run is a nonVacuityProofs record, via upsert-escalation)`,
    )
  }
  return { exit: 0, ...v }
}

// ── the verifiedBy re-run ──────────────────────────────────────────────────

/** A proof may be re-run blind only when it is a complete record: a non-empty
 *  command and evidence, `exit: 0` and `readOnly: true` (verified-by.mjs). A
 *  legacy `{cmd, exitCode}` entry or a hand edit is never run. */
export function isAdmissibleProof(v) {
  return verifiedByRecordProblem(v) === null
}

/**
 * A milestone's escalations (ids pre-named on the milestone plus records whose
 * `milestone` is it) and each one's proofs. Only admissible entries are in
 * `commands`; every other entry is listed in `inadmissible` and never run. An
 * escalation with no verifiedBy at all carries `missing: true`. Both FAIL.
 * @returns {Array<{id:string, commands:string[], inadmissible:string[], missing:boolean}>}
 */
export function milestoneEscalationProofs(state, milestone) {
  const ms = (Array.isArray(state?.milestones) ? state.milestones : []).find((m) => m && m.id === milestone)
  const ids = new Set()
  for (const e of Array.isArray(ms?.escalations) ? ms.escalations : []) {
    const id = typeof e === "string" ? e : e?.id
    if (typeof id === "string" && id) ids.add(id)
  }
  const records = Array.isArray(state?.escalations) ? state.escalations : []
  for (const r of records) if (r && r.milestone === milestone && typeof r.id === "string") ids.add(r.id)
  return [...ids].map((id) => {
    const rec = records.find((r) => r && r.id === id)
    const entries = Array.isArray(rec?.verifiedBy) ? rec.verifiedBy : []
    return {
      id,
      commands: entries.filter(isAdmissibleProof).map((v) => v.command),
      inadmissible: entries
        .filter((v) => !isAdmissibleProof(v))
        .map((v) => (isPlainObject(v) ? String(v.command ?? v.cmd ?? "(no command)") : "(not an object)")),
      missing: entries.length === 0,
    }
  })
}

/** A stable fingerprint of a proof set. The re-run takes it before running and
 *  refuses to record when the set changed while the commands ran. */
export function proofSignature(proofs) {
  return JSON.stringify((proofs ?? []).map((p) => [p.id, p.missing, p.commands, p.inadmissible ?? []]))
}

// ── test gaps → terminal records ───────────────────────────────────────────

export const TEST_GAP_KINDS = Object.freeze(["mocked-boundary", "behavioral-not-run", "missing-edge-cases", "impl-mirroring"])

/**
 * Terminal testGap records for every gap in a milestone's verdict documents.
 * `verdicts` is `[{file, doc}]`; `closed` is the set of gap ids a hardening
 * test closed; `fallback` is ACCEPTED or DEFERRED-TO-<m>. A gap whose terminal
 * record (same id, kind and detail) already exists is skipped, so a re-run adds
 * nothing. An unknown kind is kept as missing-edge-cases, named in the detail,
 * never dropped. A detail is collapsed to one line: a multi-line one would
 * split into orphan follow-up fragments downstream.
 */
export function planTestGapRecords(verdicts, existing, { closed = new Set(), fallback }) {
  const seen = new Set(
    (Array.isArray(existing) ? existing : [])
      .filter((g) => g && g.resolution && g.resolution !== "OPEN")
      .map((g) => `${g.id}::${g.kind}::${g.detail}`),
  )
  const records = []
  for (const { file, doc } of verdicts ?? []) {
    const gaps = Array.isArray(doc?.testGaps) ? doc.testGaps : []
    gaps.forEach((g, i) => {
      if (!isPlainObject(g)) return
      const id = typeof g.id === "string" && g.id ? g.id : `${file}#${i}`
      let kind = g.kind
      let detail = (typeof g.detail === "string" && g.detail.trim() ? g.detail : JSON.stringify(g)).replace(/\s+/g, " ").trim()
      if (!TEST_GAP_KINDS.includes(kind)) {
        detail = `[kind: ${String(kind)}] ${detail}`
        kind = "missing-edge-cases"
      }
      const key = `${id}::${kind}::${detail}`
      if (seen.has(key)) return
      seen.add(key)
      const rec = { id, kind, detail, resolution: closed.has(id) ? "CLOSED" : fallback, source: `verdicts/${file}` }
      if (typeof g.suggestedFix === "string" && g.suggestedFix) rec.suggestedFix = g.suggestedFix
      records.push(rec)
    })
  }
  return records
}

// ── verdict capture ────────────────────────────────────────────────────────

const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/

/** A seat's agent id without an `agent-` prefix or `.jsonl` suffix, validated
 *  (it becomes part of a file name). @throws {TypeError} */
export function normalizeAgentId(raw) {
  const id = String(raw ?? "").replace(/^agent-/, "").replace(/\.jsonl$/, "")
  if (!AGENT_ID_RE.test(id)) throw new TypeError(`--agent "${raw}" is not an agent id (letters, digits, - and _)`)
  return id
}

/** True when a parsed value looks like a validator verdict (docs/schemas.md). */
export function isVerdictShape(doc) {
  return isPlainObject(doc) && Array.isArray(doc.verdicts) && (typeof doc.module === "string" || typeof doc.area === "string" || typeof doc.validatedAt === "string")
}

/** The verdict JSON inside a returned text, exactly as written: the whole text
 *  when it parses as a verdict, else the first fenced block that does. */
export function verdictTextOf(s) {
  if (typeof s !== "string") return null
  const candidates = [s, s.trim()]
  const fence = /```(?:json)?\n([\s\S]*?)\n```/g
  for (let m; (m = fence.exec(s)); ) candidates.push(m[1])
  for (const c of candidates) {
    try {
      if (isVerdictShape(JSON.parse(c))) return c
    } catch {
      /* not JSON */
    }
  }
  return null
}

/** The tool names a runtime's seats return their final answer through. */
export const DEFAULT_HANDBACK_TOOLS = Object.freeze(["SubagentHandback"])

/**
 * A validator's RETURNED verdict JSON, byte-for-byte, from its transcript.
 *
 * A JSONL transcript (one `{message: {role, content: [...]}}` object per line):
 * when it holds ANY hand-back tool call, only the LAST one counts, and its
 * message must be a verdict (whole or fenced) or the result is null; an
 * earlier draft is never substituted. With no hand-back, the last assistant
 * text that is a verdict counts. Any other text (a runtime that keeps no
 * JSONL) is read as the returned message itself.
 *
 * @returns {string|null} the exact verdict text, or null (no verdict returned:
 *          the validator's area is failing)
 */
export function extractVerdictFromTranscript(text, { handbackTools = DEFAULT_HANDBACK_TOOLS } = {}) {
  let sawJsonl = false
  let sawHandback = false
  let handback = null
  let lastText = null
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const content = o?.message?.content
    if (!Array.isArray(content)) continue
    sawJsonl = true
    for (const b of content) {
      if (b?.type === "tool_use" && handbackTools.includes(b.name)) {
        sawHandback = true
        handback = verdictTextOf(b.input?.message)
      } else if (b?.type === "text" && o.message.role === "assistant") {
        const v = verdictTextOf(b.text)
        if (v) lastText = v
      }
    }
  }
  if (sawHandback) return handback
  if (sawJsonl) return lastText
  return verdictTextOf(String(text ?? ""))
}

/** The area segment a verdict file name binds: `<m>-<area>[-r<n>].json` →
 *  `<area>`. Null when the name does not start with `<m>-`. capture-verdict
 *  refuses a verdict whose own area differs, so one seat's return is never
 *  filed under another's name. */
export function verdictModuleOf(basename, milestone) {
  const stem = String(basename).replace(/\.json$/, "")
  if (!stem.startsWith(`${milestone}-`)) return null
  const rest = stem.slice(milestone.length + 1).replace(/-r\d+$/, "")
  return rest || null
}
