/**
 * gate.mjs — the milestone integration gate as a plan, built from the config.
 *
 * The gate is the one check that is not delegated and not judgement-based
 * (invariant 6), and it must be the repository's whole gate, the one CI runs,
 * never only the touched areas' suites (invariant 18): a scan in one package
 * reads another's files, so no touched-set derivation sees it.
 *
 * Every command comes from `mission.config.json`; nothing here knows a
 * toolchain. `gates.database` optionally describes a THROWAWAY database the
 * gate brings up first and tears down last, so the suites run against a fresh,
 * migrated database the way CI does, and never against a shared one: every
 * gate child gets the database environment keys OVERRIDDEN with the local
 * URL, and an inherited value naming a forbidden endpoint refuses the run.
 *
 * Pure: no I/O, no clock. `src/io/gate.mjs` runs the plan.
 */

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

/** The defaults `gates.database` merges over. Disabled unless configured. */
export const DEFAULT_GATE_DATABASE = Object.freeze({
  enabled: false,
  url: "",
  port: 5456,
  envKeys: ["DATABASE_URL"],
  forbid: [],
  setup: [],
  teardown: [],
  stoppedCheck: "",
})

export const DEFAULT_GATE_DEADLINE_MINUTES = 120

/** A single step never gets more than this, even with deadline left. */
export const STEP_CAP_MS = 60 * 60_000

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

export class GateConfigError extends Error {}

/** `gates.database` with its defaults. */
export function gateDatabase(gates) {
  const raw = isPlainObject(gates?.database) ? gates.database : {}
  return { ...DEFAULT_GATE_DATABASE, ...raw }
}

/** POSIX single-quote a value substituted into a command line. */
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * Fill `{port}`, `{dataDir}`, `{logDir}`, `{url}`, `{missionDir}` and
 * `{milestone}` in a configured command, each value shell-quoted (`{port}` is a
 * number and goes in bare). An unknown placeholder is left as written.
 */
export function expandGateCommand(cmd, vars) {
  return String(cmd).replace(/\{(port|dataDir|logDir|url|missionDir|milestone)\}/g, (_, k) => {
    const v = vars?.[k]
    if (v === undefined || v === null) return `{${k}}`
    return k === "port" ? String(v) : quote(v)
  })
}

/** The configured database URL with `{port}` and `{dataDir}` filled in, raw
 *  (a URL is a value, not a command line, so nothing is quoted). */
export function gateDatabaseUrl(db, { port, dataDir }) {
  return String(db?.url ?? "")
    .replace(/\{port\}/g, String(port))
    .replace(/\{dataDir\}/g, String(dataDir ?? ""))
}

/**
 * The gate database URL must be local: a URL whose host is loopback, or one
 * with no host at all (a file-backed database). Throws naming the reason,
 * never the value.
 */
export function assertLocalDatabaseUrl(url, forbid = []) {
  if (typeof url !== "string" || !url) throw new GateConfigError("gates.database.url is empty")
  for (const f of forbid) {
    if (typeof f === "string" && f && url.includes(f)) throw new GateConfigError("refused: the gate database URL names a forbidden endpoint")
  }
  let host
  try {
    host = new URL(url).hostname
  } catch {
    throw new GateConfigError("refused: the gate database URL does not parse")
  }
  if (host && !LOOPBACK_HOSTS.has(host)) throw new GateConfigError("refused: the gate database must be on loopback")
  return url
}

/**
 * The environment every gate child runs with. With a database configured it
 * refuses an inherited value that names a forbidden endpoint (a misconfigured
 * shell), then OVERRIDES every database key with the local URL, so nothing the
 * gate runs can reach a shared database. Without one, `base` is returned as is.
 */
