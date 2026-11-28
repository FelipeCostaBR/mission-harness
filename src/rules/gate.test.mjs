import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_GATE_DATABASE,
  gateDatabase,
  gateDatabaseUrl,
  expandGateCommand,
  assertLocalDatabaseUrl,
  gateEnv,
  buildGatePlan,
  gateRecord,
  stepTimeout,
  STEP_CAP_MS,
  GateConfigError,
} from "./gate.mjs"

const ctx = { missionDir: "docs/prd/demo", milestone: "M1", port: 5456, dataDir: "/tmp/g x/data", logDir: "/tmp/logs", url: "postgresql://u@127.0.0.1:5456/gate" }

test("gateDatabase merges the defaults; disabled unless configured", () => {
  assert.deepEqual(gateDatabase({}), { ...DEFAULT_GATE_DATABASE })
  assert.equal(gateDatabase({ database: { enabled: true, port: 6000 } }).port, 6000)
  assert.deepEqual(gateDatabase({ database: { enabled: true } }).envKeys, ["DATABASE_URL"])
  assert.equal(gateDatabase(undefined).enabled, false)
})

test("expandGateCommand fills the placeholders, quoting every path; gateDatabaseUrl fills raw", () => {
  assert.equal(expandGateCommand("initdb -D {dataDir} -p {port}", ctx), "initdb -D '/tmp/g x/data' -p 5456")
  assert.equal(expandGateCommand("echo {missionDir} {milestone} {logDir}", ctx), "echo 'docs/prd/demo' 'M1' '/tmp/logs'")
  assert.equal(expandGateCommand("echo {unknown} {url}", { url: null }), "echo {unknown} {url}")
  assert.equal(expandGateCommand("x {dataDir}", { dataDir: "a'b" }), "x 'a'\\''b'")
  assert.equal(gateDatabaseUrl({ url: "postgresql://u@127.0.0.1:{port}/gate" }, { port: 5457 }), "postgresql://u@127.0.0.1:5457/gate")
  assert.equal(gateDatabaseUrl({ url: "file:{dataDir}/db.sqlite" }, { port: 1, dataDir: "/tmp/d" }), "file:/tmp/d/db.sqlite")
})

test("assertLocalDatabaseUrl: loopback or host-less only; forbidden endpoints refused without echoing the value", () => {
  assert.equal(assertLocalDatabaseUrl("postgresql://u@127.0.0.1:5456/x"), "postgresql://u@127.0.0.1:5456/x")
  assert.ok(assertLocalDatabaseUrl("postgresql://u@localhost/x"))
  assert.ok(assertLocalDatabaseUrl("mysql://u@[::1]:3306/x"))
  assert.ok(assertLocalDatabaseUrl("file:/tmp/db.sqlite"))
  assert.throws(() => assertLocalDatabaseUrl("postgresql://u@db.example.com/x"), /loopback/)
  assert.throws(() => assertLocalDatabaseUrl(""), /empty/)
  assert.throws(() => assertLocalDatabaseUrl("not a url"), /does not parse/)
  assert.throws(
    () => assertLocalDatabaseUrl("postgresql://u@127.0.0.1/prod-main", ["prod-main"]),
    (e) => e instanceof GateConfigError && /forbidden/.test(e.message) && !e.message.includes("prod-main"),
  )
})

test("gateEnv overrides every database key with the local URL and refuses a forbidden inherited value", () => {
  const db = { ...DEFAULT_GATE_DATABASE, enabled: true, envKeys: ["DATABASE_URL", "DATABASE_URL_POOLED"], forbid: ["prod-host"] }
  const env = gateEnv({ PATH: "/bin", DATABASE_URL: "postgresql://staging.example/x" }, db, ctx.url)
  assert.equal(env.DATABASE_URL, ctx.url)
  assert.equal(env.DATABASE_URL_POOLED, ctx.url)
  assert.equal(env.PATH, "/bin")
  assert.throws(() => gateEnv({ DATABASE_URL_POOLED: "postgresql://u@prod-host/x" }, db, ctx.url), /inherited DATABASE_URL_POOLED names a forbidden endpoint/)
  assert.throws(() => gateEnv({}, db, "postgresql://u@remote.example/x"), /loopback/)
  const base = { DATABASE_URL: "anything" }
  assert.deepEqual(gateEnv(base, { enabled: false }, null), base, "no database configured: the environment is passed through")
  assert.notEqual(gateEnv(base, { enabled: false }, null), base, "as a copy")
})

