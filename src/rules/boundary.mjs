/**
 * boundary.mjs — the out-of-area edit rule.
 *
 * A worker seat may edit ONLY files inside its area's `pathGlobs`. The validator
 * reports any stray path as a hard-blocking `boundaryViolations[]`. This is the
 * tested path-membership half of that check; the other half (imports crossing an
 * area line) belongs to whatever import-graph linter your repo already runs.
 *
 * Pure: no I/O.
 *
 * ⚠️ WHY MEMBERSHIP DOES NOT REUSE `globBase` FROM partition.mjs.
 * An earlier version derived a glob's literal prefix and tested
 * `p === base || p.startsWith(base + "/")`. That is correct for a trailing-`**`
 * glob but WRONG when `**` sits mid-pattern: the base of `src/**\/__tests__/**`
 * keeps the wildcard, so no real path can ever start with it and every legitimate
 * test file is reported as a violation. That matters because `boundaryViolations`
 * is a HARD BLOCKER and `escalation-route` GENERATES exactly that glob shape, so a
 * clean milestone could be halted by a pure false positive.
 *
 * `globBase` is deliberately left alone in partition.mjs: there it only feeds
 * `globsOverlap`, where a too-short base over-detects overlap and therefore fails
 * SAFE (it forces the serial path). Membership needs the opposite — real
 * segment-wise matching — so the two diverge on purpose.
 */

/** Regex metacharacters that must be escaped in a glob segment. `*` is excluded:
 *  it is the one character we translate rather than escape. Real paths routinely
 *  contain literal parens (Next.js `(authed)`, Expo `(tabs)`), so this is
 *  load-bearing, not decorative. */
const RX_META = /[.+?^${}()|[\]\\]/g

/** Does one path segment match one glob segment (`*` = any run of non-`/`)? */
function segmentMatches(segment, pattern) {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return segment === pattern
  const source = "^" + pattern.replace(RX_META, "\\$&").replace(/\*/g, "[^/]*") + "$"
  return new RegExp(source).test(segment)
}

/** Segment-wise glob match supporting `**` (zero or more segments, anywhere in
 *  the pattern) and `*` (within a single segment). */
function matchFrom(pathSegments, i, globSegments, j) {
  while (j < globSegments.length) {
    const pattern = globSegments[j]
    if (pattern === "**") {
      // A trailing `**` absorbs everything left, including nothing at all.
      if (j === globSegments.length - 1) return true
      // Otherwise try every split point, shortest first.
      for (let k = i; k <= pathSegments.length; k++) {
        if (matchFrom(pathSegments, k, globSegments, j + 1)) return true
      }
      return false
    }
    if (i >= pathSegments.length) return false
    if (!segmentMatches(pathSegments[i], pattern)) return false
    i++
    j++
  }
  return i === pathSegments.length
}

const segmentsOf = (s) => String(s).split("/").filter((seg) => seg.length > 0)

/**
 * Is a single path within any of the allowed globs?
 *  - A glob containing a wildcard is matched segment-wise (`**` spans segments).
 *  - A `dir/**` glob also matches `dir` itself.
 *  - A wildcard-free glob keeps the prefix rule (`p === g`, or under `g + "/"`),
 *    so a bare directory grant and a specific-file grant both behave as written.
 */
export function pathWithinGlobs(p, allowedGlobs) {
  if (typeof p !== "string" || p.length === 0)
    throw new TypeError("path must be a non-empty string")
  const pathSegments = segmentsOf(p)
  for (const glob of allowedGlobs) {
    const g = String(glob)
    if (!g.includes("*")) {
      if (p === g || p.startsWith(g + "/")) return true
      continue
    }
    if (matchFrom(pathSegments, 0, segmentsOf(g), 0)) return true
    // `dir/**` has always also granted `dir` itself.
    if (p === g.replace(/\/\*\*$/, "")) return true
  }
  return false
}

/**
 * Return the changed paths that fall OUTSIDE the allowed globs. An empty array
 * means the worker stayed in bounds.
 * @param {string[]} changedPaths  the worker's edited files (repo-relative)
 * @param {string[]} allowedGlobs  the area's pathGlobs
 * @returns {string[]} the stray paths (sorted, deduped)
 */
export function boundaryViolations(changedPaths, allowedGlobs) {
  if (!Array.isArray(changedPaths)) throw new TypeError("changedPaths must be an array")
  if (!Array.isArray(allowedGlobs)) throw new TypeError("allowedGlobs must be an array")
  if (allowedGlobs.length === 0) {
    // No ownership declared → every edit is out of bounds (conservative).
    return [...new Set(changedPaths)].sort()
  }
  const stray = changedPaths.filter((p) => !pathWithinGlobs(p, allowedGlobs))
  return [...new Set(stray)].sort()
}

export default boundaryViolations
