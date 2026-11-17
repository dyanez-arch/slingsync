# SlingSync

**Free multicam sync for Premiere Pro, by sound. No timecode needed.**

Drop in a folder of clips from any number of cameras and audio recorders, and SlingSync lines them all up by matching their audio, then hands you an XML that opens in Premiere as a ready-synced sequence. It's built for real documentary shoots: hundreds of clips, recorders stopping and starting, cameras rolling in bursts, multichannel WAVs with dead channels.

## Documentation

Full guides are in [`docs/`](docs/README.md): [user guide](docs/user-guide.md), [command line](docs/command-line.md), [how it works](docs/how-it-works.md), [development](docs/development.md) and [troubleshooting](docs/troubleshooting.md).

## Download

Get the latest `.dmg` from the [Releases](../../releases) page, open it, and drag **SlingSync** into Applications.

**First launch:** the app isn't notarised by Apple yet, so macOS will block it the first time. Right-click (or Control-click) SlingSync in Applications, choose **Open**, then **Open** again. You only need to do this once. On recent macOS versions you may instead need to go to **System Settings → Privacy & Security** and click **Open Anyway**.

## How to use

1. Make a project folder with **one subfolder per device**, named however you like:

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

Anything that couldn't be synced by sound is listed in the app and in `SlingSync_report.txt`, so you only check those clips by eye.

## What it handles

- **Any number of cameras, recorders and channels.** Each device gets its own track or tracks in the sequence, and each audio channel gets its own track.
- **Silent and dead channels.** Channels that are too quiet, or that contain nothing but steady hiss, are ignored for syncing. Channels that are silent in every file of a device are left out of the timeline (optional).
- **Clips with no shared sound.** For example, a camera rolling while every recorder was off. SlingSync learns each device's clock offset from the clips that did sync, then places these by their file dates and flags them. It also works out whether each camera stamps the start or the end of a recording.
- **Re-runs.** Audio analysis is saved in a hidden `.slingsync_cache` folder inside the project, so changing options and syncing again is fast. Delete that folder when you're done with the project.

**Sync using** (per device) lets you force syncing to a single channel, such as the ambient mic. The default, which mixes all live channels, is usually the most reliable.

## Command line

```
pip install .
slingsync "/path/to/Interview Day 1"
slingsync --help
```

Options include `--fps 25`, `--ref-channel "Zoom F6=3"`, `--keep-silent`, `--skip-silent-clips` and `--clear-cache`.

## How it works

1. Every audio channel is checked for silence or flat noise. The live channels are mixed at equal level.
2. Each clip gets an audio fingerprint made of spectral peak pairs (the same idea Shazam uses). Matching fingerprints between devices vote for the time offset between clips. This is fast even with hundreds of clips and needs no rough positions to start from.
3. Each match is refined to sample accuracy with GCC-PHAT cross-correlation on several windows of the overlap.
4. All matches are solved together with least squares, so small errors don't pile up along chains of clips.
5. Groups that share no sound with the rest are positioned from the device clocks, as described above.
6. A Final Cut Pro 7 XML is written, which Premiere imports.

## Limitations

- A clip needs some sound in common with another device to sync by audio. Silent B-roll is placed by file date only.
- Positions in the XML are frame-accurate.
- Apple Silicon builds are published. Intel Macs can run from source (`pip install .` then `slingsync-app`).

## Building the app yourself

On a Mac with Python 3.10 or newer:

```
bash scripts/build_mac.sh
```

This produces `dist/SlingSync.app` and a `.dmg`. Pushing a tag such as `v1.0.1` makes GitHub Actions build the DMG and attach it to a new release automatically.

## License

MIT
