# Contractor

**The contract-first multi-agent build harness.**

Define "done" as a machine-checkable contract *before* any code. Fan the work out
to path-scoped worker seats. Have a fresh, adversarial seat adjudicate every
claim.

```bash
npm install -g contractor-harness
cd your-project

contractor init                       # scaffold
contractor prompt init                # hand this to your agent — it adapts the harness to YOUR repo
contractor doctor                     # verify the adaptation against reality

contractor mission new csv-export     # then write the spec and run it
```

Works with Claude Code, Codex, Cursor, or a person pasting prompts into a chat
window. Runs markedly better with a frontier reasoning model in two specific
seats — see [docs/models.md](docs/models.md).

---

## The problem this solves

Point a capable agent at a real feature and you usually get code that looks
right, tests that pass, and a summary that says it is done. Then you read it.

The failures are rarely "the model could not write the function". They are:

- **The tests pass but do not test the claim.** The unit mocks the very boundary
  the logic lives in and asserts the mock's output.
- **The definition of done was written after the code**, so it describes the
  code.
- **The agent that wrote it also judged it**, and agreed with itself.
- **A "small" change to a shared file** broke three things nothing tested.
- **It said done.** The part that mattered was never verified.

More capable models make this *worse*, not better, because the output is more
plausible. Contractor is the harness that makes those failures visible.

## How it works

```
  spec
    │
    ▼
┌─────────┐   ← a human approves the CONTRACT, before any code exists
│  PLAN   │
└─────────┘
    │
    ▼
┌─────────┐   ← workers, each scoped to ONE area's paths, in fresh contexts
│   RUN   │
└─────────┘
    │
    ▼
┌──────────┐  ← validators that NEVER saw the implementation, read-only
│ VALIDATE │  + a deterministic gate that no seat can talk its way past
└──────────┘
    │
    ├── advance ────────► next milestone
    ├── corrective ─────► back to RUN, max 2 rounds
    └── circuit-break ──► halt, checkpoint, ask a human
```

Five properties do the work:

**1. The contract is written and approved before any code.**
One assertion per testable claim. The question asked of every one: *could this
pass while the feature is broken?* If yes, it gets rewritten. Roughly **40% of
the defects found across real runs existed before a line of code was written** —
this is where they are catchable.

**2. Workers are path-scoped and cannot escape.**
A worker edits one area's globs and nothing else. A change it needs elsewhere is
an *escalation*: it stops and reports. That constraint is what makes parallelism
safe and reviews meaningful.

**3. Validators are read-only and never saw the implementation.**
A verifier that can edit will fix what it was asked to judge. A verifier that
shares the implementer's context will agree with it. Both destroy the mechanism.

**4. Decisions that matter are tested code, not prose.**
"Can I try a third corrective round?" "Is this escalation big enough to
delegate?" "Did this milestone earn an advance?" Each is a pure function with a
test suite, because a model under context pressure will eventually rationalise
its way past a paragraph.

**5. The mission survives its own context window.**
A real mission spans many windows. Measured: **30-42% of all orchestrator tokens
went on re-orientation**. `contractor brief` reconstructs position *and*
accumulated knowledge in ≤6KB, so a reset costs a couple of thousand tokens
instead of a hundred thousand.

## Adapting it to your codebase

The harness knows nothing about your repository until you tell it. That is one
file, and you do not write it by hand:

```bash
contractor prompt init > /tmp/init.md
# "Follow /tmp/init.md against this repository."
contractor doctor
```

The prompt makes your agent survey the repo — build system, CI, test layout, git
co-change history — and derive the areas, the toolchains, the integration gate,
the protected paths and the seats. `doctor` then checks every claim against
reality: do the globs match real files, are the areas disjoint, do the gate
commands exist, is the validator actually read-only.

