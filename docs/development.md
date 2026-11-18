# Development

## Code layout

The repository holds two tools that share one engine design (see [Desktop app and Premiere panel](desktop-app-and-premiere-panel.md)):

```
── Desktop app + command line (Python) ──
app.py                     entry point for the bundled Mac app (calls gui.main)
slingsync/
    __init__.py            __version__ (single source of truth for the version)
    __main__.py            python -m slingsync → cli.main
    cli.py                 argparse CLI wrapping engine.run
    engine.py              all sync logic: probe, analyse, fingerprint, match, refine, place, XML, report
    gui.py                 PySide6 desktop app (window, Help menu, quick guide, About)
    resources/icon.png     logo: shown in the app, converted to the .icns app icon at build time
scripts/build_mac.sh       builds dist/SlingSync.app and a .dmg
scripts/make_test_project.py   synthetic project with known answers (regression test)
SlingSync.spec             PyInstaller spec
.github/workflows/build-mac.yml   CI build and release (desktop app)

── Premiere Pro panel (JavaScript + WebAssembly, UXP) ──
premiere-panel/
    manifest.json          plugin id, version, Premiere 27.0+, permissions
    index.html, index.js   the panel (sync, Compact Timeline, import, About)
    engine/                JavaScript port of the engine (core.js, run.js) + file access + decoder bridge
    tests/                 panel engine vs desktop app (Node), feasibility tests
    wasm/ssdec.c           FFmpeg glue: open a file, list streams/tags, decode audio at any rate
    wasm/ssdec.js, .wasm   built decoder (scripts/build_panel_wasm.sh)
scripts/build_panel_wasm.sh    builds FFmpeg 7.1.1 (audio only) + ssdec.c with Emscripten
scripts/package_panel.sh       packages the panel as dist/SlingSync-panel-<version>.ccx (also done by CI)

── Shared ──
docs/                      guides for both tools
CHANGELOG.md               app versions and panel versions
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
2. Generates `build/SlingSync.icns` from `slingsync/resources/icon.png` (`sips` + `iconutil`).
3. Runs PyInstaller with `SlingSync.spec` (unused Qt modules excluded to keep the size down; minimum macOS 12).
4. Ad-hoc signs the app (`codesign --sign -`) so Apple Silicon will launch it.
5. Builds `dist/SlingSync-<version>-macOS-<AppleSilicon|Intel>.dmg` with an Applications shortcut.

The architecture of the build matches the machine (or runner) it's built on.

## Versioning

Every build that reaches anyone (a test build or a release) has its own version, so a report or a bug can always be traced to the exact code that produced it.

| Kind | Version | Example |
|---|---|---|
| Test build (made by hand from the Actions tab) | next release + `bN` | `1.1.0b1`, `1.1.0b2`, `1.1.0b3` |
| Release (tagged, on the Releases page) | `x.y.z` | `1.1.0` |
| Bug-fix release | bump the last number | `1.1.1` |
| Release with new features | bump the middle number | `1.2.0` |

The version lives in one place: `__version__` in `slingsync/__init__.py`. The CLI (`--version`), the app's About box, the report header and the DMG file name all read it.

Each app build also gets a **build stamp**. `scripts/build_mac.sh` writes `slingsync/_build.py` (not committed) with the short commit hash and build date, and `full_version()` combines them: `1.1.0b3 (build cae50f3, 2026-11-18)`. Running from source shows `1.1.0b3 (from source)`. macOS's own version field (`CFBundleShortVersionString`) gets the plain `1.1.0` part; the full version goes in `CFBundleVersion`.

The **analysis cache** key uses `ANALYSIS_VERSION` in `engine.py`, not the app version, so updating the app doesn't force re-analysis. Bump `ANALYSIS_VERSION` only when the analysis output changes (silence rules, mono mix, fingerprint).

### For every test build

1. Set `__version__` to the next `bN` (e.g. `1.1.0b3` → `1.1.0b4`).
2. Add a `## 1.1.0b4 (test build, date)` section at the top of `CHANGELOG.md` listing what changed since the last build.
3. Commit and push, then run **Build Mac app** from the Actions tab (or `gh workflow run build-mac.yml --ref main`). Add the run link to the changelog section.
4. Record what gets tested with that build in [the testing log](testing.md), naming the version.

## Releasing

1. Set `__version__` to the release number (e.g. `1.1.0`). In `CHANGELOG.md`, add a `## 1.1.0 (date)` section summarising everything since the last release; the test-build sections stay below it as history.
2. Commit and push.
3. Tag and push:

   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```

The tag must match `__version__`. The **Build Mac app** workflow runs on any `v*` tag. On a `macos-15` (Apple Silicon) runner it installs requirements, smoke-tests with `python -m slingsync --help`, runs `build_mac.sh`, uploads the DMG as a workflow artifact, and creates a GitHub Release with the DMG attached.

Run by hand from the **Actions** tab (`workflow_dispatch`), it builds the DMG as an artifact but doesn't create a release. That's how test builds are made.

To add an Intel build, add an Intel macOS runner label to the `matrix.runner` list in `.github/workflows/build-mac.yml`.

## Notarisation (not done yet)

The app is ad-hoc signed only, so users must approve it on first launch. Removing that step needs an Apple Developer ID certificate, `codesign` with `--options runtime`, `xcrun notarytool submit`, and `xcrun stapler staple` on the app and DMG, with the credentials stored as GitHub secrets.
