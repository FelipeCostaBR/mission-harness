/**
 * escalation-route.mjs — the escalation delegation rule.
 *
 * An escalation is any change a path-scoped worker is NOT allowed to make: a
 * shared kernel, a database schema, a cross-area contract, a generated registry.
 * Those changes have to happen somewhere, and the obvious place — the
 * orchestrator does it inline — is the single worst seat for the job:
 *
 *   1. It collapses the creator/verifier split. The orchestrator both MAKES and
 *      VERIFIES the change, with no adversarial seat in between. Escalations
 *      touch the highest-blast-radius files in the repo, so this is exactly
 *      backwards.
 *   2. It is the orchestrator's largest reducible context sink. Across real
 *      long-running missions, inline escalation work was the biggest avoidable
 *      draw on the orchestrator's window — the window every later milestone
 *      depends on.
 *
 * So every escalation is SIZE-GATED here:
 *   - trivial      → route "inline". One additive entry in one file (an enum
 *                    value, an env var, a registry row), or a declared additive
 *                    pair (a schema file + its generated migration). Spawning a
 *                    worker for one enum value costs more than it saves.
 *   - substantial  → route "delegate". Anything multi-file, anything with a
 *                    logic change, anything touching a path the config marks
 *                    `alwaysDelegate`. A dedicated worker edits within the tight
 *                    globs this rule computes, and a FRESH validator reviews it.
 *
 * `additiveOnly` is declared by the orchestrator and defaults to FALSE, because
 * the failure mode of wrongly-inline (creator/verifier collapse on real logic) is
 * much worse than wrongly-delegated (a slightly over-provisioned worker).
 *
 * Pure: no I/O. All project-specific knowledge arrives via `config`.
 *
 * @typedef {Object} ProtectedPath
 * @property {string}  glob            path or glob that a worker may never edit
 * @property {string}  [reason]        human-readable why, surfaced in `reasons[]`
 * @property {boolean} [alwaysDelegate] never inline, regardless of size
 * @property {string[]} [companionGlobs] extra globs the delegate grant should include
 *                     (e.g. a migrations dir that must be written alongside a schema file)
 *
 * @typedef {Object} EscalationRoute
 * @property {"inline"|"delegate"} route
 * @property {string[]} reasons            why this route (deterministic, auditable)
 * @property {string[]} workerPathGlobs    delegate only: the edit scope for the
 *           escalation worker — the declared files exactly, their directories
 *           (so a colocated new sibling file is allowed), the configured test
 *           globs, and any companion globs. Tight by construction: never a
 *           blanket grant over the whole shared kernel.
 * @property {boolean} validationRequired  delegate → true: a fresh read-only
 *           validator MUST review the escalation handoff at the boundary.
 */

import { pathWithinGlobs } from "./boundary.mjs"

const norm = (p) => String(p).replace(/^\.\//, "")
const dirOf = (p) => {
  const i = p.lastIndexOf("/")
  return i === -1 ? "" : p.slice(0, i)
}

/**
 * @param {Object} escalation
 * @param {string[]} escalation.files  repo-relative files the escalation must touch
 * @param {boolean} [escalation.additiveOnly=false]  true ONLY when every edit adds
 *        an entry to an existing enum/registry/list without changing any logic.
 *        When unsure, leave it false — the conservative route is delegation.
 * @param {Object} [config]
 * @param {ProtectedPath[]} [config.protectedPaths]  from mission.config.json
 * @param {string[]} [config.testGlobs]  where tests live, granted to every delegate
 * @param {Array<{primary:string, generated:string}>} [config.additivePairs]
 *        declared two-file shapes that count as ONE trivial additive change
 *        (classically: an ORM schema file plus the migration it generates).
 * @returns {EscalationRoute}
 */
export function routeEscalation(escalation, config = {}) {
  if (!escalation || typeof escalation !== "object")
    throw new TypeError("escalation must be an object")
  if (!Array.isArray(escalation.files) || escalation.files.length === 0)
    throw new TypeError("escalation.files must be a non-empty array of repo-relative paths")

  const files = [...new Set(escalation.files.map(norm))]
  const additiveOnly = escalation.additiveOnly === true
  const protectedPaths = Array.isArray(config.protectedPaths) ? config.protectedPaths : []
  const testGlobs = Array.isArray(config.testGlobs) ? config.testGlobs : []
  const additivePairs = Array.isArray(config.additivePairs) ? config.additivePairs : []
  const reasons = []

  // 1. Hard "never inline" paths, declared by the project. These are the files
  //    whose blast radius is wide enough that a fresh adversarial validator is
  //    worth a full worker spawn every single time.
  const mustDelegate = protectedPaths.filter(
    (pp) => pp && pp.alwaysDelegate === true && files.some((f) => pathWithinGlobs(f, [pp.glob])),
  )
  for (const pp of mustDelegate) {
    const hit = files.filter((f) => pathWithinGlobs(f, [pp.glob]))
    reasons.push(
      `touches ${pp.glob}${pp.reason ? ` (${pp.reason})` : ""} — always delegated: ${hit.join(", ")}`,
    )
  }

  // 2. The one legal multi-file "trivial" shape: a declared additive pair, e.g.
  //    a schema file plus the migration generated from it. They are inherently
  //    one change and splitting them across seats invites drift.
  const isAdditivePair =
    additiveOnly &&
    files.length === 2 &&
    additivePairs.some(
      (pair) =>
        pair &&
        files.some((f) => pathWithinGlobs(f, [pair.primary])) &&
        files.some((f) => pathWithinGlobs(f, [pair.generated])),
    )

  if (!mustDelegate.length && files.length > 1 && !isAdditivePair)
    reasons.push(`multi-file escalation (${files.length} files)`)
  if (!mustDelegate.length && files.length === 1 && !additiveOnly)
    reasons.push("single-file but not declared additive-only (logic change)")

  if (reasons.length === 0) {
    return {
      route: "inline",
      reasons: [
        isAdditivePair
          ? "additive-only declared pair (one entry plus its generated companion)"
          : "single-file additive-only entry",
      ],
      workerPathGlobs: [],
      validationRequired: false,
    }
  }

  // Delegate scope: the exact files, their directories (so a colocated test or a
  // new sibling file is allowed), the project's test globs, and any companion
  // globs the protected-path entry declares. Tight by construction.
  const globs = new Set()
  for (const f of files) {
    globs.add(f)
    const d = dirOf(f)
    if (d) globs.add(`${d}/**`)
  }
  for (const g of testGlobs) globs.add(g)
  for (const pp of protectedPaths) {
    if (!pp || !Array.isArray(pp.companionGlobs)) continue
    if (!files.some((f) => pathWithinGlobs(f, [pp.glob]))) continue
    for (const g of pp.companionGlobs) globs.add(g)
  }

  return {
    route: "delegate",
    reasons,
    workerPathGlobs: [...globs],
    validationRequired: true,
  }
}

export default routeEscalation
