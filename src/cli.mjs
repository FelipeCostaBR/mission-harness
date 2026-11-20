#!/usr/bin/env node
/**
 * contractor — CLI for the contract-first multi-agent build harness.
 *
 * This CLI does the DETERMINISTIC half of the harness: the parts that must not
 * depend on a model's judgement. It never calls an LLM. It scaffolds and
 * validates configuration, arms and disarms the edit-routing hook, routes edits
 * to areas, and evaluates the pure decision rules against a mission's artifacts.
 *
 * The other half — planning, building, validating — is prompts, run by whichever
 * agent runtime you use. `contractor prompt <name>` prints them for pasting into
 * any model; `contractor install <adapter>` wires them into a specific runtime.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, cpSync } from "node:fs"
import { join, dirname, relative, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

import {
  loadConfig,
  findProjectRoot,
  pathGlobsByArea,
  escalationConfig,
  resolveModel,
  seatTable,
  CONFIG_FILENAME,
  STATE_DIRNAME,
} from "./config.mjs"
import { arm, disarm, check } from "./io/flag.mjs"
import {
  missionPaths,
  ensureMissionDirs,
  readState,
  readArtifacts,
  buildBrief,
  newMissionState,
  newContract,
  readJson,
  writeJson,
} from "./io/mission.mjs"
import { enqueueEdits, drainQueue, routeFileToArea, unownedPaths } from "./io/queue.mjs"
import { partitionDisjoint } from "./rules/partition.mjs"
import { decideSelfHeal } from "./rules/self-heal.mjs"
import { resumePlan } from "./rules/resume.mjs"
import { routeEscalation } from "./rules/escalation-route.mjs"
import { correctiveSeatFromState, runCLI as runSeatCLI } from "./rules/seat-ladder.mjs"
import { runCLI as runPlanSizeCLI } from "./rules/plan-size.mjs"
import { collectCommits, commitBoundaryReport } from "./rules/commit-boundary.mjs"
import {
  checkBookkeeping,
  checkHandoffMeta,
  isBookkeepingClean,
  computeAdvanceReadiness,
} from "./rules/bookkeeping.mjs"
import { pathWithinGlobs } from "./rules/boundary.mjs"
import { runCLI as runStateCLI, COMMAND_NAMES as STATE_COMMANDS } from "./state/mission-state.mjs"

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// A CLI is routinely piped into something that stops reading early — `head`,
// `grep -q`, a pager the user quits. Node's default is to raise EPIPE as an
// unhandled 'error' event and crash with a stack trace, which turns a completely
// normal shell idiom into a spurious failure (and, in a hook, into noise the
// agent has to interpret). Exit quietly instead.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e?.code === "EPIPE") process.exit(0)
    throw e
  })
}

const out = (s = "") => process.stdout.write(s + "\n")
const err = (s = "") => process.stderr.write(s + "\n")
const bold = (s) => (process.stdout.isTTY ? `\u001b[1m${s}\u001b[0m` : s)
const dim = (s) => (process.stdout.isTTY ? `\u001b[2m${s}\u001b[0m` : s)
const red = (s) => (process.stdout.isTTY ? `\u001b[31m${s}\u001b[0m` : s)
const yellow = (s) => (process.stdout.isTTY ? `\u001b[33m${s}\u001b[0m` : s)
const green = (s) => (process.stdout.isTTY ? `\u001b[32m${s}\u001b[0m` : s)

class UserError extends Error {}

// ---------------------------------------------------------------------------
// helpers

function gitFiles(root) {
  try {
    return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Resolve which mission to operate on: an explicit arg, else the armed one. */
function resolveMission(root, explicit) {
  if (explicit) return explicit
  const c = check(root)
  if (c.armed && c.missionDir) return c.missionDir
  throw new UserError(
    "No mission specified and none armed.\n" +
      "  Pass one:   contractor <cmd> <missionDir>\n" +
      "  Or arm it:  contractor arm <missionDir>",
  )
}

function requireState(root, missionDir) {
  const state = readState(root, missionDir)
  if (!state) throw new UserError(`No mission-state.json found in ${missionDir}`)
  return state
}

function printFindings(findings) {
  for (const f of findings) {
    const tag = f.severity === "error" ? red("ERROR") : yellow("warn ")
    out(`  ${tag} ${bold(f.code)}  ${f.detail}`)
  }
}

// ---------------------------------------------------------------------------
// commands

function cmdInit(args) {
  const force = args.includes("--force")
  const { root } = findProjectRoot()
  const configPath = join(root, CONFIG_FILENAME)
  if (existsSync(configPath) && !force) {
    throw new UserError(`${CONFIG_FILENAME} already exists at ${root}. Pass --force to overwrite.`)
  }

  const template = readFileSync(join(PKG_ROOT, "templates", "contractor.config.json"), "utf8")
  writeFileSync(configPath, template)

  const missionsDir = join(root, STATE_DIRNAME, "missions")
  mkdirSync(missionsDir, { recursive: true })

  out(`${green("✓")} wrote ${relative(root, configPath) || CONFIG_FILENAME}`)
  out(`${green("✓")} created ${relative(root, missionsDir)}/`)
  out("")
  out(bold("The config is a STUB. It has no areas, so nothing is routable yet."))
  out("")
  out("Adapting it to this codebase is an agent task, not a form to fill in. Hand")
  out("your model the adaptation prompt and let it survey the repo:")
  out("")
  out(dim("  contractor prompt init > /tmp/contractor-init.md"))
  out(dim("  # then, in your agent of choice:"))
  out(dim("  #   \"Follow /tmp/contractor-init.md against this repository.\""))
  out("")
  out("When it is done, verify the result mechanically:")
  out("")
  out(dim("  contractor doctor"))
}

