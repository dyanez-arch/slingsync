#!/usr/bin/env bash
# Builds dist/SlingSync.app and a .dmg installer. Run on a Mac from the repo root:
#   bash scripts/build_mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."

python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt pyinstaller

# App icon (.icns) from slingsync/resources/icon.png
rm -rf build/icon.iconset && mkdir -p build/icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s slingsync/resources/icon.png --out "build/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) slingsync/resources/icon.png --out "build/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns build/icon.iconset -o build/SlingSync.icns

# Build stamp shown in About and in reports: exact code revision and date
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
echo "BUILD = \"build ${SHA}, $(date -u +%Y-%m-%d)\"" > slingsync/_build.py

# App bundle
python3 -m PyInstaller --noconfirm --clean SlingSync.spec

# Ad-hoc signature so Apple Silicon Macs will launch it (not notarised)
codesign --force --deep --sign - dist/SlingSync.app

# Disk image with a shortcut to Applications
VERSION=$(python3 -c "import slingsync; print(slingsync.__version__)")
ARCH=$(uname -m)
[ "$ARCH" = "arm64" ] && LABEL="AppleSilicon" || LABEL="Intel"
rm -rf build/dmg && mkdir -p build/dmg
cp -R dist/SlingSync.app build/dmg/
ln -s /Applications build/dmg/Applications
DMG="dist/SlingSync-${VERSION}-macOS-${LABEL}.dmg"
# hdiutil sometimes fails with "Resource busy" on build machines (Spotlight/XProtect still
# looking at the new app): wait and retry.
for attempt in 1 2 3 4 5; do
  if hdiutil create -volname "SlingSync" -srcfolder build/dmg -ov -format UDZO "$DMG"; then break; fi
  [ "$attempt" = 5 ] && { echo "hdiutil failed 5 times"; exit 1; }
  echo "hdiutil failed (attempt $attempt), retrying in 10 s..."
  sleep 10
done
echo "Built $DMG"
