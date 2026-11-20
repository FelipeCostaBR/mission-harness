/**
 * boundary.mjs — the missions-harness out-of-module boundary rule (B5).
 *
 * A worker may edit ONLY files inside its module's `pathGlobs`. The
 * `module-validator` reports any stray path as a hard-blocking
 * `boundaryViolations[]`. This is the tested path-membership half of that check
 * (the import half belongs to the project's own architecture tests, run by the
 * integration gate). Single
 * source of truth; `node --test`-guarded by `boundary.test.mjs`.
 *
 * Pure: no I/O.
 *
 * ⚠️ WHY THIS NO LONGER USES `globBase` FROM partition.mjs (fixed 2026-08-14).
 * It used to derive a glob's literal prefix with `globBase` and test
 * `p === base || p.startsWith(base + "/")`. That is correct for a trailing-`**`
 * glob but WRONG for a glob whose `**` sits mid-pattern: `globBase` leaves the
 * wildcard in place, so `apps/mobile/**\/__tests__/**` produced the base
 * `apps/mobile/**\/__tests__`, which no real path can ever start with — and every
 * legitimate test file was reported as a violation. That mattered because
 * `boundaryViolations` is a HARD BLOCKER at validation and `routeEscalation`
 * GENERATES exactly that glob shape for every escalation, so a clean milestone
 * could be halted by a false positive.
 *
 * partition.mjs keeps `globBase` for `globsOverlap` only, where it now cuts at
 * the FIRST wildcard segment: a too-short base over-detects overlap and so fails
 * SAFE (it forces the serial path). Membership needs the opposite — real
 * segment-wise matching — so the two diverge on purpose.
 */

/** Regex metacharacters that must be escaped in a glob segment. `*` is excluded:
 *  it is the one character we translate rather than escape. Note real paths here
 *  contain literal parens (`(authed)`, `(tabs)`, `(site)`), so escaping is load-bearing. */
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
 * A changed path as the grant sees it: repo-relative. A worker (a lane worker
 * above all) may record `./`-prefixed or absolute lane paths; compared raw,
 * every one of those reads as a hard-blocking violation. A leading `./` is
 * stripped, and so is `root` (the mission or lane worktree's absolute root)
 * when one is given. Anything else is left alone, so an absolute path under
 * some OTHER root still falls outside every repo-relative glob.
 * @param {string} p
 * @param {string} [root]
 */
export function normalizeChangedPath(p, root) {
  let s = String(p)
  if (typeof root === "string" && root.length > 0) {
    const prefix = root.endsWith("/") ? root : `${root}/`
    if (s.startsWith(prefix)) s = s.slice(prefix.length)
  }
  while (s.startsWith("./")) s = s.slice(2)
  return s
}

/** Is a single path within any of the allowed globs?
 *  - The path is normalised first (`normalizeChangedPath`): a leading `./` is
 *    stripped, and `root` too when given.
 *  - A glob containing a wildcard is matched segment-wise (`**` spans segments).
 *  - A `dir/**` glob also matches `dir` itself, as it always has.
 *  - A wildcard-free glob keeps the original prefix rule (`p === g`, or under
 *    `g + "/"`), so a bare directory grant and a specific-file grant are both
 *    unchanged. */
export function pathWithinGlobs(rawPath, allowedGlobs, root) {
  if (typeof rawPath !== "string" || rawPath.length === 0) throw new TypeError("path must be a non-empty string")
  const p = normalizeChangedPath(rawPath, root)
  if (p.length === 0) throw new TypeError(`path ${JSON.stringify(rawPath)} is empty once normalised`)
  const pathSegments = segmentsOf(p)
  for (const glob of allowedGlobs) {
    const g = normalizeChangedPath(glob)
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
 * Return the changed paths that fall OUTSIDE the allowed globs (the boundary
 * violations). Empty array means the worker stayed in bounds.
 * @param {string[]} changedPaths  the worker's edited files
 * @param {string[]} allowedGlobs  the module's pathGlobs
 * @param {{root?: string}} [options]  root: the mission or lane worktree's
 *        absolute root, stripped from an absolute changed path before matching
 * @returns {string[]} the stray paths, normalised to repo-relative (sorted, deduped)
 */
export function boundaryViolations(changedPaths, allowedGlobs, options = {}) {
  if (!Array.isArray(changedPaths)) throw new TypeError("changedPaths must be an array")
  if (!Array.isArray(allowedGlobs)) throw new TypeError("allowedGlobs must be an array")
  const root = options && typeof options.root === "string" ? options.root : undefined
  const paths = changedPaths.map((p) => (typeof p === "string" ? normalizeChangedPath(p, root) : p))
  if (allowedGlobs.length === 0) {
    // No ownership declared → every edit is out of bounds (conservative).
    return [...new Set(paths)].sort()
  }
  const stray = paths.filter((p) => !pathWithinGlobs(p, allowedGlobs))
  return [...new Set(stray)].sort()
}

export default boundaryViolations
