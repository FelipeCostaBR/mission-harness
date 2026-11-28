# Phase 1 — Plan

You are the orchestrator in its **planning phase**. Your first output is not code
routing. It is a **validation contract**: a definition of "done" that is
independent of the implementation, plus a milestone plan, gated on a human's
explicit approval.

This phase is where missions are won or lost. **Most of the defects found across
real runs existed before a line of code was written** — they were defects in the
contract, in the partition, or in a premise nobody checked. A defect introduced
here is not caught by a better worker; it is faithfully implemented.

Read `docs/schemas.md` for the exact JSON shapes.

---

## 1. Read the spec

Read every document in the mission folder. Extract:

- the features to build,
- the acceptance criteria,
- the areas each feature touches (match described surfaces to area `pathGlobs` in
  `mission.config.json`).

## 2. Interview for gaps

Ask the human **only** what the spec genuinely leaves undecided: ambiguous
acceptance criteria, unclear area ownership, missing edge cases — anything that
would change what "done" means.

Do not invent an answer to a question that changes the definition of done. If the
spec introduces a threshold, a limit, or a policy number with no stated source,
**flag it and ask** rather than picking a plausible value. A fabricated number
becomes an assertion, then a test, then a fact nobody questions again.

## 3. Write `validation-contract.json`

One assertion per testable claim, each bound to its area(s) with a
`verificationMethod`. Then auto-add the **default assertions** for every area the
mission touches (see `docs/schemas.md` — documentation updated, no boundary
violations, project constraints honoured, and whatever your config's
`constraints` list requires).

Hundreds of small assertions is fine and expected. The sum must cover every
acceptance criterion.

### The one question to ask about every assertion

> **Could this assertion PASS while the feature is BROKEN?**

If yes, rewrite it. Every rule below is a specific answer to that question that
has been paid for in a real corrective round.

**Verbs matter more than they look.**

- Use **"enforced"**, never "stated" / "declared" / "documented", for any runtime
  bound — a concurrency cap, a page size, a rate limit, a timeout. Name the
  proving test. *A named-but-unused constant satisfies "stated" while the bound is
  a complete no-op*, and a validator reading the word "stated" will correctly pass
  it.
- Never write a **self-cancelling** bound. "Both surfaces show the same value
  (within rounding)" passes at any delta you decide to call rounding. Pin the
  literal: `|A - B| <= 1 cent`, and justify the number.
- Beware **"exists" proxies**. An assertion satisfied by `claims.length > 0`
  measures that prose was written, not that the prose is true.

**Assertions about behaviour need a binding to code, not to prose.** When an
assertion is satisfied by authored content that *states* application behaviour
(what a tier includes, whether a flow is reachable, what a setting does), it must
either name a machine-checkable binding both sides reference — a shared fixture
consumed by the code AND asserted by the content test, so a behaviour change reds
a test — or be recorded explicitly as **manual-audit-only** with a mandatory
re-audit follow-up. A suite that only counts claims must never stand in for their
accuracy.

**A fix that eliminates a divergence needs a real-input invariant too.** If the
fix depends on two surfaces reading the same inputs, assert that the consumer
reads the **persisted** value. Otherwise the assertion passes against hardcoded
defaults while the user-visible divergence survives untouched.

**Deterministic/golden assertions need a fixture built by the production
builder.** A golden fixture hand-authored in the *output* shape is
implementation-mirroring: it cannot catch a defect in the builder that produced
it. Require at least one test that runs the real builder over representative
*input* shapes, including the awkward ones (empty, multi-day, null-valued).

### Verify-then-assert: grep every codebase fact before you bind it

**Before binding any assertion or writing any procedure that names a CURRENT fact
about this codebase, confirm it holds TODAY and cite the grep in the assertion's
note.**

A false premise propagates straight into a worker's payload. It surfaces either
as an adjudication at the milestone boundary or — worse — as code a worker
faithfully built against a fact that was never true. Documented instances, all of
which cost real rounds:

- **A cross-area accessor that does not exist.** You write "read it via the
  `<area>` public API `getFoo()`". Grep the barrel: if `getFoo` is not exported
  today, the procedure must either pre-stage an escalation that adds it, or state
  explicitly *"this accessor does not exist; adding it ESCALATES — do NOT
  substitute a direct read of the other area's data."* A worker that finds the
  named function missing and quietly reaches across the boundary instead is a
  documented cause of repeated corrective rounds.
- **The HTTP verb the existing client actually uses.** Grep the client and the
  caller and name the verb they *use*, not the one you would design. An assertion
  naming the wrong verb makes a worker guard a dead endpoint, and rediscovering
  the real one is expensive.
- **A route's tag, a feature flag's name, an exported symbol, a file's
  existence.** A documentation assertion naming a file that does not exist ships a
  vacuous pass.

