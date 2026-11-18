# Command line

Install from the repo root:

```
pip install .
```

This provides two commands: `slingsync` (CLI) and `slingsync-app` (desktop app). You can also run `python -m slingsync`.

## Usage

```
slingsync PROJECT [options]
```

`PROJECT` is the folder containing one subfolder per device (see the [user guide](user-guide.md#2-set-up-the-project-folder)).

## Options

| Option | Default | Description |
|---|---|---|
| `-o`, `--output PATH` | `<project>/<name>_synced.xml` | Where to write the XML |
| `--name NAME` | project folder name | Sequence name, also used in the XML file name |
| `--fps N` | first camera's rate | Sequence frame rate, e.g. `25`, `23.976`, `29.97` |
| `--ref-channel DEVICE=N` | all live channels | Sync using only channel N of DEVICE. Repeat for several devices |
| `--silence-db DB` | `-60` | A channel whose 95th-percentile loudness is below this (dBFS) counts as silent |
| `--flat-db DB` | `3` | A channel whose loudness range (95th minus 10th percentile) is less than this counts as dead or hiss-only, unless every live channel in the file is like that (steady ambience), in which case they're used |
| `--keep-silent` | off | Keep channels on the timeline even when they're silent in every file of a device |
| `--skip-silent-clips` | off | Also leave out channels that are silent in individual files |
| `--audio` | off | Also write aligned 24-bit WAV files, one per device channel, for any audio editor. See [Audio only](user-guide.md#4b-audio-only-podcasts-music-interviews-no-premiere-needed) |
| `--audio-dir DIR` | `<project>/<name>_audio` | Where to write the WAV files |
| `--audio-rate N` | most common rate in the project | Sample rate of the WAV files, e.g. `48000` |
| `--min-votes N` | `12` | Match strictness. Higher means fewer but more certain matches |
| `--workers N` | CPU count − 1, max 6 | Files analysed at once |
| `-v`, `--verbose` | off | Print details for every file (channels, levels, date), every match (offset, votes, drift) and the final placement. Useful when something didn't sync |
| `--clear-cache` | off | Delete `.slingsync_cache` and re-analyse every file |
| `--version` | | Print the version |

## Examples

```bash
# Basic
slingsync "/Volumes/Shoot/Interview Day 1"

# 25 fps sequence, recorder synced from its ambient mic on channel 3
slingsync "Interview Day 1" --fps 25 --ref-channel "Zoom F6=3"

# Two reference channels, custom output
slingsync "Day 2" --ref-channel "Zoom F6=3" --ref-channel "CamB=1" -o ~/Desktop/day2.xml

# Podcast: just aligned WAV files for an audio editor
slingsync "Podcast Ep 12" --audio

# Noisy location: be stricter about matches
slingsync "Day 3" --min-votes 20
```

## Output

Progress lines like `[ 42.0%] Analysing audio (120/290)`, then:

```
Summary: 3 placed by date, 287 synced
XML:    /…/Interview Day 1/Interview Day 1_synced.xml
Report: /…/Interview Day 1/SlingSync_report.txt
```

Exit status is non-zero, with a message, if the folder has no device subfolders, no media, or no readable files.

## Using the engine from Python

```python
from slingsync.engine import run

res = run("/path/to/project", fps=25, ref_channels={"Zoom F6": 3},
          progress=lambda frac, msg: print(f"{frac:.0%} {msg}"))
print(res["xml"], res["counts"], res["need_check"])
```

`run()` accepts the same settings as the CLI (`keep_silent`, `skip_silent_clips`, `silence_db`, `flat_db`, `min_votes`, `workers`, `output`, `name`, `clear_cache`, and `stems`, `stems_dir`, `stems_rate` for the WAV export) plus `log` (a function that receives the verbose lines) and `cancel`, a `threading.Event` that stops the run by raising `slingsync.engine.Cancelled`.

It returns a dict with `xml`, `report`, `counts`, `need_check` (status, file, position, note for every clip not synced by sound), `files`, `skipped`, `devices`, `video_tracks`, `audio_tracks`, `fps`, and `stems` / `stems_dir` (the WAV files written, if any).
