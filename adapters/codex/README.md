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

## Context and usage reports

Start the coordinator in a fresh mission session. Use `mission brief` to
resume at an approved-plan or milestone checkpoint. Keep gate logs on disk
and use `mission digest <missionDir> <artifact>` for the compact view of a
review or raw verdict. A validator with filesystem read-only access can emit
its JSON to its launcher. In Codex CLI, direct `--output-last-message` to the
assigned file under `verdicts/incoming/`, redirect `--json` events to a local
JSONL file, and show the coordinator the digest. For older missions, create
`reviews/` and `verdicts/incoming/` before assigning artifact paths. After a
successful seat return, use `mission state <missionDir> record-verdict
<milestone> verdicts/incoming/<name>.json` to persist the raw verdict and
derive state. Read omitted findings or blockers as needed.

Register each coordinator, worker, scout, reviewer, or validator attempt
before it runs. Record replacements with a distinct `id` and `retryOf`.

```sh
mission usage start docs/prd/demo '{"id":"validator-1","role":"validator","phase":"validate","model":"gpt-6.2-sol","effort":"high"}'
mission usage finish docs/prd/demo validator-1 completed '{"format":"codex-exec","path":"/tmp/validator-1.jsonl"}'
mission usage report docs/prd/demo
mission usage report docs/prd/demo --json > /tmp/demo-usage-report.json
```

The source can be supplied when starting an attempt to see usage in progress.
For Codex desktop session logs, use `codex-rollout` with the absolute JSONL
path. Specify `threadId` for a particular thread and use ISO timestamps
`since` (inclusive) and `until` (exclusive) for a coordinator in a shared
session. End the window after the final token-usage record is written. For
`codex-exec`, use one dedicated `codex exec --json` stream per attempt.
Choose one source per attempt and keep attempts on distinct threads or time
windows. These streams can report usage by turn, so their totals are
eligible for Codex credit estimates, while request-size and API tier estimates
require per-request rollout records. Keep the raw logs and local
`<missionDir>/.usage/` metadata out of version control. In a consuming repo,
add `.usage/` to its Git ignore rules or local Git excludes. Keep the source
logs until reporting is complete or save a JSON report before removing them.
Reports show counters and attempt labels
without printing raw event contents or log paths.

Use `interrupted` for a cancelled or timed-out seat and `failed` for a seat
that fails to complete its task. The report includes both outcomes even
when they have no usage data. Capture the usage source for interrupted seats
when it exists.

Set `usage.contextWarningTokens` (default 230,000) for input-size advisories
and `usage.advisoryCodexCredits` for an optional estimate-based budget in
`mission.config.json`. The report separates Standard Codex credits from
Standard API USD before cache-write premiums and shows how many records each
estimate covers. Actual billing depends on the rates and tier applied.
Warnings leave the approval, review, and validation gates in effect.
