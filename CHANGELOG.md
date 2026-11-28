# Changelog

## Unreleased

**One workflow, end to end.** `write-a-prd` now goes straight on to the plan on
the folder it wrote, and the plan's approval question offers "approve and run
on autopilot": the run then starts in a fresh context and goes milestone by
milestone to merged PRs and follow-up triage without being re-prompted. It is
the same loop with the hand-offs automated, not a second harness.

**Autopilot**
- The `autopilot` record in `mission-state.json`, written through
  `mission state set-field autopilot` (or one of `autopilot.<phase|pr|branch|blockedOn|session|dependsOn>`)
  and validated on every write: a human approver, a parseable approval time, a
  brief for a run-pending record, `blockedOn` for a blocked one.
- `mission brief --only-active` ends the brief with an `AUTOPILOT` line: a
  directive naming the next step only in the session that runs the folder (it is
  armed, or the branch equals `autopilot.branch`), one informational line in
  every other session. The brief is re-injected as quoted data.
- `mission prompt autopilot`: the protocol (plan to fresh-context run, one
  folder, branch and PR per milestone, parallel milestone sessions, delegated
  simplify, code review, land when green, follow-up triage, session hygiene and
  the human-only list).

**State verbs**
- `dispatch-esc` / `close-esc`: an escalation's dispatch and return, one write
  each. Routing uses the config; a second delegate is refused while one is in
  progress (escalations stay serial); `close-esc` refuses a missing handoff and
  never stamps `readOnly` on a proof.
- `rerun-verified <milestone> [--record]`: re-runs every admissible `verifiedBy`
  proof (`readOnly: true`, `exit: 0`, command and evidence present), logs under
  the temp dir only, never executes anything else, and refuses to record a proof
  set that changed mid-run.
- `capture-verdict <milestone> --as <name> (--transcript <file> | --agent <id> --transcripts <dir>)`:
  a validator's return, byte-for-byte from its transcript (the last hand-back
  only), bound to its area's name.
- `record-testgaps-from-verdicts`, `append-followups`.
- `set-gate`, `merge-meta` and `close-esc` stamp `ts` when it is omitted and
  refuse a typed non-ISO one.

**Gate**
- `mission gate [missionDir] <milestone>`: the whole configured gate, one
  deadline, one log per step, then the verifiedBy re-run, recorded with
  `set-gate integration`. `gates.database` describes an optional throwaway
  database (setup, teardown, a stopped check) whose URL must be on loopback and
  overrides the configured env keys for every gate child; an inherited value
  naming a forbidden endpoint refuses the run. Gate entries may carry `expect`.

**Install**
- `mission install claude-code --scope user [--target <dir>]` copies the same
  skills and agents into `~/.claude` for every project. It never edits a
  settings file; the hooks are printed to merge by hand.

**Docs**: invariants 18 to 22, `docs/protocol.md` § Autopilot,
`docs/configuration.md` `gates.database` and `autopilot`. The simplifier agent
may invoke the `simplify` skill in Claude Code.

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