function cmdDoctor() {
  const { config, root, configPath } = loadConfig()
  const findings = []
  const add = (severity, code, detail) => findings.push({ severity, code, detail })

  out(bold(`contractor doctor`))
  out(dim(`  config: ${configPath}`))
  out(dim(`  root:   ${root}`))
  out("")

  // --- areas
  const areas = config.areas ?? []
  if (!areas.length) {
    add("error", "no-areas", "No areas defined. A worker seat has nothing to be scoped to.")
  }
  const seen = new Set()
  for (const a of areas) {
    if (!a || typeof a.slug !== "string" || !a.slug) {
      add("error", "area-no-slug", `An area entry has no slug: ${JSON.stringify(a)}`)
      continue
    }
    if (seen.has(a.slug)) add("error", "area-duplicate-slug", `Duplicate area slug "${a.slug}"`)
    seen.add(a.slug)
    if (!Array.isArray(a.pathGlobs) || !a.pathGlobs.length) {
      add("error", "area-no-globs", `Area "${a.slug}" has no pathGlobs — every edit would be a boundary violation.`)
    }
    if (a.surface && !config.surfaces?.[a.surface]) {
      add("warn", "area-unknown-surface", `Area "${a.slug}" names surface "${a.surface}", which is not defined in surfaces{}.`)
    }
  }

  // --- glob reality check against tracked files
  const files = gitFiles(root)
  if (!files.length) {
    add("warn", "no-git-files", "`git ls-files` returned nothing — glob coverage could not be verified.")
  } else {
    const ownerCount = new Map()
    for (const a of areas) {
      if (!a?.slug || !Array.isArray(a.pathGlobs)) continue
      const matched = files.filter((f) => pathWithinGlobs(f, a.pathGlobs))
      if (!matched.length) {
        add("error", "area-matches-nothing", `Area "${a.slug}" matches 0 tracked files. Its globs are wrong or the code moved.`)
      }
      for (const f of matched) ownerCount.set(f, (ownerCount.get(f) ?? 0) + 1)
    }
    // Two areas owning one file breaks the partition rule's disjointness premise.
    const contested = [...ownerCount.entries()].filter(([, n]) => n > 1).map(([f]) => f)
    if (contested.length) {
      add(
        "error",
        "areas-overlap",
        `${contested.length} file(s) are claimed by more than one area, e.g. ${contested.slice(0, 3).join(", ")}. Areas must be disjoint.`,
      )
    }
    const orphans = files.filter((f) => !ownerCount.has(f))
    if (orphans.length) {
      const topDirs = [...new Set(orphans.map((f) => f.split("/").slice(0, 2).join("/")))].slice(0, 8)
      add(
        "info",
        "unowned-paths",
        `${orphans.length} tracked file(s) belong to no area. That is normal and often deliberate — cross-cutting paths must escalate. Top: ${topDirs.join(", ")}`,
      )
    }
  }

  // --- gates
  const integration = config.gates?.integration ?? []
  if (!integration.length) {
    add(
      "error",
      "no-integration-gate",
      "gates.integration is empty. Per-area checks cannot see cross-repo breakage, so a milestone would advance on nothing.",
    )
  }
  const pkgPath = join(root, "package.json")
  const pkg = existsSync(pkgPath) ? readJson(pkgPath, {}) : null
  for (const g of integration) {
    const cmd = typeof g === "string" ? g : g?.cmd
    if (!cmd) {
      add("error", "gate-no-cmd", `A gates.integration entry has no cmd: ${JSON.stringify(g)}`)
      continue
    }
    const m = /^(?:npm|pnpm|yarn|bun)\s+run\s+([\w:-]+)/.exec(cmd)
    if (m && pkg && pkg.scripts && !pkg.scripts[m[1]]) {
      add("warn", "gate-script-missing", `Gate "${cmd}" runs script "${m[1]}", which is not in package.json.`)
    }
  }

  // --- seat ladder + models
  const table = seatTable(config)
  const rungIds = new Set((table.ladder ?? []).map((r) => r.id))
  for (const [role, seat] of Object.entries(table.roles ?? {})) {
    for (const k of ["start", "ceiling"]) {
      if (!rungIds.has(seat?.[k])) add("error", "seat-bad-rung", `seatLadder role "${role}" ${k} "${seat?.[k]}" is not a ladder rung.`)
    }
  }
  if (config.models && Object.keys(config.models).length) {
    for (const model of new Set((table.ladder ?? []).map((r) => r.model))) {
      if (!config.models[model]) add("warn", "seat-unmapped", `Ladder model "${model}" has no entry in models{}; it passes through literally (right for Claude Code's own aliases).`)
    }
  }
  for (const [seat, def] of Object.entries(config.seats ?? {})) {
    if (seat === "validator" && def?.readOnly !== true) {
      add("error", "validator-not-readonly", `seats.validator must be readOnly: a validator that can edit fixes what it was asked to judge.`)
    }
  }
  if (config.seats?.validator && config.seats.validator.readOnly !== true) {
    add(
      "error",
      "validator-writable",
      "seats.validator.readOnly is not true. A validator that can edit is not a verifier — it will fix what it was asked to judge.",
    )
  }
  const orchTier = config.seats?.orchestrator?.tier
  const valTier = config.seats?.validator?.tier
  if (orchTier && orchTier !== "frontier") {
    add("warn", "orchestrator-not-frontier", `The orchestrator seat is "${orchTier}". Planning and adjudication are where model strength pays most; see docs/models.md.`)
  }
  if (valTier && valTier !== "frontier") {
    add("warn", "validator-not-frontier", `The validator seat is "${valTier}". A weak verifier rubber-stamps.`)
  }

  // --- protected paths
  for (const pp of config.protectedPaths ?? []) {
    if (!pp?.glob) add("error", "protected-no-glob", `A protectedPaths entry has no glob: ${JSON.stringify(pp)}`)
    else if (files.length && !files.some((f) => pathWithinGlobs(f, [pp.glob]))) {
      add("warn", "protected-matches-nothing", `Protected path "${pp.glob}" matches 0 tracked files.`)
    }
  }
  if (!(config.protectedPaths ?? []).length) {
    add("warn", "no-protected-paths", "No protectedPaths. Nothing will ever escalate, so workers may edit shared surfaces unreviewed.")
  }

  // --- missions dir
  const missionsRoot = join(root, config.paths?.missions ?? ".contractor/missions")
  if (!existsSync(missionsRoot)) {
    add("info", "missions-dir-missing", `${relative(root, missionsRoot)} does not exist yet; it is created on first mission.`)
  }

  const errors = findings.filter((f) => f.severity === "error")
  const warns = findings.filter((f) => f.severity === "warn")
  const infos = findings.filter((f) => f.severity === "info")

  for (const f of [...errors, ...warns]) {
    const tag = f.severity === "error" ? red("ERROR") : yellow("warn ")
    out(`  ${tag} ${bold(f.code)}`)
    out(`        ${f.detail}`)
  }
  for (const f of infos) {
    out(`  ${dim("info ")} ${dim(f.code)}`)
    out(`        ${dim(f.detail)}`)
  }

  out("")
  out(
    `${errors.length ? red(`${errors.length} error(s)`) : green("0 errors")}, ` +
      `${warns.length} warning(s), ${infos.length} note(s) — ` +
      `${areas.length} area(s), ${integration.length} integration gate(s)`,
  )
  if (errors.length) {
    out("")
    out(red("Not ready to run a mission. Fix the errors above."))
    process.exitCode = 1
  }
}

