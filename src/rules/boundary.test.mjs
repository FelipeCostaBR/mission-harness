/**
 * node:test for boundary.mjs (the B5 out-of-module path-membership rule).
 * Run: node --test .claude/skills/run-prd-multi-agent-architecture/lib/boundary.test.mjs
 * Covers BND-1.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { boundaryViolations, pathWithinGlobs } from "./boundary.mjs"

const HANDOVER = ["packages/api/src/handover/**", "apps/mobile/handover/**"]

test("pathWithinGlobs: in-bounds vs out-of-bounds", () => {
  assert.equal(pathWithinGlobs("packages/api/src/handover/x.ts", HANDOVER), true)
  assert.equal(pathWithinGlobs("apps/mobile/handover/screen.tsx", HANDOVER), true)
  assert.equal(pathWithinGlobs("packages/api/src/progress/y.ts", HANDOVER), false)
})

test("in-bounds worker -> no violations", () => {
  const changed = [
    "packages/api/src/handover/repo.ts",
    "apps/mobile/handover/screen.tsx",
  ]
  assert.deepEqual(boundaryViolations(changed, HANDOVER), [])
})

test("a stray path is flagged", () => {
  const changed = [
    "packages/api/src/handover/repo.ts",
    "packages/api/src/progress/leak.ts", // OUT of handover
  ]
  assert.deepEqual(boundaryViolations(changed, HANDOVER), [
    "packages/api/src/progress/leak.ts",
  ])
})

test("shared-kernel edit is a violation (not in any module glob)", () => {
  // the @etros/api barrel: agent-routing.json sharedKernel.apiBarrel
  const changed = ["packages/api/src/index.ts"]
  assert.deepEqual(boundaryViolations(changed, HANDOVER), ["packages/api/src/index.ts"])
})

test("multiple globs: backend + mobile both honoured", () => {
  const changed = [
    "packages/api/src/handover/a.ts",
    "apps/mobile/handover/b.tsx",
    "apps/mobile/subscription/c.tsx", // stray (subscription, not handover)
  ]
  assert.deepEqual(boundaryViolations(changed, HANDOVER), ["apps/mobile/subscription/c.tsx"])
})

test("empty allowedGlobs -> every edit is out of bounds (conservative)", () => {
  assert.deepEqual(boundaryViolations(["any/path.ts"], []), ["any/path.ts"])
})

test("empty changedPaths -> no violations", () => {
  assert.deepEqual(boundaryViolations([], HANDOVER), [])
})

test("violations are deduped + sorted", () => {
  const changed = ["z/2.ts", "z/2.ts", "a/1.ts"]
  assert.deepEqual(boundaryViolations(changed, HANDOVER), ["a/1.ts", "z/2.ts"])
})

test("throws on malformed input", () => {
  assert.throws(() => boundaryViolations("nope", HANDOVER), TypeError)
  assert.throws(() => boundaryViolations([], "nope"), TypeError)
  assert.throws(() => pathWithinGlobs("", HANDOVER), TypeError)
})

// ── BND-2: mid-pattern `**` (regression, fixed 2026-08-14) ───────────────────
// The old implementation derived a literal prefix via `globBase`, which leaves a
// mid-pattern `**` in place. `apps/web/**/__tests__/**` became the base
// `apps/web/**/__tests__`, which no real path starts with, so EVERY matching
// test file was reported as a boundary violation. That is a hard blocker at
// validation, and `routeEscalation` generates this exact glob shape for every
// escalation, so a clean milestone could be halted by a false positive.

const ESC_GLOBS = ["apps/web/lib/data/**", "apps/web/**/__tests__/**", "packages/api/__tests__/**"]

test("mid-pattern ** matches at every depth (the regression)", () => {
  assert.equal(pathWithinGlobs("apps/web/__tests__/x.test.tsx", ESC_GLOBS), true)
  assert.equal(pathWithinGlobs("apps/web/app/(site)/__tests__/x.test.tsx", ESC_GLOBS), true)
  assert.equal(pathWithinGlobs("apps/web/app/(site)/components/__tests__/x.test.tsx", ESC_GLOBS), true)
  assert.deepEqual(
    boundaryViolations(
      [
        "apps/web/__tests__/a.test.tsx",
        "apps/web/app/(site)/__tests__/b.test.tsx",
        "apps/web/app/(site)/components/__tests__/c.test.tsx",
      ],
      ESC_GLOBS,
    ),
    [],
  )
})

test("mid-pattern ** stays PRECISE: a non-matching tail is still a violation", () => {
  // The fix must not degenerate into "anything under apps/web is fine", which
  // is what truncating the glob at its first wildcard would have done.
  assert.equal(pathWithinGlobs("apps/web/app/(site)/components/FleetGrid.tsx", ESC_GLOBS), false)
  assert.equal(pathWithinGlobs("apps/web/app/(site)/components/__tests__x/y.ts", ESC_GLOBS), false)
  assert.deepEqual(boundaryViolations(["apps/web/app/(site)/components/FleetGrid.tsx"], ESC_GLOBS), [
    "apps/web/app/(site)/components/FleetGrid.tsx",
  ])
})

test("trailing ** still grants the directory itself (unchanged behaviour)", () => {
  assert.equal(pathWithinGlobs("packages/api/src/handover", HANDOVER), true)
  assert.equal(pathWithinGlobs("apps/web/lib/data", ESC_GLOBS), true)
})

test("literal parens in a path are matched, not treated as regex", () => {
  // Real Etros paths carry (site)/(authed)-style route groups; a naive regex
  // translation breaks here.
  const globs = ["apps/web/app/(site)/**/__tests__/**", "apps/web/app/(site)/legal/privacy/page.tsx"]
  assert.equal(pathWithinGlobs("apps/web/app/(site)/components/__tests__/fleet.test.tsx", globs), true)
  assert.equal(pathWithinGlobs("apps/web/app/(site)/legal/privacy/page.tsx", globs), true)
  assert.equal(pathWithinGlobs("apps/web/app/site/components/__tests__/fleet.test.tsx", globs), false)
})

test("single * matches within one segment only", () => {
  const globs = ["packages/db/scripts/backfill-*.ts"]
  assert.equal(pathWithinGlobs("packages/db/scripts/backfill-fee-schedule.ts", globs), true)
  assert.equal(pathWithinGlobs("packages/db/scripts/seed-rate-plans.ts", globs), false)
  // `*` must NOT span a path separator.
  assert.equal(pathWithinGlobs("packages/db/scripts/nested/backfill-x.ts", globs), false)
})

test("wildcard-free globs keep the original prefix rule", () => {
  const globs = ["apps/web/app/(site)/pricing/page.tsx", "packages/db"]
  assert.equal(pathWithinGlobs("apps/web/app/(site)/pricing/page.tsx", globs), true)
  assert.equal(pathWithinGlobs("packages/db", globs), true)
  assert.equal(pathWithinGlobs("packages/db/prisma/schema.prisma", globs), true)
  assert.equal(pathWithinGlobs("packages/db-other/x.ts", globs), false)
})

test("a ./-prefixed changed path is normalised, never a false violation", () => {
  const globs = ["packages/api/src/auth/**"]
  assert.deepEqual(boundaryViolations(["./packages/api/src/auth/a.ts"], globs), [])
  assert.equal(pathWithinGlobs("./packages/api/src/auth/a.ts", globs), true)
  // a ./-prefixed glob is read the same way
  assert.deepEqual(boundaryViolations(["packages/api/src/auth/a.ts"], ["./packages/api/src/auth/**"]), [])
  // a real stray is still reported, repo-relative
  assert.deepEqual(boundaryViolations(["./packages/api/src/billing/b.ts"], globs), ["packages/api/src/billing/b.ts"])
})

test("an absolute lane path is normalised against the given root; one under another root stays a violation", () => {
  const globs = ["packages/api/src/auth/**"]
  const lane = "/Users/x/Etros/.claude/worktrees/lane-1"
  assert.deepEqual(boundaryViolations([`${lane}/packages/api/src/auth/a.ts`], globs, { root: lane }), [])
  assert.deepEqual(boundaryViolations([`${lane}/packages/api/src/auth/a.ts`], globs, { root: `${lane}/` }), [])
  assert.deepEqual(
    boundaryViolations([`${lane}/packages/api/src/billing/b.ts`], globs, { root: lane }),
    ["packages/api/src/billing/b.ts"],
  )
  // without a root, or under a different root, the absolute path is out of bounds
  assert.deepEqual(boundaryViolations([`${lane}/packages/api/src/auth/a.ts`], globs), [`${lane}/packages/api/src/auth/a.ts`])
  assert.deepEqual(
    boundaryViolations(["/other/root/packages/api/src/auth/a.ts"], globs, { root: lane }),
    ["/other/root/packages/api/src/auth/a.ts"],
  )
})
