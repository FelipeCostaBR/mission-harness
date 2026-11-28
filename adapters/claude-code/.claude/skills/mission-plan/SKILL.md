---
name: mission-plan
description: Phase 1 of a mission. Reads a PRD/spec folder, interviews for gaps, writes the validation contract and milestones, and blocks for explicit human approval before any code. Use when starting a mission from a written spec.
---

Load the phase prompt and follow it exactly:

```bash
mission prompt mission    # standing rules, if not already loaded this session
mission prompt plan
```

Input: a mission folder (`docs/prd/<id>/`) holding the spec. If you were given a
one-line idea instead, STOP and run the `write-a-prd` skill first.

This phase ends by **blocking for explicit approval** (AskUserQuestion: approve /
approve and run on autopilot / revise). No worker spawns, and no `mission arm`,
until the human approves the contract.

**On "approve and run on autopilot"** (only the human's own answer counts):
write the `autopilot` record through `mission state … set-field autopilot`,
commit the plan on a plan branch, open its PR, run `/code-review xhigh` on it
and land it. Then start the run in a FRESH context: with the session tool
(`start_session`, fresh context, its own worktree on the milestone branch, the
prompt `/mission-harness <missionDir>` plus the brief), or, without one, tell
the human the one line: `/clear`, then `/mission-harness <missionDir>`. The
SessionStart hook re-injects the brief and the AUTOPILOT directive after every
reset, so the run continues without prompting. See `mission prompt autopilot`.
