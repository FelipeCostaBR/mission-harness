# <Feature name>

> The input to a mission. The orchestrator reads this, interviews you about what
> it leaves undecided, and turns it into a machine-checkable validation contract.
>
> **A one-line idea is not a spec.** The harness will refuse to plan from one, and
> it is right to: every documented plan-phase failure traces back to a premise
> nobody wrote down. Fill this in, or generate it with your model first and then
> read it critically yourself.

## Problem

What is wrong today, for whom, and how you know. Include the evidence — a number,
a support thread, a screenshot, a log. If you cannot say how you know, say that
too; it changes what "done" can mean.

## Outcome

What is true when this ships, stated so someone else could check it without
asking you. "Users can export their data as CSV from the settings screen" is
checkable. "Better export experience" is not.

## Non-goals

What this deliberately does NOT do. This section prevents more scope creep than
any other, because a worker with spare context will otherwise helpfully build the
adjacent thing.

## Surfaces & areas

Which parts of the codebase this touches, in the vocabulary of your
`contractor.config.json`.

| Area | What changes | Surface |
| --- | --- | --- |
| `<slug>` | … | `<surface>` |

**Paths no area owns.** List every path you already know this will need that
falls outside every area's globs — shared kernels, schema files, generated
registries, cross-cutting route handlers. Run `contractor own <paths...>` to
find them. These become escalations. Naming them here means they get planned as
one early batch instead of ambushing five separate milestones one at a time.

## Acceptance criteria

The heart of the document. One line per testable claim. Each becomes a contract
assertion, so write them the way a skeptic would check them.

- [ ] …
- [ ] …

**Write these so they can FAIL.** For every criterion, ask: *could this pass while
the feature is broken?* If yes, rewrite it.

- ✅ "A bounded pool caps concurrency at 4, proven by a test asserting at most 4
  resolvers run at once."
- ❌ "Concurrency is capped at 4." — a named-but-unused constant satisfies this
  while the cap is a no-op.
- ✅ "Both screens compute the total from the persisted order, and their values
  differ by at most 1 cent."
- ❌ "Both screens show the same value (within rounding)." — self-cancelling; it
  passes at any delta you decide to call rounding.

## Decisions already made

Choices that are settled, and why. A later milestone that relitigates one of
these costs a round. Record the rejected option too — "we are not doing X
because Y" is the half that actually prevents the rework.

| Decision | Why | Rejected alternative |
| --- | --- | --- |
| … | … | … |

## Open questions

What you do not know yet, and who can answer it. The orchestrator will interview
you on exactly these before writing the contract, and will refuse to invent an
answer for anything that changes what "done" means.

## Milestones (optional)

If the work has a natural order, propose it. The orchestrator honours a sensible
partition and revises only with a reason.

Two rules it will enforce regardless:

1. **A milestone owns coverage of its own output.** The tests, docs and README
   for what milestone N ships belong to milestone N. Bind them to N+1 and a halt
   between them leaves N's shipped code uncovered.
2. **Speculative work does not ride with shippable work.** If a milestone's
   acceptance is a hypothesis that might come back NO-GO, it must not gate
   features that are independently shippable — a falsified hypothesis would
   freeze them for nothing.

## Design spec (UI work only)

Link the committed design spec for any milestone that changes a user-facing
surface. Without one, a UI validator has no design contract to check and can only
verify that the code compiles.
