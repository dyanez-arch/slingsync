# SlingSync

**Free multicam sync for Premiere Pro, by sound. Also exports aligned audio files for podcasts and any audio editor.**

SlingSync comes in two forms:

| | |
|---|---|
| **Desktop app** (Mac) | Released. Works with any editor that imports FCP7 XML, or with no video at all (audio-only export). [Download](../../releases) |
| **Premiere Pro plug-in** (Premiere 2027+) | Working prototype, installs from a `.ccx` file. Syncs inside Premiere on its own and puts the sequence straight into your project; also compacts any open sequence. [About the plug-in](premiere-plugin/README.md) |

They do the same job and aim for identical results, but are built differently: Premiere plugins can only run JavaScript, so the plug-in carries its own JavaScript version of the engine. See [Desktop app and Premiere Pro plug-in](docs/desktop-app-and-premiere-plugin.md) for how they relate and which to use. The rest of this page is about the **desktop app**.

Drop in a folder of clips from any number of cameras and audio recorders, and SlingSync lines them all up by matching their audio, then hands you an XML that opens in Premiere as a ready-synced sequence. It's built for real documentary shoots: hundreds of clips, recorders stopping and starting, cameras rolling in bursts, multichannel WAVs with dead channels.

**Timecode:** syncing by sound needs no timecode, slate or clap. Every clip that shares sound with another device is lined up from its audio alone. Clips that share *no* sound (cutaways, drone shots, a camera rolling while the recorder was off) can't be synced by sound. SlingSync places those using whatever clock information the files carry: recorder time, camera timecode if there is any, or file dates. Timecode makes those placements more reliable, but isn't required.

## Status

Tested on real documentary footage and checked in Premiere Pro. See the [testing log](docs/testing.md) for exactly what has been tested and what hasn't, and the [changelog](CHANGELOG.md) for what's changed.

- ✅ A 79-minute interview: 2 cameras plus a 5-channel recorder, loose files, proxies.
- ✅ A full-day site visit: 131 clips from 5 devices (2 cameras, recorder, GoPro, drone). The camera timecode was changed mid-day.
- ✅ Premiere Pro plug-in: synced shoots inside Premiere Pro 2027 with no app, results identical to the app; Compact Timeline on a 181-clip day.
- ⏳ Not yet tested: the packaged app on other Macs, mixed frame rates, NAS drives, Intel Macs.

The current release is **v1.2.1**: desktop app plus the Premiere Pro 2027 plug-in. What's new is in the [changelog](CHANGELOG.md).

## Documentation

Full guides are in [`docs/`](docs/README.md): [user guide](docs/user-guide.md), [command line](docs/command-line.md), [how it works](docs/how-it-works.md), [troubleshooting](docs/troubleshooting.md), [development](docs/development.md) and the [testing log](docs/testing.md).

## Download

Get the latest `.dmg` from the [Releases](../../releases) page, open it, and drag **SlingSync** into Applications.

**Premiere Pro 2027 plug-in:** from the same release, download `SlingSync-PremierePro-plugin-….ccx` and double-click it; Creative Cloud installs it. Then restart Premiere and open **Window → UXP Plugins → SlingSync**.

**First launch:** SlingSync is free and isn't signed with a paid Apple developer account, so macOS blocks it the first time. This is expected, and you only do it once:

1. Open **SlingSync** from Applications. macOS says it can't verify that SlingSync is free of malware, and offers **Move to Trash** or **Done**. Click **Done**, not Move to Trash.
2. Open **System Settings → Privacy & Security** and scroll down to the **Security** section. You'll see a message that SlingSync was blocked. Click **Open Anyway**.
3. Confirm with your password or Touch ID, then click **Open Anyway** once more if asked.

From then on SlingSync opens normally. (On older macOS versions, right-clicking the app and choosing **Open** also works.)

## How to use

1. Make a project folder with **one subfolder per device**, named however you like. (Loose files with no subfolders also work: SlingSync groups them by file name.)

   ```
   Interview Day 1/
       CamA/      all clips from camera A (card folder structures inside are fine)
       CamB/
       Zoom F6/   multichannel WAVs from a recorder
       Lavs/
   ```

2. Open SlingSync and drop the project folder onto the window.
3. Check the device list, then click **Sync**.
4. In Premiere, choose **File → Import…** and pick the `…_synced.xml` file that appears in the project folder.
5. For the next shooting day, click **Sync Another Folder** (or **New Sync**). The **Help** button opens a quick guide inside the app.

