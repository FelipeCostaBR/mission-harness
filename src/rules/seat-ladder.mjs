/**
 * seat-ladder.mjs exposes the model-and-effort ladder, each role's start,
 * ceiling and climb triggers, the two session seats, and `resolveSeat`, the
 * pure rule that turns a role, the rung its last attempt ran on and why that
 * attempt failed into the seat the next attempt runs on. The data lives in
 * seat-ladder.json so a jest architecture test can read it with fs and
 * JSON.parse; `resolveSeat` and its CLI read the same table.
 *
 * The role values are today's effective seats (owner ruling 2026-10-14). The
 * cheaper starts the PRD proposes live in the `cheap` profile, which a mission
 * opts into with a top-level `seatProfile` in its mission-state.json; the
 * `current` profile has no overrides.
 *
 * The CLI (`resolve`, `corrective-seat`) is how the orchestrator, which cannot
 * import this module from the Agent-tool route, asks the rule for a seat. It
 * reads mission-state.json and writes nothing.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { exitWith, isMainModule, parseFlags } from "./cli-boot.mjs"

// Resolved from this file, not process.cwd(): the harness runs from the repo
// root, sub-packages and worktrees, and each would miss a cwd path. A project
// overrides the whole table with `seatLadder` in mission.config.json.
export const DEFAULT_SEAT_TABLE = JSON.parse(readFileSync(new URL("./seat-ladder.default.json", import.meta.url), "utf8"))
const TABLE = DEFAULT_SEAT_TABLE

/** Rungs in climbing order, weakest first. */
export const LADDER = TABLE.ladder

/**
 * Per role: `start`, `ceiling` (rung ids), `climbOn` triggers, optional `model`
 * overriding the rung's model string; the worker also carries `sizeStart`, its
 * start rung per milestone size tier.
 */
export const ROLE_SEATS = TABLE.roles

/** Seats fixed for a whole session: `planner` and `orchestrator`, the latter with a `trial` seat. */
export const SESSION_SEATS = TABLE.sessionSeats

/**
 * Start-rung overrides per profile name. A role's entry is `{ start }`, and the
 * worker's is `{ sizeStart: { small, normal, large } }`, a full replacement of
 * its per-tier starts. `current` is empty, so it is the role table as written.
 */
export const SEAT_PROFILES = TABLE.profiles

/** The profile names a mission-state `seatProfile` can hold. */
export const PROFILE_NAMES = Object.freeze(Object.keys(TABLE.profiles))

/** The size tiers a milestone can carry (lib/plan-size.mjs assigns them). */
const SIZE_TIERS = ["small", "normal", "large"]

/**
 * `infra` and `spec` are decided before any climb, so no role lists them in
 * `climbOn`; they are valid triggers all the same.
 */
const NON_CLIMBING_TRIGGERS = ["infra", "spec"]

const triggersOf = (table) => [
  ...new Set([...Object.values(table.roles).flatMap((seat) => seat.climbOn), ...NON_CLIMBING_TRIGGERS]),
]

/** Every trigger `resolveSeat` accepts for the loaded table: all climbOn triggers plus `infra` and `spec`. */
export const TRIGGERS = triggersOf(TABLE)

/** Roles with an unknown name must throw, and `"constructor"` is a property of every object. */
const roleSeat = (table, role) => {
  if (typeof role !== "string" || !Object.hasOwn(table.roles, role)) {
    throw new TypeError(`unknown role ${JSON.stringify(role)}`)
  }
  return table.roles[role]
}

/**
 * The override `flags.seatProfile` holds for `role`, or undefined. An absent or
 * null `flags` or `seatProfile` is no profile, and every other value must be an
 * own key of `table.profiles`: `"constructor"` is a property of every object,
 * and a misspelt name that silently ran the current seats would void a trial.
 * A misspelt KEY (`seatprofile`) would do the same, so `seatProfile` is the
 * only own key `flags` may hold.
 */
