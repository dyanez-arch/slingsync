# Desktop app and Premiere Pro plug-in

SlingSync comes in two forms. They do the same job (line up cameras and recorders by sound) and aim to give identical results, but they're built differently because they live in different places.

| | **SlingSync desktop app** | **SlingSync plug-in for Premiere Pro** |
|---|---|---|
| What it is | A standalone Mac app (also a command-line tool) | A plug-in inside Premiere Pro (**Window → UXP Plugins → SlingSync**) |
| Who it's for | Anyone: Premiere editors, other NLEs that read FCP7 XML, podcasters and audio editors (audio-only export) | Premiere Pro 2027+ editors who want to sync without leaving Premiere |
| Needs Premiere? | No | Yes, Premiere Pro 2027 (27.0) or later |
| Result | `…_synced.xml` you import, a report, optional aligned WAVs | The synced sequence appears directly in the open project |
| Status | **Released** (v1.2.2), tested on real shoots | **Working prototype** (0.14): syncs inside Premiere on its own; installs from a `.ccx` |
| Code | [`slingsync/`](../slingsync) (Python) | [`premiere-plugin/`](../premiere-plugin) (JavaScript + WebAssembly) |
| Download | [Releases](https://github.com/dyanez-arch/slingsync/releases) page (`.dmg`) | `.ccx` file next to the DMG in builds and releases: double-click to install |

## Why two different builds?

**The desktop app** is written in Python and uses FFmpeg (through PyAV) to read any video or audio file. That makes it fast to develop and lets it open almost every camera and recorder format. It's packaged as a normal Mac app.

**Premiere Pro plug-ins can't run that app's code.** Premiere 2027 plugins use Adobe's UXP system, which only runs **JavaScript** (plus WebAssembly) inside Premiere. Plug-ins can also include native compiled code, but on macOS that has to be signed and notarised with a paid Apple Developer ID ($99/year). To keep SlingSync free, the plug-in doesn't use native code. Instead:

- The sync engine (silence detection, fingerprints, matching, placement, XML, report, audio files) has been **rewritten in JavaScript** ([`premiere-plugin/engine/`](../premiere-plugin/engine)). It's checked against the Python engine on the same real shoots: the XML files come out byte-for-byte identical.
- File reading uses **the same FFmpeg version as the app (7.1.1)**, audio parts only, compiled to WebAssembly ([`premiere-plugin/wasm/`](../premiere-plugin/wasm/README.md)). The plug-in opens the same formats as the app and reads the same timecode and dates.

## How they relate

- **One engine design, two implementations.** The Python engine in `slingsync/engine.py` is the reference. The JavaScript engine in the plug-in is a port of it. When the sync logic changes, both are updated, and the plug-in is re-checked against the app.
- **Same output.** Both write the same FCP7 XML, `SlingSync_report.txt` and aligned WAVs into the shoot folder. A folder synced by either can be imported with either.
- **Independent.** The plug-in doesn't need the app installed, and the app never needs Premiere.
- **Shared analysis folder.** Both keep their saved analysis in the shoot's hidden `.slingsync_cache` folder, with separate file names, so they never get in each other's way.

### What each one can do

| | Desktop app | Premiere Pro plug-in |
|---|---|---|
| Sync a shoot folder by sound → XML + report | ✅ | ✅ and imports the sequence into the open project |
| Export aligned audio files (WAV per microphone) | ✅ | ✅ |
| Compact timeline (cut out every stretch where nothing records) | ✅ as a second XML (`…_compact.xml`) | ✅ on **any open sequence**: makes a "(compact)" copy |
| Sync clips already in a Premiere project (from a bin) | No | ✅ *Sync Selected Bin* (0.16.0) |
| Import a folder that was synced before | (File → Import in Premiere) | ✅ *Import a synced folder* |
| Clips sorted into a bin per device in the Project panel | No (Premiere puts them in one bin) | ✅ (0.15.0) |
| Per-device "Sync using" channel, frame-rate choice, silent-channel options | ✅ | ✅ (0.13.0: device list and Options before syncing) |
| Analyses several files at once | ✅ (faster on fast drives) | One at a time |

### Checked so far (see the [testing log](testing.md))

- Kishorn (111 clips, 5 devices, proxies), Mark Borthwick (loose files, 2 cameras + recorder), synthetic project: XML **byte-identical** to the app's, reports identical apart from the version line.
- The plug-in synced Kishorn and Borthwick inside Premiere Pro 2027, and compacted Devon Night 2 (181 clips, 135 → 60 min).
- Decoding: identical to the app on 21 files covering MXF, MP4/MOV, WAV, AIFF, MP3, AAC/M4A, FLAC, Opus, AC-3.

## Which should I use?

- **Edit in Premiere Pro 2027 or later?** The plug-in (install the `.ccx`). The desktop app is still there for anything the plug-in doesn't do yet.
- **Older Premiere, another editor, or audio only?** Use the desktop app.
