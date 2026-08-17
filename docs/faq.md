# FAQ

### Is this another agent framework?

No. There is no runtime, no scheduler, no provider SDK, no orchestration graph.
Contractor is a **protocol** — seats, artifacts, gates — plus a CLI that
implements the decisions a model should not be making by itself.

It composes with whatever you already use. The rules are importable if you want
to build your own runner.

### How is it different from CrewAI / AutoGen / LangGraph?

Those answer *how do I wire multiple agents together?* Contractor answers *how do
I know the result is correct?*

The distinctive parts are the ones about verification: a contract approved before
any code, a read-only seat that never saw the implementation, a deterministic gate
no seat can talk its way past, and a circuit breaker that stops instead of
retrying forever. You could implement Contractor's protocol on top of any of
those frameworks.

### Do I need a frontier model?

For workers, no — a mid-tier model implementing a well-specified feature inside a
bounded scope is the most tractable job in the system.

For the **orchestrator** and the **validator**, effectively yes. A weak plan is
not recoverable by strong workers: they will faithfully build the wrong thing and
the harness will correctly certify that they did. And a weak verifier does not
fail loudly, it agrees — which is worse than having no validator, because it
manufactures confidence.

See [models.md](models.md).

### Does it work with a model that has no tool use?

Yes, with you as the tool layer. `contractor prompt <seat>` prints each seat's
instructions; you paste, the model reasons, you run the commands. Slower, and the
protocol holds — because the CLI does every deterministic part. See
`adapters/generic/`.

### What if my codebase has no clean module boundaries?

Then the harness will mostly run serially, and that is a correct outcome rather
than a failure. Declare one or two coarse areas and let the conservative
partition serialize everything.

You still get the contract, the fresh-context validator, the integration gate,
and the circuit breaker — which is most of the value. What you lose is
parallelism, which was never the point.

Do **not** invent a partition the code does not have. Overlapping areas break the
disjointness proof that makes concurrent workers safe.

### Why can't areas cover the whole repository?

Because the paths that no area owns are exactly the ones a path-scoped worker
must not edit: shared kernels, schemas, generated registries, cross-cutting
handlers. Leaving them unowned forces them through the escalation path, where a
dedicated worker makes the change and a fresh validator reviews it.

Widening an area to absorb one is the most tempting way to break the harness.

### The escalations are annoying. Can I turn them off?

You can, by widening your areas. You will be trading a visible cost for an
invisible one.

On one large mission, most of the escalations were **structural** rather than
error — the harness asking permission to touch a shared surface, and not
reducible by a better worker. What *was* reducible was **when** they
surfaced. Enumerated at plan time they become one early batch; discovered
mid-milestone, each one interrupts a running milestone.

If escalations feel constant, enumerate them during planning rather than removing
the boundary that produces them.

### Two corrective rounds seems low.

It is empirical. A feature that fails validation twice is stuck — agents arguing
about the interpretation, or blindly re-editing the same test to force green — and
a third attempt reliably burns tokens without converging.

The cap is `policy.maxCorrectiveRounds` if you disagree. Note that the harness
already escalates the worker to a stronger model for the *final* round before the
breaker trips, which recovers a meaningful share of would-be human escalations.

### Why does the worker write its own handoff instead of returning it?

Context. Full handoffs returning through the orchestrator took a large share of a
worker-heavy session, and the object then passed through a second time as the
write that persisted it. Now the worker writes the file and returns ~1KB;
validators read the full object from disk, where it always lived.

The orchestrator's `_meta` merge into that file is also the **deterministic
proof** the worker's "I wrote it" claim was true.

### My mission's edit queue is empty but work definitely happened.

Expected, and handled — provided you armed with `contractor arm`, which probes
for it.

Most agent runtimes freeze their project directory at session boot. A mission
running in a different worktree resolves its flag and queue against the *boot*
worktree, so its own queue stays empty for the whole run while everything else
looks normal. The same thing happens under parallel workers, because the queue is
read-modify-write and races lose entries.

The queue is best-effort by design. Scope falls back to the handoffs (each names
its feature → area) plus the milestone's committed paths, which is always
available and always correct.

### Can I resume a mission in a different runtime?

Yes. The mission's entire state lives in its folder. Plan under Claude Code,
build under Codex, validate by hand — the artifacts are the interface.

### Does it work outside TypeScript?

The harness is language-agnostic: it routes paths and runs commands. The rule
engine is Node, but that is an implementation detail of the CLI.

The honest caveat is that the **adaptation prompt** has the most evidence behind
it on JavaScript/TypeScript monorepos. Reports from Go, Python, Rust and Ruby
codebases are the most useful contribution right now.

### What does it cost?

Substantially more than one agent doing the same work — you are paying for
validators, reviewers, and corrective rounds. In exchange you find out when the
work is wrong.

Two mitigations are built in: workers run on a mid tier by default, and the
expensive tier is spent on the *last* corrective round rather than the first.
`_meta.tokensSpent` and `budget.byMilestone` record where it actually went, so
you can tune on data rather than intuition.

### When should I NOT use this?

- **A one-file change.** The ceremony exceeds the work.
- **Exploratory prototyping.** A contract written before you know what you are
  building is a guess with extra steps. Explore first, then run a mission on what
  you decided.
- **You cannot give a validator a fresh context.** Then you are running one agent
  with extra steps, and the central mechanism is absent.
- **You will not read the approval summary.** The plan gate is the highest-value
  human moment in the whole protocol. Rubber-stamping it removes most of the
  value.