const profileOverride = (table, role, flags) => {
  if (flags === undefined || flags === null) return undefined
  if (typeof flags !== "object" || Array.isArray(flags)) {
    throw new TypeError(`flags must be an object, got ${JSON.stringify(flags)}`)
  }
  const stray = Object.keys(flags).filter((key) => key !== "seatProfile")
  if (stray.length > 0) {
    throw new TypeError(`unknown flags key ${JSON.stringify(stray[0])}: the only flag is seatProfile`)
  }
  const name = Object.hasOwn(flags, "seatProfile") ? flags.seatProfile : undefined
  if (name === undefined || name === null) return undefined
  const profiles = table.profiles ?? {}
  if (typeof name !== "string" || !Object.hasOwn(profiles, name)) {
    throw new TypeError(`unknown seatProfile ${JSON.stringify(name)}`)
  }
  return Object.hasOwn(profiles[name], role) ? { name, ...profiles[name][role] } : undefined
}

/**
 * The seat the next attempt of `role` runs on.
 *
 * With `previousRung` null, undefined or absent the result is the role's start
 * rung (the worker's is `sizeStart[sizeTier]`, a missing `sizeTier` read as
 * `normal`) and `trigger` is ignored. Otherwise `trigger` names why the attempt
 * on `previousRung` failed, and the first rule that applies wins, in this
 * order: `infra` keeps the rung; `spec` keeps it and routes to the contract; a
 * trigger outside the role's `climbOn` keeps the rung, so neither of the next
 * two rules is considered for it; a scout at or above its ceiling hands over to
 * the reviewer, carrying its ceiling seat; `gate-repeat` climbs one rung; any
 * other trigger climbs one rung, two when `sameCheckFailedBefore` is true.
 * Nothing climbs above the role's ceiling.
 *
 * `flags.seatProfile` names a profile in `table.profiles`, and its override for
 * `role` replaces the start rung only: a call with a `previousRung` climbs from
 * that rung as it would without the flag, though the name is checked on every
 * call. An absent `flags`, `{}` and `{"seatProfile":"current"}` return identical
 * seats, reason included.
 *
 * @returns {{model: string, effort: string, rung: string, climbed: boolean,
 *   atCeiling: boolean, route: "contract" | "reviewer" | null, reason: string}}
 * @throws {TypeError} on an unknown role, rung, sizeTier, trigger or
 *   seatProfile, a `flags` that is not an object or holds an own key other
 *   than `seatProfile`, a `seatProfile` at the top level of `input`, a missing trigger when
 *   `previousRung` is given, or a `sameCheckFailedBefore` that is present and
 *   not a boolean.
 */
