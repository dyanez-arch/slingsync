// SlingSync plug-in engine: a whole sync, step by step (port of engine.run / engine.analyze /
// engine.scan_devices). All file access goes through `platform`, so the same code runs in
// Premiere (UXP file system) and in Node (tests):
//
//   platform = {
//     join(a, b), relPath(path, from),
//     listDir(path)            -> [{ name, isDir }]
//     stat(path)               -> { size, mtime, birthtime }   (seconds)
//     exists(path), mkdir(path),
//     open(path) -> handle,  readAt(handle, size, pos) -> Uint8Array,  close(handle)
//     readFile(path) -> Uint8Array,  writeFile(path, Uint8Array | string)
//     openWrite(path) -> handle,  writeAt(handle, Uint8Array, pos)      (audio export)
//     remove(path)                                                      (re-analyse)
//   }
//   media = SlingMedia instance whose read() calls platform.readAt
(function (root) {
  "use strict";
  const C = (typeof module !== "undefined" && module.exports) ? require("./core.js") : root.SlingCore;
  const { SR, CACHE_DIR, Cancelled } = C;
  const ANALYSIS_VERSION = "js1";   // part of the cache key; bump when analysis output changes
  const FRAME = Math.trunc(0.05 * SR), CHUNK = FRAME * 400;

  function fnv(s) {                                      // short stable hash for cache names
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }
  const fmtDate = (t) => {
    const d = new Date(t * 1000), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const pyList = (a) => "[" + a.join(", ") + "]";
  const tick = () => new Promise((r) => setTimeout(r, 0));   // let the plug-in redraw / see Cancel

  // ---- scanning (engine._media_files, engine.scan_devices) ----
  async function mediaFiles(P, folder, recursive = true) {
    const found = [];
    const walk = async (dir) => {
      const entries = await P.listDir(dir);
      const files = entries.filter((e) => !e.isDir).map((e) => e.name).sort();
      for (const fn of files) if (C.isMedia(fn)) found.push(P.join(dir, fn));
      if (!recursive) return;
      const dirs = entries.filter((e) => e.isDir && !C.skipDir(e.name)).map((e) => e.name).sort();
      for (const d of dirs) await walk(P.join(dir, d));
    };
    await walk(folder);
    return found;
  }

  // engine.CARD_DIRS / engine._split_group: a folder grouping several recorders or cameras
  // (Audio/Boom, Audio/Ed Lav) becomes one device per subfolder; camera cards stay together
  const CARD_DIRS = new Set(["contents", "clips001", "clips002", "private", "xdroot", "dcim", "avchd", "bdmv",
    "m4root", "clip", "stream", "video", "audio", "sub", "card", "misc"]);
  async function splitGroup(P, project, dname) {
    let entries;
    try { entries = await P.listDir(P.join(project, dname)); } catch (e) { return null; }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    if (entries.some((e) => !e.isDir && C.isMedia(e.name))) return null;
    const subs = entries.filter((e) => e.isDir && !e.name.startsWith(".") && !C.skipDir(e.name)).map((e) => e.name);
    const parts = [];
    for (const e of subs) {
      const files = await mediaFiles(P, P.join(P.join(project, dname), e));
      if (files.length) parts.push([e, files]);
    }
    if (parts.length < 2 || parts.some(([e]) => CARD_DIRS.has(e.toLowerCase()))) return null;
    const names = parts.map(([, files]) => new Set(files.map(C.looseDevice)));
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) if ([...names[i]].some((n) => names[j].has(n))) return null;
    }
    return parts.map(([e, files]) => [`${dname} - ${e}`, files]);
  }

  async function scanDevices(P, project) {
    const entries = await P.listDir(project);
    const devices = entries.filter((e) => e.isDir && !C.skipDir(e.name)).map((e) => e.name).sort();
    const found = new Map();
    for (const d of devices) {
      const files = await mediaFiles(P, P.join(project, d));
      if (C.isAudioExport(d, files)) continue;
      const group = await splitGroup(P, project, d);
      for (const [name, fs] of group || [[d, files]]) found.set(name, fs);
    }
    // 'B-roll/Cam A' is the same camera as 'Cam A' when its files are named the same way
    const namesOf = new Map([...found].map(([n, fs]) => [n, new Set(fs.map(C.looseDevice))]));
    for (const name of [...found.keys()]) {
      if (!name.includes(" - ")) continue;
      const sub = name.split(" - ").slice(1).join(" - ");
      if (found.has(sub) && devices.includes(sub) && [...namesOf.get(name)].some((n) => namesOf.get(sub).has(n))) {
        found.set(sub, found.get(sub).concat(found.get(name)));
        found.delete(name);
      }
    }
    const out = [];
    for (const [name, files] of found) {
      const entry = C.deviceEntry(name, files);
      if (entry.files.length) out.push(entry);
    }
    if (out.length) return out;
    const groups = new Map();
    for (const f of await mediaFiles(P, project, false)) {
      const k = C.looseDevice(f);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }
    return [...groups.keys()].sort().map((k) => C.deviceEntry(k, groups.get(k))).filter((e) => e.files.length);
  }

  // Devices with their channel counts, for the settings step (gui.ScanWorker / engine.device_channels)
  async function scanWithChannels(P, media, project) {
    const devs = await scanDevices(P, project);
    for (const d of devs) {
      let best = 0;
      for (const f of d.files.slice(0, 3)) {
        const info = await probe(P, media, f);
        if (info) best = Math.max(best, info.nch);
      }
      d.channels = best;
    }
    return devs;
  }

  // ---- probe ----
  async function probe(P, media, path) {
    let h = null;
    try {
      const st = await P.stat(path);
      h = await P.open(path);
      const info = await media.open(h, st.size);
      media.close();
      const fileDate = st.birthtime || (st.mtime - (info ? info.duration : 0));
      return C.probeFromInfo(info, path, fileDate);
    } catch (e) {
      return null;
    } finally {
      if (h !== null) try { await P.close(h); } catch (e) { /* ignore */ }
    }
  }

  // ---- analysis (engine.analyze): silent/flat channels, mono mix, fingerprint ----
  async function decodeAll(P, media, path, onBlock, checkCancel, rate = SR, chunk = CHUNK, onBlockAsync = null) {
    const st = await P.stat(path);
    const h = await P.open(path);
    try {
      const info = await media.open(h, st.size);
      if (!info) throw new Error("file could not be opened");
      const nch = media.start(rate);
      if (nch < 0) throw new Error("audio could not be decoded");
      // full blocks of CHUNK frames, last one partial (like engine._blocks)
      let pend = [], pendN = 0;
      const flush = async (n) => {
        const blk = new Float32Array(n * nch);
        let o = 0;
        while (o < n * nch) {
          const p = pend[0], take = Math.min(p.length, n * nch - o);
          blk.set(p.subarray(0, take), o);
          o += take;
          if (take === p.length) pend.shift(); else pend[0] = p.subarray(take);
        }
        pendN -= n;
        if (onBlockAsync) await onBlockAsync(blk, n, nch); else onBlock(blk, n, nch);
      };
      for (let k = 0; ; k++) {
        if (checkCancel && k % 8 === 0) checkCancel();
        if (k % 8 === 7) await tick();
        const b = await media.read(chunk);
        if (!b) break;
        pend.push(b.data); pendN += b.frames;
        while (pendN >= chunk) await flush(chunk);
      }
      if (pendN) await flush(pendN);
      return nch;
    } finally {
      media.close();
      await P.close(h);
    }
  }

  async function analyze(P, media, clip, cacheBase, refCh, silenceDb, flatDb, checkCancel) {
    const metaP = cacheBase + ".json", monoP = cacheBase + "_mono.f32", fpP = cacheBase + "_fp.bin";
    if (await P.exists(metaP) && await P.exists(fpP)) {
      const meta = JSON.parse(C.utf8Decode(await P.readFile(metaP)));
      if (meta.fp) {
        const b = await P.readFile(fpP), n = meta.fp_n;
        const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        meta.fp_h = new Int32Array(buf, 0, n); meta.fp_t = new Int32Array(buf, n * 4, n);
      }
      return meta;
    }
    const nch = clip.nch;
    // pass 1: per-channel loudness in 50 ms frames. Small files keep their audio in memory
    // so they're decoded once; long ones are decoded again for the mix (like the app).
    const keep = clip.duration * SR * nch * 4 < 256e6;
    const kept = [];
    const rms = Array.from({ length: nch }, () => []);
    let gotCh = nch;
    gotCh = await decodeAll(P, media, clip.path, (blk, n, ch) => {
      if (keep) kept.push([blk, n]);
      const m = Math.floor(n / FRAME);
      for (let f = 0; f < m; f++) {
        for (let c = 0; c < ch && c < nch; c++) {
          let s = 0;
          for (let i = f * FRAME; i < (f + 1) * FRAME; i++) { const v = blk[i * ch + c]; s += v * v; }
          rms[c].push(Math.sqrt(s / FRAME));
        }
      }
    }, checkCancel);
    const meta = { silent: [], used: [], levels_db: [], mono: null, fp: null, note: "" };
    const save = async () => {
      const m = Object.assign({}, meta);
      delete m.fp_h; delete m.fp_t;
      await P.writeFile(metaP, JSON.stringify(m));
    };
    if (!rms[0] || !rms[0].length) {
      meta.silent = Array.from({ length: nch }, (_, i) => i + 1);
      meta.note = "no decodable audio";
      await save();
      return meta;
    }
    const gains = new Float32Array(nch);
    const quiet = new Set(), flat = new Set();
    const db = rms.map((r) => r.map((v) => 20 * Math.log10(v + 1e-12)));
    for (let c = 0; c < nch; c++) {
      const p95 = C.percentile(db[c], 95), p10 = C.percentile(db[c], 10);
      meta.levels_db.push(C.pyRound(p95 * 10) / 10);
      if (p95 < silenceDb) quiet.add(c);
      else if (p95 - p10 < flatDb) flat.add(c);
    }
    if (flat.size && new Set([...quiet, ...flat]).size === nch) {
      meta.note = "only steady/low-dynamics sound in this file";
      flat.clear();
    }
    for (let c = 0; c < nch; c++) {
      if (quiet.has(c) || flat.has(c)) meta.silent.push(c + 1);
      else gains[c] = 1.0 / Math.pow(10, C.percentile(db[c], 90) / 20);
    }
    let used = [];
    for (let c = 0; c < nch; c++) if (gains[c] > 0) used.push(c);
    if (refCh && used.includes(refCh - 1)) used = [refCh - 1];
    else if (refCh) meta.note = `reference channel ${refCh} silent here, used the other channels`;
    meta.used = used.map((c) => c + 1);
    if (!used.length) {
      meta.note = meta.note || "all channels silent";
      await save();
      return meta;
    }
    // pass 2: equal-level mix of the live channels
    const w = new Float32Array(nch);
    for (const c of used) w[c] = Math.fround(gains[c] / used.length);
    const parts = [];
    let total = 0;
    const mix = (blk, n, ch) => {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (const c of used) if (c < ch) s += blk[i * ch + c] * w[c];
        out[i] = Number.isFinite(s) ? s : 0;
      }
      parts.push(out); total += n;
    };
    if (keep) for (const [blk, n] of kept) mix(blk, n, gotCh);
    else await decodeAll(P, media, clip.path, mix, checkCancel);
    const mono = new Float32Array(total);
    let o = 0;
    for (const p of parts) { mono.set(p, o); o += p.length; }
    await P.writeFile(monoP, new Uint8Array(mono.buffer));
    const fp = C.fingerprint(mono, checkCancel);
    const fpb = new Int32Array(fp.h.length * 2);
    fpb.set(fp.h, 0); fpb.set(fp.t, fp.h.length);
    await P.writeFile(fpP, new Uint8Array(fpb.buffer));
    meta.mono = monoP; meta.fp = fpP; meta.fp_n = fp.h.length; meta.mono_n = total;
    await save();
    meta.fp_h = fp.h; meta.fp_t = fp.t;
    return meta;
  }

  // ---- audio files (engine._Wav24, engine._safe, engine.export_stems) ----
  const WAV_LIMIT = 4 * 1024 ** 3 - 1024;            // plain WAV files can't exceed 4 GB

  // Streaming 24-bit mono WAV writer, same bytes as Python's wave module + engine._Wav24
  class Wav24 {
    constructor(P, path, rate) { this.P = P; this.path = path; this.rate = rate; this.n = 0; this.buf = []; this.bufN = 0; }
    async open() {
      this.h = await this.P.openWrite(this.path);
      await this.P.writeAt(this.h, this.header(0), 0);
      this.pos = 44;
    }
    header(dataBytes) {
      const b = new Uint8Array(44), v = new DataView(b.buffer);
      const tag = (o, t) => { for (let i = 0; i < 4; i++) b[o + i] = t.charCodeAt(i); };
      tag(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); tag(8, "WAVE"); tag(12, "fmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, this.rate, true); v.setUint32(28, this.rate * 3, true);
      v.setUint16(32, 3, true); v.setUint16(34, 24, true); tag(36, "data"); v.setUint32(40, dataBytes, true);
      return b;
    }
    async write(x) {                                  // Float32Array or null (= silence of length n)
      const out = new Uint8Array(x.length * 3);
      const hi = Math.fround(1.0 - 1.0 / 8388608);
      for (let i = 0, o = 0; i < x.length; i++, o += 3) {
        let v = x[i];
        if (v !== v) v = 0;                           // NaN -> 0 (nan_to_num); ±inf clip below
        v = v < -1 ? -1 : (v > hi ? hi : v);
        const q = C.pyRound(v * 8388608);             // numpy rounds half to even
        out[o] = q & 255; out[o + 1] = (q >> 8) & 255; out[o + 2] = (q >> 16) & 255;
      }
      this.n += x.length;
      this.buf.push(out); this.bufN += out.length;
      if (this.bufN >= 4 << 20) await this.flush();
    }
    async silence(n) {
      while (n > 0) { const k = Math.min(n, 1 << 20); await this.write(new Float32Array(k)); n -= k; }
    }
    async flush() {
      if (!this.bufN) return;
      const all = new Uint8Array(this.bufN);
      let o = 0;
      for (const b of this.buf) { all.set(b, o); o += b.length; }
      await this.P.writeAt(this.h, all, this.pos);
      this.pos += all.length; this.buf = []; this.bufN = 0;
    }
    async close() {
      await this.flush();
      if (this.n) await this.P.writeAt(this.h, this.header(this.n * 3), 0);
      await this.P.close(this.h);
    }
  }

  // engine._safe: keep letters/digits (any language) and " ._-()"
  const safeName = (name) => {
    const t = Array.from(name).map((ch) => (/[\p{L}\p{N}]/u.test(ch) || " ._-()".includes(ch) ? ch : "_")).join("").trim();
    return t || "device";
  };

  async function exportStems(P, media, clips, devices, laneInfo, outDir, rate, progress, checkCancel) {
    const say = progress || (() => {});
    const withAudio = clips.filter((c) => c.nch);
    if (!withAudio.length) return [];
    if (!rate) {                                    // most common source rate
      const cnt = new Map();
      for (const c of withAudio) cnt.set(c.samplerate, (cnt.get(c.samplerate) || 0) + 1);
      let best = -1;
      for (const [r, n] of cnt) if (n > best) { best = n; rate = r; }
    }
    const total = Math.ceil(Math.max(...withAudio.map((c) => c.start + c.duration)) * rate);
    if (total * 3 > WAV_LIMIT) {
      throw new Error(`The synced timeline is ${C.pyFixed(total / rate / 3600, 1)} hours long, which makes each ` +
        "audio file larger than the 4 GB WAV limit. Sync fewer days at once, or use the Premiere XML instead.");
    }
    const chansOf = new Map(laneInfo.map(([dname, , chans]) => [dname, chans]));
    if (!(await P.exists(outDir))) await P.mkdir(outDir);
    const jobs = [];
    devices.forEach((dname, d) => {
      const dc = withAudio.filter((c) => c.dev === d);
      const lanes = [...new Set(dc.map((c) => c.lane || 0))].sort((a, b) => a - b);
      for (const lane of lanes) {
        const lc = dc.filter((c) => (c.lane || 0) === lane).sort((a, b) => a.start - b.start);
        if (lc.length && (chansOf.get(dname) || []).length) jobs.push([dname, lane, lc]);
      }
    });
    const nLanes = new Map();
    for (const [dname] of jobs) nLanes.set(dname, (nLanes.get(dname) || 0) + 1);
    const files = [];
    let done = 0;
    const todo = jobs.reduce((s, j) => s + j[2].length, 0);
    for (const [dname, lane, lc] of jobs) {
      const chans = chansOf.get(dname);
      const suffix = nLanes.get(dname) > 1 ? ` (lane ${lane + 1})` : "";
      const names = chans.map((ch) => P.join(outDir, `${safeName(dname)}${suffix} - ch${ch}.wav`));
      const writers = names.map((p) => new Wav24(P, p, rate));
      for (const w of writers) await w.open();
      try {
        let pos = 0;
        for (const c of lc) {
          checkCancel();
          done++;
          say(done / Math.max(1, todo), `Writing audio files (${done}/${todo})`);
          const start = C.pyRound(c.start * rate);
          let skip = Math.max(0, pos - start);
          if (start > pos) { for (const w of writers) await w.silence(start - pos); pos = start; }
          let written = 0;
          const want = C.pyRound(c.duration * rate) - skip;
          try {
            await decodeAll(P, media, c.path, null, checkCancel, rate, rate * 10, async (blk, n, ch) => {
              let from = 0;
              if (skip) { const cut = Math.min(skip, n); from = cut; skip -= cut; }
              const m = Math.max(0, Math.min(n - from, want - written));
              if (!m) return;
              for (let k = 0; k < writers.length; k++) {
                const chI = chans[k] - 1, x = new Float32Array(m);
                if (chI < ch) for (let i = 0; i < m; i++) x[i] = blk[(from + i) * ch + chI];
                await writers[k].write(x);
              }
              written += m;
            });
          } catch (e) {
            if (e instanceof Cancelled) throw e;     // unreadable audio: leave silence
          }
          if (written < want) for (const w of writers) await w.silence(want - written);
          pos += want;
        }
        for (const w of writers) await w.silence(Math.max(0, total - pos));
      } finally {
        for (const w of writers) { try { await w.close(); } catch (e) { /* keep going */ } }
      }
      files.push(...names);
    }
    return files;
  }

  // Reads part of a clip's cached mono mix; zero outside the clip.
  function monoReader(P, path, len) {
    return async (start, n) => {
      const out = new Float32Array(n);
      const a = Math.max(0, start), b = Math.min(len, start + n);
      if (b > a) {
        const h = await P.open(path);
        try {
          const bytes = await P.readAt(h, (b - a) * 4, a * 4);
          const copy = new Uint8Array((b - a) * 4);
          copy.set(bytes.subarray(0, copy.length));
          out.set(new Float32Array(copy.buffer), a - start);
        } finally { await P.close(h); }
      }
      return out;
    };
  }

  // ---- the whole sync (engine.run) ----
  async function run(P, media, project, opts = {}) {
    const o = Object.assign({ refChannels: {}, fps: null, keepSilent: false, skipSilentClips: false,
      silenceDb: -60.0, flatDb: 3.0, minVotes: 12, output: null, name: null, cacheDir: null,
      reportPath: null, clearCache: false, compact: false, stems: false, stemsDir: null, stemsRate: null, version: "plug-in", progress: null, isCancelled: null, log: null }, opts);
    const outer = o.progress || (() => {});
    const say = o.stems ? (f, m) => outer(0.85 * f, m) : outer;   // last part of the bar: audio files
    const log = o.log || (() => {});
    const checkCancel = () => { if (o.isCancelled && o.isCancelled()) throw new Cancelled(); };
    const name = o.name || C.basename(project);
    say(0.0, "Looking for media...");
    const devs = await scanDevices(P, project);
    const devices = devs.map((d) => d.name);
    const files = [];
    devs.forEach((d, i) => d.files.forEach((f) => files.push([i, f])));
    if (!devs.length) throw new Error("No device subfolders found. Put each camera or recorder's files in its own subfolder inside the project folder.");
    for (const d of devs) {
      log(`Device ${d.name}: ${d.files.length} files (${d.camera ? "camera" : "audio"})` +
        (d.skipped_proxies ? `, skipped ${d.skipped_proxies} proxies (originals present)` : "") +
        (d.proxies_used ? `, using ${d.proxies_used} proxies (no originals)` : ""));
    }
    let clips = [];
    const skipped = [];
    for (let k = 0; k < files.length; k++) {
      if (k % 5 === 0) await tick();
      checkCancel();
      const [d, path] = files[k];
      const info = await probe(P, media, path);
      say(0.02 + 0.05 * (k + 1) / files.length, `Reading file info (${k + 1}/${files.length})`);
      if (!info) { skipped.push(path); continue; }
      Object.assign(info, { dev: d, idx: clips.length, name: C.basename(path), rel: P.relPath(path, project),
        proxy: C.proxyBase(path) !== null });
      clips.push(info);
    }
    if (!clips.length) throw new Error("None of the files could be read.");
    C.resolveDates(clips, devices.length);
    devices.forEach((dname, di) => {
      const dc = clips.filter((c) => c.dev === di);
      const srcs = new Map();
      for (const c of dc) srcs.set(c.date_src, (srcs.get(c.date_src) || 0) + 1);
      log(`Dates for ${dname}: ` + [...srcs].map(([k, v]) => `${v} ${k}`).join(", ") +
        (dc.some((c) => c.tc_mode) ? "  (timecode is record-run, not time of day: ignored)" : ""));
    });

    const cacheDir = o.cacheDir || P.join(project, CACHE_DIR);
    if (!(await P.exists(cacheDir))) await P.mkdir(cacheDir);
    if (o.clearCache) {                          // re-analyse: forget the plug-in's saved analysis
      for (const e of await P.listDir(cacheDir)) if (!e.isDir && e.name.startsWith("js-")) await P.remove(P.join(cacheDir, e.name));
      log("Saved analysis cleared: re-analysing every file");
    }
    const jobs = [];
    for (const c of clips) {
      c.silent = []; c.used = []; c.note = "";
      if (!c.nch) { c.note = "no audio"; continue; }
      const st = await P.stat(c.path);
      const r = o.refChannels[devices[c.dev]] || null;
      const key = `${ANALYSIS_VERSION}|${c.path}|${st.size}|${st.mtime}|${r}|${o.silenceDb}|${o.flatDb}`;
      jobs.push([c, P.join(cacheDir, "js-" + fnv(key)), r]);
    }
    let done = 0;
    for (const [c, cache, r] of jobs) {
      await tick();
      checkCancel();
      let meta;
      try {
        meta = await analyze(P, media, c, cache, r, o.silenceDb, o.flatDb, checkCancel);
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        if (!(await P.exists(project))) {
          throw new Error("The drive or folder went offline during the sync. Reconnect it and sync again: files already analysed are saved and won't be redone.");
        }
        meta = { note: `could not analyse audio (${e.message || e})` };
      }
      done++;
      c.silent = meta.silent || []; c.used = meta.used || []; c.note = meta.note || "";
      c.mono_path = meta.mono; c.mono_n = meta.mono_n || 0;
      if (meta.fp) { c.fp_h = meta.fp_h; c.fp_t = meta.fp_t; }
      say(0.07 + 0.70 * done / Math.max(1, jobs.length), `Analysing audio (${done}/${jobs.length})`);
      log(`  ${c.rel}: ${C.pyFixed(c.duration, 1)}s, ${c.nch} ch, levels dB ${meta.levels_db ? pyList(meta.levels_db.map((x) => x.toFixed(1))) : "None"}, ` +
        `silent ${pyList(c.silent)}, used ${pyList(c.used)}, ${c.fp_h ? c.fp_h.length : 0} hashes, ` +
        `date ${c.date ? fmtDate(c.date) : "-"} (${c.date_src})` + (c.note ? `, NOTE ${c.note}` : ""));
    }

    // engine.run: tiny silent recordings (no video, < EMPTY_MAX_S, nothing usable) are left out
    let leftOut = clips.filter((c) => !c.has_video && !(c.used && c.used.length) && c.duration < C.EMPTY_MAX_S);
    if (leftOut.length && leftOut.length < clips.length) {
      const out = new Set(leftOut);
      clips = clips.filter((c) => !out.has(c));
      clips.forEach((c, i) => { c.idx = i; });
      for (const c of leftOut) log(`  left out (silent, ${C.pyFixed(c.duration, 1)}s, no video): ${c.rel}`);
    } else leftOut = [];

    const edges = C.matchAll(clips, o.minVotes, 2.0, (f, m) => say(0.77 + 0.13 * f, m), checkCancel);
    for (let k = 0; k < edges.length; k++) {
      if (k % 5 === 0) await tick();
      checkCancel();
      const e = edges[k];
      if (k % 10 === 0) say(0.90 + 0.07 * k / Math.max(1, edges.length), `Fine-tuning sync (${k}/${edges.length})`);
      const A = clips[e.a], B = clips[e.b], coarse = e.off;
      [e.off, e.refined, e.drift_ms] = await C.refine(monoReader(P, A.mono_path, A.mono_n),
        monoReader(P, B.mono_path, B.mono_n), A.mono_n, B.mono_n, e.off);
      const sg = (x, d) => (x >= 0 ? "+" : "") + C.pyFixed(x, d);
      log(`  match ${A.rel} -> ${B.rel}: offset ${sg(e.off, 4)}s, ${e.votes} votes, ` +
        `${e.refined ? "refined" : "NOT refined"}, drift ${sg(e.drift_ms, 1)}ms (coarse ${sg(coarse, 3)}s)`);
    }
    say(0.97, "Building timeline...");
    log(`${edges.length} matches between devices`);
    const [conflicts, clock, dropped] = C.place(clips, edges, o.minVotes);
    for (const e of dropped) log(`  dropped weak match (contradicts device clocks): ${clips[e.a].rel} -> ${clips[e.b].rel} (${e.votes} votes)`);
    for (const e of conflicts) log(`  CONFLICT ${clips[e.a].rel} <-> ${clips[e.b].rel}`);
    for (const c of [...clips].sort((a, b) => a.start - b.start)) log(`  ${C.tc(c.start)}  ${c.status.padEnd(22)} ${c.rel}`);
    const firstCam = clips.find((c) => c.has_video);
    const seqFps = o.fps || (firstCam ? firstCam.fps : 25.0);
    const [xml, laneInfo, nv, na] = C.buildXml(clips, devices, name, seqFps, o.keepSilent, o.skipSilentClips);
    const out = o.output || P.join(project, `${name}_synced.xml`);
    await P.writeFile(out, xml);
    let compactXml = null;
    if (o.compact) {                             // one continuous block, no empty stretches
      const cc = C.compactClips(clips, seqFps);
      compactXml = P.join(out.slice(0, out.lastIndexOf("/")) || project, `${name}_compact.xml`);
      await P.writeFile(compactXml, C.buildXml(cc, devices, `${name} (compact)`, seqFps, o.keepSilent, o.skipSilentClips)[0]);
      const endOf = (cs) => Math.max(...cs.map((c) => c.start + c.duration));
      log(`Compact timeline: ${C.tc(endOf(cc))} (full day ${C.tc(endOf(clips))}) -> ${compactXml}`);
    }
    let stemFiles = [];
    const stemsDir = o.stemsDir || P.join(project, `${name}_audio`);
    if (o.stems) {
      stemFiles = await exportStems(P, media, clips, devices, laneInfo, stemsDir, o.stemsRate,
        (f, m) => outer(0.85 + 0.15 * f, m), checkCancel);
      for (const f of stemFiles) log(`  audio file: ${f}`);
    }
    const reportPath = o.reportPath || P.join(project, "SlingSync_report.txt");
    const [report, counts] = C.reportText({ version: o.version, name, seqFps, nv, na, clips, laneInfo, conflicts,
      skipped, edges, clock, devices, stems: o.stems ? [stemsDir, stemFiles] : null, leftOut, relPath: (p) => P.relPath(p, project) });
    await P.writeFile(reportPath, report);
    outer(1.0, "Done");
    const need = [...clips].sort((a, b) => a.start - b.start).filter((c) => c.status !== "synced")
      .map((c) => ({ status: c.status, file: c.rel, at: C.tc(c.start), note: c.note }));
    return { xml: out, report: reportPath, counts, need_check: need, files: clips.length, skipped, devices,
      video_tracks: nv, audio_tracks: na, fps: seqFps, clips, edges, compact_xml: compactXml,
      stems: stemFiles, stems_dir: o.stems ? stemsDir : null };
  }

  const api = { run, scanDevices, scanWithChannels, probe, analyze, exportStems, ANALYSIS_VERSION };
  root.SlingRun = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
