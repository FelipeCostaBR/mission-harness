/**
 * node:test for partition.mjs (the disjoint-module partition rule).
 * Run: node --test .claude/skills/run-prd-multi-agent-architecture/lib/partition.test.mjs
 * Covers PAR-1: all-disjoint / overlapping / escalation / mixed / glob-prefix / size-1 / conservative,
 * plus escalation-first serial order, per-feature pathGlobs, and the agent-routing.json adapter.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  partitionDisjoint,
  globBase,
  pathPrefixOverlap,
  globsOverlap,
  featuresConflict,
  pathGlobsFromRouting,
} from "./partition.mjs"
import * as partitionModule from "./partition.mjs"

const GLOBS = {
  handover: ["packages/api/src/handover/**"],
  subscription: ["packages/api/src/subscription/**"],
  "web-account": ["apps/web/app/(account)/**"],
  a: ["a/**"],
  ab: ["a/b/**"],
}

const ids = (batch) => batch.map((f) => f.id).sort()

test("helpers: globBase strips wildcards", () => {
  assert.equal(globBase("a/b/**"), "a/b")
  assert.equal(globBase("a/b/*"), "a/b")
  assert.equal(globBase("packages/api/src/handover/**"), "packages/api/src/handover")
  assert.equal(globBase("apps/admin/app/(fleet)/**"), "apps/admin/app/(fleet)")
})

test("helpers: globBase cuts at the FIRST wildcard segment, so a mid-pattern glob still overlaps", () => {
  assert.equal(globBase("apps/web/**/__tests__/**"), "apps/web")
  assert.equal(globBase("apps/web/**/*.test.ts"), "apps/web")
  assert.equal(globBase("packages/validation/src/fee-schedule*"), "packages/validation/src")
  // A feature declaring a cross-route test glob must serialize with the route it reaches into.
  const by = { "web-api": ["apps/web/app/api/**"], "web-browse": ["apps/web/app/(browse)/**"] }
  const a = { id: "F1", module: "web-api", pathGlobs: ["apps/web/**/__tests__/**"] }
  const b = { id: "F2", module: "web-browse" }
  assert.equal(featuresConflict(a, b, by), true)
  assert.equal(globsOverlap(["apps/web/**/*.test.ts"], ["apps/web/app/(browse)/**"]), true)
})

test("helpers: pathPrefixOverlap detects prefix relationships", () => {
  assert.equal(pathPrefixOverlap("a", "a/b"), true) // a is a prefix of a/b
  assert.equal(pathPrefixOverlap("a/b", "a/c"), false)
  assert.equal(pathPrefixOverlap("packages/api/src/handover", "packages/api/src/subscription"), false)
  assert.equal(pathPrefixOverlap("apps/web", "apps/web-admin"), false) // segment-wise, not string-wise
})

test("helpers: globsOverlap + featuresConflict", () => {
  assert.equal(globsOverlap(GLOBS.a, GLOBS.ab), true)
  assert.equal(globsOverlap(GLOBS.handover, GLOBS["web-account"]), false)
  assert.equal(featuresConflict({ id: "x", module: "handover" }, { id: "y", module: "handover" }, GLOBS), true)
  assert.equal(featuresConflict({ id: "x", module: "handover" }, { id: "y", module: "web-account" }, GLOBS), false)
})

test("all-disjoint -> one parallel batch, empty serial", () => {
  const feats = [
    { id: "h1", module: "handover" },
    { id: "s1", module: "subscription" },
    { id: "w1", module: "web-account" },
  ]
  const { parallelBatches, serial } = partitionDisjoint(feats, GLOBS)
  assert.equal(parallelBatches.length, 1)
  assert.deepEqual(ids(parallelBatches[0]), ["h1", "s1", "w1"])
  assert.deepEqual(serial, [])
})

test("overlapping pair (same module) -> serial, no parallel", () => {
  const feats = [
    { id: "h1", module: "handover" },
    { id: "h2", module: "handover" },
  ]
  const { parallelBatches, serial } = partitionDisjoint(feats, GLOBS)
  assert.deepEqual(parallelBatches, [])
  assert.deepEqual(ids(serial), ["h1", "h2"])
})

test("escalation is always serial; disjoint siblings still parallelise", () => {
  const feats = [
    { id: "e1", module: "webKernel", isEscalation: true },
    { id: "h1", module: "handover" },
    { id: "s1", module: "subscription" },
  ]
  const { parallelBatches, serial } = partitionDisjoint(feats, GLOBS)
  assert.equal(parallelBatches.length, 1)
  assert.deepEqual(ids(parallelBatches[0]), ["h1", "s1"])
  assert.deepEqual(ids(serial), ["e1"])
})