export function resolveSeat(input, table = TABLE) {
  if (input === null || typeof input !== "object") throw new TypeError("resolveSeat needs an input object")
  // Read nowhere at the top level, so a profile placed there would run the current seats unannounced.
  if (Object.hasOwn(input, "seatProfile")) {
    throw new TypeError("seatProfile belongs inside flags, as {\"flags\":{\"seatProfile\":...}}, not at the top level")
  }
  const { role, previousRung, trigger, sameCheckFailedBefore: repeated, sizeTier, flags } = input
  const seat = roleSeat(table, role)
  const override = profileOverride(table, role, flags)
  // A string "true" from a hand-written CLI argument would otherwise climb one rung where two were meant.
  if (repeated !== undefined && typeof repeated !== "boolean") {
    throw new TypeError(`sameCheckFailedBefore must be a boolean, got ${JSON.stringify(repeated)}`)
  }
  const rank = new Map(table.ladder.map((rung, i) => [rung.id, i]))
  const rungAt = (i) => table.ladder[i]
  const rankOf = (id, what) => {
    if (!rank.has(id)) throw new TypeError(`unknown ${what} ${JSON.stringify(id)}`)
    return rank.get(id)
  }
  if (sizeTier != null && !SIZE_TIERS.includes(sizeTier)) {
    throw new TypeError(`unknown sizeTier ${JSON.stringify(sizeTier)}`)
  }
  const ceiling = rankOf(seat.ceiling, "ceiling")
  const finish = (index, previous, route, reason) => {
    const at = Math.min(index, ceiling)
    const rung = rungAt(at)
    return {
      model: seat.model ?? rung.model,
      effort: rung.effort,
      rung: rung.id,
      climbed: previous !== null && at > previous,
      atCeiling: at === ceiling,
      route,
      reason,
    }
  }

  if (previousRung == null) {
    const tier = sizeTier ?? "normal"
    const start = override?.sizeStart?.[tier] ?? override?.start ?? seat.sizeStart?.[tier] ?? seat.start
    const via = override ? ` (profile ${override.name})` : ""
    return finish(rankOf(start, "start"), null, null, `${role} starts at ${start}${via}`)
  }

  const previous = rankOf(previousRung, "rung")
  const triggers = triggersOf(table)
  if (typeof trigger !== "string" || !triggers.includes(trigger)) {
    throw new TypeError(`trigger ${JSON.stringify(trigger)} is not one of ${triggers.join(", ")}`)
  }
  const keep = Math.min(previous, ceiling)
  const climbsOn = seat.climbOn.includes(trigger)

  if (trigger === "infra") return finish(keep, previous, null, `infra failure: ${role} stays at ${rungAt(keep).id}`)
  if (trigger === "spec") return finish(keep, previous, "contract", `spec failure: the contract is wrong, not the ${role} seat`)
  if (!climbsOn) return finish(keep, previous, null, `${role} does not climb on ${trigger}`)
  if (role === "scout" && previous >= ceiling) {
    return finish(ceiling, previous, "reviewer", `scout at ${rungAt(previous).id}, at or above its ceiling ${seat.ceiling}, on ${trigger}: the reviewer takes over`)
  }
  const step = trigger !== "gate-repeat" && repeated === true ? 2 : 1
  const target = Math.min(previous + step, ceiling)
  const again = step === 2 ? " (the same check failed in the previous corrective round)" : ""
  return finish(
    target,
    previous,
    null,
    `${trigger} failure${again}: ${role} moves ${rungAt(previous).id} to ${rungAt(target).id}`,
  )
}

/**
 * The ladder rung a `<model>/<effort>` seat string names, else null. Archived
 * roundLog entries hold other shapes ('orchestrator', 'base', 'opus
 * (module-worker)', a bare tier), so no string throws. An opus rung's model is
 * also read as `opus[1m]`, the reviewer's override.
 */
export function rungOfSeat(seat, table = TABLE) {
  if (typeof seat !== "string") return null
  const parts = seat.split("/")
  if (parts.length !== 2) return null
  const [model, effort] = parts
  // A context-window suffix (`opus[1m]`) names the same tier as its bare model.
  const bare = model.replace(/\[[^\]]*\]$/, "")
  const rung = table.ladder.find((r) => r.effort === effort && (r.model === model || r.model === bare))
  return rung ? rung.id : null
}

/**
 * True when the milestone's newest `type: corrective` roundLog entry shares a
 * trigger id with `triggerIds`. Read it before bump-round appends the round
 * being decided, or that round is compared with itself.
 */
export function sameCheckFailedBefore(roundLog, milestone, triggerIds) {
  const newest = newestCorrective(roundLog, milestone)
  if (!newest || !Array.isArray(newest.trigger) || !Array.isArray(triggerIds)) return false
  return newest.trigger.some((id) => triggerIds.includes(id))
}

/** The milestone's corrective entry with the highest round; the later entry wins a tie. */
function newestCorrective(roundLog, milestone) {
  if (!Array.isArray(roundLog)) return null
  let newest = null
  for (const entry of roundLog) {
    if (!entry || entry.milestone !== milestone || entry.type !== "corrective") continue
    if (newest === null || (entry.round ?? 0) >= (newest.round ?? 0)) newest = entry
  }
  return newest
}

const USAGE =
  "usage: seat-ladder.mjs resolve '<json>'\n" +
  "       seat-ladder.mjs corrective-seat <prd-dir> <milestone> --cause <assertion|gate|spec> --triggers '<json ids>' [--size-tier <tier>]\n"

/**
 * Why a corrective round ran: the values `corrective-seat --cause` and
 * mission-state-cli.mjs `bump-round --cause` accept, the latter through
 * bookkeeping.mjs's `ROUND_LOG_CAUSES`, which is this array. `infra` is not
 * one: an infrastructure failure is re-run without a round.
 */
