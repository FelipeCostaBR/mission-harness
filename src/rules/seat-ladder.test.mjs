/**
 * seat-ladder.mjs against the values ML-003 states, and resolveSeat,
 * rungOfSeat, sameCheckFailedBefore and the CLI against ML-010 and ML-011. The
 * expected tables below are typed out independently of seat-ladder.json, so a
 * drifted rung or role fails here. checkRoleSeats is the structural rule; the
 * negative controls feed it bad input to prove it can fail. The resolveSeat
 * expectations are written from the rule's statement, one rung id at a time,
 * not computed from the table.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  CORRECTIVE_CAUSES,
  LADDER,
  PROFILE_NAMES,
  ROLE_SEATS,
  SEAT_PROFILES,
  SESSION_SEATS,
  TRIGGERS,
  resolveSeat,
  rungOfSeat,
  runCLI,
  sameCheckFailedBefore,
} from "./seat-ladder.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))

const SIZE_TIERS = ["small", "normal", "large"]

const KNOWN_TRIGGERS = [
  "assertion",
  "gate",
  "schema",
  "low-confidence",
  "gate-repeat",
  "recheck",
  "dispute",
  "ambiguous",
]

/** Returns one message per defect; an empty array means the table is sound. */
function checkRoleSeats(roles, ladder, triggers = KNOWN_TRIGGERS) {
  const rank = new Map(ladder.map((rung, i) => [rung.id, i]))
  const defects = []
  for (const [role, seat] of Object.entries(roles)) {
    if (!rank.has(seat.start)) defects.push(`${role}: start ${seat.start} is not a rung`)
    if (!rank.has(seat.ceiling)) defects.push(`${role}: ceiling ${seat.ceiling} is not a rung`)
    if (rank.has(seat.start) && rank.has(seat.ceiling) && rank.get(seat.start) > rank.get(seat.ceiling)) {
      defects.push(`${role}: start ${seat.start} is above ceiling ${seat.ceiling}`)
    }
    for (const trigger of seat.climbOn) {
      if (trigger === "infra" || trigger === "spec") {
        defects.push(`${role}: climbOn names ${trigger}, which resolveSeat decides before any climb`)
      } else if (!triggers.includes(trigger)) {
        defects.push(`${role}: climbOn names unknown trigger ${trigger}`)
      }
    }
    if (role === "worker" && !seat.sizeStart) defects.push("worker: sizeStart is missing")
    if (seat.sizeStart) {
      for (const tier of SIZE_TIERS) {
        const value = seat.sizeStart[tier]
        if (!rank.has(value)) defects.push(`${role}: sizeStart.${tier} ${value} is not a rung`)
        else if (rank.has(seat.ceiling) && rank.get(value) > rank.get(seat.ceiling)) {
          defects.push(`${role}: sizeStart.${tier} ${value} is above ceiling ${seat.ceiling}`)
        }
      }
      if (seat.start !== seat.sizeStart.normal) {
        defects.push(`${role}: start ${seat.start} differs from sizeStart.normal ${seat.sizeStart.normal}`)
      }
    }
  }
  return defects
}

describe("LADDER", () => {
  test("is exactly the seven rungs in order", () => {
    assert.deepEqual(LADDER, [
      { id: "L0", model: "haiku", effort: "low" },
      { id: "L1", model: "haiku", effort: "medium" },
      { id: "L2", model: "sonnet", effort: "medium" },
      { id: "L3", model: "sonnet", effort: "high" },
      { id: "L4", model: "opus", effort: "high" },
      { id: "L5", model: "opus", effort: "xhigh" },
      { id: "L6", model: "opus", effort: "max" },
    ])
  })
})

describe("ROLE_SEATS", () => {
  test("holds exactly today's seats for exactly the eight roles", () => {
    assert.deepEqual(ROLE_SEATS, {
      worker: {
        start: "L3",
        sizeStart: { small: "L3", normal: "L3", large: "L3" },
        ceiling: "L5",
        climbOn: ["assertion", "gate"],
      },
      simplify: { start: "L3", ceiling: "L3", climbOn: [] },
      scout: { start: "L3", ceiling: "L4", climbOn: ["schema", "low-confidence"] },
      fixer: { start: "L3", ceiling: "L5", climbOn: ["gate-repeat"] },
      verifier: { start: "L2", ceiling: "L3", climbOn: ["gate-repeat"] },
      validator: { start: "L5", ceiling: "L6", climbOn: ["recheck", "dispute"] },
      "screenshot-validator": { start: "L5", ceiling: "L6", climbOn: ["ambiguous"] },
      reviewer: { start: "L5", ceiling: "L6", climbOn: [], model: "opus[1m]" },
    })
  })

  test("only the reviewer overrides the rung's model", () => {
    const overriding = Object.entries(ROLE_SEATS)
      .filter(([, seat]) => "model" in seat)
      .map(([role]) => role)
    assert.deepEqual(overriding, ["reviewer"])
  })

  test("no role starts on Haiku (owner ruling 2026-10-14)", () => {
    for (const [role, seat] of Object.entries(ROLE_SEATS)) {
      const start = LADDER.find((rung) => rung.id === seat.start)
      assert.notEqual(start.model, "haiku", role)
    }
  })

  test("passes the structural check", () => {
    assert.deepEqual(checkRoleSeats(ROLE_SEATS, LADDER), [])
  })
})

describe("checkRoleSeats negative controls", () => {
  test("fails a role whose start is above its ceiling", () => {
    const bad = { ...ROLE_SEATS, fixer: { start: "L5", ceiling: "L3", climbOn: ["gate-repeat"] } }
    assert.deepEqual(checkRoleSeats(bad, LADDER), ["fixer: start L5 is above ceiling L3"])
  })

  test("accepts start equal to ceiling (simplify)", () => {
    assert.deepEqual(checkRoleSeats({ simplify: ROLE_SEATS.simplify }, LADDER), [])
  })

  test("fails a climbOn naming an unknown trigger", () => {
    const bad = { ...ROLE_SEATS, scout: { start: "L3", ceiling: "L4", climbOn: ["schema", "vibes"] } }
    assert.deepEqual(checkRoleSeats(bad, LADDER), ["scout: climbOn names unknown trigger vibes"])
  })

  test("fails a climbOn naming infra or spec", () => {
    for (const reserved of ["infra", "spec"]) {
      const bad = { ...ROLE_SEATS, fixer: { ...ROLE_SEATS.fixer, climbOn: ["gate-repeat", reserved] } }
      assert.deepEqual(checkRoleSeats(bad, LADDER), [
        `fixer: climbOn names ${reserved}, which resolveSeat decides before any climb`,
      ])
    }
  })

  test("fails a sizeStart value that is not a rung", () => {
    const bad = { worker: { ...ROLE_SEATS.worker, sizeStart: { small: "L9", normal: "L3", large: "L3" } } }
    assert.deepEqual(checkRoleSeats(bad, LADDER), ["worker: sizeStart.small L9 is not a rung"])
  })

  test("fails a sizeStart tier that is missing", () => {
    const bad = { worker: { ...ROLE_SEATS.worker, sizeStart: { small: "L3", normal: "L3" } } }
    assert.deepEqual(checkRoleSeats(bad, LADDER), ["worker: sizeStart.large undefined is not a rung"])
  })

  test("fails a sizeStart value above the worker ceiling", () => {
    const bad = { worker: { ...ROLE_SEATS.worker, sizeStart: { small: "L3", normal: "L3", large: "L6" } } }
    assert.deepEqual(checkRoleSeats(bad, LADDER), ["worker: sizeStart.large L6 is above ceiling L5"])
  })

  test("accepts a sizeStart value equal to the ceiling", () => {
    const ok = { worker: { ...ROLE_SEATS.worker, sizeStart: { small: "L3", normal: "L3", large: "L5" } } }
    assert.deepEqual(checkRoleSeats(ok, LADDER), [])
  })

  test("fails a worker whose start differs from sizeStart.normal", () => {
    const bad = { worker: { ...ROLE_SEATS.worker, start: "L4" } }
    assert.deepEqual(checkRoleSeats(bad, LADDER), ["worker: start L4 differs from sizeStart.normal L3"])
  })

  test("fails a worker with no sizeStart", () => {
    const { sizeStart: _omitted, ...bare } = ROLE_SEATS.worker
    assert.deepEqual(checkRoleSeats({ worker: bare }, LADDER), ["worker: sizeStart is missing"])
  })

  test("fails a start or ceiling that is not a rung", () => {
    const bad = { fixer: { start: "L9", ceiling: "L-1", climbOn: [] } }
    assert.deepEqual(checkRoleSeats(bad, LADDER), [
      "fixer: start L9 is not a rung",
      "fixer: ceiling L-1 is not a rung",
    ])
  })
})

