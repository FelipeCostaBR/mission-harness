# Phase 3 — Validate

You are the orchestrator **at a milestone boundary**, running adversarial
validation.

Validators are fresh agents that never saw the implementation. They are skeptical
by design. **Validation rarely passes on the first attempt, and that is the point
of having it.** A boundary that always passes first try is not evidence the work
is good; it is evidence the verifier is not adversarial enough.

---

## 1. Determine the scope source, then drain

In this order:

1. **If `scopeOverride` is set for this milestone** (the run phase recorded a
   handoff-derived area set because the milestone ran a parallel batch), use it
   and **skip the queue entirely.** The queue is read-modify-write and races lose
   entries — this holds even when the substrate probe said `live`.

2. **Else read `queueSubstrate.status`.** If `unavailable-worktree`, the queue is
   dead by construction. Derive the touched-area set from the handoffs (each names
   its feature → area) ∪ the areas owning the milestone's committed paths
   (`git show --name-only`, routed through `contractor own`). **Do not read the
   queue, and do not treat its emptiness as a finding** — its deadness was
   recorded at arm time, not discovered now.

3. **Else drain it:** `contractor status` shows the queued areas; the drain drops
   entries stamped with another mission mechanically. If the queue is empty but
   the milestone had features **and** the substrate was `live`, do not silently
   fall back: re-probe with `contractor route --resolve <a changed path>` first.
   If the flag resolves from the root but the queue was empty during the run, the
   cause is a working-directory drift inside the run. Record it in
   `boundaryNotes` so a retro can count it, and proceed on handoff ∪ commit scope.
   **A silent empty `live` queue must never pass un-cross-checked.**

---

## 2. Spawn one validator per touched area

