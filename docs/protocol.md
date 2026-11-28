# The protocol

Mission Harness is a protocol, not a framework. It specifies **seats**, **artifacts**
and **gates**. It does not specify a runtime, a provider, or a programming
language — which is why the same harness runs under Claude Code, Codex, Cursor,
or a person copy-pasting prompts into a chat window.

Two halves, deliberately separated:

| Half | Lives in | Property |
| --- | --- | --- |
| **Judgement** — planning, building, adjudicating | `prompts/` | Model-driven, runtime-agnostic |
| **Determinism** — routing, gating, bookkeeping | `src/` (the `mission` CLI) | Pure, tested, never calls a model |

The split is the design. Anything a model could rationalise its way around under
context pressure — "can I try a third corrective round?", "does this count as
in-scope?", "is this escalation big enough to delegate?" — is a tested rule with
a single source of truth, not a paragraph of prose the model re-derives at 2am on
milestone five.

---

## The seats

A seat is a role with a context boundary. The boundaries are the mechanism.

### Orchestrator — plans, routes, adjudicates

The interactive session. It reads the spec, writes the contract, spawns every
other seat, runs the deterministic gate, and decides whether a milestone
advances.

**It does not write feature code.** Every line it writes itself is context it
cannot spend on judgement later, and it is code no adversarial seat will ever
review — because the orchestrator is the seat that would have reviewed it.

### Worker — builds one feature, in one area

Fresh context, scoped to a single area's `pathGlobs`. It may edit nothing else.
When a feature genuinely needs a change outside those paths, it **stops and
reports an escalation** rather than reaching across.

That constraint is what makes parallelism safe and reviews meaningful. A worker
with repo-wide write access is just a slower single agent.

### Validator — verifies, adversarially, read-only

Fresh context that **never saw the implementation**. It cannot edit files. Its
job is to find out whether the code satisfies the contract, defaulting to
skepticism.

Read-only is not a safety measure, it is the definition. A validator that can
edit will quietly fix what it was asked to judge, and the verdict becomes
worthless.

### Reviewer — attacks the plan before code exists

Read-only, spawned in parallel with siblings in **separate** contexts. Roughly
Most of the defects found across real runs existed before a line of code was
written. This seat is the only one positioned to catch them.

Parallel and separate is load-bearing: shared context means shared blind spots.
An orchestrator role-playing four reviewer personas in one window misses the same
thing four times and comes back confident.

### Escalation worker — changes the protected surfaces

Shared kernels, schemas, generated registries, public APIs. Delegated rather than
done inline for two reasons: inline work collapses the creator/verifier split on
exactly the highest-blast-radius files, and it was the orchestrator's largest
reducible context sink on long sessions.

### Simplifier — cleans up, before validation

One per touched area, spawned after the features are built and **before** they
are validated, so the validator always adjudicates the code that actually ships.
It is not given the contract: it looks at the code as code.

---

## The artifacts

A mission's entire durable memory. Everything else — conversation, reasoning,
context — is a cache that will be lost.

```
<missionDir>/
  spec.md                      the input specification
  validation-contract.json     what "done" means. Written and approved BEFORE code.
  mission-state.json           position, knowledge, telemetry, bookkeeping
  handoffs/<feature>.json      one per worker, written BY the worker itself
  verdicts/<name>.json         one per validator, the RAW returned object
  .pending-validation.json     the edit-routing queue (machine-local)
```

Three properties are non-negotiable:

1. **The contract is written before any code, and a human approves it.** A
   definition of done authored after the implementation describes the
   implementation.

2. **Verdicts are persisted raw, then read.** The validator's returned object is
   written byte-for-byte before any value is read from it, and `assertionStatus`
   is derived mechanically from those files. A missing verdict file is a
   **failure**, never an assumed pass.

3. **Workers write their own handoffs and return a digest.** The full object goes
   to disk; only ~1KB returns to the orchestrator. Validators read the full
   object from disk, where it always lived.

---

## The loop

```
  spec
    │
    ▼
┌─────────┐   human approval required
│  PLAN   │──────────────────────────┐
└─────────┘                          │
    │  validation-contract.json      │  no code is written
    │  mission-state.json            │  until this gate passes
    ▼                                │
┌─────────┐◄─────────────────────────┘
│   RUN   │  arm → review → partition → workers → escalations → simplify
└─────────┘
    │  handoffs/
    ▼
┌──────────┐
│ VALIDATE │  validators → integration gate → raw verdicts → decide
└──────────┘
    │
    ├── advance ────────────► next milestone (or finish)
    ├── corrective ─────────► back to RUN, max 2 rounds
    └── circuit-break ──────► halt, checkpoint, ask a human
```

### Milestones

