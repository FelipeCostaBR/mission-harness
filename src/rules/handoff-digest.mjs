/**
 * handoff-digest.mjs — the terse-worker-return rule.
 *
 * A worker's full handoff is a big object: everything it built, every command it
 * ran, every issue it found. If that object is the worker's RETURN value, it
 * re-enters the orchestrator's context whole — and then a second time as the
 * write that persists it. Measured on real runs, worker returns accounted for
 * 10-18% of a worker-heavy orchestrator session.
 *
 * So persistence is inverted. The WORKER writes its own full handoff to
 * `handoffs/<feature-id>.json` as its last action, and its RETURN is only this
 * DIGEST (~1KB, schema-forced). The orchestrator ingests the digest; validators
 * and bookkeeping read the full object from disk, where it always lived.
 *
 * The digest deliberately keeps EVERYTHING the orchestrator's spawn loop acts on:
 *   - escalations WITH their full file lists (escalation-route consumes them directly),
 *   - incomplete reasons + self-flagged issues (clipped — full text is on disk),
 *   - failed commands (green commands are just a count),
 *   - assertionsCovered, proceduresFollowed, and the handoff path.
 *
 * `digestFromHandoff()` is the single definition of the full→digest mapping.
 *
 * Pure: no I/O.
 */

const CLIP = { reason: 200, incomplete: 160, issue: 120, cmd: 80 }
const MAX = { escalations: 6, escalationFiles: 12, incomplete: 5, issues: 5, failedCommands: 5 }

const clip = (s, n) => {
  const str = String(s)
  return str.length > n ? `${str.slice(0, n)}…` : str
}

/**
 * JSON Schema to force on the worker's RETURN value, in runtimes that support
 * structured output. In runtimes that do not, paste it into the worker prompt as
 * the required response shape — the fields are the contract either way.
 */
export const HANDOFF_DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["feature", "handoffPath", "handoffWritten", "status", "assertionsCovered"],
  properties: {
    feature: { type: "string" },
    handoffPath: { type: "string" }, // <mission>/handoffs/<feature-id>.json
    handoffWritten: { type: "boolean" }, // the worker's CLAIM; the orchestrator's _meta merge is the proof
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
 * @param {Object} handoff  full worker handoff (see docs/schemas.md)
 * @param {{handoffPath: string}} opts
 */
export function digestFromHandoff(handoff, opts = {}) {
  if (!handoff || typeof handoff !== "object") throw new TypeError("handoff must be an object")
  if (typeof handoff.feature !== "string" || !handoff.feature)
    throw new TypeError("handoff.feature must be a non-empty string")
  const handoffPath = opts.handoffPath
  if (typeof handoffPath !== "string" || !handoffPath)
    throw new TypeError("opts.handoffPath is required (where the full handoff lives)")

  const structured = Array.isArray(handoff.escalations) ? handoff.escalations : []
  const incompleteAll = (handoff.incomplete ?? []).map(String)
  const escFromIncomplete = incompleteAll
    .filter((s) => /^escalation:/i.test(s.trim()))
    .map((s) => ({ files: [], reason: s.trim() }))
  const escalations = [...structured, ...escFromIncomplete]
    .slice(0, MAX.escalations)
    .map((e) => {
      const files = (Array.isArray(e.files) ? e.files : []).map(String)
      const overflow =
        files.length > MAX.escalationFiles
          ? ` [+${files.length - MAX.escalationFiles} more files]`
          : ""
      const out = {
        files: files.slice(0, MAX.escalationFiles),
        reason: clip(e.reason ?? e.description ?? "", CLIP.reason - overflow.length) + overflow,
      }
      if (typeof e.additiveOnly === "boolean") out.additiveOnly = e.additiveOnly
      return out
    })

  const incomplete = incompleteAll
    .filter((s) => !/^escalation:/i.test(s.trim()))
    .slice(0, MAX.incomplete)
    .map((s) => clip(s, CLIP.incomplete))
  const issuesAll = (handoff.issues ?? []).map(String)
  const commands = Array.isArray(handoff.commandsRun) ? handoff.commandsRun : []
  const failed = commands
    .filter((c) => c && typeof c.exitCode === "number" && c.exitCode !== 0)
    .slice(0, MAX.failedCommands)
    .map((c) => ({ cmd: clip(c.cmd ?? "", CLIP.cmd), exitCode: c.exitCode }))

  const status = escalations.length ? "escalated" : incompleteAll.length ? "incomplete" : "complete"

  return {
    feature: handoff.feature,
    handoffPath,
    handoffWritten: true,
    status,
    assertionsCovered: (handoff.assertionsCovered ?? []).map(String),
    escalations,
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