Anything that couldn't be synced by sound is marked orange (placed by its device's clock) or red (couldn't be placed), and listed in the app and in `SlingSync_report.txt`, so you only check those clips by eye.

## What it handles

- **Any number of cameras, recorders and channels.** Each device gets its own track or tracks in the sequence, and each audio channel gets its own track.
- **Silent and dead channels.** Channels that are too quiet, or that contain nothing but steady hiss while other channels have real sound, are ignored for syncing. Steady ambience is still used when it's all a clip has. Channels that are silent in every file of a device are left out of the timeline (optional).
- **Clips with no shared sound.** For example, a camera rolling while every recorder was off, or a drone. SlingSync reads each device's clock (recorder time, camera timecode, file dates), checks it against the clips that did sync, and places these clips with it, flagged orange. It copes with clocks that are off by hours, with clocks that were changed mid-shoot (e.g. cameras re-jammed at lunch), and with cameras that stamp the end of a recording instead of the start.
- **Proxies.** Premiere `_Proxy` files are skipped when the original is there, and used when it isn't. A proxy's own file date (the day it was transcoded) is never trusted, but timecode or an original shoot date carried inside it is.
- **Loose files.** No subfolders? SlingSync guesses the devices from file names (e.g. `A005C002…` → Cam A).
- **False matches.** A weak sound match that contradicts what the device clocks say is dropped.
- **Clock drift.** Long takes are lined up at the middle, and any drift between devices is measured and reported.
- **Audio only.** Tick **Also export audio files** and SlingSync also writes one aligned WAV per microphone. Drop them at the start of any audio editor (Audacity, Reaper, Logic, Descript…) and they're in sync. No Premiere or video needed, which suits podcasts, music and interviews.
- **Compact timeline.** Tick **Also make a compact timeline** for a second XML with every stretch where nothing was recording cut out: the whole day as one continuous block, still in sync, for reviewers or a single transcript. (A 5-hour day with 1.5 hours of recordings becomes a 1.5-hour sequence.)
- **Re-runs.** Audio analysis is saved in a hidden `.slingsync_cache` folder inside the project, so changing options and syncing again is fast. Delete that folder when you're done with the project.

**Sync using** (per device) lets you force syncing to a single channel, such as the ambient mic. The default, which mixes all live channels, is usually the most reliable.

## Premiere Pro plug-in (working prototype)

A SlingSync plug-in for **Premiere Pro 2027** lives in [`premiere-plugin/`](premiere-plugin/README.md). It syncs a shoot folder **inside Premiere, without the desktop app**, using a JavaScript copy of the same engine (results are byte-identical to the app's), and adds the synced sequence to your project. It can also export the aligned audio files and **compact any open sequence**. Install it by double-clicking the `SlingSync-PremierePro-plugin-….ccx` file that comes with each build. Read [Desktop app and Premiere Pro plug-in](docs/desktop-app-and-premiere-plugin.md) for the differences.

## Command line

```
pip install .
slingsync "/path/to/Interview Day 1"
slingsync --help
```

Options include `--verbose` (details for every file and match), `--fps 25`, `--ref-channel "Zoom F6=3"`, `--keep-silent`, `--skip-silent-clips` and `--clear-cache`.

## How it works

1. Every audio channel is checked for silence, or for a dead input that only carries hiss. The live channels are mixed at equal level.
2. Each clip gets an audio fingerprint made of spectral peak pairs (the same idea Shazam uses). Matching fingerprints between devices vote for the time offset between clips. This is fast even with hundreds of clips and needs no rough positions to start from.
3. Each match is refined to sample accuracy with GCC-PHAT cross-correlation across the overlap. Slow clock drift on long takes is measured.
4. All matches are solved together with least squares, so small errors don't pile up along chains of clips.
5. Clips and scenes that share no sound with the rest are positioned from each device's clock (recorder time, timecode or file date). Each clock is checked against the clips that did sync, and clock changes during the shoot are allowed.
6. A Final Cut Pro 7 XML is written, which Premiere imports, along with a plain-text report and, optionally, aligned WAV files (sample-accurate).

Details: [how it works](docs/how-it-works.md).

## Limitations

- A clip needs some sound in common with another device to sync by audio. Silent B-roll and drone clips are placed by their device's clock only. That's only as good as the clock, and a device with no sound at all (e.g. a drone) has a clock nobody can check.
- Positions in the XML are whole frames, so a clip can be up to half a frame off (20 ms at 25 fps). Sound-synced clips are otherwise accurate to about a millisecond.
- If you sync proxies with no originals present, the sequence points at the proxies.
- The analysis cache is written inside the project folder, so read-only drives aren't supported yet.
- Apple Silicon builds are published. Intel Macs can run from source (`pip install .` then `slingsync-app`).

## Building the app yourself

On a Mac with Python 3.10 or newer:

```
bash scripts/build_mac.sh
```

This produces `dist/SlingSync.app` and a `.dmg`. Pushing a tag such as `v1.1.0` makes GitHub Actions build the DMG and attach it to a new release automatically. See [development](docs/development.md).

## Repository layout

| Folder | |
|---|---|
| [`slingsync/`](slingsync) | Desktop app and command line (Python): engine, GUI, CLI |
| [`premiere-plugin/`](premiere-plugin/README.md) | Premiere Pro plug-in (JavaScript + WebAssembly) |
| [`docs/`](docs/README.md) | Guides for both |
| [`scripts/`](scripts) | Build scripts (Mac app, plug-in decoder) and the synthetic test project |

## Credits and support

Made by [Daniel Yanez](https://github.com/dyanez-arch), a documentary editor, to stop syncing multicam shoots by hand. SlingSync is free. Problems and ideas are welcome in [Issues](../../issues).

If it saves you time, you can support its development on **[Ko-fi](https://ko-fi.com/pisdronio)** ☕

## License

MIT for SlingSync's own code. The desktop app bundles FFmpeg through PyAV, and the plug-in includes FFmpeg compiled to WebAssembly; FFmpeg is LGPL 2.1+ (see [`premiere-plugin/wasm/`](premiere-plugin/wasm/README.md)).