describe("SESSION_SEATS", () => {
  test("planner and orchestrator are opus/xhigh, the orchestrator with a sonnet/high trial", () => {
    assert.deepEqual(SESSION_SEATS, {
      planner: { model: "opus", effort: "xhigh" },
      orchestrator: {
        model: "opus",
        effort: "xhigh",
        trial: { model: "sonnet", effort: "high" },
      },
    })
  })

  test("the session seats name the L5 rung's model and effort", () => {
    const l5 = LADDER.find((rung) => rung.id === "L5")
    for (const seat of Object.values(SESSION_SEATS)) {
      assert.equal(seat.model, l5.model)
      assert.equal(seat.effort, l5.effort)
    }
  })
})

describe("loading", () => {
  test("reads the JSON relative to the module, not the cwd", () => {
    const href = JSON.stringify(pathToFileURL(path.join(HERE, "seat-ladder.mjs")).href)
    const script = `import(${href}).then((m) => console.log(m.LADDER.length))`
    const run = spawnSync(process.execPath, ["-e", script], { cwd: "/", encoding: "utf8" })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.trim(), "7")
  })
})

/** A table whose worker sizeStart differs per tier, so each sizeTier branch has its own answer. */
const SPLIT_TABLE = {
  ...{ ladder: LADDER, sessionSeats: SESSION_SEATS },
  roles: {
    ...ROLE_SEATS,
    worker: { ...ROLE_SEATS.worker, start: "L2", sizeStart: { small: "L1", normal: "L2", large: "L4" } },
  },
}

const seatOf = (result) => `${result.model}/${result.effort}`

describe("TRIGGERS", () => {
  test("is every climbOn trigger plus infra and spec", () => {
    assert.deepEqual([...TRIGGERS].sort(), [...KNOWN_TRIGGERS, "infra", "spec"].sort())
  })
})

describe("resolveSeat: start rung (previousRung null)", () => {
  test("returns each role's start rung and ignores a missing or bogus trigger", () => {
    const expected = {
      worker: "L3",
      simplify: "L3",
      scout: "L3",
      fixer: "L3",
      validator: "L5",
      "screenshot-validator": "L5",
      reviewer: "L5",
    }
    for (const [role, rung] of Object.entries(expected)) {
      for (const trigger of [undefined, "infra", "not-a-trigger"]) {
        const got = resolveSeat({ role, previousRung: null, trigger })
        assert.equal(got.rung, rung, `${role} ${trigger}`)
        assert.equal(got.climbed, false)
        assert.equal(got.route, null)
      }
    }
  })

  test("reports atCeiling only where start is the ceiling", () => {
    assert.equal(resolveSeat({ role: "simplify", previousRung: null }).atCeiling, true)
    assert.equal(resolveSeat({ role: "worker", previousRung: null }).atCeiling, false)
  })

  test("reads a missing sizeTier as normal and picks sizeStart per tier from the injected table", () => {
    const pick = (sizeTier) => resolveSeat({ role: "worker", previousRung: null, sizeTier }, SPLIT_TABLE).rung
    assert.equal(pick("small"), "L1")
    assert.equal(pick("normal"), "L2")
    assert.equal(pick("large"), "L4")
    assert.equal(pick(undefined), "L2")
    assert.equal(pick(null), "L2")
  })

  test("every tier is L3 for the worker in today's table", () => {
    for (const sizeTier of SIZE_TIERS) {
      assert.equal(resolveSeat({ role: "worker", previousRung: null, sizeTier }).rung, "L3")
    }
  })

  test("sizeTier moves no role but the worker", () => {
    assert.equal(resolveSeat({ role: "scout", previousRung: null, sizeTier: "large" }, SPLIT_TABLE).rung, "L3")
  })

  test("reports the role's model override on the start seat", () => {
    assert.equal(seatOf(resolveSeat({ role: "reviewer", previousRung: null })), "opus[1m]/xhigh")
    assert.equal(seatOf(resolveSeat({ role: "validator", previousRung: null })), "opus/xhigh")
  })
})

describe("resolveSeat: throws a TypeError", () => {
  const bad = [
    ["an unknown role", { role: "intern", previousRung: null }],
    ["an inherited property as the role", { role: "constructor", previousRung: null }],
    ["a missing role", { previousRung: null }],
    ["an unknown rung", { role: "worker", previousRung: "L9", trigger: "gate" }],
    ["an unknown sizeTier", { role: "worker", previousRung: null, sizeTier: "huge" }],
    ["an unknown sizeTier for a non-worker", { role: "scout", previousRung: null, sizeTier: "huge" }],
    ["an unknown sizeTier alongside a previousRung", { role: "worker", previousRung: "L3", trigger: "gate", sizeTier: "huge" }],
    ["a missing trigger", { role: "worker", previousRung: "L3" }],
    ["a trigger outside TRIGGERS", { role: "worker", previousRung: "L3", trigger: "vibes" }],
    ["a non-string trigger", { role: "worker", previousRung: "L3", trigger: 3 }],
  ]
  for (const [name, input] of bad) {
    test(name, () => assert.throws(() => resolveSeat(input), TypeError))
  }

  test("no input object", () => {
    assert.throws(() => resolveSeat(null), TypeError)
    assert.throws(() => resolveSeat(undefined), TypeError)
  })

  test("a trigger outside the injected table's TRIGGERS, though the default table has it", () => {
    const table = { ...SPLIT_TABLE, roles: { worker: SPLIT_TABLE.roles.worker } }
    assert.throws(() => resolveSeat({ role: "worker", previousRung: "L2", trigger: "recheck" }, table), TypeError)
  })

  test("a sameCheckFailedBefore that is present and not a boolean, on every path", () => {
    for (const sameCheckFailedBefore of ["true", "false", 1, 0, null, {}, []]) {
      const label = JSON.stringify(sameCheckFailedBefore)
      assert.throws(
        () => resolveSeat({ role: "worker", previousRung: "L3", trigger: "gate", sameCheckFailedBefore }),
        { name: "TypeError", message: /sameCheckFailedBefore must be a boolean/ },
        label,
      )
      assert.throws(() => resolveSeat({ role: "worker", previousRung: null, sameCheckFailedBefore }), TypeError, label)
      assert.throws(() => resolveSeat({ role: "fixer", previousRung: "L3", trigger: "gate-repeat", sameCheckFailedBefore }), TypeError, label)
    }
  })
})