function cmdMissionNew(args) {
  const id = args[0]
  if (!id) throw new UserError("usage: contractor mission new <mission-id>")
  const { config, root } = loadConfig()
  const missionDir = join(config.paths?.missions ?? ".contractor/missions", id)
  const p = ensureMissionDirs(root, missionDir)
  if (!existsSync(p.state)) {
    const seats = Object.fromEntries(
      Object.entries(config.seats ?? {}).map(([k, v]) => [k, v.tier]),
    )
    writeJson(p.state, newMissionState(missionDir, { name: id, seats }))
  }
  if (!existsSync(p.contract)) writeJson(p.contract, newContract(missionDir))
  const specPath = join(p.dir, "spec.md")
  if (!existsSync(specPath)) {
    cpSync(join(PKG_ROOT, "templates", "spec-template.md"), specPath)
  }
  out(`${green("✓")} mission scaffolded at ${missionDir}`)
  out("")
  out("  1. Write the spec:      " + dim(`${missionDir}/spec.md`))
  out("  2. Plan it:             " + dim("contractor prompt plan") + dim("  → give it to your orchestrator"))
  out("  3. Arm it (after approval): " + dim(`contractor arm ${missionDir}`))
}

function cmdArm(args) {
  const { root } = loadConfig()
  const missionDir = args[0]
  if (!missionDir) throw new UserError("usage: contractor arm <missionDir>")
  const r = arm(root, missionDir)
  if (!r.ok) throw new UserError(`FAILED to arm: ${r.flag} was not written`)
  out(`${green("ARMED")} ${r.flag} -> ${missionDir}`)
  if (!r.statusWritten) {
    out(yellow(`  warn: missionStatus was not set (no mission-state.json at ${missionDir})`))
  }
  // The queue-substrate probe, run NOW and recorded. Doing it at arm time is the
  // whole point: an empty queue at the milestone boundary is ambiguous — it can
  // mean "no edits happened" or "the hook was never able to write here" — and the
  // two demand opposite responses. Probed up front, it is never ambiguous again.
  const probe = probeSubstrate(root)
  const state = readState(root, missionDir)
  if (state) {
    state.queueSubstrate = {
      status: probe.status,
      scopeSource: probe.status === "live" ? "hook-queue" : "handoffs+commits",
      detail: probe.detail,
      ts: new Date().toISOString(),
    }
    writeJson(missionPaths(root, missionDir).state, state)
  }
  out(dim(`  queue substrate: ${probe.status}${probe.detail ? ` (${probe.detail})` : ""}`))
  if (probe.status !== "live") {
    out(
      yellow(
        "  This mission's edit queue will stay empty for the whole run. Derive\n" +
          "  validation scope from handoffs ∪ committed paths instead, and do NOT read\n" +
          "  the empty queue as evidence that nothing was edited.",
      ),
    )
  }
}

