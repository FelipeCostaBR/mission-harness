# Invariants

Rules that hold in every mission. Each one exists because breaking it produced a
failure that **every other check passed**. That is the bar for being on this
list: not "this seems wise", but "this shipped, green, and was wrong".

Read this file when you are about to make an exception. The exception has
probably already been tried.

---

### 1. Seat boundaries are absolute

A **validator never edits.** A **worker never commits.** An **orchestrator never
lets a worker touch a protected surface.**

A validator that can edit will fix what it was asked to judge. A worker that
commits makes the mission's history unattributable and breaks the clean-tree
assumption the next worker depends on.

### 2. The contract is written before any code, and a human approves it

A definition of done authored after the implementation describes the
implementation. The approval gate is not ceremony: roughly 40% of defects found
across real runs existed before a line of code was written, and this is the only
point where a human sees the plan cheaply enough to change it.

### 3. Two corrective rounds, then stop

A feature that fails validation twice is stuck — agents arguing, or blindly
re-editing the same test to force green. A third attempt reliably burns tokens
without converging. On hitting the cap: checkpoint the stuck state to a
`debug/<mission>-<milestone>-stuck` branch, set `missionStatus: "halted"`, and
hand the human the failing verdicts plus the gate output.

### 4. The round counter IS the safety mechanism

Two rules read `correctiveRounds[milestone]` and nothing else: the circuit
breaker, and the worker-seat escalation. **A round that is logged but not counted
disarms both, silently.**

Observed: a round log holding a dozen corrective entries across five milestones
while the counter recorded one milestone at 2 — and another milestone ran five
uncapped rounds with no breaker. `contractor check` treats a counter behind its
log as an **error** for exactly this reason.

### 5. Verdicts are persisted raw, then derived — never paraphrased

Each validator's returned object is written verbatim before any value is read
from it. `assertionStatus` is computed mechanically from those files. **A missing
verdict file means failing, never assumed-pass.**

`boundaryViolations[]` and `missingDefaults[]` are hard blockers, not notes.

A real run transcribed verdicts from memory and recorded a genuine drift as
"passing with notes", masking it entirely.

### 6. The integration gate is mandatory, deterministic, and orchestrator-run

Per-area checks structurally cannot see breakage that spans the repository: a
whole-program type graph, an exhaustive registry mapping, a generated client
drifting from its schema, a cross-source consistency suite.

**Delete incremental build caches first.** A warm build cache makes the compiler
skip re-checking touched files and report a **false green** — and a type-stripping
test runner will pass too, so a real type error can ride the entire gate.

Derive extra suites from the **commit**, not from the touched-area set. A changed
path that no area owns reds its own suite while every area suite stays green.

A red gate blocks the milestone exactly like a failing assertion.

### 7. Escalation edits are verified, not assumed

Every change to a protected surface: read before edit as its own call, confirm the
tool reported success, prove the post-condition with a command, and confirm the
staged diff shows every intended file with a non-zero delta before committing.

Three silent no-ops make this necessary, and they mask each other:

- an edit tool failing inside a large parallel batch;
- **staging an unchanged file, which exits 0**, so a commit can "succeed"
  containing nothing;
- a migration applying to the database independently of its schema declaration,
  leaving generated types blind to a value the database accepts.

`verifiedBy` records the exact commands and exit codes. The gate re-runs them. No
`verifiedBy` means unverified, which blocks.

### 8. Substantial escalations are delegated, never done inline

Inline escalation work collapses the creator/verifier split on precisely the
highest-blast-radius files in the repository, and it was the orchestrator's
largest reducible context sink (11-28% of long sessions).

`contractor escalate` size-gates it. `additiveOnly` defaults to false because
wrongly-inline (creator/verifier collapse on real logic) is far worse than
wrongly-delegated (a slightly over-provisioned worker).

A delegated escalation **must** be recorded with `implementedBy:
"escalation-worker"` — the fresh-validator spawn keys on exactly that marker.
Observed: two escalation workers ran with no marker recorded, so no validator
ever spawned and the creator/verifier restoration silently did not happen.

### 9. Workers persist their own handoffs and return a digest

Full handoffs returning through the orchestrator measured 10-18% of a
worker-heavy session, and passed through its context a second time as the write
that persisted them.