describe("resolveSeat: an absent previousRung and an absent sameCheckFailedBefore", () => {
  test("an absent or undefined previousRung reads as null: the start rung, the trigger ignored", () => {
    for (const input of [
      { role: "worker", trigger: "gate" },
      { role: "worker", previousRung: undefined, trigger: "assertion", sameCheckFailedBefore: true },
      { role: "worker", trigger: "not-a-trigger" },
    ]) {
      const got = resolveSeat(input)
      assert.deepEqual({ rung: got.rung, climbed: got.climbed, route: got.route }, { rung: "L3", climbed: false, route: null }, JSON.stringify(input))
    }
    assert.equal(resolveSeat({ role: "worker", trigger: "gate", sizeTier: "large" }, SPLIT_TABLE).rung, "L4")
    assert.equal(resolveSeat({ role: "validator" }).rung, "L5")
  })

  test("an absent and an explicitly undefined sameCheckFailedBefore both climb one rung", () => {
    assert.equal(resolveSeat({ role: "worker", previousRung: "L3", trigger: "gate" }).rung, "L4")
    assert.equal(resolveSeat({ role: "worker", previousRung: "L3", trigger: "gate", sameCheckFailedBefore: undefined }).rung, "L4")
  })
})

describe("resolveSeat: infra and spec are decided first", () => {
  test("infra keeps the rung without climbing, for a role that does not list it", () => {
    for (const [role, rung] of [["worker", "L4"], ["scout", "L4"], ["reviewer", "L5"], ["simplify", "L3"]]) {
      const got = resolveSeat({ role, previousRung: rung, trigger: "infra", sameCheckFailedBefore: true })
      assert.equal(got.rung, rung)
      assert.equal(got.climbed, false)
      assert.equal(got.route, null)
    }
  })

  test("infra at the scout's ceiling does not hand over to the reviewer", () => {
    const got = resolveSeat({ role: "scout", previousRung: "L4", trigger: "infra" })
    assert.equal(got.route, null)
    assert.equal(got.rung, "L4")
  })

  test("spec keeps the rung and routes to the contract", () => {
    const got = resolveSeat({ role: "worker", previousRung: "L3", trigger: "spec", sameCheckFailedBefore: true })
    assert.deepEqual(
      { rung: got.rung, climbed: got.climbed, route: got.route, atCeiling: got.atCeiling },
      { rung: "L3", climbed: false, route: "contract", atCeiling: false },
    )
  })

  test("spec at the scout's ceiling routes to the contract, not the reviewer", () => {
    assert.equal(resolveSeat({ role: "scout", previousRung: "L4", trigger: "spec" }).route, "contract")
  })

  test("infra and spec return the ceiling for a previousRung above it", () => {
    for (const trigger of ["infra", "spec"]) {
      const got = resolveSeat({ role: "worker", previousRung: "L6", trigger })
      assert.equal(got.rung, "L5")
      assert.equal(got.climbed, false)
      assert.equal(got.atCeiling, true)
    }
  })
})

describe("resolveSeat: the scout hands over to the reviewer at its ceiling", () => {
  for (const trigger of ["schema", "low-confidence"]) {
    test(`on ${trigger}`, () => {
      const got = resolveSeat({ role: "scout", previousRung: "L4", trigger })
      assert.equal(got.route, "reviewer")
      assert.equal(got.rung, "L4")
      assert.equal(seatOf(got), "opus/high")
      assert.equal(got.climbed, false)
      assert.equal(got.atCeiling, true)
    })
  }

  test("a scout above its ceiling, at L5 or L6, carries the ceiling seat and the reviewer route", () => {
    for (const previousRung of ["L5", "L6"]) {
      for (const trigger of ["schema", "low-confidence"]) {
        for (const sameCheckFailedBefore of [true, false]) {
          const label = `${previousRung} ${trigger} ${sameCheckFailedBefore}`
          const got = resolveSeat({ role: "scout", previousRung, trigger, sameCheckFailedBefore })
          assert.equal(got.route, "reviewer", label)
          assert.equal(got.rung, "L4", label)
          assert.equal(seatOf(got), "opus/high", label)
          assert.equal(got.climbed, false, label)
          assert.equal(got.atCeiling, true, label)
          assert.match(got.reason, new RegExp(`^scout at ${previousRung}, at or above its ceiling L4, on ${trigger}:`), label)
        }
      }
    }
  })

  test("a scout below its ceiling climbs instead", () => {
    const got = resolveSeat({ role: "scout", previousRung: "L3", trigger: "schema" })
    assert.equal(got.route, null)
    assert.equal(got.rung, "L4")
    assert.equal(got.climbed, true)
  })

  test("another role at its ceiling does not route to the reviewer", () => {
    assert.equal(resolveSeat({ role: "worker", previousRung: "L5", trigger: "gate" }).route, null)
  })

  test("a scout's trigger outside its climbOn keeps the rung, no handover", () => {
    const got = resolveSeat({ role: "scout", previousRung: "L4", trigger: "assertion" })
    assert.equal(got.route, null)
    assert.equal(got.rung, "L4")
  })

  test("a trigger outside the role's climbOn keeps the rung before gate-repeat is considered", () => {
    for (const role of ["worker", "scout"]) {
      const got = resolveSeat({ role, previousRung: "L3", trigger: "gate-repeat" })
      assert.deepEqual({ rung: got.rung, climbed: got.climbed, route: got.route }, { rung: "L3", climbed: false, route: null }, role)
    }
  })
})

describe("resolveSeat: climbing", () => {
  test("a climbOn trigger climbs one rung", () => {
    const got = resolveSeat({ role: "worker", previousRung: "L3", trigger: "assertion" })
    assert.deepEqual(
      { rung: got.rung, climbed: got.climbed, atCeiling: got.atCeiling, route: got.route },
      { rung: "L4", climbed: true, atCeiling: false, route: null },
    )
    assert.equal(seatOf(got), "opus/high")
  })

  test("sameCheckFailedBefore false or absent climbs one rung", () => {
    for (const sameCheckFailedBefore of [false, undefined]) {
      assert.equal(resolveSeat({ role: "worker", previousRung: "L3", trigger: "gate", sameCheckFailedBefore }).rung, "L4")
    }
  })

  test("sameCheckFailedBefore true climbs two rungs", () => {
    const got = resolveSeat({ role: "worker", previousRung: "L3", trigger: "gate", sameCheckFailedBefore: true })
    assert.equal(got.rung, "L5")
    assert.equal(got.climbed, true)
    assert.equal(got.atCeiling, true)
  })

  test("two rungs clamp at the ceiling and report one real climb", () => {
    const got = resolveSeat({ role: "worker", previousRung: "L4", trigger: "assertion", sameCheckFailedBefore: true })
    assert.equal(got.rung, "L5")
    assert.equal(got.climbed, true)
    assert.match(got.reason, /L4 to L5/)
  })

  test("gate-repeat climbs exactly one rung whatever sameCheckFailedBefore says", () => {
    for (const sameCheckFailedBefore of [true, false, undefined]) {
      const got = resolveSeat({ role: "fixer", previousRung: "L3", trigger: "gate-repeat", sameCheckFailedBefore })
      assert.equal(got.rung, "L4", String(sameCheckFailedBefore))
    }
  })

  test("a trigger the role does not climb on keeps the rung, sameCheckFailedBefore or not", () => {
    for (const [role, trigger] of [["worker", "recheck"], ["fixer", "assertion"], ["simplify", "gate"], ["reviewer", "dispute"]]) {
      const rung = role === "reviewer" ? "L5" : "L3"
      const got = resolveSeat({ role, previousRung: rung, trigger, sameCheckFailedBefore: true })
      assert.equal(got.rung, rung, `${role} ${trigger}`)
      assert.equal(got.climbed, false)
    }
  })

  test("a role at its ceiling stays there and reports atCeiling", () => {
    const got = resolveSeat({ role: "worker", previousRung: "L5", trigger: "assertion" })
    assert.deepEqual({ rung: got.rung, climbed: got.climbed, atCeiling: got.atCeiling }, { rung: "L5", climbed: false, atCeiling: true })
  })

  test("a previousRung above the ceiling returns the ceiling, for a climbing trigger too", () => {
    const got = resolveSeat({ role: "worker", previousRung: "L6", trigger: "assertion", sameCheckFailedBefore: true })
    assert.equal(got.rung, "L5")
    assert.equal(got.climbed, false)
    assert.equal(got.atCeiling, true)
  })

  test("the validator climbs to L6, the reviewer's model override survives", () => {
    assert.equal(seatOf(resolveSeat({ role: "validator", previousRung: "L5", trigger: "dispute" })), "opus/max")
    const reviewer = resolveSeat({ role: "validator", previousRung: "L5", trigger: "recheck" }, {
      ...SPLIT_TABLE,
      roles: { ...SPLIT_TABLE.roles, validator: { ...SPLIT_TABLE.roles.validator, model: "opus[1m]" } },
    })
    assert.equal(seatOf(reviewer), "opus[1m]/max")
  })

  test("the simplify role never climbs", () => {
    assert.equal(resolveSeat({ role: "simplify", previousRung: "L3", trigger: "gate" }).rung, "L3")
  })

  test("climbed is true exactly when the rung is above previousRung, over every role, rung and trigger", () => {
    const rankOf = (id) => LADDER.findIndex((r) => r.id === id)
    for (const role of Object.keys(ROLE_SEATS)) {
      for (const { id } of LADDER) {
        for (const trigger of TRIGGERS) {
          for (const sameCheckFailedBefore of [true, false]) {
            const got = resolveSeat({ role, previousRung: id, trigger, sameCheckFailedBefore })
            const label = `${role} ${id} ${trigger} ${sameCheckFailedBefore}`
            assert.equal(got.climbed, rankOf(got.rung) > rankOf(id), label)
            assert.ok(rankOf(got.rung) <= rankOf(ROLE_SEATS[role].ceiling), label)
            assert.equal(got.atCeiling, got.rung === ROLE_SEATS[role].ceiling, label)
            assert.ok(got.route === null || got.route === "contract" || got.route === "reviewer", label)
          }
        }
      }
    }
  })
})

