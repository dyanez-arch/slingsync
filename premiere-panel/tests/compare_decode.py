"""Compare the panel decoder (FFmpeg WebAssembly, run in Node) with the desktop app's
decoding (PyAV) on the same files: channels, length and samples at 8 kHz.

usage: .venv/bin/python premiere-panel/tests/compare_decode.py [--seconds 120] FILE...
"""
import argparse, json, os, subprocess, sys, tempfile, time
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from slingsync import engine

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--seconds", type=float, default=120)
ap.add_argument("files", nargs="+")
a = ap.parse_args()
want = int(a.seconds * engine.SR)
ok_all = True
for f in a.files:
    t = time.time()
    py = []
    n = 0
    for blk in engine._blocks(f, 4000):
        py.append(blk); n += len(blk)
        if n >= want: break
    py = np.concatenate(py)[:want] if py else np.zeros((0, 0), np.float32)
    tpy = time.time() - t
    with tempfile.NamedTemporaryFile(suffix=".f32") as tmp:
        r = subprocess.run(["node", os.path.join(HERE, "decode_dump.js"), f, str(a.seconds), tmp.name],
                           capture_output=True, text=True)
        res = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {"error": r.stderr[-500:]}
        if "error" in res:
            print(f"✗ {os.path.basename(f)}: panel decoder error: {res['error']}"); ok_all = False; continue
        js = np.fromfile(tmp.name, np.float32).reshape(-1, max(1, res["channels"]))
    name = os.path.basename(f)
    if res["channels"] <= 0 or not len(py):
        same = (res["channels"] <= 0) == (not len(py))
        ok_all &= same
        print(f"{'✓' if same else '✗'} {name}: no audio (app {'none' if not len(py) else 'some'}, "
              f"panel {'none' if res['channels'] <= 0 else 'some'})")
        continue
    if py.shape[1] != js.shape[1]:
        print(f"✗ {name}: channels app {py.shape[1]} vs panel {js.shape[1]}"); ok_all = False; continue
    m = min(len(py), len(js))
    diff = float(np.max(np.abs(py[:m] - js[:m]))) if m else 0.0
    # sample lag on the loudest channel (should be 0)
    c = int(np.argmax(np.std(py[:m], axis=0))) if m else 0
    x, y = py[:m, c], js[:m, c]
    lag = 0
    if m > 1000 and np.std(x) > 0:
        seg = slice(m // 4, m // 4 + min(8000, m // 2))
        best = max(range(-20, 21), key=lambda k: float(np.dot(x[seg], np.roll(y, -k)[seg])))
        lag = best
    peak = float(np.max(np.abs(py[:m]))) if m else 0.0
    same = diff <= max(1e-4, 1e-3 * peak)   # identical samples: no lag possible (tones repeat,
    lag = 0 if same else lag                 # so the lag search alone can be fooled)
    ok = py.shape[0] == js.shape[0] and same
    ok_all &= ok
    fmt = res["info"]["format"]; codecs = sorted({s["codec"] for s in res["info"]["streams"] if s["type"] == "audio"})
    print(f"{'✓' if ok else '✗'} {name} [{fmt}, {'/'.join(codecs)}]: {py.shape[1]} ch, "
          f"frames app {len(py)} panel {len(js)}, max diff {diff:.2e} (peak {peak:.2f}), lag {lag}, "
          f"time app {tpy:.1f}s panel {res['ms']/1000:.1f}s")
sys.exit(0 if ok_all else 1)
