"""
SlingSync engine: sync cameras and multitrack audio by sound (no timecode)
and write a Final Cut Pro 7 XML that Premiere Pro imports.

Pure Python + numpy/scipy; audio decoding via PyAV (bundled FFmpeg libraries).
"""

import datetime
import hashlib
import json
import os
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote
from xml.sax.saxutils import escape

import av
import numpy as np
from scipy.ndimage import maximum_filter

from . import __version__ as VERSION

try:
    av.logging.set_level(av.logging.PANIC)
except Exception:
    pass

# ---- analysis constants ----
SR = 8000                 # analysis sample rate
N_FFT = 512
HOP = 128
FRAME_S = HOP / SR        # 16 ms fingerprint resolution
BIN_LO, BIN_HI = 13, 225  # ~200 Hz .. 3.5 kHz
PEAKS_PER_SEC = 25
FANOUT = 5
MAX_DT = 48
MAX_DF = 60
BUCKET_CAP = 60           # ignore hashes that are too common

VIDEO_EXT = {".mp4", ".mov", ".mxf", ".mts", ".m2ts", ".avi", ".mkv", ".m4v",
             ".mpg", ".mpeg", ".3gp", ".insv", ".lrv"}
AUDIO_EXT = {".wav", ".bwf", ".aif", ".aiff", ".mp3", ".m4a", ".flac", ".aac",
             ".ogg", ".caf"}
CACHE_DIR = ".slingsync_cache"



def _parse_iso(s):
    s = s.strip().replace("Z", "+00:00")
    if " " in s and "T" not in s[:11]:
        s = s.replace(" ", "T", 1)
    try:
        return datetime.datetime.fromisoformat(s).timestamp()
    except Exception:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y:%m:%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.datetime.strptime(s[:19], fmt).timestamp()
        except Exception:
            continue
    return None


def _date_from_tags(tags, sr, path, duration):
    t = {k.lower(): str(v) for k, v in tags.items()}
    # Broadcast WAV: recorder's own clock (works even without jammed timecode)
    od = t.get("origination_date")
    ot_tag = t.get("origination_time")
    ct = t.get("creation_time", "")
    if not od and t.get("date") and (t.get("time_reference") or (len(ct) == 8 and ct[2] == ":")):
        od, ot_tag = t["date"], ot_tag or ct   # how FFmpeg reports BWF bext fields
    if od:
        od = od.replace(":", "-")[:10]
        try:
            base = datetime.datetime.strptime(od, "%Y-%m-%d").timestamp()
            if t.get("time_reference") and sr:
                return base + int(t["time_reference"]) / sr, "recorder clock"
            ot = ot_tag
            if ot:
                h, m, s = [int(x) for x in ot.replace("-", ":").split(":")[:3]]
                return base + h * 3600 + m * 60 + s, "recorder clock"
        except Exception:
            pass
    for k in ("com.apple.quicktime.creationdate", "creation_time", "date"):
        if k in t:
            v = _parse_iso(t[k])
            if v:
                return v, "file metadata"
    st = os.stat(path)
    if hasattr(st, "st_birthtime"):
        return st.st_birthtime, "file date"
    return st.st_mtime - duration, "file date"


class Cancelled(Exception):
    pass


def _check(cancel):
    if cancel is not None and cancel.is_set():
        raise Cancelled()


def probe(path):
    """Duration, streams, channel counts, frame rate and a date hint for one file."""
    try:
        c = av.open(path)
    except Exception:
        return None
    try:
        is_audio_file = os.path.splitext(path)[1].lower() in AUDIO_EXT
        vids = [] if is_audio_file else list(c.streams.video)
        auds = list(c.streams.audio)
        durs = [c.duration / 1e6 if c.duration else 0.0]
        for s in list(c.streams.video) + auds:
            if s.duration and s.time_base:
                durs.append(float(s.duration * s.time_base))
        duration = max(durs)
        if duration <= 0:
            return None
        out = {"path": path, "duration": duration, "has_video": bool(vids),
               "audio_streams": [len(s.layout.channels) for s in auds],
               "samplerate": int(auds[0].rate or 48000) if auds else 48000}
        out["nch"] = sum(out["audio_streams"])
        if vids:
            v = vids[0]
            fps = float(v.average_rate or v.guessed_rate or 0) or 25.0
            out.update(fps=fps, width=int(v.codec_context.width or 1920),
                       height=int(v.codec_context.height or 1080))
        tags = dict(c.metadata)
        for s in c.streams:
            for k, val in dict(s.metadata).items():
                tags.setdefault(k, val)
    except Exception:
        return None
    finally:
        c.close()
    out["date"], out["date_src"] = _date_from_tags(tags, out["samplerate"], path, duration)
    return out


