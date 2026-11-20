# Changelog

## 0.2.0 — mission-harness

The package is renamed from Contractor to **mission-harness** (CLI: `mission`),
and catches up with the harness generation that ran production missions after
0.1.0.

**State**
- `mission state <dir> <command>` is the only sanctioned way to change
  `mission-state.json` after approval. Every command locks the file, re-checks
  bookkeeping, refuses a write that would add an error, refuses if the file
  changed underneath it, and writes atomically. `set-assertion <id> passing` is
  refused unless the newest verdicts for that id unanimously pass.
- `record-verdict` derives assertion states from the raw verdict file;
  `bump-round` increments the counter and appends the stamped round log in one
  write; `upsert-escalation` refuses a `verifiedBy` record that cannot be re-run.
- `arm` / `disarm` write `missionStatus` through the same lock.
- `gated` is a first-class status (`behaviorally-gated` still reads).

**Seats**
- The seat ladder replaces the three-tier worker seat: seven model/effort rungs,
  per-role start, ceiling and climb triggers, a `cheap` profile, and size tiers
  (`mission size`) that pick the worker's start. `mission seat resolve` and
  `mission seat corrective`. A project replaces the table with `seatLadder`.
- New seats: **scout** (answers a code question with cited lines, so the
  orchestrator never reads source) and **fixer** (makes a red gate pass without
  touching the test that caught it).

**Checks**
- `mission commits <range>`: every commit stays inside the grant of the feature
  or escalation that claims it; protected paths are violations whatever the grant.
- Bookkeeping, rehydration, partition, boundary and handoff-digest rules updated
  to the newer generation (segment-wise glob matching, structured `filesChanged[]`
  in the artifact trail, ESC handoffs keyed by filename, planned escalations in
  the brief).
- The feature surface vocabulary comes from the config's `surfaces{}`.

**Claude Code**
- `mission install claude-code` merges the hooks into `.claude/settings.json`
  (PostToolUse route, SessionStart brief, and a new PreCompact breadcrumb).
- Phase skills `mission-plan`, `mission-run`, `mission-validate`, and a generic
  `write-a-prd` skill (`mission prompt write-a-prd` for other runtimes).

**Migration**
- `mission migrate <agent-routing.json>` drafts `mission.config.json` from the
  module registry of a pre-package harness copy. See `MIGRATING.md`.