export function gateEnv(base, db, url) {
  if (!db?.enabled) return { ...base }
  const keys = Array.isArray(db.envKeys) && db.envKeys.length ? db.envKeys : DEFAULT_GATE_DATABASE.envKeys
  for (const k of keys) {
    const v = base?.[k]
    if (typeof v === "string" && (db.forbid ?? []).some((f) => typeof f === "string" && f && v.includes(f))) {
      throw new GateConfigError(`refused: the inherited ${k} names a forbidden endpoint; unset it and re-run`)
    }
  }
  assertLocalDatabaseUrl(url, db.forbid ?? [])
  const env = { ...base }
  for (const k of keys) env[k] = url
  return env
}

const entryCmd = (e) => (typeof e === "string" ? e : isPlainObject(e) ? e.cmd : undefined)

/**
 * The ordered step list. `critical` steps (the database bring-up) skip every
 * later non-`always` step when they fail: suites against a database that never
 * came up only produce noise. `always` steps (the teardown) run regardless.
 * A gate entry may carry `expect`, a regular expression its output must match
 * (a silently skipped suite also exits 0).
 *
 * @param {object} gates      config.gates
 * @param {object} ctx        {missionDir, milestone, port, dataDir, logDir, url}
 * @param {string[]} [rerun]  argv of the verifiedBy re-run step (omitted: none)
 * @returns {Array<{name:string, cmd?:string, argv?:string[], critical?:boolean, always?:boolean, expect?:string, why?:string}>}
 */
export function buildGatePlan(gates, ctx, rerun = null) {
  const db = gateDatabase(gates)
  const vars = { ...ctx }
  const steps = []
  const push = (name, raw, extra = {}) => {
    const cmd = entryCmd(raw)
    if (typeof cmd !== "string" || !cmd.trim()) throw new GateConfigError(`${name}: a gate entry has no cmd`)
    const step = { name, cmd: expandGateCommand(cmd, vars), ...extra }
    if (isPlainObject(raw) && typeof raw.why === "string") step.why = raw.why
    if (isPlainObject(raw) && typeof raw.expect === "string") {
      try {
        new RegExp(raw.expect)
      } catch {
        throw new GateConfigError(`${name}: expect is not a valid regular expression`)
      }
      step.expect = raw.expect
    }
    steps.push(step)
  }
  if (db.enabled) (db.setup ?? []).forEach((c, i) => push(`db-setup-${i + 1}`, c, { critical: true }))
  ;(gates?.pre ?? []).forEach((c, i) => push(`pre-${i + 1}`, c))
  const integration = gates?.integration ?? []
  if (!integration.length) throw new GateConfigError("gates.integration is empty: a milestone would advance on nothing")
  integration.forEach((c, i) => push(`gate-${i + 1}`, c))
  if (Array.isArray(rerun) && rerun.length) steps.push({ name: "rerun-verified", argv: rerun })
  if (db.enabled) (db.teardown ?? []).forEach((c, i) => push(`db-teardown-${i + 1}`, c, { always: true }))
  return steps
}

/**
 * The `set-gate integration` payload. Green needs every non-`always` step at
 * exit 0 and every `expect` matched. Teardown failures do not redden the gate
 * (the suites already ran), but they are recorded.
 */
export function gateRecord(milestone, results) {
  const counted = results.filter((r) => !r.always)
  const passed = counted.length > 0 && counted.every((r) => r.exitCode === 0 && !r.expectFailed)
  const red = counted.filter((r) => r.exitCode !== 0 || r.expectFailed).map((r) => r.name)
  return {
    passed,
    milestone,
    scope: `${milestone}: whole-repository gate, ${counted.length} step(s)${red.length ? `; red: ${red.join(", ")}` : ", all green"}`,
    commands: results.map(({ name, cmd, exitCode, log, skipped, expectFailed }) => ({
      name,
      cmd,
      exitCode,
      log,
      ...(skipped ? { skipped } : {}),
      ...(expectFailed ? { expectFailed: true } : {}),
    })),
  }
}

/** What one step may take: the smaller of the step cap and the deadline left. */
export function stepTimeout(deadline, now) {
  return Math.max(1_000, Math.min(STEP_CAP_MS, deadline - now))
}
