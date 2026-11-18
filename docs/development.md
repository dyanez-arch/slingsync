# Development

## Code layout

```
app.py                     entry point for the bundled Mac app (calls gui.main)
slingsync/
    __init__.py            __version__ (single source of truth for the version)
    __main__.py            python -m slingsync → cli.main
    cli.py                 argparse CLI wrapping engine.run
    engine.py              all sync logic: probe, analyse, fingerprint, match, refine, place, XML, report
    gui.py                 PySide6 desktop app
assets/icon.png            app icon source (converted to .icns at build time)
scripts/build_mac.sh       builds dist/SlingSync.app and a .dmg
scripts/make_test_project.py   synthetic project with known answers (regression test)
SlingSync.spec             PyInstaller spec
.github/workflows/build-mac.yml   CI build and release
```

The GUI and CLI are thin. Everything else is in `engine.py`, documented in [How it works](how-it-works.md). Main entry points, in pipeline order:

| Function | Does |
|---|---|
| `scan_devices` | Finds devices (subfolders, or loose files grouped by name), skips proxies whose originals are present |
| `probe` / `_date_candidates` / `_parse_tc` | Reads duration, streams, channels, fps, timecode and every date hint |
| `resolve_dates` | Picks each clip's date: recorder clock > timecode > metadata > file date, with proxy and record-run rules |
| `analyze` | Silence/flat-channel detection, mono mix, fingerprint (cached) |
| `match_all` | Fingerprint voting across devices → coarse offsets |
| `refine` | GCC-PHAT, drift-tolerant → sample-accurate offset + drift |
| `place` | Drops false matches, least squares, local device clocks, statuses |
| `build_xml` / `write_report` | Output |

### GUI structure

- `DropZone`: drag-and-drop area and **Choose Folder…** button.
- `Main`: window with the device table (with a per-device **Sync using** dropdown), options, progress bar, results and buttons.
- Long work runs in a `QThread` via small worker objects: a scan worker calls `scan_devices` + `device_channels`, and a sync worker calls `engine.run`. They report back with Qt signals. **Cancel** sets a `threading.Event` that `run()` checks between steps.

## Running from source

Python 3.9 or newer (3.10+ for building the app).

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
slingsync --help        # CLI
slingsync-app           # desktop app
```

Dependencies: `numpy`, `scipy`, `av` (PyAV, which bundles FFmpeg), `PySide6`. No system FFmpeg is needed.

> The loose `slingsync.py` outside this repo is the earlier single-file version. It shells out to `ffmpeg`/`ffprobe`, and is superseded by this package.

## Testing and debugging

There's no automated test suite yet. What's been run on real footage is recorded in the [testing log](testing.md); please add to it.

**Synthetic regression test.** Run this after any change to matching or placement. It takes about 10 seconds:

```bash
python scripts/make_test_project.py /tmp/synth && slingsync -v /tmp/synth
python scripts/make_test_project.py /tmp/synth --camb-clock-off 94608000 && slingsync -v /tmp/synth
python scripts/make_test_project.py /tmp/synth --proxies && slingsync -v /tmp/synth
```

Each run prints the expected clip positions. Compare them with the placement lines at the end of the verbose output. They should match exactly.

**Real footage.** `slingsync -v <project>` prints every file's channels, levels, date and where the date came from, every match (offset, votes, refined or not, drift), dropped false matches, and the final placement. The report's **Device clocks** section shows how consistent each device's clock is with the sound. A sudden jump there usually means a clock change on set or a false match. Re-runs reuse `.slingsync_cache`, so iterating on placement logic takes seconds.

**App.** The window can be driven without a display, e.g. `QT_QPA_PLATFORM=offscreen python -c "from slingsync import gui; ..."`, using `MainWindow.load_folder()` and `start_sync()`.

## Building the Mac app

On a Mac:

```bash
bash scripts/build_mac.sh
```

The script:

1. Installs requirements and PyInstaller.
2. Generates `build/SlingSync.icns` from `assets/icon.png` (`sips` + `iconutil`).
3. Runs PyInstaller with `SlingSync.spec` (unused Qt modules excluded to keep the size down; minimum macOS 12).
4. Ad-hoc signs the app (`codesign --sign -`) so Apple Silicon will launch it.
5. Builds `dist/SlingSync-<version>-macOS-<AppleSilicon|Intel>.dmg` with an Applications shortcut.

The architecture of the build matches the machine (or runner) it's built on.

## Releasing

1. Bump `__version__` in `slingsync/__init__.py`. This changes the app version, the DMG name and the cache key. Move the changelog's *Unreleased* section under the new version.
2. Commit and push.
3. Tag and push:

   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```

The **Build Mac app** workflow runs on any `v*` tag. On a `macos-15` (Apple Silicon) runner it installs requirements, smoke-tests with `python -m slingsync --help`, runs `build_mac.sh`, uploads the DMG as a workflow artifact, and creates a GitHub Release with the DMG attached.

It can also be run by hand from the **Actions** tab (`workflow_dispatch`). That builds the DMG as an artifact but doesn't create a release.

To add an Intel build, add an Intel macOS runner label to the `matrix.runner` list in `.github/workflows/build-mac.yml`.

## Notarisation (not done yet)

The app is ad-hoc signed only, so users must approve it on first launch. Removing that step needs an Apple Developer ID certificate, `codesign` with `--options runtime`, `xcrun notarytool submit`, and `xcrun stapler staple` on the app and DMG, with the credentials stored as GitHub secrets.