function probeSubstrate(root) {
  let top = null
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return { status: "unavailable-worktree", detail: "not a git repository" }
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.env.CONTRACTOR_PROJECT_DIR ?? null
  if (projectDir && resolve(projectDir) !== resolve(top)) {
    return {
      status: "unavailable-worktree",
      detail: `agent project dir ${projectDir} != worktree ${top}`,
    }
  }
  const flag = check(root)
  if (!flag.armed) return { status: "unavailable-worktree", detail: "flag not resolvable from root" }
  return { status: "live", detail: null }
}

function cmdDisarm(args) {
  const { root } = loadConfig()
  const status = args[0] && !args[0].startsWith("-") ? args[0] : "halted"
  const fallback = args[1] ?? ""
  const r = disarm(root, status, fallback)
  if (!r.ok) throw new UserError(`FAILED to disarm: ${r.flag} is still present`)
  out(`${green("DISARMED")} (inert, status=${r.status})`)
  if (r.warning) out(yellow(`  warn: ${r.warning}`))
  if (!r.statusWritten && r.missionDir) {
    out(yellow(`  warn: missionStatus was not written (no mission-state.json at ${r.missionDir})`))
  }
}

function cmdStatus(args) {
  const { config, root } = loadConfig()
  const c = check(root)
  if (!c.armed) {
    out(`${bold("INERT")} — no mission armed`)
  } else {
    out(`${bold("ARMED")} -> ${c.missionDir}`)
  }
  const missionDir = args[0] ?? c.missionDir
  if (!missionDir) return
  const state = readState(root, missionDir)
  if (!state) {
    out(dim(`  (no mission-state.json at ${missionDir})`))
    return
  }
  const plan = resumePlan(state)
  out("")
  out(`  missionStatus : ${state.missionStatus ?? "unknown"}`)
  out(`  milestones    : done=[${plan.doneMilestoneIds.join(", ")}] remaining=[${plan.remainingMilestoneIds.join(", ")}]`)
  out(`  next          : ${plan.nextMilestoneId ?? "(none — all done)"}`)
  const q = drainQueue(root, missionDir)
  out(`  queued areas  : ${q.areas.length ? q.areas.join(", ") : "(none)"}${q.dropped ? dim(` [${q.dropped} foreign entries ignored]`) : ""}`)
  void config
}

function cmdBrief(args) {
  const { root } = loadConfig()
  // --only-active is the hook form: print the brief when a mission is armed AND
  // live, and print NOTHING otherwise. A session-start hook must be silent when
  // there is no mission, and must never fail the session.
  const onlyActive = args.includes("--only-active")
  const positional = args.filter((a) => !a.startsWith("-"))
  let missionDir
  try {
    missionDir = resolveMission(root, positional[0])
  } catch (e) {
    if (onlyActive) return
    throw e
  }
  if (onlyActive) {
    const state = readState(root, missionDir)
    if (!state || state.missionStatus !== "active") return
  }
  const { brief, plan } = buildBrief(root, missionDir)
  if (args.includes("--json")) {
    out(JSON.stringify(plan, null, 2))
    return
  }
  out(brief)
}

function cmdCheck(args) {
  const { root } = loadConfig()
  const missionDir = resolveMission(root, args[0])
  const state = requireState(root, missionDir)
  const artifacts = readArtifacts(root, missionDir)
  const { config } = loadConfig()
  const findings = checkBookkeeping(state, { handoffFiles: artifacts.handoffFiles, surfaces: Object.keys(config.surfaces ?? {}) })

  const p = missionPaths(root, missionDir)
  for (const f of artifacts.handoffFiles) {
    const h = readJson(join(p.handoffs, f), null)
    for (const m of checkHandoffMeta(h)) {
      findings.push({ ...m, detail: `${f}: ${m.detail}` })
    }
  }

  if (!findings.length) {
    out(`${green("✓")} bookkeeping clean (${artifacts.handoffFiles.length} handoff(s), ${artifacts.verdictMilestonePrefixes.length} verdict(s))`)
    return
  }
  out(bold(`bookkeeping findings for ${missionDir}`))
  printFindings(findings)
  out("")
  if (!isBookkeepingClean(findings)) {
    out(red("Errors present — fix before advancing the milestone."))
    process.exitCode = 1
  } else {
    out(yellow("Warnings only — record them in boundaryNotes and continue."))
  }
}