describe("rungOfSeat", () => {
  test("maps every ladder rung's <model>/<effort> to its id", () => {
    for (const rung of LADDER) assert.equal(rungOfSeat(`${rung.model}/${rung.effort}`), rung.id)
  })

  test("reads a context-window suffix (`opus[1m]`) as its bare model", () => {
    assert.equal(rungOfSeat("opus[1m]/xhigh"), "L5")
    assert.equal(rungOfSeat("opus[1m]/high"), "L4")
    assert.equal(rungOfSeat("sonnet[1m]/high"), "L3")
    assert.equal(rungOfSeat("gpt[1m]/high"), null)
  })

  test("returns null for a bare tier and the archived shapes, never throwing", () => {
    for (const seat of [
      "opus", "sonnet", "haiku", "orchestrator", "base", "opus (module-worker)", "",
      "sonnet/", "/high", "sonnet/ultra", "gpt/high", "sonnet/high/extra", " sonnet/high", "Sonnet/high", "sonnet/high ",
    ]) {
      assert.equal(rungOfSeat(seat), null, JSON.stringify(seat))
    }
  })

  test("returns null for a non-string", () => {
    for (const seat of [undefined, null, 3, {}, ["sonnet/high"]]) assert.equal(rungOfSeat(seat), null)
  })
})

