# Schemas

Every artifact a mission reads or writes. These are the contract between seats,
so they matter more than the prose around them.

---

## `validation-contract.json`

Written in the plan phase, **approved by a human before any code**.

```jsonc
{
  "spec": "<missionDir>/",
  "assertions": [
    {
      "id": "A-001",
      "statement": "A free-tier request to the prescriptive endpoint is rejected with 403",
      "areas": ["billing", "auth"],
      "verificationMethod": "unit",   // unit | static | boundary | live
      "note": "Verified at plan time: the route exists at src/api/plan.ts:14 and is currently unguarded (grep 2026-01-04).",
      "status": "pending",            // pending | passing | failing | hypothesis-failed

      // --- `live` only, all optional ---
      "liveArea": "checkout",         // a key in config.liveGate.areas
      "requires": { "environment": "staging" },
      "expectSignals": [{ "name": "checkout_completed", "min": 1 }],

      // --- optional: the pass depends on a step OUTSIDE the mission ---
      // The validator verifies the MECHANISM and records `pass` with an explicit
      // deferred-outcome note. The numeric outcome is an operator gate recorded
      // back into boundaryNotes once that step actually runs.
      "operatorOutcome": { "step": "run the backfill against production", "gates": "M3" },

      // --- optional: an empirical gate over an UNPROVEN design ---
      // A FAIL here is a legitimate NO-GO, not a code defect. No sharpened
      // procedure fixes a falsified hypothesis, so it must NOT open a corrective
      // round. It is non-blocking for the other assertions (they still earn real
      // verdicts) but it bars `done` and halts the milestone CLEAN — no debug
      // branch, no round burned. Distinct from a circuit break.
      "hypothesisGate": { "onNoGo": "halt-clean", "safeState": "flag stays OFF" }
    }
  ]
}
```

### `verificationMethod`

| Method | What the validator does |
| --- | --- |
| `unit` | Runs the tests. Confirms they exist, **exercise the claim**, and pass. |
| `static` | Greps/reads the code and cites `file:line`. |
| `boundary` | Confirms the worker stayed inside `pathGlobs`, plus import-boundary linting. |
| `live` | Runs the configured live gate. `0` → pass, the skip code → `skipped`, else `fail`. Never a false pass; never a fail on missing infrastructure. |

### Default assertions

The orchestrator auto-adds these to every area slice, on top of the
spec-specific ones:

- the area's documentation reflects the change;
- no boundary violations;
- every entry in the config's `constraints` is honoured in the changed code;
- **enforced-bound wording** — an assertion about a runtime bound (a concurrency
  cap, a page size, a rate limit) uses the verb "enforced" and names the proving
  test, never "stated"/"declared"/"documented". A named-but-unused constant
  satisfies "stated" while the bound is a complete no-op;
- **fixture-builder coverage** — where an assertion covers a deterministic replay
  over committed fixtures, at least one test must build a fixture by running the
  production builder over representative *input* shapes. A golden hand-authored
  in the *output* shape cannot catch a defect in the builder that produced it.

---

## `mission-state.json`

The broadcast channel and the resume substrate.

