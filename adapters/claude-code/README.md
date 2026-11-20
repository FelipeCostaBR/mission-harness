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

## Wire the hooks

Merge `.claude/mission-harness-settings-snippet.json` into your
`.claude/settings.json`. Do not replace the file — you almost certainly have
hooks of your own.

| Hook | Why |
| --- | --- |
| `PostToolUse` → `mission route` | Routes every edit to its owning area and queues it for validation. Inert outside a mission; it never blocks a tool call. |
| `SessionStart` → `mission brief --only-active` | Injects the rehydration brief when a mission is armed and active. A fresh window inherits position and knowledge for ~1.5k tokens instead of re-deriving from source. |

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
milestone by milestone.

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
