# SlingSync plug-in for Adobe Premiere Pro (2027 or later)

A plug-in inside Premiere Pro that syncs a shoot by sound and puts the synced sequence straight into the open project, **with no other app needed**. It's the Premiere-native counterpart of the [SlingSync desktop app](../README.md); for how the two relate and why they're built differently, see [Desktop app and Premiere Pro plug-in](../docs/desktop-app-and-premiere-plugin.md).

Requires **Premiere Pro 2027 (27.0) or later** (Adobe's UXP plugin system).

## What it does

- **Sync a Shoot…**: pick a shoot folder (one subfolder per camera or recorder, or loose files). The plug-in analyses the sound, lines everything up, writes `…_synced.xml` and `SlingSync_report.txt` into the folder (same files as the desktop app) and imports the sequence. Optional: **Also export audio files** (one aligned WAV per microphone).
- **Compact Timeline**: makes a copy of the **open sequence** ("… (compact)") with every stretch where no track has a clip cut out, so the day plays as one block for review or a transcript. Clips that overlap stay in sync; the original sequence is untouched.
- **Import a synced folder**: imports the sequence of a folder synced earlier (by the plug-in or the app).
- **Show details** after a sync: every file, match and placement (**Copy details** to paste it into a bug report).
- **About**: version, creator, GitHub, Ko-fi.

## Status

| Feature | Status |
|---|---|
| Sync inside Premiere, own engine | ✅ Works in Premiere 2027 (Kishorn, Borthwick, 2026-11-18). Results byte-identical to the desktop app |
| Compact Timeline | ✅ Works in Premiere 2027 (Devon Night 2: 181 clips, 135 → 60 min) |
| Audio-file export | Matches the app (tested in Node); not yet tested inside Premiere |
| Import a synced folder | Built; not yet tested in Premiere |
| Per-device "Sync using" channel, frame rate, silent-channel options | Not in the plug-in yet (uses the recommended defaults) |
| Sync from Premiere bins instead of folders | Planned |
| Packaging for normal installation (`.ccx`) | ✅ `scripts/package_plugin.sh`, also on GitHub builds; installs by double-click (tested 2026-11-18) |

Full results: [testing log](../docs/testing.md).

## Install

**From a test build or release (`SlingSync-PremierePro-plugin-<version>.ccx`):** double-click the `.ccx` file. Creative Cloud asks to install the plugin; since it isn't from Adobe's marketplace it warns that it's a third-party plugin: confirm. Then restart Premiere and open **Window → UXP Plugins → SlingSync**. *(Tested 2026-11-18: installs by double-click and works in Premiere 2027.)*

To remove it: Creative Cloud app → **Plugins** (or **Stock & Marketplace → Plugins**) → SlingSync → Uninstall.

**Build the package yourself:** `bash scripts/package_plugin.sh` → `dist/SlingSync-PremierePro-plugin-<version>.ccx` (about 1 MB). GitHub Actions does this on every build and attaches it to releases next to the app's DMG.

## Try it (development install)

1. Install **Adobe UXP Developer Tool** from the Creative Cloud app (*Apps → search "UXP Developer Tool"*).
2. In Premiere: **Settings → Plugins → Enable developer mode**, then restart Premiere and open a project.
3. In UXP Developer Tool: **Add Plugin** → choose `premiere-plugin/manifest.json` from this repository → in its row, **⋯ → Load**. After an update, **⋯ → Reload** (or Unload + Load if the plugin's permissions changed).
4. In Premiere: **Window → UXP Plugins → SlingSync**.

If UXP Developer Tool says *"No applications are connected to the service"*, developer mode isn't on yet (step 2), or Premiere isn't open.

## How it's built

| Path | |
|---|---|
| `manifest.json` | Plugin id, version, Premiere 27.0+, permissions (full file access, clipboard, opening web links) |
| `index.html`, `index.js` | The plug-in: buttons, progress, import, Compact Timeline, About |
| `engine/core.js` | The sync logic, a JavaScript port of `slingsync/engine.py`: dates, fingerprints, matching, refinement, placement, XML, report, compact timeline |
| `engine/run.js` | A whole sync step by step (scan, probe, analyse, match, place, write files, audio export); file access goes through a `platform` object |
| `engine/uxp_platform.js` | `platform` inside Premiere (UXP `fs`) |
| `engine/media.js` | Bridge to the decoder |
| `wasm/` | FFmpeg 7.1.1 (audio only) compiled to WebAssembly: reads every format the app reads ([details and license](wasm/README.md)) |
| `tests/` | Node test harness: `compare_decode.py`, `compare_sync.py` (plug-in engine vs desktop app on a real shoot), `run_sync.js`, `node_platform.js`; `lab_feasibility.js` (the in-Premiere feasibility tests from 2026-11-18, no longer loaded) |

### Things Premiere's plugin system needs (learned the hard way)

- **WebAssembly** must be loaded synchronously (`new WebAssembly.Module/Instance`); `WebAssembly.instantiate` never finishes.
- No `TextEncoder`/`TextDecoder`: the engine has its own UTF-8 helpers.
- **Editing a sequence** (Compact Timeline): actions must be created inside `project.lockedAccess(() => project.executeTransaction(…))`, and every script object (project, sequence, track item) must be fetched again after each edit; otherwise Premiere says *"The script object is no longer valid"*.
- `importFiles` may take long or report success before the import is done: the plug-in watches for the new sequence instead.
- Clipboard: `navigator.clipboard.setContent({"text/plain": …})`.

### Testing against the desktop app

```
brew install node emscripten          # once
bash scripts/build_plugin_wasm.sh      # only if wasm/ssdec.c or the FFmpeg build changes
.venv/bin/python premiere-plugin/tests/compare_decode.py FILE...
.venv/bin/python premiere-plugin/tests/compare_sync.py SHOOT_FOLDER OUTPUT_FOLDER
```

`compare_sync.py` syncs the shoot with both engines (all output goes to OUTPUT_FOLDER; nothing is written to the shoot) and compares the XML, compact XML and every clip's position and status. **Keep `core.js`/`run.js` in step with `engine.py`**: when the sync logic changes, change both and rerun this.
