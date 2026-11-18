# Testing log

What has actually been run, on what, and what hasn't been tested yet. Newest first. Each entry names the SlingSync version or build it was run with (see the [changelog](../CHANGELOG.md)).

## 2026-11-17: Installed app (test DMG from GitHub Actions) + Kishorn shoot, 111 clips: ✅ verified in Premiere

**Build:** 1.1.0b1 (Actions run 44207696385, shown as "1.0.0" in the app).

**App install (Dani, Apple Silicon Mac):** downloaded the test build artifact from GitHub Actions and dragged it to Applications. On first launch macOS showed its "can't verify… free of malware" warning with **Move to Trash / Done**. Clicked Done, then **System Settings → Privacy & Security → Open Anyway**, and it opened. Right-click → Open was not needed or offered. The README's first-launch steps were rewritten from this.

**Kishorn Pens AM** (a shoot SlingSync had never seen), synced from the installed app. Proxies, 5 devices: Audio 12 WAVs, Cam A 29, Cam B 58, Drone 10 (no audio), GoPro 2 chapters.
- 32 synced by sound, 79 placed by date, 0 not placed. One track per device.
- Device clocks: recorder, Cam A and Cam B each checked against sound 7 to 15 times, all within 0.0 s. GoPro checked once. Drone is a guess.
- Clock drift on long takes: at most ±8 ms at the ends ("fine").
- Progress bar and results worked in the app. **Premiere: "looks great"** (Dani).

**App UI additions tested offscreen** (window driven by script, screenshots checked): logo in header and About, New Sync / Sync Another Folder reset the window and a new folder loads and syncs, Help menu and quick guide, About box. A locally built `.app` contains the logo at the path the app reads it from and launches. **Not yet tried by hand** in the installed app.

## 2026-11-17: Scotland site visit, 131 clips, 5 devices: ✅ verified in Premiere

**Build:** run from source (development code between 1.0.0 and 1.1.0b1).

**Media:** device subfolders on an SSD, all proxies (no originals present):

| Device | Clips | Audio | Dates found |
|---|---|---|---|
| `Audio/` | 17 BWF WAVs | 3 ch | recorder clock |
| `Cam A/` | 53 proxies | 8 ch (1 live) | timecode only |
| `Cam B/` | 36 proxies | 8 ch (1 live) | timecode only |
| `Drone/` | 20 DJI proxies | none | original creation date carried into proxy |
| `GoPro/` | 5 chapters of one recording | 2 ch | timecode + one shared creation date |

**Result:** 57 clips synced by sound, 74 placed by date, one track per device. 7 min first run, about 11 s re-run from the cache, 1.6 GB peak memory.

**What the clocks showed (and SlingSync now handles):**
- Recorder clock steady all day (checked 17 times against sound, 0.0 s error).
- Cam A and Cam B ran different timecode in the morning and were jammed to the recorder at about 17:10. Detected as a clock change. Morning clips are placed using the morning setting.
- GoPro steadily 62 min behind (within 1.2 s).
- Drone: no audio, so its clock is a guess.
- One false match (Cam A `0427` ↔ GoPro, 13 votes) contradicted the clocks by 45 min and was dropped.

**Fixed during this test:** timecode as a date source, proxy dates carried over from originals, wall-clock time zones, record-run versus chapter detection, clock changes mid-shoot, weak-match rejection, sub-second overlaps of back-to-back clips, simpler statuses.

**Premiere (checked by Dani):** all good. Sound-synced scenes, morning clips, GoPro chapters, Drone position and orange clips all as expected.

## 2026-11-17: Interview, 2 cameras + polyWAV recorder: ✅ verified in Premiere

**Build:** run from source (development code between 1.0.0 and 1.1.0b1).

**Media:** 4 loose files in one folder (no device subfolders), on an internal-class SSD (APFS, PCIe):

| File | What | Length | Audio |
|---|---|---|---|
| `A005C002_260914TO_proxy.mp4` | Cam A proxy (no original present) | 79 min | 2 ch |
| `B016C002_260914DP_proxy.mp4` | Cam B proxy (no original present) | 79 min | 2 ch |
| `INTVW1T01.wav` | Recorder, BWF | 70 s | 5 ch |
| `INTVW1T02.wav` | Recorder, BWF | 79 min | 5 ch |

**Result**
- Devices auto-grouped correctly: Cam A, Cam B, INTVW1T.
- All three devices matched by sound, 12,600 to 18,000 votes per match. The three offsets agree with each other to within 3 ms.
- Clock drift over 79 min: camera vs recorder about 11 to 13 ms, camera vs camera about 2.5 ms. Reported as "fine".
- `INTVW1T01` (no camera rolling) was placed 89 s before `INTVW1T02` using the recorder's BWF clock, which matches the recorder's own timestamps.
- 28 s total on an Apple Silicon Mac with 32 GB RAM, about 2.7 GB peak memory.
- **Premiere:** imported without errors. One track per channel, video and audio linked, label colour shown, lip sync correct start to end (checked by Dani).

