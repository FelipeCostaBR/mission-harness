# Contributing

## Run the tests

```bash
node --test src/rules/*.test.mjs     # the pure decision rules
bash test/cli-smoke.sh               # the CLI, end to end against a real repo
```

No dependencies, no build step. Node 20+.

## The shape of the project

Two halves, and keeping them separate is the whole design:

| | Where | Rule |
| --- | --- | --- |
| **Deterministic** | `src/` | Pure, tested, never calls a model |
| **Judgement** | `prompts/` | Model-driven, runtime-agnostic |

- **`src/rules/*.mjs` must stay pure.** No I/O, no `Date.now()`, no randomness,
  no config imports. They take data and return decisions. All filesystem access
  lives in `src/io/` and `src/cli.mjs`.
- **Every rule needs tests.** These rules decide whether work ships. An untested
  branch here is worse than no rule, because everyone downstream trusts it.
- **No project-specific knowledge anywhere in `src/`.** If a rule needs to know
  something about a repository, that something belongs in
  `mission.config.json` and arrives as a parameter.

## Adding an invariant

`docs/invariants.md` has a deliberately high bar: **something shipped, green, and
was wrong.**

"This seems like good practice" is not enough. The list is only useful while
every entry is a real, paid-for failure — the moment it fills with reasonable
suggestions, people stop reading it, and the entries that would have saved them
go unread with the rest.

So an invariant PR should say what broke, what *didn't* catch it, and why the
proposed rule would have. If it can be expressed as a tested rule in `src/rules/`
rather than prose, do that instead — prose drifts, tests do not.

## Editing prompts

The prompts carry the harness's accumulated knowledge, and they are read by
models under context pressure. Two consequences:

- **Say why, briefly.** A rule with no rationale gets rationalised away at the
  worst moment. A rule with one clause of evidence survives.
- **Do not describe a specific runtime.** No tool names, no vendor APIs. "Spawn a
  read-only agent in a fresh context" works everywhere; "use the Task tool" works
  in one place. Runtime specifics belong in `adapters/`.

Keep them terse. Every added paragraph is context a seat spends before it starts
working.

## Adding an adapter

An adapter is a thin translation layer, not a fork of the prompts. It should:

1. Point the runtime at `mission prompt <name>` rather than duplicating text —
   one source of truth for the instructions.
2. Declare the seats, especially the **read-only** ones. If the runtime cannot
   revoke write access from a validator, say so plainly in its README and give
   the workaround.
3. Wire edit routing (`mission route`) and brief injection
   (`mission brief --only-active`), or explain what to run by hand instead.
4. Include a `README.md` covering install, adaptation, and what differs from the
   Claude Code adapter.

## Most useful contributions right now

- **Reports from non-JavaScript stacks.** The adaptation prompt has the least
  evidence behind it on Go, Python, Rust and Ruby codebases. What did `mission
  prompt init` get wrong about yours?
- **Adapters** for runtimes not yet covered.
- **Playbook entries**: a way agent-built work passed every check and was still
  wrong.
