/**
 * plan-size.mjs against ML-015: `small` below 1190, `large` at 4604 or more,
 * `normal` between, `DEF-` ids not counted, an id absent from the contract
 * counting 0. The boundary sizes are typed out here, not read from the exported
 * constants, so a drifted cutoff fails; the tests that read the constants
 * recompute them from the frozen replay input in evidence/. The percentiles
 * read only a few order statistics of that input, so its bytes are pinned by
 * sha256 too.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { LARGE_FROM, SMALL_BELOW, planSize, planSizeTier, runCLI } from "./plan-size.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, "plan-size.mjs")

const assertion = (id, chars) => ({ id, statement: "x".repeat(chars) })
const contractOf = (...assertions) => ({ assertions })
const milestoneOf = (...ids) => ({ id: "M1", assertions: ids })

describe("planSizeTier boundaries", () => {
  const cases = [
    [0, "small"],
    [1, "small"],
    [1189, "small"],
    [1190, "normal"],
    [1191, "normal"],
    [4603, "normal"],
    [4604, "large"],
    [4605, "large"],
    [20000, "large"],
  ]
  for (const [chars, tier] of cases) {
    test(`${chars} statement characters is ${tier}`, () => {
      assert.equal(planSizeTier(milestoneOf("A-1"), contractOf(assertion("A-1", chars))), tier)
    })
  }

  test("the size is the sum over the named assertions, not any one of them", () => {
    const contract = contractOf(assertion("A-1", 600), assertion("A-2", 590), assertion("A-3", 5000))
    assert.equal(planSize(milestoneOf("A-1", "A-2"), contract), 1190)
    assert.equal(planSizeTier(milestoneOf("A-1", "A-2"), contract), "normal")
    assert.equal(planSizeTier(milestoneOf("A-1"), contract), "small")
  })

  test("an assertion the milestone does not name is not counted", () => {
    assert.equal(planSize(milestoneOf("A-1"), contractOf(assertion("A-1", 10), assertion("A-9", 9000))), 10)
  })
})

describe("DEF- exclusion", () => {
  test("a DEF- assertion adds nothing, however long its statement", () => {
    const contract = contractOf(assertion("A-1", 1000), assertion("DEF-gate-M1", 9000))
    assert.equal(planSize(milestoneOf("A-1", "DEF-gate-M1"), contract), 1000)
    assert.equal(planSizeTier(milestoneOf("A-1", "DEF-gate-M1"), contract), "small")
  })

  test("only the DEF- prefix excludes: an id merely containing DEF- or in another case counts", () => {
    const contract = contractOf(assertion("A-DEF-1", 700), assertion("def-1", 700))
    assert.equal(planSize(milestoneOf("A-DEF-1", "def-1"), contract), 1400)
  })

  test("a milestone naming only DEF- assertions is small", () => {
    assert.equal(planSizeTier(milestoneOf("DEF-a", "DEF-b"), contractOf(assertion("DEF-a", 9999), assertion("DEF-b", 9999))), "small")
  })
})

describe("input the contract does not cover", () => {
  test("an id absent from the contract counts 0 and does not throw", () => {
    const contract = contractOf(assertion("A-1", 1190))
    assert.equal(planSize(milestoneOf("A-1", "GHOST-1"), contract), 1190)
    assert.equal(planSizeTier(milestoneOf("GHOST-1"), contract), "small")
  })

  test("a milestone with no assertions, a contract with none, and null contract are small", () => {
    assert.equal(planSizeTier({ id: "M1" }, contractOf()), "small")
    assert.equal(planSizeTier(milestoneOf(), contractOf(assertion("A-1", 5000))), "small")
    assert.equal(planSizeTier(milestoneOf("A-1"), {}), "small")
    assert.equal(planSizeTier(milestoneOf("A-1"), null), "small")
    assert.equal(planSizeTier(null, null), "small")
  })

  test("an assertion with no statement counts 0", () => {
    assert.equal(planSize(milestoneOf("A-1", "A-2"), { assertions: [{ id: "A-1" }, assertion("A-2", 5)] }), 5)
  })

  test("a non-string id in the milestone is skipped", () => {
    assert.equal(planSize({ assertions: [null, 7, "A-1"] }, contractOf(assertion("A-1", 3))), 3)
  })

  test("characters are code points, as the replay's Python len counts them", () => {
    const contract = contractOf({ id: "A-1", statement: "\u{1F600}".repeat(1189) })
    assert.equal(planSize(milestoneOf("A-1"), contract), 1189)
    assert.equal(planSizeTier(milestoneOf("A-1"), contract), "small")
  })
})

/** numpy's default percentile: k = (n-1)*p/100, interpolated between the neighbours of k. */
const linearPercentile = (sorted, p) => {
  const k = ((sorted.length - 1) * p) / 100
  const lo = Math.floor(k)
  const hi = Math.min(lo + 1, sorted.length - 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo)
}
const cutoffsOf = (sizes) => {
  const sorted = [...sizes].sort((a, b) => a - b)
  return { n: sorted.length, p30: linearPercentile(sorted, 30), p80: linearPercentile(sorted, 80) }
}
const frozen = (text = readFileSync(FROZEN_INPUT, "utf8")) => JSON.parse(text).milestones