**Fixed during this test:** loose-file grouping, proxy-only folders, drift-tolerant refinement.

**Re-run after the Scotland changes (same day):** identical positions (to the millisecond). Also run in the app window (offscreen): the device list showed Cam A / Cam B as proxies and the "devices were guessed from file names" warning appeared. The sync completed with the same result. Before the fix, both camera↔recorder matches fell back to the coarse 16 ms result.

## 2026-11-17 (late): 1.2.0b1 installed app: ✅ (Dani)

**Build:** 1.2.0b1 test build (Actions run 44219903752, commit `0e4f9b3`).
- **About** shows the real version and build stamp, the first build to do so.
- **Audio export** from the app (checkbox, then **Show Audio Files**): the WAVs lined up in an audio editor.
- **Cancel** stopped promptly on a folder that hadn't been synced before.
- Not yet tested: the Premiere Pro plug-in.

## 2026-11-17 (evening): Night shoot, re-run from the installed app: ✅ worked (Dani)

**Build:** 1.1.0b2 test build (the app and report still showed "1.0.0"). Same WD Elements USB drive and original Sony MXF files as the incomplete run below (85 media files, about 135 GB).

**Result:** the drive stayed connected for the whole run. 91 clips placed: 8 synced by sound, 83 placed by date, none unplaced, one track per device. The recorder only covers about 6 minutes of the night, so most camera clips have no sound partner and are placed by clock.
- Device clocks: recorder checked against sound 4 times and Cam B 3 times, both within 0.0 s. Cam A checked once. Drone (no audio) is a guess.
- `CAShoe_0747`, misjudged as silent in this morning's first run, was correctly analysed as steady ambience.
- Dani: "worked perfect".

## 2026-11-17: Night shoot, 2 cameras + recorder + drone: ⚠️ incomplete

**Build:** run from source (development code between 1.0.0 and 1.1.0b1).

**Media:** device subfolders on a bus-powered USB hard drive (WD Elements, exFAT):
- `Audio/`: 5 BWF WAVs, 3 ch, about 6 min total
- `Cam A/`, `Cam B/`: 31 + 49 Sony XAVC MXF (4K 25p, 8 mono audio tracks, only ch 1 live), each with a `Proxies/` folder
- `Drone/`: 6 DJI MP4s with no audio, plus `Proxies/`

**Found**
- Premiere `Proxies/` folders were being treated as duplicate clips. Fixed.
- Camera ch 1 is steady night ambience (about 3 dB of variation) and was being discarded as a dead channel, so the cameras had nothing to sync with. Fixed.
- With no sound links, every device except one ended up NOT PLACED. Fixed: devices are now placed by their own dates.
- Cam A's clock is set to January 2020. Handled by the per-device clock model and the new fallback.
- **The drive disconnected twice mid-run** ("Device not configured"), both times during the 8 GB `CAShoe_0754.MXF`. The file plays fine in VLC, so this is most likely the bus-powered drive dropping out under sustained reads. SlingSync now stops with a clear message when this happens.

**Not yet verified:** the sync result for this shoot. It needs a rerun on stable storage.

## Premiere Pro plug-in (2026-11-17 / 18, Premiere Pro 2027)

The plug-in's JavaScript engine is checked against the desktop app's engine with `premiere-plugin/tests/compare_sync.py` (both engines on the same shoot, output to a temporary folder, nothing written to the shoot) and `compare_decode.py` (decoding, sample by sample).

