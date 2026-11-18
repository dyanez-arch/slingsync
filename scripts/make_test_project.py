"""Make a small synthetic SlingSync project with known answers, for regression testing.

    python scripts/make_test_project.py /tmp/synth                  # correct clocks
    python scripts/make_test_project.py /tmp/synth --camb-clock-off 94608000   # Cam B 3 years off
    python scripts/make_test_project.py /tmp/synth --proxies         # Cam A as proxies only
    slingsync -v /tmp/synth

Devices (audio-only .m4a files, which is enough to test sync and placement):
    Rec   2 takes; ch1 = scene A, ch2 = steady hiss (a dead preamp: must be ignored)
    CamA  3 clips; ch1 = scene A (quieter, extra noise), ch2 = digital silence
          A1 and A2 overlap the recorder; A3 rolls while the recorder is off
    CamB  2 clips of a different scene: shares no sound with anything

Expected timeline starts (seconds), printed at the end:
    R1 0, A1 50, B1 100, R2 250, A2 300, B2 320, A3 520
With --camb-clock-off, Cam B starts at the beginning of the timeline instead
(B1 0, B2 220) and is flagged "its clock is a guess".
"""
import argparse
import datetime
import os
import shutil

import av
import numpy as np

SR = 16000
LENGTH = 600


def scene(seed):
    """Steady ambience plus sparse chirps (voices, knocks)."""
    r = np.random.default_rng(seed)
    x = r.standard_normal(LENGTH * SR).astype(np.float32) * 0.05
    for _ in range(400):
        s = r.integers(0, LENGTH * SR - 8000)
        n = r.integers(800, 8000)
        f = r.uniform(300, 2500)
        t = np.arange(n) / SR
        x[s:s + n] += (0.08 * np.sin(2 * np.pi * f * t * (1 + 0.3 * t)) * np.hanning(n)).astype(np.float32)
    return x


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", help="folder to create (replaced if it exists)")
    ap.add_argument("--camb-clock-off", type=float, default=0.0,
                    help="seconds Cam B's clock is wrong by (default 0)")
    ap.add_argument("--proxies", action="store_true",
                    help="write Cam A as Proxies/*_Proxy files only, and add a proxy next to R1")
    a = ap.parse_args()

    shutil.rmtree(a.out, ignore_errors=True)
    rng = np.random.default_rng(1)
    scene_a, scene_b = scene(1), scene(2)
    base = datetime.datetime(2023, 10, 29, 20, 0, 0)

    def write(rel, chans, t0, dur, clock_shift=0.0):
        path = os.path.join(a.out, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        seg = np.stack([c[int(t0 * SR):int((t0 + dur) * SR)] for c in chans]).astype(np.float32)
        c = av.open(path, "w")
        c.metadata["creation_time"] = (base + datetime.timedelta(seconds=t0 + clock_shift)) \
            .strftime("%Y-%m-%dT%H:%M:%S.000000Z")
        st = c.add_stream("aac", rate=SR)
        st.layout = "stereo" if len(chans) == 2 else "mono"
        fr = av.AudioFrame.from_ndarray(seg, format="fltp", layout=st.layout.name)
        fr.sample_rate = SR
        for p in st.encode(fr):
            c.mux(p)
        for p in st.encode(None):
            c.mux(p)
        c.close()

    hiss = rng.standard_normal(LENGTH * SR).astype(np.float32) * 0.01
    zero = np.zeros(LENGTH * SR, np.float32)
    cam_a = scene_a * 0.7 + rng.standard_normal(LENGTH * SR).astype(np.float32) * 0.02

    write("Rec/R1.m4a", [scene_a, hiss], 0, 200)
    write("Rec/R2.m4a", [scene_a, hiss], 250, 250)
    if a.proxies:
        write("Rec/Proxies/R1_Proxy.m4a", [scene_a, hiss], 0, 200)
    for name, t0, dur in (("A1", 50, 100), ("A2", 300, 100), ("A3", 520, 60)):
        rel = f"CamA/Proxies/{name}_Proxy.m4a" if a.proxies else f"CamA/{name}.m4a"
        write(rel, [cam_a, zero], t0, dur)
    write("CamB/B1.m4a", [scene_b], 100, 80, a.camb_clock_off)
    write("CamB/B2.m4a", [scene_b], 320, 60, a.camb_clock_off)

    print(f"Wrote {a.out}")
    if a.camb_clock_off:
        print("Expected starts: R1 0, A1 50, R2 250, A2 300, A3 520; Cam B: B1 0, B2 220 (clock guessed)")
    else:
        print("Expected starts: R1 0, A1 50, B1 100, R2 250, A2 300, B2 320, A3 520")


if __name__ == "__main__":
    main()