def _blocks(path, chunk):
    """Yield (n, channels) float32 blocks at SR Hz, all audio streams side by side."""
    c = av.open(path)
    try:
        streams = list(c.streams.audio)
        if not streams:
            return
        res = [av.AudioResampler(format="fltp", layout=s.layout, rate=SR) for s in streams]
        idx = {s.index: k for k, s in enumerate(streams)}
        bufs = [[] for _ in streams]
        lens = [0] * len(streams)

        def push(k, frames):
            for o in frames or []:
                a = o.to_ndarray().astype(np.float32, copy=False)
                if a.ndim == 1:
                    a = a[None, :]
                bufs[k].append(a)
                lens[k] += a.shape[1]

        def take(n):
            out = []
            for k in range(len(streams)):
                cat = np.concatenate(bufs[k], axis=1) if len(bufs[k]) > 1 else bufs[k][0]
                out.append(cat[:, :n])
                rest = cat[:, n:]
                bufs[k] = [rest] if rest.shape[1] else []
                lens[k] = rest.shape[1]
            return np.ascontiguousarray(np.concatenate(out, axis=0).T)

        for packet in c.demux(*streams):
            k = idx[packet.stream.index]
            try:
                for f in packet.decode():
                    push(k, res[k].resample(f))
            except Exception:
                continue
            while min(lens) >= chunk:
                yield take(chunk)
        for k in range(len(streams)):
            try:
                push(k, res[k].resample(None))
            except Exception:
                pass
        n = min(lens)
        if n:
            yield take(n)
    finally:
        c.close()


def fingerprint(x):
    """Spectral-peak landmark hashes (Shazam-style). Returns (hashes, frame_times)."""
    empty = (np.zeros(0, np.int64), np.zeros(0, np.int32))
    if len(x) < N_FFT * 8:
        return empty
    x = x + np.random.default_rng(0).standard_normal(len(x)).astype(np.float32) * 1e-4
    win = np.hanning(N_FFT).astype(np.float32)
    nfr = 1 + (len(x) - N_FFT) // HOP
    T, F, V = [], [], []
    B, M = 4096, 8
    for b0 in range(0, nfr, B):
        f0, f1 = max(0, b0 - M), min(nfr, b0 + B + M)
        seg = x[f0 * HOP:(f1 - 1) * HOP + N_FFT]
        fr = np.lib.stride_tricks.sliding_window_view(seg, N_FFT)[::HOP]
        S = np.abs(np.fft.rfft(fr * win, axis=1))[:, BIN_LO:BIN_HI]
        S = 20 * np.log10(S + 1e-6)
        mx = maximum_filter(S, size=(11, 11), mode="constant", cval=-np.inf)
        thr = max(np.percentile(S, 60) + 3, -35.0)
        ti, fi = np.nonzero((S == mx) & (S > thr))
        t = ti + f0
        keep = (t >= b0) & (t < b0 + B)
        T.append(t[keep]); F.append(fi[keep]); V.append(S[ti[keep], fi[keep]])
    t, f, v = np.concatenate(T), np.concatenate(F), np.concatenate(V)
    if len(t) < 4:
        return empty
    sec = t // int(round(1 / FRAME_S))
    o = np.lexsort((-v, sec))
    t, f, sec = t[o], f[o], sec[o]
    starts = np.r_[0, np.flatnonzero(np.diff(sec)) + 1]
    rank = np.arange(len(sec)) - np.repeat(starts, np.diff(np.r_[starts, len(sec)]))
    keep = rank < PEAKS_PER_SEC
    t, f = t[keep], f[keep]
    o = np.lexsort((f, t))
    t, f = t[o].astype(np.int64), f[o].astype(np.int64)
    n = len(t)
    cnt = np.zeros(n, np.int32)
    H, TT = [], []
    for k in range(1, 40):
        if k >= n:
            break
        i = np.arange(n - k)
        j = i + k
        dt = t[j] - t[i]
        df = f[j] - f[i]
        ok = (dt > 0) & (dt <= MAX_DT) & (np.abs(df) <= MAX_DF) & (cnt[i] < FANOUT)
        i, dt, df = i[ok], dt[ok], df[ok]
        cnt[i] += 1
        H.append((f[i] << 13) | ((df + MAX_DF) << 6) | dt)
        TT.append(t[i])
    if not H:
        return empty
    return np.concatenate(H), np.concatenate(TT).astype(np.int32)


