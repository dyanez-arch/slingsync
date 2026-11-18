#!/bin/bash
# Package the Premiere panel as a .ccx (a zip of the plugin, manifest.json at its root),
# which Creative Cloud installs with a double-click. Output: dist/SlingSync-panel-<version>.ccx
# Left out: tests, the decoder's C source, notes. Kept: everything index.html loads.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/premiere-panel"
VER=$(/usr/bin/python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$SRC/manifest.json")
OUT="$HERE/dist/SlingSync-panel-$VER.ccx"
mkdir -p "$HERE/dist"
rm -f "$OUT"
cd "$SRC"
FILES=(manifest.json index.html index.js lab.js icons engine/core.js engine/run.js engine/media.js
       engine/uxp_platform.js wasm/ssdec.js wasm/ssdec.wasm)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "missing $f"; exit 1; }; done
# every <script src> in index.html must be packaged
for s in $(grep -o 'src="[^"]*\.js"' index.html | cut -d'"' -f2); do
  printf '%s\n' "${FILES[@]}" | grep -qx "$s" || { echo "index.html loads $s but it isn't packaged"; exit 1; }
done
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
for f in "${FILES[@]}"; do mkdir -p "$STAGE/$(dirname "$f")"; cp -R "$f" "$STAGE/$f"; done
cp "$HERE/LICENSE" "$STAGE/LICENSE.txt"                       # SlingSync: MIT
cp "$SRC/wasm/README.md" "$STAGE/wasm/FFMPEG-NOTICE.md"       # FFmpeg: LGPL notice and source
cd "$STAGE"
zip -qrX "$OUT" . -x "*.DS_Store"
echo "$OUT ($(du -h "$OUT" | cut -f1))"
