# Write a PRD for a mission

You write the PRD a mission runs on. Its reader is the plan phase (`mission
prompt plan`): it turns your Acceptance Criteria into the validation contract,
routes each feature by its area and surface, and starts from your Milestones.
Author for that reader — structure over prose, area slugs over file paths,
discrete checkable claims over intentions.

You may skip steps you judge unnecessary, but never the four sections the
harness depends on: **Surfaces & Areas, Acceptance Criteria, Escalations,
Milestones.**

## 0. Read the project's harness config

```bash
mission doctor            # the config must be clean before a PRD can target it
```

`mission.config.json` holds the vocabulary you write in:

- `areas[]` — the slugs and the ONLY paths each worker may edit;
- `surfaces{}` — the toolchains; a surface with `designSpec: true` needs a
  design spec before any worker runs;
- `protectedPaths[]` — the paths that always escalate;
- `constraints[]` — project rules every feature inherits (copy rules, banned
  imports, logging conventions). Do not restate them as criteria; the planner
  adds them as default assertions;
- `liveGate` — whether out-of-harness verification (a device, a staging run)
  exists for some areas.

## 1. Interview and explore

1. Ask for a long, detailed description of the problem and any ideas for a
   solution.
2. Explore the repository to verify what they told you and learn the current
   state. Verify every factual claim in code and note the `file:line`; when a doc
   contradicts the code, the doc is wrong. Map the work onto the config's
   **areas** as you read: `mission own <paths…>` says which area owns a path and
   which paths no area owns.
3. Interview relentlessly until you share one understanding. Walk the design
   tree branch by branch, resolving dependencies between decisions one at a time.
   Ask one question at a time and give your recommended answer with each. For any
   feature that renders UI, also resolve: which screen(s) it changes, which user
   states or entitlements each flow assumes, and the primary device or viewport.
4. Sketch the modules to build or modify. Look for **deep modules** — a lot of
   behaviour behind a small, stable, testable interface. For each, record its
   **area slug**, **surface**, and whether it is **new or modified**. Confirm with
   the user, and ask which modules they want tests written for. Prefer importing an
   existing shared home over specifying a new per-module helper.

## 2. Classify surfaces

Tag every feature with exactly one surface from `surfaces{}`. **A feature that
needs two surfaces is two features**, one per surface: no worker crosses a
surface, because each surface is verified by different commands.

## 3. Design spec (only for a `designSpec: true` surface)

For each milestone with work on such a surface, write
`design-<milestone>.md` in the PRD folder **now**. Workers and validators on that
surface implement and verify against it; they do not design. Required sections:

- **Tokens** — the project's own design tokens or class names, never raw values,
  never a second palette.
- **Layout** — top-to-bottom composition, existing components to reuse, and a
  stable test id for every interactive element (e2e criteria can only assert on
  ids the spec pins).
- **States** — loading, empty, error, offline and any gated state, each mapped to
  concrete behaviour.
- **Copy** — every user-visible string verbatim, obeying the config's
  `constraints`.
- **Risks** — anything that touches a protected or unowned path is an
  escalation, never a worker edit.
- **Build notes** — the concrete do / don't list for the worker.

Do not run the app or a simulator here: there is no code yet.

## 4. Write the PRD

Write it to `<paths.missions>/<id>/spec.md` (`mission new <id>` scaffolds the
folder; the default is `docs/prd/<id>/`). Reference **area slugs and public
interfaces**, which are stable, never volatile file paths or code snippets.

<prd-template>

## Problem Statement

The problem, from the user's perspective, with the evidence for it.

## Solution

The solution, from the user's perspective.

## User Stories

A LONG numbered list: `As a <actor>, I want <feature>, so that <benefit> — (surface: <surface>)`.

## Surfaces & Areas

One row per buildable feature. The harness routes on this table.

| Feature id | Surface | Area slug(s) | New / Modify | Notes |
| --- | --- | --- | --- | --- |
| `BILL-invoice-api` | backend | `billing` | Modify | adds the issue endpoint |

Name every path no area owns that the work needs; those are escalations.

## Implementation Decisions

Modules built or modified and the public interfaces that change; schema changes,
API contracts, architectural choices, and the alternatives rejected and why. No
file paths, no code.

## Acceptance Criteria (assertions)

Each becomes a contract assertion. Write each as a discrete, independently
verifiable claim, with:

- `id` (short, stable, e.g. `BILL-001`)
- `statement` — the externally observable behaviour that proves it works
- `areas` — the owning slug(s)
- `verificationMethod` — `unit` | `integration` | `lint-boundary` | `behavioral-e2e`
- for `behavioral-e2e`: the flow or spec that proves it, the user state it runs
  as, and any data it must leave behind.

**Write each so it can FAIL.** Ask of every one: could this pass while the
feature is broken? If yes, rewrite it. Do not list the harness's default
assertions (boundaries respected, docs updated, project constraints); the
planner adds those.

## Escalations (shared surfaces)

Everything outside a single area's paths: schema and migrations, generated
registries, shared kernels, any `protectedPaths` entry, cross-area changes, new
dependencies. Naming them here lets the planner batch them early instead of
meeting them one milestone at a time. If none: "None — all changes are
area-local."

## Milestones

Features grouped into contract slices in dependency order: `id`, features,
assertions, and the `design-<id>.md` for any design-spec surface. Isolate
escalations early, split surfaces, order by dependency. Say which milestones
depend on which (`M2 consumes M1's interface`) and which could run in parallel:
the plan uses that to give parallel milestones their own folders and sessions.

## Testing Decisions

What a good test is here (external behaviour, not implementation), which modules
get tests, and the prior art in the codebase.

## Out of Scope

What this deliberately does not do.

## Open Questions

Anything still undecided. The planner will interview for each before writing
the contract.

</prd-template>

## 5. Hand off — straight into the plan

This folder IS the mission's input. Do not end the session on "the PRD is
ready": go on to the plan phase (`mission prompt plan`) on
`<paths.missions>/<id>/` in this same session, so the user is not asked to
re-prompt. Tell them in one line that you are doing so. The plan reads this
folder, writes the validation contract, and **blocks for their approval before
any code is written.** Its approval question offers "approve and run on
autopilot": with that answer the run starts in a fresh context by itself and
goes milestone by milestone to merged PRs and follow-up triage
(`mission prompt autopilot`).
