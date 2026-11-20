# Models and seats

Mission Harness works with any model that can read files, run commands, and follow a
long instruction. It works **markedly better** with a frontier reasoning model in
two specific seats, and that difference is not uniform — it is concentrated where
a mistake is expensive and invisible.

Seats are named by abstract tier (`economy` / `standard` / `frontier`) and mapped
to real model ids in one block of `mission.config.json`, so a model upgrade is
a one-line change and the harness is not coupled to a vendor.

---

## Where model strength actually pays

| Seat | Tier | Why this tier |
| --- | --- | --- |
| **orchestrator** | frontier | Writes the contract, partitions the work, adjudicates every boundary, and holds the mission across many context windows. Every downstream cost is set by decisions made here. |
| **validator** | frontier | Its entire value is catching what a confident implementer missed. A weak verifier rubber-stamps, and a rubber-stamp is worse than no validator: it manufactures false confidence. |
| **reviewer** | frontier | Adversarial plan review is pure reasoning with no code to lean on and no test to check against. |
| **worker** | standard | Implementation inside a bounded scope, with an explicit contract and a list of assertions, is the most tractable job in the system. This is where a mid-tier model is genuinely sufficient. |
| **simplifier** | standard | Local, mechanical, and every change is checked by the gate immediately afterwards. |

**If you only pay for one seat, pay for the orchestrator.** A weak plan is not
recoverable by strong workers: they will faithfully build the wrong thing, and
the harness will correctly certify that they did.

**If you can pay for two, add the validator.** The worker/validator pair is the
harness's core mechanism, and it only works when the verifier is at least as
strong as the creator. Inverting that gives you the cost of two seats and the
value of one.

---

## Concretely

Model ids move. Check the provider's current lineup rather than trusting a table
in a README — including this one.

```jsonc
"models": {
  "frontier": { "claude-code": "opus",   "default": "claude-opus-5" },
  "standard": { "claude-code": "sonnet", "default": "claude-sonnet-5" },
  "economy":  { "claude-code": "haiku",  "default": "claude-haiku-4-5-20251001" }
}
```

Tiers, not ids, is deliberate. Aliases ride model upgrades for free; pinned ids
have to be chased. Pin an id only when you need reproducibility across time — and
accept that you are then opting out of every improvement.

Broadly, by provider family:

- **Frontier** — the largest current reasoning model, with extended thinking
  enabled if the runtime supports it. Orchestrator, validator, reviewer.
- **Standard** — the mid-tier workhorse. Workers, simplifiers.
- **Economy** — the small fast model. Optional; see the caveat below.

---

## Long context is the second axis, and it is not optional for the orchestrator

The orchestrator carries a mission across many windows. The harness is built to
survive that — `mission brief` reconstructs a working state in ≤6KB — but a
larger window still means fewer resets, and every reset costs a ramp and a cold
prompt cache.

If your provider offers an extended-context variant, put the orchestrator on it.
Workers do not need it: a worker sees one area and one feature by construction,
which is exactly the property that makes the mid-tier seat viable.

---

## Family diversity between planner and verifier

The validator's adversarial value rests primarily on its **fresh, read-only
context** — it never saw the implementation or the reasoning behind it. That is
the load-bearing property, and it holds regardless of which model fills the seat.

Model-family diversity is a secondary, cheap hedge: an orchestrator and a
validator from different families are less likely to share a blind spot. If you
have credits with two providers, this is a good place to spend the second one.

**The trip-wire:** if you notice validators consistently passing work on the first
attempt with reasoning that echoes the orchestrator's own framing, pin the
validator to a different family and see whether the pass rate changes. A boundary
that always passes first try is not evidence the work is good.

---

## Where a small model is fine, and where it is a trap

**Fine:** a worker on a well-specified feature in a small area with good existing
tests. Documentation and comment updates. Mechanical refactors under a green
gate.

**A trap:**

- **The validator.** A weak verifier does not fail loudly, it agrees. You lose the
  entire mechanism and gain a plausible verdict file.
- **The orchestrator on a multi-milestone mission.** Errors compound: a
  mis-partitioned plan produces escalation churn that costs far more than the
  model saving.
- **Anything touching a protected surface.** Blast radius, not diff size, is what
  matters there.

---

## Runtimes

The protocol assumes only that you can spawn a sub-agent with its own context and
give it a prompt. Everything else is adaptation.

| Runtime | Spawning | Notes |
| --- | --- | --- |
| **Claude Code** | subagents (`.claude/agents/`) | The richest fit: hooks give you automatic edit routing and brief injection. `mission install claude-code`. |
| **Codex / AGENTS.md** | `codex exec` per seat | `mission install codex`. Edit routing is manual (`mission route <files>`) or a wrapper script. |
| **Cursor** | manual, per seat | `mission install cursor`. Best driven with the orchestrator in one window and seats in separate ones. |
| **Any chat model** | you, copy-pasting | `mission prompt <seat>`. Slower, and it genuinely works — the CLI does all the deterministic parts. |
| **Your own runner** | `import` the rules | `import { decideSelfHeal, partitionDisjoint } from "mission-harness"`. |

**Fresh context per seat is the one non-negotiable.** If your runtime cannot give
a validator a context that never saw the implementation, you are not running this
protocol — you are running one agent with extra steps. Separate windows, separate
sessions, or separate processes all count.
