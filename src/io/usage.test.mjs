import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startUsage, finishUsage, missionUsage, renderUsage } from "./usage.mjs"

const base = { role: "worker", phase: "run", model: "gpt-6.1-terra", effort: "medium" }
const counts = (input_tokens, cached_input_tokens, output_tokens) => ({ input_tokens, cached_input_tokens, output_tokens })
const record = (response_id, usage, timestamp = "2026-11-25T03:31:00Z", thread_id = "demo-thread") => ({
  type: "token_usage_record", timestamp, payload: { response_id, thread_id, usage },
})

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mission-usage-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeLog(dir, name, events) {
  const path = join(dir, name)
  writeFileSync(path, events.map((row) => JSON.stringify(row)).join("\n") + "\n")
  return path
}

test("rollout reports request-level usage for the registered window and separates Codex and long-context API prices", async (t) => {
  const dir = fixture(t)
  const log = writeLog(dir, "rollout.jsonl", [
    { type: "turn_context", payload: { model: "gpt-6.2-sol" } },
    record("before", counts(4, 0, 1), "2026-11-25T03:29:00Z"),
    record("at-limit", counts(272_000, 200_000, 50), "2026-11-25T03:30:00Z"),
    record("over-limit", { ...counts(300_000, 270_000, 100), cache_write_input_tokens: 10_000 }),
    record("other-thread", counts(75, 0, 15), "2026-11-25T03:31:00Z", "another"),
    record("after", counts(9, 0, 1), "2026-11-25T03:32:00Z"),
    { type: "response_item", payload: "RAW_CHAT_MUST_NOT_LEAK" },
  ])
  startUsage(dir, {
    ...base, id: "coordinator", role: "orchestrator", phase: "all",
    source: { format: "codex-rollout", path: log, since: "2026-11-25T03:30:00Z", until: "2026-11-25T03:32:00Z", threadId: "demo-thread" },
  })
  const report = await missionUsage(dir, { advisoryCodexCredits: 1 })
  assert.equal(report.seats[0].status, "running")
  assert.deepEqual(report.seats[0].models, ["gpt-6.2-sol"])
  assert.equal(report.totals.requestedModelFallbackRecords, 0)
  assert.equal(report.totals.input, 572_000)
  assert.equal(report.totals.cachedInput, 470_000)
  assert.equal(report.totals.cacheWriteInput, 10_000)
  assert.equal(report.coordinator.peakRequestInput, 300_000)
  assert.equal(report.totals.longContextRequests, 1)
  assert.equal(report.totals.contextWarningRequests, 2)
  assert.ok(Math.abs(report.totals.standardCodexCredits - 6.3125) < 1e-10)
  assert.ok(Math.abs(report.totals.standardApiUsdBeforeCacheWrites - 0.34) < 1e-10)
  assert.equal(report.advisory.reached, true)
  assert.match(renderUsage(report), /keep any outstanding required checks pending/)
  assert.doesNotMatch(JSON.stringify(report), /RAW_CHAT_MUST_NOT_LEAK|rollout\.jsonl|demo-thread/)
})

test("a cancelled seat stays visible, a replacement has its own ID, and turn summaries have no request-tier price", async (t) => {
  const dir = fixture(t)
  const log = writeLog(dir, "exec.jsonl", [
    { type: "turn.completed", usage: counts(500_000, 450_000, 100) },
    { type: "turn.completed", usage: { input_tokens: 500, output_tokens: 7 } },
  ])
  startUsage(dir, { ...base, id: "first" })
  finishUsage(dir, "first", "interrupted")
  assert.throws(() => finishUsage(dir, "first", "completed"), /already exists/)
  startUsage(dir, { ...base, id: "retry", retryOf: "first" })
  finishUsage(dir, "retry", "completed", { format: "codex-exec", path: log })
  const report = await missionUsage(dir)
  assert.equal(report.attempts, 2)
  assert.equal(report.retries, 1)
  assert.equal(report.interrupted, 1)
  assert.equal(report.missingUsage, 1)
  assert.equal(report.seats[0].usage, null)
  assert.equal(report.totals.aggregateTurnRecords, 2)
  assert.equal(report.totals.cacheBreakdownRecords, 1)
  assert.equal(report.totals.cacheHitRate, 0.9)
  assert.equal(report.totals.peakRequestInput, null)
  assert.equal(report.totals.standardApiUsdBeforeCacheWrites, null)
  assert.equal(report.totals.codexPricedRecords, 1)
  assert.equal(report.totals.requestedModelFallbackRecords, 2)
})

test("duplicate response IDs are counted once and corrupt or unavailable usage stays visible", async (t) => {
  const dir = fixture(t)
  const log = writeLog(dir, "rollout.jsonl", [
    record("same", counts(100, 10, 30)),
    record("same", counts(100, 10, 30)),
    record("invalid", counts(10, 90, 3)),
  ])
  writeFileSync(log, readFileSync(log, "utf8") + '{"t')
  for (const id of ["a", "b"]) startUsage(dir, { ...base, id, source: { format: "codex-rollout", path: log } })
  startUsage(dir, { ...base, id: "failed", source: { format: "codex-rollout", path: join(dir, "absent.jsonl") } })
  finishUsage(dir, "failed", "failed")
  const report = await missionUsage(dir)
  assert.equal(report.totals.records, 1)
  assert.equal(report.seats[0].sourceStatus, "partial")
  assert.equal(report.seats[0].rejectedEvents, 2)
  assert.equal(report.seats[1].duplicateRecords, 2)
  assert.equal(report.seats[2].sourceStatus, "unavailable")
  assert.equal(report.missingUsage, 2)
})

test("a late record uses its turn model and an unknown model stays unpriced", async (t) => {
  const dir = fixture(t)
  const older = record("older", counts(100, 10, 3))
  older.payload.turn_id = "older-turn"
  const newer = record("newer", counts(200, 20, 5))
  newer.payload.turn_id = "newer-turn"
  const log = writeLog(dir, "rollout.jsonl", [
    { type: "turn_context", payload: { turn_id: "older-turn", model: "gpt-6.2-sol" } },
    { type: "turn_context", payload: { turn_id: "newer-turn", model: "terra-new-release" } },
    older, newer,
  ])
  startUsage(dir, { ...base, id: "a", source: { format: "codex-rollout", path: log } })
  const report = await missionUsage(dir)
  assert.deepEqual(report.seats[0].models, ["gpt-6.2-sol", "terra-new-release"])
  assert.equal(report.totals.input, 300)
  assert.equal(report.totals.codexPricedRecords, 1)
  assert.equal(report.totals.apiPricedRequests, 1)
  assert.equal(report.totals.requestedModelFallbackRecords, 0)
})

test("usage registry rejects locations and IDs that could mix attempt records", (t) => {
  const dir = fixture(t)
  assert.throws(() => startUsage(dir, { ...base, id: "../a" }), /attempt ID/)
  assert.throws(() => startUsage(dir, { ...base, id: "a", retryOf: "missing" }), /registered attempt/)
  assert.throws(() => finishUsage(dir, "a", "failed"), /Register the attempt/)
  assert.throws(() => startUsage(dir, {
    ...base, id: "a", source: { format: "codex-exec", path: join(dir, "log.jsonl"), since: "2026-11-25T03:30:00Z" },
  }), /Time and thread filters/)
})
