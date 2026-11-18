# Panel audio decoder (FFmpeg in WebAssembly)

The panel reads media with **FFmpeg 7.1.1**, the same version the desktop app uses through PyAV, compiled to WebAssembly so it runs inside Premiere's UXP JavaScript. Only audio parts are built: file readers (demuxers) and audio decoders, no video decoding.

| File | |
|---|---|
| `ssdec.c` | Small C layer the panel calls: open a file, list its streams and tags (timecode, dates, BWF recorder clock), decode all audio streams resampled to a given rate |
| `ssdec.js`, `ssdec.wasm` | The built decoder (about 2.4 MB) |

**Formats:** MP4, MOV, M4A, MXF, WAV/BWF/RF64, W64, AIFF, CAF, MP3, AAC, AC-3/E-AC-3, FLAC, Ogg, Matroska/WebM, MPEG-TS/MTS/M2TS, MPEG-PS, AVI, DV, ASF/WMA. **Audio codecs:** PCM (all common variants), AAC, MP3/MP2, AC-3/E-AC-3, FLAC, ALAC, Opus, Vorbis, WMA, SMPTE 302M, DV audio, IMA/MS ADPCM. The full list is in [`scripts/build_panel_wasm.sh`](../../scripts/build_panel_wasm.sh).

File bytes come from the panel's own file access (`js_read`), so only the parts of a file that are needed are read, even for very large camera files. UXP file reads are asynchronous, so the module is built with Emscripten's Asyncify.

**Rebuild:** `brew install emscripten`, then `bash scripts/build_panel_wasm.sh`. It downloads the FFmpeg source to `~/Library/Caches/slingsync-wasm` the first time.

**Status:** builds, and decodes identically to the desktop app (tested in Node, not yet inside Premiere). `premiere-panel/engine/media.js` is the JavaScript side.

**Checked against the app** with `premiere-panel/tests/compare_decode.py` (2026-11-18): same channel count, same length, no timing offset, sample differences ≤ 0.000001 (rounding), on 21 files:
- generated from a Devon recording: MP3, AAC in M4A/MP4/MKV, AIFF, FLAC, PCM in MOV, Opus in Ogg, AC-3
- real: Devon recorder WAV (5 ch) and Canon MXF from both cameras (8 ch); Kishorn recorder WAV, camera, GoPro and drone proxies (MP4/AAC; the drone has no audio and both agree); AIFF music; iPhone M4A; MP3; a MOV with no audio
- speed: 18 min of 5-channel WAV in 1.9 s (app 0.9 s), both reading from cache

## License

FFmpeg is licensed under the **GNU LGPL 2.1 or later**. This build uses only LGPL components (no `--enable-gpl`, no non-free parts). The exact source is FFmpeg 7.1.1 from <https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz>, configured and built by `scripts/build_panel_wasm.sh`; anyone can rebuild or replace the decoder with that script. SlingSync's own code (`ssdec.c` and the rest of the panel) is MIT.
