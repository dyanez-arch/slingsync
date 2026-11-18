# SlingSync panel for Premiere Pro 2027 (in development)

A panel inside Premiere Pro that syncs a shoot by sound and puts the synced sequence straight into the open project. It's the Premiere-native counterpart of the [SlingSync desktop app](../README.md). For how the two relate and why they're built differently, see [Desktop app and Premiere panel](../docs/desktop-app-and-premiere-panel.md).

Requires **Premiere Pro 2027 (27.0) or later** (Adobe's UXP plugin system).

## Status

| Step | What it does | Status |
|---|---|---|
| 1 | Import a SlingSync XML (pick a shoot folder or the XML) and check the sequence really appeared | Panel loads in Premiere 2027 ✅; import itself not yet tested |
| 2 | **Sync Shoot Folder…** through the desktop app (temporary bridge, see below) | Built (panel 0.2+, app 1.2.0b2); not yet tested in Premiere |
| 3 | **Panel engine:** syncing inside Premiere with no app needed | In progress (see below) |
| 4 | Sync from Premiere bins instead of folders | Planned |
| — | **About** (version, creator, GitHub, report a problem) | Added in 0.4, not yet tested in Premiere |

### Panel engine (step 3)

The panel will run its own copy of the sync engine: the Python engine rewritten in JavaScript, with FFmpeg compiled to WebAssembly for reading files ([`wasm/`](wasm/README.md)). Feasibility tests run in Premiere Pro 2027 on 2026-11-18 (the **Developer tests** section of the panel):

| Test | Result |
|---|---|
| Read a recorder WAV directly | ✅ 3.8 h of audio (2 GB) in 17.5 s |
| Convert a clip with Media Encoder | ✅ works but slow (3 min clip in 79 s): only a last-resort fallback |
| JavaScript speed (spectrogram) | ✅ about 5 s per hour of audio |
| Built-in audio decoder (Web Audio) | ❌ not available in UXP |
| WebAssembly | ✅ works (synchronous loading; asynchronous loading hung) |

Next: wire the decoder into the panel, port the analysis, matching, placement and XML, and check results against the desktop app on real shoots.

## Try it (development install)

1. Install **Adobe UXP Developer Tool** from the Creative Cloud app (*Apps → search "UXP Developer Tool"*).
2. In Premiere: **Settings → Plugins → Enable developer mode**, then restart Premiere and open a project.
3. In UXP Developer Tool: **Add Plugin** → choose `premiere-panel/manifest.json` from this repository → in its row, click **⋯ → Load**. After changes, use **⋯ → Reload**.
4. In Premiere: **Window → UXP Plugins → SlingSync**.
5. Until the panel engine is ready, **Sync Shoot Folder…** needs the SlingSync desktop app **1.2.0b2 or later** in Applications. The first time, macOS asks whether Premiere may open SlingSync: allow it. For a folder already synced, use **Import from Shoot Folder…**.

If UXP Developer Tool says *"No applications are connected to the service"*, developer mode isn't on yet (step 2), or Premiere isn't open.

## Files

- `manifest.json`: plugin id, version, Premiere 27.0+, permissions (read files, open `slingsync://` and web links).
- `index.html`, `index.js`: the panel. Uses `premierepro` (`Project.getActiveProject`, `importFiles`, `getSequences`), `uxp.storage.localFileSystem`, `uxp.shell`.
- `lab.js`: temporary feasibility tests; removed once the panel engine works.
- `wasm/`: FFmpeg audio decoder for the panel engine.
- `icons/`: generated from `slingsync/resources/icon.png`.

## The temporary bridge to the desktop app

UXP panels can't run programs, but they can open a link with the user's permission. So for now:

1. The desktop app registers the `slingsync://` link type (`CFBundleURLTypes` in `SlingSync.spec`).
2. The panel opens `slingsync://sync?folder=<path>&id=<request id>&audio=0|1`. macOS launches the app, which syncs the folder with default options.
3. The app writes `<folder>/.slingsync_status.json` as it goes: `{id, state: scanning|syncing|done|error|cancelled, progress, message, xml, report, stems, synced, files, check}`.
4. The panel reads that file every 0.7 s, shows progress, and on `done` imports the XML and checks the sequence appeared. No answer within 60 s → it says to install the app.

This bridge is removed when the panel engine is ready.