export const CORRECTIVE_CAUSES = Object.freeze(["assertion", "gate", "spec"])

class UsageError extends Error {}

function parseJson(text, what) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`${what} is not valid JSON: ${error.message}`)
  }
}

/**
 * The worker seat for the next corrective round of `milestone`, read from a
 * mission-state object: the start rung for the mission's seatProfile and
 * `sizeTier`, climbed from the seat the newest corrective round ran on.
 * Pure — the CLI and `mission advance` both call it.
 */
export function correctiveSeatFromState(state, milestone, { cause, triggerIds = [], sizeTier } = {}, table = TABLE) {
  if (!CORRECTIVE_CAUSES.includes(cause)) throw new TypeError(`cause must be one of ${CORRECTIVE_CAUSES.join(", ")}`)
  const flags = state?.seatProfile == null ? undefined : { seatProfile: state.seatProfile }
  const start = resolveSeat({ role: "worker", previousRung: null, sizeTier, flags }, table).rung
  const previousRung = rungOfSeat(newestCorrective(state?.roundLog, milestone)?.seat, table) ?? start
  return resolveSeat({
    role: "worker",
    previousRung,
    trigger: cause,
    sameCheckFailedBefore: sameCheckFailedBefore(state?.roundLog, milestone, triggerIds),
    sizeTier,
    flags,
  }, table)
}

function correctiveSeat(args, table) {
  const [prdDir, milestone, ...rest] = args
  if (!prdDir || !milestone || prdDir.startsWith("--") || milestone.startsWith("--")) {
    throw new UsageError("corrective-seat needs <prd-dir> and <milestone>")
  }
  const parsed = parseFlags(rest, { "--cause": "cause", "--triggers": "triggers", "--size-tier": "sizeTier" })
  if (parsed.error) throw new UsageError(parsed.error)
  const { cause, triggers, sizeTier } = parsed.values
  if (!CORRECTIVE_CAUSES.includes(cause)) throw new UsageError(`--cause must be one of ${CORRECTIVE_CAUSES.join(", ")}`)
  if (triggers === undefined) throw new UsageError("--triggers is required")
  const triggerIds = parseJson(triggers, "--triggers")
  if (!Array.isArray(triggerIds) || !triggerIds.every((id) => typeof id === "string")) {
    throw new UsageError("--triggers must be a JSON array of ids")
  }
  const statePath = path.join(prdDir, "mission-state.json")
  let state
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"))
  } catch (error) {
    throw new UsageError(`cannot read ${statePath}: ${error.message}`)
  }
  if (Array.isArray(state.milestones) && !state.milestones.some((m) => m?.id === milestone)) {
    throw new UsageError(`${statePath} has no milestone ${milestone}`)
  }
  // Only the top-level seatProfile: a stored milestones[].sizeTier is a plan-time record and never picks a start.
  return correctiveSeatFromState(state, milestone, { cause, triggerIds, sizeTier }, table)
}

/**
 * Runs the CLI and returns `{exitCode, stdout, stderr}`; it never exits the
 * process. `table` stands in for seat-ladder.json so a test can give the worker
 * a different start per size tier; the CLI entry point never passes one.
 */
export function runCLI(argv, table = TABLE) {
  const [command, ...args] = argv
  try {
    let result
    if (command === "resolve") {
      if (args.length !== 1) throw new UsageError("resolve takes exactly one JSON argument")
      result = resolveSeat(parseJson(args[0], "the argument"), table)
    } else if (command === "corrective-seat") {
      result = correctiveSeat(args, table)
    } else {
      throw new UsageError(`unknown command ${JSON.stringify(command)}`)
    }
    return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" }
  } catch (error) {
    if (!(error instanceof UsageError) && !(error instanceof TypeError)) throw error
    const usage = error instanceof UsageError ? USAGE : ""
    return { exitCode: 2, stdout: "", stderr: `seat-ladder: ${error.message}\n${usage}` }
  }
}

if (isMainModule(import.meta.url)) await exitWith(runCLI(process.argv.slice(2)))