def analyze(job):
    path, cache, ref_ch, silence_db, flat_db = job
    meta_p, mono_p, fp_p = cache + ".json", cache + "_mono.npy", cache + "_fp.npz"
    if os.path.exists(meta_p) and os.path.exists(fp_p):
        with open(meta_p) as fh:
            return json.load(fh)
    nch = probe(path)["nch"]
    frame = int(0.05 * SR)
    # pass 1: per-channel loudness in 50 ms frames
    rms = []
    for blk in _blocks(path, frame * 400):
        m = len(blk) // frame
        if m:
            rms.append(np.sqrt(np.mean(blk[:m * frame].reshape(m, frame, nch) ** 2, axis=1)))
    meta = {"silent": [], "used": [], "levels_db": [], "mono": None, "fp": None,
            "note": ""}
    if not rms:
        meta["silent"] = list(range(1, nch + 1))
        meta["note"] = "no decodable audio"
        with open(meta_p, "w") as fh:
            json.dump(meta, fh)
        return meta
    db = 20 * np.log10(np.concatenate(rms) + 1e-12)
    gains = np.zeros(nch, np.float32)
    for c in range(nch):
        p95, p10 = np.percentile(db[:, c], 95), np.percentile(db[:, c], 10)
        meta["levels_db"].append(round(float(p95), 1))
        # silent = too quiet, OR flat noise with no dynamics (dead input / hiss only)
        if p95 < silence_db or (p95 - p10) < flat_db:
            meta["silent"].append(c + 1)
        else:
            gains[c] = 1.0 / (10 ** (np.percentile(db[:, c], 90) / 20))
    used = [c for c in range(nch) if gains[c] > 0]
    if ref_ch and ref_ch - 1 in used:
        used = [ref_ch - 1]
    elif ref_ch:
        meta["note"] = f"reference channel {ref_ch} silent here, used the other channels"
    meta["used"] = [c + 1 for c in used]
    if not used:
        meta["note"] = meta["note"] or "all channels silent"
        with open(meta_p, "w") as fh:
            json.dump(meta, fh)
        return meta
    # pass 2: equal-level mix of the non-silent channels
    w = np.zeros(nch, np.float32)
    w[used] = gains[used] / len(used)
    mono = np.concatenate([blk @ w for blk in _blocks(path, frame * 400)]).astype(np.float32)
    np.save(mono_p, mono)
    h, t = fingerprint(mono)
    np.savez(fp_p, h=h, t=t)
    meta["mono"], meta["fp"] = mono_p, fp_p
    with open(meta_p, "w") as fh:
        json.dump(meta, fh)
    return meta


# ---- matching --------------------------------------------------------------
def _gcc(A, B, offs, s, L, m):
    a = np.asarray(A[s:s + L], np.float32)
    bs, be = s - offs - m, s - offs + L + m
    b = np.asarray(B[max(0, bs):min(len(B), be)], np.float32)
    b = np.pad(b, (max(0, -bs), max(0, be - len(B))))
    n = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    R = np.conj(np.fft.rfft(a, n)) * np.fft.rfft(b, n)
    f = np.fft.rfftfreq(n, 1 / SR)
    R *= ((f > 150) & (f < 3500)) / (np.abs(R) ** 0.75 + 1e-9)  # band-limited, softened PHAT
    cc = np.fft.irfft(R, n)[:2 * m + 1]
    return offs + m - int(np.argmax(cc))


