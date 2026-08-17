#!/usr/bin/env python3
"""Generate the dark variant of a diagram by token swap.

The two variants MUST stay geometrically identical — only the skin changes. Doing
that by hand drifts, so the inversion table from the diagram-design skill's
type-loop.md section 5 lives here instead:

    paper <-> ink, muted/soft to their dark equivalents, ink-at-opacity washes
    re-based on the light ink, and the accent hue-shifted brighter to read on
    dark paper.

Two details that are easy to get wrong:

  * The swap is a permutation, not a sequence of independent replaces. paper and
    ink trade places, so a naive ordered replace maps both onto the same colour.
    Every rule therefore lands on a placeholder first, and placeholders resolve
    in a second pass.

  * The accessible-SVG contract requires per-variant title/desc ids. Two inlined
    SVGs sharing bare ids would let one figure resolve to the other's accessible
    name, so the ids get a -dark suffix.

Usage:  ./make-dark.py architecture.html  ->  architecture-dark.html
"""

import re
import sys
from pathlib import Path

# (light, dark) — order is irrelevant because of the placeholder pass.
SWAPS = [
    # --- semantic tokens -------------------------------------------------
    ("#f5f5f5", "#2d3142"),  # paper
    ("#2d3142", "#f5f5f5"),  # ink
    ("#ffffff", "#393e53"),  # step lift -> paper-2 dark
    ("#4f5d75", "#bfc0c0"),  # muted
    ("#7a8399", "#8e98ac"),  # soft
    ("#eb6c36", "#f08a59"),  # accent
    ("#2e5aa8", "#6a95d8"),  # link
    ("rgba(235,108,54,0.08)", "rgba(240,138,89,0.10)"),  # accent-tint
    ("rgba(79,93,117,0.10)", "rgba(191,192,192,0.10)"),  # input wash
    # --- ink-at-opacity washes: same opacity, RGB inverted ---------------
    ("rgba(45,49,66,0.02)", "rgba(245,245,245,0.02)"),
    ("rgba(45,49,66,0.03)", "rgba(245,245,245,0.03)"),
    ("rgba(45,49,66,0.05)", "rgba(245,245,245,0.05)"),
    ("rgba(45,49,66,0.10)", "rgba(245,245,245,0.10)"),
    ("rgba(45,49,66,0.12)", "rgba(245,245,245,0.12)"),
    ("rgba(45,49,66,0.22)", "rgba(245,245,245,0.22)"),
    ("rgba(45,49,66,0.30)", "rgba(245,245,245,0.30)"),
    ("rgba(45,49,66,0.40)", "rgba(245,245,245,0.40)"),
]


def to_dark(src: str, slug: str) -> str:
    out = src
    # Pass 1: every light value -> a placeholder no source can contain.
    for i, (light, _) in enumerate(SWAPS):
        out = out.replace(light, f"\x00SWAP{i}\x00")
    # Pass 2: placeholders -> their dark values.
    for i, (_, dark) in enumerate(SWAPS):
        out = out.replace(f"\x00SWAP{i}\x00", dark)

    # Per-variant accessible ids.
    out = out.replace(f"{slug}-title", f"{slug}-dark-title")
    out = out.replace(f"{slug}-desc", f"{slug}-dark-desc")
    return out


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit("usage: make-dark.py <diagram.html>")
    src_path = Path(sys.argv[1])
    if src_path.stem.endswith("-dark"):
        sys.exit("refusing to darken an already-dark variant")

    src = src_path.read_text()
    slug = src_path.stem

    if f"{slug}-title" not in src:
        sys.exit(f"{src_path}: expected accessible ids prefixed '{slug}-'")

    dark = to_dark(src, slug)
    out_path = src_path.with_name(f"{slug}-dark.html")
    out_path.write_text(dark)

    # A light hex surviving into the dark file usually means a hardcoded colour
    # bypassed the token layer. paper/ink legitimately appear as each other's
    # swapped role, so they are expected; anything else is a real leak.
    leaked = sorted(set(re.findall(r"#(?:ffffff|4f5d75|7a8399|eb6c36|2e5aa8)", dark)))
    if leaked:
        print(f"  warn: un-swapped light values remain: {', '.join(leaked)}")

    print(f"  wrote {out_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
