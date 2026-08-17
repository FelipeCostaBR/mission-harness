#!/usr/bin/env bash
# Rasterize a diagram HTML to PNG at the exact viewBox size × a scale factor.
#
# The diagram sources are self-contained HTML with inline SVG. This extracts the
# <svg> node, frames it at its true viewBox dimensions with no page chrome, and
# screenshots it — so the PNG is the diagram, not a screenshot of a web page.
#
# Chrome is used rather than Playwright because it is already present on most
# machines; --virtual-time-budget is what waits for the webfonts to actually
# land, rather than guessing with a sleep.
#
#   ./export.sh mission-loop.html [scale]
set -euo pipefail

SRC="${1:?usage: export.sh <diagram.html> [scale]}"
SCALE="${2:-2}"
BASE="${SRC%.html}"
OUT="$BASE.png"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME" >&2; exit 1; }

read -r W H < <(python3 - "$SRC" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'viewBox="0 0 (\d+) (\d+)"', src)
if not m:
    sys.exit("no viewBox found")
print(m.group(1), m.group(2))
PY
)

SHELL_HTML="$(mktemp -t diagram-export-XXXX).html"
trap 'rm -f "$SHELL_HTML"' EXIT

python3 - "$SRC" "$SHELL_HTML" "$W" "$H" <<'PY'
import re, sys
src, out, w, h = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
html = open(src).read()

svg = re.search(r"<svg\b.*?</svg>", html, re.S)
if not svg:
    sys.exit("no <svg> block found")

# The diagram's visual grammar lives in the page <style> block as CSS classes
# (.station, .ring, .node-name, ...), NOT inline on the SVG nodes. Extracting the
# <svg> alone yields a black-box render: every fill falls back to the SVG default.
# So the stylesheet travels with it, and the frame override is appended AFTER so
# it wins on equal specificity.
styles = "\n".join(m.group(0) for m in re.finditer(r"<style\b.*?</style>", html, re.S))
if not styles:
    sys.exit("no <style> block found — refusing to export an unstyled diagram")

fonts = re.search(r'<link href="https://fonts\.googleapis\.com[^"]*"[^>]*>', html)

open(out, "w").write(f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">{fonts.group(0) if fonts else ""}
{styles}
<style>
  html, body {{ margin: 0; padding: 0; background: transparent;
                display: block; min-height: 0; }}
  svg {{ display: block; width: {w}px; height: {h}px; min-width: 0; }}
</style></head><body>{svg.group(0)}</body></html>""")
PY

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --hide-scrollbars \
  --force-device-scale-factor="$SCALE" \
  --window-size="$W,$H" \
  --virtual-time-budget=15000 \
  --screenshot="$OUT" \
  "file://$SHELL_HTML" >/dev/null 2>&1

[ -f "$OUT" ] || { echo "screenshot failed" >&2; exit 1; }
echo "$OUT  ($(python3 -c "print($W*$SCALE,'x',$H*$SCALE)"))  $(du -h "$OUT" | cut -f1)"
