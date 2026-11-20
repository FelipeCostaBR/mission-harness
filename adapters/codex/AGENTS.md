# Mission Harness missions

This repository uses **Mission Harness**, a contract-first multi-agent build harness.
When asked to build a specification end-to-end, run it as a mission rather than
editing files directly.

## The rule that matters most

**Nothing is built until a validation contract exists and a human has approved
it.** The contract defines "done" independently of the implementation. A
definition of done written afterwards describes the implementation.

## Load your instructions

Mission Harness keeps the deterministic half in a CLI and the judgement half in
prompts. Load the prompt for the phase or seat you are in:

```bash
mission prompt mission     # the loop and the standing rules
mission prompt plan        # phase 1 — contract + milestones, then BLOCK
mission prompt run         # phase 2 — build
mission prompt validate    # phase 3 — adjudicate

mission prompt seats/worker
mission prompt seats/validator
mission prompt seats/escalation-worker
mission prompt seats/reviewer
mission prompt seats/simplifier
```

## First run in a fresh clone

```bash
mission doctor
```

If it reports errors, the harness is not adapted to this repository yet. Run
`mission prompt init`, follow it, and re-run `doctor`. Never start a mission
against a config with errors — every gate would pass vacuously.

## Spawning seats

Each seat needs its **own fresh context**. That is the mechanism, not a detail:
a validator that shares the implementer's context is not a verifier.

```bash
codex exec --model <tier-model> "$(mission prompt seats/worker)

## Payload
area: billing
pathGlobs: src/billing/**, test/billing/**
feature: F-export — <the spec>
assertions: A-001, A-002
missionDir: docs/prd/csv-export
"
```

Resolve `<tier-model>` from `seats` and `models` in `mission.config.json`.

**The validator must be read-only.** If your invocation cannot revoke write
access, state the constraint at the top of its prompt and check its handoff for
edits — `git status` before and after. A validator that fixes what it was asked
to judge has destroyed the only thing it was for.

## Deterministic decisions — never re-derive these

```bash
mission partition <milestone>   # which features may run in parallel
mission escalate <files…>       # inline or delegate, and the worker's grant
mission advance                 # advance / corrective / circuit-break
mission check                   # bookkeeping invariants
mission brief                   # the rehydration digest (≤6KB)
mission own <paths…>            # which area owns a path
```

## Edit routing

Without a PostToolUse hook, route edits explicitly after a worker finishes:

```bash
mission route <the files it changed>
```

Or skip the queue entirely — it is best-effort by design. Derive validation scope
from the handoffs (each names its feature → area) plus the milestone's committed
paths. That fallback is always available and always correct.

## Context

The mission's artifacts are its only memory. To reorient a fresh session, run
`mission brief` — never re-read the raw artifacts. On real missions,
re-orientation by re-reading consumed most of what a fresh window spent.

## Finish honestly

```bash
mission disarm <halted|gated|done> <missionDir>
mission status     # must print INERT
```

**`gated` is not `done`.** If any assertion could not be verified in-harness —
no device, no staging environment, no configured runner — the mission is `gated`,
and the required verification is recorded as a follow-up with its exact commands.
