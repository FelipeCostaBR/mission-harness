# Generic adapter — any model, any runtime

Mission Harness's protocol assumes exactly one capability: **you can give a model a
prompt in a context that does not contain the other seats' contexts.**

Separate windows, separate sessions, separate processes, separate people — all
count. Everything else is convenience.

This adapter copies nothing. It is the instructions for driving the harness by
hand, which is genuinely viable because the CLI does every deterministic part.

## Setup

```bash
npm install -g mission-harness
cd your-project
mission init

mission prompt init > /tmp/mission-init.md
# Give /tmp/mission-init.md to your model, pointed at this repository.

mission doctor        # iterate until zero errors
```

## Running a mission by hand

**1. Scaffold and write the spec.**

```bash
mission new csv-export
$EDITOR docs/prd/csv-export/spec.md
```

**2. Plan.** Give your strongest model `mission prompt plan` plus the spec. It
returns a contract, a milestone plan, and an approval summary. **Read the summary
and approve or revise it.** This is the cheapest point in the whole mission to
change your mind, and the one where most defects are still catchable.

**3. Arm and build.**

```bash
mission arm docs/prd/csv-export
mission partition M1        # tells you what can run concurrently
```

For each feature, open a **fresh** context and paste
`mission prompt seats/worker` plus the payload: `area`, `pathGlobs`, the
feature spec, its assertions, the project constraints, the gate commands, and
`missionDir`.

The worker writes `handoffs/<feature>.json` and returns a digest. Commit the
feature so the next worker starts from a clean tree.

**4. Handle escalations.**

```bash
mission escalate db/schema.prisma src/shared/registry.ts
```

Take the routing. `delegate` means a **separate** worker in a fresh context,
using `mission prompt seats/escalation-worker`.

**5. Validate.** For each touched area, open a fresh context — one that has
**never seen the implementation** — and paste `mission prompt seats/validator`
plus the contract slice and the changed paths.

Save each returned object **verbatim** to `verdicts/<area>.json` before reading
any value from it. Then run the gate commands yourself and record the result.

**6. Decide.**

```bash
mission advance
```

`advance`, `corrective` (back to step 3 with sharpened procedures), or
`circuit-break` (stop and look at it yourself).

**7. Finish.**

```bash
mission check                                          # bookkeeping
mission disarm <halted|gated|done> <missionDir>
mission status                                         # must print INERT
```

## What you must not shortcut

Everything else is negotiable. These three are the protocol:

1. **The contract is approved before any code.** A definition of done written
   afterwards describes the implementation.
2. **The validator's context never saw the implementation.** Same window, same
   session, or a pasted conversation history all break this. It will agree with
   itself.
3. **Verdicts are saved raw, then read.** Not summarized, not "cleaned up". A
   missing verdict is a **failure**, never an assumed pass.

## Building your own runner

The rules are importable and pure:

```js
import {
  decideSelfHeal,
  partitionDisjoint,
  routeEscalation,
  boundaryViolations,
  computeAdvanceReadiness,
  rehydrationPlan,
  renderRehydrationBrief,
} from "mission-harness"
```

No I/O, no clock, no randomness — so your runner stays testable, and the
decisions stay identical to every other runtime's.
