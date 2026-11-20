/**
 * handoff-digest.mjs — the missions-harness terse-worker-return rule.
 *
 * Worker/validator returns re-enter the orchestrator as `<task-notification>`
 * payloads; a full handoff object (17–23KB) used to pass through the
 * orchestrator TWICE — once in the notification, once as the Write that
 * persisted it. The fix inverts persistence: the WORKER writes its own full
 * handoff to `<prdFolder>/handoffs/<feature-id>.json` as its last action (an
 * escalation-worker writes `handoffs/ESC-<id>.json`), and its RETURN value is
 * only this DIGEST (schema-forced via HANDOFF_DIGEST_SCHEMA). The orchestrator
 * ingests ~1KB per worker; validators and bookkeeping read the full file from
 * disk, where it always lived.
 *
 * `digestFromHandoff()` is the single definition of the full→digest mapping —
 * used by tests and by any retrofit over old missions. The digest keeps
 * EVERYTHING the orchestrator's spawn loop actually acts on:
 *   - escalations with their file lists CLIPPED at MAX.escalationFiles (12;
 *     the overflow is named in the reason as "[+N more files]") and EMPTY for
 *     a prose escalation (a bare string, or an `escalation:`-prefixed
 *     incomplete[] line), plus `escalationsCount`, so an escalation past the
 *     cap of 6 is never dropped silently. mission-run step 3 (MR-3.0) feeds
 *     `routeEscalation` from the digest only when `files` is non-empty and
 *     unclipped; otherwise it reads the full list from the handoff file
 *     (`routeEscalation` throws on an empty `files`),
 *   - incomplete reasons + self-flagged issues (clipped — the validator reads
 *     the full text from disk; the orchestrator only needs awareness),
 *   - failed commands (green commands are just a count),
 *   - assertionsCovered, proceduresFollowed, and the handoff path.
 *
 * Pure: no I/O. `node --test`-guarded by `handoff-digest.test.mjs`.
 */

const CLIP = { reason: 200, incomplete: 160, issue: 120, cmd: 80 }
const MAX = { escalations: 6, escalationFiles: 12, incomplete: 5, issues: 5, failedCommands: 5 }

const clip = (s, n) => {
  const str = String(s)
  return str.length > n ? `${str.slice(0, n)}…` : str
}

/**
 * An absent list field reads as empty; a present non-array one throws, so a
 * malformed handoff (say `incomplete: "x"`) can never digest to "complete".
 */
function listOf(handoff, key) {
  const value = handoff[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new TypeError(`handoff.${key} must be an array when present`)
  return value
}

/**
 * JSON Schema forced on the worker's RETURN (replaces the full handoff schema
 * at the Workflow `agent()` call — the full object goes to disk instead).
 */
export const HANDOFF_DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["feature", "handoffPath", "handoffWritten", "status", "assertionsCovered"],
  properties: {
    feature: { type: "string" },
    handoffPath: { type: "string" }, // <prdFolder>/handoffs/<feature-id>.json (ESC-<id>.json for an escalation-worker)
    handoffWritten: { type: "boolean" }, // worker's claim; the orchestrator's _meta merge is the deterministic proof
    status: { enum: ["complete", "incomplete", "escalated"] },
    assertionsCovered: { type: "array", items: { type: "string" } },
    escalations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["files", "reason"],
        properties: {
          files: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
          additiveOnly: { type: "boolean" },
        },
      },
    },
    escalationsCount: { type: "number" },
    incomplete: { type: "array", items: { type: "string" } },
    incompleteCount: { type: "number" },
    issues: { type: "array", items: { type: "string" } },
    issuesCount: { type: "number" },
    commandsRunCount: { type: "number" },
    commandsFailed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cmd", "exitCode"],
        properties: { cmd: { type: "string" }, exitCode: { type: "number" } },
      },
    },
    proceduresFollowed: { type: "boolean" },
  },
}

/**
 * Derive the digest from a FULL handoff object (the canonical mapping).
 * Escalations are accepted from either shape real handoffs use: a structured
 * `escalations[]` field, and/or `incomplete[]` strings prefixed "escalation:".
 * @param {Object} handoff  full worker handoff (references/architecture.md schema)
 * @param {{handoffPath: string}} opts
 */
export function digestFromHandoff(handoff, opts = {}) {
  if (!handoff || typeof handoff !== "object") throw new TypeError("handoff must be an object")
  if (typeof handoff.feature !== "string" || !handoff.feature)
    throw new TypeError("handoff.feature must be a non-empty string")
  const handoffPath = opts.handoffPath
  if (typeof handoffPath !== "string" || !handoffPath)
    throw new TypeError("opts.handoffPath is required (where the full handoff lives)")

  const structured = listOf(handoff, "escalations").map((e, i) => {
    if (typeof e === "string") return { files: [], reason: e }
    if (!e || typeof e !== "object") throw new TypeError(`handoff.escalations[${i}] must be an object or a string`)
    return e
  })
  const incompleteAll = listOf(handoff, "incomplete").map(String)
  const escFromIncomplete = incompleteAll
    .filter((s) => /^escalation:/i.test(s.trim()))
    .map((s) => ({ files: [], reason: s.trim() }))
  const escalationsAll = [...structured, ...escFromIncomplete]
  const escalations = escalationsAll.slice(0, MAX.escalations).map((entry) => {
    const files = (Array.isArray(entry.files) ? entry.files : []).map(String)
    const overflow = files.length > MAX.escalationFiles ? ` [+${files.length - MAX.escalationFiles} more files]` : ""
    const out = {
      files: files.slice(0, MAX.escalationFiles),
      reason: clip(entry.reason ?? entry.description ?? "", CLIP.reason - overflow.length) + overflow,
    }
    if (typeof entry.additiveOnly === "boolean") out.additiveOnly = entry.additiveOnly
    return out
  })

  const incomplete = incompleteAll
    .filter((s) => !/^escalation:/i.test(s.trim()))
    .slice(0, MAX.incomplete)
    .map((s) => clip(s, CLIP.incomplete))
  const issuesAll = listOf(handoff, "issues").map(String)
  const commands = listOf(handoff, "commandsRun")
  const failed = commands
    .filter((c) => c && typeof c.exitCode === "number" && c.exitCode !== 0)
    .slice(0, MAX.failedCommands)
    .map((c) => ({ cmd: clip(c.cmd ?? "", CLIP.cmd), exitCode: c.exitCode }))

  const status = escalationsAll.length ? "escalated" : incompleteAll.length ? "incomplete" : "complete"

  return {
    feature: handoff.feature,
    handoffPath,
    handoffWritten: true,
    status,
    assertionsCovered: listOf(handoff, "assertionsCovered").map(String),
    escalations,
    escalationsCount: escalationsAll.length,
    incomplete,
    incompleteCount: incompleteAll.length - escFromIncomplete.length,
    issues: issuesAll.slice(0, MAX.issues).map((s) => clip(s, CLIP.issue)),
    issuesCount: issuesAll.length,
    commandsRunCount: commands.length,
    commandsFailed: failed,
    proceduresFollowed: handoff.proceduresFollowed === true,
  }
}

export default digestFromHandoff