function cmdAdvance(args) {
  const { config, root } = loadConfig()
  const missionDir = resolveMission(root, args[0])
  const state = requireState(root, missionDir)
  const milestoneId = args[1] ?? state.currentMilestone ?? resumePlan(state).nextMilestoneId
  if (!milestoneId) throw new UserError("No milestone to evaluate (all done?)")
  const milestone = (state.milestones ?? []).find((m) => m?.id === milestoneId)
  if (!milestone) throw new UserError(`Milestone "${milestoneId}" not found in mission-state`)

  const bound = milestone.assertions ?? []
  const states = Object.fromEntries(bound.map((a) => [a, state.assertionStatus?.[a] ?? "pending"]))
  const readiness = computeAdvanceReadiness(states)

  // Hard blockers are counted from the persisted verdict files, never from prose.
  const p = missionPaths(root, missionDir)
  let boundaryViolations = 0
  let missingDefaults = 0
  const verdictFiles = existsSync(p.verdicts)
    ? readdirSync(p.verdicts).filter((f) => f.endsWith(".json"))
    : []
  for (const f of verdictFiles) {
    const v = readJson(join(p.verdicts, f), {}) ?? {}
    boundaryViolations += (v.boundaryViolations ?? []).length
    missingDefaults += (v.missingDefaults ?? []).length
  }

  const gateGreen = state.integrationGate?.passed === true
  const rounds = state.correctiveRounds?.[milestoneId] ?? 0
  const maxRounds = config.policy?.maxCorrectiveRounds ?? 2

  const decision = decideSelfHeal({
    assertionsAllPassing: readiness.assertionsAllPassing,
    boundaryViolations,
    missingDefaults,
    gateGreen,
    correctiveRounds: rounds,
    maxRounds,
  })

  const seat = correctiveSeatFromState(state, milestoneId, { cause: gateGreen ? "assertion" : "gate" }, seatTable(config))

  out(bold(`advance check — ${missionDir} · ${milestoneId}`))
  out("")
  out(`  assertions        : ${bound.length} bound, ${readiness.assertionsAllPassing ? green("all resolved") : red(`blocking: ${readiness.blocking.join(", ")}`)}`)
  out(`  boundaryViolations: ${boundaryViolations === 0 ? green("0") : red(String(boundaryViolations))}`)
  out(`  missingDefaults   : ${missingDefaults === 0 ? green("0") : red(String(missingDefaults))}`)
  out(`  integration gate  : ${gateGreen ? green("green") : red("not green")}`)
  out(`  correctiveRounds  : ${rounds} / ${maxRounds}`)
  out(`  verdict files     : ${verdictFiles.length}${verdictFiles.length ? "" : red("  ← a missing verdict is a FAILURE, never an assumed pass")}`)
  out("")
  if (readiness.behaviorallyGated) {
    out(yellow(`  gated: an assertion could not be verified in-harness. The milestone may advance,`))
    out(yellow(`         but the mission must NOT be recorded done. Disarm with status "gated".`))
  }
  if (readiness.hypothesisFailed) {
    out(yellow(`  hypothesis failed: an empirical gate returned NO-GO. Halt clean — do NOT open a`))
    out(yellow(`         corrective round. No sharpened procedure fixes a falsified hypothesis.`))
  }
  const color = decision.action === "advance" ? green : decision.action === "corrective" ? yellow : red
  out(`  ${bold("DECISION")}: ${color(decision.action.toUpperCase())}`)
  out(`  ${dim(decision.reason)}`)
  if (decision.action === "corrective") {
    out(`  ${dim(`next worker seat: ${seat.model}/${seat.effort} (${seat.rung}${seat.climbed ? ", climbed" : ""}) — ${seat.reason}`)}`)
  }
  if (decision.action !== "advance") process.exitCode = 2
}

function cmdPartition(args) {
  const { config, root } = loadConfig()
  const missionDir = resolveMission(root, args[1])
  const state = requireState(root, missionDir)
  const milestoneId = args[0] ?? state.currentMilestone ?? resumePlan(state).nextMilestoneId
  const milestone = (state.milestones ?? []).find((m) => m?.id === milestoneId)
  if (!milestone) throw new UserError(`Milestone "${milestoneId}" not found`)

  // Feature -> area mapping comes from mission-state's features[] entries, which
  // may be plain ids (looked up in featureAreas) or objects.
  const features = (milestone.features ?? []).map((f) => {
    if (typeof f === "object" && f) return f
    const meta = state.featureAreas?.[f] ?? {}
    return { id: f, area: meta.area ?? state.procedures?.[f]?.area ?? "", isEscalation: !!meta.isEscalation }
  })
  const missing = features.filter((f) => !f.area)
  if (missing.length) {
    out(yellow(`  ${missing.length} feature(s) have no area mapping; they will be serialized.`))
    out(dim(`  Add state.featureAreas = { "<featureId>": { "area": "<slug>" } } to fix.`))
  }
  const withArea = features.map((f) => ({ ...f, area: f.area || "__unknown__" }))
  const { parallelBatches, serial } = partitionDisjoint(withArea, pathGlobsByArea(config))

  out(bold(`partition — ${milestoneId}`))
  out("")
  if (config.policy?.parallelWorkers === false) {
    out(yellow("  policy.parallelWorkers is false — everything runs serially regardless."))
    out("")
  }
  out(`  serial (in-tree, one at a time):`)
  for (const f of serial) out(`    - ${f.id} ${dim(`[${f.area}]${f.isEscalation ? " escalation" : ""}`)}`)
  if (!serial.length) out(dim("    (none)"))
  out("")
  for (const [i, b] of parallelBatches.entries()) {
    out(`  parallel batch ${i + 1} (isolated worktrees, merge back in feature-id order):`)
    for (const f of b) out(`    - ${f.id} ${dim(`[${f.area}]`)}`)
  }
  if (!parallelBatches.length) out(dim("  (no parallel batches — conservative partition)"))
}

