---
name: mission-run
description: Phase 2 of a mission. Arms the edit-routing hook, runs the milestone pre-flight review, spawns path-scoped workers at ladder seats, handles escalations and the simplify pass. Use after the plan is approved, or to resume a halted mission.
---

Load the phase prompt and follow it exactly:

```bash
mission prompt run
```

Before the first spawn: `mission arm <missionDir>` and confirm it prints ARMED
with a live queue substrate. Every spawn uses the seat `mission seat resolve`
returns, and every state change goes through `mission state`.
