# Adapt Mission Harness to this codebase

You are setting up the Mission Harness harness for a repository you have not seen
before. Your output is a filled-in `mission.config.json` that `mission
doctor` reports zero errors on, plus a short written handover explaining the
judgement calls you made.

This is a **survey task, not a form-filling task**. Every value you write is a
claim about this repository. Verify each one against the code before you write
it, and cite what you looked at. A config that describes a codebase that does not
exist is worse than no config: it will route workers into the wrong files and
every gate will pass vacuously.

Work through the seven steps in order. Do not skip to writing the file.

---

## 0. Ground yourself

Read, in this order:

1. The repository's own agent instructions if any exist (`CLAUDE.md`,
   `AGENTS.md`, `.cursorrules`, `CONTRIBUTING.md`). These tell you the
   conventions and the sharp edges.
2. `README.md` — what the project is for.
3. The root manifest (`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`,
   `Gemfile`, `pom.xml`, …) and any workspace/monorepo declaration.
4. The CI workflow files. **CI is the most reliable source of truth for what
   "green" means here** — it is the one set of commands somebody already proved
   works from a clean checkout.

Then get the shape of the tree:

```
git ls-files | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -40
```

Write down, for yourself: what kind of system is this, what is the deployable
unit, and where does the code that changes most often live.

---

## 1. Find the seams — define the areas

An **area** is the unit of worker ownership: one slug, plus the ONLY paths a
worker assigned to it may edit. Everything else about the harness follows from
this partition, so it is the decision worth spending the most time on.

**A good area is a seam that already exists.** You are discovering the
repository's structure, not imposing one. Look for, in descending order of
preference:

- Workspace packages or modules the build system already treats as units.
- Directories with their own `README`, `index`/barrel file, or public API.
- Bounded contexts named consistently across layers (`src/billing/`,
  `test/billing/`, `docs/billing.md`).
- Directories whose files change together in the git history:
  ```
  git log --format='%H' -n 400 | while read c; do
    git show --name-only --format='' "$c" | sed 's|/[^/]*$||' | sort -u | paste -sd, -
  done | sort | uniq -c | sort -rn | head -30
  ```
  Paths that co-change constantly are one area, whatever the folder tree says.

**Hard requirements**, all checked by `mission doctor`:

- **Areas must be DISJOINT.** No file may be claimed by two areas. The
  parallelism rule assumes disjointness to prove two workers can run
  concurrently; overlapping areas silently break that proof.
- **Every area's globs must match real tracked files.** An area matching zero
  files is a typo or a moved directory, and it makes every edit in it a boundary
  violation.
- **Areas must NOT cover the whole repository.** See step 2 — this is a feature.

**Sizing.** Aim for an area a single worker can hold in context and change
coherently: roughly 5-50 source files. Fewer than 3 areas means the harness
degenerates into one big worker with extra ceremony. More than about 15 usually
means you have split by file type (`controllers/`, `models/`, `views/`) rather
than by seam — which is the classic mistake, because every real feature then
touches every area and nothing is ever disjoint.

If the codebase genuinely has no seams — one directory, everything imports
everything — say so plainly in your handover. Declare one or two coarse areas,
and note that the harness will run mostly serially until the code is factored.
Do not invent a partition the code does not have.

---

## 2. Decide what NOBODY owns

Now list the paths that fall outside every area. Run:

```
mission doctor        # reports the count and the top directories
mission own <path>…   # checks specific paths
```

**Unowned paths are the point, not a gap to close.** These are the
cross-cutting surfaces — a shared kernel, a database schema, a generated
registry, a dependency-injection root, route handlers that bind to a feature by a
tag rather than a folder. A path-scoped worker editing one of these can break
every other area while its own tests stay green.

Leaving them unowned forces them through the escalation path, where a dedicated
worker makes the change and a **fresh** validator reviews it.

So: **do not widen an area's globs to absorb an unowned path.** The exclusion is
the architecture.

Record the ones a typical feature will hit in `unownedPaths`. That list is what
lets a planner batch them into one early milestone instead of discovering them
one at a time across five later ones — which is the single most common source of
mid-mission stalls.

---

## 3. Surfaces — group areas by toolchain

A **surface** is a toolchain, not a folder. Two areas share a surface when the
same commands verify them.

Split surfaces when the commands differ: a backend and a mobile app in one
monorepo almost always have separate typecheck, test and lint invocations, and a
worker handed the wrong one will report green having run nothing. (A filtered
build command that matches no package typically exits 0 — a silent no-op that
looks exactly like success.)

Set `designSpec: true` on any surface that renders a user interface. That makes
the harness require a design spec before a UI worker runs, and mount it into both
the worker and the validator. Without it, a UI validator can only confirm the
code compiles.

---

## 4. The integration gate — the check that is not delegated