function cmdEscalate(args) {
  const { config } = loadConfig()
  const additiveOnly = args.includes("--additive-only")
  const files = args.filter((a) => !a.startsWith("-"))
  if (!files.length) {
    throw new UserError("usage: contractor escalate <file> [file...] [--additive-only]")
  }
  const route = routeEscalation({ files, additiveOnly }, escalationConfig(config))
  out(bold(`escalation route: ${route.route === "inline" ? yellow("INLINE") : green("DELEGATE")}`))
  out("")
  for (const r of route.reasons) out(`  · ${r}`)
  out("")
  if (route.route === "delegate") {
    out(`  worker path grant (${route.workerPathGlobs.length}):`)
    for (const g of route.workerPathGlobs) out(`    ${g}`)
    out("")
    out(`  ${bold("A fresh read-only validator MUST review this at the boundary.")}`)
    out(dim(`  Record it in escalations[] with implementedBy: "escalation-worker" — the`))
    out(dim(`  validator spawn keys on exactly that marker.`))
  } else {
    out(`  The orchestrator applies this itself, with the full inline discipline:`)
    out(dim(`    read-before-edit · prove the post-condition with a command ·`))
    out(dim(`    verify the staged diff is non-empty · full typecheck with a cold cache ·`))
    out(dim(`    record the commands + exit codes as verifiedBy`))
  }
  out("")
  out(JSON.stringify(route, null, 2))
}

/**
 * Hook entry. Reads a PostToolUse-style JSON event on stdin, or takes explicit
 * paths as arguments. Always exits 0: a hook that throws breaks the agent's tool
 * loop, and a queue is not worth that.
 */
async function cmdRoute(args) {
  if (args[0] === "--resolve") {
    const { root } = findProjectRoot()
    const c = check(root)
    out(JSON.stringify({ root, flagFound: c.armed, missionDir: c.missionDir }))
    return
  }

  let config, root
  try {
    ;({ config, root } = loadConfig())
  } catch {
    return // no config: nothing to route
  }
  const c = check(root)
  if (!c.armed || !c.missionDir) return // inert outside a mission

  // Defense in depth: even if the flag was left behind by a failed disarm, a
  // mission whose own state says it is finished must not keep queueing edits.
  const state = readState(root, c.missionDir)
  if (state?.missionStatus && state.missionStatus !== "active") return

  const explicit = args.filter((a) => !a.startsWith("-"))
  let paths = explicit
  let session = null
  if (!paths.length) {
    const raw = await readStdin()
    if (!raw) return
    let event
    try {
      event = JSON.parse(raw)
    } catch {
      return
    }
    const tool = event.tool_name ?? event.toolName
    if (tool && !["Edit", "Write", "MultiEdit", "apply_patch", "edit_file"].includes(tool)) return
    const input = event.tool_input ?? event.toolInput ?? {}
    const set = new Set()
    if (typeof input.file_path === "string") set.add(input.file_path)
    if (typeof input.path === "string") set.add(input.path)
    if (Array.isArray(input.edits)) for (const e of input.edits) if (e?.file_path) set.add(e.file_path)
    paths = [...set]
    session = event.session_id ?? event.sessionId ?? null
  }
  if (!paths.length) return

  const rel = paths.map((p) => (isAbsolute(p) ? relative(root, p) : p).split("\\").join("/"))
  const n = enqueueEdits(root, c.missionDir, config, rel, { session })
  if (process.env.CONTRACTOR_DEBUG) err(`[contractor route] queued ${n}/${rel.length} path(s)`)
}

function readStdin() {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res("")
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (c) => (data += c))
    process.stdin.on("end", () => res(data))
    process.stdin.on("error", () => res(""))
  })
}

function cmdOwn(args) {
  const { config, root } = loadConfig()
  const paths = args.filter((a) => !a.startsWith("-"))
  if (!paths.length) throw new UserError("usage: contractor own <path> [path...]")
  const rel = paths.map((p) => (isAbsolute(p) ? relative(root, p) : p))
  for (const p of rel) {
    const area = routeFileToArea(config, p)
    out(`${area ? green(area.padEnd(20)) : yellow("(unowned)".padEnd(20))} ${p}`)
  }
  const orphans = unownedPaths(config, rel)
  if (orphans.length) {
    out("")
    out(yellow(`${orphans.length} path(s) belong to no area — these ESCALATE.`))
    out(dim("Plan them into the earliest milestone that needs them, as one batch."))
  }
}

