# Codex / AGENTS.md adapter

For any runtime that reads `AGENTS.md` — Codex CLI, and several other agent tools
that adopted the convention.

## Install

```bash
npm install -g mission-harness
cd your-project
mission init
mission install codex
```

That writes `AGENTS.md` at your project root. If you already have one, the
install will not overwrite it — merge the Mission Harness section in by hand.

## Adapt

```bash
mission prompt init > /tmp/mission-init.md
codex exec "Follow /tmp/mission-init.md against this repository."
mission doctor     # must report zero errors
```

## What differs from the Claude Code adapter

| | Claude Code | Codex |
| --- | --- | --- |
| Seat spawning | subagents, declared in `.claude/agents/` | one `codex exec` per seat |
| Edit routing | automatic (PostToolUse hook) | explicit `mission route <files>`, or derive scope from handoffs |
| Brief injection | automatic (SessionStart hook) | run `mission brief` yourself when reorienting |
| Read-only validator | enforced by the agent's tool list | enforced by prompt, verified with `git status` |

Everything else is identical: the same prompts, the same CLI, the same artifacts.
A mission started under one runtime can be resumed under the other, because the
state lives entirely in the mission folder.

## Automating the seats

A thin wrapper keeps the spawns consistent:

```bash
#!/usr/bin/env bash
# mission-seat <seat> <payload-file>
set -euo pipefail
seat="$1"; payload="$2"
tier=$(jq -r ".seats.\"${seat##*/}\".tier // \"standard\"" mission.config.json)
model=$(jq -r ".models.\"$tier\".default // \"$tier\"" mission.config.json)
codex exec --model "$model" "$(mission prompt "$seat")

$(cat "$payload")"
```

Keep the prompt **prefix** byte-stable across spawns and vary only the payload —
stable prefixes hit the prompt cache, and a reshuffled prompt does not.
