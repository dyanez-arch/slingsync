# Changelog

Every build that reaches anyone gets its own version number and section here. Test builds are `1.1.0b1`, `1.1.0b2`… and the release is `1.1.0`. See [versioning](docs/development.md#versioning). The app's **About** box and every report show the exact version and build.

What was tested with each build is in the [testing log](docs/testing.md).

## 1.2.0b1 (in development)

### Added
- **Audio only / podcasts:** *Also export audio files* (app) or `--audio` (command line) writes one aligned 24-bit WAV per device channel to `<project>_audio`. Drop them all at 0:00 in any audio editor and they're in sync to the sample. No Premiere or video needed. Tested on a 5-hour, 111-clip shoot: 7 files, about 3 minutes, under 1 GB of memory. Placement is identical to the XML but not rounded to frames.
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