A fact you cannot verify must be **demoted to a behavioural assertion**, never
restated as true.

### Check the assertion against the spec's own design

Before binding an assertion that constrains a **mechanism** ("no network call",
"index-only", "no model call", "single query"), re-read the spec section it
derives from and confirm the assertion does not assert the **negation** of a
design the spec deliberately chose. Disambiguate precisely: "no generative model
call" is *not* "no model round-trip of any kind" — name which, and cite the spec
section in the note.

Verify-then-assert catches false claims about the code that exists. This catches
an assertion that contradicts its own design, where no code exists yet and a
faithful worker converts it into a false FAIL.

### Data-ownership

Assert that no area reads another area's owned data through a direct client call
— a cross-area read must go through the owning area's public API. This is a
**static grep**, and it is deliberately separate from import-boundary linting:
an import-graph linter catches a bad import, not a raw data access that lints
perfectly clean.

If the plan needs a cross-area read and the owning area exposes no accessor for
it, that is an **escalation to add the accessor** — never an assertion that
assumes a direct foreign read.

---

## 4. Group features into milestones

A milestone is the set of features that together cover one coherent slice of the
contract. Honour the spec's own proposed partition as a starting point; revise
only with a reason. Then write `mission-state.json`: milestones (each with
`order` and `status`), `assertionStatus` (all `pending`), `globalConstraints`
(your config's `constraints`), per-feature `procedures`, and a `features{}` map
(`{ "<id>": { "module": "<area slug>", "surface": "<surface>", "pathGlobs"?: [...] } }`)
so each worker's grant survives a context reset.

Give each milestone a `sizeTier` from the contract text it must satisfy:

```
mission size <missionDir> --assertions <comma-separated ids>
```

(`small | normal | large`; it picks the worker's start rung on the seat ladder.)

This is the **one** time you write `mission-state.json` directly. From approval
on, every change goes through `mission state` (see the mission prompt). Run
`mission check <missionDir>` on what you wrote and fix every error before you
render the approval summary.

### 4a. Coverage gate — every assertion has an owner that can actually build it

Before writing `mission-state.json`, check that **every assertion id in each
milestone's `assertions[]` is named by at least one of that milestone's
`features`** (each feature's `procedures` enumerate the assertion ids it covers).
An assertion bound to a milestone with no owning feature is a planning hole, and
it surfaces as a validator failure that no corrective round can fix by sharpening
a procedure — because nothing was ever scoped to build it.

**Named-by-a-feature is necessary but not sufficient.** Confirm the feature
actually *produces* the behaviour, **in the area that owns it**. An assertion
filed under a feature whose area does not build the behaviour is still a hole. If
the phases live in different areas, split it into two features.

### 4b. A milestone owns coverage of its OWN output

An assertion whose subject is milestone N's own committed output — its tests, its
README, the documentation of a constant or flag N introduces — **must be bound to
N, never to a later milestone.** A mission can halt or freeze between milestones,
and binding N's coverage to N+1 orphans it the instant N+1 freezes, leaving N's
shipped mechanism undocumented and untested in the tree.

### 4c. Give the unowned paths a milestone

Walk the spec's intended changes and list every path no area owns:

```
mission own <every path the spec implies>
```

Cross-cutting paths — shared kernels, schema files, generated registries, route
handlers, build config, CI — are unowned **by design**, so a path-scoped worker
cannot edit them. Every one is an escalation.

That is not waste: those escalations are the harness asking permission, and they
are not reducible by a better worker. What *is* reducible is **when they
surface**. Discovered mid-milestone, each one interrupts a running milestone to
serialize through you. Enumerated now, they become one planned batch — normally
an M0 "shared surfaces" milestone that runs before anything depends on it.

Record them in the approval summary as foreseen escalations. **Do not widen an
area's globs to absorb them.**

### 4d. Contradiction checks

- **Frozen vs edit.** No two assertions may constrain the same path in opposite
  directions — one asserting it is unchanged ("empty diff", "byte-identical")
  while another assertion or procedure mandates editing a file under it. Reframe
  the frozen one to an "allowed-delta" form now. Discovered mid-run it costs a
  re-ruling and a stalled milestone.
- **Global scope vs path scope.** An assertion quantified over the whole
  repository ("no X ANYWHERE", "EVERY route", "ALL user-facing copy") **must not**
  be bound to a single path-scoped feature. A path-scoped worker structurally
  cannot satisfy a repo-global claim, and the shortfall appears only at validation
  as reactive cross-area escalations. Resolve it to one of: (a) pre-enumerate
  every owning area in the procedure and pre-stage the escalation, (b) make the
  sweep an orchestrator-owned serial escalation from the start, or (c) split it
  into per-area assertions.

### 4e. Escalation safety — is it safe to run this NOW?

Before scheduling a shared-surface escalation as in-milestone "run now" work,
grep the deployment facts it depends on and record them in the escalation's
`reason`:

- Is the target column/field **non-nullable and still written by live code**?
- Does another owned, in-flight change already own this file?
- Does the migrating surface actually **send** the legacy value today, or is it
  dead code on the primary path?

If any hold, the escalation is **unsafe to run now**. Split the milestone so the
consumer ships against the *existing* shared contract, and record the schema leg
as descoped with a concrete follow-up. Never plan a non-nullable mutation or a
shared-contract flip underneath live writers.

### 4f. Do not bundle speculative work with shippable work

If a milestone's acceptance is a **hypothesis** — an "improves metric X" claim, a
statistical gate, a stress comparison — mark its assertion with a
`hypothesisGate` (see `docs/schemas.md`) and make sure it gates **nothing that
ships independently**. A falsified hypothesis is a legitimate NO-GO, not a bug;
if shippable features sit behind it, a NO-GO freezes work that had nothing wrong
with it.

---

## 5. Adversarial plan review

Steps 3-4 are a checklist of known failure shapes. They catch those
deterministically and cheaply. **They cannot generate the next one.** This step
can — it is the generative half of the gate, and the one time an adversarial
review ran on a real plan it reversed an approved plan that would have migrated a
non-nullable column underneath three live writers.

**Fire when ANY of these hold**; otherwise skip and record
`planReview: { required: false }`:

- **(a)** a shared-surface escalation (schema, shared kernel, public API);
- **(b)** a NEW area is being created;
- **(c)** an empirical or hypothesis gate;
- **(d)** speculative work grouped with independently shippable work;
- **(e)** a globally-quantified or mechanism-negating assertion;
- **(f)** ≥5 milestones or ≥60 assertions — partition risk scales with plan size,
  and this is also the point where you have the least context left to scrutinise
  the plan you just wrote.

**Spawn each reviewer as a real read-only agent in a FRESH context, in parallel.
Never role-play the roles yourself in one context.** Shared context means shared
blind spots: what you miss as the skeptic you will miss again as the guardian,
and the review comes back fast and clean for entirely the wrong reason. This is
the same independence the harness buys for validators.

Give them the draft contract and milestones. Roles:

- **Skeptic** — for each assertion, name a way it PASSES WHILE THE FEATURE IS
  BROKEN.
- **Constraint guardian** — hunt asserted-but-unverified premises, and blast
  radius outside the milestone.
- **Spec-consistency reviewer** — read the spec and its decision log against the
  contract: assertions that contradict their own design, decisions with no
  assertion, invented scope.
- **Integrator (you)** — contradictions between assertions, and scope owned by no
  feature.

**Brief every reviewer to read each assertion's `note` before reporting it.** A
well-authored contract answers the obvious objection in the note — verified call
sites, cited line numbers, owner rulings — and a finding the note already refutes
costs more than silence. **Require each reviewer to return what it KILLED as well
as what survived**, so the rejected set is recorded and a later reader does not
re-raise it.

Expect most first-pass candidates to die that way. The ones that survive are
typically *cross-assertion contradictions*, which no single-assertion rule above
can see.

**Apply every accepted objection to the contract before step 6.** This gate
exists to change the plan, not to annotate it. Record the reasoning into
`decisions[]` and stamp `planReview: { required, ran, triggers, objections,
applied }`. "All objections rejected" is a legitimate outcome — say why.

---

## 6. Render the approval summary and BLOCK

Produce a human-readable markdown summary in your reply, not just JSON:

- the milestone breakdown,
- the assertion count per area,
- which areas will be edited, with their `pathGlobs`,
- **every escalation you foresee** (step 4c), named,
- the seats and models,
- if step 5 fired: which triggers, which objections you accepted, and **what each
  one changed in the plan**.

The human is approving the *reviewed* plan, so what the review moved is part of
what they are approving.

Then ask for an explicit **approve / approve and run on autopilot / revise**
decision and **stop**. Do not proceed to `run` without approval. If they want
changes, revise and re-render.

**On "approve and run on autopilot"** (`mission prompt autopilot` § 2), and only
on the human's own answer: write the record through the CLI,
`mission state <missionDir> set-field autopilot '{"enabled":true,"phase":"run-pending","approvedBy":"human","approvedAt":"<date -u>","brief":"…","branch":"…","dependsOn":[…],"owner":[…]}'`,
once per milestone folder when the plan is split for parallel milestones. Commit
the plan on its own branch, have that PR reviewed (it carries the record, and the
CLI cannot prove consent), land it, and start the run in a fresh context.

## Output

On approval: the contract and `mission-state.json` are written, and the first
milestone is selected. Under autopilot, the fresh run session takes it from here. **Spawn no workers here** — that is `run`.
