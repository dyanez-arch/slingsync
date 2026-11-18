# User guide

SlingSync lines up clips from any number of cameras and audio recorders by matching their sound, then writes a Final Cut Pro 7 XML that Premiere Pro imports as a ready-synced sequence, and, if you like, aligned WAV files for any audio editor (see [Audio only](#4b-audio-only-podcasts-music-interviews-no-premiere-needed)). Syncing by sound needs no timecode or slate. Clips that share no sound with another device are placed using the files' own clock information (recorder time, camera timecode if present, or file dates).

## 1. Install

1. Download the latest `SlingSync-<version>-macOS-AppleSilicon.dmg` from the [Releases](https://github.com/dyanez-arch/slingsync/releases) page.
2. Open it and drag **SlingSync** into **Applications**.
3. Open it once by following the first-launch steps below.

### First launch

SlingSync is free and isn't signed with a paid Apple developer account, so macOS blocks it the first time. This is expected, and you only do it once:

1. Open **SlingSync** from Applications. macOS says it can't verify that SlingSync is free of malware, and offers **Move to Trash** or **Done**. Click **Done**, not Move to Trash.
2. Open **System Settings → Privacy & Security** and scroll down to the **Security** section. You'll see a message that SlingSync was blocked. Click **Open Anyway**.
3. Confirm with your password or Touch ID, then click **Open Anyway** once more if asked.

From then on SlingSync opens normally. (On older macOS versions, right-clicking the app and choosing **Open** also works.)

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

- Every file inside a device folder, at any depth, is treated as coming from that device, with one exception (next section).
- Files and folders starting with `.` are ignored.
- Premiere's auto-save and preview folders are ignored.
- Recognised video: `.mp4 .mov .mxf .mts .m2ts .avi .mkv .m4v .mpg .mpeg .3gp .insv .lrv`
- Recognised audio: `.wav .bwf .aif .aiff .mp3 .m4a .flac .aac .ogg .caf`

Keep each physical device in its own folder. SlingSync never tries to match two clips from the same device against each other, and it learns each device's clock separately.

### A folder that groups several devices

If a folder only holds other device folders, SlingSync splits it into one device per subfolder:

```
Shoot/
    Audio/
        Boom/          SHOOT4T01.wav …   → device "Audio - Boom"
        Ed Lav/        ED_0001.wav …     → device "Audio - Ed Lav"
        Matthew Lav/   Matthew_0001.wav … → device "Audio - Matthew Lav"
    B-roll/
        Cam A/         CAShoe_0533.MXF … → joins device "Cam A" (same camera, same file names)
    Cam A/
    Cam B/
```

It splits only when the folder has no media of its own, at least two subfolders contain media, none is a camera-card folder (`CONTENTS`, `PRIVATE`, `DCIM`, `CLIPS001`…), and the subfolders' files are **named differently** (`SHOOT4T…` vs `ED_…`). Cards from one camera share a naming pattern (`A001C002…`, `A002C001…`), so `Cam A/Card 1` and `Cam A/Card 2` stay one camera. A split-off subfolder with the same name and file naming as a top-level device (`B-roll/Cam A` and `Cam A`) joins it.

Why it matters: on a real shoot with three recorders inside `Audio/`, treating them as one device hid each recorder's clock: 59 of 139 clips synced by sound and the timeline was 72 hours long. Split, 67 synced and the timeline was 24.5 hours.

### Loose files (no subfolders)

If the project folder has **no** device subfolders, SlingSync groups the files lying in it by their names instead:

| File names | Grouped as |
|---|---|
| `A005C002_….mp4`, `A006C001_….mp4` | Cam A |
| `B016C002_….mp4` | Cam B |
| `INTVW1T01.wav`, `INTVW1T02.wav` | INTVW1T |
| `DJI_0143.MP4`, `DJI_0144.MP4` | DJI |

Check the device list before you click **Sync**. If the grouping is wrong, put the files into subfolders, which always takes priority. When subfolders exist, loose files next to them (such as an export) are ignored.

### Proxies

SlingSync recognises Premiere-style proxies (`…_Proxy.mov`, `…_proxy.mp4`, usually in a `Proxies` folder):

- **Original and proxy both present:** the proxy is skipped and the original is used.
- **Only the proxy present:** the proxy is used. The sequence will then point at the proxy files.

A proxy's own file date is when it was transcoded, so SlingSync never uses it. Many proxies still carry the original shoot date or the camera's timecode inside them, and those are used. A proxy with no usable date that shares no sound with another device is parked at the end of the timeline (red) instead of being placed at a wrong time.

## 3. Sync

1. Open SlingSync and drop the project folder on the window (or click **Choose Folder…**).
2. Check the device table: name, number of files, Camera or Audio, channel count, and whether proxies are being used. If there were no subfolders, the devices were guessed from file names, so make sure they're right.
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

**Next shooting day:** click **Sync Another Folder** in the results, or **New Sync** at the top (**File → New Sync**, ⌘N). This clears the window but keeps your options. You can also just drop another folder on the window at any time.

**Help:** the **Help** button (or **Help → SlingSync Quick Guide**) opens a short guide inside the app. The Help menu also links to this user guide, troubleshooting, and a page for reporting problems. **About SlingSync** is in the SlingSync menu.

## 4. Import into Premiere

**File → Import…** and choose `<project name>_synced.xml` in the project folder. Premiere creates a sequence that links to the media files in place: your originals, or the proxies if only proxies were in the folder. Don't move or rename the media before importing.

### Sequence layout

- Each device gets its own video track (cameras) and one audio track **per channel**, in device-folder order.
- If clips on one device overlap in time (e.g. two cards from the same camera, or a misnamed folder), that device gets extra *lanes*, i.e. extra tracks. This usually means something worth checking.
- Video and audio of the same clip are linked.
- Clips that were not synced by sound get a **label colour**:

| Colour | Status | Meaning |
|---|---|---|
| (none) | synced | Lined up by sound with at least one other device. Separate scenes are positioned relative to each other by device clocks, but within a scene everything is synced by sound |
| Orange | placed by date | Shares no sound with another device (cutaways, drone, a camera rolling while the recorder was off). Positioned by its device's clock (recorder clock, timecode or file date), corrected using the nearest sound-synced clip from the same device. The report says how far away that check was, or that the clock is a guess (e.g. a drone with no audio) |
| Red | NOT PLACED | No usable sound and no usable date. Parked after the end of the timeline |

## 4b. Audio only: podcasts, music, interviews (no Premiere needed)

Tick **Also export audio files** before you click **Sync** (command line: `--audio`). Besides the XML, SlingSync writes a `<project>_audio` folder with **one WAV file per microphone/channel**:

```
Podcast Ep 12_audio/
    Zoom H6 - ch1.wav
    Zoom H6 - ch2.wav
    Phone - ch1.wav
    Cam A - ch1.wav
```

Drop **all of them at the very start (0:00) of the timeline** in any audio editor: Audacity, Reaper, Logic, Pro Tools, Descript, GarageBand, or Premiere/Resolve too. They line up to the audio sample. Gaps where a device wasn't recording are silence, and every file has the same length.

- No video is needed: a folder of recorder, phone and laptop recordings works the same way. Video files contribute their audio.
- Files are 24-bit WAV at the project's most common sample rate (usually 48 kHz). Channels that are silent in every file of a device are left out, as on the Premiere timeline.
- **Size:** about 0.5 GB per hour of timeline per channel. A single WAV can't exceed 4 GB (about 7.7 hours at 48 kHz), so for very long days sync each part separately.
- **Mics at different distances** hear the same voice a few milliseconds apart (sound travels about 1 m every 3 ms). SlingSync keeps each microphone's natural timing. If you mix two mics on the same voice and it sounds hollow, nudge one by a few milliseconds or use only the closest mic.
- Clips with no shared sound are placed by their device's clock, exactly as in the XML (see the report).

## 4c. Compact timeline: the whole day as one block (review, transcripts)

Tick **Also make a compact timeline** (desktop app), use **Compact Timeline…** (Premiere Pro plug-in) or `--compact` (command line). SlingSync writes a second XML, `<project>_compact.xml`, next to the normal one: the same sync, but every stretch where **nothing** was recording (no camera, no recorder) is cut out, so the day plays as one continuous block with no black gaps.

- Clips that overlap stay in sync with each other: each block of overlapping recordings moves as one piece, by whole frames.
- Your normal synced sequence is unchanged; the compact one is separate.
- Use it to send reviewers a shorter version of everything recorded that day, or to make a single transcript. Example: a 5-hour shooting day with 1 h 27 min of actual recording becomes a 1 h 27 min sequence.

## 4d. Left out: tiny silent recordings

Audio-only files shorter than 10 seconds with no usable sound (a recorder started and stopped by accident) are left off the timeline and listed at the end of the report under *Left out of the timeline*. Camera clips are never left out.

## 5. The report

`SlingSync_report.txt` is written next to the XML. It contains:

- A summary count per status, sequence frame rate and track counts.
- **Tracks per device**: lanes and which channels were kept.
- **CHECK THESE BY EYE**: every clip not synced by sound, with its timeline position.
- **Device clocks**: for each device, whether its clock was steady, changed during the shoot (e.g. cameras re-jammed at lunch), or is a guess. This is how far you can trust orange clips.
- **Clock drift**: how far each pair of long clips drifts apart, and whether that matters.
- **Inconsistent matches**: pairs of clips whose sound match disagrees with the final solution by more than 80 ms. Usually harmless (e.g. repeated music), but look here if something is off.
- **Silent channels** per file, and which channels were used for syncing.
- **Unreadable files** that were skipped.
- **All clips** with their timeline position and status.

### Clock drift on long takes

Cameras and recorders run at very slightly different speeds. Over a long take they drift apart by a few milliseconds every 10 minutes. SlingSync measures this and lines the clips up at the middle of the take, so the ends are off by only half the drift. The report's **Clock drift** section lists each pair and says whether it's fine. Anything under one frame of total drift is invisible in practice.

Positions in the XML are whole frames, so any clip can also be up to half a frame off (20 ms at 25 fps).

## 6. Re-running

Audio analysis is cached in a hidden `.slingsync_cache` folder inside the project. Changing options and syncing again is fast. The cache is keyed on each file's path, size, modification time, reference channel and silence thresholds, so changed files are re-analysed automatically. Delete the folder when the project is finished to reclaim space (it holds an 8 kHz mono copy of every clip's audio).

## Tips for good results

- Have every camera record scratch audio, even a poor-quality on-camera mic.
- Short clips (under ~1 second of overlap) can't be fine-tuned and are less reliable.
- Set camera and recorder clocks roughly right before the shoot, or jam timecode. Clips with no shared sound are positioned from these clocks. A clock that is wrong but *consistent* is fine, because SlingSync measures the error against the clips that did sync. If you re-jam or reset a clock mid-shoot, that's handled too.
- Steady noise (fans, air-con, wind) alone is hard to match. Speech, music and handling sounds match well.
- Sync original files when you can: their dates and channels are complete, and the sequence points at them.
- Work from an SSD or a reliable drive. Bus-powered USB hard drives can disconnect under sustained reading.
