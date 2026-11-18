"""Sync one shoot with the desktop app's engine (Python) and the plug-in engine (JavaScript,
in Node) and compare the results clip by clip. Nothing is written to the shoot folder:
XML, reports and analysis caches go to OUTDIR.

usage: .venv/bin/python premiere-plugin/tests/compare_sync.py PROJECT OUTDIR
"""
import json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from slingsync import engine

HERE = os.path.dirname(os.path.abspath(__file__))
project, outdir = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
os.makedirs(outdir, exist_ok=True)

# --- desktop app engine, redirected ---
py_xml, py_rep = os.path.join(outdir, "py.xml"), os.path.join(outdir, "py_report.txt")
if not os.path.exists(os.path.join(outdir, "py_compact.xml")) or "--rerun-py" in sys.argv:
    engine.CACHE_DIR = os.path.join(outdir, "py_cache")      # absolute: os.path.join keeps it
    orig = engine.write_report
    engine.write_report = lambda path, *a, **k: orig(py_rep, *a, **k)
    lines = []
    t = time.time()
    engine.run(project, output=py_xml, log=lines.append, compact=True)
    open(os.path.join(outdir, "py_log.txt"), "w").write("\n".join(lines) + "\n")
    os.replace(os.path.join(outdir, os.path.basename(project) + "_compact.xml"), os.path.join(outdir, "py_compact.xml"))
    print(f"app engine: {time.time() - t:.0f} s")

# --- plug-in engine ---
t = time.time()
r = subprocess.run(["node", os.path.join(HERE, "run_sync.js"), project, outdir])
if r.returncode:
    sys.exit("plug-in engine failed")
print(f"plug-in engine: {time.time() - t:.0f} s")
os.replace(os.path.join(outdir, os.path.basename(project) + "_compact.xml"), os.path.join(outdir, "js_compact.xml"))
xml_same = True
for kind in ("", "_compact"):
    same = open(os.path.join(outdir, f"py{kind or ''}.xml" if kind else os.path.join(outdir, "py.xml")), "rb").read() == \
        open(os.path.join(outdir, f"js{kind}.xml"), "rb").read()
    print(f"XML{kind or ''}: {'identical' if same else 'DIFFERENT'}")
    xml_same &= same

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
print(f"\nclips: app {len(a)}, plug-in {len(b)}, same status {same_status}/{len(a)}")
for lim in (0.001, 0.0205, 0.5):
    print(f"  start within {lim * 1000:g} ms: {sum(1 for d, _ in diffs if d <= lim)}/{len(diffs)}")
print("largest differences:")
for d, k in diffs[:8]:
    print(f"  {d * 1000:9.1f} ms  {a[k][1]:<16} {b[k][1]:<16} {k}")
for k in a:
    if k in b and a[k][1] != b[k][1]:
        print(f"  status differs: {k}: app {a[k][1]}, plug-in {b[k][1]}")

# --expect "Rec/R1.m4a=0,CamA/A1.m4a=50,…": known positions (seconds, within 1 ms)
expect_bad = []
for arg in sys.argv:
    if arg.startswith("--expect="):
        for item in arg.split("=", 1)[1].split(","):
            rel, t = item.rsplit("=", 1)
            if rel not in a or abs(a[rel][0] - float(t)) > 0.001:
                expect_bad.append(f"{rel}: expected {t} s, got {a.get(rel, ('missing',))[0]}")
for e in expect_bad:
    print("  WRONG POSITION " + e)
ok = xml_same and same_status == len(a) == len(b) and not expect_bad
print("RESULT:", "OK" if ok else "MISMATCH")
sys.exit(0 if ok else 1)
