import test from "node:test"
import assert from "node:assert/strict"
import { routeEscalation } from "./escalation-route.mjs"

const config = {
  protectedPaths: [
    { glob: "db/schema.prisma", reason: "database schema", companionGlobs: ["db/migrations/**"] },
    { glob: "packages/core-math/**", reason: "shared formulas", alwaysDelegate: true },
    { glob: "src/shared/**", reason: "shared kernel" },
  ],
  testGlobs: ["test/**"],
  additivePairs: [{ primary: "db/schema.prisma", generated: "db/migrations/**" }],
}

test("one additive entry in one file routes inline", () => {
  const r = routeEscalation({ files: ["src/shared/events.ts"], additiveOnly: true }, config)
  assert.equal(r.route, "inline")
  assert.equal(r.validationRequired, false)
  assert.deepEqual(r.workerPathGlobs, [])
})

test("a single file with a logic change is delegated", () => {
  // additiveOnly defaults to false, and that default is the safety property:
  // wrongly-inline (creator/verifier collapse on real logic) is worse than
  // wrongly-delegated (a slightly over-provisioned worker).
  const r = routeEscalation({ files: ["src/shared/events.ts"] }, config)
  assert.equal(r.route, "delegate")
  assert.equal(r.validationRequired, true)
  assert.match(r.reasons.join(" "), /not declared additive-only/)
})

test("a declared additive pair stays inline", () => {
  const r = routeEscalation(
    { files: ["db/schema.prisma", "db/migrations/20260101_add_kind/migration.sql"], additiveOnly: true },
    config,
  )
  assert.equal(r.route, "inline")
})

test("the same pair without additiveOnly is delegated", () => {
  const r = routeEscalation(
    { files: ["db/schema.prisma", "db/migrations/20260101_add_kind/migration.sql"] },
    config,
  )
  assert.equal(r.route, "delegate")
})

test("multi-file escalations are delegated", () => {
  const r = routeEscalation(
    { files: ["src/shared/a.ts", "src/shared/b.ts"], additiveOnly: true },
    config,
  )
  assert.equal(r.route, "delegate")
  assert.match(r.reasons.join(" "), /multi-file/)
})

test("an alwaysDelegate path is delegated even as a lone additive entry", () => {
  const r = routeEscalation({ files: ["packages/core-math/bmr.ts"], additiveOnly: true }, config)
  assert.equal(r.route, "delegate")
  assert.match(r.reasons.join(" "), /always delegated/)
})

test("the delegate grant is tight: files, their dirs, tests, companions", () => {
  const r = routeEscalation({ files: ["db/schema.prisma", "src/shared/a.ts"] }, config)
  assert.ok(r.workerPathGlobs.includes("db/schema.prisma"))
  assert.ok(r.workerPathGlobs.includes("db/**"))
  assert.ok(r.workerPathGlobs.includes("src/shared/**"))
  assert.ok(r.workerPathGlobs.includes("test/**"))
  assert.ok(r.workerPathGlobs.includes("db/migrations/**"), "companion glob for the schema file")
  // Never a blanket grant over something nobody asked for.
  assert.ok(!r.workerPathGlobs.includes("**"))
})

test("leading ./ is normalized so it cannot dodge a protected path", () => {
  const r = routeEscalation({ files: ["./packages/core-math/bmr.ts"], additiveOnly: true }, config)
  assert.equal(r.route, "delegate")
})

test("duplicate files do not inflate the multi-file count", () => {
  const r = routeEscalation(
    { files: ["src/shared/a.ts", "src/shared/a.ts"], additiveOnly: true },
    config,
  )
  assert.equal(r.route, "inline")
})

test("works with no config at all (everything non-trivial delegates)", () => {
  assert.equal(routeEscalation({ files: ["a.ts"], additiveOnly: true }).route, "inline")
  assert.equal(routeEscalation({ files: ["a.ts", "b.ts"], additiveOnly: true }).route, "delegate")
})

test("malformed input throws", () => {
  assert.throws(() => routeEscalation(null, config), TypeError)
  assert.throws(() => routeEscalation({ files: [] }, config), TypeError)
  assert.throws(() => routeEscalation({}, config), TypeError)
})