def refine(A, B, off_s):
    """Sample-accurate offset (start_B - start_A): GCC-PHAT on several windows of the
    overlap around the coarse guess; accepted only if the windows agree."""
    offs = int(round(off_s * SR))
    s0, s1 = max(0, offs), min(len(A), offs + len(B))
    if s1 - s0 < SR:
        return off_s, False
    L = min(s1 - s0, 8 * SR)
    m = int(0.06 * SR)
    nwin = 1 if s1 - s0 < 2 * L else 5
    starts = np.linspace(s0, s1 - L, nwin + 2)[1:-1] if nwin > 1 else [s0 + (s1 - s0 - L) // 2]
    res = np.array([_gcc(A, B, offs, int(s), L, m) for s in starts])
    med = int(np.median(res))
    agree = np.sum(np.abs(res - med) <= 0.002 * SR)
    ok = agree >= (1 if nwin == 1 else 3)
    return (med / SR if ok else off_s), bool(ok)


def match_all(clips, min_votes, ratio, progress=None, cancel=None):
    have = [c for c in clips if c.get("fp_h") is not None and len(c["fp_h"])]
    if len(have) < 2:
        return []
    H = np.concatenate([c["fp_h"] for c in have])
    C = np.concatenate([np.full(len(c["fp_h"]), c["idx"], np.int32) for c in have])
    T = np.concatenate([c["fp_t"] for c in have])
    o = np.argsort(H, kind="stable")
    Hs, Cs, Ts = H[o], C[o], T[o]
    dev = np.array([c["dev"] for c in clips])
    edges = []
    for n_done, c in enumerate(have, 1):
        _check(cancel)
        if progress and (n_done % 5 == 0 or n_done == len(have)):
            progress(n_done / len(have), f"Matching sound between devices ({n_done}/{len(have)})")
        hA, tA = c["fp_h"], c["fp_t"]
        lo, hi = np.searchsorted(Hs, hA, "left"), np.searchsorted(Hs, hA, "right")
        cnt = hi - lo
        cnt[cnt > BUCKET_CAP] = 0
        tot = int(cnt.sum())
        if not tot:
            continue
        rep = np.repeat(np.arange(len(hA)), cnt)
        pos = np.arange(tot) - np.repeat(np.cumsum(cnt) - cnt, cnt) + np.repeat(lo, cnt)
        cB = Cs[pos]
        m = (cB > c["idx"]) & (dev[cB] != c["dev"])
        if not m.any():
            continue
        cB = cB[m]
        dt = tA[rep[m]].astype(np.int64) - Ts[pos[m]].astype(np.int64)
        key = (cB.astype(np.int64) << 32) | (dt + (1 << 31))
        uk, uc = np.unique(key, return_counts=True)
        ub = (uk >> 32).astype(np.int64)
        udt = (uk & 0xFFFFFFFF) - (1 << 31)
        starts = np.r_[0, np.flatnonzero(np.diff(ub)) + 1]
        ends = np.r_[starts[1:], len(ub)]
        gmax = np.maximum.reduceat(uc, starts)
        for g in np.flatnonzero(gmax >= max(3, min_votes // 3)):
            d, nn = udt[starts[g]:ends[g]], uc[starts[g]:ends[g]]
            k = int(np.argmax(nn))
            votes = int(nn[np.abs(d - d[k]) <= 1].sum())
            far = np.abs(d - d[k]) > 2
            second = int(nn[far].max()) if far.any() else 0
            if votes >= min_votes and nn[k] >= ratio * max(second, 1):
                edges.append({"a": c["idx"], "b": int(ub[starts[g]]),
                              "off": float(d[k] * FRAME_S), "votes": votes})
    return edges


# ---- placement -------------------------------------------------------------
def place(clips, edges):
    n = len(clips)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    adj = {i: [] for i in range(n)}
    for e in sorted(edges, key=lambda e: -e["votes"]):
        ra, rb = find(e["a"]), find(e["b"])
        if ra != rb:
            parent[ra] = rb
            adj[e["a"]].append((e["b"], e["off"]))
            adj[e["b"]].append((e["a"], -e["off"]))
            e["tree"] = True
    comps = {}
    for i in range(n):
        comps.setdefault(find(i), []).append(i)
    rel = {}
    for members in comps.values():
        root = max(members, key=lambda i: len(adj[i]))
        rel[root] = 0.0
        stack = [root]
        while stack:
            u = stack.pop()
            for v, off in adj[u]:
                if v not in rel:
                    rel[v] = rel[u] + off
                    stack.append(v)
    # least-squares over ALL consistent matches (averages out small errors along chains)
    from scipy.sparse import lil_matrix
    from scipy.sparse.linalg import lsqr
    for members in comps.values():
        if len(members) < 3:
            continue
        mset = set(members)
        col = {i: k for k, i in enumerate(members)}
        root = members[0]
        for _ in range(2):
            es = [e for e in edges if e["a"] in mset
                  and abs(rel[e["b"]] - rel[e["a"]] - e["off"]) < 0.05]
            M = lil_matrix((len(es) + 1, len(members)))
            y = np.zeros(len(es) + 1)
            for r_, e in enumerate(es):
                w = np.sqrt(e["votes"]) * (2.0 if e.get("refined") else 1.0)
                M[r_, col[e["b"]]], M[r_, col[e["a"]]], y[r_] = w, -w, w * e["off"]
            M[len(es), col[root]], y[len(es)] = 100.0, 100.0 * rel[root]
            sol = lsqr(M.tocsr(), y, atol=1e-12, btol=1e-12)[0]
            for i in members:
                rel[i] = float(sol[col[i]])
    conflicts = [e for e in edges if abs(rel[e["b"]] - rel[e["a"]] - e["off"]) > 0.08]

    groups = sorted(comps.values(),
                    key=lambda m: (len(m), sum(clips[i]["duration"] for i in m)), reverse=True)
    comp_of = {i: gi for gi, g in enumerate(groups) for i in g}
    devs = sorted({c["dev"] for c in clips})

    def solve(conv):
        """Each device clock = audio timeline + constant. Blocks that share no sound
        are positioned by those clocks (start- or end-of-recording dates, per device)."""
        obs = [(i, clips[i]["dev"], comp_of[i],
                rel[i] - (clips[i]["date"] - (clips[i]["duration"] if conv[clips[i]["dev"]] else 0)))
               for i in range(n) if clips[i].get("date")]
        G, O = {0: 0.0}, {}
        for _ in range(40):
            changed = False
            for d in devs:
                v = [y - G[g] for i, dd, g, y in obs if dd == d and g in G]
                if v:
                    new = float(np.median(v))
                    changed |= d not in O or abs(O[d] - new) > 1e-6
                    O[d] = new
            for g in range(1, len(groups)):
                v = [y - O[dd] for i, dd, gg, y in obs if gg == g and dd in O]
                if v:
                    new = float(np.median(v))
                    changed |= g not in G or abs(G[g] - new) > 1e-6
                    G[g] = new
            if not changed:
                break
        resid = sum(abs(y - G[g] - O[dd]) for i, dd, g, y in obs if g in G and dd in O)
        return G, resid

    best = None
    combos = [dict(zip(devs, bits)) for bits in np.ndindex(*([2] * len(devs)))] \
        if len(devs) <= 8 else [dict.fromkeys(devs, 0)]
    for conv in combos:
        G, resid = solve(conv)
        score = (-len(G), round(resid, 3), sum(conv.values()))
        if best is None or score < best[0]:
            best = (score, G)
    G = best[1]
    for gi, g in enumerate(groups):
        for i in g:
            if gi == 0:
                clips[i]["start"] = rel[i]
                clips[i]["status"] = "synced" if len(g) > 1 else "only clip"
            elif gi in G:
                clips[i]["start"] = rel[i] - G[gi]
                clips[i]["status"] = "block placed by date" if len(g) > 1 else "placed by date"
                clips[i]["block"] = len(g)
    unplaced = [g for gi, g in enumerate(groups) if gi and gi not in G]
    end = max([clips[i]["start"] + clips[i]["duration"] for i in range(n) if "start" in clips[i]] or [0])
    cursor = end + 30
    for g in unplaced:
        base = min(rel[i] for i in g)
        for i in g:
            clips[i]["start"] = cursor + rel[i] - base
            clips[i]["status"] = "NOT PLACED"
        cursor = max(clips[i]["start"] + clips[i]["duration"] for i in g) + 10
    t0 = min(c["start"] for c in clips)
    for c in clips:
        c["start"] -= t0
    return conflicts


# ---- XML (Final Cut Pro 7 XML, which Premiere imports) ---------------------
def rate_xml(fps):
    ntsc = abs(fps - round(fps) * 1000 / 1001) < 0.01 and abs(fps - round(fps)) > 0.001
    tb = int(round(fps))
    return f"<rate><timebase>{tb}</timebase><ntsc>{'TRUE' if ntsc else 'FALSE'}</ntsc></rate>", tb, ntsc


def build_xml(clips, devices, seq_name, seq_fps, keep_silent, skip_silent_clips):
    seq_rate, tb, ntsc = rate_xml(seq_fps)
    fps = tb * 1000 / 1001 if ntsc else tb
    fr = lambda s: int(round(s * fps))

    for c in clips:
        c["f_start"] = fr(c["start"])
        c["f_len"] = max(1, fr(c["duration"]))
        c["f_end"] = c["f_start"] + c["f_len"]

    video_tracks, audio_tracks = [], []
    lane_info = []
    for d, dname in enumerate(devices):
        dc = sorted([c for c in clips if c["dev"] == d], key=lambda c: c["f_start"])
        if not dc:
            continue
        lanes = []
        for c in dc:
            for li, lend in enumerate(lanes):
                if c["f_start"] >= lend:
                    lanes[li] = c["f_end"]
                    c["lane"] = li
                    break
            else:
                lanes.append(c["f_end"])
                c["lane"] = len(lanes) - 1
        maxch = max(c["nch"] for c in dc)
        live_ch = set()
        for c in dc:
            live_ch |= {ch for ch in range(1, c["nch"] + 1) if ch not in c["silent"]}
        chans = list(range(1, maxch + 1)) if keep_silent else sorted(live_ch)
        is_cam = any(c["has_video"] for c in dc)
        for li in range(len(lanes)):
            lane = [c for c in dc if c["lane"] == li]
            if is_cam:
                video_tracks.append([(c, None) for c in lane if c["has_video"]])
            for ch in chans:
                items = []
                for c in lane:
                    if ch > c["nch"]:
                        continue
                    if skip_silent_clips and ch in c["silent"]:
                        continue
                    items.append((c, ch))
                if items:
                    audio_tracks.append(items)
        lane_info.append((dname, len(lanes), chans))

    # ids and indices
    item_id = {}
    counter = [0]
    for kind, tracks in (("v", video_tracks), ("a", audio_tracks)):
        for ti, tr in enumerate(tracks, 1):
            for ci, (c, ch) in enumerate(tr, 1):
                counter[0] += 1
                item_id[(c["idx"], ch)] = (f"clipitem-{counter[0]}", kind, ti, ci)
    file_written = set()

    def file_xml(c):
        fid = f"file-{c['idx'] + 1}"
        if fid in file_written:
            return f'<file id="{fid}"/>'
        file_written.add(fid)
        frate = rate_xml(c.get("fps") or seq_fps)[0]
        fpsf = c.get("fps") or seq_fps
        url = "file://localhost" + quote(os.path.abspath(c["path"]))
        media = ""
        if c["has_video"]:
            media += (f"<video><samplecharacteristics>{frate}<width>{c['width']}</width>"
                      f"<height>{c['height']}</height></samplecharacteristics></video>")
        if c["nch"]:
            media += (f"<audio><samplecharacteristics><depth>24</depth><samplerate>{c['samplerate']}"
                      f"</samplerate></samplecharacteristics><channelcount>{c['nch']}</channelcount></audio>")
        return (f'<file id="{fid}"><name>{escape(c["name"])}</name><pathurl>{escape(url)}</pathurl>'
                f"{frate}<duration>{max(1, int(round(c['duration'] * fpsf)))}</duration>"
                f"<media>{media}</media></file>")

    label = {"placed by date": "Orange", "block placed by date": "Yellow", "NOT PLACED": "Red"}

    by_clip = {}
    for key, val in item_id.items():
        by_clip.setdefault(key[0], []).append(val)

    def item_xml(c, ch):
        iid, kind, ti, ci = item_id[(c["idx"], ch)]
        x = (f'<clipitem id="{iid}"><name>{escape(c["name"])}</name><enabled>TRUE</enabled>'
             f"<duration>{c['f_len']}</duration>{seq_rate}<start>{c['f_start']}</start>"
             f"<end>{c['f_end']}</end><in>0</in><out>{c['f_len']}</out>{file_xml(c)}")
        if ch is not None:
            x += f"<sourcetrack><mediatype>audio</mediatype><trackindex>{ch}</trackindex></sourcetrack>"
        for lid, lk, lti, lci in by_clip[c["idx"]]:
            x += (f"<link><linkclipref>{lid}</linkclipref><mediatype>"
                  f"{'video' if lk == 'v' else 'audio'}</mediatype><trackindex>{lti}</trackindex>"
                  f"<clipindex>{lci}</clipindex></link>")
        if c["status"] in label:
            x += f"<labels><label2>{label[c['status']]}</label2></labels>"
        return x + "</clipitem>"

    cams = [c for c in clips if c["has_video"]]
    w = cams[0]["width"] if cams else 1920
    h = cams[0]["height"] if cams else 1080
    total = max([c["f_end"] for c in clips] or [1])
    out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE xmeml>", '<xmeml version="4">',
           f'<sequence id="sequence-1"><name>{escape(seq_name)}</name><duration>{total}</duration>'
           f"{seq_rate}<media><video><format><samplecharacteristics>{seq_rate}<width>{w}</width>"
           f"<height>{h}</height><pixelaspectratio>square</pixelaspectratio>"
           f"</samplecharacteristics></format>"]
    for tr in video_tracks:
        out.append("<track>" + "".join(item_xml(c, ch) for c, ch in tr) + "</track>")
    out.append("</video><audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics>"
               "<depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>")
    for tr in audio_tracks:
        out.append("<track>" + "".join(item_xml(c, ch) for c, ch in tr) + "</track>")
    out.append(f"</audio></media><timecode>{seq_rate}<string>00:00:00:00</string><frame>0</frame>"
               "<displayformat>NDF</displayformat></timecode></sequence></xmeml>")
    return "\n".join(out), lane_info, len(video_tracks), len(audio_tracks)


# ---- main ------------------------------------------------------------------
def tc(s):
    s = max(0, s)
    return f"{int(s // 3600):02d}:{int(s % 3600 // 60):02d}:{s % 60:06.3f}"


def scan_devices(project):
    """List device subfolders and their media files (no decoding)."""
    devices = sorted(d for d in os.listdir(project)
                     if os.path.isdir(os.path.join(project, d)) and not d.startswith("."))
    out = []
    for dname in devices:
        files = []
        for root, dirs, fnames in os.walk(os.path.join(project, dname)):
            dirs[:] = sorted(x for x in dirs if not x.startswith("."))
            for fn in sorted(fnames):
                ext = os.path.splitext(fn)[1].lower()
                if not fn.startswith(".") and ext in VIDEO_EXT | AUDIO_EXT:
                    files.append(os.path.join(root, fn))
        out.append({"name": dname, "files": files,
                    "camera": any(os.path.splitext(f)[1].lower() in VIDEO_EXT for f in files)})
    return out


def device_channels(files, sample=3):
    """Max audio channel count over the first few files of a device."""
    best = 0
    for f in files[:sample]:
        p = probe(f)
        if p:
            best = max(best, p["nch"])
    return best


def run(project, ref_channels=None, fps=None, keep_silent=False, skip_silent_clips=False,
        silence_db=-60.0, flat_db=3.0, min_votes=12, workers=None, output=None, name=None,
        clear_cache=False, progress=None, cancel=None):
    """Sync a project folder (one subfolder per device). Returns a result dict.

    progress(fraction 0..1, message) is called along the way; set the threading.Event
    `cancel` to stop early (raises Cancelled)."""
    say = progress or (lambda f, m: None)
    ref_channels = ref_channels or {}
    project = os.path.abspath(project)
    if not os.path.isdir(project):
        raise ValueError(f"Not a folder: {project}")
    name = name or os.path.basename(project)
    workers = workers or max(1, min(6, (os.cpu_count() or 2) - 1))

    say(0.0, "Looking for media...")
    devs = scan_devices(project)
    devices = [d["name"] for d in devs]
    files = [(i, f) for i, d in enumerate(devs) for f in d["files"]]
    if not devs:
        raise ValueError("No device subfolders found. Put each camera or recorder's "
                         "files in its own subfolder inside the project folder.")
    if not files:
        raise ValueError("No video or audio files found in the device subfolders.")

    clips, skipped = [], []
    with ThreadPoolExecutor(8) as ex:
        futs = [ex.submit(probe, f) for _, f in files]
        for k, ((d, path), fu) in enumerate(zip(files, futs)):
            _check(cancel)
            info = fu.result()
            say(0.02 + 0.05 * (k + 1) / len(files), f"Reading file info ({k + 1}/{len(files)})")
            if not info:
                skipped.append(path)
                continue
            info.update(dev=d, idx=len(clips), name=os.path.basename(path),
                        rel=os.path.relpath(path, project))
            clips.append(info)
    if not clips:
        raise ValueError("None of the files could be read.")

    cache_dir = os.path.join(project, CACHE_DIR)
    if clear_cache and os.path.isdir(cache_dir):
        shutil.rmtree(cache_dir, ignore_errors=True)
    os.makedirs(cache_dir, exist_ok=True)
    jobs = {}
    for c in clips:
        c["silent"], c["used"], c["note"] = [], [], ""
        if not c["nch"]:
            c["note"] = "no audio"
            continue
        st = os.stat(c["path"])
        r = ref_channels.get(devices[c["dev"]])
        key = f"{VERSION}|{c['path']}|{st.st_size}|{st.st_mtime}|{r}|{silence_db}|{flat_db}"
        cache = os.path.join(cache_dir, hashlib.sha1(key.encode()).hexdigest()[:20])
        jobs[c["idx"]] = (c["path"], cache, r, silence_db, flat_db)

    done = 0
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(analyze, j): i for i, j in jobs.items()}
        try:
            for f in as_completed(futs):
                _check(cancel)
                c = clips[futs[f]]
                done += 1
                try:
                    meta = f.result()
                except Exception as e:
                    meta = {"note": f"could not analyse audio ({e})"}
                c["silent"], c["used"] = meta.get("silent", []), meta.get("used", [])
                c["note"] = meta.get("note", "")
                c["mono_path"] = meta.get("mono")
                if meta.get("fp"):
                    z = np.load(meta["fp"])
                    c["fp_h"], c["fp_t"] = z["h"], z["t"]
                say(0.07 + 0.70 * done / max(1, len(jobs)),
                    f"Analysing audio ({done}/{len(jobs)})")
        except Cancelled:
            for f in futs:
                f.cancel()
            raise

    edges = match_all(clips, min_votes, 2.0,
                      progress=lambda fr, m: say(0.77 + 0.13 * fr, m), cancel=cancel)
    mono_cache = {}

    def mono(i):
        if i not in mono_cache:
            mono_cache[i] = np.load(clips[i]["mono_path"], mmap_mode="r")
        return mono_cache[i]

    for k, e in enumerate(edges):
        _check(cancel)
        if k % 10 == 0:
            say(0.90 + 0.07 * k / max(1, len(edges)), f"Fine-tuning sync ({k}/{len(edges)})")
        e["off"], e["refined"] = refine(mono(e["a"]), mono(e["b"]), e["off"])

    say(0.97, "Building timeline...")
    conflicts = place(clips, edges)
    seq_fps = fps or next((c["fps"] for c in clips if c["has_video"]), 25.0)
    xml, lane_info, nv, na = build_xml(clips, devices, name, seq_fps, keep_silent,
                                       skip_silent_clips)
    out = output or os.path.join(project, f"{name}_synced.xml")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(xml)
    report_path = os.path.join(project, "SlingSync_report.txt")
    counts = write_report(report_path, name, seq_fps, nv, na, clips, lane_info,
                          conflicts, skipped, project)
    say(1.0, "Done")
    need = [{"status": c["status"], "file": c["rel"], "at": tc(c["start"]), "note": c["note"]}
            for c in sorted(clips, key=lambda c: c["start"]) if c["status"] != "synced"]
    return {"xml": out, "report": report_path, "counts": counts, "need_check": need,
            "files": len(clips), "skipped": skipped, "devices": devices,
            "video_tracks": nv, "audio_tracks": na, "fps": seq_fps}


def write_report(path, name, seq_fps, nv, na, clips, lane_info, conflicts, skipped, proj):
    counts = {}
    for c in clips:
        counts[c["status"]] = counts.get(c["status"], 0) + 1
    R = [f"SlingSync {VERSION} report - {name}",
         f"Sequence: {seq_fps:.3f} fps, {nv} video tracks, {na} audio tracks", ""]
    R.append("Summary: " + ", ".join(f"{v} {k}" for k, v in sorted(counts.items())))
    R.append("")
    R.append("Tracks per device:")
    for dname, nl, chans in lane_info:
        R.append(f"  {dname}: {nl} lane(s), channels kept {chans or 'none'}"
                 + ("  (extra lanes = clips that overlap in time on one device - check those)"
                    if nl > 1 else ""))
    R.append("")
    need = [c for c in clips if c["status"] != "synced"]
    if need:
        R.append("CHECK THESE BY EYE")
        R.append("  block placed by date = synced by sound with each other, but the block shares no sound")
        R.append("                         with the rest, so its position comes from the file dates")
        R.append("  placed by date       = no sound overlap with any other device, positioned by file date")
        R.append("  NOT PLACED           = no usable sound or date, parked after the end of the timeline")
        for c in sorted(need, key=lambda c: c["start"]):
            why = c["note"]
            if c["status"] == "block placed by date":
                why = why or f"block of {c['block']} clips"
            R.append(f"  [{c['status']}] {c['rel']}  at {tc(c['start'])}  {why}")
        R.append("")
    if conflicts:
        R.append("Inconsistent matches (usually fine, but worth a look if something seems off):")
        for e in conflicts[:50]:
            R.append(f"  {clips[e['a']]['rel']}  <->  {clips[e['b']]['rel']}")
        R.append("")
    R.append("Silent channels (left out of the timeline when silent in every file of a device):")
    silent = [c for c in clips if c["silent"]]
    for c in silent:
        R.append(f"  {c['rel']}: silent ch {c['silent']}, synced using ch {c['used'] or '-'}")
    if not silent:
        R.append("  none")
    if skipped:
        R.append("")
        R.append("Unreadable files (skipped):")
        R += [f"  {os.path.relpath(p, proj)}" for p in skipped]
    R.append("")
    R.append("All clips:")
    for c in sorted(clips, key=lambda c: (c["dev"], c["start"])):
        R.append(f"  {tc(c['start'])}  {c['status']:<24} {c['rel']}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(R) + "\n")
    return counts
