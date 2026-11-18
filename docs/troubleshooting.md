# Troubleshooting

**"No device subfolders found"**
The folder you chose has no subfolders. Choose the folder *above* your device folders, not a device folder itself.

**"No video or audio files found in the device subfolders"**
None of the files have a recognised extension. See the list in the [user guide](user-guide.md#2-set-up-the-project-folder). Hidden files and folders (starting with `.`) are skipped.

**macOS says the app is damaged or can't be opened**
The app isn't notarised. Right-click → **Open**, or **System Settings → Privacy & Security → Open Anyway**. If macOS still refuses, run `xattr -dr com.apple.quarantine /Applications/SlingSync.app` in Terminal.

**"The drive or folder went offline during the sync"**
The drive disconnected while SlingSync was reading it. Bus-powered USB hard drives can drop out under sustained full-speed reading even when normal playback is fine. Try a different cable or port (directly on the Mac, not a hub), a powered hub, or copy the shoot to an SSD. Sync again afterwards: finished files are cached and won't be re-read.

**A clip is "placed by date" but it clearly has sound**
- The other devices may not have been recording at the same time. Check the report for gaps.
- The sound may be too repetitive (music, machinery) to give a single clear offset.
- Try **Sync using → Only channel N** on the recorder to pick a mic closer to what the cameras hear, or the reverse.
- On the CLI, try a lower `--min-votes` (e.g. `8`). This finds more matches, but risks false ones.

**A scene or an orange clip is in the wrong place**
Positions between scenes come from device clocks. Look at **Device clocks** in the report. If a device's clock changed during the shoot, clips near the change may be off. Move them by hand in Premiere: clips within a scene stay synced to each other.

**Wrong matches (a clip clearly misaligned but not flagged)**
Look at **Inconsistent matches** in the report. Raise `--min-votes` (e.g. `20`) on the CLI, or set a reference channel that avoids shared music or PA sound.

**A device has more tracks than expected (extra lanes)**
Clips from that device overlap in time. This usually means files from two different devices are in one folder, or the same files were copied twice. Separate them into their own folders.

**A channel I need is missing from the timeline**
It was judged silent in every file of that device. Untick **Leave out channels that are silent in every file of a device**, or use `--keep-silent`.

**The report lists clock drift as "check the ends" or "OUT OF SYNC at the ends"**
Two devices drifted more than half a frame over a long take. Lip sync is right in the middle and slips towards the ends. Cut the clip around the point where it slips and nudge it, or split very long recordings.

**Devices were grouped wrongly (loose files)**
SlingSync guesses devices from file names when there are no subfolders. Put each device's files into its own subfolder and sync again.

**Media offline in Premiere**
The XML uses absolute paths. Import it before moving or renaming the media or the drive. If you've moved things, re-run SlingSync from the new location.

**Results didn't change after changing files**
The cache is keyed on file size and modification time, so this should be rare. Tick **Re-analyse everything** or use `--clear-cache`.

**Sync is slow**
The first run decodes every file twice. Later runs reuse the cache. On the CLI, `--workers` controls parallel analysis. Fast local storage helps more than CPU.