describe("sameCheckFailedBefore", () => {
  const log = [
    { milestone: "M1", round: 1, type: "corrective", trigger: ["A-1", "A-2"] },
    { milestone: "M2", round: 1, type: "corrective", trigger: ["B-1"] },
    { milestone: "M1", round: 2, type: "corrective", trigger: ["A-3"] },
    { milestone: "M1", round: 3, type: "adversarial", trigger: ["A-3"] },
    { milestone: "M1", round: 4, type: "hardening", trigger: ["A-9"] },
  ]

  test("compares with the milestone's newest corrective entry only", () => {
    assert.equal(sameCheckFailedBefore(log, "M1", ["A-3"]), true)
    assert.equal(sameCheckFailedBefore(log, "M1", ["A-1"]), false)
  })

  test("shares any one id among several", () => {
    assert.equal(sameCheckFailedBefore(log, "M1", ["Z-1", "A-3"]), true)
  })

  test("ignores another milestone's entries and non-corrective types", () => {
    assert.equal(sameCheckFailedBefore(log, "M2", ["A-3"]), false)
    assert.equal(sameCheckFailedBefore(log, "M2", ["B-1"]), true)
    assert.equal(sameCheckFailedBefore(log, "M1", ["A-9"]), false)
  })

  test("the newest is the highest round even when the log is out of order", () => {
    const shuffled = [log[2], log[0]]
    assert.equal(sameCheckFailedBefore(shuffled, "M1", ["A-3"]), true)
    assert.equal(sameCheckFailedBefore(shuffled, "M1", ["A-1"]), false)
  })

  test("two corrective entries with the same round: the later one decides", () => {
    const tied = [
      { milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"] },
      { milestone: "M1", round: 1, type: "corrective", trigger: ["A-2"] },
    ]
    assert.equal(sameCheckFailedBefore(tied, "M1", ["A-2"]), true)
    assert.equal(sameCheckFailedBefore(tied, "M1", ["A-1"]), false)
  })

  test("an entry with no round ranks as round 0", () => {
    const noRoundAfter = [
      { milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"] },
      { milestone: "M1", type: "corrective", trigger: ["A-2"] },
    ]
    assert.equal(sameCheckFailedBefore(noRoundAfter, "M1", ["A-1"]), true)
    assert.equal(sameCheckFailedBefore(noRoundAfter, "M1", ["A-2"]), false)
    const noRoundBefore = [noRoundAfter[1], noRoundAfter[0]]
    assert.equal(sameCheckFailedBefore(noRoundBefore, "M1", ["A-1"]), true)
    assert.equal(sameCheckFailedBefore(noRoundBefore, "M1", ["A-2"]), false)
    const bothUnnumbered = [
      { milestone: "M1", type: "corrective", trigger: ["A-2"] },
      { milestone: "M1", type: "corrective", trigger: ["A-3"] },
    ]
    assert.equal(sameCheckFailedBefore(bothUnnumbered, "M1", ["A-3"]), true)
    assert.equal(sameCheckFailedBefore(bothUnnumbered, "M1", ["A-2"]), false)
    assert.equal(sameCheckFailedBefore([noRoundAfter[1]], "M1", ["A-2"]), true)
  })

  test("is false for no corrective entry, an empty or missing trigger list, and malformed input", () => {
    assert.equal(sameCheckFailedBefore([], "M1", ["A-1"]), false)
    assert.equal(sameCheckFailedBefore(log, "M3", ["A-1"]), false)
    assert.equal(sameCheckFailedBefore(log, "M1", []), false)
    assert.equal(sameCheckFailedBefore(log, "M1", undefined), false)
    assert.equal(sameCheckFailedBefore(undefined, "M1", ["A-1"]), false)
    assert.equal(sameCheckFailedBefore([null, { milestone: "M1", type: "corrective" }], "M1", ["A-1"]), false)
  })
})

describe("CLI", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seat-ladder-"))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const writeState = (state) => {
    writeFileSync(path.join(dir, "mission-state.json"), JSON.stringify(state))
    return dir
  }
  const base = {
    milestones: [{ id: "M1" }, { id: "M2" }],
    roundLog: [
      { milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], seat: "sonnet/high" },
      { milestone: "M2", round: 1, type: "corrective", trigger: ["B-1"], seat: "opus/xhigh" },
    ],
  }
  const out = (result) => JSON.parse(result.stdout)
  const corrective = (state, ...rest) => runCLI(["corrective-seat", writeState(state), ...rest])

  test("resolve prints resolveSeat's result and exits 0", () => {
    const run = runCLI(["resolve", JSON.stringify({ role: "worker", previousRung: "L3", trigger: "gate" })])
    assert.equal(run.exitCode, 0)
    assert.deepEqual(out(run), resolveSeat({ role: "worker", previousRung: "L3", trigger: "gate" }))
    assert.equal(out(run).rung, "L4")
  })

  test("resolve exits 2 with the message on a TypeError", () => {
    const run = runCLI(["resolve", JSON.stringify({ role: "intern", previousRung: null })])
    assert.equal(run.exitCode, 2)
    assert.equal(run.stdout, "")
    assert.match(run.stderr, /unknown role "intern"/)
  })

  test("resolve exits 2 on a usage error", () => {
    for (const argv of [["resolve"], ["resolve", "{not json"], ["resolve", "null"], ["resolve", "{}", "extra"], ["bogus"], []]) {
      const run = runCLI(argv)
      assert.equal(run.exitCode, 2, JSON.stringify(argv))
      assert.match(run.stderr, /seat-ladder:/)
    }
  })

  test("corrective-seat starts from the milestone's newest corrective seat and climbs one rung", () => {
    const run = corrective(base, "M1", "--cause", "assertion", "--triggers", '["A-9"]')
    assert.equal(run.exitCode, 0, run.stderr)
    assert.equal(out(run).rung, "L4")
    assert.equal(out(run).climbed, true)
  })

  test("corrective-seat climbs two rungs when the same check failed before", () => {
    const run = corrective(base, "M1", "--cause", "gate", "--triggers", '["A-1"]')
    assert.equal(out(run).rung, "L5")
  })

  test("corrective-seat reads the newest entry of the milestone asked for", () => {
    const run = corrective(base, "M2", "--cause", "assertion", "--triggers", '["Z"]')
    assert.equal(out(run).rung, "L5")
    assert.equal(out(run).climbed, false)
    assert.equal(out(run).atCeiling, true)
  })

  test("corrective-seat reads the newest of several corrective entries", () => {
    const state = {
      milestones: [{ id: "M1" }],
      roundLog: [
        { milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], seat: "sonnet/high" },
        { milestone: "M1", round: 2, type: "corrective", trigger: ["A-2"], seat: "opus/high" },
      ],
    }
    const run = corrective(state, "M1", "--cause", "assertion", "--triggers", '["A-2"]')
    assert.equal(out(run).rung, "L5")
  })

  test("corrective-seat reads the newest corrective entry's seat, not a newer adversarial or hardening one", () => {
    const state = {
      milestones: [{ id: "M1" }],
      roundLog: [
        { milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], seat: "sonnet/high" },
        { milestone: "M1", round: 2, type: "adversarial", trigger: ["A-2"], seat: "opus/xhigh" },
        { milestone: "M1", round: 3, type: "hardening", trigger: ["A-3"], seat: "opus/xhigh" },
      ],
    }
    const run = corrective(state, "M1", "--cause", "assertion", "--triggers", '["A-9"]')
    assert.equal(run.exitCode, 0, run.stderr)
    assert.equal(out(run).rung, "L4")
    assert.equal(out(run).climbed, true)
  })

  test("corrective-seat restarts from the start rung when the newest corrective seat names no rung, ignoring an older one that does", () => {
    const state = {
      milestones: [{ id: "M1" }],
      roundLog: [
        { milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], seat: "opus/high" },
        { milestone: "M1", round: 2, type: "corrective", trigger: ["A-2"], seat: "orchestrator" },
      ],
    }
    const run = corrective(state, "M1", "--cause", "assertion", "--triggers", '["A-9"]')
    assert.equal(out(run).rung, "L4")
    assert.match(out(run).reason, /L3 to L4/)
  })

  test("corrective-seat takes the later of two corrective entries with the same round", () => {
    const state = {
      milestones: [{ id: "M1" }],
      roundLog: [
        { milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], seat: "sonnet/high" },
        { milestone: "M1", round: 1, type: "corrective", trigger: ["A-2"], seat: "opus/high" },
      ],
    }
    assert.equal(out(corrective(state, "M1", "--cause", "gate", "--triggers", '["A-9"]')).rung, "L5")
  })

  test("corrective-seat --size-tier picks the worker start rung from the table it is given", () => {
    const empty = { milestones: [{ id: "M1" }], roundLog: [] }
    const legacy = {
      milestones: [{ id: "M1" }],
      roundLog: [{ milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], seat: "opus (module-worker)" }],
    }
    const seat = (state, ...tier) =>
      out(runCLI(["corrective-seat", writeState(state), "M1", "--cause", "assertion", "--triggers", '["A-9"]', ...tier], SPLIT_TABLE)).rung
    for (const state of [empty, legacy]) {
      assert.equal(seat(state, "--size-tier", "small"), "L2")
      assert.equal(seat(state, "--size-tier", "normal"), "L3")
      assert.equal(seat(state, "--size-tier", "large"), "L5")
      assert.equal(seat(state), "L3")
    }
  })

  test("resolve uses the table it is given", () => {
    const run = runCLI(["resolve", JSON.stringify({ role: "worker", previousRung: null, sizeTier: "small" })], SPLIT_TABLE)
    assert.equal(out(run).rung, "L1")
  })

  test("resolve exits 2 on a non-boolean sameCheckFailedBefore", () => {
    const run = runCLI(["resolve", JSON.stringify({ role: "worker", previousRung: "L3", trigger: "gate", sameCheckFailedBefore: "true" })])
    assert.equal(run.exitCode, 2)
    assert.match(run.stderr, /sameCheckFailedBefore must be a boolean, got "true"/)
  })

  test("corrective-seat --cause accepts exactly CORRECTIVE_CAUSES", () => {
    assert.deepEqual([...CORRECTIVE_CAUSES], ["assertion", "gate", "spec"])
    for (const cause of CORRECTIVE_CAUSES) {
      assert.equal(corrective(base, "M1", "--cause", cause, "--triggers", "[]").exitCode, 0, cause)
    }
    for (const cause of ["infra", "bogus", "Assertion", "constructor"]) {
      const run = corrective(base, "M1", "--cause", cause, "--triggers", "[]")
      assert.equal(run.exitCode, 2, cause)
      assert.match(run.stderr, /--cause must be one of assertion, gate, spec/, cause)
    }
  })

  test("corrective-seat starts from the worker start rung with no corrective entry or an unreadable seat", () => {
    const none = corrective({ milestones: [{ id: "M1" }], roundLog: [] }, "M1", "--cause", "assertion", "--triggers", "[]")
    assert.equal(out(none).rung, "L4")
    const legacy = {
      milestones: [{ id: "M1" }],
      roundLog: [{ milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], seat: "opus (module-worker)" }],
    }
    const run = corrective(legacy, "M1", "--cause", "assertion", "--triggers", '["A-1"]')
    assert.equal(out(run).rung, "L5")
    const missing = corrective({ milestones: [{ id: "M1" }] }, "M1", "--cause", "gate", "--triggers", "[]")
    assert.equal(out(missing).rung, "L4")
  })

  test("corrective-seat with cause spec routes to the contract without climbing", () => {
    const run = corrective(base, "M1", "--cause", "spec", "--triggers", '["A-1"]')
    assert.equal(out(run).route, "contract")
    assert.equal(out(run).rung, "L3")
  })

  test("corrective-seat accepts every size tier and rejects an unknown one", () => {
    for (const tier of SIZE_TIERS) {
      assert.equal(corrective(base, "M1", "--cause", "gate", "--triggers", "[]", "--size-tier", tier).exitCode, 0)
    }
    assert.equal(corrective(base, "M1", "--cause", "gate", "--triggers", "[]", "--size-tier", "huge").exitCode, 2)
  })

  test("corrective-seat writes nothing to the state file", () => {
    const text = JSON.stringify(base)
    writeState(base)
    runCLI(["corrective-seat", dir, "M1", "--cause", "gate", "--triggers", '["A-1"]'])
    assert.equal(readFileSync(path.join(dir, "mission-state.json"), "utf8"), text)
  })

  test("corrective-seat exits 2 on every usage error", () => {
    writeState(base)
    const good = ["--cause", "gate", "--triggers", "[]"]
    const cases = [
      ["corrective-seat"],
      ["corrective-seat", dir],
      ["corrective-seat", dir, "--cause", "gate", "--triggers", "[]"],
      ["corrective-seat", dir, "M1"],
      ["corrective-seat", dir, "M1", "--cause", "gate"],
      ["corrective-seat", dir, "M1", "--triggers", "[]"],
      ["corrective-seat", dir, "M1", "--cause", "infra", "--triggers", "[]"],
      ["corrective-seat", dir, "M1", "--cause", "gate", "--triggers", "{nope"],
      ["corrective-seat", dir, "M1", "--cause", "gate", "--triggers", '{"a":1}'],
      ["corrective-seat", dir, "M1", "--cause", "gate", "--triggers", "[1]"],
      ["corrective-seat", dir, "M1", ...good, "--cause", "gate"],
      ["corrective-seat", dir, "M1", ...good, "stray"],
      ["corrective-seat", dir, "M9", ...good],
      ["corrective-seat", path.join(dir, "nope"), "M1", ...good],
    ]
    for (const argv of cases) {
      const run = runCLI(argv)
      assert.equal(run.exitCode, 2, JSON.stringify(argv))
      assert.equal(run.stdout, "")
      assert.notEqual(run.stderr, "")
    }
  })

  test("a state file that is not JSON exits 2", () => {
    writeFileSync(path.join(dir, "mission-state.json"), "{not json")
    assert.equal(runCLI(["corrective-seat", dir, "M1", "--cause", "gate", "--triggers", "[]"]).exitCode, 2)
  })

  test("run as a process, the CLI prints the result and passes the exit code through", () => {
    const file = path.join(HERE, "seat-ladder.mjs")
    const ok = spawnSync(process.execPath, [file, "resolve", '{"role":"validator","previousRung":"L5","trigger":"dispute"}'], { encoding: "utf8" })
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(JSON.parse(ok.stdout).rung, "L6")
    const bad = spawnSync(process.execPath, [file, "resolve", '{"role":"intern"}'], { encoding: "utf8" })
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /unknown role/)
  })

  test("importing the module prints nothing and runs no CLI", () => {
    const href = JSON.stringify(pathToFileURL(path.join(HERE, "seat-ladder.mjs")).href)
    const run = spawnSync(process.execPath, ["-e", `import(${href})`], { encoding: "utf8" })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, "")
  })
})

