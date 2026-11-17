"""Command-line interface: python -m slingsync /path/to/project"""
import argparse
import sys
import time

from . import __version__
from .engine import Cancelled, run


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="slingsync",
        description="Sync multicam + multitrack audio by sound and export a Premiere-ready "
                    "XML. Put each device's files in its own subfolder of the project folder.")
    ap.add_argument("project", help="project folder containing one subfolder per device")
    ap.add_argument("-o", "--output", help="XML path (default: <project>/<name>_synced.xml)")
    ap.add_argument("--name", help="sequence name (default: project folder name)")
    ap.add_argument("--fps", type=float, help="sequence frame rate (default: first camera)")
    ap.add_argument("--ref-channel", action="append", default=[], metavar="DEVICE=N",
                    help="only listen to channel N of DEVICE for syncing, e.g. Zoom1=3")
    ap.add_argument("--silence-db", type=float, default=-60.0,
                    help="channels quieter than this (dBFS) count as silent (default -60)")
    ap.add_argument("--flat-db", type=float, default=3.0,
                    help="channels with less dynamic range than this count as dead/hiss")
    ap.add_argument("--keep-silent", action="store_true",
                    help="keep channels that are silent in every file of a device")
    ap.add_argument("--skip-silent-clips", action="store_true",
                    help="also leave out channels that are silent in individual files")
    ap.add_argument("--min-votes", type=int, default=12, help="match strictness (default 12)")
    ap.add_argument("--workers", type=int, help="files analysed at once")
    ap.add_argument("--clear-cache", action="store_true", help="re-analyse every file")
    ap.add_argument("--version", action="version", version=f"SlingSync {__version__}")
    a = ap.parse_args(argv)

    ref = {}
    for r in a.ref_channel:
        try:
            k, v = r.split("=")
            ref[k] = int(v)
        except ValueError:
            ap.error(f"--ref-channel should look like Zoom1=3, got {r}")

    last = [0.0, ""]

    def progress(frac, msg):
        now = time.time()
        if msg != last[1] and (now - last[0] > 0.5 or frac >= 1):
            print(f"[{frac * 100:5.1f}%] {msg}", flush=True)
            last[0], last[1] = now, msg

    try:
        res = run(a.project, ref_channels=ref, fps=a.fps, keep_silent=a.keep_silent,
                  skip_silent_clips=a.skip_silent_clips, silence_db=a.silence_db,
                  flat_db=a.flat_db, min_votes=a.min_votes, workers=a.workers,
                  output=a.output, name=a.name, clear_cache=a.clear_cache, progress=progress)
    except (ValueError, Cancelled) as e:
        sys.exit(str(e) or "Cancelled")
    print()
    print("Summary: " + ", ".join(f"{v} {k}" for k, v in sorted(res["counts"].items())))
    print(f"XML:    {res['xml']}")
    print(f"Report: {res['report']}")


if __name__ == "__main__":
    main()
