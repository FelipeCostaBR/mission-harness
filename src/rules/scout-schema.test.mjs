/**
 * node:test for scout-schema.mjs (the mission-scout reply shape).
 * Run: node --test .claude/skills/run-prd-multi-agent-architecture/lib/scout-schema.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  validateScoutReply,
  parseCitationLocation,
  citationQuoteMatchesLine,
  citationQuoteRejection,
  QUOTE_REJECTION,
  LOCATION_RE,
  SCOUT_REPLY_SCHEMA,
  SCOUT_REPLY_MAX_ANSWER_CHARS,
  SCOUT_REPLY_MAX_CITATIONS,
  SCOUT_REPLY_MAX_BYTES,
  SCOUT_REPLY_MIN_QUOTE_CHARS,
} from "./scout-schema.mjs"

const goodReply = () => ({
  answer: "mission-scout is read-only: tools Read, Grep, Glob, Bash; model sonnet.",
  citations: [{ location: ".claude/agents/mission-scout.md:5", quote: "model: sonnet" }],
  confidence: "high",
  unverified: [],
})

test("SS-1 a well-formed reply validates with no errors", () => {
  const { valid, errors } = validateScoutReply(goodReply())
  assert.equal(valid, true)
  assert.deepEqual(errors, [])
})

test("SS-2 missing required keys are each reported", () => {
  const { valid, errors } = validateScoutReply({ answer: "x" })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes('"citations"')))
  assert.ok(errors.some((e) => e.includes('"confidence"')))
  assert.ok(errors.some((e) => e.includes('"unverified"')))
})

test("SS-3 an unexpected top-level key is rejected (additionalProperties: false)", () => {
  const { valid, errors } = validateScoutReply({ ...goodReply(), extra: true })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes("extra")))
})

test("SS-4 answer at exactly the cap passes; one char over fails", () => {
  const atCap = { ...goodReply(), answer: "a".repeat(SCOUT_REPLY_MAX_ANSWER_CHARS) }
  assert.equal(validateScoutReply(atCap).valid, true)
  const overCap = { ...goodReply(), answer: "a".repeat(SCOUT_REPLY_MAX_ANSWER_CHARS + 1) }
  const { valid, errors } = validateScoutReply(overCap)
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes("exceeds 600 chars")))
})

test("SS-5 an empty or whitespace-only answer is rejected", () => {
  assert.equal(validateScoutReply({ ...goodReply(), answer: "" }).valid, false)
  assert.equal(validateScoutReply({ ...goodReply(), answer: "   " }).valid, false)
})

test("SS-6 a non-string answer is rejected", () => {
  const { valid, errors } = validateScoutReply({ ...goodReply(), answer: 42 })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes("answer must be a string")))
})

test("SS-7 citations at exactly the cap pass; one more fails", () => {
  const atCap = {
    ...goodReply(),
    citations: Array.from({ length: SCOUT_REPLY_MAX_CITATIONS }, (_, i) => ({
      location: `f.ts:${i + 1}`,
      quote: "q",
    })),
  }
  assert.equal(validateScoutReply(atCap).valid, true)
  const overCap = {
    ...goodReply(),
    citations: Array.from({ length: SCOUT_REPLY_MAX_CITATIONS + 1 }, (_, i) => ({
      location: `f.ts:${i + 1}`,
      quote: "q",
    })),
  }
  const { valid, errors } = validateScoutReply(overCap)
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes("citations exceeds 10 entries")))
})

test("SS-8 empty citations[] is allowed only at 'low' confidence ('nothing found')", () => {
  // Corrected from round 1: goodReply() defaults to confidence "high", under
  // which zero citations must now fail (SS-8b) — this case pins the actual
  // "nothing found" shape (low confidence + no citations).
  assert.equal(validateScoutReply({ ...goodReply(), confidence: "low", citations: [] }).valid, true)
})

test("SS-8b 'high' or 'medium' confidence with zero citations is rejected (an unbacked answer)", () => {
  for (const confidence of ["high", "medium"]) {
    const { valid, errors } = validateScoutReply({ ...goodReply(), confidence, citations: [] })
    assert.equal(valid, false, `confidence ${confidence} with no citations should be invalid`)
    assert.ok(errors.some((e) => e.includes("requires at least one citation")))
  }
})

test("SS-9 a citation location without a trailing line number is rejected", () => {
  const { valid, errors } = validateScoutReply({
    ...goodReply(),
    citations: [{ location: "packages/api/src/index.ts", quote: "q" }],
  })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes("must be a") && e.includes("file:line")))
})

test("SS-10 a citation quote spanning two lines is rejected", () => {
  const { valid, errors } = validateScoutReply({
    ...goodReply(),
    citations: [{ location: "f.ts:1", quote: "line one\nline two" }],
  })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes("single line")))
})

test("SS-11 a citation with an empty quote is rejected", () => {
  const { valid } = validateScoutReply({ ...goodReply(), citations: [{ location: "f.ts:1", quote: "" }] })
  assert.equal(valid, false)
})

test("SS-12 a citation carrying an extra key is rejected", () => {
  const { valid, errors } = validateScoutReply({
    ...goodReply(),
    citations: [{ location: "f.ts:1", quote: "q", note: "nope" }],
  })
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes("unexpected key")))
})

test("SS-13 confidence rejects anything outside the enum, including a near-miss", () => {
  assert.equal(validateScoutReply({ ...goodReply(), confidence: "certain" }).valid, false)
  assert.equal(validateScoutReply({ ...goodReply(), confidence: "High" }).valid, false) // case-sensitive
  for (const level of ["high", "medium", "low"]) {
    assert.equal(validateScoutReply({ ...goodReply(), confidence: level }).valid, true)
  }
})

test("SS-14 unverified must be an array of strings", () => {
  assert.equal(validateScoutReply({ ...goodReply(), unverified: "nope" }).valid, false)
  assert.equal(validateScoutReply({ ...goodReply(), unverified: [1, 2] }).valid, false)
  assert.equal(validateScoutReply({ ...goodReply(), unverified: ["could not confirm X"] }).valid, true)
})

test("SS-15 total reply size over the 2,048-byte cap is rejected even when every field is individually valid", () => {
  const oversized = { ...goodReply(), unverified: Array.from({ length: 50 }, (_, i) => `note ${i} ${"x".repeat(50)}`) }
  const { valid, errors } = validateScoutReply(oversized)
  assert.equal(valid, false)
  assert.ok(errors.some((e) => e.includes(`exceeds ${SCOUT_REPLY_MAX_BYTES} bytes`)))
})

test("SS-16 reply must be a plain object, not null/array/primitive", () => {
  assert.equal(validateScoutReply(null).valid, false)
  assert.equal(validateScoutReply([]).valid, false)
  assert.equal(validateScoutReply("nope").valid, false)
  assert.equal(validateScoutReply(undefined).valid, false)
})

test("SS-17 SCOUT_REPLY_SCHEMA's own required/property keys agree with the validator's allowlist", () => {
  const allowed = new Set(Object.keys(SCOUT_REPLY_SCHEMA.properties))
  for (const key of SCOUT_REPLY_SCHEMA.required) assert.ok(allowed.has(key), `required key ${key} not a property`)
  assert.deepEqual(allowed, new Set(["answer", "citations", "confidence", "unverified"]))
})

test("SS-18 parseCitationLocation splits file and line, and tolerates a colon in the path", () => {
  assert.deepEqual(parseCitationLocation("packages/api/src/index.ts:42"), { file: "packages/api/src/index.ts", line: 42 })
  // Next.js route groups and dynamic segments are literal path characters.
  assert.deepEqual(parseCitationLocation("apps/admin/app/(fleet)/vehicles/[id]/page.tsx:7"), {
    file: "apps/admin/app/(fleet)/vehicles/[id]/page.tsx",
    line: 7,
  })
  assert.deepEqual(parseCitationLocation("weird:path/name.ts:7"), { file: "weird:path/name.ts", line: 7 })
})

test("SS-19 parseCitationLocation throws on a malformed location", () => {
  assert.throws(() => parseCitationLocation("no-line-number"), /not a "file:line" location/)
  assert.throws(() => parseCitationLocation(""), Error)
})

test("SS-20 citationQuoteMatchesLine matches a trimmed substring and rejects an absent one", () => {
  assert.equal(citationQuoteMatchesLine("model: sonnet", "  model: sonnet"), true)
  assert.equal(citationQuoteMatchesLine("model: opus", "model: sonnet"), false)
  assert.equal(citationQuoteMatchesLine("", "model: sonnet"), false)
})

test("SS-21 citationQuoteMatchesLine rejects non-string inputs instead of throwing", () => {
  assert.equal(citationQuoteMatchesLine(null, "model: sonnet"), false)
  assert.equal(citationQuoteMatchesLine("model: sonnet", undefined), false)
})

test("SS-22 citationQuoteMatchesLine rejects a quote under the minimum non-whitespace length", () => {
  assert.equal(citationQuoteMatchesLine("o", "model: sonnet"), false)
  assert.equal(citationQuoteMatchesLine("{", "export const HANDOFF_DIGEST_SCHEMA = {"), false)
  assert.equal(citationQuoteMatchesLine("-", "---"), false)
  const atMin = "a".repeat(SCOUT_REPLY_MIN_QUOTE_CHARS)
  assert.equal(citationQuoteMatchesLine(atMin, `line has ${atMin} in it`), true)
  const underMin = "a".repeat(SCOUT_REPLY_MIN_QUOTE_CHARS - 1)
  assert.equal(citationQuoteMatchesLine(underMin, `line has ${underMin} in it`), false)
})

test("SS-23 citationQuoteMatchesLine rejects a quote that is only punctuation, even if long enough", () => {
  const punctOnly = "-".repeat(SCOUT_REPLY_MIN_QUOTE_CHARS)
  assert.equal(citationQuoteMatchesLine(punctOnly, `border: ${punctOnly}`), false)
})

test("SS-24 citationQuoteMatchesLine counts only non-whitespace characters toward the minimum", () => {
  // "a b c d e" is 9 chars total but only 5 non-whitespace (a,b,c,d,e) — under
  // the minimum, so padding with spaces must not satisfy the length check.
  assert.equal(citationQuoteMatchesLine("a b c d e", "line has a b c d e in it"), false)
})

test("SS-25 citationQuoteRejection names WHY a quote is refused, and returns null for a confirmed one", () => {
  const line = '  export const FEE_SCHEDULE_VERSION = "2025.1"'
  assert.equal(citationQuoteRejection("FEE_SCHEDULE_VERSION", line), null)
  const cases = [
    [null, line, QUOTE_REJECTION.NOT_A_STRING],
    ["FEE_SCHEDULE_VERSION", undefined, QUOTE_REJECTION.NOT_A_STRING],
    ["   ", line, QUOTE_REJECTION.EMPTY],
    ["export", line, QUOTE_REJECTION.TOO_SHORT],
    ["=".repeat(SCOUT_REPLY_MIN_QUOTE_CHARS), `a ${"=".repeat(SCOUT_REPLY_MIN_QUOTE_CHARS)} b`, QUOTE_REJECTION.NO_LETTER_OR_DIGIT],
    ["FEE_SCHEDULE_VERSION = 2026", line, QUOTE_REJECTION.NOT_ON_LINE],
  ]
  for (const [quote, text, code] of cases) {
    const r = citationQuoteRejection(quote, text)
    assert.equal(r?.code, code, JSON.stringify(quote))
    assert.ok(typeof r.message === "string" && r.message.length > 0)
  }
  // A substance refusal of a quote that IS on the line must not claim "not found".
  assert.notEqual(citationQuoteRejection("export", line).code, QUOTE_REJECTION.NOT_ON_LINE)
})

test("SS-26 QUOTE_REJECTION is frozen and its codes are distinct", () => {
  assert.ok(Object.isFrozen(QUOTE_REJECTION))
  const codes = Object.values(QUOTE_REJECTION)
  assert.equal(new Set(codes).size, codes.length)
})

test("SS-27 the schema's location pattern and LOCATION_RE agree", () => {
  const pattern = new RegExp(SCOUT_REPLY_SCHEMA.properties.citations.items.properties.location.pattern)
  for (const loc of ["a.ts:1", "weird:path/x.ts:22", "a.ts", "a.ts:", ":3", "a.ts:1a"]) {
    assert.equal(pattern.test(loc), LOCATION_RE.test(loc), loc)
  }
})