/** The overrides ML-022a states for `cheap`, typed out here and not read from the table. */
const CHEAP = {
  worker: { sizeStart: { small: "L2", normal: "L2", large: "L3" } },
  simplify: { start: "L2" },
  scout: { start: "L2" },
  fixer: { start: "L2" },
  validator: { start: "L4" },
  "screenshot-validator": { start: "L4" },
  reviewer: { start: "L4" },
}

/**
 * One message per defect in a profiles table. A profile is not a role, so the
 * role rule that `start` equal `sizeStart.normal` is deliberately not applied:
 * `cheap` starts a normal worker on L2 while the role table's `start` is L3.
 */
function checkProfiles(profiles, roles, ladder, tiers = SIZE_TIERS) {
  const rank = new Map(ladder.map((rung, i) => [rung.id, i]))
  const defects = []
  const checkRung = (where, rung, ceiling) => {
    if (!rank.has(rung)) defects.push(`${where}: ${rung} is not a rung`)
    else if (rank.get(rung) > rank.get(ceiling)) defects.push(`${where}: ${rung} is above ceiling ${ceiling}`)
  }
  for (const [name, overrides] of Object.entries(profiles)) {
    for (const [role, override] of Object.entries(overrides)) {
      const where = `${name}.${role}`
      if (!Object.hasOwn(roles, role)) {
        defects.push(`${where}: ${role} is not a role`)
        continue
      }
      const { ceiling } = roles[role]
      if (role === "worker") {
        if ("start" in override) defects.push(`${where}: a worker override is a sizeStart, not a start`)
        for (const tier of tiers) {
          if (!override.sizeStart || !(tier in override.sizeStart)) defects.push(`${where}: sizeStart.${tier} is missing`)
          else checkRung(`${where}.sizeStart.${tier}`, override.sizeStart[tier], ceiling)
        }
      } else {
        if ("sizeStart" in override) defects.push(`${where}: only the worker has a sizeStart`)
        if (!("start" in override)) defects.push(`${where}: start is missing`)
        else checkRung(`${where}.start`, override.start, ceiling)
      }
    }
  }
  return defects
}

describe("profiles", () => {
  test("PROFILE_NAMES is exactly current and cheap", () => {
    assert.deepEqual([...PROFILE_NAMES], ["current", "cheap"])
    assert.equal(Object.isFrozen(PROFILE_NAMES), true)
  })

  test("current has no overrides and cheap holds the PRD's cheaper starts, without Haiku", () => {
    assert.deepEqual(SEAT_PROFILES.current, {})
    assert.deepEqual(SEAT_PROFILES.cheap, CHEAP)
    for (const [role, override] of Object.entries(SEAT_PROFILES.cheap)) {
      for (const rung of [override.start, ...Object.values(override.sizeStart ?? {})].filter(Boolean)) {
        assert.notEqual(LADDER.find((r) => r.id === rung).model, "haiku", role)
      }
    }
  })

  test("every profile key is a role, and every override is a rung at or below its role's ceiling", () => {
    assert.deepEqual(checkProfiles(SEAT_PROFILES, ROLE_SEATS, LADDER), [])
  })

  test("a profile is not held to the role rule start === sizeStart.normal", () => {
    assert.notEqual(SEAT_PROFILES.cheap.worker.sizeStart.normal, ROLE_SEATS.worker.start)
    assert.deepEqual(checkProfiles(SEAT_PROFILES, ROLE_SEATS, LADDER), [])
    assert.deepEqual(checkRoleSeats({ worker: { ...ROLE_SEATS.worker, start: "L2" } }, LADDER), [
      "worker: start L2 differs from sizeStart.normal L3",
    ])
  })

  describe("checkProfiles negative controls", () => {
    const withCheap = (cheap) => ({ current: {}, cheap })
    const defectsOf = (cheap) => checkProfiles(withCheap(cheap), ROLE_SEATS, LADDER)

    test("fails a key that is not a role, an inherited property included", () => {
      assert.deepEqual(defectsOf({ intern: { start: "L2" } }), ["cheap.intern: intern is not a role"])
      assert.deepEqual(defectsOf({ constructor: { start: "L2" } }), ["cheap.constructor: constructor is not a role"])
    })

    test("fails an override that is not a rung", () => {
      assert.deepEqual(defectsOf({ scout: { start: "L9" } }), ["cheap.scout.start: L9 is not a rung"])
    })

    test("fails an override above its role's ceiling, at the boundary and past it", () => {
      assert.deepEqual(defectsOf({ simplify: { start: "L3" } }), [])
      assert.deepEqual(defectsOf({ simplify: { start: "L4" } }), ["cheap.simplify.start: L4 is above ceiling L3"])
      assert.deepEqual(defectsOf({ scout: { start: "L5" } }), ["cheap.scout.start: L5 is above ceiling L4"])
    })

    test("fails a worker override that is not a full sizeStart", () => {
      assert.deepEqual(defectsOf({ worker: { sizeStart: { small: "L2", normal: "L2" } } }), ["cheap.worker: sizeStart.large is missing"])
      assert.deepEqual(defectsOf({ worker: { start: "L2" } }), [
        "cheap.worker: a worker override is a sizeStart, not a start",
        "cheap.worker: sizeStart.small is missing",
        "cheap.worker: sizeStart.normal is missing",
        "cheap.worker: sizeStart.large is missing",
      ])
      assert.deepEqual(defectsOf({ worker: { sizeStart: { small: "L2", normal: "L2", large: "L6" } } }), [
        "cheap.worker.sizeStart.large: L6 is above ceiling L5",
      ])
    })

    test("fails a non-worker override that is a sizeStart or has no start", () => {
      assert.deepEqual(defectsOf({ fixer: { sizeStart: { small: "L2", normal: "L2", large: "L2" } } }), [
        "cheap.fixer: only the worker has a sizeStart",
        "cheap.fixer: start is missing",
      ])
      assert.deepEqual(defectsOf({ fixer: {} }), ["cheap.fixer: start is missing"])
    })
  })
})

