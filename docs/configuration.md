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

## `seats` and `models`

```jsonc
"seats": {
  "orchestrator": { "tier": "frontier", "runtime": "session" },
  "worker":       { "tier": "standard", "runtime": "subagent" },
  "validator":    { "tier": "frontier", "runtime": "subagent", "readOnly": true },
  "reviewer":     { "tier": "frontier", "runtime": "subagent", "readOnly": true }
},
"models": {
  "frontier": { "claude-code": "opus",   "default": "claude-opus-5" },
  "standard": { "claude-code": "sonnet", "default": "claude-sonnet-5" }
}
```

`doctor` **errors** if `validator.readOnly` is not `true`, and warns if the
orchestrator or validator is not on the frontier tier. See `docs/models.md`.

---

## `policy`

| Key | Default | Meaning |
| --- | --- | --- |
| `maxCorrectiveRounds` | `2` | The circuit breaker. Two failed rounds means stuck, not unlucky. |
| `escalateSeatAfterRounds` | `1` | Spend the frontier tier on the LAST attempt before the breaker trips, not the first. |
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
