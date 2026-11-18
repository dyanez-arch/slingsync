// Temporary feasibility tests for a panel-only (no app) SlingSync engine in JavaScript.
// Each test writes plain-text results into #labOut so they can be screenshotted.
(function () {
  const ppro = require("premierepro");
  const { storage } = require("uxp");
  const lfs = storage.localFileSystem;
  const fs = require("fs");
  const out = document.getElementById("labOut");
  const log = (s) => { out.textContent += s + "\n"; out.scrollTop = out.scrollHeight; };
  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function btn(id, fn) {
    document.getElementById(id).addEventListener("click", async () => {
      out.textContent = " ";                                 // "" doesn't always clear in UXP
      try { await fn(); } catch (e) { log("ERROR: " + (e && e.stack ? e.stack : e)); }
    });
  }

  // Copy the whole log (to paste into a message instead of screenshots)
  document.getElementById("labCopy").addEventListener("click", async () => {
    const text = out.textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      log("\n(Log copied ✓)");
    } catch (e) {
      log("\n(Couldn't copy: " + e + ". Select the text and press ⌘C instead.)");
    }
  });

  // ---- Test 1: read a WAV in chunks, measure speed, per-channel level ----
  btn("labWav", async () => {
    const f = await lfs.getFileForOpening({ types: ["wav", "WAV", "bwf"] });
    if (!f) return;
    const path = f.nativePath;
    log("File: " + path);
    log("fs functions: " + Object.keys(fs).sort().join(", "));
    const t0 = now();
    let head;
    let fd = null;
    if (typeof fs.open === "function" && typeof fs.read === "function") {
      fd = await fs.open(path, "r");
      head = new ArrayBuffer(65536);
      await fs.read(fd, head, 0, 65536, 0);
      log("Ranged reads: available (fs.open/fs.read)");
    } else {
      log("Ranged reads: NOT available, reading whole file");
      head = await fs.readFile(path);
    }
    const dv = new DataView(head);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    log("Container: " + tag(0) + "/" + tag(8));
    let o = 12, ch = 0, rate = 0, bits = 0, dataOff = 0, dataLen = 0;
    while (o + 8 <= dv.byteLength) {
      const id = tag(o), size = dv.getUint32(o + 4, true);
      if (id === "fmt ") { ch = dv.getUint16(o + 10, true); rate = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); }
      if (id === "data") { dataOff = o + 8; dataLen = size === 0xffffffff ? f.size - dataOff : size; break; }
      o += 8 + size + (size & 1);
    }
    log(`Format: ${ch} ch, ${rate} Hz, ${bits}-bit, audio starts at byte ${dataOff}, ${(dataLen / 1e6).toFixed(0)} MB`);
    if (!dataOff || !fd) { log("Stopping here (no data chunk in first 64 KB, or no ranged reads)."); return; }
    const bps = bits / 8, frame = bps * ch, CH = 8 * 1024 * 1024 - ((8 * 1024 * 1024) % frame);
    const buf = new ArrayBuffer(CH);
    const sumsq = new Float64Array(ch);
    let pos = 0, frames = 0;
    const limit = Math.min(dataLen, 2e9);                  // read at most 2 GB for the test
    while (pos < limit) {
      const n = Math.min(CH, limit - pos);
      await fs.read(fd, buf, 0, n, dataOff + pos);
      const b = new Uint8Array(buf, 0, n);
      for (let i = 0; i + frame <= n; i += frame) {
        for (let c = 0; c < ch; c++) {
          const k = i + c * bps;
          let v;
          if (bps === 3) { v = (b[k] | (b[k + 1] << 8) | (b[k + 2] << 16)); if (v & 0x800000) v -= 0x1000000; v /= 8388608; }
          else if (bps === 2) { v = (b[k] | (b[k + 1] << 8)); if (v & 0x8000) v -= 0x10000; v /= 32768; }
          else { v = 0; }
          sumsq[c] += v * v;
        }
      }
      frames += Math.floor(n / frame);
      pos += n;
    }
    if (fs.close) await fs.close(fd);
    const secs = (now() - t0) / 1000;
    log(`Read + decoded ${(pos / 1e6).toFixed(0)} MB (${(frames / rate / 60).toFixed(1)} min of audio) in ${secs.toFixed(1)} s = ${(pos / 1e6 / secs).toFixed(0)} MB/s`);
    log("Level per channel (dBFS RMS): " + Array.from(sumsq).map((s) => (10 * Math.log10(s / frames + 1e-12)).toFixed(1)).join(", "));
  });

  // ---- Test 2: ask Media Encoder to convert a clip's audio to a 16 kHz mono WAV ----
  btn("labAme", async () => {
    const f = await lfs.getFileForOpening({ types: ["mxf", "MXF", "mp4", "MP4", "mov", "MOV", "wav", "WAV"] });
    if (!f) return;
    const em = ppro.EncoderManager.getManager();
    log("Media Encoder installed: " + em.isAMEInstalled);
    const preset = "/Applications/Adobe Premiere Pro 2027/Adobe Premiere Pro 2027.app/Contents/Settings/EncoderPresets/WAV_Mono_16bit_16kHz.epr";
    const data = await lfs.getDataFolder();
    const outPath = data.nativePath + "/labtest_" + now() + ".wav";
    log("Source: " + f.nativePath);
    log("Output: " + outPath);
    const t0 = now();
    let ok;
    try {
      ok = await em.encodeFile(f.nativePath, outPath, preset,
        ppro.TickTime.createWithSeconds(0), ppro.TickTime.createWithSeconds(86400), 0, true, true);
    } catch (e) {
      log("encodeFile threw: " + e);
    }
    log("encodeFile returned: " + ok + " after " + ((now() - t0) / 1000).toFixed(1) + " s. Waiting for the WAV…");
    let last = -1, stable = 0;
    for (let i = 0; i < 1200; i++) {                       // up to 10 minutes
      await sleep(500);
      let size = -1;
      try { size = (await fs.lstat(outPath)).size; } catch (e) { /* not there yet */ }
      if (i % 4 === 0) out.textContent = out.textContent.replace(/\nWaiting:.*$/, "") + `\nWaiting: ${((now() - t0) / 1000).toFixed(0)} s, file ${size < 0 ? "not created yet" : (size / 1e6).toFixed(1) + " MB"}`;
      if (size > 0 && size === last) { if (++stable >= 6) break; } else stable = 0;
      last = size;
    }
    if (last > 0) log(`\nWAV ready: ${(last / 1e6).toFixed(1)} MB after ${((now() - t0) / 1000).toFixed(1)} s (≈ ${(last / 32000 / 60).toFixed(1)} min of 16 kHz mono)`);
    else log("\nNo WAV appeared within 10 minutes. Is Media Encoder showing the job or an error?");
  });

  // ---- Test 4: does Premiere's JavaScript have a built-in audio decoder (MP3/AAC/etc.)? ----
  btn("labDecode", async () => {
    const g = globalThis;
    const has = (n) => { try { return typeof g[n] !== "undefined" ? typeof g[n] : "missing"; } catch (e) { return "error"; } };
    for (const n of ["AudioContext", "OfflineAudioContext", "webkitAudioContext", "AudioDecoder",
                     "EncodedAudioChunk", "WebAssembly", "Worker", "Blob", "URL", "Audio", "MediaSource"]) {
      log(n + ": " + has(n));
    }
    const Ctx = g.OfflineAudioContext || g.AudioContext || g.webkitAudioContext;
    if (!Ctx) { log("\nNo built-in audio decoder. (That's fine, there are other routes.)"); return; }
    log("\nA decoder exists. Pick a short compressed file (MP3, M4A, MP4)…");
    const f = await lfs.getFileForOpening({ types: ["mp3", "MP3", "m4a", "M4A", "mp4", "MP4", "mov", "MOV", "aif", "aiff", "wav"] });
    if (!f) return;
    log("File: " + f.nativePath);
    const t0 = now();
    const bytes = await fs.readFile(f.nativePath);
    log("Read " + (bytes.byteLength / 1e6).toFixed(1) + " MB in " + ((now() - t0) / 1000).toFixed(1) + " s");
    try {
      const ctx = Ctx === g.OfflineAudioContext ? new Ctx(1, 8000, 8000) : new Ctx();
      const t1 = now();
      const buf = await ctx.decodeAudioData(bytes);
      log(`Decoded: ${buf.numberOfChannels} ch, ${buf.sampleRate} Hz, ${(buf.duration / 60).toFixed(1)} min in ${((now() - t1) / 1000).toFixed(1)} s`);
    } catch (e) {
      log("decodeAudioData failed: " + e);
    }
  });

  // ---- Test 5: is WebAssembly usable (would let us run FFmpeg's audio decoders in the panel)? ----
  btn("labWasm", async () => {
    log("Test 5 v2. Loading a tiny WebAssembly module…");
    await sleep(50);
    const bytes = new Uint8Array([0,0x61,0x73,0x6d,1,0,0,0, 1,7,1,0x60,2,0x7f,0x7f,1,0x7f, 3,2,1,0, 5,3,1,0,1,
      7,13,2,3,0x61,0x64,0x64,0,0, 3,0x6d,0x65,0x6d,2,0, 10,9,1,7,0,0x20,0,0x20,1,0x6a,0x0b]);
    log("WebAssembly has: " + Object.getOwnPropertyNames(WebAssembly).join(", "));
    let instance = null;
    try {                                                    // way 1: synchronous
      log("Way 1: new WebAssembly.Module…");
      await sleep(50);
      const m = new WebAssembly.Module(bytes);
      log("  module OK, creating instance…");
      await sleep(50);
      instance = new WebAssembly.Instance(m, {});
      log("  instance OK");
    } catch (e) {
      log("  way 1 failed: " + e);
    }
    if (!instance) {                                         // way 2: asynchronous, with a timeout
      log("Way 2: WebAssembly.instantiate (10 s limit)…");
      await sleep(50);
      try {
        const r = await Promise.race([WebAssembly.instantiate(bytes),
                                      sleep(10000).then(() => { throw new Error("no answer after 10 s"); })]);
        instance = r.instance;
        log("  instance OK");
      } catch (e) {
        log("  way 2 failed: " + e);
      }
    }
    if (!instance) { log("\nWebAssembly is NOT usable here ❌"); return; }
    const { add, mem } = instance.exports;
    log("Loaded. Calling it 10 million times…");
    await sleep(50);
    let t = now(), s = 0;
    for (let i = 0; i < 1e7; i++) s = add(s, 1);
    log(`  result ${s} (should be 10000000) in ${now() - t} ms`);
    log("Growing its memory to 500 MB…");
    await sleep(50);
    t = now();
    mem.grow(8000);
    new Uint8Array(mem.buffer).fill(7);
    log(`  ${(mem.buffer.byteLength / 1e6).toFixed(0)} MB in ${now() - t} ms`);
    log("\nWebAssembly works ✅");
  });

  // ---- Test 6: the panel's own decoder (FFmpeg in WebAssembly) on any media file ----
  btn("labDecoder", async () => {
    log("Test 6. Pick any video or audio file…");
    const f = await lfs.getFileForOpening();
    if (!f) return;
    const path = f.nativePath;
    log("File: " + path);
    await sleep(50);
    const folder = await lfs.getPluginFolder();
    const wasmBytes = await fs.readFile(folder.nativePath + "/wasm/ssdec.wasm");
    log("Decoder loaded: " + (wasmBytes.byteLength / 1e6).toFixed(1) + " MB");
    const fd = await fs.open(path, "r");
    let reads = 0, bytes = 0;
    const read = async (h, size, pos) => {
      const ab = new ArrayBuffer(size);
      const r = await fs.read(fd, ab, 0, size, pos);
      const n = typeof r === "number" ? r : (r && typeof r.bytesRead === "number" ? r.bytesRead : size);
      reads++; bytes += n;
      return new Uint8Array(ab, 0, n);
    };
    const media = await SlingMedia.create({ factory: SSDec, wasmBytes, read });
    log("WebAssembly started.");
    const size = (await fs.lstat(path)).size;
    const t0 = now();
    const info = await media.open(1, size);
    if (!info) { log("FFmpeg could not open this file ❌"); return; }
    const aud = info.streams.filter((s) => s.type === "audio");
    const vid = info.streams.find((s) => s.type === "video");
    log(`Opened: ${info.format}, ${(info.duration / 60).toFixed(1)} min` +
        (vid ? `, video ${vid.width}x${vid.height} ${vid.fps.toFixed(3)} fps` : ""));
    log("Audio: " + (aud.length ? aud.map((s) => `${s.codec} ${s.channels}ch ${s.rate}Hz`).join(" + ") : "none"));
    const tags = Object.assign({}, info.tags, ...info.streams.map((s) => s.tags));
    for (const k of ["timecode", "creation_time", "date", "origination_date", "origination_time", "time_reference"]) {
      if (tags[k]) log(`  ${k}: ${tags[k]}`);
    }
    if (!aud.length) { media.close(); return; }
    const ch = media.start(8000);
    const sumsq = new Float64Array(ch);
    let frames = 0, last = now();
    for (let b; (b = await media.read(8000)); ) {
      for (let i = 0; i < b.data.length; i++) sumsq[i % ch] += b.data[i] * b.data[i];
      frames += b.frames;
      if (now() - last > 1000) {
        last = now();
        out.textContent = out.textContent.replace(/\nDecoding:.*$/, "") + `\nDecoding: ${(frames / 8000 / 60).toFixed(1)} min…`;
        await sleep(0);
      }
    }
    media.close();
    if (fs.close) await fs.close(fd);
    out.textContent = out.textContent.replace(/\nDecoding:.*$/, "");
    const secs = (now() - t0) / 1000;
    log(`Decoded ${(frames / 8000 / 60).toFixed(1)} min of audio (${ch} ch) in ${secs.toFixed(1)} s`);
    log(`Read ${(bytes / 1e6).toFixed(0)} MB of ${(size / 1e6).toFixed(0)} MB in ${reads} reads`);
    log("Level per channel (dBFS RMS): " + Array.from(sumsq).map((s) => (10 * Math.log10(s / frames + 1e-12)).toFixed(1)).join(", "));
    log("\nPanel decoder works ✅");
  });

  // ---- Test 3: JavaScript speed for the sync maths (FFT spectrogram) ----
  btn("labDsp", async () => {
    log("Test 3 started…");
    await sleep(50);                                        // let the panel redraw
    const SR = 8000, N = 512, HOP = 128, minutes = 1;
    const x = new Float32Array(SR * 60 * minutes);
    for (let i = 0; i < x.length; i++) x[i] = Math.random() - 0.5;
    log("Made 1 min of test audio. Analysing…");
    await sleep(50);
    const t0 = now();
    const re = new Float64Array(N), im = new Float64Array(N);
    const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    const rev = new Uint32Array(N);
    for (let i = 0, j = 0; i < N; i++) { rev[i] = j; let bit = N >> 1; while (j & bit) { j ^= bit; bit >>= 1; } j |= bit; }
    let frames = 0, acc = 0;
    for (let s = 0; s + N <= x.length; s += HOP) {
      for (let i = 0; i < N; i++) { re[rev[i]] = x[s + i] * win[i]; im[rev[i]] = 0; }
      for (let len = 2; len <= N; len <<= 1) {
        const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < N; i += len) {
          let cr = 1, ci = 0;
          for (let k = 0; k < len / 2; k++) {
            const a = i + k, b = a + len / 2;
            const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
            const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
          }
        }
      }
      acc += re[10]; frames++;
      if (frames % 500 === 0) {                             // show progress, keep Premiere responsive
        log(`  ${frames} FFTs, ${((now() - t0) / 1000).toFixed(1)} s`);
        await sleep(0);
      }
    }
    const secs = (now() - t0) / 1000;
    log(`Spectrogram of ${minutes} min of audio (${frames} FFTs) in ${secs.toFixed(2)} s`);
    log(`→ about ${(secs / minutes * 60).toFixed(1)} s per hour of audio for this step (${acc > 1e9 ? "" : "ok"})`);
  });
})();