| Test | Result |
|---|---|
| Feasibility in Premiere (plug-in 0.3): read a 2 GB recorder WAV directly | ✅ 3.8 h of audio in 17.5 s |
| Media Encoder as decoder | ✅ works, slow (3 min clip in 79 s): last resort only |
| JavaScript speed (spectrogram) | ✅ ~5 s per hour of audio |
| Built-in audio decoder (Web Audio) | ❌ not in UXP |
| WebAssembly | ✅ (synchronous loading; asynchronous loading hangs) |
| FFmpeg 7.1.1 WebAssembly decoder vs app, 21 files (MXF, MP4/MOV, WAV, AIFF, MP3, AAC, FLAC, Opus, AC-3, no-audio files) | ✅ identical channels, length and timing; samples within 0.000001 |
| Decoder inside Premiere (Test 6): 4K Canon MXF, 8 tracks + timecode | ✅ same speed as the app on the same USB drive (both ~14 s per 48 s of 4K footage: the drive is the limit) |
| Kishorn (111 clips, 5 devices, proxies): plug-in engine vs app | ✅ XML and compact XML byte-identical, report identical apart from the version line |
| Synthetic project | ✅ identical, every clip at its known position |
| Kishorn synced **inside Premiere** by the plug-in (0.6), no app | ✅ |
| Mark Borthwick (loose files) | Found a bug (also in the app): the earlier audio export's `_audio` folder was taken for a device, so the cameras were dropped (no video). Fixed; now 3/3 synced, 2 video + 9 audio tracks, identical in both engines |
| Compact timeline engine (Kishorn) | ✅ 5 h 03 → 1 h 27, 52 blocks, sync kept in every block, 0-frame gaps, identical in both engines |
| **Compact Timeline in Premiere** (plug-in 0.10.2) on Devon Night 2 | ✅ 181 clips, 47 blocks, 135.1 → 59.6 min, every clip where planned, original unchanged. Needed: actions created inside `lockedAccess` + `executeTransaction`, fresh objects after every edit |
| Plug-in audio-file export vs app (synthetic) | ✅ same length and positions; samples within 1 least-significant bit (−138 dB) |
| Grouped device folders (Audio/Boom, Audio/Ed Lav…), scan of 14 shoots, app vs plug-in | ✅ only the 3 shoots with grouped folders change; both engines split identically, same files in the same order |
| Devon 2nd Run with recorders split | ✅ 67 synced (was 59), timeline 24.5 h (was 72 h). Found the app's `lsqr` stopping early (up to 6.8 ms off); exact solve: app and plug-in byte-identical again (also Kishorn, Borthwick, synthetic) |
| Devon 2nd Run (139 files: original 4K Canon MXF + 3 recorders, USB drive): plug-in engine vs app | ✅ XML and compact XML byte-identical; same status for all 139 clips; report identical except 5 clip times differing by 1 ms in the last digit (rounding). Plug-in engine 48 min for 139 files, app 19 min for the 55 files it hadn't cached (about the same per file: the USB drive is the limit) |

## Synthetic tests (run after each change)

Generated with known offsets: 3 devices, steady ambience plus sparse events, a dead "hiss" channel, a digitally silent channel.

| Case | Expected | Result |
|---|---|---|
| Recorder + Cam A linked by sound, Cam B shares no sound, correct clocks | All clips at true positions | ✅ exact |
| Same, Cam B clock 3 years off | Cam B starts at timeline start, spacing kept, flagged | ✅ |
| Cam A as proxies only, recorder with original + proxy | Recorder proxy skipped. Cam A proxies synced by sound. Unlinked proxy NOT PLACED with note | ✅ |

## Not tested yet

- [x] A many-clip shoot imported into Premiere (Scotland, above)
- [ ] Original camera files (MXF/MOV) rather than proxies, on a many-clip shoot
- [x] The built DMG: install, first launch, choose folder, progress, results (Kishorn, above)
- [x] Faster Cancel and version/build display, in the installed app (1.2.0b1)
- [x] Audio-only WAV export, in the installed app (1.2.0b1)
- [x] Cancel during a sync, in the installed app (1.1.0b1/b2: worked but took ~1 min to stop on long files; fixed in 1.1.0b3)
- [ ] New Sync / Help in the installed app (tested offscreen only; About confirmed in 1.2.0b1)
- [x] Premiere Pro 2027 plug-in loads (Window → UXP Plugins) via UXP Developer Tool after enabling developer mode (plug-in 0.1)
- [x] Plug-in sync inside Premiere with its own engine (Kishorn, Borthwick)
- [x] Compact Timeline in Premiere (Devon Night 2)
- [x] 1.2.0b2 DMG (run 44355109228) installs and shows version 1.2.0b2 (2026-11-18)
- [x] 1.2.0b2 app: Mark Borthwick syncs 3 of 3 with video (fix confirmed), and the compact timeline checkbox writes `…_compact.xml` (2026-11-18)
- [x] Plug-in `.ccx` (0.10.3) installs by double-click and works in Premiere 2027 (2026-11-18)
- [ ] Plug-in audio-file export inside Premiere (UXP `fs.write`)
- [ ] Plug-in *Import a synced folder* link
- [x] Plug-in engine on a large shoot of original camera files (Devon 2nd Run, identical to the app)
- [ ] First launch on a second Mac, recording macOS's exact wording
- [ ] Devon 23 Oct and Illminster synced with the new device split (scan checked only)
- [ ] Mixed frame rates in one project (23.976 / 25 / 29.97 / 50)
- [ ] Variable-frame-rate phone footage
- [x] Paths with a space and an accented character (`t remote é`, synthetic, from-source app): sync, XML, audio files, status file
- [ ] Paths with accented characters imported into Premiere
- [ ] Cameras that stamp the *end* of a recording (logic exists, not seen in real media yet; all devices so far stamp the start)
- [ ] Read-only drives and NAS shares (the cache is written inside the project folder)
- [ ] Very long multi-hour recorder files and memory use on 8 GB Macs
- [ ] Intel Macs
