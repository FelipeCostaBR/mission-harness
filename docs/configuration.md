# Configuration

`mission.config.json` is the **only** place project knowledge lives. Every
rule in `src/rules/` is pure and project-blind; every prompt is written against
this file's vocabulary. That separation is what lets the same harness run on a
Rails monolith, a Go service mesh and a TypeScript monorepo.

You should not hand-write this file. Run `mission prompt init` and give it to
your agent — it surveys the repository and derives the values. Then run
`mission doctor`, which checks the result against reality.

This page is the reference for what `doctor` is checking and why.

---

## `areas`

The unit of worker ownership. One slug, plus the ONLY paths a worker assigned to
it may edit.

```jsonc
{
  "slug": "billing",
  "pathGlobs": ["src/billing/**", "test/billing/**"],
  "surface": "service",
  "docs": "src/billing/README.md",
  "publicApi": "src/billing/index.ts",
  "owns": ["subscriptions", "invoices"]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `slug` | yes | Unique identifier. |
| `pathGlobs` | yes | The edit scope. Supports `*` (one segment) and `**` (any depth, anywhere in the pattern). |
| `surface` | no | Key into `surfaces{}` — which toolchain verifies it. |
| `docs` | no | Documentation the default assertions require updating. |
| `publicApi` | no | The seam other areas consume. Cross-area access goes through it. |
| `owns` | no | Data/tables this area owns. Feeds the data-ownership assertion. |

**Hard requirements**, all enforced by `doctor`:

- **Disjoint.** No file may be claimed by two areas — the parallelism rule assumes
  disjointness to prove two workers can run concurrently.
- **Non-empty match.** An area matching zero tracked files is a typo or a moved
  directory, and it makes every edit in it a boundary violation.
- **Not exhaustive.** Areas must NOT cover the whole repository. See
  `unownedPaths`.

**Sizing.** Roughly 5-50 source files: what one worker can hold and change
coherently. Fewer than 3 areas and the harness is one big worker with ceremony.
More than ~15 usually means you split by file type (`controllers/`, `models/`,
`views/`) rather than by seam — after which every feature touches every area and
nothing is ever disjoint.

---

## `surfaces`

A toolchain, not a folder. Two areas share a surface when the same commands
verify them.

```jsonc
"surfaces": {
  "service": { "gates": ["npm run typecheck", "npm run test:server"], "designSpec": false },
  "web":     { "gates": ["npm run typecheck:web", "npm run test:web"], "designSpec": true }
}
```

Split when the commands differ. A worker handed the wrong toolchain will report
green having run nothing — a filtered build command that matches no package
typically exits 0, which is indistinguishable from success.

`designSpec: true` requires a design spec before any worker on that surface runs,
and mounts it into both the worker and the validator. Without one, a UI validator
can only confirm the code compiles.

---

## `gates`

The milestone integration gate: the check that is not delegated and not
judgement-based.

```jsonc
"gates": {
  "pre": ["rm -f tsconfig.tsbuildinfo"],
  "integration": [
    { "cmd": "npx tsc --noEmit", "why": "whole-program type graph" },
    { "cmd": "npm run lint", "why": "full lint, not just import boundaries" },
    { "cmd": "npm run test:architecture", "why": "registry consistency" }
  ]
}
```

`pre` runs first. **Put cache-busters here** — this is correctness, not hygiene.
An incremental compiler with a warm build cache skips re-checking touched files
and reports a **false green**, and a type-stripping test runner passes too, so a
real type error can ride the entire gate.

`integration` must include the whole-program typecheck, the **full** linter (not
just an import-boundary check — different tools, different bugs), and any
architecture or consistency suite the repo has.

**Verify every command runs before you write it down.** A gate command that does
not exist will be "run" and "pass" for the life of the project.

**Make it the gate CI runs, the whole repository's.** A scan in one package can
read another package's files, so a gate limited to the touched areas passes
while CI goes red (invariant 18). An entry may carry `expect`, a regular
expression its output must match: a suite that silently ran nothing also
exits 0.

`mission gate <missionDir> <milestone>` runs the list: the database setup,
`pre`, every `integration` entry, the milestone's `verifiedBy` re-run, then the
teardown, under one deadline (`deadlineMinutes`, default 120), each step in its
own process group with its own log, and records `set-gate integration`.

### `gates.database` — a throwaway database for the gate

Optional. When the suites need a database, give the gate its own, fresh one, the
way CI does, so they never run against a shared one:

```jsonc
"gates": {
  "integration": [{ "cmd": "npm test", "expect": "\\d+ passing" }],
  "deadlineMinutes": 120,
  "database": {
    "enabled": true,
    "url": "postgresql://postgres@127.0.0.1:{port}/mission_gate",
    "port": 5456,
    "envKeys": ["DATABASE_URL"],
    "forbid": ["<a substring of your production host>"],
    "setup": [
      "initdb -D {dataDir} -U postgres -A trust -E UTF8 --locale=C",
      "pg_ctl -D {dataDir} -l {logDir}/db.log -w start -o \"-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''\"",
      "createdb -h 127.0.0.1 -p {port} -U postgres mission_gate",
      "npm run db:migrate && npm run db:seed"
    ],
    "teardown": ["pg_ctl -D {dataDir} -m fast -w stop"],
    "stoppedCheck": "pg_ctl -D {dataDir} status; test $? -eq 3"
  }
}
```

- `{dataDir}` is a fresh temp directory, `{port}` the port (`--port` overrides),
  `{logDir}` the gate's log directory; paths are shell-quoted for you.
- Every gate child runs with each `envKeys` variable **overridden** to `url`.
  `url` must be on loopback (or a host-less file URL), and an inherited value
  containing any `forbid` substring refuses the run before anything starts.
- `setup` steps are critical: one failing skips the suites. `teardown` always
  runs, on a signal too. The data directory is deleted only once `stoppedCheck`
  exits 0 (or, with no check, the teardown was green); `--keep-db` keeps it.
- Postgres on macOS: set `LC_ALL` in your shell if the server refuses to start,
  and keep `unix_socket_directories=''`, because a deep temp path overflows the
  socket path limit.

---

## `protectedPaths`

Files a worker may never edit. Touching one is an escalation.

```jsonc
"protectedPaths": [
  { "glob": "db/schema.prisma", "reason": "database schema",
    "companionGlobs": ["db/migrations/**"] },
  { "glob": "packages/core-math/**", "reason": "shared formulas",
    "alwaysDelegate": true }
]
```

| Field | Meaning |
| --- | --- |
| `glob` | The protected path. |
| `reason` | Surfaced in the routing decision. |
| `alwaysDelegate` | Never inline, regardless of diff size. |
| `companionGlobs` | Extra paths a delegated worker needs (a migrations dir beside a schema file). |

Use `alwaysDelegate` where **blast radius, not diff size**, is what matters. Pure
computational logic other code trusts is the archetype: a one-line change to a
formula is small, and wrong is catastrophic.

Typical entries: schema/migration sources, shared kernels, generated registries
and DI containers, public APIs other apps consume, and security-relevant config
(auth middleware, permission tables, rate limits).

---

## `additivePairs`

Two-file shapes that count as ONE trivial additive change, so a genuinely trivial
addition stays inline instead of costing a worker spawn.

```jsonc
"additivePairs": [{ "primary": "db/schema.prisma", "generated": "db/migrations/**" }]
```

Only applies when the orchestrator also declares `additiveOnly`.

---

## `unownedPaths`

Paths you already know no area owns and that a typical feature will hit.

This list is documentation for the planner: it lets a mission batch those
escalations into one early milestone instead of discovering them one at a time
across five later ones. `mission doctor` reports the full count; you record
here the ones that matter.

**Do not widen an area to absorb one.** The exclusion is the architecture.

---

## `seats`, `seatLadder` and `models`

`seats` says how each seat runs: `runtime` (`session` or `subagent`) and
`readOnly`. `doctor` **errors** if `validator.readOnly` is not `true`.

Which model and effort a spawn runs on comes from the **seat ladder**, not from
`seats`. The built-in table (`src/rules/seat-ladder.default.json`) has seven
rungs, Haiku/low to Opus/max, and per role a `start` rung, a `ceiling`, and the
failure triggers it climbs on (`climbOn`). The worker's start depends on the
milestone's size tier (`mission size`). A `cheap` profile lowers the starts; a
mission opts in with a top-level `seatProfile: "cheap"` in its state.

```bash
mission seat resolve '{"role":"validator"}'
# {"model":"opus","effort":"xhigh","rung":"L5","climbed":false,...}
```

Set `seatLadder` to a full replacement table (same shape as the default) to
change it; `doctor` checks every role's start and ceiling are real rungs.

The ladder's `model` values are Claude Code's tier aliases (`haiku`, `sonnet`,
`opus`). `models{}` maps each to a concrete id per runtime, for runtimes without
those aliases:

```jsonc
"models": {
  "opus":   { "claude-code": "opus",   "default": "claude-opus-5-5" },
  "sonnet": { "claude-code": "sonnet", "default": "claude-sonnet-5-5" },
  "haiku":  { "claude-code": "haiku",  "default": "claude-haiku-5-5" }
}
```

See `docs/models.md` for why the orchestrator and validator are the seats worth
paying for.

---

## `commitBoundary`

Optional settings for `mission commits <range>`, the per-commit boundary check.
Protected paths are always forbidden and the mission folder is always exempt.

| Field | Meaning |
| --- | --- |
| `archTestGlobs` | Existing architecture tests. A commit that edits one must have it NAMED (not globbed) in a claiming grant. |
| `forbiddenExceptions` | Paths under a protected glob that a grant may still touch. |
| `ownerAcceptedPrefixes` | Commit subjects the owner accepted outside any grant (a rebase reconciliation). |
| `acknowledged` | Retroactive grants the owner has acknowledged. |

---

## `policy`

| Key | Default | Meaning |
| --- | --- | --- |
| `maxCorrectiveRounds` | `2` | The circuit breaker. Two failed rounds means stuck, not unlucky. |
| `parallelWorkers` | `true` | Allow provably-disjoint features to run concurrently. |
| `simplifyPass` | `true` | Run a simplify worker per touched area before validation. |
| `commitPerFeature` | `true` | Commit after each clean handoff, so the next worker inherits a clean tree. |
| `commitSubjectTemplate` | `feat({area}): {feature}` | Commit subject format. |

---

## `constraints`

Project-wide rules every worker must honour, in plain language. Injected into
every seat prompt and auto-added as default contract assertions.

Good constraints are specific and checkable:

- ✅ "Never call `console.*` in `src/server/**`; use the logger from `src/lib/log.ts`."
- ✅ "All DB access goes through a repository in `src/data/`, never a raw client
  call in a handler."
- ❌ "Write clean code."

Include user-facing copy rules **verbatim**. Linters do not catch those and they
are expensive to fix after the fact.

---

## `liveGate`

Optional verification that can only happen outside the harness: a device run, a
staging deploy, a manual QA pass.

```jsonc
"liveGate": {
  "enabled": true,
  "runner": "npm run e2e -- --area {{area}}",
  "skipExitCode": 78,
  "areas": {
    "checkout": { "flows": ["e2e/checkout.spec.ts"], "expectSignals": [{ "name": "purchase", "min": 1 }] }
  }
}
```

**The exit code is the contract:**

| Exit | Result |
| --- | --- |
| `0` | `pass` |
| `skipExitCode` | `skipped` — no runner available. A SKIP, never a regression and never a false pass. |
| anything else | `fail`, after one retry for infrastructure flake. |

A mission with an unverified live gate is recorded **`gated`, not `done`**.

`areas` is the single source for each area's flows and expected signals, so the
contract and a manual run cannot drift apart.

---

## `autopilot`

Settings for the end-to-end run a human may approve at plan time
(`docs/protocol.md` § Autopilot). The approval itself lives in
`mission-state.json`, never here.

```jsonc
"autopilot": {
  "landCommand": "gh pr merge {pr} --squash --auto",
  "maxLandFixRounds": 3,
  "followUpBatchSize": 5,
  "smallFixMaxLines": 150
}
```

- `landCommand` is how a PR lands once every check is green: your own script, a
  merge queue, or your forge's auto-merge. Empty means "the project's documented
  land step". It must never push to the default branch directly.
- `maxLandFixRounds` bounds the red-check fix loop before the run blocks.
- `followUpBatchSize` and `smallFixMaxLines` bound what triage may fix itself;
  anything larger is deferred with a reason.
