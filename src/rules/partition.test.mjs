import test from "node:test"
import assert from "node:assert/strict"
import { partitionDisjoint, globsOverlap, globBase } from "./partition.mjs"

const globsByArea = {
  billing: ["src/billing/**"],
  auth: ["src/auth/**"],
  reporting: ["src/reporting/**"],
}

test("disjoint areas batch together", () => {
  const { parallelBatches, serial } = partitionDisjoint(
    [
      { id: "F1", area: "billing" },
      { id: "F2", area: "auth" },
    ],
    globsByArea,
  )
  assert.equal(parallelBatches.length, 1)
  assert.deepEqual(parallelBatches[0].map((f) => f.id), ["F1", "F2"])
  assert.deepEqual(serial, [])
})

test("two features in the same area never run in parallel", () => {
  const { parallelBatches, serial } = partitionDisjoint(
    [
      { id: "F1", area: "billing" },
      { id: "F2", area: "billing" },
    ],
    globsByArea,
  )
  assert.equal(parallelBatches.length, 0)
  assert.deepEqual(serial.map((f) => f.id), ["F1", "F2"])
})

test("escalations are always serial", () => {
  const { parallelBatches, serial } = partitionDisjoint(
    [
      { id: "F1", area: "billing" },
      { id: "F2", area: "auth" },
      { id: "E1", area: "auth", isEscalation: true },
    ],
    globsByArea,
  )
  assert.deepEqual(serial.map((f) => f.id), ["E1"])
  assert.deepEqual(parallelBatches[0].map((f) => f.id), ["F1", "F2"])
})

test("unknown area ownership serializes (conservative)", () => {
  const { parallelBatches, serial } = partitionDisjoint(
    [
      { id: "F1", area: "billing" },
      { id: "F2", area: "mystery" },
    ],
    globsByArea,
  )
  assert.equal(parallelBatches.length, 0)
  assert.equal(serial.length, 2)
})

test("overlapping globs across differently-named areas serialize", () => {
  const overlapping = { a: ["src/shared/**"], b: ["src/shared/sub/**"] }
  const { parallelBatches } = partitionDisjoint(
    [
      { id: "F1", area: "a" },
      { id: "F2", area: "b" },
    ],
    overlapping,
  )
  assert.equal(parallelBatches.length, 0)
})

test("a batch of one runs in-tree rather than paying worktree overhead", () => {
  const { parallelBatches, serial } = partitionDisjoint([{ id: "F1", area: "billing" }], globsByArea)
  assert.equal(parallelBatches.length, 0)
  assert.deepEqual(serial.map((f) => f.id), ["F1"])
})

test("partitioning is deterministic regardless of input order", () => {
  const a = partitionDisjoint(
    [
      { id: "F3", area: "reporting" },
      { id: "F1", area: "billing" },
      { id: "F2", area: "auth" },
    ],
    globsByArea,
  )
  const b = partitionDisjoint(
    [
      { id: "F2", area: "auth" },
      { id: "F3", area: "reporting" },
      { id: "F1", area: "billing" },
    ],
    globsByArea,
  )
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b))
})

test("glob helpers behave as the overlap check expects", () => {
  assert.equal(globBase("src/billing/**"), "src/billing")
  assert.equal(globsOverlap(["src/a/**"], ["src/b/**"]), false)
  assert.equal(globsOverlap(["src/a/**"], ["src/a/deep/**"]), true)
})

test("malformed features throw", () => {
  assert.throws(() => partitionDisjoint("nope"), TypeError)
  assert.throws(() => partitionDisjoint([{ area: "billing" }]), TypeError)
  assert.throws(() => partitionDisjoint([{ id: "F1" }]), TypeError)
})