test("buildGatePlan: database setup (critical), pre, every integration entry, the re-run, teardown (always)", () => {
  const gates = {
    pre: ["rm -f *.tsbuildinfo"],
    integration: [{ cmd: "npm test", why: "every suite", expect: "\\d+ passing" }, "npx tsc --noEmit"],
    database: { enabled: true, setup: ["initdb -D {dataDir}", "pg_ctl -D {dataDir} -o '-p {port}' start"], teardown: ["pg_ctl -D {dataDir} stop"] },
  }
  const plan = buildGatePlan(gates, ctx, ["node", "cli.mjs", "state", "x", "rerun-verified", "M1"])
  assert.deepEqual(plan.map((s) => [s.name, !!s.critical, !!s.always]), [
    ["db-setup-1", true, false],
    ["db-setup-2", true, false],
    ["pre-1", false, false],
    ["gate-1", false, false],
    ["gate-2", false, false],
    ["rerun-verified", false, false],
    ["db-teardown-1", false, true],
  ])
  assert.equal(plan[0].cmd, "initdb -D '/tmp/g x/data'")
  assert.equal(plan[3].expect, "\\d+ passing")
  assert.equal(plan[3].why, "every suite")
  assert.deepEqual(plan[5].argv, ["node", "cli.mjs", "state", "x", "rerun-verified", "M1"])
  const noDb = buildGatePlan({ pre: [], integration: ["make check"], database: { enabled: false, setup: ["never"] } }, ctx)
  assert.deepEqual(noDb.map((s) => s.name), ["gate-1"], "a disabled database adds no steps; no re-run argv, no re-run step")
  assert.throws(() => buildGatePlan({ integration: [] }, ctx), /integration is empty/)
  assert.throws(() => buildGatePlan({ integration: [{ why: "no cmd" }] }, ctx), /no cmd/)
  assert.throws(() => buildGatePlan({ integration: [{ cmd: "x", expect: "(" }] }, ctx), /expect is not a valid/)
})

test("gateRecord: green needs every counted step at 0 and every expect matched; teardown is recorded, not counted", () => {
  const ok = [
    { name: "gate-1", cmd: "a", exitCode: 0, log: "l1" },
    { name: "db-teardown-1", cmd: "t", exitCode: 1, log: "l2", always: true },
  ]
  const g = gateRecord("M1", ok)
  assert.equal(g.passed, true)
  assert.equal(g.milestone, "M1")
  assert.match(g.scope, /^M1: whole-repository gate, 1 step\(s\), all green/)
  assert.equal(g.commands.length, 2)
  assert.equal(gateRecord("M1", [{ name: "gate-1", exitCode: 0, expectFailed: true }]).passed, false, "a silently skipped suite is not green")
  const red = gateRecord("M1", [{ name: "gate-1", exitCode: 0 }, { name: "gate-2", exitCode: 1 }, { name: "rerun-verified", exitCode: null, skipped: "deadline" }])
  assert.equal(red.passed, false)
  assert.match(red.scope, /red: gate-2, rerun-verified/)
  assert.equal(red.commands[2].skipped, "deadline")
  assert.equal(gateRecord("M1", []).passed, false, "nothing ran is never green")
})

test("stepTimeout: the smaller of the cap and the deadline left, never under a second", () => {
  assert.equal(stepTimeout(Infinity, 0), STEP_CAP_MS)
  assert.equal(stepTimeout(10_000, 4_000), 6_000)
  assert.equal(stepTimeout(1_000, 5_000), 1_000)
})
