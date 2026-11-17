# Testing log

What has actually been run, on what, and what hasn't been tested yet. Newest first.

## 2026-11-17: Interview, 2 cameras + polyWAV recorder: ✅ verified in Premiere

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

**Fixed during this test:** loose-file grouping, proxy-only folders, drift-tolerant refinement. Before the fix, both camera↔recorder matches fell back to the coarse 16 ms result.

## 2026-11-17: Night shoot, 2 cameras + recorder + drone: ⚠️ incomplete

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

## Synthetic tests (run after each change)

Generated with known offsets: 3 devices, steady ambience plus sparse events, a dead "hiss" channel, a digitally silent channel.

| Case | Expected | Result |
|---|---|---|
| Recorder + Cam A linked by sound, Cam B shares no sound, correct clocks | All clips at true positions | ✅ exact |
| Same, Cam B clock 3 years off | Cam B starts at timeline start, spacing kept, flagged | ✅ |
| Cam A as proxies only, recorder with original + proxy | Recorder proxy skipped. Cam A proxies synced by sound. Unlinked proxy NOT PLACED with note | ✅ |

## Not tested yet

- [ ] A many-clip shoot (the night shoot above) on stable storage, imported into Premiere
- [ ] The built `.app` / DMG: install, Gatekeeper first launch, drag-and-drop, progress, cancel
- [ ] Mixed frame rates in one project (23.976 / 25 / 29.97 / 50)
- [ ] Variable-frame-rate phone footage
- [ ] Paths with accented characters
- [ ] Cameras that stamp the *end* of a recording (logic exists, not seen in real media yet)
- [ ] Read-only drives and NAS shares (the cache is written inside the project folder)
- [ ] Very long multi-hour recorder files and memory use on 8 GB Macs
- [ ] Intel Macs