The `_meta` merge into the persisted file is the **deterministic proof** the
worker's `handoffWritten: true` claim was true. If the file is missing or
unparsable, treat it exactly like a failed handoff.

### 10. Working-directory independence for all bookkeeping

A shell's working directory persists across calls, so one `cd` inside a compound
command silently changes it for every later step. Relative bookkeeping paths then
resolve somewhere else entirely and **exit 0**.

Use the `contractor` CLI for flag operations, `git -C <root>` for commits, and
absolute paths for file operations. This is the documented root cause of a "hook
left armed" incident, and it recurred later as an edit queue that silently stopped
recording mid-run.

### 11. The edit queue is best-effort and never the sole source of scope

Two structural failure modes, neither of them bugs to fix:

- **Worktree binding.** Most runtimes freeze their project directory at session
  boot. A mission running in a different worktree resolves its flag and queue
  against the boot worktree, so its queue stays empty for the whole run while
  everything else looks normal.
- **Concurrency.** The queue is read-modify-write; parallel workers racing on it
  lose entries.

Probe at arm time and record `queueSubstrate`. Under parallelism, use
`scopeOverride`. The always-available fallback is handoff-declared areas ∪ the
areas owning the milestone's committed paths.

**A silent empty queue that was probed `live` must never pass un-cross-checked.**

### 12. Parallelism requires proven disjointness

Features run concurrently only when the tested partition rule proves their areas
are disjoint. The rule is conservative: unknown ownership or overlapping globs
serialize, so the worst case is the proven-correct serial path.

**Verify each worktree's base.** Worktree isolation usually forks the primary
repository HEAD, which in a nested-worktree session can be a stale commit where
scoped build commands match nothing and exit 0 — making every worker self-check a
phantom. On failure, abort the batch and run the milestone serially.

Escalations are always serial.

### 13. Unowned paths are the architecture, not a gap

Paths that no area owns — shared kernels, schemas, generated registries,
cross-cutting handlers — are excluded **deliberately**, so a path-scoped worker
cannot edit them. **Never widen an area's globs to absorb one.**

Enumerate them at plan time and batch them into one early milestone. Discovered
mid-milestone, each interrupts a running milestone to serialize through the
orchestrator; roughly two thirds of the escalations on one large mission were
structural rather than error, and it was *when* they surfaced that cost.

### 14. Orchestrator context is a mission resource

A mission runs across many context windows. Measured: **30-42% of all
orchestrator tokens went on re-orientation** — each fresh window re-reading source
to rediscover what the previous one knew. The window ceiling was never the
failure; the toll at each window change was.

Therefore: the artifacts are the only memory; `contractor brief` replaces
re-reading; `decisions[]` and `constraints[]` are written at every boundary; and
the reset fires **at a milestone boundary, never at a token threshold** — a
threshold can land mid-worker and checkpoint a torn state.

A brief carrying status alone measurably did **not** reduce the toll. The
knowledge half is what makes a reset cheap, and a cheap reset is what makes
per-milestone resets viable at all.

### 15. `gated` is not `done`

If any assertion could not be verified in-harness because the runner was
unavailable, the mission is `gated`: non-active, non-terminal, and never reported
as finished. Record the required verification as a follow-up with its exact
commands, and leave the state file in place.

A mission was once recorded `done` with several unverified legs; the deferred
real run then found four genuine cross-screen bugs.

### 16. A falsified hypothesis is not a defect

An assertion carrying a `hypothesisGate` whose gate returns NO-GO records
`hypothesis-failed` and **does not open a corrective round**. No sharpened
procedure fixes a falsified hypothesis.

The other assertions still earn real verdicts — never mark them passing from a
handoff on the way out. Then halt clean: safe state preserved, result recorded,
no debug branch, no round burned, and the milestone not marked done.

### 17. The hook is inert outside a mission

`contractor disarm` removes the flag and records an honest status, then verifies
its own post-condition and exits non-zero if the flag survived. The hook also
requires **both** signals — flag present AND `missionStatus === "active"` — so a
leftover flag from a failed disarm is harmless once the milestone is recorded.

Never remove the flag with a bare relative `rm`. See invariant 10.
