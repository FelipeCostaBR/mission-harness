# Diagrams

Source HTML plus the exported PNGs used in the project README.

| File | What it shows |
| --- | --- |
| `mission-loop.html` / `.png` | The mission loop — six stations clockwise, writing back to one artifact store. Light. |
| `mission-loop-dark.html` / `.png` | The same geometry under the dark token inversion. |

The README serves them through a `<picture>` element keyed on
`prefers-color-scheme`, so the diagram matches the reader's GitHub theme.

## Why a loop and not a flowchart

The loop is the honest shape. Contractor's phases run in a cycle — the milestone
boundary feeds straight back into scoping the next one — and each phase writes
durable state into a store that outlives any single context window. The dashed
write-back spokes are the defining signal: remove them and the figure is just a
circular process, which would misrepresent how the harness actually works.

The three-way exit (advance / corrective / circuit-break) is deliberately *not*
in this diagram. It is a branch, not a station, and forcing it into the ring
would break the type. The README's text flow covers it instead.

## Provenance

Built with the [diagram-design](https://github.com/cathrynlavery/diagram-design)
skill (MIT), using its Loop type at the default editorial skin. The ring-arc and
spoke geometry is the type's parametric contract at `N=6`, `R=240`, `C=(520,340)`
— identical inputs produce identical geometry, so the layout is reproducible
rather than hand-nudged.

Verified with the skill's own checkers before export:

```bash
python3 <skill>/scripts/self_check.py mission-loop.html      # accessible-SVG contract
python3 <skill>/scripts/verify-geometry.py mission-loop.html # label-mask overlap
```

## Regenerating the PNGs

```bash
./export.sh mission-loop.html 2        # 2× → 2080×1360
./export.sh mission-loop-dark.html 2
```

`export.sh` uses headless Chrome rather than Playwright, because Chrome is
already present on most machines and needs no install step.

Two things it does that a naive screenshot does not:

- **It carries the page `<style>` block into the export shell.** The diagram's
  visual grammar lives in CSS classes (`.station`, `.ring`, `.node-name`), not
  inline on the SVG nodes. Extracting the `<svg>` alone renders every box solid
  black, because each fill silently falls back to the SVG default.
- **It waits on `--virtual-time-budget` rather than a sleep**, so the webfonts
  have actually landed before the capture. A fixed delay races them and
  intermittently exports the fallback serif.

The PNG size is the `viewBox` times the scale factor, so pass `3` for print and
`1` for a compact inline asset.

## Editing

Edit the light HTML, then regenerate the dark variant by token swap rather than
by hand — the two must stay geometrically identical. The swap is the inversion
table in the skill's `type-loop.md` §5: paper↔ink, muted/soft to their dark
equivalents, accent hue-shifted brighter, and the `<title>`/`<desc>` ids
re-prefixed per variant so two inlined SVGs can never resolve to each other's
accessible name.