test("glob-prefix overlap (a/** vs a/b/**) -> conflict -> serial", () => {
  const feats = [
    { id: "x", module: "a" },
    { id: "y", module: "ab" },
  ]
  const { parallelBatches, serial } = partitionDisjoint(feats, GLOBS)
  assert.deepEqual(parallelBatches, [])
  assert.deepEqual(ids(serial), ["x", "y"])
})

test("size-1 batch -> serial (no worktree overhead)", () => {
  const { parallelBatches, serial } = partitionDisjoint([{ id: "h1", module: "handover" }], GLOBS)
  assert.deepEqual(parallelBatches, [])
  assert.deepEqual(ids(serial), ["h1"])
})

test("unknown module globs -> conservative conflict -> serial", () => {
  const feats = [
    { id: "u1", module: "unknownA" },
    { id: "u2", module: "unknownB" },
  ]
  const { parallelBatches, serial } = partitionDisjoint(feats, GLOBS)
  assert.deepEqual(parallelBatches, [])
  assert.deepEqual(ids(serial), ["u1", "u2"])
})

test("mixed: escalation serial + 3 disjoint parallel + same-module pair serial", () => {
  const feats = [
    { id: "e1", module: "webKernel", isEscalation: true },
    { id: "h1", module: "handover" },
    { id: "s1", module: "subscription" },
    { id: "w1", module: "web-account" },
    { id: "w2", module: "web-account" }, // conflicts w1
  ]
  const { parallelBatches, serial } = partitionDisjoint(feats, GLOBS)
  // h1, s1, w1 are mutually disjoint -> one batch of 3; w2 conflicts w1 -> serial; e1 serial.
  assert.equal(parallelBatches.length, 1)
  assert.deepEqual(ids(parallelBatches[0]), ["h1", "s1", "w1"])
  assert.deepEqual(ids(serial), ["e1", "w2"])
})

test("deterministic: same input -> same output, whatever the input order", () => {
  const feats = [
    { id: "s1", module: "subscription" },
    { id: "h1", module: "handover" },
    { id: "w1", module: "web-account" },
  ]
  const a = JSON.stringify(partitionDisjoint(feats, GLOBS))
  const b = JSON.stringify(partitionDisjoint([...feats].reverse(), GLOBS))
  assert.equal(a, b)
})

test("throws on malformed features", () => {
  assert.throws(() => partitionDisjoint("nope", GLOBS), TypeError)
  assert.throws(() => partitionDisjoint([{ module: "handover" }], GLOBS), TypeError) // no id
  assert.throws(() => partitionDisjoint([{ id: "x" }], GLOBS), TypeError) // no module
  assert.throws(() => partitionDisjoint([null], GLOBS), TypeError)
  assert.throws(() => partitionDisjoint([{ id: "x", module: "handover", pathGlobs: "apps/web/**" }], GLOBS), TypeError)
  assert.throws(() => partitionDisjoint([{ id: "x", module: "handover", pathGlobs: [1] }], GLOBS), TypeError)
})

test("the returned shape is exactly {parallelBatches, serial} (no contract-era blocked/landedContracts)", () => {
  const out = partitionDisjoint([{ id: "h1", module: "handover" }], GLOBS)
  assert.deepEqual(Object.keys(out), ["parallelBatches", "serial"])
  for (const dropped of ["laneGlobs", "landedContracts"]) assert.equal(dropped in partitionModule, false, dropped)
})

test("serial order: escalations first (sorted by id), then the rest by id", () => {
  const feats = [
    { id: "a1", module: "handover" },
    { id: "z-esc", module: "webKernel", isEscalation: true },
    { id: "b-esc", module: "adminKernel", isEscalation: true },
    { id: "a2", module: "handover" },
  ]
  const { serial } = partitionDisjoint(feats, GLOBS)
  assert.deepEqual(
    serial.map((f) => f.id),
    ["b-esc", "z-esc", "a1", "a2"],
  )
})

test("a feature's own pathGlobs are added to its module's: an overlap outside the modules serializes the pair", () => {
  const signIn = { id: "WEB-sign-in-ui", module: "web-account", pathGlobs: ["apps/web/app/(account)/**", "apps/web/e2e/auth-otp.spec.ts"] }
  const handover = { id: "H-ui", module: "handover", pathGlobs: ["apps/web/e2e/**"] }
  assert.equal(featuresConflict(signIn, handover, GLOBS), true)
  const { parallelBatches, serial } = partitionDisjoint([signIn, handover], GLOBS)
  assert.deepEqual(parallelBatches, [])
  assert.deepEqual(ids(serial), ["H-ui", "WEB-sign-in-ui"])
  // Without the shared extra path the two modules are disjoint.
  assert.equal(featuresConflict({ ...signIn, pathGlobs: undefined }, { ...handover, pathGlobs: undefined }, GLOBS), false)
})

