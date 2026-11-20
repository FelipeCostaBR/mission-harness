# Cursor adapter

```bash
npm install -g mission-harness
cd your-project
mission init
mission install cursor
```

Writes `.cursor/rules/mission-harness.mdc`.

## The one thing Cursor makes you do by hand

Cursor has no subagent primitive, so **you** are the context boundary. That is
workable, and it is not optional:

- **Orchestrator** — one chat, for the whole mission.
- **Worker** — a new chat per feature. Paste `mission prompt seats/worker`
  plus the payload. Nothing else.
- **Validator** — a new chat per area, with **no history** from the worker's
  chat. Paste `mission prompt seats/validator` plus the contract slice and the
  changed paths.

Running the validator in the chat that wrote the code defeats the entire
protocol. It will agree with itself and produce a confident, worthless verdict.

## Edit routing

No hooks, so route explicitly after each worker:

```bash
mission route <the files it changed>
```

Or skip the queue — it is best-effort by design. Deriving scope from the handoffs
plus the milestone's committed paths is always available and always correct.

## Reorienting a long mission

When a chat gets long, start a new one and paste:

```bash
mission brief
```

That is the ≤6KB digest: position, per-assertion states, burned rounds, open
escalations, plus the decisions and constraints previous windows recorded and a
mechanically-derived list of what has already been built. Do **not** re-read the
mission's raw artifacts to reorient — that is precisely the cost the brief exists
to remove.