```
$ contractor doctor
  ERROR area-matches-nothing
        Area "reporting" matches 0 tracked files. Its globs are wrong or the code moved.
  warn  gate-script-missing
        Gate "npm run test:arch" runs script "test:arch", which is not in package.json.
  info  unowned-paths
        41 tracked file(s) belong to no area. That is normal and often deliberate —
        cross-cutting paths must escalate. Top: db/, src/app/api, packages/shared
```

Paths that no area owns are a **feature**, not a gap: they force an escalation
instead of letting a path-scoped worker quietly edit a shared surface.

## The CLI

The deterministic half. It never calls a model.

```
Setup
  init                        scaffold contractor.config.json
  doctor                      validate the config against this repository
  install [adapter]           wire the prompts into an agent runtime
  prompt [name]               print a seat prompt (works with ANY model)

Missions
  mission new <id>            scaffold a mission folder
  arm <missionDir>            arm edit-routing for a mission
  disarm [status] [dir]       halted | gated | done
  status                      armed state + milestone position
  brief                       the rehydration digest for a fresh context

Decisions  (pure rules, evaluated against the mission's artifacts)
  check                       bookkeeping invariants
  advance                     advance / corrective / circuit-break
  partition <milestone>       which features may run in parallel
  escalate <files…>           inline or delegate, and the worker's path grant
  own <paths…>                which area owns a path
```

## The seats

| Seat | Context | Can edit? | Job |
| --- | --- | --- | --- |
| **orchestrator** | the whole mission | no code | Plans, routes, adjudicates |
| **worker** | fresh, one feature | one area's globs | Builds |
| **validator** | fresh, never saw the code | **no** | Verifies, adversarially |
| **reviewer** | fresh, parallel siblings | **no** | Attacks the plan before code exists |
| **escalation worker** | fresh | a tight per-escalation grant | Changes protected surfaces |
| **simplifier** | fresh, no contract | one area's globs | Reuse, dedup, altitude |

## Why the rules are what they are

Every invariant in [docs/invariants.md](docs/invariants.md) exists because
breaking it produced a failure that **every other check passed**. A sample:

- **Staging an unchanged file exits 0**, so a commit can "succeed" containing
  nothing — which is how an edit that never landed masquerades as done.
- **A warm incremental build cache makes the typecheck report a false green**,
  and a type-stripping test runner passes too, so a real type error rides the
  entire gate.
- **A round logged but not counted disarms the circuit breaker** *and* the seat
  escalation, silently — both read that one counter.
- **A validator's verdict transcribed from memory** turned a real drift into
  "passing with notes". Verdicts are now persisted byte-for-byte before any value
  is read from them, and a missing verdict file is a failure, never an assumed
  pass.
- **`gated` is a distinct terminal state from `done`**, because a mission once
  reported done with its whole on-device surface unverified — and the deferred
  real run found four genuine bugs.

[docs/playbook.md](docs/playbook.md) is the full catalogue: ways agent-built work
goes wrong while everything reports green.

## Docs

| | |
| --- | --- |
| [protocol.md](docs/protocol.md) | Seats, artifacts, the loop, terminal states |
| [schemas.md](docs/schemas.md) | Every JSON artifact, annotated |
| [invariants.md](docs/invariants.md) | The rules, and what breaking each one cost |
| [configuration.md](docs/configuration.md) | `contractor.config.json` reference |
| [models.md](docs/models.md) | Which seats deserve a frontier model, and why |
| [playbook.md](docs/playbook.md) | Failure modes that pass every check |
| [faq.md](docs/faq.md) | Honest answers, including when not to use this |

## Use it as a library

Every decision rule is pure, tested, and importable:

```js
import { decideSelfHeal, partitionDisjoint, routeEscalation } from "contractor-harness"
```

No I/O, no clock, no randomness. Build your own runner and the decisions stay
identical to every other runtime's.

## Status

Early. The protocol and the rule engine come out of a year of running multi-agent
missions on a production codebase; the packaging is new. Expect the CLI surface
to move before 1.0.

Issues and pull requests welcome — especially reports from stacks other than
TypeScript, which is where the adaptation prompt has the least evidence behind
it.

MIT.