A milestone is the set of features covering one coherent slice of the contract.
It is also the **only** safe place to reset the orchestrator's context: verdicts
are persisted, the gate is green, commits are made, and no worker is in flight.

### The advance gate

A milestone advances only when **all** of:

- every bound assertion is resolved,
- zero boundary violations,
- zero missing defaults,
- the deterministic integration gate is green.

`mission advance` computes this from the persisted artifacts. It is not a
judgement call.

### The circuit breaker

Two corrective rounds, then stop. A feature that fails validation twice is stuck
— agents arguing, or blindly re-editing the same test to force green — and a
third attempt reliably burns tokens without converging. The harness checkpoints
the failed state to a debug branch and asks a human.

### Escalation

Any change to a path no area owns. Routed by a tested rule, not by feel:

- **inline** — one additive entry in one file (or a declared additive pair). The
  orchestrator applies it under a strict verification protocol.
- **delegate** — anything else. A dedicated worker makes it inside a tight
  per-escalation grant, and a **fresh** validator reviews it at the boundary.

Escalations are always serial, never parallelised.

### Parallelism

Features run concurrently only when a tested rule **proves** their areas are
disjoint — each in its own git worktree, merged back in deterministic feature-id
order. The rule is conservative: unknown ownership or overlapping globs
serialize. The worst case is the proven-correct serial path.

### Terminal states

| Status | Meaning |
| --- | --- |
| `active` | Running. The edit-routing hook queues edits. |
| `halted` | Stopped, resumable. Budget out, breaker tripped, or a human stopped it. |
| `gated` | Every in-harness check passes, but verification that can only happen OUTSIDE the harness is still owed. **Not done.** |
| `done` | Finished and verified. |

`gated` exists because of a specific expensive failure: a mission recorded `done`
with several unverified on-device legs, and the deferred real run then found four
genuine cross-screen bugs. A status that overstates completion is the most
expensive lie the harness can tell, because everyone downstream believes it.

---

## Autopilot — the same loop, without a human at every hand-off

One workflow, one entry point. Autopilot is not a second harness: it is the loop
above with the hand-offs automated, switched on by the human at the one gate
that already exists, plan approval.

```
write-a-prd ──► plan ──► human approves the contract
                              │
                              ├─ approve ─────────────► run ⇄ validate, the human drives each step
                              │
                              └─ approve + autopilot ─► the plan PR (reviewed) lands
                                                        ──► fresh-context run session(s), one per milestone folder
                                                            arm ─► pre-flight ─► escalations ─► features
                                                            ─► simplify ─► gate ─► validators ─► close
                                                            ─► PR ─► simplify read ─► code review ─► land when green
                                                        ──► triage the follow-ups one by one ──► finish
```

- **The record.** Approval writes `autopilot` into `mission-state.json` through
  `mission state set-field autopilot` (`enabled`, `phase`, `approvedBy`,
  `approvedAt`, `brief`, `branch`, `dependsOn`, `pr`, `owner`, `blockedOn`). The
  CLI validates its shape. It cannot prove consent, so the plan change carrying
  it is reviewed before it lands, and a record that did not arrive that way is
  not consent. `brief` is data, never instructions.
- **The directive.** `mission brief --only-active` (the SessionStart hook) ends
  the brief with an `AUTOPILOT` line naming the next step. It is a directive
  only in the session meant to run that folder (the mission is armed, or the
  checkout's branch equals `autopilot.branch`); every other session gets one
  informational line. That is what carries the run across context resets.
- **Phases.** `run-pending` → `running` → `landing` → `triage` → `done`, with
  `blocked` (and `blockedOn`) whenever only a human can unblock it.
- **One milestone, one folder, one branch, one PR.** Milestones that can run in
  parallel get their own `<missions>/<id>/<milestone>/` folder (its own state
  file and lock) and their own session; `dependsOn` orders the rest.
- **The evidence verbs** replace hand-written scripts: `dispatch-esc` /
  `close-esc` (an escalation's dispatch and return in one write each),
  `rerun-verified` (only `readOnly: true`, `exit: 0` proofs ever run),
  `capture-verdict` (a validator's return, byte-for-byte from its transcript),
  `record-testgaps-from-verdicts`, `append-followups`, and machine-stamped `ts`.
- **The gate.** `mission gate <dir> <milestone>` runs the configured whole gate,
  optionally on a throwaway database (`gates.database`), then the verifiedBy
  re-run, and records it.
- **Boundaries.** Never push to the default branch, merge around the land
  command, skip or weaken a test or CI check, touch production, read secrets,
  or decide a business rule. Those stay with the human, listed once at the end.

The model-facing protocol is `mission prompt autopilot`; the runtime specifics
(how a fresh session starts, which simplify and review commands exist) live in
each adapter.