test("declared pathGlobs never rescue an unknown module (ownership stays unknown -> serial)", () => {
  const feats = [
    { id: "u1", module: "unknownA", pathGlobs: ["x/**"] },
    { id: "h1", module: "handover" },
  ]
  const { parallelBatches, serial } = partitionDisjoint(feats, GLOBS)
  assert.deepEqual(parallelBatches, [])
  assert.deepEqual(ids(serial), ["h1", "u1"])
})

test("a module slug that is an Object.prototype key is unknown, not a crash", () => {
  const feats = [
    { id: "p1", module: "constructor" },
    { id: "h1", module: "handover" },
  ]
  const { parallelBatches, serial } = partitionDisjoint(feats, GLOBS)
  assert.deepEqual(parallelBatches, [])
  assert.deepEqual(ids(serial), ["h1", "p1"])
})

test("pathGlobsBySlug must map slugs to string arrays; the raw agent-routing.json object is refused", () => {
  const raw = { $comment: "registry", modules: { handover: { surface: "backend", pathGlobs: ["packages/api/src/handover/**"] } } }
  assert.throws(() => partitionDisjoint([{ id: "h1", module: "handover" }], raw), /pathGlobsFromRouting/)
  assert.throws(() => partitionDisjoint([], null), TypeError)
  assert.throws(() => partitionDisjoint([], [["a/**"]]), TypeError)
})

test("pathGlobsFromRouting: flattens agent-routing.json modules, skipping $-keys and retired modules", () => {
  const routing = {
    $comment: "registry",
    modules: {
      $comment: "not a module",
      handover: { surface: "backend", pathGlobs: ["packages/api/src/handover/**"] },
      "web-account": { surface: "web", pathGlobs: ["apps/web/app/(account)/**"] },
      "mobile-browse": { surface: "mobile", retired: true, pathGlobs: ["apps/mobile/app/(browse)/**"] },
    },
    sharedKernel: { webKernel: ["apps/web/lib/**"] },
  }
  const bySlug = pathGlobsFromRouting(routing)
  assert.deepEqual(bySlug, {
    handover: ["packages/api/src/handover/**"],
    "web-account": ["apps/web/app/(account)/**"],
  })
  bySlug.handover.push("mutated")
  assert.deepEqual(routing.modules.handover.pathGlobs, ["packages/api/src/handover/**"], "the routing object is not aliased")
  // A feature on a retired module is unknown ownership -> serial.
  const { parallelBatches } = partitionDisjoint(
    [
      { id: "m1", module: "mobile-browse" },
      { id: "h1", module: "handover" },
    ],
    pathGlobsFromRouting(routing),
  )
  assert.deepEqual(parallelBatches, [])
})

test("pathGlobsFromRouting: refuses a non-registry shape", () => {
  assert.throws(() => pathGlobsFromRouting(null), TypeError)
  assert.throws(() => pathGlobsFromRouting({}), TypeError)
  assert.throws(() => pathGlobsFromRouting({ modules: [{ slug: "handover", pathGlobs: [] }] }), TypeError) // an array-of-modules registry is not this repo's shape
  assert.throws(() => pathGlobsFromRouting({ modules: { handover: { pathGlobs: "packages/api/**" } } }), TypeError)
  assert.throws(() => pathGlobsFromRouting({ modules: { handover: null } }), TypeError)
})

test("the live web-foundation M1 shape: four disjoint module features batch, the kernel escalation runs first in serial", () => {
  const bySlug = {
    notification: ["packages/api/src/notifications/**"],
    auth: ["packages/api/src/auth/**"],
    "web-api": ["apps/web/app/api/**"],
    "web-account": ["apps/web/app/(account)/**"],
  }
  const feats = [
    { id: "WEB-notification", module: "notification", pathGlobs: ["packages/api/src/notifications/**"] },
    { id: "WEB-auth-backend", module: "auth", pathGlobs: ["packages/api/src/auth/**"] },
    { id: "WEB-auth-web", module: "web-api", pathGlobs: ["apps/web/app/api/**", "apps/web/__tests__/api/**"] },
    { id: "WEB-sign-in-ui", module: "web-account", pathGlobs: ["apps/web/app/(account)/**", "apps/web/e2e/auth-otp.spec.ts"] },
    { id: "WEB-admin-auth", module: "adminKernel", isEscalation: true, pathGlobs: ["apps/admin/lib/**"] },
  ]
  const { parallelBatches, serial } = partitionDisjoint(feats, bySlug)
  assert.equal(parallelBatches.length, 1)
  assert.deepEqual(ids(parallelBatches[0]), ["WEB-auth-backend", "WEB-auth-web", "WEB-notification", "WEB-sign-in-ui"])
  assert.deepEqual(serial.map((f) => f.id), ["WEB-admin-auth"])
})
