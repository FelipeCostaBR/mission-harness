# Failure playbook

Ways agent-built work goes wrong while every check reports green. Each entry is a
pattern observed in production runs, generalized. They are grouped by the phase
that can still catch them cheaply.

The unifying property: **none of these are caught by "did the tests pass?"**

---

## Plan phase

Roughly 40% of the defects found across real runs existed before a line of code
was written. These are the expensive ones, because a faithful worker implements
them correctly.

### The assertion that passes while the feature is broken

The single question to ask about every assertion. Concrete shapes:

- **Self-cancelling wording.** "Both surfaces show the same value (within
  rounding)" passes at any delta you decide to call rounding. → Pin the literal
  bound and justify the number.
- **Declared, not enforced.** "The concurrency limit is 4" is satisfied by a
  constant that is defined and never referenced, while the limit is a complete
  no-op. → Use the verb **"enforced"** and name the proving test.
- **Existence proxies.** A suite asserting `claims.length > 0` measures that prose
  was written, not that it is true. → Require a machine-checkable binding both
  sides reference, or record accuracy as manual-audit-only with a mandatory
  re-audit follow-up.
- **Implementation-mirroring coverage.** A golden fixture hand-authored in the
  *output* shape cannot catch a defect in the builder that produced it. → Require
  at least one fixture built by running the production builder over representative
  *input* shapes.

### The premise nobody checked

An assertion or procedure naming a function, route, tag, flag or file that must
already exist — where it does not. The false premise goes straight into a worker's
payload, and a worker that finds the named accessor missing will often reach
across an area boundary instead, which is caught later and costs a round.

→ **Grep every codebase fact at plan time and cite it in the assertion's note.** A
fact you cannot verify is demoted to a behavioural assertion, never restated as
true.

### The assertion that contradicts its own design

An assertion constraining a *mechanism* ("no network call", "index-only") that
asserts the **negation** of what the spec deliberately chose. Verify-then-assert
cannot catch this: no code exists yet. A faithful worker converts it into a false
FAIL and a mid-run rewrite.

→ Re-read the spec section the assertion derives from, and cite it. Disambiguate
precisely — "no generative model call" is not "no model round-trip".

### Scope owned by nobody

An assertion bound to a milestone that no feature builds. It surfaces as a
validator failure that no corrective round can fix by sharpening a procedure,
because nothing was ever scoped to build it.

→ Every assertion is named by a feature, **and** that feature's area actually
produces the behaviour. If the phases live in different areas, split the feature.

### Coverage orphaned by a freeze

An assertion covering milestone N's own output (its tests, its README, the doc of
a flag N introduces) bound to milestone N+1. A mission can halt between them,
leaving N's shipped mechanism undocumented and untested.

→ A milestone owns coverage of its own output.

### The repo-wide claim on a path-scoped worker

"No X anywhere", "every route", "all user-facing copy" — bound to one feature. A
path-scoped worker structurally cannot satisfy it, and the shortfall appears at
validation as reactive cross-area escalations.

→ Pre-enumerate the owning areas, make it an orchestrator-owned serial sweep, or
split into per-area assertions.

### The impossible pair

Two assertions constraining the same path in opposite directions — one asserting
it is unchanged, another mandating an edit under it. Cheap to reframe now, a
stalled milestone to discover mid-run.

### The unsafe "run now" escalation

A schema or shared-contract change planned as in-milestone work, underneath live
consumers. A non-nullable mutation or a contract flip with writers still active.

→ Grep the deployment facts first. If any hold, split the milestone so the
consumer ships against the *existing* contract, and descope the schema leg with a
concrete follow-up.

### Speculative work gating shippable work

A milestone whose acceptance is a hypothesis, sitting in front of features that
ship independently. A NO-GO then freezes work that had nothing wrong with it.

→ Mark it `hypothesisGate` and make sure it gates nothing shippable.

---

## Run phase

### The queue that was never alive

Most runtimes freeze their project directory at session boot. A mission in a
different worktree resolves its flag and queue against the boot worktree, so its
queue stays empty for the whole run while everything else looks normal.

→ Probe at arm time and record `queueSubstrate`. Probed up front it is a known
fact; discovered at the boundary, an empty queue is ambiguous between "nothing was
edited" and "the queue was dead", and the two demand opposite responses.

