# Changelog

## Unreleased

First fixes from testing on real footage. See [docs/testing.md](docs/testing.md) for what was tested.

### Added
- **Loose files.** A project folder with no device subfolders now works. Files are grouped into devices by name (`A005C002…` → Cam A, `INTVW1T01/02.wav` → INTVW1T).
- **Smart proxy handling.** Premiere `_Proxy` files are skipped when the original is present and used when it isn't.
- **Clock drift.** Long takes are lined up at the middle of the overlap, and the drift between devices is measured and listed in the report with a verdict (fine / check the ends / out of sync).
- **`--verbose`** on the CLI (and a `log` callback in `engine.run`) prints every file's channels, levels and date, every match with its offset, votes and drift, and the final placement.
- A clear error if the drive disconnects during a sync.
- **Camera timecode** is used to place clips. Record-run timecode is detected and ignored, while GoPro-style chapters are kept back to back.
- **Clocks that change mid-shoot** (e.g. cameras re-jammed at lunch) are handled: clips with no shared sound use the nearest sound-verified clip from the same device. A new **Device clocks** report section shows, for each device, whether its clock was steady, changed, or is a guess.
- **Weak false matches** that contradict well-established device clocks are dropped.

### Changed
- **Simpler colours:** *synced* (no colour) now covers every clip lined up by sound with another device, including whole scenes positioned by clock. *Placed by date* (orange) is only for clips with no sound partner, with a note on how reliable their clock is. The yellow "block placed by date" status is gone.
- **Proxy dates:** a proxy's own file date is never used, but a creation date carried over from the original is.
- **Dates are compared as wall-clock time.** Cameras that label local time as UTC no longer shift by hours.
- Back-to-back recordings that overlap by a fraction of a second (date rounding, GoPro chapters) no longer open an extra track.
- **Steady ambience is no longer thrown away.** A channel with little level variation is only treated as dead when the same file has a livelier channel. Camera mics recording steady wind or night ambience were previously discarded, leaving nothing to sync.
- **Devices that share no sound are placed by their own dates** instead of all being parked at the end as NOT PLACED. If a device's clock is clearly wrong (e.g. set to the wrong year), its clips start at the beginning of the timeline with their spacing kept, and the report flags "its clock is a guess".
- Premiere auto-save and preview folders are ignored, and folders with no media no longer appear as devices.
- CI builds on `macos-15` (the `macos-14` runner is retired).

### Fixed
- Analysis crashed with `'NoneType' object is not subscriptable` when a file couldn't be reopened.
- Spurious "divide by zero / overflow in matmul" warnings from numpy 2.0 on Apple Silicon.

## 1.0.0

Initial release. Built and tested on synthetic audio only.
