# Diagrams

Source HTML plus the exported PNGs used in the project README. Each diagram ships
light and dark; the README serves them through a `<picture>` element keyed on
`prefers-color-scheme`, so they match the reader's GitHub theme.

| Diagram | Type | Answers |
| --- | --- | --- |
| `mission-loop` | Loop | How does a mission run over time? |
| `seats` | Swimlane | Who does what, and what can they *not* do? |
| `architecture` | Architecture | Why does the same harness run anywhere? |

Three diagrams because they are three different questions. Folding them into one
would blow the complexity budget and answer none of them well.

## What each one deliberately leaves out

**`mission-loop`** omits the three-way exit (advance / corrective /
circuit-break). That is a branch, not a station, and forcing it into the ring
would break the type. The swimlane covers it instead.

The loop is a loop rather than a flowchart because that is the honest shape: the
milestone boundary feeds straight back into scoping the next one, and every phase
writes durable state into a store that outlives any single context window. The
dashed write-back spokes are the defining signal — remove them and the figure is
a plain circular process, which would misrepresent the harness.

**`seats`** omits the escalation path and the simplify pass. Five lanes is the
type's hard limit and the creator/verifier handoff is the thesis; adding lanes
would bury it.

**`architecture`** omits the decision feedback edge from the CLI back to the
runtime. The loop diagram already carries the cycle, and drawing it here would
make a structural diagram argue two things at once.

## Provenance

Built with the [diagram-design](https://github.com/cathrynlavery/diagram-design)
skill (MIT) at its default editorial skin, using its Loop, Swimlane and
Architecture types.

The loop's ring-arc and spoke geometry is the type's parametric contract at
`N=6`, `R=240`, `C=(520,340)` — identical inputs produce identical geometry, so
the layout is reproducible rather than hand-nudged.

One deliberate divergence from the skill's own swimlane example: that example
routes lane handoffs as diagonal `<line>` elements, which the current mandatory
connector rules forbid. These use rounded right-angle elbows with `r=8` instead,
and enter a node's top or bottom port when the travel is mainly vertical.

Verified with the skill's own checkers before every export:

```bash
python3 <skill>/scripts/self_check.py <file>.html       # accessible-SVG contract
python3 <skill>/scripts/verify-geometry.py <file>.html  # label-mask overlap
```

## Regenerating

```bash
./make-dark.py architecture.html     # light -> dark, by token swap
./export.sh architecture.html 2      # -> architecture.png at 2x
./export.sh architecture-dark.html 2
```

### `make-dark.py`

Never hand-edit a dark variant. The two must stay geometrically identical, and
hand-editing drifts. The script applies the inversion table from the skill's
`type-loop.md` §5.

Two things it gets right that a naive script does not:

- **The swap is a permutation, not a sequence of replaces.** `paper` and `ink`
  trade places, so replacing them in order maps both onto the same colour. Every
  rule lands on a placeholder first and resolves in a second pass.
- **It re-prefixes the `<title>`/`<desc>` ids.** Two inlined SVGs sharing bare ids
  would let one figure resolve to the other's accessible name.

### `export.sh`

Rasterizes with headless Chrome rather than Playwright, because Chrome is already
present on most machines and needs no install step. The PNG's pixel size is the
`viewBox` times the scale factor — pass `3` for print, `1` for a compact inline
asset.

Two things it does that a naive screenshot does not:

- **It carries the page `<style>` block into the export shell.** The diagram's
  visual grammar lives in CSS classes (`.station`, `.step`, `.node`), not inline
  on the SVG nodes. Extracting the `<svg>` alone renders every box solid black,
  because each fill silently falls back to the SVG default. This is not
  hypothetical — it is what the first export of `mission-loop` produced.
- **It waits on `--virtual-time-budget` rather than a sleep**, so the webfonts
  have actually landed before capture. A fixed delay races them and
  intermittently exports the fallback serif.
