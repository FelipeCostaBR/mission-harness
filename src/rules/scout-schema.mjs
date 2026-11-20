/**
 * scout-schema.mjs — the mission-scout reply shape.
 *
 * The orchestrator asks `mission-scout` a code question instead of reading
 * source itself (keeping its own context lean). The scout's reply is forced into this shape so the
 * orchestrator can trust it without re-opening the scout's sources: `answer`
 * (<=600 chars), `citations[]` (<=10 `file:line` entries, each a one-line,
 * >=8-non-whitespace-char, letter-or-digit-bearing quote actually on that
 * line), `confidence` (`high|medium|low`, and `high`/`medium` require at
 * least one citation), `unverified[]` for anything the scout could not
 * confirm by reading. Total reply <=2,048 RAW bytes (checked on what the
 * orchestrator actually receives, in the I/O caller — see below).
 *
 * This module is pure — no filesystem access — so it can be `node --test`-run
 * standalone. `validateScoutReply` checks SHAPE only; confirming a citation's
 * `file:line` exists on disk with its quote is necessarily I/O and lives in the
 * thin caller (the `module-validator`/orchestrator check at grading time:
 * read the file, take line N, call `citationQuoteRejection`), which is exactly
 * the pure-rule / thin-I/O-shell split every other lib/ module here already
 * uses. `node --test`-guarded by `scout-schema.test.mjs`.
 */

const CONFIDENCE_LEVELS = ["high", "medium", "low"]

/** A citation's `location` is `path/segments/file.ext:123` — the greedy first
 *  group so a path itself may contain colons, anchored on trailing digits. */
export const LOCATION_RE = /^(.+):(\d+)$/

export const SCOUT_REPLY_MAX_ANSWER_CHARS = 600
export const SCOUT_REPLY_MAX_CITATIONS = 10
export const SCOUT_REPLY_MAX_BYTES = 2048

/** A quote of `"{"` or `"e"` is cheaper to fabricate than to verify, and both
 *  pass a bare substring check — the exact unbacked-claim hazard citations
 *  exist to stop. 8 non-whitespace characters is short enough for a real code token
 *  ("model:", "export ") and too long to guess-and-match by accident. */
export const SCOUT_REPLY_MIN_QUOTE_CHARS = 8

/**
 * JSON Schema for the scout's forced reply. Mirrors the shape of
 * `HANDOFF_DIGEST_SCHEMA` in `handoff-digest.mjs` (`additionalProperties:
 * false`, explicit `required`) so both are enforceable the same way if this
 * repo ever adopts a generic JSON Schema validator; `validateScoutReply` below
 * is the hand-rolled check that runs today under plain `node --test`.
 */
export const SCOUT_REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "citations", "confidence", "unverified"],
  properties: {
    answer: { type: "string", maxLength: SCOUT_REPLY_MAX_ANSWER_CHARS },
    citations: {
      type: "array",
      maxItems: SCOUT_REPLY_MAX_CITATIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["location", "quote"],
        properties: {
          location: { type: "string", pattern: "^.+:\\d+$" },
          quote: { type: "string" },
        },
      },
    },
    confidence: { enum: CONFIDENCE_LEVELS },
    unverified: { type: "array", items: { type: "string" } },
  },
}

