# Changelog

Every build that reaches anyone gets its own version number and section here. Test builds are `1.2.0b1`, `1.2.0b2`… and the release is `1.2.0`. The Premiere Pro plug-in has its own version (in `premiere-plugin/manifest.json`), listed under each app version it ships with. See [versioning](docs/development.md#versioning). The app's **About** box and every report show the exact version and build.

What was tested with each build is in the [testing log](docs/testing.md).

## 1.2.1b1 (test build)

Includes the **Premiere Pro plug-in 0.12.0** (`SlingSync-PremierePro-plugin-0.12.0.ccx`), with the same device split as the app.

### Improved
- **A folder that groups several recorders or cameras is split into one device each** (app and plug-in): `Audio/Boom`, `Audio/Ed Lav`, `Audio/Matthew Lav` become three devices instead of one "Audio" device with three mixed-up clocks. Only when the subfolders' files are named differently, so cards of one camera stay together; `B-roll/Cam A` joins `Cam A` when its files are named the same way. Devon 2nd Run: 59 → 67 clips synced by sound, timeline 72 h → 24.5 h (compact 11 h 34 → 6 h 05). Checked on 14 shoots: only the 3 with grouped folders change. See the [user guide](docs/user-guide.md#a-folder-that-groups-several-devices).

### Fixed
- **Placement accuracy (app):** the final least-squares step used scipy's iterative `lsqr`, which on Devon 2nd Run stopped at its iteration limit and left clips up to 6.8 ms off (under a frame). Now solved exactly, as the plug-in already did; app and plug-in are byte-identical again on Devon, Kishorn, Borthwick and the synthetic project.

### Changed
- **"Panel" is now called the Premiere Pro plug-in** everywhere (docs, app About, the plug-in itself, GitHub): it's what editors call it. Repository folder `premiere-panel/` → `premiere-plugin/`, scripts `build_plugin_wasm.sh` and `package_plugin.sh`, package `SlingSync-PremierePro-plugin-<version>.ccx`, docs page [Desktop app and Premiere Pro plug-in](docs/desktop-app-and-premiere-plugin.md). The plug-in's internal id stays `io.github.slingsync.panel`, so an installed copy updates instead of appearing twice.

### Removed
- The app's `slingsync://` link and `.slingsync_status.json` progress file: they let early plug-in versions ask the app to sync, and the plug-in has synced on its own since 0.6. (A leftover `.slingsync_status.json` in a shoot folder can be deleted.)

### Premiere Pro plug-in 0.11.0
- The developer tests are out of the plug-in (kept in `premiere-plugin/tests/lab_feasibility.js`). About shows only what users need.

### Repository
- Issue templates: *Report a problem* asks for the tool, version, Mac, the shoot, `SlingSync_report.txt` and the details log; *Suggest a feature*; links to the guides and Ko-fi.

## 1.2.0 (2026-11-18)

Everything in the 1.2.0b1 and 1.2.0b2 test builds below, plus the **Premiere Pro 2027 plug-in** as a `.ccx` next to the DMG. Built by GitHub Actions run [44359091126](https://github.com/dyanez-arch/slingsync/actions/runs/44359091126) from tag `v1.2.0`; [release page](https://github.com/dyanez-arch/slingsync/releases/tag/v1.2.0) with `SlingSync-1.2.0-macOS-AppleSilicon.dmg` and `SlingSync-panel-0.10.3.ccx`.

**Highlights**
- **Premiere Pro plug-in (Premiere 2027+):** syncs a shoot inside Premiere with no other app, using a JavaScript copy of the engine whose results are byte-identical to the app's, and adds the sequence to your project. Also **Compact Timeline** on any open sequence, audio-file export and import of a synced folder. Installs by double-clicking `SlingSync-panel-0.10.3.ccx`. Working prototype: tested on three shoots in Premiere 2027.
- **Compact timeline:** a second sequence with every stretch where nothing was recording cut out, so the day plays as one block for review or a transcript (app checkbox, `--compact`, plug-in button).
- **Audio only:** one aligned WAV per microphone for any audio editor, no Premiere or video needed.
- **Fixed:** a loose-files shoot synced again after an audio export lost its video.
- About credits the creator and links to GitHub issues and Ko-fi; docs explain the desktop app and the plug-in side by side.

Tested on 1.2.0b2 (same code apart from the version number): installs and shows its version, Borthwick fix, compact timeline, plug-in `.ccx` install. See the [testing log](docs/testing.md).

## 1.2.0b2 (test build)

Built by GitHub Actions run [44355109228](https://github.com/dyanez-arch/slingsync/actions/runs/44355109228) from commit `df9fe7f`: `SlingSync-1.2.0b2-macOS-AppleSilicon.dmg` plus the **Premiere Pro plug-in package** `SlingSync-panel-0.10.3.ccx`, in one download (*SlingSync-macos-15*). (The first attempt, run 44354634877, failed making the DMG: hdiutil "Resource busy"; the build now retries that step.)

### Fixed
- **Loose-files shoots synced again after an audio export lost their video** (found on Mark Borthwick, 2026-11-18): the `<name>_audio` folder that *Also export audio files* creates was taken for a device subfolder, so only the exported WAVs were synced and the cameras and recorder were ignored (0 video tracks). SlingSync's own audio-export folders are now never treated as devices (app and plug-in). Borthwick now: 3 of 3 clips synced, 2 video + 9 audio tracks, identical in both engines.

### Added
- **Compact timeline** (app checkbox, `--compact`, plug-in button **Compact Timeline…**): a second XML, `…_compact.xml`, with every stretch where nothing was recording cut out, so the day plays as one block for review or a transcript. Overlapping clips move together; blocks are joined frame-exactly (no black frames). Kishorn: 5 h 03 min → 1 h 27 min, 52 recording blocks, sync kept in every block, 0-frame gaps; app and plug-in engines write byte-identical files. Checked in Premiere on 1.2.0b2.
- **Premiere Pro plug-in step 2 (plug-in 0.2):** **Sync Shoot Folder…** in the plug-in opens the SlingSync app with that folder (via a `slingsync://` link that the app now registers). The app syncs it, reports progress to the plug-in through a small `.slingsync_status.json` file in the folder, and the plug-in imports the synced sequence. Option to also export audio files. Tested with the app driven offscreen, including a folder name with a space and an accent; not yet tested in Premiere.
- App **About** now credits the creator (link to GitHub profile) and links to Issues. Plus a link to support development on [Ko-fi](https://ko-fi.com/pisdronio) (app, plug-in, README, and GitHub's **Sponsor** button via `.github/FUNDING.yml`). Tested offscreen.
- **Docs:** new [Desktop app and Premiere Pro plug-in](docs/desktop-app-and-premiere-plugin.md) page explaining the two tools, why they're built differently and how they relate; README, docs index, code layout and plug-in README reorganised around it.

### Premiere Pro plug-in 0.5 – 0.8 (development, not packaged)
- 0.5: FFmpeg WebAssembly decoder runs inside Premiere (Test 6): a 4K Canon MXF's 8 audio tracks and timecode read correctly, same speed as the app on the same USB drive.
- 0.6: **the plug-in's own engine**: **Sync Shoot Folder…** runs a JavaScript port of the sync engine inside Premiere, no app needed (the `slingsync://` bridge to the app is no longer used). Checked against the app: Kishorn (111 clips) and the synthetic project give byte-identical XML and identical reports. Synced Kishorn inside Premiere 2027 successfully (2026-11-18). 0.6.1: clipboard copy via UXP `setContent`, Copy details.
- 0.7: simpler layout: one main button; progress, result and details only when needed; import and About as small links; developer tests moved into About.
- 0.8: **Compact Timeline…** button.
- 0.10.3: **packaged as `.ccx`** (`scripts/package_plugin.sh`, about 1 MB: plug-in, engine, decoder, MIT license and FFmpeg LGPL notice; tests and C source left out). GitHub builds now package it and attach it to releases.
- 0.9 – 0.10.2: **Compact Timeline** works on the open sequence: Premiere copies it ("… (compact)"), the plug-in closes every gap where no track has a clip, checks every clip landed where planned, and opens the copy; the original is unchanged. Premiere 2027 needs actions created inside `lockedAccess` + `executeTransaction` and fresh objects after each edit (otherwise "The script object is no longer valid"). Tested in Premiere 2027 on Devon Night 2 (2026-11-18): 181 clips, 47 blocks, 135.1 → 59.6 min, all clips where planned; clips move individually (linked clips don't follow). 0.10 also adds the audio-file export to the plug-in (WAVs match the app's to within 1 least-significant bit).

### Premiere Pro plug-in 0.3 – 0.4 (development, not packaged)
- 0.3: temporary **Developer tests** to check a plug-in-only engine is feasible. Run in Premiere Pro 2027 on 2026-11-18: direct WAV reading ✅ fast, Media Encoder ✅ slow (fallback only), JavaScript speed ✅, built-in audio decoder ❌ none, WebAssembly ✅.
- 0.4: **About** section (version, creator, GitHub, report a problem, Ko-fi). Opening web links needs the `https` scheme in the manifest. Not yet tested in Premiere.
- **Plug-in decoder:** FFmpeg 7.1.1 (same as the app), audio only, built to WebAssembly (`premiere-plugin/wasm/`, `scripts/build_plugin_wasm.sh`). Builds; not yet wired in or tested.

## 1.2.0b1 (test build, 2026-11-17)

Built by GitHub Actions run [44219903752](https://github.com/dyanez-arch/slingsync/actions/runs/44219903752) from commit `0e4f9b3`.

### Added
- **Audio only / podcasts:** *Also export audio files* (app) or `--audio` (command line) writes one aligned 24-bit WAV per device channel to `<project>_audio`. Drop them all at 0:00 in any audio editor and they're in sync to the sample. No Premiere or video needed. Tested on a 5-hour, 111-clip shoot: 7 files, about 3 minutes, under 1 GB of memory. Placement is identical to the XML but not rounded to frames.
- **Premiere Pro 2027 plug-in, prototype step 1** (`premiere-plugin/`): imports a SlingSync XML into the open project from a shoot folder or file, and checks that the sequence appeared. Not yet tested in Premiere.
- App: **Show Audio Files** button in the results; the quick guide explains audio-only use.

## 1.1.0 (2026-11-17)

The first release tested on real documentary footage and checked in Premiere Pro: four shoots, from a 79-minute interview to a 131-clip day with five devices (see the [testing log](docs/testing.md)). It includes everything in the test builds below.

**Highlights**
- Syncs real shoots: proxies or originals, folders or loose files, cameras with only scratch/ambient audio, multichannel recorders with dead channels.
- Places clips that share no sound using recorder clocks, camera timecode or dates, checked against the clips that did sync, including clocks that were changed mid-shoot.
- Measures and reports clock drift on long takes.
- Simpler colours: synced / orange (placed by date) / red (not placed), and a clearer report.
- App: logo, New Sync / Sync Another Folder, Help with a quick guide, About, faster Cancel, version and build shown in About and every report.

**Not yet tested by hand in the installed app:** the faster Cancel and the version display, both new in 1.1.0b3 and tested from source. Intel Macs and NAS/read-only drives are not supported yet.

## 1.1.0b3 (test build, 2026-11-17)

Built by GitHub Actions run [44216414950](https://github.com/dyanez-arch/slingsync/actions/runs/44216414950) from commit `6a56c0f`.

### Added
- **Version tracking.** Every build has its own version. **About** and the report header show the version plus the exact code revision and build date (e.g. `1.1.0b3 (build cae50f3, 2026-11-18)`), so any report can be traced to the build that made it. Running from source shows `(from source)`.

### Fixed
- **Cancel** stops within about a second, even in the middle of a long recording. It used to wait for every file being read to finish (a minute or more on long recordings in 1.1.0b2).

### Changed
- Saved analysis (`.slingsync_cache`) is no longer tied to the app version, so updating the app doesn't force every project to be re-analysed. **One-time exception:** projects synced with earlier builds are re-analysed once with this build.

## 1.1.0b2 (test build, 2026-11-17)

Built by GitHub Actions run [44211278040](https://github.com/dyanez-arch/slingsync/actions/runs/44211278040) from commit `48fe159`. The app still showed "1.0.0".

### Added
- **App:** logo in the window header, About box and window icon.
- **New Sync** (⌘N) and **Sync Another Folder** to clear the window for the next shooting day.
- **Help** button and menu: an in-app quick guide, plus links to the online user guide, troubleshooting and issue reporting.
- **About SlingSync**, in the SlingSync menu.

### Changed
- Report: silent channels are summarised per device instead of listed per file.
- First-launch instructions updated for current macOS: **Done**, then **Privacy & Security → Open Anyway**. Written from the first real install.
- The logo moved to `slingsync/resources/icon.png`, so it is bundled with the package and the app.

## 1.1.0b1 (test build, 2026-11-17)

Built by GitHub Actions run [44207696385](https://github.com/dyanez-arch/slingsync/actions/runs/44207696385) from commit `e965613`. The app still showed "1.0.0". This was the first fixes from testing on real footage: three shoots verified in Premiere.

### Added
- **Loose files.** A project folder with no device subfolders works. Files are grouped into devices by name (`A005C002…` → Cam A, `INTVW1T01/02.wav` → INTVW1T). The app warns when devices were guessed from file names.
- **Smart proxy handling.** Premiere `_Proxy` files are skipped when the original is present and used when it isn't. The app's device list shows when proxies are used.
- **Camera timecode** is used to place clips. Record-run timecode is detected and ignored, while GoPro-style chapters are kept back to back.
- **Clocks that change mid-shoot** (e.g. cameras re-jammed at lunch) are handled: clips with no shared sound use the nearest sound-verified clip from the same device. A new **Device clocks** report section shows, for each device, whether its clock was steady, changed, or is a guess.
- **Clock drift.** Long takes are lined up at the middle of the overlap, and the drift between devices is measured and listed in the report with a verdict (fine / check the ends / out of sync).
- **Weak false matches** that contradict well-established device clocks are dropped.
- **`--verbose`** on the CLI (and a `log` callback in `engine.run`) prints every file's channels, levels and date, every match with its offset, votes and drift, and the final placement.
- A clear error if the drive disconnects during a sync.
- `scripts/make_test_project.py`: a synthetic project with known answers for regression testing.

### Changed
- **Simpler colours:** *synced* (no colour) covers every clip lined up by sound with another device, including whole scenes positioned by clock. *Placed by date* (orange) is only for clips with no sound partner, with a note on how reliable their clock is. The yellow "block placed by date" status is gone.
- **Steady ambience is no longer thrown away.** A channel with little level variation is only treated as dead when the same file has a livelier channel. Camera mics recording steady wind or night ambience were previously discarded, leaving nothing to sync.
- **Devices that share no sound are placed by their own dates** instead of all being parked at the end as NOT PLACED. If a device's clock is clearly wrong (e.g. set to the wrong year), its clips start at the beginning of the timeline with their spacing kept, and the report flags "its clock is a guess".
- **Proxy dates:** a proxy's own file date is never used, but a creation date carried over from the original is.
- **Dates are compared as wall-clock time.** Cameras that label local time as UTC no longer shift by hours.
- Back-to-back recordings that overlap by a fraction of a second (date rounding, GoPro chapters) no longer open an extra track.
- Premiere auto-save and preview folders are ignored, and folders with no media no longer appear as devices.
- README: clearer about what "no timecode needed" means (sound sync needs none; timecode and dates help place clips that share no sound), plus a status section linking to the testing log.
- CI builds on `macos-15` (the `macos-14` runner is retired).

### Fixed
- Analysis crashed with `'NoneType' object is not subscriptable` when a file couldn't be reopened.
- Spurious "divide by zero / overflow in matmul" warnings from numpy 2.0 on Apple Silicon.

## 1.0.0 (2026-11-17)

Initial release. Built and tested on synthetic audio only.