function cmdPrompt(args) {
  const promptsDir = join(PKG_ROOT, "prompts")
  const known = collectPrompts(promptsDir)
  const name = args[0]
  if (!name) {
    out(bold("available prompts"))
    out("")
    for (const [key, file] of known) out(`  ${key.padEnd(22)} ${dim(relative(PKG_ROOT, file))}`)
    out("")
    out(dim("  contractor prompt <name>            print it"))
    out(dim("  contractor prompt <name> --raw      print with no header"))
    return
  }
  const match = known.find(([k]) => k === name)
  if (!match) throw new UserError(`Unknown prompt "${name}". Run \`contractor prompt\` to list them.`)
  const body = readFileSync(match[1], "utf8")
  if (args.includes("--raw")) {
    process.stdout.write(body)
    return
  }
  process.stdout.write(body)
}

function collectPrompts(dir, prefix = "") {
  const acc = []
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) acc.push(...collectPrompts(full, `${prefix}${entry.name}/`))
    else if (entry.name.endsWith(".md")) {
      const base = entry.name.replace(/\.md$/, "")
      // Top-level orchestrator phases get short names: plan / run / validate.
      const key = prefix === "orchestrator/" ? base : `${prefix}${base}`
      acc.push([key, full])
    }
  }
  return acc
}

function cmdInstall(args) {
  const adapter = args[0]
  const adaptersDir = join(PKG_ROOT, "adapters")
  const available = existsSync(adaptersDir)
    ? readdirSync(adaptersDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : []
  if (!adapter) {
    out(bold("available adapters"))
    out("")
    for (const a of available) out(`  ${a}`)
    out("")
    out(dim("  contractor install <adapter>"))
    return
  }
  if (!available.includes(adapter)) {
    throw new UserError(`Unknown adapter "${adapter}". Available: ${available.join(", ")}`)
  }
  const { root } = findProjectRoot()
  const src = join(adaptersDir, adapter)
  const copied = []
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "README.md") continue
    const from = join(src, entry.name)
    const to = join(root, entry.name)
    cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
    copied.push(relative(root, to))
  }
  out(`${green("✓")} installed the ${adapter} adapter into ${root}`)
  for (const c of copied) out(`    ${c}/`)
  out("")
  out(`Wiring instructions (hooks, seats, model tiers):`)
  out(`    ${dim(join(src, "README.md"))}`)
  out("")
  out(`Next: adapt the harness to this repository.`)
  out(`    ${dim("contractor prompt init")}   ${dim("→ give it to your agent")}`)
  out(`    ${dim("contractor doctor")}        ${dim("→ verify the result")}`)
}

// ---------------------------------------------------------------------------

const USAGE = `${bold("contractor")} — contract-first multi-agent build harness

${bold("Setup")}
  init [--force]              scaffold ${CONFIG_FILENAME} + ${STATE_DIRNAME}/
  doctor                      validate the config against this repository
  install [adapter]           wire the prompts into an agent runtime
  prompt [name] [--raw]       print a seat prompt (works with ANY model)

${bold("Missions")}
  mission new <id>            scaffold a mission folder
  arm <missionDir>            arm edit-routing for a mission
  disarm [status] [dir]       halted (default) | gated | done
  status [missionDir]         armed state + milestone position
  brief [missionDir] [--json] the rehydration digest for a fresh context
  state [missionDir] <cmd>    the ONLY way to change mission-state.json after
                              approval (locked, atomic, bookkeeping-checked);
                              run \`contractor state help\` for its commands

${bold("Decisions")} ${dim("(pure rules, evaluated against the mission's artifacts)")}
  seat resolve '<json>'       the model + effort a role's next spawn runs on
  seat corrective [dir] <ms> --cause <assertion|gate|spec> --triggers '<ids>'
  size [dir] <milestone>      small | normal | large (picks the worker's start rung)
  commits [dir] <rev-range>   every commit stays inside the grant that claims it
  check [missionDir]          bookkeeping invariants
  advance [missionDir] [ms]   advance / corrective / circuit-break
  partition [milestone] [dir] which features may run in parallel
  escalate <files...>         inline or delegate, and the worker's path grant
  own <paths...>              which area owns a path (and what escalates)

${bold("Hook")}
  route                       PostToolUse entry (reads the event on stdin)
  route --resolve             probe whether the flag resolves from here

Docs: https://github.com/FelipeCostaBR/contractor
`

/**
 * `contractor state [missionDir] <command> [args]` — the ONLY sanctioned route
 * for a mission-state.json write once the plan is approved. Locked, atomic,
 * and refused when it would add a bookkeeping error. With no missionDir it
 * acts on the armed mission.
 */
