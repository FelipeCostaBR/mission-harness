import { randomUUID } from "node:crypto"
import { createReadStream, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { createInterface } from "node:readline"
import { normalizeCodexUsage, summarizeUsage, USAGE_MODEL } from "../rules/usage-report.mjs"

const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const STATUSES = ["completed", "failed", "interrupted"]

function label(value, field) {
  if (typeof value !== "string" || !LABEL.test(value)) throw new Error(`Invalid usage ${field}`)
  return value
}

function sourceConfig(source) {
  if (source == null) return null
  const { format, path, since, until, threadId } = source
  if (!["codex-rollout", "codex-exec"].includes(format) || typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl")) {
    throw new Error("Usage source needs codex-rollout or codex-exec format and an absolute JSONL path")
  }
  const start = since == null ? null : Date.parse(since)
  const end = until == null ? null : Date.parse(until)
  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end)) ||
      (start !== null && end !== null && start >= end)) throw new Error("Usage source needs a valid since/until window")
  if (format === "codex-exec" && (since != null || until != null || threadId != null)) {
    throw new Error("Register one dedicated Codex exec stream per attempt. Time and thread filters require a rollout.")
  }
  return { format, path, since: since ?? null, until: until ?? null, threadId: threadId == null ? null : label(threadId, "threadId") }
}

function attemptDirectory(missionPath) {
  const directory = join(realpathSync(missionPath), ".usage")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (realpathSync(directory) !== directory) throw new Error("Usage metadata must stay in the mission directory")
  return directory
}

function writeOnce(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    linkSync(temp, path)
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("That usage entry already exists. Register retries under a new ID.")
    throw error
  } finally {
    rmSync(temp, { force: true })
  }
}

export function startUsage(missionPath, input) {
  const directory = attemptDirectory(missionPath)
  const { id, role, phase, model, effort, retryOf, source } = input ?? {}
  label(id, "attempt ID")
  if (typeof model !== "string" || !USAGE_MODEL.test(model)) throw new Error("Invalid usage model")
  const record = {
    id, role: label(role, "role"), phase: label(phase, "phase"), requestedModel: model,
    effort: effort == null ? null : label(effort, "effort"),
    retryOf: retryOf == null ? null : label(retryOf, "retryOf"),
    startedAt: new Date().toISOString(),
    source: sourceConfig(source),
  }
  if (record.retryOf !== null && !readdirSync(directory).includes(`${record.retryOf}.start.json`)) {
    throw new Error("retryOf must reference an already registered attempt")
  }
  writeOnce(join(directory, `${id}.start.json`), record)
  return id
}

export function finishUsage(missionPath, id, status, source) {
  label(id, "attempt ID")
  if (!STATUSES.includes(status)) throw new Error("Use completed, failed, or interrupted for the usage outcome")
  const directory = attemptDirectory(missionPath)
  if (!readdirSync(directory).includes(`${id}.start.json`)) throw new Error("Register the attempt before finishing it")
  writeOnce(join(directory, `${id}.finish.json`), {
    status,
    finishedAt: new Date().toISOString(),
    source: sourceConfig(source),
  })
}