Read-only, fresh context, in parallel. Use `contractor prompt seats/validator`
(or `seats/ui-validator` for a surface that renders an interface — pass it the
milestone's design spec).

Give each: the `area`, the contract assertions bound to that area for this
milestone, the `changedPaths` for that area, the project `constraints`, the
surface's gate commands, and `missionDir`. Force the verdict schema.

**Five rules that apply to every validator spawn:**

- **No owning feature → fail, not search.** If an assertion bound to this
  milestone is claimed by NO worker handoff, the validator returns `fail` with
  evidence "no owning feature" rather than hunting for a partial implementation.
  That is a planning hole, and it routes to a corrective that BUILDS the missing
  leg — not to a hardening round.

- **A design-spec mandate that no feature implemented is a blocking gap**, even
  when every individual assertion passes. Otherwise a mandate that fell between
  two features ships on sequencing luck.

- **An inconclusive subjective judgement must be TRACKED, not orphaned.** When a
  validator returns an inconclusive design-fidelity result, you MUST write a
  matching `followUps[]` entry naming exactly what is unverified, and flag the
  milestone. Recorded once and orphaned, an inconclusive reads as verified to
  every later reader.

- **A "defensive" path that the PRIMARY cohort actually takes is a functional
  break.** When a handoff describes a silent no-op or a silent drop, determine
  whether the contract's primary users actually traverse that path. If they do, it
  is a blocking gap, not an accepted defensive follow-up. (Real instance: a write
  that silently no-opped for every user lacking a profile row — which was *all*
  free users, not a rare race — shipped as "defensive".)

- **A self-flagged but unguarded hazard is a blocking gap.** If a handoff NAMES a
  correctness hazard the implementation does not guard, it blocks. The implementer
  already saw it; it does not get absorbed into a hardening budget.

### 2a. The delegated-escalation validator

For every `escalations[]` entry this milestone carrying `implementedBy:
"escalation-worker"`, spawn ONE additional fresh read-only validator, in parallel
with the area validators.

Payload: the escalation's reason, its `handoffs/ESC-<id>.json`, its declared file
list, and its `workerPathGlobs`. It must (i) bound the handoff's changed paths
against those globs, (ii) re-run the handoff's `verifiedBy` commands, and (iii)
adversarially review the shared-surface change itself — type-graph blast radius,
registry exhaustiveness, schema/migration lockstep.

**Escalation files belong to no area, so without this spawn a delegated
escalation has no owner at all.** These are the highest-blast-radius changes in
the mission.

---

## 2b. The deterministic integration gate — mandatory, non-negotiable

Per-area validators run per-area checks, which **cannot** see breakage that spans
the repository. Run every command in your config's `gates.pre` then
`gates.integration`, and require exit 0 on each.

Add, derived from the milestone's actual commit (`git show --name-only`), not
from the touched-area set:

- **Each touched area's own test suite.** The repo-wide architecture suites do
  not cover an area's unit tests; a stale mock or a vacuous assertion otherwise
  surfaces several milestones late.
- **The mirror suite for any changed path that no area owns.** A changed route
  handler reds its OWN route suite while every area suite stays green. Derive
  these from the commit; tolerate "no tests found" where an edit has no mirror.
- **Schema lockstep**, if a schema file changed: validate the schema, regenerate
  the client, confirm the generated artifact carries every new symbol, and only
  THEN run the full typecheck. The data layer cannot be called done while the
  generated types disagree with the schema.
- **Every escalation's `verifiedBy` commands**, re-run. An escalation with no
  `verifiedBy` evidence FAILS the gate.

**Run quiet.** Redirect each command's output to a log and ingest only the exit
code: `<cmd> > /tmp/gate-N.log 2>&1; echo "exit=$?"`. On a RED command do not
`cat` the log — take a bounded slice (`grep -E "FAIL|error|✕" … | head -40`),
which is what feeds the corrective scoping anyway. Record the log path alongside
the command so a corrective worker can read the full output from disk.

Record `integrationGate: { passed, commands: [{cmd, exitCode, log}], ts }`.

**A red gate blocks the milestone exactly like a failing assertion.** The gate is
deterministic and orchestrator-run, never delegated, because it is the one check
that does not rely on anyone's judgement.

---

## 2c. Adversarial correctness pass for high-risk milestones

The contract-scoped validators check the ASSERTED claims plus the defaults. They
do not run an open-ended correctness hunt, and a new area's contract cannot
assert invariants nobody anticipated.

This is a real and measured gap: on one mission every milestone passed its
validators and the gate first try, with zero corrective rounds — and a separate
human-run code review found genuine defects in each one, including write-path
authorization holes, wrong-row writes, and a non-idempotent race.

So fold that safety net into the loop. When a milestone **(a)** introduces a NEW
area, OR **(b)** any change touches auth/session/token handling, a database
transaction or merge, or a concurrency/idempotency path — spawn ONE read-only
frontier-tier investigator over the milestone's commit range before advancing,
briefed to hunt correctness, security and privacy bugs **beyond** the contract
assertions.

Record it on its OWN counter `adversarialRounds[<milestone>]` (cap 1) and append
a `roundLog[]` entry with `type: "adversarial"`. It is **not** drawn from the
corrective cap, so running the safety net can never trip the circuit breaker. Its
confirmed findings route to self-heal like a failing assertion and **block
advance**; those fixes are ordinary corrective rounds.

---

## 3. Persist the RAW verdict, then derive status

Two steps, in this order, no exceptions.

**a. Immutable raw capture.** Write each validator's returned object VERBATIM to
`<missionDir>/verdicts/<name>.json` — byte for byte, no summarizing, no
paraphrasing, no cleaning up. Do this for **every** validator BEFORE reading any
verdict value.

If a validator did not return, its verdict file is absent → that area is
**failing by default**, never assumed-pass.

**b. Mechanical derivation.** Compute `assertionStatus` STRICTLY from the
persisted files. An assertion is `passing` only if its verdict literally says so.
You may not write `assertionStatus` from expectation, and may not write it before
every validator's file exists.

Any `"verdict": "fail"`, **any** `boundaryViolations[]`, or **any**
`missingDefaults[]` makes the bound assertion `failing`. These are hard blockers,
not notes. Record `testGaps[]` (a `pass` can carry a gap — gaps alone are not
failures) and `informational[]` (recorded, never blocking).

> This protocol exists because a real run transcribed verdicts from memory and
> recorded a genuine drift as "passing with notes", masking it. Persist first,
> read second.

---

## 4. Self-heal

Run the decision:

```
contractor advance <missionDir> <milestoneId>
```

It reads the persisted verdicts, the gate result and the round counter, and
returns `advance`, `corrective` or `circuit-break`.

**Before opening a corrective round, check for an empirical NO-GO.** If the only
non-passing assertion is a `hypothesisGate` whose gate returned NO-GO, record its
state as `hypothesis-failed` (NOT `failing`) and do **not** open a corrective
round — no sharpened procedure fixes a falsified hypothesis. You still spawn the
milestone's validators and run the gate for every OTHER assertion, so they earn
real verdicts. Then halt clean: keep the flag-gated code in its declared safe
state, record the measured result in `boundaryNotes`, set `missionStatus:
"halted"` with **no** debug branch and **no** round logged, and do not mark the
milestone done.

For a real failure:

- **Increment `correctiveRounds[milestone]` AND append to `roundLog[]`** with
  `{ milestone, round, type: "corrective", trigger: [...], at: <ISO-8601>, seat }`.

  ⚠️ **The increment is not bookkeeping, it is the safety mechanism.** Two rules
  read that counter and nothing else: the circuit breaker, and the worker-seat
  escalation. A round that is logged but not counted disarms **both**, silently.
  `contractor check` treats a counter behind its log as an error for exactly this
  reason.

- **Always stamp `at`.** Without it a retro can count rounds but never measure
  them, and "this mission took three days" cannot be attributed to any stage.

- **Pick the worker seat for the round** from `contractor advance`'s output. It
  keeps the cheap seat for the first attempt and escalates to the frontier tier
  for the FINAL round before the breaker would hand off to a human — spending the
  expensive seat only where the cheap one is visibly struggling. Record the seat
  in the round log so a retro can tell whether it helped.

- **Under the cap:** scope follow-up feature(s) targeting exactly the failing
  assertions, with procedures sharpened by the validator's notes. Hand back to
  `run`, then re-validate.

- **At the cap (circuit break):** STOP. Do not attempt a third round. Commit the
  current state to a `debug/<mission>-<milestone>-stuck` branch so the failed state
  is inspectable and the main branch stays clean, set `missionStatus: "halted"`,
  write the failing verdicts and gate output into `mission-state.json`, and flag
  the human with that evidence. **Never silently retry past the cap.** A feature
  that fails validation twice is stuck — agents arguing, or blindly re-editing the
  same test to force green — and a third try reliably just burns tokens.

### 4b. Test hardening — for gaps, even when everything passes

If validators returned `testGaps[]`, scope ONE hardening feature whose procedures
are the gaps' suggested fixes: extract implementation-mirrored logic into pure
functions with exhaustive edge-case tests; add a guarded integration test where
the boundary genuinely cannot move. It runs in a FRESH worker context, so the new
tests are adversarial rather than implementation-mirroring.

It shares the corrective cap — at most one hardening round per milestone — and is
logged with `type: "hardening"` so retros can tell rigor from churn.

**Gap-guards must be discharged before advance.** If a worker reports it wrote a
test that pins the CURRENT broken state and only enforces correctness once a
production fix lands, the milestone must NOT advance on that worker's green
alone. Apply the fix, re-run the test, and confirm it now exercises the
*enforcing* branch (revert the fix locally and watch it go red). An undischarged
gap-guard is a blocking gap, not a follow-up.

**No test gap may advance as "OPEN".** At the owning milestone's advance every gap
is exactly one of: **CLOSED** (a hardening test landed), **ACCEPTED** (a
`followUps[]` entry with a one-line reason it cannot close in-harness), or
**DEFERRED-TO-<milestone>** (an explicit later milestone owns it). "Candidate for
a future hardening bundle" is not a terminal state; gaps carried in that limbo
reach mission close still open.

---

## 5. Advance

A milestone may advance ONLY when all of: every bound assertion resolved, zero
boundary violations, zero missing defaults, AND the integration gate green.
`contractor advance` computes this.

Then run `contractor check <missionDir>` and fix any **error** finding before
advancing. Emit **warn** findings into `boundaryNotes` so they stay visible to a
retro.

**Never advance on green per-area tests alone.** The integration gate is the real
boundary.

### 5a. Write the checkpoint, then discharge any context reset

The milestone boundary is the only point where mission state is provably
consistent — verdicts persisted, gate green, commits made, no worker in flight —
so it is the only safe place to reset your window.

**Record the knowledge half** in `mission-state.json`:

- **`decisions[]`** — `{ milestone, decision, why }` for each choice a later
  window would otherwise relitigate. Include the approach **rejected** and why;
  that half is what prevents the rework. Terse: one or two per milestone is right.
  Ten means you are logging events, not decisions.
- **`constraints[]`** — `{ milestone, constraint, impact }` for facts discovered
  this milestone that still bind later work: a data-shape surprise, an
  environment gotcha, a limitation you had to design around. These are what a
  later milestone breaks itself on.

Do **not** hand-write a file list. The artifact trail is derived mechanically
from the handoffs, because artifact-trail fidelity is the weakest dimension of
every summarizer measured — and it is exactly the part a fresh session cannot
cheaply re-derive. Write prose only for reasoning.

**If a context reset is pending**, confirm the checkpoint is written and
committed, then say so plainly in your final message. **Do not clear the flag
yourself** — you cannot verify a reset happened, and an orchestrator that
discharges its own reset signal will run on for another 200k tokens with the
state file claiming nothing was needed.

If no reset is pending, just advance. Resetting after a cheap milestone costs the
ramp toll and a cold prompt cache for nothing.

### 5b. The gate for out-of-harness verification

If any assertion is in an unverifiable state — the device was not attached, the
staging environment was down, the runner was not configured —
`contractor advance` reports the milestone **gated**.

A gated milestone or mission **MUST NOT be recorded `done`.**

```
contractor disarm gated <missionDir>
contractor status                     # confirm INERT
```

List the required verification as a REQUIRED follow-up with its exact commands,
and leave the state file and contract in place for the operator's resume. Flip to
`done` only when that verification passes for real and the assertions move to
`passing`.

This exists because a mission was once recorded `done` with several unverified
legs, and the deferred live run then found four real cross-screen bugs. `gated`
is non-active and non-terminal: the hook is inert, but nothing reads it as
finished.

### 5c. Mission-final adversarial pass — once, when the LAST milestone closes

Step 2c hunts bugs per milestone. Nothing has looked at the mission **as a
whole**, and integration defects fall between per-milestone passes by
construction: an interface that drifted across three milestones, a policy applied
inconsistently between areas, an escalation that was sound alone but not in
aggregate.

When the final milestone would advance and every assertion is resolved, before
archiving: spawn ONE read-only frontier-tier investigator over the **full mission
commit range**, briefed with the whole contract PLUS the accumulated `decisions[]`
and `constraints[]`. Those exist now, so it can check whether the shipped code
still honours the reasoning that produced it — which no per-milestone pass can
see.

Record `missionFinalReview: { ran, findings, ts }` — never on `correctiveRounds`,
so running it cannot trip the breaker. Confirmed findings block `done` and route
to self-heal. Run it ONCE per mission.

**Then hand the heavier review back to the human.** Append a follow-up asking for
a human code review of the branch before it merges, and say it plainly in the
finish summary.

---

## 6. Finish

```
contractor disarm done <missionDir>
contractor status                     # must print INERT
```

The hook also self-defends: it no-ops whenever `missionStatus` is not `active`,
so a leftover flag is harmless once the milestone is recorded. Keep
`missionStatus` honest anyway — it is what every later reader trusts.

Then archive per your project's convention, and give the human a summary:
assertions passed, rounds spent, escalations made, tokens spent, follow-ups
created, and **anything left unverified**.
