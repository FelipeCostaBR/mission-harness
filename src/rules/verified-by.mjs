/**
 * verified-by.mjs — what one `escalations[].verifiedBy` record must be for the
 * validate phase to re-run it blind.
 *
 * A record is the orchestrator's proof that a delegated escalation works: the
 * exact command it ran, the exit code, the evidence the output showed, and a
 * claim that the command only reads. The validator re-runs `command` in a fresh
 * context and compares against `evidence`. A blank command re-runs as a no-op
 * that exits 0, so it proves nothing while reading green; a blank evidence
 * leaves nothing to compare against.
 *
 * Three readers apply it: `mission state upsert-escalation` refuses a payload
 * record that fails it, and `mission check` warns on one already recorded.
 *
 * Pure: no I/O.
 */

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0

/**
 * Why `record` is not a re-runnable proof, or null when it is one: a non-empty
 * `command` and `evidence`, `exit` exactly 0 and `readOnly` exactly true.
 * @returns {string|null} a clause that reads after `verifiedBy[<i>]`
 */
export function verifiedByRecordProblem(record) {
  if (!isPlainObject(record)) return "is not an object"
  if (!isNonEmptyString(record.command)) return "has no non-empty command"
  if (record.exit !== 0) return "did not exit 0"
  if (!isNonEmptyString(record.evidence)) return "has no non-empty evidence"
  if (record.readOnly !== true) return "is not readOnly: true"
  return null
}

/** Every problem across a verifiedBy value (a record or a list of them). */
export function verifiedByProblems(value) {
  const records = Array.isArray(value) ? value : value == null ? [] : [value]
  const out = []
  records.forEach((r, i) => {
    const p = verifiedByRecordProblem(r)
    if (p) out.push(`verifiedBy[${i}] ${p}`)
  })
  return out
}