```jsonc
{
  "mission": "<missionDir>/",
  "missionStatus": "active",          // active | halted | gated | done

  // `order` and `status` are REQUIRED. resumePlan degrades gracefully without
  // them (declaration index; "pending") and reports degraded:true, but new
  // missions must write both.
  "milestones": [
    { "id": "M1", "order": 1, "status": "pending",
      "features": ["F-export"], "assertions": ["A-001"],
      "surface": "service", "designSpecPath": null }
  ],
  "currentMilestone": "M1",
  "assertionStatus": { "A-001": "pending" },
  "featureAreas": { "F-export": { "area": "billing", "isEscalation": false } },
  "activeWorker": null,

  "correctiveRounds": { "M1": 0 },
  // roundLog disambiguates what the counter conflates. decideSelfHeal still
  // reads ONLY correctiveRounds — which is exactly why a round logged but not
  // counted disarms the breaker AND the seat escalation, silently.
  "roundLog": [
    { "milestone": "M1", "round": 1, "type": "corrective",
      "trigger": ["A-001"], "at": "2026-01-04T10:00:00Z", "seat": "standard" }
  ],
  "adversarialRounds": { "M1": 1 },   // own counter, NOT drawn from the cap

  "globalConstraints": ["…"],
  "procedures": { "F-export": "Covers A-001. Run the migration check after schema edits; …" },

  "escalations": [
    { "id": "E-add-kind", "milestone": "M1",
      "reason": "new enum value requires the schema + migration + mapping",
      "files": ["db/schema.prisma", "db/migrations/…"],
      "implementedBy": "escalation-worker",   // ← the fresh-validator trigger keys on this
      "verifiedBy": [{ "cmd": "grep KIND db/schema.prisma", "exitCode": 0 }],
      "status": "verified" }
  ],

  "integrationGate": {
    "passed": true,
    "commands": [{ "cmd": "npm run typecheck", "exitCode": 0, "log": "/tmp/gate-1.log" }],
    "scope": "M1", "ts": "…"
  },

  // Probed at arm time. "unavailable-worktree" means the edit queue is dead by
  // construction for this run, so scope comes from handoffs ∪ commits — and an
  // empty queue is NOT a finding.
  "queueSubstrate": { "status": "live", "scopeSource": "hook-queue", "ts": "…" },
  // Set when a milestone ran a parallel batch: the queue is RMW-unsafe under
  // concurrency, so scope comes from the handoffs. Cleared after validation.
  "scopeOverride": { "milestone": "M1", "areas": ["billing", "auth"], "source": "parallel-handoffs" },

  // --- checkpoint knowledge: what a RESET window inherits beyond position ---
  // Without this the brief is a bookmark, not a handoff: a fresh session learns
  // WHERE it is and then re-derives WHAT it knew by re-reading source.
  "decisions": [
    { "milestone": "M1", "decision": "scaling stays in the read model",
      "why": "stored values are as-sent; rescaling at write double-applies" }
  ],
  "constraints": [
    { "milestone": "M1", "constraint": "the seed script never writes totals",
      "impact": "a blank total on the test account is NOT a regression" }
  ],

  "planReview": { "required": true, "ran": true, "triggers": ["a", "f"], "objections": 5, "applied": 3 },
  "milestoneReviews": { "M1": { "required": true, "ran": true, "findings": 2, "applied": 2 } },
  "simplifyPasses": { "M1": ["billing", "auth"] },
  "missionFinalReview": { "ran": true, "findings": 0, "ts": "…" },

  "budget": { "total": null, "byMilestone": { "M1": 41200 } },
  "followUps": ["REQUIRED: run the staging checkout flow before release"],
  "boundaryNotes": { "M1": "queue drift observed; scope derived from commits" },
  "contextReset": { "requested": false, "atPercent": 62, "milestone": "M1" },
  "seats": { "orchestrator": "frontier", "worker": "standard", "validator": "frontier" }
}
```

### `contextReset` is owned by the watcher, on both edges

If your runtime has a context watcher, it sets `requested: true` when the window
crosses a threshold and clears it **only** when context actually drops back under
— which is the sole honest proof a reset happened.

The orchestrator **acts** on the flag at a milestone boundary and must never
clear it. An orchestrator that clears its own reset flag is discharging a signal
it cannot verify was acted on; the observed result is a session running on for
hundreds of thousands of tokens while the state file claims nothing was needed.

Do not park unrelated notes in this object. Those belong in `boundaryNotes` or
`decisions[]`.

---

## Worker handoff — `handoffs/<feature-id>.json`

Written by the **worker itself**, as its last action.

```jsonc
{
  "feature": "F-export",
  "completed": ["added src/billing/export.ts", "extended test/billing/export.test.ts"],
  "incomplete": ["…"],
  "escalations": [{ "files": ["db/schema.prisma"], "reason": "…", "additiveOnly": true }],
  "commandsRun": [{ "cmd": "npm test -- test/billing", "exitCode": 0 }],
  "issues": ["…"],
  "proceduresFollowed": true,
  "assertionsCovered": ["A-001"],

  // Orchestrator-INJECTED telemetry, never part of the schema forced on the
  // worker: a worker cannot know its own spend, so a worker-claimed number is
  // fiction. "exact" = a serial worker's measured delta. "batch" = one delta
  // measured around a whole parallel batch, written to every member — an
  // aggregate UPPER BOUND, never presented as one worker's truth.
  "_meta": { "tokensSpent": 41200, "attribution": "exact", "ts": "…" }
}
```

