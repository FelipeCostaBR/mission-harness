import { test } from "node:test"
import assert from "node:assert/strict"

test("the public API loads and exposes the rule set", async () => {
  const api = await import("./index.mjs")
  for (const name of ["checkBookkeeping", "resolveSeat", "decideSelfHeal", "partitionDisjoint", "routeEscalation", "runStateCommand", "loadConfig", "autopilotProblems", "autopilotDirective", "buildGatePlan", "gateRecord", "extractVerdictFromTranscript"]) {
    assert.equal(typeof api[name], "function", name)
  }
})
