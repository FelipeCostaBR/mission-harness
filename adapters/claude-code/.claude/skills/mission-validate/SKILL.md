---
name: mission-validate
description: Phase 3 of a mission, at each milestone boundary. Spawns fresh read-only validators, runs the deterministic integration gate and commit-boundary check, records raw verdicts, and takes the advance / corrective / circuit-break decision. Use when a milestone's workers have all returned.
---

Load the phase prompt and follow it exactly:

```bash
mission prompt validate
```

Persist each validator's RAW verdict file first, then derive status with
`mission state <missionDir> record-verdict`. The decision is `mission advance`'s,
not yours: a missing verdict is a failure, never an assumed pass.