/**
 * Validate a candidate scout reply against SCOUT_REPLY_SCHEMA plus the total
 * byte cap. Pure shape check — see the module doc for why file-existence and
 * quote-on-line checks are deliberately NOT here.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateScoutReply(reply) {
  const errors = []
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
    return { valid: false, errors: ["reply must be an object"] }
  }

  const allowedKeys = new Set(Object.keys(SCOUT_REPLY_SCHEMA.properties))
  for (const key of Object.keys(reply)) {
    if (!allowedKeys.has(key)) errors.push(`unexpected top-level key "${key}"`)
  }
  for (const key of SCOUT_REPLY_SCHEMA.required) {
    if (!(key in reply)) errors.push(`missing required key "${key}"`)
  }

  if (typeof reply.answer !== "string") {
    errors.push("answer must be a string")
  } else if (reply.answer.trim().length === 0) {
    errors.push("answer must not be empty")
  } else if (reply.answer.length > SCOUT_REPLY_MAX_ANSWER_CHARS) {
    errors.push(`answer exceeds ${SCOUT_REPLY_MAX_ANSWER_CHARS} chars (${reply.answer.length})`)
  }

  if (!Array.isArray(reply.citations)) {
    errors.push("citations must be an array")
  } else {
    if (reply.citations.length > SCOUT_REPLY_MAX_CITATIONS) {
      errors.push(`citations exceeds ${SCOUT_REPLY_MAX_CITATIONS} entries (${reply.citations.length})`)
    }
    reply.citations.forEach((c, i) => {
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        errors.push(`citations[${i}] must be an object`)
        return
      }
      for (const key of Object.keys(c)) {
        if (key !== "location" && key !== "quote") errors.push(`citations[${i}] has unexpected key "${key}"`)
      }
      if (typeof c.location !== "string" || !LOCATION_RE.test(c.location)) {
        errors.push(`citations[${i}].location must be a "file:line" string, got ${JSON.stringify(c.location)}`)
      }
      if (typeof c.quote !== "string" || c.quote.length === 0) {
        errors.push(`citations[${i}].quote must be a non-empty string`)
      } else if (c.quote.includes("\n")) {
        errors.push(`citations[${i}].quote must be a single line`)
      }
    })
  }

  if (!CONFIDENCE_LEVELS.includes(reply.confidence)) {
    errors.push(`confidence must be one of ${CONFIDENCE_LEVELS.join("|")}, got ${JSON.stringify(reply.confidence)}`)
  } else if (
    (reply.confidence === "high" || reply.confidence === "medium") &&
    Array.isArray(reply.citations) &&
    reply.citations.length === 0
  ) {
    // SS-8: an empty citations[] is only a "nothing found" reply at "low"
    // confidence. "high"/"medium" with zero citations is an unbacked answer —
    // the grader must not wave it through.
    errors.push(`confidence "${reply.confidence}" requires at least one citation (citations[] is empty)`)
  }

  if (!Array.isArray(reply.unverified)) {
    errors.push("unverified must be an array")
  } else {
    reply.unverified.forEach((u, i) => {
      if (typeof u !== "string") errors.push(`unverified[${i}] must be a string`)
    })
  }

  // Checked last: a malformed reply is still worth reporting on its own terms,
  // and JSON.stringify on a shape violation (e.g. a circular value) would throw
  // before any of the errors above were ever collected.
  let totalBytes
  try {
    totalBytes = Buffer.byteLength(JSON.stringify(reply), "utf8")
  } catch {
    totalBytes = Infinity
  }
  if (totalBytes > SCOUT_REPLY_MAX_BYTES) {
    errors.push(`reply exceeds ${SCOUT_REPLY_MAX_BYTES} bytes (${totalBytes})`)
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Split a citation's `location` into its file and line number. Throws on a
 * malformed location — the caller (a validator or the fixture's verify
 * script) is the one doing filesystem I/O and should treat that as a citation
 * failure, not silently skip it.
 */
export function parseCitationLocation(location) {
  const match = LOCATION_RE.exec(String(location))
  if (!match) throw new Error(`not a "file:line" location: ${location}`)
  return { file: match[1], line: Number(match[2]) }
}

/** The distinct ways a quote can fail, so a caller can branch on the reason
 *  rather than re-deriving it from the quote it already handed over. */
export const QUOTE_REJECTION = Object.freeze({
  NOT_A_STRING: "not-a-string",
  EMPTY: "empty",
  TOO_SHORT: "too-short",
  NO_LETTER_OR_DIGIT: "no-letter-or-digit",
  NOT_ON_LINE: "not-on-line",
})

/**
 * Why a citation's quote is refused, or `null` when it is confirmed on the
 * line. Substring match after trimming, so a caller passes a raw line straight
 * from `fs.readFileSync(file, "utf8").split("\n")[line - 1]` without
 * pre-cleaning it.
 *
 * Two SUBSTANCE rules run before the substring check: fewer than
 * `SCOUT_REPLY_MIN_QUOTE_CHARS` non-whitespace characters, or no letter or
 * digit anywhere (a run of punctuation), is refused however real the text is.
 * Both are near-certain to fabricate-and-match by luck rather than reflect a
 * real read.
 *
 * The reason is returned rather than folded into one boolean because the two
 * substance rules refuse a quote that IS on the line, so a caller with only a
 * boolean can report nothing except "not found" — a statement about the file
 * that is false, and that sends the reader to re-read a line which already
 * says what they quoted.
 */
export function citationQuoteRejection(quote, lineText) {
  if (typeof quote !== "string" || typeof lineText !== "string") {
    return { code: QUOTE_REJECTION.NOT_A_STRING, message: "quote and line must both be strings" }
  }
  const trimmed = quote.trim()
  if (trimmed.length === 0) {
    return { code: QUOTE_REJECTION.EMPTY, message: "quote is empty or whitespace only" }
  }
  const nonWhitespaceCount = trimmed.replace(/\s+/g, "").length
  if (nonWhitespaceCount < SCOUT_REPLY_MIN_QUOTE_CHARS) {
    return {
      code: QUOTE_REJECTION.TOO_SHORT,
      message:
        `quote has ${nonWhitespaceCount} non-whitespace character${nonWhitespaceCount === 1 ? "" : "s"}, ` +
        `under the ${SCOUT_REPLY_MIN_QUOTE_CHARS} the substance rule requires (quote more of the line)`,
    }
  }
  if (!/[A-Za-z0-9]/.test(trimmed)) {
    return {
      code: QUOTE_REJECTION.NO_LETTER_OR_DIGIT,
      message: "quote carries no letter or digit, so the substance rule refuses it (quote a name, not punctuation)",
    }
  }
  if (!lineText.includes(trimmed)) {
    return { code: QUOTE_REJECTION.NOT_ON_LINE, message: "quote not found on that line" }
  }
  return null
}

/** Boolean form of `citationQuoteRejection`, for a caller that reports no reason. */
export function citationQuoteMatchesLine(quote, lineText) {
  return citationQuoteRejection(quote, lineText) === null
}

export default validateScoutReply
