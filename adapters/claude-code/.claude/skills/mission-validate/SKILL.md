---
name: mission-validate
description: Phase 3 of a mission, at each milestone boundary. Spawns fresh read-only validators, runs the deterministic integration gate and commit-boundary check, records raw verdicts, and takes the advance / corrective / circuit-break decision. Use when a milestone's workers have all returned.
---

Load the phase prompt and follow it exactly:

```bash
mission prompt validate
```

Run the gate with `mission gate <missionDir> <milestone>` in the background.
Persist each validator's RAW verdict first, mechanically:
`mission state <missionDir> capture-verdict <milestone> --as <milestone>-<area>.json --agent <agentId> --transcripts ~/.claude/projects/<project>/<session>/subagents`
(never retype it), or write the file and derive with `record-verdict`. The decision is `mission advance`'s,
not yours: a missing verdict is a failure, never an assumed pass.
