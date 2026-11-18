"""Sync one shoot with the desktop app's engine (Python) and the panel engine (JavaScript,
in Node) and compare the results clip by clip. Nothing is written to the shoot folder:
XML, reports and analysis caches go to OUTDIR.

usage: .venv/bin/python premiere-panel/tests/compare_sync.py PROJECT OUTDIR
"""
import json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from slingsync import engine

HERE = os.path.dirname(os.path.abspath(__file__))
project, outdir = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
os.makedirs(outdir, exist_ok=True)

# --- desktop app engine, redirected ---
py_xml, py_rep = os.path.join(outdir, "py.xml"), os.path.join(outdir, "py_report.txt")
if not os.path.exists(py_rep) or "--rerun-py" in sys.argv:
    engine.CACHE_DIR = os.path.join(outdir, "py_cache")      # absolute: os.path.join keeps it
    orig = engine.write_report
    engine.write_report = lambda path, *a, **k: orig(py_rep, *a, **k)
    lines = []
    t = time.time()
    engine.run(project, output=py_xml, log=lines.append)
    open(os.path.join(outdir, "py_log.txt"), "w").write("\n".join(lines) + "\n")
    print(f"app engine: {time.time() - t:.0f} s")

# --- panel engine ---
t = time.time()
r = subprocess.run(["node", os.path.join(HERE, "run_sync.js"), project, outdir])
if r.returncode:
    sys.exit("panel engine failed")
print(f"panel engine: {time.time() - t:.0f} s")

def clips(rep):
    out, on = {}, False
    for line in open(rep):
        if line.startswith("All clips:"):
            on = True; continue
        if on and line.strip():
            m = re.match(r"\s+(\d+):(\d+):([\d.]+)\s+(.+?)\s{2,}(.*)$", line.rstrip("\n"))
            if m:
                out[m.group(5)] = (int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)), m.group(4).strip())
    return out

a, b = clips(py_rep), clips(os.path.join(outdir, "js_report.txt"))
same_status = sum(1 for k in a if k in b and a[k][1] == b[k][1])
diffs = sorted(((abs(a[k][0] - b[k][0]), k) for k in a if k in b), reverse=True)
print(f"\nclips: app {len(a)}, panel {len(b)}, same status {same_status}/{len(a)}")
for lim in (0.001, 0.0205, 0.5):
    print(f"  start within {lim * 1000:g} ms: {sum(1 for d, _ in diffs if d <= lim)}/{len(diffs)}")
print("largest differences:")
for d, k in diffs[:8]:
    print(f"  {d * 1000:9.1f} ms  {a[k][1]:<16} {b[k][1]:<16} {k}")
for k in a:
    if k in b and a[k][1] != b[k][1]:
        print(f"  status differs: {k}: app {a[k][1]}, panel {b[k][1]}")
