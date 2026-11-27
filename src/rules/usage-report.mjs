// Published Standard rates per million tokens. Codex credits and API USD are
// separate estimates. The API estimate excludes cache-write premiums.
const RATES = new Map([
  ["gpt-6.2-sol", { credits: [50, 2.5, 250], api: [2, 0.1, 10] }],
  ["gpt-6.1-sol", { credits: [50, 2.5, 250], api: [2, 0.1, 10] }],
  ["gpt-6.1-terra", { credits: [25, 1.25, 125], api: [1, 0.05, 5] }],
  ["gpt-6.2-astra", { credits: [200, 10, 1000], api: [8, 0.4, 40] }],
])

export const API_LONG_CONTEXT_TOKENS = 272_000
export const DEFAULT_CONTEXT_WARNING_TOKENS = 230_000
export const USAGE_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/

export function normalizeCodexUsage(usage) {
  const input = usage?.input_tokens
  const output = usage?.output_tokens
  const cached = usage?.cached_input_tokens ?? null
  const writes = usage?.cache_write_input_tokens ?? null
  const valid = (value) => Number.isSafeInteger(value) && value >= 0
  if (!valid(input) || !valid(output) || (cached !== null && (!valid(cached) || cached > input)) ||
      (writes !== null && (!valid(writes) || writes > input - (cached ?? 0)))) return null
  return { input, output, cached, writes }
}

function totals() {
  return {
    records: 0, requestRecords: 0, aggregateTurnRecords: 0,
    input: 0, output: 0, cachedInput: 0, freshInput: 0, cacheWriteInput: 0,
    inputWithCacheBreakdown: 0, cacheBreakdownRecords: 0, cacheWriteRecords: 0,
    peakRequestInput: null, longContextRequests: 0, contextWarningRequests: 0,
    standardCodexCredits: 0, standardApiUsdBeforeCacheWrites: 0,
    codexPricedRecords: 0, apiPricedRequests: 0, requestedModelFallbackRecords: 0,
  }
}

function add(aggregate, record, warningAt) {
  const { request, model, modelFallback, input, output, cached, writes } = record
  const long = request && input > API_LONG_CONTEXT_TOKENS
  aggregate.records++
  aggregate.input += input
  aggregate.output += output
  if (modelFallback) aggregate.requestedModelFallbackRecords++
  if (request) {
    aggregate.requestRecords++
    aggregate.peakRequestInput = Math.max(aggregate.peakRequestInput ?? 0, input)
    if (long) aggregate.longContextRequests++
    if (input >= warningAt) aggregate.contextWarningRequests++
  } else aggregate.aggregateTurnRecords++
  if (writes !== null) {
    aggregate.cacheWriteInput += writes
    aggregate.cacheWriteRecords++
  }
  if (cached === null) return
  aggregate.cachedInput += cached
  aggregate.freshInput += input - cached
  aggregate.inputWithCacheBreakdown += input
  aggregate.cacheBreakdownRecords++

  const rate = RATES.get(model)
  if (!rate) return
  const price = ([freshRate, cachedRate, outputRate], inputFactor, outputFactor) =>
    (((input - cached) * freshRate + cached * cachedRate) * inputFactor + output * outputRate * outputFactor) / 1_000_000
  aggregate.standardCodexCredits += price(rate.credits, 1, 1)
  aggregate.codexPricedRecords++
  if (request) {
    aggregate.standardApiUsdBeforeCacheWrites += price(rate.api, long ? 2 : 1, long ? 1.5 : 1)
    aggregate.apiPricedRequests++
  }
}

function finish(result) {
  return {
    ...result,
    cacheHitRate: result.inputWithCacheBreakdown ? result.cachedInput / result.inputWithCacheBreakdown : null,
    standardCodexCredits: result.codexPricedRecords ? result.standardCodexCredits : null,
    standardApiUsdBeforeCacheWrites: result.apiPricedRequests ? result.standardApiUsdBeforeCacheWrites : null,
  }
}

/** Aggregate only normalized usage. A shared provider response is counted once. */
export function summarizeUsage(attempts, settings = {}) {
  const warningAt = settings.contextWarningTokens ?? DEFAULT_CONTEXT_WARNING_TOKENS
  const budget = settings.advisoryCodexCredits ?? null
  if (!Number.isSafeInteger(warningAt) || warningAt <= 0) throw new Error("usage.contextWarningTokens must be a positive integer")
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) throw new Error("usage.advisoryCodexCredits must be non-negative")
  const complete = totals()
  const coordinator = totals()
  const seen = new Set()
  const seats = attempts.map(({ records, ...attempt }) => {
    const seat = totals()
    const models = new Set()
    let duplicateRecords = 0
    for (const record of records) {
      if (seen.has(record.key)) {
        duplicateRecords++
        continue
      }
      seen.add(record.key)
      models.add(record.model)
      for (const target of [seat, complete]) add(target, record, warningAt)
      if (["coordinator", "orchestrator", "planner"].includes(attempt.role)) add(coordinator, record, warningAt)
    }
    return {
      ...attempt, models: [...models].sort(),
      duplicateRecords,
      usage: seat.records ? finish(seat) : null,
    }
  })
  return {
    attempts: seats.length,
    retries: seats.filter((seat) => seat.retryOf).length,
    failed: seats.filter((seat) => seat.status === "failed").length,
    interrupted: seats.filter((seat) => seat.status === "interrupted").length,
    missingUsage: seats.filter((seat) => seat.usage === null).length,
    partialSources: seats.filter((seat) => seat.sourceStatus === "partial").length,
    totals: finish(complete),
    coordinator: finish(coordinator),
    advisory: {
      contextWarningTokens: warningAt,
      standardCodexCreditBudget: budget,
      reached: budget !== null && complete.codexPricedRecords > 0 && complete.standardCodexCredits >= budget,
    },
    pricing: {
      codex: "https://developers.openai.com/codex/pricing#token-rates",
      api: "https://developers.openai.com/api/docs/pricing",
      apiLongContextTokens: API_LONG_CONTEXT_TOKENS,
      assumptions: "Published Standard rates, recorded usage only. API USD excludes API cache-write premiums and turn aggregates. Codex credits and API USD are separate estimates.",
    },
    seats,
  }
}