`gates.integration` is the most important list in the config, and the one you
must actually RUN before writing down.

Per-area tests structurally cannot see breakage that spans the repository: a
whole-program type graph, an exhaustive registry or enum mapping, a generated
client drifting from its schema, a cross-source consistency suite. Real runs have
shipped exactly this class of failure with every per-file test green.

Include, adapted to this stack:

- **The whole-program typecheck / compile.** Not per-file. This is the single
  highest-yield gate in most repositories.
- **The full linter.** Not just an import-boundary check — those are different
  tools and the difference accumulates as debt across milestones.
- **Any architecture, registry or consistency suite** the repo already has.
- **Schema validation and client regeneration**, if the repo has a schema that
  generates code.

Put **cache-busters in `gates.pre`**. This is not hygiene, it is correctness: an
incremental compiler with a warm build cache will skip re-checking touched files
and report a **false green**, and a test runner that strips types rather than
checking them will pass too. A real type error can ride an entire gate this way.
If the repo has an incremental build artifact, delete it in `pre`.

**Verify every command runs.** Execute each one and record the exit code. A gate
command that does not exist is worse than no gate — it will be "run" and
"pass" for the life of the project. If a command is too slow to be a gate
(over ~10 minutes), say so in your handover and propose a scoped variant rather
than silently dropping it.

---

## 5. Protected paths and escalation

`protectedPaths` are the files a worker may never edit. Anything a worker needs
there becomes an escalation.

Include:

- The schema or migration source, plus its generated companions.
- Any shared kernel, common library, or cross-cutting utility layer.
- Generated registries, DI containers, dependency graphs, exhaustive mappings.
- Public API surfaces other teams or apps consume.
- Security-relevant configuration: auth middleware, permission tables, CORS,
  rate limits.

Set `alwaysDelegate: true` on anything whose blast radius justifies a fresh
adversarial read every single time, regardless of how small the diff looks. Pure
computational logic that other code trusts is the archetype: a one-line change to
a formula is small, and wrong is catastrophic.

Use `additivePairs` for two-file shapes that are inherently ONE change — a schema
file plus the migration generated from it. Declaring the pair keeps a genuinely
trivial addition inline instead of costing a worker spawn.

Set `testGlobs` to where tests live. Delegated escalation workers get that grant
so they can prove their change.

---

## 6. Seats and models

`seats` says who does what; `models` maps abstract tiers to real model ids.

Keep the defaults unless you have a specific reason:

| Seat | Tier | Why |
| --- | --- | --- |
| orchestrator | frontier | It plans, adjudicates, and holds the mission across many context windows. Every downstream cost is set by decisions made here. |
| worker | standard | Implementation inside a bounded scope with an explicit contract is the most tractable job in the system. |
| validator | frontier | A weak verifier rubber-stamps. Its whole value is catching what a confident implementer missed. |
| reviewer | frontier | Adversarial plan review is pure reasoning with no code to lean on. |

**The validator must be `readOnly: true`.** A validator that can edit is not a
verifier — it will quietly fix what it was asked to judge, and the verdict
becomes meaningless.

If this repository's runtime uses its own tier aliases, map them in `models`.
Keep model ids in that one block so a model upgrade is a one-line change.

---

## 7. Constraints

`constraints` are project-wide rules every worker must honour, in plain language.
They are injected into every seat prompt and become default contract assertions.

Harvest them from the repo's own agent instructions, its linter config, and its
CONTRIBUTING guide. Good constraints are specific and checkable:

- ✅ "Never call `console.*` in `src/server/**`; use the `logger` from
  `src/lib/log.ts`."
- ✅ "All new DB access goes through a repository in `src/data/`, never a raw
  client call in a handler."
- ❌ "Write clean code."

Include any user-facing copy rules verbatim. They are invisible to linters and
expensive to fix after the fact.

---

## Write the config, then prove it

1. Write `mission.config.json`.
2. Run `mission doctor`. **Iterate until it reports zero errors.** Warnings
   are judgement calls you may keep — explain each one you keep.
3. Run every `gates.integration` command and record its exit code.
4. Spot-check the routing on real paths:
   ```
   mission own $(git ls-files | shuf -n 15)
   ```
   Every path should land in the area you would have guessed, or be deliberately
   unowned. If any surprises you, the globs are wrong — fix them now, because
   this is far cheaper than discovering it mid-mission.

## Then hand over

Write a short summary for the human, covering:

- **The area partition** and the seam you used to derive it.
- **What is deliberately unowned**, and why those must escalate.
- **The gate commands you ran**, with their exit codes and rough durations.
- **Every judgement call you are unsure about.** This matters more than the rest:
  you are guessing about a codebase you met an hour ago, and the human can
  correct in one sentence what would otherwise cost a mission a corrective round.
- **Anything you could not determine**, stated plainly rather than filled with a
  plausible default.