describe("resolveSeat: flags.seatProfile", () => {
  const ROLES = Object.keys(ROLE_SEATS)
  const rungOf = (input) => resolveSeat(input).rung

  test("an absent flags, {} and the current profile return identical seats for every role and tier", () => {
    for (const role of ROLES) {
      for (const sizeTier of [...SIZE_TIERS, undefined]) {
        const bare = resolveSeat({ role, previousRung: null, sizeTier })
        for (const flags of [{}, { seatProfile: "current" }, { seatProfile: null }, null]) {
          assert.deepEqual(resolveSeat({ role, previousRung: null, sizeTier, flags }), bare, `${role} ${sizeTier} ${JSON.stringify(flags)}`)
        }
      }
    }
  })

  test("the current profile changes no climb either", () => {
    const flags = { seatProfile: "current" }
    for (const [role, previousRung, trigger] of [["worker", "L3", "gate"], ["validator", "L5", "dispute"], ["scout", "L4", "schema"], ["fixer", "L3", "infra"]]) {
      assert.deepEqual(resolveSeat({ role, previousRung, trigger, flags }), resolveSeat({ role, previousRung, trigger }), role)
    }
  })

  test("cheap starts each role on the rung the profile names, the worker per tier", () => {
    const flags = { seatProfile: "cheap" }
    const expected = {
      simplify: "L2",
      scout: "L2",
      fixer: "L2",
      validator: "L4",
      "screenshot-validator": "L4",
      reviewer: "L4",
    }
    for (const [role, rung] of Object.entries(expected)) assert.equal(rungOf({ role, previousRung: null, flags }), rung, role)
    assert.equal(rungOf({ role: "worker", previousRung: null, sizeTier: "small", flags }), "L2")
    assert.equal(rungOf({ role: "worker", previousRung: null, sizeTier: "normal", flags }), "L2")
    assert.equal(rungOf({ role: "worker", previousRung: null, sizeTier: "large", flags }), "L3")
    assert.equal(rungOf({ role: "worker", previousRung: null, flags }), "L2")
  })

  test("cheap keeps the reviewer's model override and moves only its effort", () => {
    assert.equal(seatOf(resolveSeat({ role: "reviewer", previousRung: null, flags: { seatProfile: "cheap" } })), "opus[1m]/high")
    assert.equal(seatOf(resolveSeat({ role: "worker", previousRung: null, flags: { seatProfile: "cheap" } })), "sonnet/medium")
  })

  test("a profile names itself in the reason of the seat it moved, and not otherwise", () => {
    assert.match(resolveSeat({ role: "scout", previousRung: null, flags: { seatProfile: "cheap" } }).reason, /scout starts at L2 \(profile cheap\)/)
    assert.equal(resolveSeat({ role: "scout", previousRung: null, flags: { seatProfile: "current" } }).reason, "scout starts at L3")
  })

  test("a profile moves the start rung only: a call with a previousRung climbs as it does without the flag", () => {
    const flags = { seatProfile: "cheap" }
    for (const [role, previousRung, trigger, sameCheckFailedBefore] of [
      ["worker", "L3", "gate", false],
      ["worker", "L3", "assertion", true],
      ["validator", "L5", "dispute", false],
      ["scout", "L4", "schema", false],
      ["fixer", "L3", "gate-repeat", false],
      ["fixer", "L3", "infra", false],
      ["worker", "L3", "spec", false],
    ]) {
      const input = { role, previousRung, trigger, sameCheckFailedBefore }
      assert.deepEqual(resolveSeat({ ...input, flags }), resolveSeat(input), `${role} ${trigger}`)
    }
  })

  test("a climb from the profiled start moves one rung, and two when the same check failed before", () => {
    assert.equal(rungOf({ role: "worker", previousRung: "L2", trigger: "assertion" }), "L3")
    assert.equal(rungOf({ role: "worker", previousRung: "L2", trigger: "assertion", sameCheckFailedBefore: true }), "L4")
  })

  test("a profile's start is clamped to the role's ceiling when the table asks for more", () => {
    const table = { ...SPLIT_TABLE, profiles: { current: {}, high: { simplify: { start: "L5" } } } }
    const got = resolveSeat({ role: "simplify", previousRung: null, flags: { seatProfile: "high" } }, table)
    assert.equal(got.rung, "L3")
    assert.equal(got.atCeiling, true)
  })

  test("the worker override replaces sizeStart per tier, and a start-only override ignores the tier", () => {
    const table = {
      ...SPLIT_TABLE,
      profiles: {
        current: {},
        tiered: { worker: { sizeStart: { small: "L0", normal: "L1", large: "L2" } } },
        flat: { worker: { start: "L2" } },
      },
    }
    const pick = (seatProfile, sizeTier) => resolveSeat({ role: "worker", previousRung: null, sizeTier, flags: { seatProfile } }, table).rung
    assert.deepEqual(SIZE_TIERS.map((tier) => pick("tiered", tier)), ["L0", "L1", "L2"])
    assert.deepEqual(SIZE_TIERS.map((tier) => pick("flat", tier)), ["L2", "L2", "L2"])
    assert.deepEqual(SIZE_TIERS.map((tier) => pick("current", tier)), ["L1", "L2", "L4"])
  })

  describe("throws a TypeError", () => {
    const bad = [
      ["an unknown name", { seatProfile: "frugal" }],
      ["the inherited property constructor", { seatProfile: "constructor" }],
      ["the inherited property __proto__", { seatProfile: "__proto__" }],
      ["the inherited property toString", { seatProfile: "toString" }],
      ["a name differing in case", { seatProfile: "Cheap" }],
      ["an empty name", { seatProfile: "" }],
      ["a number", { seatProfile: 1 }],
      ["an array holding a valid name", { seatProfile: ["cheap"] }],
      ["flags that is a string", "cheap"],
      ["flags that is an array", ["cheap"]],
      ["flags that is a number", 0],
      ["a misspelt key holding a valid name", { seatprofile: "cheap" }],
      ["a misspelt key alone, with no seatProfile", { profile: "cheap" }],
      ["a stray key beside a valid seatProfile", { seatProfile: "cheap", sizeTier: "large" }],
      ["a stray key beside current", { seatProfile: "current", extra: true }],
      ["a stray key whose value is undefined-like", { seatProfile: null, other: null }],
    ]
    for (const [name, flags] of bad) {
      test(name, () => {
        assert.throws(() => resolveSeat({ role: "worker", previousRung: null, flags }), TypeError)
        assert.throws(() => resolveSeat({ role: "worker", previousRung: "L3", trigger: "gate", flags }), TypeError)
      })
    }

    test("the message for a stray flags key names the key", () => {
      assert.throws(
        () => resolveSeat({ role: "validator", previousRung: null, flags: { seatprofile: "cheap" } }),
        { name: "TypeError", message: /unknown flags key "seatprofile"/ },
      )
    })

    test("a seatProfile at the top level of the input, whatever its value, on both paths", () => {
      for (const seatProfile of ["cheap", "current", null, undefined]) {
        const label = String(seatProfile)
        assert.throws(
          () => resolveSeat({ role: "validator", previousRung: null, seatProfile }),
          { name: "TypeError", message: /seatProfile belongs inside flags/ },
          label,
        )
        assert.throws(() => resolveSeat({ role: "worker", previousRung: "L3", trigger: "gate", seatProfile }), TypeError, label)
        assert.throws(
          () => resolveSeat({ role: "worker", previousRung: null, seatProfile, flags: { seatProfile: "cheap" } }),
          TypeError,
          label,
        )
      }
    })

    test("an empty flags object and a lone seatProfile key are still accepted", () => {
      assert.equal(resolveSeat({ role: "validator", previousRung: null, flags: {} }).rung, "L5")
      assert.equal(resolveSeat({ role: "validator", previousRung: null, flags: { seatProfile: "cheap" } }).rung, "L4")
      assert.equal(resolveSeat({ role: "validator", previousRung: null, flags: { seatProfile: undefined } }).rung, "L5")
    })

    test("a profile name the injected table lacks, though the default table has it", () => {
      assert.throws(() => resolveSeat({ role: "worker", previousRung: null, flags: { seatProfile: "cheap" } }, SPLIT_TABLE), TypeError)
    })

    test("the message names the profile", () => {
      assert.throws(
        () => resolveSeat({ role: "worker", previousRung: null, flags: { seatProfile: "constructor" } }),
        { name: "TypeError", message: /unknown seatProfile "constructor"/ },
      )
    })
  })
})

