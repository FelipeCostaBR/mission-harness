/**
 * partition.mjs — the disjoint-area parallelism rule.
 *
 * Decides which of a milestone's features may run as PARALLEL isolated workers
 * (each in its own git worktree) and which must run SERIALLY in the main tree.
 *
 * This is the policy layer on top of whatever concurrency your runtime offers.
 * It is deliberately CONSERVATIVE: when area ownership is unknown or two areas'
 * globs overlap, the features are serialized. The worst case is therefore the
 * proven-correct serial path, never a corrupted tree.
 *
 * Pure: no I/O, no Date.now, no randomness.
 *
 * @typedef {Object} Feature
 * @property {string}  id              stable feature id (drives deterministic order)
 * @property {string}  area            the routing slug the feature edits
 * @property {boolean} [isEscalation]  true for shared / cross-area work (ALWAYS serial)
 */

/** Strip glob wildcards to a concrete base path: "a/b/**" -> "a/b". */
export function globBase(glob) {
  return String(glob)
    .replace(/\/\*\*?$/, "")
    .replace(/\/[^/]*\*[^/]*$/, "")
}

/** True if one path is a path-segment prefix of the other (or equal). */
export function pathPrefixOverlap(a, b) {
  if (a === b) return true
  const as = a.split("/")
  const bs = b.split("/")
  const n = Math.min(as.length, bs.length)
  for (let i = 0; i < n; i++) {
    if (as[i] !== bs[i]) return false
  }
  return true // one is a strict path-prefix of the other
}

/** True if any glob in A overlaps any glob in B (by base-path prefix). */
export function globsOverlap(globsA, globsB) {
  for (const ga of globsA) {
    for (const gb of globsB) {
      if (pathPrefixOverlap(globBase(ga), globBase(gb))) return true
    }
  }
  return false
}

/**
 * Do two features conflict (i.e. MUST NOT run in parallel)?
 * Same area → conflict. Different areas → conflict iff their globs overlap.
 * Unknown/empty globs → conflict (conservative).
 */
export function featuresConflict(a, b, pathGlobsByArea) {
  if (a.area === b.area) return true
  const ga = pathGlobsByArea[a.area] ?? []
  const gb = pathGlobsByArea[b.area] ?? []
  if (ga.length === 0 || gb.length === 0) return true // unknown ownership → serialize
  return globsOverlap(ga, gb)
}

/**
 * Partition a milestone's features into parallel batches + a serial remainder.
 * @param {Feature[]} features
 * @param {Record<string,string[]>} [pathGlobsByArea]  area slug -> its pathGlobs
 * @returns {{ parallelBatches: Feature[][], serial: Feature[] }}
 *   Each `parallelBatches[i]` is a set of mutually-disjoint features safe to run
 *   concurrently in worktrees; batches themselves run one after another.
 *   `serial` runs in the main tree.
 */
export function partitionDisjoint(features, pathGlobsByArea = {}) {
  if (!Array.isArray(features)) throw new TypeError("features must be an array")

  // Deterministic order, so the same input always yields the same batches.
  const sorted = [...features].sort(byId)

  const serial = []
  const candidates = []
  for (const f of sorted) {
    if (!f || typeof f.id !== "string") throw new TypeError("each feature needs a string id")
    if (typeof f.area !== "string" || f.area.length === 0)
      throw new TypeError(`feature ${f.id} needs a non-empty area`)
    if (f.isEscalation) serial.push(f) // escalations are always serial
    else candidates.push(f)
  }

  // Greedy independent-set batching: place each feature in the first existing
  // batch it conflicts with NONE of; otherwise open a new batch.
  const batches = []
  for (const f of candidates) {
    let placed = false
    for (const batch of batches) {
      if (batch.every((g) => !featuresConflict(f, g, pathGlobsByArea))) {
        batch.push(f)
        placed = true
        break
      }
    }
    if (!placed) batches.push([f])
  }

  // A batch of one has nothing to parallelise — run it in the main tree, with no
  // worktree setup cost.
  const parallelBatches = []
  for (const batch of batches) {
    if (batch.length >= 2) parallelBatches.push(batch)
    else serial.push(batch[0])
  }
  serial.sort(byId)

  return { parallelBatches, serial }
}

function byId(a, b) {
  return String(a.id).localeCompare(String(b.id))
}

export default partitionDisjoint
