# User guide

SlingSync lines up clips from any number of cameras and audio recorders by matching their sound, then writes a Final Cut Pro 7 XML that Premiere Pro imports as a ready-synced sequence. No timecode or slate is needed.

## 1. Install

1. Download the latest `SlingSync-<version>-macOS-AppleSilicon.dmg` from the [Releases](https://github.com/dyanez-arch/slingsync/releases) page.
2. Open it and drag **SlingSync** into **Applications**.
3. The first time, macOS will block it because the app isn't notarised. Right-click SlingSync → **Open** → **Open**. On recent macOS you may need **System Settings → Privacy & Security → Open Anyway** instead. This is only needed once.

Requires macOS 12 or later. Intel Macs: see [Development](development.md#running-from-source).

## 2. Set up the project folder

Make one folder per shoot, with **one subfolder per device**. Folder names become device and track names in Premiere.

```
Interview Day 1/
    CamA/         clips from camera A (card structures like PRIVATE/M4ROOT/CLIP are fine)
    CamB/
    Zoom F6/      multichannel WAVs from a recorder
    Lavs/
```

Rules:

- Every file inside a device folder, at any depth, is treated as coming from that device.
- Files and folders starting with `.` are ignored.
- Files directly in the project folder (not in a subfolder) are ignored.
- Recognised video: `.mp4 .mov .mxf .mts .m2ts .avi .mkv .m4v .mpg .mpeg .3gp .insv .lrv`
- Recognised audio: `.wav .bwf .aif .aiff .mp3 .m4a .flac .aac .ogg .caf`

Keep each physical device in its own folder. SlingSync never tries to match two clips from the same device against each other, and it learns each device's clock separately.

## 3. Sync

1. Open SlingSync and drop the project folder on the window (or click **Choose Folder…**).
2. Check the device table: name, number of files, Camera or Audio.
3. Optionally set, per device, **Sync using**:
   - **All live channels (recommended)**: mixes every non-silent channel at equal level.
   - **Only channel N**: listen to one channel only, for example an ambient or scratch mic. If that channel is silent in a particular file, the other channels are used for that file.
4. Options:
   - **Sequence frame rate**: defaults to the first camera's rate.
   - **Leave out channels that are silent in every file of a device** (on by default).
   - **Also leave out channels that are silent in individual clips**.
   - **Re-analyse everything**: ignores saved analysis.
5. Click **Sync**. Progress goes through reading file info, analysing audio, matching, fine-tuning and building the timeline. **Cancel** stops at any point.

When it finishes, the window shows a summary and lists anything that needs checking. **Show XML in Finder** and **Open Report** take you to the outputs.

## 4. Import into Premiere

**File → Import…** and choose `<project name>_synced.xml` in the project folder. Premiere creates a sequence that links to your original media in place. Don't move or rename the media before importing.

### Sequence layout

- Each device gets its own video track (cameras) and one audio track **per channel**, in device-folder order.
- If clips on one device overlap in time (e.g. two cards from the same camera, or a misnamed folder), that device gets extra *lanes*, i.e. extra tracks. This usually means something worth checking.
- Video and audio of the same clip are linked.
- Clips that were not synced by sound get a **label colour**:

| Colour | Status | Meaning |
|---|---|---|
| (none) | synced | Placed by sound |
| Yellow | block placed by date | A group of clips synced to each other by sound, but sharing no sound with the main timeline. The group is positioned using device clocks |
| Orange | placed by date | A single clip with no sound match, positioned using its device's clock |
| Red | NOT PLACED | No usable sound and no usable date. Parked after the end of the timeline |

## 5. The report

`SlingSync_report.txt` is written next to the XML. It contains:

- A summary count per status, sequence frame rate and track counts.
- **Tracks per device**: lanes and which channels were kept.
- **CHECK THESE BY EYE**: every clip not synced by sound, with its timeline position.
- **Inconsistent matches**: pairs of clips whose sound match disagrees with the final solution by more than 80 ms. Usually harmless (e.g. repeated music), but look here if something is off.
- **Silent channels** per file, and which channels were used for syncing.
- **Unreadable files** that were skipped.
- **All clips** with their timeline position and status.

## 6. Re-running

Audio analysis is cached in a hidden `.slingsync_cache` folder inside the project. Changing options and syncing again is fast. The cache is keyed on each file's path, size, modification time, reference channel and silence thresholds, so changed files are re-analysed automatically. Delete the folder when the project is finished to reclaim space (it holds an 8 kHz mono copy of every clip's audio).

## Tips for good results

- Have every camera record scratch audio, even a poor-quality on-camera mic.
- Short clips (under ~1 second of overlap) can't be fine-tuned and are less reliable.
- Set camera and recorder clocks roughly right before the shoot. Clips with no shared sound are positioned from these clocks, and a correct clock makes their placement much better.
- Steady noise (fans, air-con, wind) alone is hard to match. Speech, music and handling sounds match well.
