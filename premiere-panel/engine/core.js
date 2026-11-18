// SlingSync panel engine: the sync logic, ported from the desktop app's slingsync/engine.py.
// Pure computation (no file access), so it runs the same in Premiere (UXP) and Node (tests).
// Function names follow engine.py; keep the two in step when the sync logic changes.
(function (root) {
  "use strict";

  // ---- constants (engine.py) ----
  const SR = 8000, N_FFT = 512, HOP = 128, FRAME_S = HOP / SR;
  const BIN_LO = 13, BIN_HI = 225, PEAKS_PER_SEC = 25, FANOUT = 5, MAX_DT = 48, MAX_DF = 60;
  const BUCKET_CAP = 60;
  const VIDEO_EXT = new Set([".mp4", ".mov", ".mxf", ".mts", ".m2ts", ".avi", ".mkv", ".m4v",
    ".mpg", ".mpeg", ".3gp", ".insv", ".lrv"]);
  const AUDIO_EXT = new Set([".wav", ".bwf", ".aif", ".aiff", ".mp3", ".m4a", ".flac", ".aac", ".ogg", ".caf"]);
  const CACHE_DIR = ".slingsync_cache";
  const SKIP_DIRS = new Set(["adobe premiere pro auto-save", "adobe premiere pro video previews",
    "adobe premiere pro audio previews", CACHE_DIR]);
  const PROXY_SUFFIXES = ["_proxy", " proxy", "-proxy"];

  class Cancelled extends Error { constructor() { super("Cancelled"); this.name = "Cancelled"; } }

  // ---- Python-compatible helpers ----
  // round() with ties to even, like Python
  function pyRound(x) {
    const r = Math.round(x);
    return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
  }
  // f"{x:.{d}f}": exact binary value, ties to even (JS toFixed rounds ties up)
  function pyFixed(x, d) {
    let s = x.toFixed(d);
    const m = Math.pow(10, d), y = x * m;
    if (Number.isFinite(y) && Math.abs(y % 1) === 0.5 && Math.abs(y) < 2 ** 52) {
      s = (pyRound(y) / m).toFixed(d);
    }
    return s;
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  const ext = (p) => { const b = basename(p), i = b.lastIndexOf("."); return i > 0 ? b.slice(i).toLowerCase() : ""; };
  const basename = (p) => p.replace(/\/+$/, "").split("/").pop();
  const stemOf = (p) => { const b = basename(p), i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; };
  function median(a) {
    const s = Float64Array.from(a).sort(), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  // numpy.percentile, linear interpolation. Partially sorts a copy.
  function percentile(arr, q) {
    const a = Float64Array.from(arr), n = a.length;
    const pos = (n - 1) * q / 100, lo = Math.floor(pos), hi = Math.min(n - 1, lo + 1);
    const vlo = select(a, lo), vhi = hi === lo ? vlo : minFrom(a, lo + 1);
    return vlo + (vhi - vlo) * (pos - lo);
  }
  function minFrom(a, from) { let m = Infinity; for (let i = from; i < a.length; i++) if (a[i] < m) m = a[i]; return m; }
  function select(a, k) {                       // quickselect: a[k] in place, a[0..k-1] <= a[k] <= rest
    let l = 0, r = a.length - 1;
    while (r > l) {
      const pivot = a[(l + r) >> 1];
      let i = l, j = r;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) r = j; else if (k >= i) l = i; else break;
    }
    return a[k];
  }
  // linear least squares fit y = slope*x + mid (numpy.polyfit deg 1)
  function polyfit1(x, y) {
    const n = x.length;
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    const mx = sx / n, my = sy / n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
    const slope = sxx ? sxy / sxx : 0;
    return [slope, my - slope * mx];
  }

  // ---- dates (engine.py: _parse_iso, _date_candidates, _parse_tc, resolve_dates) ----
  function localTs(y, mo, d, h = 0, mi = 0, s = 0, frac = 0) {
    const dt = new Date(y, mo - 1, d, h, mi, s);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt.getTime() / 1000 + frac;
  }
  function parseIso(s) {
    s = String(s).trim();
    if (s.includes(" ") && !s.slice(0, 11).includes("T")) s = s.replace(" ", "T");
    s = s.replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6})\d*)?)?)?)?$/);
    if (m) {
      const frac = m[7] ? Number("0." + m[7]) : 0;
      const v = localTs(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), frac);
      if (v !== null) return v;
    }
    const t = s.slice(0, 19);
    m = t.match(/^(\d{4})[-:](\d{1,2})[-:](\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    if (m) { const v = localTs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]); if (v !== null) return v; }
    m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) { const v = localTs(+m[1], +m[2], +m[3]); if (v !== null) return v; }
    return null;
  }

  function dateCandidates(tags, sr, fileDate) {
    const t = {};
    for (const [k, v] of Object.entries(tags)) t[k.toLowerCase()] = String(v);
    const out = {};
    let od = t.origination_date, otTag = t.origination_time;
    const ct = t.creation_time || "";
    const bwfStyle = ct.length === 8 && ct[2] === ":";
    if (!od && t.date && (t.time_reference || bwfStyle)) { od = t.date; otTag = otTag || ct; }
    if (od) {
      od = od.replace(/:/g, "-").slice(0, 10);
      const m = od.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      const base = m ? localTs(+m[1], +m[2], +m[3]) : null;
      if (base !== null) {
        if (t.time_reference && sr) {
          const tr = Number(t.time_reference);
          if (Number.isInteger(tr)) out.recorder = base + tr / sr;
        } else if (otTag) {
          const p = otTag.replace(/-/g, ":").split(":").slice(0, 3).map((x) => x.trim());
          if (p.length === 3 && p.every((x) => /^[+-]?\d+$/.test(x))) {
            out.recorder = base + (+p[0]) * 3600 + (+p[1]) * 60 + (+p[2]);
          }
        }
      }
    }
    if (!("recorder" in out)) {
      for (const k of ["com.apple.quicktime.creationdate", "creation_time", "date"]) {
        if (k in t) { const v = parseIso(t[k]); if (v) { out.meta = v; break; } }
      }
    }
    out.file = fileDate;
    return out;
  }

  function parseTc(s, fps) {
    if (!s) return null;
    const parts = String(s).replace(/;/g, ":").replace(/\./g, ":").split(":");
    if (parts.length < 4 || !parts.slice(0, 4).every((x) => /^\s*[+-]?\d+\s*$/.test(x))) return null;
    const [h, m, sec, f] = parts.slice(0, 4).map(Number);
    if (!(h >= 0 && h < 24 && m >= 0 && m < 60 && sec >= 0 && sec < 60)) return null;
    return h * 3600 + m * 60 + sec + f / Math.max(1, pyRound(fps || 25));
  }

  function localMidnight(ts) {
    const d = new Date(ts * 1000);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
  }

  function resolveDates(clips, nDevices) {
    for (const c of clips) {
      const d = c.dates;
      let meta = d.meta === undefined ? null : d.meta;
      if (c.proxy && meta !== null && meta > d.file - 86400) meta = null;
      c._meta = meta;
    }
    const days = new Map();
    for (const c of clips) {
      const ref = c.dates.recorder || c._meta;
      if (ref) { const k = localMidnight(ref); days.set(k, (days.get(k) || 0) + 1); }
    }
    let shootDay = localMidnight(946728000);
    if (days.size) { let best = -1; for (const [k, v] of days) if (v > best) { best = v; shootDay = k; } }
    for (let dev = 0; dev < nDevices; dev++) {
      const dc = clips.filter((c) => c.dev === dev && c.tc !== null && c.tc !== undefined).sort((a, b) => a.tc - b.tc);
      let recRun = false;
      if (dc.length >= 3) {
        let b2b = 0;
        for (let i = 0; i + 1 < dc.length; i++) if (Math.abs(dc[i + 1].tc - (dc[i].tc + dc[i].duration)) < 1.0) b2b++;
        if (b2b >= 0.7 * (dc.length - 1)) {
          const other = dc.map((c) => c._meta || (c.proxy ? null : c.dates.file)).filter((x) => x);
          const tcSpan = dc[dc.length - 1].tc + dc[dc.length - 1].duration - dc[0].tc;
          recRun = other.length >= 3 && (Math.max(...other) - Math.min(...other)) > 2 * tcSpan + 60;
        }
      }
      for (const c of clips) {
        if (c.dev !== dev) continue;
        const d = c.dates;
        const hasTc = c.tc !== null && c.tc !== undefined;
        c.tc_mode = recRun && hasTc ? "record run" : null;
        if (d.recorder) { c.date = d.recorder; c.date_src = "recorder clock"; }
        else if (hasTc && !recRun) {
          const ref = c._meta || (c.proxy ? null : d.file);
          const day = ref ? localMidnight(ref) : shootDay;
          const target = ref || day + c.tc;
          let best = null;
          for (const k of [-1, 0, 1]) {
            const x = day + k * 86400 + c.tc;
            if (best === null || Math.abs(x - target) < Math.abs(best - target)) best = x;
          }
          c.date = best; c.date_src = "timecode";
        } else if (c._meta) { c.date = c._meta; c.date_src = "file metadata"; }
        else if (!c.proxy) { c.date = d.file; c.date_src = "file date"; }
        else { c.date = null; c.date_src = "proxy (no usable date)"; }
      }
    }
  }

  // probe(): file info from the decoder's ss_info JSON (engine.probe)
  function probeFromInfo(info, path, fileDate) {
    if (!info) return null;
    const isAudioFile = AUDIO_EXT.has(ext(path));
    const vids = isAudioFile ? [] : info.streams.filter((s) => s.type === "video");
    const auds = info.streams.filter((s) => s.type === "audio");
    const durs = [info.duration || 0];
    for (const s of info.streams) if ((s.type === "video" || s.type === "audio") && s.duration) durs.push(s.duration);
    const duration = Math.max(...durs);
    if (!(duration > 0)) return null;
    const out = { path, duration, has_video: vids.length > 0,
      audio_streams: auds.map((s) => s.channels), samplerate: auds.length ? (auds[0].rate || 48000) : 48000 };
    out.nch = out.audio_streams.reduce((a, b) => a + b, 0);
    if (vids.length) {
      const v = vids[0];
      out.fps = v.fps || 25.0; out.width = v.width || 1920; out.height = v.height || 1080;
    }
    const tags = Object.assign({}, info.tags);
    for (const s of info.streams) for (const [k, v] of Object.entries(s.tags || {})) if (!(k in tags)) tags[k] = v;
    out.dates = dateCandidates(tags, out.samplerate, fileDate);
    out.tc = parseTc(tags.timecode, out.fps);
    return out;
  }

  // ---- FFT (radix-2, in place, complex) ----
  const fftCache = new Map();
  function fftTables(n) {
    let t = fftCache.get(n);
    if (t) return t;
    const rev = new Uint32Array(n);
    for (let i = 0, j = 0; i < n; i++) {
      rev[i] = j;
      let bit = n >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j |= bit;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    t = { rev, cos, sin };
    fftCache.set(n, t);
    return t;
  }
  // inverse=false: X[k] = sum x[j] e^{-2πijk/n}; inverse=true: no scaling (caller divides by n)
  function fft(re, im, inverse) {
    const n = re.length, { rev, cos, sin } = fftTables(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sgn = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const wr = cos[w], wi = sgn * sin[w];
          const a = i + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // ---- fingerprint (engine.fingerprint) ----
  // engine.py adds tiny noise from numpy's generator (seed 0); JavaScript can't reproduce
  // that stream, so this uses its own fixed generator. Fingerprints therefore differ very
  // slightly from the app's; refined offsets and placements are what must match.
  function gaussNoise(n) {
    const out = new Float32Array(n);
    let s = 0x9e3779b9 | 0;
    const u = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) + 0.5) / 4294967296; };
    for (let i = 0; i < n; i += 2) {
      const r = Math.sqrt(-2 * Math.log(u())), th = 2 * Math.PI * u();
      out[i] = r * Math.cos(th);
      if (i + 1 < n) out[i + 1] = r * Math.sin(th);
    }
    return out;
  }

  function fingerprint(x0, checkCancel) {
    const empty = { h: new Int32Array(0), t: new Int32Array(0) };
    if (x0.length < N_FFT * 8) return empty;
    const noise = gaussNoise(x0.length);
    const x = new Float32Array(x0.length);
    for (let i = 0; i < x.length; i++) x[i] = x0[i] + noise[i] * 1e-4;
    const win = new Float64Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N_FFT - 1));
    const nfr = 1 + Math.floor((x.length - N_FFT) / HOP);
    const NB = BIN_HI - BIN_LO, B = 4096, M = 8;
    const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
    let T = [], F = [], V = [];
    for (let b0 = 0; b0 < nfr; b0 += B) {
      if (checkCancel) checkCancel();
      const f0 = Math.max(0, b0 - M), f1 = Math.min(nfr, b0 + B + M), nf = f1 - f0;
      const S = new Float64Array(nf * NB);
      for (let fr = 0; fr < nf; fr++) {
        const s = (f0 + fr) * HOP;
        for (let i = 0; i < N_FFT; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
        fft(re, im, false);
        for (let k = 0; k < NB; k++) {
          const a = Math.hypot(re[BIN_LO + k], im[BIN_LO + k]);
          S[fr * NB + k] = 20 * Math.log10(a + 1e-6);
        }
      }
      // 11x11 maximum filter (separable), outside = -inf
      const tmp = new Float64Array(nf * NB), mx = new Float64Array(nf * NB);
      for (let fr = 0; fr < nf; fr++) {
        for (let k = 0; k < NB; k++) {
          let m = -Infinity;
          for (let j = Math.max(0, k - 5); j <= Math.min(NB - 1, k + 5); j++) { const v = S[fr * NB + j]; if (v > m) m = v; }
          tmp[fr * NB + k] = m;
        }
      }
      for (let fr = 0; fr < nf; fr++) {
        const lo = Math.max(0, fr - 5), hi = Math.min(nf - 1, fr + 5);
        for (let k = 0; k < NB; k++) {
          let m = -Infinity;
          for (let j = lo; j <= hi; j++) { const v = tmp[j * NB + k]; if (v > m) m = v; }
          mx[fr * NB + k] = m;
        }
      }
      const thr = Math.max(percentile(S, 60) + 3, -35.0);
      for (let fr = 0; fr < nf; fr++) {
        const t = fr + f0;
        if (t < b0 || t >= b0 + B) continue;
        for (let k = 0; k < NB; k++) {
          const v = S[fr * NB + k];
          if (v === mx[fr * NB + k] && v > thr) { T.push(t); F.push(k); V.push(v); }
        }
      }
    }
    if (T.length < 4) return empty;
    // keep the strongest PEAKS_PER_SEC peaks in each second
    const perSec = pyRound(1 / FRAME_S);
    let idx = T.map((_, i) => i);
    idx.sort((a, b) => (Math.floor(T[a] / perSec) - Math.floor(T[b] / perSec)) || (V[b] - V[a]) || (a - b));
    const keep = [];
    let curSec = -1, rank = 0;
    for (const i of idx) {
      const s = Math.floor(T[i] / perSec);
      if (s !== curSec) { curSec = s; rank = 0; }
      if (rank++ < PEAKS_PER_SEC) keep.push(i);
    }
    keep.sort((a, b) => (T[a] - T[b]) || (F[a] - F[b]) || (a - b));
    const t = Int32Array.from(keep, (i) => T[i]), f = Int32Array.from(keep, (i) => F[i]);
    const n = t.length, cnt = new Int32Array(n);
    const H = [], TT = [];
    for (let k = 1; k < 40; k++) {
      if (k >= n) break;
      for (let i = 0; i < n - k; i++) {
        const j = i + k, dt = t[j] - t[i], df = f[j] - f[i];
        if (dt > 0 && dt <= MAX_DT && Math.abs(df) <= MAX_DF && cnt[i] < FANOUT) {
          cnt[i]++;
          H.push((f[i] << 13) | ((df + MAX_DF) << 6) | dt);
          TT.push(t[i]);
        }
      }
    }
    return { h: Int32Array.from(H), t: Int32Array.from(TT) };
  }

  // ---- matching (engine.match_all) ----
  function matchAll(clips, minVotes, ratio, progress, checkCancel) {
    const have = clips.filter((c) => c.fp_h && c.fp_h.length);
    if (have.length < 2) return [];
    let total = 0;
    for (const c of have) total += c.fp_h.length;
    const H = new Int32Array(total), C = new Int32Array(total), Tm = new Int32Array(total);
    let o = 0;
    for (const c of have) { H.set(c.fp_h, o); C.fill(c.idx, o, o + c.fp_h.length); Tm.set(c.fp_t, o); o += c.fp_h.length; }
    const order = new Uint32Array(total);
    for (let i = 0; i < total; i++) order[i] = i;
    order.sort((a, b) => (H[a] - H[b]) || (a - b));                  // stable argsort
    const Hs = new Int32Array(total), Cs = new Int32Array(total), Ts = new Int32Array(total);
    for (let i = 0; i < total; i++) { Hs[i] = H[order[i]]; Cs[i] = C[order[i]]; Ts[i] = Tm[order[i]]; }
    const bucket = new Map();                                         // hash -> [lo, hi)
    for (let i = 0; i < total;) { let j = i; while (j < total && Hs[j] === Hs[i]) j++; bucket.set(Hs[i], [i, j]); i = j; }
    const dev = clips.map((c) => c.dev);
    const edges = [];
    let nDone = 0;
    for (const c of have) {
      nDone++;
      if (checkCancel) checkCancel();
      if (progress && (nDone % 5 === 0 || nDone === have.length)) {
        progress(nDone / have.length, `Matching sound between devices (${nDone}/${have.length})`);
      }
      const counts = new Map();                                       // cB*2^32 + dt+2^31 -> count
      const hA = c.fp_h, tA = c.fp_t;
      for (let q = 0; q < hA.length; q++) {
        const r = bucket.get(hA[q]);
        if (!r || r[1] - r[0] > BUCKET_CAP) continue;
        for (let p = r[0]; p < r[1]; p++) {
          const cB = Cs[p];
          if (cB > c.idx && dev[cB] !== c.dev) {
            const key = cB * 4294967296 + (tA[q] - Ts[p] + 2147483648);
            counts.set(key, (counts.get(key) || 0) + 1);
          }
        }
      }
      if (!counts.size) continue;
      const keys = Array.from(counts.keys()).sort((a, b) => a - b);
      for (let s = 0; s < keys.length;) {
        const cB = Math.floor(keys[s] / 4294967296);
        let e = s;
        while (e < keys.length && Math.floor(keys[e] / 4294967296) === cB) e++;
        const d = [], nn = [];
        for (let k = s; k < e; k++) { d.push(keys[k] - cB * 4294967296 - 2147483648); nn.push(counts.get(keys[k])); }
        s = e;
        let k = 0;
        for (let i = 1; i < nn.length; i++) if (nn[i] > nn[k]) k = i;
        if (nn[k] < Math.max(3, Math.floor(minVotes / 3))) continue;
        let votes = 0, second = 0;
        for (let i = 0; i < d.length; i++) {
          if (Math.abs(d[i] - d[k]) <= 1) votes += nn[i];
          if (Math.abs(d[i] - d[k]) > 2 && nn[i] > second) second = nn[i];
        }
        if (votes >= minVotes && nn[k] >= ratio * Math.max(second, 1)) {
          edges.push({ a: c.idx, b: cB, off: d[k] * FRAME_S, votes });
        }
      }
    }
    return edges;
  }

  // ---- refine (engine._gcc, engine.refine) ----
  // getA/getB(start, length) -> Promise<Float32Array> of a clip's 8 kHz mono mix, zero-padded
  // outside the clip (so long clips needn't be held in memory).
  async function gcc(getA, getB, offs, s, L, m) {
    const a = await getA(s, L);
    const b = await getB(s - offs - m, L + 2 * m);
    let n = 1;
    while (n < a.length + b.length) n <<= 1;
    // both real FFTs in one complex FFT: z = a + i b
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < a.length; i++) re[i] = a[i];
    for (let i = 0; i < b.length; i++) im[i] = b[i];
    fft(re, im, false);
    const Rr = new Float64Array(n), Ri = new Float64Array(n);
    for (let k = 0; k <= n / 2; k++) {
      const j = (n - k) % n;
      const Ar = (re[k] + re[j]) / 2, Ai = (im[k] - im[j]) / 2;      // A[k]
      const Br = (im[k] + im[j]) / 2, Bi = (re[j] - re[k]) / 2;      // B[k]
      let pr = Ar * Br + Ai * Bi, pi = Ar * Bi - Ai * Br;             // conj(A) * B
      const f = k * SR / n;
      const w = (f > 150 && f < 3500) ? 1 / (Math.pow(Math.hypot(pr, pi), 0.75) + 1e-9) : 0;
      pr *= w; pi *= w;
      Rr[k] = pr; Ri[k] = pi;
      if (k > 0 && k < n / 2) { Rr[n - k] = pr; Ri[n - k] = -pi; }
    }
    if (n >= 2) Ri[n / 2] = 0;                                       // irfft ignores it
    Ri[0] = 0;
    fft(Rr, Ri, true);
    let best = 0;
    for (let i = 1; i <= 2 * m; i++) if (Rr[i] > Rr[best]) best = i;
    return offs + m - best;
  }

  async function refine(getA, getB, lenA, lenB, offS) {
    const offs = pyRound(offS * SR);
    const s0 = Math.max(0, offs), s1 = Math.min(lenA, offs + lenB);
    if (s1 - s0 < SR) return [offS, false, 0.0];
    const L = Math.min(s1 - s0, 8 * SR), m = Math.trunc(0.06 * SR);
    if (s1 - s0 < 2 * L) {
      return [(await gcc(getA, getB, offs, s0 + Math.floor((s1 - s0 - L) / 2), L, m)) / SR, true, 0.0];
    }
    const nwin = Math.trunc(Math.min(15, Math.max(5, (s1 - s0) / (60 * SR))));
    const starts = [];
    for (let i = 1; i <= nwin; i++) starts.push(s0 + (s1 - L - s0) * i / (nwin + 1));
    const res = [];
    for (const s of starts) res.push(await gcc(getA, getB, offs, Math.trunc(s), L, m));
    const pos = starts.map((s) => (s + L / 2 - (s0 + s1) / 2) / SR);
    const med = median(res);
    const gi = res.map((r, i) => i).filter((i) => Math.abs(res[i] - med) <= 0.03 * SR);
    if (gi.length < 3) return [offS, false, 0.0];
    let [slope, mid] = polyfit1(gi.map((i) => pos[i]), gi.map((i) => res[i]));
    const inl = gi.filter((i) => Math.abs(res[i] - (slope * pos[i] + mid)) <= 0.004 * SR);
    if (inl.length < Math.max(3, 0.6 * nwin)) return [offS, false, 0.0];
    [slope, mid] = polyfit1(inl.map((i) => pos[i]), inl.map((i) => res[i]));
    return [mid / SR, true, slope * (s1 - s0) / SR / SR * 1000];
  }

  // ---- placement (engine._drop_clock_contradictions, engine.place) ----
  function dropClockContradictions(clips, edges, minVotes) {
    const byPair = new Map();
    for (const e of edges) {
      const a = clips[e.a], b = clips[e.b];
      if (!a.date || !b.date) continue;
      let gap = (b.date - a.date) - e.off, key = a.dev + "," + b.dev;
      if (a.dev > b.dev) { key = b.dev + "," + a.dev; gap = -gap; }
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push([gap, e]);
    }
    const dropped = new Set();
    for (const items of byPair.values()) {
      const support = items.map(([g]) => items.filter(([g2]) => Math.abs(g2 - g) < 2).length);
      let best = 0;
      for (let i = 1; i < support.length; i++) if (support[i] > support[best]) best = i;
      if (support[best] < 2) continue;
      const ref = items[best][0];
      items.forEach(([g, e], i) => {
        if (support[i] === 1 && Math.abs(g - ref) > 120 && e.votes < 3 * minVotes) dropped.add(e);
      });
    }
    return [edges.filter((e) => !dropped.has(e)), edges.filter((e) => dropped.has(e))];
  }

  // Weighted least squares for one component, matching scipy lsqr's minimum-norm answer:
  // members not connected (through `es`) to the anchored root get a zero-mean solution.
  function solveComponent(members, es, root, rootVal) {
    const col = new Map(members.map((i, k) => [i, k]));
    const nM = members.length;
    const adj = members.map(() => []);
    for (const e of es) { const a = col.get(e.a), b = col.get(e.b); adj[a].push(b); adj[b].push(a); }
    const comp = new Int32Array(nM).fill(-1);
    let nc = 0;
    for (let s = 0; s < nM; s++) {
      if (comp[s] >= 0) continue;
      const st = [s]; comp[s] = nc;
      while (st.length) { const u = st.pop(); for (const v of adj[u]) if (comp[v] < 0) { comp[v] = nc; st.push(v); } }
      nc++;
    }
    const x = new Float64Array(nM);
    for (let k = 0; k < nc; k++) {
      const idx = []; for (let i = 0; i < nM; i++) if (comp[i] === k) idx.push(i);
      const loc = new Map(idx.map((i, j) => [i, j]));
      const n = idx.length;
      const A = Array.from({ length: n }, () => new Float64Array(n)), y = new Float64Array(n);
      for (const e of es) {
        const a = col.get(e.a), b = col.get(e.b);
        if (comp[a] !== k) continue;
        const w = Math.sqrt(e.votes) * (e.refined ? 2.0 : 1.0), w2 = w * w;
        const ia = loc.get(a), ib = loc.get(b);
        A[ib][ib] += w2; A[ia][ia] += w2; A[ib][ia] -= w2; A[ia][ib] -= w2;
        y[ib] += w2 * e.off; y[ia] -= w2 * e.off;
      }
      const rk = col.get(root);
      const anchored = comp[rk] === k;
      if (anchored) { const r = loc.get(rk); A[r][r] += 10000; y[r] += 10000 * rootVal; }
      else { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) A[i][j] += 1 / n; } // gauge: mean 0
      const sol = gaussSolve(A, y);
      idx.forEach((i, j) => { x[i] = sol[j]; });
    }
    return x;
  }
  function gaussSolve(A, y) {
    const n = y.length, M = A.map((r) => Float64Array.from(r)), b = Float64Array.from(y);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]]; [b[c], b[p]] = [b[p], b[c]];
      const d = M[c][c];
      if (Math.abs(d) < 1e-300) continue;
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / d;
        if (!f) continue;
        for (let k = c; k < n; k++) M[r][k] -= f * M[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Float64Array(n);
    for (let c = n - 1; c >= 0; c--) {
      let s = b[c];
      for (let k = c + 1; k < n; k++) s -= M[c][k] * x[k];
      x[c] = Math.abs(M[c][c]) < 1e-300 ? 0 : s / M[c][c];
    }
    return x;
  }

  function place(clips, edgesIn, minVotes = 12) {
    const [edges, dropped] = dropClockContradictions(clips, edgesIn, minVotes);
    const n = clips.length, parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const adj = Array.from({ length: n }, () => []);
    for (const e of [...edges].sort((a, b) => b.votes - a.votes)) {
      const ra = find(e.a), rb = find(e.b);
      if (ra !== rb) {
        parent[ra] = rb;
        adj[e.a].push([e.b, e.off]); adj[e.b].push([e.a, -e.off]);
        e.tree = true;
      }
    }
    const comps = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(i); }
    const rel = new Map();
    for (const members of comps.values()) {
      let rootI = members[0];
      for (const i of members) if (adj[i].length > adj[rootI].length) rootI = i;
      rel.set(rootI, 0.0);
      const stack = [rootI];
      while (stack.length) {
        const u = stack.pop();
        for (const [v, off] of adj[u]) if (!rel.has(v)) { rel.set(v, rel.get(u) + off); stack.push(v); }
      }
    }
    for (const members of comps.values()) {
      if (members.length < 3) continue;
      const mset = new Set(members), rootI = members[0];
      for (let it = 0; it < 2; it++) {
        const es = edges.filter((e) => mset.has(e.a) && Math.abs(rel.get(e.b) - rel.get(e.a) - e.off) < 0.05);
        const sol = solveComponent(members, es, rootI, rel.get(rootI));
        members.forEach((i, k) => rel.set(i, sol[k]));
      }
    }
    const conflicts = edges.filter((e) => Math.abs(rel.get(e.b) - rel.get(e.a) - e.off) > 0.08);

    const durSum = (m) => m.reduce((s, i) => s + clips[i].duration, 0);
    const groups = [...comps.values()].map((m, k) => [m, k])
      .sort((x, y) => (y[0].length - x[0].length) || (durSum(y[0]) - durSum(x[0])) || (x[1] - y[1]))
      .map((x) => x[0]);
    // Python: sorted(..., reverse=True) keeps the original order for ties, as here
    const compOf = new Map();
    groups.forEach((g, gi) => g.forEach((i) => compOf.set(i, gi)));
    const devs = [...new Set(clips.map((c) => c.dev))].sort((a, b) => a - b);

    function solve(conv) {
      const obs = [];
      for (let i = 0; i < n; i++) {
        const c = clips[i];
        if (c.date) obs.push([i, c.dev, compOf.get(i), rel.get(i) - (c.date - (conv[c.dev] ? c.duration : 0))]);
      }
      const G = new Map([[0, 0.0]]), O = new Map();
      for (let it = 0; it < 40; it++) {
        let changed = false;
        for (const d of devs) {
          const v = obs.filter((o) => o[1] === d && G.has(o[2])).map((o) => o[3] - G.get(o[2]));
          if (v.length) {
            const nw = median(v);
            changed = changed || !O.has(d) || Math.abs(O.get(d) - nw) > 1e-6;
            O.set(d, nw);
          }
        }
        for (let g = 1; g < groups.length; g++) {
          const v = obs.filter((o) => o[2] === g && O.has(o[1])).map((o) => o[3] - O.get(o[1]));
          if (v.length) {
            const nw = median(v);
            changed = changed || !G.has(g) || Math.abs(G.get(g) - nw) > 1e-6;
            G.set(g, nw);
          }
        }
        if (!changed) break;
      }
      let resid = 0;
      for (const o of obs) if (G.has(o[2]) && O.has(o[1])) resid += Math.abs(o[3] - G.get(o[2]) - O.get(o[1]));
      return [G, resid];
    }

    const multi = new Set();
    groups.forEach((g, gi) => { if (new Set(g.map((j) => clips[j].dev)).size > 1) multi.add(gi); });

    function localPlace(conv) {
      const when = new Map();
      for (let i = 0; i < n; i++) if (clips[i].date) when.set(i, clips[i].date - (conv[clips[i].dev] ? clips[i].duration : 0));
      const anchors = new Map(devs.map((d) => [d, []]));
      const G = new Map([[0, 0.0]]), guessed = new Set(), evidence = new Map();
      const addAnchors = (g) => {
        if (g === 0 || multi.has(g)) {
          for (const i of groups[g]) if (when.has(i)) anchors.get(clips[i].dev).push([when.get(i), rel.get(i) - G.get(g) - when.get(i)]);
        }
      };
      addAnchors(0);
      const pending = new Set(); for (let g = 1; g < groups.length; g++) pending.add(g);
      while (pending.size) {
        let best = null;
        for (const g of [...pending].sort((a, b) => a - b)) {
          const cands = [];
          for (const i of groups[g]) {
            const A = anchors.get(clips[i].dev);
            if (when.has(i) && A.length) {
              let bd = null, bo = null;
              for (const [t, o] of A) {
                const dist = Math.abs(t - when.get(i));
                if (bd === null || dist < bd || (dist === bd && o < bo)) { bd = dist; bo = o; }
              }
              cands.push([bd, rel.get(i) - when.get(i) - bo]);
            }
          }
          if (!cands.length) continue;
          let pick = null, pk = null;
          for (const c of cands) {
            const k1 = cands.filter((x) => Math.abs(x[1] - c[1]) < 2).length, k2 = -c[0];
            if (pick === null || k1 > pk[0] || (k1 === pk[0] && k2 > pk[1])) { pick = c; pk = [k1, k2]; }
          }
          if (best === null || pick[0] < best[0]) best = [pick[0], g, pick[1]];
        }
        if (best === null) {
          const todo = devs.filter((d) => !anchors.get(d).length &&
            [...pending].some((g) => groups[g].some((i) => when.has(i) && clips[i].dev === d)));
          if (!todo.length) break;
          const d = todo[0];
          const placed = [];
          for (const [g, gv] of G) for (const i of groups[g]) placed.push(rel.get(i) - gv);
          const lo = Math.min(...placed), hi = Math.max(...placed);
          const allOffs = [];
          for (const A of anchors.values()) for (const [, o] of A) allOffs.push(o);
          const dates = [];
          for (const g of [...pending].sort((a, b) => a - b)) for (const i of groups[g]) if (when.has(i) && clips[i].dev === d) dates.push(when.get(i));
          let off = allOffs.length ? median(allOffs) : lo - Math.min(...dates);
          if (Math.max(...dates) + off < lo - 6 * 3600 || Math.min(...dates) + off > hi + 6 * 3600) off = lo - Math.min(...dates);
          anchors.get(d).push([Math.min(...dates), off]);
          guessed.add(d);
          continue;
        }
        const [dist, g, val] = best;
        G.set(g, val); evidence.set(g, dist); pending.delete(g);
        addAnchors(g);
      }
      return [G, guessed, anchors, evidence];
    }

    let best = null;
    const combos = [];
    if (devs.length <= 8) {
      for (let bits = 0; bits < (1 << devs.length); bits++) {
        const conv = {};
        // np.ndindex order: first device is the most significant digit
        devs.forEach((d, k) => { conv[d] = (bits >> (devs.length - 1 - k)) & 1; });
        combos.push(conv);
      }
    } else combos.push(Object.fromEntries(devs.map((d) => [d, 0])));
    for (const conv of combos) {
      const [G, resid] = solve(conv);
      const score = [-G.size, pyRound(resid * 1000) / 1000, Object.values(conv).reduce((a, b) => a + b, 0)];
      if (best === null || score[0] < best[0][0] || (score[0] === best[0][0] && (score[1] < best[0][1] ||
          (score[1] === best[0][1] && score[2] < best[0][2])))) best = [score, conv];
    }
    const [G, guessed, anchors, evidence] = localPlace(best[1]);
    const clock = {};
    for (const d of devs) {
      const eras = [];
      const A = [...anchors.get(d)].sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]));
      for (const [t, o] of A) {
        if (eras.length && Math.abs(o - eras[eras.length - 1].offs[eras[eras.length - 1].offs.length - 1]) < 2) {
          eras[eras.length - 1].offs.push(o); eras[eras.length - 1].t1 = t;
        } else eras.push({ t0: t, t1: t, offs: [o] });
      }
      clock[d] = { end_stamp: !!best[1][d], guessed: guessed.has(d),
        eras: eras.map((e) => ({ t0: e.t0, t1: e.t1, n: e.offs.length, spread: Math.max(...e.offs) - Math.min(...e.offs) })) };
    }
    groups.forEach((g, gi) => {
      for (const i of g) {
        const c = clips[i];
        if (gi === 0) { c.start = rel.get(i); c.status = g.length > 1 ? "synced" : "only clip"; }
        else if (G.has(gi)) {
          c.start = rel.get(i) - G.get(gi);
          c.status = g.length > 1 ? "synced" : "placed by date";
          if (g.length > 1) continue;
          let how;
          if (guessed.has(c.dev)) how = "device shares no sound with the others, so its clock is a guess";
          else {
            const dist = evidence.get(gi) || 0;
            how = "clock checked against sound " + (dist >= 60 ? `${pyFixed(dist / 60, 0)} min away` : "nearby") +
              (dist > 3 * 3600 ? "  (far: check)" : "");
          }
          c.note = c.note ? `${c.note}; ${how}` : how;
        }
      }
    });
    const unplaced = groups.filter((g, gi) => gi && !G.has(gi));
    let end = 0;
    for (const c of clips) if (c.start !== undefined) end = Math.max(end, c.start + c.duration);
    let cursor = end + 30;
    for (const g of unplaced) {
      const base = Math.min(...g.map((i) => rel.get(i)));
      for (const i of g) {
        const c = clips[i];
        c.start = cursor + rel.get(i) - base;
        c.status = "NOT PLACED";
        if (c.proxy && !c.note) c.note = "proxy with no shared sound (proxy dates can't be trusted)";
      }
      cursor = Math.max(...g.map((i) => clips[i].start + clips[i].duration)) + 10;
    }
    for (const d of devs) {
      const dc = clips.filter((c) => c.dev === d).sort((a, b) => a.start - b.start);
      for (let k = 0; k + 1 < dc.length; k++) {
        const a = dc[k], b = dc[k + 1], over = a.start + a.duration - b.start;
        if (b.status === "placed by date" && over > 0 && over < 1.5) b.start += over;
      }
      for (let k = dc.length - 2; k >= 0; k--) {
        const a = dc[k], b = dc[k + 1], over = a.start + a.duration - b.start;
        if (a.status === "placed by date" && over > 0 && over < 1.5) a.start -= over;
      }
    }
    const t0 = Math.min(...clips.map((c) => c.start));
    for (const c of clips) c.start -= t0;
    return [conflicts, clock, dropped];
  }

  // ---- XML (engine.rate_xml, engine.build_xml) ----
  const escapeXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // urllib.parse.quote(s) with safe="/" (UTF-8). Premiere's JavaScript has no TextEncoder,
  // so this builds on encodeURIComponent, which escapes the same set except /!'()*.
  function pyQuote(s) {
    return encodeURIComponent(s).replace(/%2F/g, "/")
      .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  }
  // UTF-8 bytes -> string (no TextDecoder in Premiere's JavaScript)
  function utf8Decode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  }
  function rateXml(fps) {
    const ntsc = Math.abs(fps - pyRound(fps) * 1000 / 1001) < 0.01 && Math.abs(fps - pyRound(fps)) > 0.001;
    const tb = pyRound(fps);
    return [`<rate><timebase>${tb}</timebase><ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`, tb, ntsc];
  }

  function buildXml(clips, devices, seqName, seqFps, keepSilent, skipSilentClips) {
    const [seqRate, tb, ntsc] = rateXml(seqFps);
    const fps = ntsc ? tb * 1000 / 1001 : tb;
    const fr = (s) => pyRound(s * fps);
    for (const c of clips) { c.f_start = fr(c.start); c.f_len = Math.max(1, fr(c.duration)); c.f_end = c.f_start + c.f_len; }
    const videoTracks = [], audioTracks = [], laneInfo = [];
    devices.forEach((dname, d) => {
      const dc = clips.filter((c) => c.dev === d).sort((a, b) => a.f_start - b.f_start);
      if (!dc.length) return;
      const lanes = [];
      for (const c of dc) {
        let placed = false;
        for (let li = 0; li < lanes.length; li++) {
          const last = lanes[li], over = last.f_end - c.f_start;
          if (over <= 0 || (over <= 2 && last.f_len > over + 1)) {
            if (over > 0) { last.f_len -= over; last.f_end -= over; }
            lanes[li] = c; c.lane = li; placed = true; break;
          }
        }
        if (!placed) { lanes.push(c); c.lane = lanes.length - 1; }
      }
      const maxch = Math.max(...dc.map((c) => c.nch));
      const live = new Set();
      for (const c of dc) for (let ch = 1; ch <= c.nch; ch++) if (!c.silent.includes(ch)) live.add(ch);
      const chans = keepSilent ? Array.from({ length: maxch }, (_, i) => i + 1) : [...live].sort((a, b) => a - b);
      const isCam = dc.some((c) => c.has_video);
      for (let li = 0; li < lanes.length; li++) {
        const lane = dc.filter((c) => c.lane === li);
        if (isCam) videoTracks.push(lane.filter((c) => c.has_video).map((c) => [c, null]));
        for (const ch of chans) {
          const items = [];
          for (const c of lane) {
            if (ch > c.nch) continue;
            if (skipSilentClips && c.silent.includes(ch)) continue;
            items.push([c, ch]);
          }
          if (items.length) audioTracks.push(items);
        }
      }
      laneInfo.push([dname, lanes.length, chans]);
    });
    const itemId = new Map(), byClip = new Map();
    let counter = 0;
    for (const [kind, tracks] of [["v", videoTracks], ["a", audioTracks]]) {
      tracks.forEach((tr, ti0) => tr.forEach(([c, ch], ci0) => {
        counter++;
        const v = [`clipitem-${counter}`, kind, ti0 + 1, ci0 + 1];
        itemId.set(c.idx + "|" + ch, v);
        if (!byClip.has(c.idx)) byClip.set(c.idx, []);
        byClip.get(c.idx).push(v);
      }));
    }
    const fileWritten = new Set();
    const fileXml = (c) => {
      const fid = `file-${c.idx + 1}`;
      if (fileWritten.has(fid)) return `<file id="${fid}"/>`;
      fileWritten.add(fid);
      const frate = rateXml(c.fps || seqFps)[0], fpsf = c.fps || seqFps;
      const url = "file://localhost" + pyQuote(c.path);
      let media = "";
      if (c.has_video) media += `<video><samplecharacteristics>${frate}<width>${c.width}</width><height>${c.height}</height></samplecharacteristics></video>`;
      if (c.nch) media += `<audio><samplecharacteristics><depth>24</depth><samplerate>${c.samplerate}</samplerate></samplecharacteristics><channelcount>${c.nch}</channelcount></audio>`;
      return `<file id="${fid}"><name>${escapeXml(c.name)}</name><pathurl>${escapeXml(url)}</pathurl>` +
        `${frate}<duration>${Math.max(1, pyRound(c.duration * fpsf))}</duration><media>${media}</media></file>`;
    };
    const label = { "placed by date": "Orange", "NOT PLACED": "Red" };
    const itemXml = (c, ch) => {
      const [iid] = itemId.get(c.idx + "|" + ch);
      let x = `<clipitem id="${iid}"><name>${escapeXml(c.name)}</name><enabled>TRUE</enabled>` +
        `<duration>${c.f_len}</duration>${seqRate}<start>${c.f_start}</start><end>${c.f_end}</end><in>0</in><out>${c.f_len}</out>${fileXml(c)}`;
      if (ch !== null) x += `<sourcetrack><mediatype>audio</mediatype><trackindex>${ch}</trackindex></sourcetrack>`;
      for (const [lid, lk, lti, lci] of byClip.get(c.idx)) {
        x += `<link><linkclipref>${lid}</linkclipref><mediatype>${lk === "v" ? "video" : "audio"}</mediatype><trackindex>${lti}</trackindex><clipindex>${lci}</clipindex></link>`;
      }
      if (label[c.status]) x += `<labels><label2>${label[c.status]}</label2></labels>`;
      return x + "</clipitem>";
    };
    const cams = clips.filter((c) => c.has_video);
    const w = cams.length ? cams[0].width : 1920, h = cams.length ? cams[0].height : 1080;
    const total = clips.length ? Math.max(...clips.map((c) => c.f_end)) : 1;
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE xmeml>", '<xmeml version="4">',
      `<sequence id="sequence-1"><name>${escapeXml(seqName)}</name><duration>${total}</duration>` +
      `${seqRate}<media><video><format><samplecharacteristics>${seqRate}<width>${w}</width>` +
      `<height>${h}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>`];
    for (const tr of videoTracks) out.push("<track>" + tr.map(([c, ch]) => itemXml(c, ch)).join("") + "</track>");
    out.push("</video><audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics>" +
      "<depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>");
    for (const tr of audioTracks) out.push("<track>" + tr.map(([c, ch]) => itemXml(c, ch)).join("") + "</track>");
    out.push(`</audio></media><timecode>${seqRate}<string>00:00:00:00</string><frame>0</frame>` +
      "<displayformat>NDF</displayformat></timecode></sequence></xmeml>");
    return [out.join("\n"), laneInfo, videoTracks.length, audioTracks.length];
  }

  // engine.compact_clips: copies with every stretch where nothing is recording cut out,
  // blocks joined frame-exactly (in the frames buildXml uses)
  function compactClips(clips, seqFps) {
    const [, tb, ntsc] = rateXml(seqFps);
    const fps = ntsc ? tb * 1000 / 1001 : tb;
    const out = clips.map((c) => Object.assign({}, c)).sort((a, b) => a.start - b.start);
    let cursor = 0, shift = 0, blockEnd = null;
    for (const c of out) {
      const f0 = pyRound(c.start * fps), f1 = f0 + Math.max(1, pyRound(c.duration * fps));
      if (blockEnd === null || f0 > blockEnd) { shift = f0 - cursor; blockEnd = f0; }
      blockEnd = Math.max(blockEnd, f1);
      cursor = blockEnd - shift;
      c.start -= shift / fps;
    }
    return out.sort((a, b) => a.idx - b.idx);
  }

  // ---- report (engine.tc, engine.write_report) ----
  function tc(s) {
    s = Math.max(0, s);
    return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pyFixed(s % 60, 3).padStart(6, "0")}`;
  }
  const hm = (t) => { const d = new Date(t * 1000); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); };
  const pyList = (a) => "[" + a.join(", ") + "]";

  function reportText({ version, name, seqFps, nv, na, clips, laneInfo, conflicts, skipped, edges, clock, devices, stems, relPath }) {
    const counts = {};
    for (const c of clips) counts[c.status] = (counts[c.status] || 0) + 1;
    const R = [`SlingSync ${version} report - ${name}`, `Sequence: ${pyFixed(seqFps, 3)} fps, ${nv} video tracks, ${na} audio tracks`, ""];
    R.push("Summary: " + Object.keys(counts).sort().map((k) => `${counts[k]} ${k}`).join(", "));
    R.push("");
    if (stems) {
      R.push(`Audio files: ${stems[1].length} aligned WAV files in ${stems[0]}`);
      R.push("  Import them all at the very start (00:00:00) of any audio editor's timeline;");
      R.push("  they line up to the audio sample. One file per device channel.");
      R.push("");
    }
    R.push("Tracks per device:");
    for (const [dname, nl, chans] of laneInfo) {
      R.push(`  ${dname}: ${nl} lane(s), channels kept ${chans.length ? pyList(chans) : "none"}` +
        (nl > 1 ? "  (extra lanes = clips that overlap in time on one device - check those)" : ""));
    }
    R.push("");
    const need = clips.filter((c) => c.status !== "synced");
    if (need.length) {
      R.push("CHECK THESE BY EYE");
      R.push("  placed by date = no sound shared with another device (cutaways, drone, camera");
      R.push("                   rolling while the recorder was off); positioned by its device's");
      R.push("                   clock (date/timecode), corrected using nearby sound-synced clips");
      R.push("  NOT PLACED     = no usable sound or date, parked after the end of the timeline");
      for (const c of [...need].sort((a, b) => a.start - b.start)) R.push(`  [${c.status}] ${c.rel}  at ${tc(c.start)}  ${c.note}`);
      R.push("");
    }
    if (clock) {
      R.push("Device clocks (how well each device's clock agrees with the sound, across");
      R.push("separate blocks; this is how accurate 'placed by date' positions are):");
      for (const d of Object.keys(clock).map(Number).sort((a, b) => a - b)) {
        const info = clock[d], stamp = info.end_stamp ? "end of recording" : "start of recording", eras = info.eras;
        let q;
        if (info.guessed) q = "no sound link to other devices: clock is a guess";
        else if (!eras.length) q = "no sound-verified clips";
        else if (eras.length === 1 && eras[0].n === 1) q = "checked against sound once (too few checks to tell whether it's steady)";
        else if (eras.length === 1) q = `steady, checked against sound ${eras[0].n} times (within ${pyFixed(eras[0].spread, 1)} s)`;
        else {
          const parts = eras.map((e) => `${hm(e.t0)}-${hm(e.t1)}`).join(", ");
          q = `CLOCK CHANGED during the shoot (${eras.length} settings, device time ${parts}). Date-placed clips use the nearest setting; check those near a change`;
        }
        R.push(`  ${devices[d]}: dates mark ${stamp}; ${q}`);
      }
      R.push("");
    }
    const frameMs = 1000 / seqFps;
    const drifting = edges.filter((e) => Math.abs(e.drift_ms || 0) >= frameMs / 4);
    if (drifting.length) {
      R.push("Clock drift (clips are lined up at the middle of each overlap, so the ends are");
      R.push(`off by half the drift; one frame here is ${pyFixed(frameMs, 0)} ms):`);
      for (const e of [...drifting].sort((a, b) => Math.abs(b.drift_ms) - Math.abs(a.drift_ms))) {
        const half = Math.abs(e.drift_ms) / 2;
        const verdict = half < frameMs / 2 ? "fine" : (half < frameMs ? "check the ends" : "OUT OF SYNC at the ends, cut and re-sync");
        const sd = (e.drift_ms >= 0 ? "+" : "") + pyFixed(e.drift_ms, 0);
        R.push(`  ${clips[e.a].rel}  <->  ${clips[e.b].rel}: ${sd} ms over the overlap, ends off by up to ${pyFixed(half, 0)} ms (${verdict})`);
      }
      R.push("");
    }
    if (conflicts.length) {
      R.push("Inconsistent matches (usually fine, but worth a look if something seems off):");
      for (const e of conflicts.slice(0, 50)) R.push(`  ${clips[e.a].rel}  <->  ${clips[e.b].rel}`);
      R.push("");
    }
    const chs = (xs) => {
      xs = [...xs].sort((a, b) => a - b);
      const out = [];
      for (const x of xs) { if (out.length && x === out[out.length - 1][1] + 1) out[out.length - 1][1] = x; else out.push([x, x]); }
      return out.map(([a, b]) => (b > a ? `${a}-${b}` : `${a}`)).join(", ");
    };
    R.push("Silent channels (ignored for syncing; left out of the timeline when silent in every");
    R.push("file of a device, unless that option is switched off):");
    let anySilent = false;
    for (const d of [...new Set(clips.map((c) => c.dev))].sort((a, b) => a - b)) {
      const dc = clips.filter((c) => c.dev === d && c.nch);
      if (!dc.length) continue;
      let common = new Set(dc[0].silent);
      for (const c of dc.slice(1)) common = new Set([...common].filter((x) => c.silent.includes(x)));
      const nm = d < devices.length ? devices[d] : String(d);
      if (common.size) { anySilent = true; R.push(`  ${nm}: ch ${chs(common)} silent in all ${dc.length} files`); }
      for (const c of dc) {
        const extra = c.silent.filter((x) => !common.has(x)).sort((a, b) => a - b);
        if (extra.length) {
          anySilent = true;
          R.push(`    ${c.rel}: ${common.size ? "also " : ""}silent ch ${chs(extra)}, synced using ` +
            (c.used.length ? `ch ${chs(c.used)}` : "nothing (no usable sound)"));
        }
      }
    }
    if (!anySilent) R.push("  none");
    if (skipped.length) { R.push(""); R.push("Unreadable files (skipped):"); for (const p of skipped) R.push(`  ${relPath(p)}`); }
    R.push("");
    R.push("All clips:");
    for (const c of [...clips].sort((a, b) => (a.dev - b.dev) || (a.start - b.start))) R.push(`  ${tc(c.start)}  ${c.status.padEnd(24)} ${c.rel}`);
    return [R.join("\n") + "\n", counts];
  }

  // ---- devices (engine.proxy_base, _loose_device, _device_entry) ----
  function proxyBase(fn) {
    const stem = stemOf(fn).toLowerCase();
    for (const suf of PROXY_SUFFIXES) if (stem.endsWith(suf)) return stem.slice(0, -suf.length);
    return null;
  }
  const stripChars = (s) => s.replace(/^[_\- ]+|[_\- ]+$/g, "");
  function looseDevice(fn) {
    let stem = stemOf(fn);
    const base = proxyBase(fn);
    if (base !== null) stem = stem.slice(0, base.length);
    let m = stem.match(/^([A-Za-z])\d{3}C\d{3}/);
    if (m) return `Cam ${m[1].toUpperCase()}`;
    m = stem.match(/^(.*?\D)[_\- ]?\d+$/);
    if (m && stripChars(m[1])) return stripChars(m[1]);
    return stem;
  }
  function deviceEntry(name, found) {
    const originals = new Set(found.filter((f) => proxyBase(f) === null).map((f) => stemOf(f).toLowerCase()));
    const files = found.filter((f) => !originals.has(proxyBase(f)));
    return { name, files, skipped_proxies: found.length - files.length,
      proxies_used: files.filter((f) => proxyBase(f) !== null).length,
      camera: files.some((f) => VIDEO_EXT.has(ext(f))) };
  }
  const isMedia = (fn) => !fn.startsWith(".") && (VIDEO_EXT.has(ext(fn)) || AUDIO_EXT.has(ext(fn)));
  const skipDir = (d) => d.startsWith(".") || SKIP_DIRS.has(d.toLowerCase());

  const api = { SR, FRAME_S, CACHE_DIR, VIDEO_EXT, AUDIO_EXT, Cancelled, pyRound, pyFixed, percentile, median,
    parseIso, dateCandidates, parseTc, resolveDates, probeFromInfo, fft, fingerprint, matchAll, refine,
    place, buildXml, compactClips, rateXml, tc, reportText, proxyBase, looseDevice, deviceEntry, isMedia, skipDir,
    basename, ext, pyQuote, utf8Decode };
  root.SlingCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
