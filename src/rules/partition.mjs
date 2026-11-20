/**
 * partition.mjs — the missions-harness disjoint-module partition rule (the
 * partition-driven serial/parallel toggle).
 *
 * Decides which of a milestone's features may run as PARALLEL lane-isolated
 * workers and which must run SERIALLY in-tree. This is the policy layer on top
 * of the Workflow substrate's `parallel()`; the lane isolation itself is
 * orchestrator-provisioned per batch member via
 * `git worktree add --detach <sibling dir> <mission tip>` (mission-run step 2),
 * NEVER Workflow's `isolation:"worktree"`, which forks main instead of the
 * mission tip. Each lane worker's first act is the worktree-preamble base check
 * (lib/worktree-preamble.mjs); a batch with any lane that cannot prove its base
 * is not merged back, clean lanes are cherry-picked in feature-id order, and
 * the integration gate is the net.
 *
 * Pure: no I/O, no Date.now, no randomness. Conservative by default — when module
 * ownership is unknown or globs overlap, features are serialized (conservative
 * partition). Tested by
 * `partition.test.mjs` (`node --test`); mirrors the `self-heal.mjs` pattern.
 *
 * @typedef {Object} Feature
 * @property {string}   id              stable feature id (drives deterministic order)
 * @property {string}   module          the routing slug the feature edits (an
 *   agent-routing.json `modules` key)
 * @property {boolean}  [isEscalation]  true for sharedKernel/Prisma/cross-module work
 *   (escalations always serial, and ordered first in `serial`)
 * @property {string[]} [pathGlobs]     the feature's own declared edit scope, as
 *   mission-plan records it in mission-state `features{}`. It is ADDED to the
 *   module's routing globs for the overlap check (never replaces them), so a
 *   feature that also touches, say, an e2e spec or a `__tests__` dir outside
 *   its module conflicts with a sibling that touches the same path.
 */

/** The literal directory prefix of a glob: every segment before the FIRST one
 *  holding a wildcard ("a/b/**" -> "a/b", "a/**\/__tests__/**" -> "a",
 *  "a/**\/*.test.ts" -> "a"). Cutting at the first wildcard segment, not only a
 *  trailing one, keeps the base no longer than any path the glob can match, so
 *  `globsOverlap` over-detects (serializes) rather than missing a real overlap. */
