# Codex / AGENTS.md adapter

For any runtime that reads `AGENTS.md` — Codex CLI, and several other agent tools
that adopted the convention.

## Install

```bash
npm install -g contractor-harness
cd your-project
contractor init
contractor install codex
```

That writes `AGENTS.md` at your project root. If you already have one, the
install will not overwrite it — merge the Contractor section in by hand.

## Adapt

```bash
contractor prompt init > /tmp/contractor-init.md
codex exec "Follow /tmp/contractor-init.md against this repository."
contractor doctor     # must report zero errors
```

## What differs from the Claude Code adapter

| | Claude Code | Codex |
| --- | --- | --- |
| Seat spawning | subagents, declared in `.claude/agents/` | one `codex exec` per seat |
| Edit routing | automatic (PostToolUse hook) | explicit `contractor route <files>`, or derive scope from handoffs |
| Brief injection | automatic (SessionStart hook) | run `contractor brief` yourself when reorienting |
| Read-only validator | enforced by the agent's tool list | enforced by prompt, verified with `git status` |

Everything else is identical: the same prompts, the same CLI, the same artifacts.
A mission started under one runtime can be resumed under the other, because the
state lives entirely in the mission folder.

## Automating the seats

A thin wrapper keeps the spawns consistent:

```bash
#!/usr/bin/env bash
# contractor-seat <seat> <payload-file>
set -euo pipefail
seat="$1"; payload="$2"
tier=$(jq -r ".seats.\"${seat##*/}\".tier // \"standard\"" contractor.config.json)
model=$(jq -r ".models.\"$tier\".default // \"$tier\"" contractor.config.json)
codex exec --model "$model" "$(contractor prompt "$seat")

$(cat "$payload")"
```

Keep the prompt **prefix** byte-stable across spawns and vary only the payload —
stable prefixes hit the prompt cache, and a reshuffled prompt does not.
