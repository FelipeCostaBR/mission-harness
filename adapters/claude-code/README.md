# Claude Code adapter

The richest fit for Mission Harness: subagents give you real fresh-context seats, and
hooks give you automatic edit routing and brief injection.

## Install

```bash
npm install -g mission-harness      # or: npm i -D mission-harness
cd your-project
mission init
mission install claude-code
```

That copies into your project:

```
.claude/skills/mission-harness/SKILL.md          the orchestrator entry point
.claude/agents/mission-*.md              the seven seats
.claude/mission-harness-settings-snippet.json    hooks to merge into settings.json
```

Existing files are **not** overwritten.

### Or once, for every project (user scope)

```bash
npm install -g mission-harness
mission install claude-code --scope user     # --target <dir> to choose; --force to refresh
```

This copies the same skills and agents into `~/.claude/skills` and
`~/.claude/agents`, so `write-a-prd`, `mission-harness` and the phase skills are
available in every project with no per-project copy. It does **not** touch any
settings file: merge `.claude/mission-harness-settings-snippet.json` into
`~/.claude/settings.json` yourself if you want the hooks everywhere. Each hook is
a no-op in a project with no `mission.config.json` or no armed mission. A project
still needs its own `mission init` + `mission doctor` before a mission runs.

## Wire the hooks

Merge `.claude/mission-harness-settings-snippet.json` into your
`.claude/settings.json`. Do not replace the file — you almost certainly have
hooks of your own.

| Hook | Why |
| --- | --- |
| `PostToolUse` → `mission route` | Routes every edit to its owning area and queues it for validation. Inert outside a mission; it never blocks a tool call. |
| `SessionStart` → `mission brief --only-active` | Injects the rehydration brief when a mission is armed and active. A fresh window inherits position and knowledge for ~1.5k tokens instead of re-deriving from source. With an approved `autopilot` record it adds the `AUTOPILOT` line: a directive only in the session that runs that folder (armed, or on `autopilot.branch`), informational everywhere else. |

## Adapt it to your repo

```bash
mission prompt init > /tmp/mission-init.md
```

Then, in Claude Code: *"Follow /tmp/mission-init.md against this
repository."* When it finishes:

```bash
mission doctor        # must report zero errors
```

## Run a mission

```bash
mission new csv-export
# write docs/prd/csv-export/spec.md
```

Then in Claude Code:

```
/mission-harness docs/prd/csv-export
```

The orchestrator plans, blocks for your approval, then builds and validates
milestone by milestone. Start from `/write-a-prd` instead and it writes the
spec and goes straight on to the plan. Answer the approval with "approve and run
on autopilot" and the run continues in a fresh session by itself: one PR per
milestone, the `simplify` skill, `/code-review xhigh`, land when green, then
follow-up triage (`mission prompt autopilot`).

## Models

Set `seats` in `mission.config.json`; the agent files carry a matching
`model:` in their frontmatter. If you change a seat's tier, change both — or
delete the frontmatter `model:` and let the orchestrator pass it per spawn.

The default mapping is `frontier → opus`, `standard → sonnet`. The orchestrator
seat is your interactive session, so switch it yourself with `/model opus` before
planning. See `docs/models.md` for why those two seats are the ones worth paying
for.

## Notes

- **`mission` must be on `PATH`** for the hooks and agent files. If you
  installed it as a dev dependency, use `npx mission` in the snippet and in the
  agent files.
- **Worktrees.** If you start a mission in a different worktree than the session
  booted in, `mission arm` will tell you the edit queue is dead for that run.
  That is expected and handled — scope comes from handoffs and commits instead.
  What matters is that you were told at arm time rather than discovering an empty
  queue at the boundary.