describe("linear percentile", () => {
  test("matches values numpy.percentile gives by hand", () => {
    assert.equal(linearPercentile([1, 2, 3, 4], 30), 1.9)
    assert.equal(linearPercentile([10, 20], 80), 18)
    assert.equal(linearPercentile([7], 30), 7)
    assert.equal(linearPercentile([1, 2, 3, 4, 5], 80), 4.2)
  })
})

describe("exported cutoffs", () => {
  test("they are the values the size calibration chose", () => {
    assert.equal(SMALL_BELOW, 1190)
    assert.equal(LARGE_FROM, 4604)
  })
})

describe("CLI", () => {
  const dirs = []
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  const prd = ({ state, contract } = {}) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plan-size-"))
    dirs.push(dir)
    if (state !== null) writeFileSync(path.join(dir, "mission-state.json"), typeof state === "string" ? state : JSON.stringify(state))
    if (contract !== null) writeFileSync(path.join(dir, "validation-contract.json"), typeof contract === "string" ? contract : JSON.stringify(contract))
    return dir
  }
  const state = {
    milestones: [
      { id: "M1", assertions: ["A-1"] },
      { id: "M2", assertions: ["A-1", "A-2", "DEF-x"] },
      { id: "M3", assertions: ["A-3", "DEF-x"] },
    ],
  }
  const contract = contractOf(assertion("A-1", 100), assertion("A-2", 4504), assertion("A-3", 1500), assertion("DEF-x", 9000))

  test("prints the tier of the named milestone and exits 0", () => {
    const dir = prd({ state, contract })
    assert.deepEqual(runCLI([dir, "M1"]), { exitCode: 0, stdout: "small\n", stderr: "" })
    assert.deepEqual(runCLI([dir, "M2"]), { exitCode: 0, stdout: "large\n", stderr: "" })
    assert.deepEqual(runCLI([dir, "M3"]), { exitCode: 0, stdout: "normal\n", stderr: "" })
  })

  test("run as a process it prints the tier and writes nothing into the prd dir", () => {
    const dir = prd({ state, contract })
    const before = [readFileSync(path.join(dir, "mission-state.json"), "utf8"), readFileSync(path.join(dir, "validation-contract.json"), "utf8")]
    const run = spawnSync(process.execPath, [CLI, dir, "M2"], { encoding: "utf8" })
    assert.equal(run.status, 0)
    assert.equal(run.stdout, "large\n")
    assert.equal(run.stderr, "")
    assert.deepEqual(
      [readFileSync(path.join(dir, "mission-state.json"), "utf8"), readFileSync(path.join(dir, "validation-contract.json"), "utf8")],
      before,
    )
  })

  test("importing the module runs no CLI", () => {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(CLI)}`], { encoding: "utf8" })
    assert.equal(run.status, 0)
    assert.equal(run.stdout, "")
  })

  test("an unknown milestone exits 1 and names it", () => {
    const result = runCLI([prd({ state, contract }), "M9"])
    assert.equal(result.exitCode, 1)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /unknown milestone "M9"/)
  })

  test("a missing state file, a missing contract and unparsable JSON each exit 1 with no stdout", () => {
    for (const dir of [prd({ state: null, contract }), prd({ state, contract: null }), prd({ state: "{", contract }), prd({ state, contract: "nope" })]) {
      const result = runCLI([dir, "M1"])
      assert.equal(result.exitCode, 1)
      assert.equal(result.stdout, "")
      assert.match(result.stderr, /^plan-size: /)
    }
  })

  test("a state with no milestones array reports the milestone unknown", () => {
    assert.equal(runCLI([prd({ state: {}, contract }), "M1"]).exitCode, 1)
  })

  test("the wrong number of arguments or a flag exits 2 with usage", () => {
    for (const argv of [[], ["only-one"], ["a", "b", "c"], ["a", "--tier"]]) {
      const result = runCLI(argv)
      assert.equal(result.exitCode, 2)
      assert.equal(result.stdout, "")
      assert.match(result.stderr, /^usage: node plan-size\.mjs <prd-dir> <milestone>/)
    }
  })

  describe("--assertions form", () => {
    test("prints the tier of the named ids from the contract alone, with no mission-state.json", () => {
      const dir = prd({ state: null, contract })
      assert.deepEqual(runCLI([dir, "--assertions", "A-1"]), { exitCode: 0, stdout: "small\n", stderr: "" })
      assert.deepEqual(runCLI([dir, "--assertions", "A-1,A-2,DEF-x"]), { exitCode: 0, stdout: "large\n", stderr: "" })
      assert.deepEqual(runCLI([dir, "--assertions", "A-3,DEF-x"]), { exitCode: 0, stdout: "normal\n", stderr: "" })
    })

    test("agrees with the milestone form on the same assertions", () => {
      const dir = prd({ state, contract })
      for (const m of state.milestones) {
        assert.deepEqual(runCLI([dir, "--assertions", m.assertions.join(",")]), runCLI([dir, m.id]))
      }
    })

    test("an unknown id counts 0, so it never lifts the tier", () => {
      const dir = prd({ state: null, contract: contractOf(assertion("A-1", 1189)) })
      assert.equal(runCLI([dir, "--assertions", "A-1,GHOST-1"]).stdout, "small\n")
      assert.equal(runCLI([dir, "--assertions", "GHOST-1"]).stdout, "small\n")
    })

    test("spaces around ids and empty items between commas are ignored", () => {
      const dir = prd({ state: null, contract })
      assert.equal(runCLI([dir, "--assertions", " A-1 , A-2,,"]).stdout, "large\n")
    })

    test("run as a process it prints the tier and leaves the prd dir as it was", () => {
      const dir = prd({ state: null, contract })
      const before = [readdirSync(dir), readFileSync(path.join(dir, "validation-contract.json"), "utf8")]
      const run = spawnSync(process.execPath, [CLI, dir, "--assertions", "A-1,A-2"], { encoding: "utf8" })
      assert.equal(run.status, 0)
      assert.equal(run.stdout, "large\n")
      assert.equal(run.stderr, "")
      assert.deepEqual([readdirSync(dir), readFileSync(path.join(dir, "validation-contract.json"), "utf8")], before)
    })

    test("a missing or unparsable contract exits 1 with no stdout", () => {
      for (const dir of [prd({ state: null, contract: null }), prd({ state: null, contract: "{" })]) {
        const result = runCLI([dir, "--assertions", "A-1"])
        assert.equal(result.exitCode, 1)
        assert.equal(result.stdout, "")
        assert.match(result.stderr, /^plan-size: .*validation-contract\.json/)
      }
    })

    test("a missing, empty or flag-shaped id list, a misplaced flag or an extra argument exits 2 with both usages", () => {
      const dir = prd({ state, contract })
      const argvs = [
        [dir, "--assertions"],
        [dir, "--assertions", ""],
        [dir, "--assertions", " , ,"],
        [dir, "--assertions", "--json"],
        [dir, "--assertions", "A-1", "extra"],
        [dir, "--ids", "A-1"],
        ["--assertions", dir, "A-1"],
        ["--assertions", "A-1"],
      ]
      for (const argv of argvs) {
        const result = runCLI(argv)
        assert.equal(result.exitCode, 2, JSON.stringify(argv))
        assert.equal(result.stdout, "")
        assert.match(result.stderr, /<prd-dir> <milestone>\n.*<prd-dir> --assertions <comma-separated ids>/)
      }
    })
  })
})

/** The text of mission-plan step 4's "(the mission's ONE-TIME initial authoring ...)" parenthetical. */
const initialAuthoring = (skill) => {
  const start = skill.indexOf("(the mission's ONE-TIME initial authoring")
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < skill.length; i += 1) {
    if (skill[i] === "(") depth += 1
    if (skill[i] === ")") depth -= 1
    if (depth === 0) return skill.slice(start, i + 1)
  }
  return null
}

const SIZE_TIER_SENTENCE =
  /sets each milestone's `sizeTier`, computed before the one-time write as the output of `node \.claude\/skills\/run-prd-multi-agent-architecture\/lib\/plan-size\.mjs docs\/prd\/<feature> --assertions <ids>`, `<ids>` being the drafted milestone's `assertions\[\]` joined by commas; that form reads only the step-3 `validation-contract\.json`, so it runs before `mission-state\.json` exists/
