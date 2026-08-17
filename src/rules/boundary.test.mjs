import test from "node:test"
import assert from "node:assert/strict"
import { boundaryViolations, pathWithinGlobs } from "./boundary.mjs"

const globs = ["src/billing/**", "test/billing/**"]

test("in-bounds paths produce no violations", () => {
  assert.deepEqual(
    boundaryViolations(["src/billing/invoice.ts", "test/billing/invoice.test.ts"], globs),
    [],
  )
})

test("an out-of-area edit is reported", () => {
  assert.deepEqual(boundaryViolations(["src/auth/session.ts"], globs), ["src/auth/session.ts"])
})

test("violations are deduped and sorted", () => {
  assert.deepEqual(boundaryViolations(["b/x.ts", "a/y.ts", "b/x.ts"], globs), ["a/y.ts", "b/x.ts"])
})

test("no declared ownership means every edit is out of bounds", () => {
  // Conservative: an area with no globs cannot silently authorize anything.
  assert.deepEqual(boundaryViolations(["src/anything.ts"], []), ["src/anything.ts"])
})

test("a mid-pattern ** matches, which is what escalation grants generate", () => {
  // Regression guard: a prefix-based implementation reports every one of these as
  // a violation, and boundaryViolations is a HARD blocker — so the bug halts
  // clean milestones. escalation-route generates exactly this glob shape.
  const g = ["src/**/__tests__/**"]
  assert.equal(pathWithinGlobs("src/billing/__tests__/invoice.test.ts", g), true)
  assert.equal(pathWithinGlobs("src/a/b/c/__tests__/deep.test.ts", g), true)
  assert.equal(pathWithinGlobs("src/billing/invoice.ts", g), false)
})

test("literal parens in real framework paths are matched, not treated as regex", () => {
  const g = ["app/(authed)/**"]
  assert.equal(pathWithinGlobs("app/(authed)/dashboard/page.tsx", g), true)
  assert.equal(pathWithinGlobs("app/xauthedx/dashboard/page.tsx", g), false)
})

test("a single * stays within one segment", () => {
  const g = ["src/*.ts"]
  assert.equal(pathWithinGlobs("src/index.ts", g), true)
  assert.equal(pathWithinGlobs("src/nested/index.ts", g), false)
})

test("dir/** also grants dir itself", () => {
  assert.equal(pathWithinGlobs("src/billing", ["src/billing/**"]), true)
})

test("a wildcard-free glob keeps prefix semantics", () => {
  assert.equal(pathWithinGlobs("src/billing/x.ts", ["src/billing"]), true)
  assert.equal(pathWithinGlobs("src/billingx/x.ts", ["src/billing"]), false)
})

test("bad input throws", () => {
  assert.throws(() => boundaryViolations("nope", globs), TypeError)
  assert.throws(() => boundaryViolations([], "nope"), TypeError)
  assert.throws(() => pathWithinGlobs("", globs), TypeError)
})
