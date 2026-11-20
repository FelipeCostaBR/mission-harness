---
name: write-a-prd
description: Create a PRD through user interview, codebase exploration and module design, structured for the mission harness to plan and run. Use when the user wants to write a PRD, a product requirements document or a spec, or plan a new feature before building it.
---

Load the prompt and follow it exactly:

```bash
mission prompt write-a-prd
```

The PRD is written to `docs/prd/<id>/spec.md` (or the config's
`paths.missions`), in the vocabulary of `mission.config.json`: its area slugs,
surfaces and protected paths. Interview one question at a time with your
recommended answer. Never skip Surfaces & Areas, Acceptance Criteria,
Escalations or Milestones. When it is written, hand off to the `mission-plan`
skill on that folder.
