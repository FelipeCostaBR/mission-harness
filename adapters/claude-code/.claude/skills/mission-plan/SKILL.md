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

This phase ends by **blocking for explicit approval**. No worker spawns, and no
`mission arm`, until the human approves the contract.