### The stale worktree base

Worktree isolation forks the primary repository HEAD, which in a nested-worktree
session can be a stale commit where scoped build commands match nothing and
**exit 0**. Every worker self-check passes having run nothing at all.

→ Assert the base branch and that a scoped build command actually resolves. On
failure, abort the batch and run serially.

### The silent no-op trio

Three ways a change reports success and did not happen. They mask each other,
which is why the escalation protocol checks all three:

1. An edit tool failing inside a large parallel batch.
2. **Staging an unchanged file exits 0**, so a commit can "succeed" containing
   nothing.
3. A migration applying to the database independently of its schema declaration,
   leaving generated types blind to a value the database accepts.

### The false-green typecheck

An incremental compiler with a warm build cache skips re-checking touched files
and reports green. A type-stripping test runner passes too. A real type error
rides the entire gate.

→ Delete the build artifact first. Always whole-program, never per-file.

### The mandate between two features

A design-spec section owned by nobody. It ships, or does not, purely on the order
the features happened to run in.

→ Attribute every spec section to an owning feature at plan time. A section owned
by no feature is a planning hole.

---

## Validate phase

### The verdict that was paraphrased

Verdicts transcribed from memory, and a genuine drift recorded as "passing with
notes".

→ Persist the returned object byte-for-byte **before** reading any value from it,
then derive status mechanically. A missing verdict file is a failure, never an
assumed pass.

### The disarmed circuit breaker

A round logged but not counted. Two rules read that counter and nothing else — the
breaker and the seat escalation — so one missed increment disarms both, silently.
Observed: a milestone running five uncapped rounds.

→ `contractor check` errors on a counter behind its log.

### The escalation nobody reviewed

A delegated escalation recorded without `implementedBy: "escalation-worker"`. The
fresh-validator spawn keys on exactly that marker, so no validator spawns and the
creator/verifier split silently does not happen — on the highest-blast-radius
files in the mission.

### The "defensive" path everyone takes

A handoff describes a silent no-op as defensive. It is only defensive if the
primary cohort does not traverse it. Observed: a write that silently no-opped for
every user lacking a profile row — which was *all* free users, not a rare race.

→ Work out who actually takes the path. If it is the primary cohort, it is a
functional break.

### The hazard the implementer named and punted

A handoff that NAMES a correctness hazard the implementation does not guard. The
hardening round is for gaps a fresh adversarial context finds, not for hazards the
implementer already saw.

→ A named-but-unguarded hazard blocks. Punting it does not save the round it
costs.

### The green boundary that hid real bugs

Every milestone passing its validators and the gate first try, with zero
corrective rounds — while a separate human review found genuine defects in each
one, including write-path authorization holes and a non-idempotent race.

Contract-scoped validators check the ASSERTED claims. They do not run an
open-ended correctness hunt, and a new area's contract cannot assert invariants
nobody anticipated.

→ The adversarial correctness pass on high-risk milestones, and the mission-final
pass over the whole commit range. Both on their own counters, so running the
safety net never trips the breaker.

### The gap that advanced as OPEN

A test gap recorded as "candidate for a future hardening bundle". Gaps carried in
that limbo reach mission close still open.

→ At advance, every gap is CLOSED, ACCEPTED (with a reason), or
DEFERRED-TO-\<milestone\>.

### The inconclusive that read as verified

A subjective design-fidelity result returned inconclusive, recorded once, and
never tracked. Every later reader takes it as verified.

→ Name the specific unverified principles, and write a tracked follow-up.

---

## Finish

### `done` that was not done

A mission recorded `done` with several unverified on-device legs. The deferred
real run found four genuine cross-screen bugs.

→ `gated` is a distinct terminal state. Any assertion that could not be verified
in-harness bars `done`, records the required verification as a follow-up with its
exact commands, and leaves the state file in place.

### The orchestrator that cleared its own reset flag

A context reset marked discharged at a boundary with no reset actually happening.
The session ran on for hundreds of thousands of tokens while the state file
claimed nothing was needed.

→ The watcher owns both edges of that flag. The orchestrator acts on it and never
clears it.