export function globBase(glob) {
  const parts = String(glob).split("/")
  const i = parts.findIndex((s) => /[*?]/.test(s))
  return (i === -1 ? parts : parts.slice(0, i)).join("/")
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
 * The globs a feature may edit: its module's routing globs plus its own
 * declared `pathGlobs`. Null when the module has no routing globs — unknown
 * ownership, which `featuresConflict` serializes (conservative partition) whatever the feature
 * declares itself.
 */
function featureGlobs(f, pathGlobsBySlug) {
  const moduleGlobs = Object.hasOwn(pathGlobsBySlug, f.module) ? pathGlobsBySlug[f.module] : undefined
  if (!Array.isArray(moduleGlobs) || moduleGlobs.length === 0) return null
  return Array.isArray(f.pathGlobs) ? [...moduleGlobs, ...f.pathGlobs] : moduleGlobs
}

/**
 * Do two features conflict (i.e. MUST NOT run in parallel)?
 * Same module → conflict. Different modules → conflict iff their globs (module
 * routing globs + each feature's own pathGlobs) overlap.
 * Unknown/empty module globs → conflict (conservative partition).
 */
export function featuresConflict(a, b, pathGlobsBySlug) {
  if (a.module === b.module) return true
  const ga = featureGlobs(a, pathGlobsBySlug)
  const gb = featureGlobs(b, pathGlobsBySlug)
  if (!ga || !gb) return true // unknown ownership → serialize
  return globsOverlap(ga, gb)
}

function isStringArray(x) {
  return Array.isArray(x) && x.every((s) => typeof s === "string")
}

/**
 * Build `pathGlobsBySlug` from an `agent-routing.json`-shaped registry (the
 * format the pre-package harness copies used; `contractor migrate` reads it) —
 * `{ modules: { <slug>: { surface, pathGlobs, retired? } }, sharedKernel: … }`,
 * an object keyed by slug. `$`-prefixed keys (`$comment`) are skipped, and so
 * are `retired: true` modules: a feature naming one is
 * unknown ownership and runs serially. sharedKernel paths are orchestrator-owned
 * escalations, which partitionDisjoint serializes via `isEscalation`, so they
 * are not included.
 * @param {{modules: Record<string, {pathGlobs: string[], retired?: boolean}>}} routing
 * @returns {Record<string, string[]>}
 */
export function pathGlobsFromRouting(routing) {
  const modules = routing?.modules
  if (!modules || typeof modules !== "object" || Array.isArray(modules))
    throw new TypeError("routing.modules must be an object keyed by module slug (the parsed agent-routing.json)")
  const out = {}
  for (const [slug, entry] of Object.entries(modules)) {
    if (slug.startsWith("$")) continue
    if (!entry || typeof entry !== "object" || !isStringArray(entry.pathGlobs))
      throw new TypeError(`agent-routing.json modules.${slug}.pathGlobs must be an array of strings`)
    if (entry.retired === true) continue
    out[slug] = [...entry.pathGlobs]
  }
  return out
}

/**
 * Partition a milestone's features into parallel batches + a serial remainder.
 * @param {Feature[]} features
 * @param {Record<string,string[]>} [pathGlobsBySlug]  slug -> its pathGlobs
 *   (build it with `pathGlobsFromRouting(agentRouting)`; passing the raw
 *   agent-routing.json object throws rather than silently serializing everything)
 * @returns {{ parallelBatches: Feature[][], serial: Feature[] }}
 *   Each `parallelBatches[i]` is a set of mutually-disjoint features safe to run
 *   concurrently in lane worktrees; batches run sequentially. `serial` runs
 *   in-tree: escalations first (sorted by id), then the rest by id.
 */
export function partitionDisjoint(features, pathGlobsBySlug = {}) {
  if (!Array.isArray(features)) throw new TypeError("features must be an array")
  if (!pathGlobsBySlug || typeof pathGlobsBySlug !== "object" || Array.isArray(pathGlobsBySlug))
    throw new TypeError("pathGlobsBySlug must be an object of slug -> string[]")
  for (const [slug, globs] of Object.entries(pathGlobsBySlug)) {
    if (!isStringArray(globs))
      throw new TypeError(
        `pathGlobsBySlug.${slug} must be an array of strings (pass pathGlobsFromRouting(routing), not the raw agent-routing.json)`,
      )
  }
  for (const f of features) {
    if (!f || typeof f !== "object" || typeof f.id !== "string") throw new TypeError("each feature needs a string id")
    if (typeof f.module !== "string" || f.module.length === 0)
      throw new TypeError(`feature ${f.id} needs a non-empty module`)
    if (f.pathGlobs !== undefined && !isStringArray(f.pathGlobs))
      throw new TypeError(`feature ${f.id} pathGlobs must be an array of strings`)
  }

  // Deterministic order (so the same input always yields the same batches).
  const sorted = [...features].sort(byId)

  const serial = []
  const candidates = []
  for (const f of sorted) {
    if (f.isEscalation) serial.push(f) // escalations are always serial
    else candidates.push(f)
  }

  // Greedy independent-set batching: place each feature in the first existing
  // batch it conflicts with NONE of; otherwise open a new batch.
  const batches = []
  for (const f of candidates) {
    let placed = false
    for (const batch of batches) {
      if (batch.every((g) => !featuresConflict(f, g, pathGlobsBySlug))) {
        batch.push(f)
        placed = true
        break
      }
    }
    if (!placed) batches.push([f])
  }

  // A batch of one has nothing to parallelise — run it in-tree (no worktree
  // overhead, R1). Only batches of >= 2 become real parallel batches.
  const parallelBatches = []
  for (const batch of batches) {
    if (batch.length >= 2) parallelBatches.push(batch)
    else serial.push(batch[0])
  }
  serial.sort(bySerialOrder)

  return { parallelBatches, serial }
}

function byId(a, b) {
  return String(a.id).localeCompare(String(b.id))
}

/** Escalations land the shared change their siblings build on, so they sort first, then by id. */
function bySerialOrder(a, b) {
  const pa = a.isEscalation ? 0 : 1
  const pb = b.isEscalation ? 0 : 1
  return pa !== pb ? pa - pb : byId(a, b)
}

export default partitionDisjoint
