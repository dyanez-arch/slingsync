# Troubleshooting

**"No device subfolders found"**
The folder you chose has no subfolders. Choose the folder *above* your device folders, not a device folder itself.

**"No video or audio files found in the device subfolders"**
None of the files have a recognised extension. See the list in the [user guide](user-guide.md#2-set-up-the-project-folder). Hidden files and folders (starting with `.`) are skipped.

**macOS says the app is damaged or can't be opened**
The app isn't notarised. Right-click → **Open**, or **System Settings → Privacy & Security → Open Anyway**. If macOS still refuses, run `xattr -dr com.apple.quarantine /Applications/SlingSync.app` in Terminal.

**A clip is "placed by date" but it clearly has sound**
- The other devices may not have been recording at the same time. Check the report for gaps.
- The sound may be too repetitive (music, machinery) to give a single clear offset.
- Try **Sync using → Only channel N** on the recorder to pick a mic closer to what the cameras hear, or the reverse.
- On the CLI, try a lower `--min-votes` (e.g. `8`). This finds more matches, but risks false ones.

**A whole block is in the wrong place**
Yellow (*block placed by date*) clips are only as accurate as the device clocks. Move the block by hand in Premiere. Every clip inside it is still synced to the others in the block.

**Wrong matches (a clip clearly misaligned but not flagged)**
Look at **Inconsistent matches** in the report. Raise `--min-votes` (e.g. `20`) on the CLI, or set a reference channel that avoids shared music or PA sound.

**A device has more tracks than expected (extra lanes)**
Clips from that device overlap in time. This usually means files from two different devices are in one folder, or the same files were copied twice. Separate them into their own folders.

**A channel I need is missing from the timeline**
It was judged silent in every file of that device. Untick **Leave out channels that are silent in every file of a device**, or use `--keep-silent`.

**Media offline in Premiere**
The XML uses absolute paths. Import it before moving or renaming the media or the drive. If you've moved things, re-run SlingSync from the new location.

**Results didn't change after changing files**
The cache is keyed on file size and modification time, so this should be rare. Tick **Re-analyse everything** or use `--clear-cache`.

**Sync is slow**
The first run decodes every file twice. Later runs reuse the cache. On the CLI, `--workers` controls parallel analysis. Fast local storage helps more than CPU.
