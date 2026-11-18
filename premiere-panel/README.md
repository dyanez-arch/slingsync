# SlingSync panel for Premiere Pro 2027 (prototype)

A panel inside Premiere Pro that brings SlingSync results straight into the open project. It's a **work in progress**, built and tested one step at a time:

| Step | What it does | Status |
|---|---|---|
| 1 | Import a SlingSync XML (pick a shoot folder or the XML) into the open project, and check that the sequence really appeared | Built, waiting for its first test in Premiere |
| 2 | Start a sync from the panel: it opens the SlingSync app, which syncs and reports back | Planned |
| 3 | Sync from Premiere bins instead of folders | Planned |

Requires **Premiere Pro 2027 (27.0) or later**. It uses Adobe's UXP plugin system, which replaces CEP. The SlingSync app does the actual syncing, so the panel stays small.

## Try it (development install)

1. Install **Adobe UXP Developer Tool** from the Creative Cloud app (*Apps → search "UXP Developer Tool"*).
2. Open Premiere Pro 2027 with a project.
3. In UXP Developer Tool: **Add Plugin** → choose `premiere-panel/manifest.json` from this repository → in its row, click **⋯ → Load**.
4. In Premiere: **Window → UXP Plugins → SlingSync** (or **Window → Extensions**, depending on version).
5. Sync a folder with the SlingSync app, then click **Import from Shoot Folder…** in the panel and pick that folder.

## Files

- `manifest.json`: plugin id, Premiere 27.0+, panel size, permission to read files the user picks.
- `index.html`, `index.js`: the panel. Uses `premierepro` (`Project.getActiveProject`, `importFiles`, `getSequences`) and `uxp.storage.localFileSystem`.
- `icons/`: generated from `slingsync/resources/icon.png`.

## How it will start syncs (step 2, planned)

UXP panels can't run programs directly. They can open a link with the user's permission, so the SlingSync app will register a `slingsync://` link. The panel opens `slingsync://sync?folder=…`, macOS launches the app with that folder, the app writes progress to a small status file in the project, and the panel shows it and imports the XML when done. See Adobe's [Launch External Processes](https://developer.adobe.com/premiere-pro/uxp/resources/recipes/external-process) recipe.
