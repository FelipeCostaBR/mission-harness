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

That installs the Codex runtime marker and `AGENTS.md` at your project root.
If your project already has `AGENTS.md`, merge the Mission Harness section into
it. To enable model routing on an existing project, rerun
`mission install codex` with the updated harness.

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

Use `mission seat session planner` or `mission seat session orchestrator`
before opening a fresh session. Both resolve to GPT-6.2 Sol by default.
Workers and scouts resolve to GPT-6.1 Terra. Other seats resolve to GPT-6.2
Sol. The resolved effort and correction rules still come from the project's
seat ladder. Keep each family current by setting `models.sol.codex` or
`models.terra.codex` in `mission.config.json` when adopting a newer model.

Use the role and prompt that match the work. For example:

```bash
seat=$(mission seat resolve '{"role":"worker","sizeTier":"normal"}')
model=$(jq -r .model <<< "$seat")
effort=$(jq -r .effort <<< "$seat")
codex exec --model "$model" -c "model_reasoning_effort=\"$effort\"" "$(mission prompt seats/worker)

$(cat worker-payload.md)"
```

For code and file research, resolve `scout` and use `mission prompt seats/scout`.
For browser research, resolve `browser-scout` and use
`mission prompt seats/browser-scout`. Run it in a fresh Codex session with
browser tools and access to the authorized sources. The browser scout returns
page URLs and what it observed. The file scout returns file and line references.

Keep the prompt **prefix** byte-stable across spawns and vary only the payload —
stable prefixes hit the prompt cache, and a reshuffled prompt does not.