async function collectUsage(attempt, source) {
  const result = { records: [], rejectedEvents: 0, sourceStatus: source ? "read" : "missing" }
  if (!source) return result
  try {
    const path = realpathSync(source.path)
    if (!statSync(path).isFile()) throw new Error("Usage source must be a regular file")
    const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })
    const rollout = source.format === "codex-rollout"
    const since = source.since == null ? -Infinity : Date.parse(source.since)
    const until = source.until == null ? Infinity : Date.parse(source.until)
    const turnModels = new Map()
    let latestModel = null
    let lineNumber = 0
    for await (const line of lines) {
      lineNumber++
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch {
        result.rejectedEvents++
        continue
      }
      if (rollout && event?.type === "turn_context") {
        const { model, turn_id } = event.payload ?? {}
        latestModel = typeof model === "string" && USAGE_MODEL.test(model) ? model : null
        if (typeof turn_id === "string") turnModels.set(turn_id, latestModel)
        continue
      }
      if (event?.type !== (rollout ? "token_usage_record" : "turn.completed")) continue
      const record = rollout ? event.payload : event
      if (source.threadId !== null && record?.thread_id !== source.threadId) continue
      if (since !== -Infinity || until !== Infinity) {
        const time = Date.parse(event.timestamp)
        if (!Number.isFinite(time)) {
          result.rejectedEvents++
          continue
        }
        if (time < since || time >= until) continue
      }
      const usage = normalizeCodexUsage(record?.usage)
      const key = rollout ? record?.response_id : `exec:${path}:${lineNumber}`
      if (!usage || typeof key !== "string" || !key) {
        result.rejectedEvents++
        continue
      }
      const observedModel = record?.turn_id == null ? latestModel : turnModels.get(record.turn_id) ?? null
      result.records.push({
        ...usage, key, request: rollout,
        model: observedModel ?? attempt.requestedModel,
        modelFallback: observedModel === null,
      })
    }
  } catch {
    result.sourceStatus = result.records.length ? "partial" : "unavailable"
  }
  if (result.sourceStatus === "read" && result.rejectedEvents) result.sourceStatus = "partial"
  if (result.sourceStatus === "read" && !result.records.length) result.sourceStatus = "empty"
  return result
}

export async function missionUsage(missionPath, settings) {
  const directory = join(realpathSync(missionPath), ".usage")
  let files
  try {
    files = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
  } catch (error) {
    if (error.code === "ENOENT") return summarizeUsage([], settings)
    throw error
  }
  if (realpathSync(directory) !== directory) throw new Error("Usage metadata must stay in the mission directory")
  const fileSet = new Set(files)
  const attempts = []
  for (const file of files.filter((name) => name.endsWith(".start.json"))) {
    const { source, ...attempt } = JSON.parse(readFileSync(join(directory, file), "utf8"))
    const endFile = file.replace(/\.start\.json$/, ".finish.json")
    const end = fileSet.has(endFile) ? JSON.parse(readFileSync(join(directory, endFile), "utf8")) : null
    const telemetry = await collectUsage(attempt, sourceConfig(end?.source ?? source))
    attempts.push({ ...attempt, status: end?.status ?? "running", finishedAt: end?.finishedAt ?? null, ...telemetry })
  }
  return summarizeUsage(attempts, settings)
}

export function renderUsage(report) {
  const total = report.totals
  const estimates = (value) => value === null ? "unavailable" : value.toFixed(2)
  const percent = total.cacheHitRate === null ? "unavailable" : `${(100 * total.cacheHitRate).toFixed(2)}%`
  const lines = [
    `Attempts ${report.attempts} | retries ${report.retries} | failed ${report.failed} | interrupted ${report.interrupted} | missing usage ${report.missingUsage} | partial sources ${report.partialSources}`,
    `Input ${total.input} | output ${total.output} | cache hit rate ${percent} across ${total.cacheBreakdownRecords}/${total.records} records`,
    `Coordinator input ${report.coordinator.input} | peak request ${report.coordinator.peakRequestInput ?? "unknown"}`,
    `Requests above API long-context threshold ${total.longContextRequests}/${total.requestRecords} | aggregate turns ${total.aggregateTurnRecords}`,
    `Standard Codex credits estimate ${estimates(total.standardCodexCredits)} (${total.codexPricedRecords}/${total.records} records)`,
    `Standard API USD estimate before cache-write premiums ${estimates(total.standardApiUsdBeforeCacheWrites)} (${total.apiPricedRequests}/${total.records} records)`,
  ]
  if (total.contextWarningRequests) lines.push(`Advisory: ${total.contextWarningRequests} requests crossed ${report.advisory.contextWarningTokens} input tokens. Trim future payloads or resume from a safe checkpoint.`)
  if (report.advisory.reached) lines.push(`Advisory: recorded credits reached ${report.advisory.standardCodexCreditBudget}. Pause optional work and keep any outstanding required checks pending.`)
  return lines.join("\n")
}
