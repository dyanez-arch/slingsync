# Desktop app and Premiere panel

SlingSync comes in two forms. They do the same job (line up cameras and recorders by sound) and aim to give identical results, but they're built differently because they live in different places.

| | **SlingSync desktop app** | **SlingSync panel for Premiere Pro** |
|---|---|---|
| What it is | A standalone Mac app (also a command-line tool) | A panel inside Premiere Pro (**Window → UXP Plugins → SlingSync**) |
| Who it's for | Anyone: Premiere editors, other NLEs that read FCP7 XML, podcasters and audio editors (audio-only export) | Premiere Pro 2027+ editors who want to sync without leaving Premiere |
| Needs Premiere? | No | Yes, Premiere Pro 2027 (27.0) or later |
| Result | `…_synced.xml` you import, a report, optional aligned WAVs | The synced sequence appears directly in the open project |
| Status | **Released** (v1.1.0), tested on real shoots | **In development** (prototype 0.4) |
| Code | [`slingsync/`](../slingsync) (Python) | [`premiere-panel/`](../premiere-panel) (JavaScript + WebAssembly) |
| Download | [Releases](https://github.com/dyanez-arch/slingsync/releases) page (`.dmg`) | Not packaged yet; developers can load it with Adobe's UXP Developer Tool |

## Why two different builds?

**The desktop app** is written in Python and uses FFmpeg (through PyAV) to read any video or audio file. That makes it fast to develop and lets it open almost every camera and recorder format. It's packaged as a normal Mac app.

**Premiere panels can't run that app's code.** Premiere 2027 plugins use Adobe's UXP system, which only runs **JavaScript** (plus WebAssembly) inside Premiere. Panels can also include native compiled code, but on macOS that has to be signed and notarised with a paid Apple Developer ID ($99/year). To keep SlingSync free, the panel doesn't use native code. Instead:

- The sync engine (silence detection, fingerprints, matching, placement, XML) is being **rewritten in JavaScript**. Each piece is checked against the Python engine on the same real shoots, so both give the same results.
- File reading uses **the same FFmpeg version as the app (7.1.1)**, audio parts only, compiled to WebAssembly ([`premiere-panel/wasm/`](../premiere-panel/wasm/README.md)). The panel opens the same formats as the app and reads the same timecode and dates.

## How they relate

- **One engine design, two implementations.** The Python engine in `slingsync/engine.py` is the reference. The JavaScript engine in the panel is a port of it. When the sync logic changes, both are updated, and the panel is re-checked against the app.
- **Same output.** Both write the same FCP7 XML, `SlingSync_report.txt` and aligned WAVs into the shoot folder. A folder synced by either can be imported with either.
- **Independent.** Once the JavaScript engine is finished, the panel won't need the app installed, and the app will never need Premiere.

### Today (panel prototype 0.4)

The JavaScript engine isn't finished yet. Until it is, the panel's **Sync Shoot Folder…** button asks the installed desktop app (1.2.0b2 or later) to do the sync, then imports the result. That bridge goes away when the panel engine is ready. See the [panel README](../premiere-panel/README.md) for the step-by-step status.

## Which should I use?

- **Edit in Premiere Pro 2027 or later?** Once the panel is released, use the panel. Until then, use the desktop app.
- **Older Premiere, another editor, or audio only?** Use the desktop app.