**Be specific in `completed[]`.** The mission's artifact trail is derived
mechanically from this text by regex, precisely because artifact-trail fidelity
is the weakest dimension of every summarizer — and it is exactly what a fresh
context cannot cheaply re-derive.

---

## Worker return — the digest

What the worker RETURNS (~1KB), as opposed to what it writes (the full object).
`HANDOFF_DIGEST_SCHEMA` in `mission-harness` is the machine-readable version.

```jsonc
{
  "feature": "F-export",
  "handoffPath": "<missionDir>/handoffs/F-export.json",
  "handoffWritten": true,             // the worker's CLAIM; the _meta merge is the proof
  "status": "complete",               // complete | incomplete | escalated
  "assertionsCovered": ["A-001"],
  "escalations": [{ "files": ["…"], "reason": "…", "additiveOnly": false }],
  "incomplete": ["clipped"], "incompleteCount": 2,
  "issues": ["clipped"], "issuesCount": 3,
  "commandsRunCount": 4,
  "commandsFailed": [{ "cmd": "npm run lint", "exitCode": 1 }],
  "proceduresFollowed": true
}
```

Escalation file lists are carried **in full**, because the escalation routing rule
consumes them directly — truncating them would silently change the routing
decision.

---

## Validator verdict — `verdicts/<name>.json`

Persisted **byte-for-byte** before any value is read from it.

```jsonc
{
  "area": "billing",
  "verdicts": [
    { "id": "A-001", "verdict": "pass",       // pass | fail | inconclusive
      "evidence": "npm test -- test/billing exit 0",
      "notes": "" }
  ],

  // HARD BLOCKERS. Not notes.
  "boundaryViolations": [],
  "missingDefaults": [],

  // Pre-existing, non-blocking observations worth recording. These NEVER block.
  // A validator must NOT put a pre-existing item in boundaryViolations[] to force
  // a human override — that is the judgement escape hatch this schema removes.
  "informational": [{ "detail": "…", "preExisting": true }],

  // Tests that EXIST and PASS but do not exercise the claim. A `pass` plus a gap
  // means "works as far as I can tell, but a regression would not be caught."
  "testGaps": [
    { "id": "A-001",
      "kind": "mocked-boundary",   // mocked-boundary | impl-mirroring | missing-edge-cases | not-run
      "detail": "the ordering clause is inside a mocked query; the unit asserts the mock",
      "suggestedFix": "extract the comparator to a pure fn and unit-test it; add a guarded integration test",
      "resolution": "OPEN" }       // CLOSED | ACCEPTED | DEFERRED-TO-<milestone>. Never OPEN at advance.
  ],

  // UI validator only
  "designCompliance": {
    "subjectiveMatch": "inconclusive",
    "unverifiedPrinciples": ["transition timing", "reduced-motion behaviour"],
    "blockingRuleViolations": [],
    "unimplementedMandates": []
  }
}
```

---

## Edit queue — `.pending-validation.json`

```jsonc
{
  "pending": [
    { "area": "billing", "path": "src/billing/export.ts",
      "mission": "<missionDir>/", "session": "<agent session id>", "ts": "…" }
  ]
}
```

The `mission` and `session` stamps make drain-time exclusion of foreign entries
**mechanical**. A second agent session working in the same tree writes entries
indistinguishable from yours without them, and excluding those by eye is exactly
the judgement call that gets skipped under pressure.

**This queue is never the sole source of validation scope.** See
`docs/invariants.md`.

---

## Assertion states

| State | Blocks advance? | Bars `done`? | Meaning |
| --- | --- | --- | --- |
| `passing` | no | no | A verdict literally says so. |
| `failing` | **yes** | yes | A verdict says fail, or a hard blocker fired. |
| `pending` | **yes** | yes | Never validated. Never assume this is passing. |
| `inconclusive` | **yes** | yes | The validator could not determine it. |
| `skipped` / `gate-unverified` / `inconclusive-no-runner` | no | **yes** | No runner available. A SKIP, not a regression — a headless run advances rather than stalling, but the mission is `gated`. |
| `hypothesis-failed` | no | **yes** | An empirical gate returned NO-GO. Halt clean; do not open a corrective round. |