function cmdState(args) {
  const { root, config } = loadConfig()
  const explicit = args[0] && !STATE_COMMANDS.includes(args[0]) ? args[0] : null
  const rest = explicit ? args.slice(1) : args
  const missionDir = resolveMission(root, explicit)
  const abs = isAbsolute(missionDir) ? missionDir : join(root, missionDir)
  const r = runStateCLI([abs, ...rest], { surfaces: Object.keys(config.surfaces ?? {}) })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  process.exitCode = r.exitCode
}

/**
 * `contractor seat resolve '<json>'` and
 * `contractor seat corrective [missionDir] <milestone> --cause <c> --triggers '<ids>'`:
 * the seat (model + effort) the next spawn of a role runs on, from the
 * project's seat ladder. Pure; writes nothing.
 */
function cmdSeat(args) {
  const { root, config } = loadConfig()
  const table = seatTable(config)
  if (args[0] === "corrective") {
    const rest = args.slice(1)
    const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")))
    const missionDir = resolveMission(root, positional.length >= 2 ? positional[0] : null)
    const abs = isAbsolute(missionDir) ? missionDir : join(root, missionDir)
    const flagArgs = rest.slice(rest.findIndex((a) => a.startsWith("--")) >= 0 ? rest.findIndex((a) => a.startsWith("--")) : rest.length)
    const milestone = positional[positional.length - 1]
    return emit(runSeatCLI(["corrective-seat", abs, milestone, ...flagArgs], table))
  }
  return emit(runSeatCLI(args, table))
}

/** `contractor size [missionDir] <milestone>`: small | normal | large. */
function cmdSize(args) {
  const { root } = loadConfig()
  const missionDir = resolveMission(root, args.length >= 2 ? args[0] : null)
  const abs = isAbsolute(missionDir) ? missionDir : join(root, missionDir)
  return emit(runPlanSizeCLI([abs, args[args.length - 1]]))
}

/**
 * `contractor commits [missionDir] <rev-range>`: the per-commit boundary rule.
 * Every path a commit touches must sit inside a grant of the feature or
 * escalation that claims the commit; protected paths are violations whatever
 * the grant; the mission's own artifacts are exempt.
 */
function cmdCommits(args) {
  const { root, config } = loadConfig()
  const missionDir = resolveMission(root, args.length >= 2 ? args[0] : null)
  const range = args[args.length - 1]
  if (!range) throw new UserError("usage: contractor commits [missionDir] <rev-range>")
  const abs = isAbsolute(missionDir) ? missionDir : join(root, missionDir)
  const rel = relative(root, abs).split("\\").join("/")
  const cb = config.commitBoundary ?? {}
  const rules = {
    exempt: [`${rel}/mission-state.json`, `${rel}/validation-contract.json`, `${rel}/handoffs/**`, `${rel}/verdicts/**`, `${rel}/spec.md`],
    forbidden: (config.protectedPaths ?? []).map((p) => p.glob).filter(Boolean),
    forbiddenExceptions: cb.forbiddenExceptions ?? [],
    archTestGlobs: cb.archTestGlobs ?? [],
    prdPath: `${rel}/spec.md`,
    ownerAcceptedPrefixes: cb.ownerAcceptedPrefixes ?? [],
    acknowledged: cb.acknowledged ?? [],
  }
  const state = requireState(root, missionDir)
  const report = commitBoundaryReport(collectCommits(range, { prdDir: abs, prdPath: rules.prdPath }), state, rules)
  out(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

function emit(r) {
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  process.exitCode = r.exitCode
}

async function main() {
  const [, , cmd, ...args] = process.argv
  switch (cmd) {
    case "init":
      return cmdInit(args)
    case "doctor":
      return cmdDoctor(args)
    case "mission":
      if (args[0] === "new") return cmdMissionNew(args.slice(1))
      throw new UserError("usage: contractor mission new <id>")
    case "arm":
      return cmdArm(args)
    case "state":
      return cmdState(args)
    case "seat":
      return cmdSeat(args)
    case "size":
      return cmdSize(args)
    case "commits":
      return cmdCommits(args)
    case "disarm":
      return cmdDisarm(args)
    case "status":
      return cmdStatus(args)
    case "brief":
      return cmdBrief(args)
    case "check":
      return cmdCheck(args)
    case "advance":
      return cmdAdvance(args)
    case "partition":
      return cmdPartition(args)
    case "escalate":
      return cmdEscalate(args)
    case "own":
      return cmdOwn(args)
    case "route":
      return cmdRoute(args)
    case "prompt":
      return cmdPrompt(args)
    case "install":
      return cmdInstall(args)
    case "--version":
    case "-v": {
      const pkg = readJson(join(PKG_ROOT, "package.json"), {})
      return out(pkg.version ?? "unknown")
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return out(USAGE)
    default:
      err(`Unknown command "${cmd}"\n`)
      err(USAGE)
      process.exitCode = 2
  }
}

main().catch((e) => {
  if (e instanceof UserError) {
    err(red(e.message))
    process.exitCode = 1
    return
  }
  // `route` runs as a hook: it must never break the agent's tool loop.
  if (process.argv[2] === "route") {
    err(`[contractor route] ${e?.message ?? e}`)
    return
  }
  err(red(`contractor: ${e?.stack ?? e}`))
  process.exitCode = 1
})
