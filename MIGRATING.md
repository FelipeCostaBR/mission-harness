# Migrating

## From a copied `.claude` harness (run-prd-multi-agent-architecture)

Projects that copied the harness into `.claude/skills/run-prd-multi-agent-architecture`
keep their module registry in an `agent-routing.json`. To move one onto the package:

1. `npm install -g mission-harness` (or as a dev dependency).
2. `mission migrate path/to/agent-routing.json --write` drafts
   `mission.config.json`: one area per module (retired modules dropped), one
   surface per module surface, and every `sharedKernel` path as a protected path.
3. Fill in each surface's `gates` and the top-level `gates.integration`, and move
   the project rules that lived in the agent files into `constraints[]`.
4. `mission doctor` until it reports no errors.
5. `mission install claude-code`. It adds the `mission-*` agents, the phase
   skills, `write-a-prd`, and merges the hooks into `.claude/settings.json`.
6. Remove the old copy (`.claude/skills/run-prd-multi-agent-architecture`,
   `mission-plan|run|validate`, `module-worker`/`module-validator` agents, and the
   old hook entries) once a mission has run on the package.

Existing missions under `docs/prd/<feature>/` keep working: the state schema is
the same, and older status spellings still validate.

| Old | New |
| --- | --- |
| `node …/lib/mission-state-cli.mjs <dir> <cmd>` | `mission state <dir> <cmd>` |
| `node …/lib/rehydrate-cli.mjs <dir>` | `mission brief <dir>` |
| `node …/lib/seat-ladder.mjs resolve '<json>'` | `mission seat resolve '<json>'` |
| `node …/lib/plan-size.mjs <dir> <ms>` | `mission size <dir> <ms>` |
| `node .claude/hooks/mission-flag.mjs disarm <status>` | `mission disarm <status> <dir>` |
| `module-worker` / `module-validator` | `mission-worker` / `mission-validator` |

Not carried into the package (they stay project-specific): Maestro and device
lanes, the Next.js WIRE/contract-route checks, worktree preamble checks, and the
Claude Code spend and weekly-cap ledger.

## From Contractor 0.1

- The CLI is `mission` (was `contractor`); `mission new <id>` replaces
  `contractor mission new`.
- Rename `contractor.config.json` to `mission.config.json` (the old name is still
  read). Seat `tier` fields are no longer used: the ladder decides; `models{}` is
  keyed by the ladder's aliases (`opus`, `sonnet`, `haiku`).
- State moved from `.contractor/` to `.mission/`; missions default to `docs/prd/`.
- Re-run `mission install claude-code --force` to refresh the agents and skills.
