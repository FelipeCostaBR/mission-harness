# Contractor missions

This repository uses **Contractor**, a contract-first multi-agent build harness.
When asked to build a specification end-to-end, run it as a mission rather than
editing files directly.

## The rule that matters most

**Nothing is built until a validation contract exists and a human has approved
it.** The contract defines "done" independently of the implementation. A
definition of done written afterwards describes the implementation.

## Load your instructions

Contractor keeps the deterministic half in a CLI and the judgement half in
prompts. Load the prompt for the phase or seat you are in:

```bash
contractor prompt mission     # the loop and the standing rules
contractor prompt plan        # phase 1 — contract + milestones, then BLOCK
contractor prompt run         # phase 2 — build
contractor prompt validate    # phase 3 — adjudicate

contractor prompt seats/worker
contractor prompt seats/validator
contractor prompt seats/escalation-worker
contractor prompt seats/reviewer
contractor prompt seats/simplifier
```

## First run in a fresh clone

```bash
contractor doctor
```

If it reports errors, the harness is not adapted to this repository yet. Run
`contractor prompt init`, follow it, and re-run `doctor`. Never start a mission
against a config with errors — every gate would pass vacuously.

## Spawning seats

Each seat needs its **own fresh context**. That is the mechanism, not a detail:
a validator that shares the implementer's context is not a verifier.

```bash
codex exec --model <tier-model> "$(contractor prompt seats/worker)

## Payload
area: billing
pathGlobs: src/billing/**, test/billing/**
feature: F-export — <the spec>
assertions: A-001, A-002
missionDir: .contractor/missions/csv-export
"
```

Resolve `<tier-model>` from `seats` and `models` in `contractor.config.json`.

**The validator must be read-only.** If your invocation cannot revoke write
access, state the constraint at the top of its prompt and check its handoff for
edits — `git status` before and after. A validator that fixes what it was asked
to judge has destroyed the only thing it was for.

## Deterministic decisions — never re-derive these

```bash
contractor partition <milestone>   # which features may run in parallel
contractor escalate <files…>       # inline or delegate, and the worker's grant
contractor advance                 # advance / corrective / circuit-break
contractor check                   # bookkeeping invariants
contractor brief                   # the rehydration digest (≤6KB)
contractor own <paths…>            # which area owns a path
```

## Edit routing

Without a PostToolUse hook, route edits explicitly after a worker finishes:

```bash
contractor route <the files it changed>
```

Or skip the queue entirely — it is best-effort by design. Derive validation scope
from the handoffs (each names its feature → area) plus the milestone's committed
paths. That fallback is always available and always correct.

## Context

The mission's artifacts are its only memory. To reorient a fresh session, run
`contractor brief` — never re-read the raw artifacts. On real missions,
re-orientation by re-reading consumed most of what a fresh window spent.

## Finish honestly

```bash
contractor disarm <halted|gated|done> <missionDir>
contractor status     # must print INERT
```

**`gated` is not `done`.** If any assertion could not be verified in-harness —
no device, no staging environment, no configured runner — the mission is `gated`,
and the required verification is recorded as a follow-up with its exact commands.
