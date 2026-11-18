// SlingSync panel engine: a whole sync, step by step (port of engine.run / engine.analyze /
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

  async function scanDevices(P, project) {
    const entries = await P.listDir(project);
    const devices = entries.filter((e) => e.isDir && !C.skipDir(e.name)).map((e) => e.name).sort();
    const out = [];
    for (const d of devices) {
      const entry = C.deviceEntry(d, await mediaFiles(P, P.join(project, d)));
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
  async function decodeAll(P, media, path, onBlock, checkCancel) {
    const st = await P.stat(path);
    const h = await P.open(path);
    try {
      const info = await media.open(h, st.size);
      if (!info) throw new Error("file could not be opened");
      const nch = media.start(SR);
      if (nch < 0) throw new Error("audio could not be decoded");
      // full blocks of CHUNK frames, last one partial (like engine._blocks)
      let pend = [], pendN = 0;
      const flush = (n) => {
        const blk = new Float32Array(n * nch);
        let o = 0;
        while (o < n * nch) {
          const p = pend[0], take = Math.min(p.length, n * nch - o);
          blk.set(p.subarray(0, take), o);
          o += take;
          if (take === p.length) pend.shift(); else pend[0] = p.subarray(take);
        }
        pendN -= n;
        onBlock(blk, n, nch);
      };
      for (let k = 0; ; k++) {
        if (checkCancel && k % 8 === 0) checkCancel();
        const b = await media.read(CHUNK);
        if (!b) break;
        pend.push(b.data); pendN += b.frames;
        while (pendN >= CHUNK) flush(CHUNK);
      }
      if (pendN) flush(pendN);
      return nch;
    } finally {
      media.close();
      await P.close(h);
    }
  }

  async function analyze(P, media, clip, cacheBase, refCh, silenceDb, flatDb, checkCancel) {
    const metaP = cacheBase + ".json", monoP = cacheBase + "_mono.f32", fpP = cacheBase + "_fp.bin";
    if (await P.exists(metaP) && await P.exists(fpP)) {
      const meta = JSON.parse(new TextDecoder().decode(await P.readFile(metaP)));
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
      reportPath: null, version: "panel", progress: null, isCancelled: null, log: null }, opts);
    const say = o.progress || (() => {});
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
    const clips = [], skipped = [];
    for (let k = 0; k < files.length; k++) {
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

    const edges = C.matchAll(clips, o.minVotes, 2.0, (f, m) => say(0.77 + 0.13 * f, m), checkCancel);
    for (let k = 0; k < edges.length; k++) {
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
    const reportPath = o.reportPath || P.join(project, "SlingSync_report.txt");
    const [report, counts] = C.reportText({ version: o.version, name, seqFps, nv, na, clips, laneInfo, conflicts,
      skipped, edges, clock, devices, stems: null, relPath: (p) => P.relPath(p, project) });
    await P.writeFile(reportPath, report);
    say(1.0, "Done");
    const need = [...clips].sort((a, b) => a.start - b.start).filter((c) => c.status !== "synced")
      .map((c) => ({ status: c.status, file: c.rel, at: C.tc(c.start), note: c.note }));
    return { xml: out, report: reportPath, counts, need_check: need, files: clips.length, skipped, devices,
      video_tracks: nv, audio_tracks: na, fps: seqFps, clips, edges };
  }

  const api = { run, scanDevices, probe, analyze, ANALYSIS_VERSION };
  root.SlingRun = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
