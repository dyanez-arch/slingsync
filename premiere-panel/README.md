# SlingSync panel for Premiere Pro 2027 (prototype)

A panel inside Premiere Pro that brings SlingSync results straight into the open project. It's a **work in progress**, built and tested one step at a time:

| Step | What it does | Status |
|---|---|---|
| 1 | Import a SlingSync XML (pick a shoot folder or the XML) into the open project, and check that the sequence really appeared | Panel loads in Premiere 2027 ✅; import itself not yet tested |
| 2 | **Sync Shoot Folder…**: pick a folder, the SlingSync app syncs it, the panel shows progress and imports the sequence | Built (panel 0.2 + app 1.2.0b2); app side tested offscreen, not yet in Premiere |
| 3 | Sync from Premiere bins instead of folders | Planned |

**Direction (2026-11-17):** the panel should work on its own, without the SlingSync app, by running a JavaScript version of the sync engine inside Premiere. The standalone app stays for people without Premiere. Panel 0.3 adds temporary **Developer tests** to check this is feasible in Premiere: reading WAV files directly, converting other formats' audio with Media Encoder (`EncoderManager.encodeFile` with Premiere's `WAV_Mono_16bit_16kHz.epr` preset), and JavaScript speed for the analysis. Steps 2 and 3 will be rebuilt on the JavaScript engine.

Requires **Premiere Pro 2027 (27.0) or later**. It uses Adobe's UXP plugin system, which replaces CEP. The SlingSync app does the actual syncing, so the panel stays small.

## Try it (development install)

1. Install **Adobe UXP Developer Tool** from the Creative Cloud app (*Apps → search "UXP Developer Tool"*).
2. Open Premiere Pro 2027 with a project.
3. In UXP Developer Tool: **Add Plugin** → choose `premiere-panel/manifest.json` from this repository → in its row, click **⋯ → Load**.
4. In Premiere: **Window → UXP Plugins → SlingSync** (or **Window → Extensions**, depending on version).
5. Install the SlingSync app **1.2.0b2 or later** in Applications (earlier versions don't accept requests from the panel).
6. In the panel, click **Sync Shoot Folder…** and pick a shoot folder. The first time, macOS asks whether Premiere may open SlingSync: allow it (you can tell it to remember). The SlingSync app opens and syncs; the panel shows progress, then imports the synced sequence into the project.
7. For a folder already synced, use **Import from Shoot Folder…** instead.

If UXP Developer Tool says *"No applications are connected to the service"*: in Premiere, **Settings → Plugins → Enable developer mode**, restart Premiere, and keep it open (with a project) while you click **Load**.

## Files

- `manifest.json`: plugin id, Premiere 27.0+, panel size, permission to read files the user picks.
- `index.html`, `index.js`: the panel. Uses `premierepro` (`Project.getActiveProject`, `importFiles`, `getSequences`) and `uxp.storage.localFileSystem`.
- `icons/`: generated from `slingsync/resources/icon.png`.

## How the panel starts a sync

UXP panels can't run programs directly, but they can open a link with the user's permission (Adobe's [Launch External Processes](https://developer.adobe.com/premiere-pro/uxp/resources/recipes/external-process) recipe). So:

1. The SlingSync app registers the `slingsync://` link type (`CFBundleURLTypes` in `SlingSync.spec`).
2. The panel opens `slingsync://sync?folder=<path>&id=<request id>&audio=0|1` with `shell.openExternal` (manifest permission `launchProcess.schemes: ["slingsync"]`). macOS launches or activates the app, which loads the folder and syncs it with default options.
3. The app writes `<folder>/.slingsync_status.json` as it goes: `{id, state: scanning|syncing|done|error|cancelled, progress, message, xml, report, stems, synced, files, check}`.
4. The panel reads that file every 0.7 s (manifest `localFileSystem: fullAccess`), shows progress, and on `done` imports `xml` and checks the sequence appeared. If the app doesn't answer within 60 s, the panel says to install SlingSync 1.2.0b2 or later.