describe("CLI: seatProfile", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seat-ladder-profile-"))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const out = (result) => JSON.parse(result.stdout)
  const corrective = (state, extra = [], table) => {
    writeFileSync(path.join(dir, "mission-state.json"), JSON.stringify(state))
    return runCLI(["corrective-seat", dir, "M1", "--cause", "assertion", "--triggers", '["A-9"]', ...extra], table)
  }
  const fresh = (extra = {}) => ({ milestones: [{ id: "M1" }], roundLog: [], ...extra })

  test("round 1 under cheap climbs from L2 to L3 for a normal and a small tier", () => {
    for (const tier of ["normal", "small"]) {
      const run = corrective(fresh({ seatProfile: "cheap" }), ["--size-tier", tier])
      assert.equal(run.exitCode, 0, run.stderr)
      assert.equal(out(run).rung, "L3", tier)
      assert.equal(out(run).climbed, true)
    }
    assert.equal(out(corrective(fresh({ seatProfile: "cheap" }))).rung, "L3")
  })

  test("round 1 under cheap for a large tier climbs from L3 to L4", () => {
    assert.equal(out(corrective(fresh({ seatProfile: "cheap" }), ["--size-tier", "large"])).rung, "L4")
  })

  test("round 1 under current, null and an absent seatProfile is L4, as without profiles", () => {
    for (const state of [fresh({ seatProfile: "current" }), fresh({ seatProfile: null }), fresh()]) {
      assert.equal(out(corrective(state)).rung, "L4", JSON.stringify(state.seatProfile))
    }
  })

  test("the profile moves the start rung only: a recorded seat is climbed from, whatever the profile", () => {
    const logged = { roundLog: [{ milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], seat: "sonnet/high" }] }
    assert.equal(out(corrective(fresh({ ...logged, seatProfile: "cheap" }))).rung, "L4")
    assert.equal(out(corrective(fresh(logged))).rung, "L4")
  })

  test("a recorded seat that names no rung restarts from the profiled start", () => {
    const legacy = { roundLog: [{ milestone: "M1", round: 1, type: "corrective", trigger: ["A-1"], seat: "orchestrator" }] }
    assert.equal(out(corrective(fresh({ ...legacy, seatProfile: "cheap" }))).rung, "L3")
    assert.equal(out(corrective(fresh(legacy))).rung, "L4")
  })

  test("an unknown or non-string seatProfile in the state exits 2 and names the profile", () => {
    for (const seatProfile of ["frugal", "constructor", 1, ["cheap"]]) {
      const run = corrective(fresh({ seatProfile }))
      assert.equal(run.exitCode, 2, JSON.stringify(seatProfile))
      assert.match(run.stderr, /unknown seatProfile/)
    }
  })

  test("a stored milestones[].sizeTier of large is ignored when --size-tier is absent, under a table whose sizeStart differs by tier", () => {
    const stored = { milestones: [{ id: "M1", sizeTier: "large" }], roundLog: [] }
    assert.equal(out(corrective(stored, [], SPLIT_TABLE)).rung, "L3")
    assert.equal(out(corrective(stored, ["--size-tier", "large"], SPLIT_TABLE)).rung, "L5")
    assert.equal(out(corrective({ milestones: [{ id: "M1", sizeTier: "small" }], roundLog: [] }, [], SPLIT_TABLE)).rung, "L3")
  })

  test("a stored sizeTier moves no start under cheap either", () => {
    const stored = { milestones: [{ id: "M1", sizeTier: "large" }], roundLog: [], seatProfile: "cheap" }
    assert.equal(out(corrective(stored)).rung, "L3")
  })

  test("resolve passes flags through to the rule", () => {
    const run = runCLI(["resolve", JSON.stringify({ role: "validator", previousRung: null, flags: { seatProfile: "cheap" } })])
    assert.equal(run.exitCode, 0, run.stderr)
    assert.equal(out(run).rung, "L4")
    const bad = runCLI(["resolve", JSON.stringify({ role: "validator", previousRung: null, flags: { seatProfile: "constructor" } })])
    assert.equal(bad.exitCode, 2)
    assert.match(bad.stderr, /unknown seatProfile "constructor"/)
  })

  test("resolve exits 2 on a misspelt flags key or a top-level seatProfile, where it once printed the current seat", () => {
    const cases = [
      [{ role: "validator", previousRung: null, flags: { seatprofile: "cheap" } }, /unknown flags key "seatprofile"/],
      [{ role: "validator", previousRung: null, flags: { seatProfile: "cheap", extra: 1 } }, /unknown flags key "extra"/],
      [{ role: "validator", previousRung: null, seatProfile: "cheap" }, /seatProfile belongs inside flags/],
    ]
    for (const [input, message] of cases) {
      const run = runCLI(["resolve", JSON.stringify(input)])
      assert.equal(run.exitCode, 2, JSON.stringify(input))
      assert.equal(run.stdout, "")
      assert.match(run.stderr, message)
    }
  })

  test("corrective-seat still writes nothing to the state file under a profile", () => {
    const state = fresh({ seatProfile: "cheap" })
    corrective(state)
    assert.equal(readFileSync(path.join(dir, "mission-state.json"), "utf8"), JSON.stringify(state))
  })
})
