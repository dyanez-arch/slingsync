"""SlingSync desktop app (PySide6)."""
import json
import os
import time
import subprocess
import sys
import threading

from PySide6.QtCore import QEvent, QObject, Qt, QThread, QTimer, QUrl, QUrlQuery, Signal
from PySide6.QtGui import QAction, QDesktopServices, QIcon, QKeySequence, QPixmap
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QCheckBox, QComboBox,
                               QDialog, QDialogButtonBox, QFileDialog, QFrame, QHBoxLayout,
                               QHeaderView, QLabel, QListWidget, QMainWindow, QMessageBox,
                               QProgressBar, QPushButton, QSizePolicy, QTableWidget,
                               QTableWidgetItem, QTextBrowser, QVBoxLayout, QWidget)

from . import __version__, full_version
from . import engine

FPS_CHOICES = [("Match first camera", None), ("23.976", 24000 / 1001), ("24", 24.0),
               ("25", 25.0), ("29.97", 30000 / 1001), ("30", 30.0), ("50", 50.0),
               ("59.94", 60000 / 1001), ("60", 60.0)]
AUTO_CH = "All live channels (recommended)"
ICON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resources", "icon.png")
REPO = "https://github.com/dyanez-arch/slingsync"
DOCS = REPO + "/blob/main/docs/"
COPYRIGHT = "© 2026 Daniel Juan Yanez Villagomez"
CREATOR_URL = "https://github.com/dyanez-arch"
# Donation page (e.g. "https://ko-fi.com/<name>"); the About line is hidden while empty.
# Keep in sync with SUPPORT_URL in premiere-panel/index.js.
SUPPORT_URL = "https://ko-fi.com/pisdronio"


STATUS_FILE = ".slingsync_status.json"


def write_status(folder, **fields):
    """Progress/result file the Premiere panel reads (written atomically)."""
    try:
        fields["time"] = time.time()
        path = os.path.join(folder, STATUS_FILE)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(fields, fh)
        os.replace(tmp, path)
    except OSError:
        pass


def logo(size):
    pm = QPixmap(ICON)
    if pm.isNull():
        return QPixmap()
    dpr = 2.0
    pm = pm.scaled(int(size * dpr), int(size * dpr), Qt.KeepAspectRatio, Qt.SmoothTransformation)
    pm.setDevicePixelRatio(dpr)
    return pm


GUIDE_HTML = """
<h2>Quick guide</h2>

<h3>1. Make a project folder</h3>
<p>One folder per shooting day, with <b>one subfolder per camera or recorder</b>:</p>
<pre>Interview Day 1/
    Cam A/      clips from camera A (card folders inside are fine)
    Cam B/
    Recorder/   multichannel WAVs</pre>
<p>Folder names become track names in Premiere. Loose files with no subfolders also work:
SlingSync then guesses the devices from the file names, so check the device list.</p>
<p><b>Proxies:</b> Premiere <i>_Proxy</i> files are skipped when the original is there, and
used when it isn't (the sequence then points at the proxies).</p>

<h3>2. Sync</h3>
<p>Drop the folder on the window (or click <b>Choose Folder…</b>), check the device list,
then click <b>Sync</b>. The first sync of a folder reads every file. Syncing the same folder
again is much faster, because the analysis is saved in a hidden <i>.slingsync_cache</i>
folder inside it.</p>
<p><b>Sync using</b> lets you pick one channel of a device (e.g. the ambient mic). The default,
all live channels, is usually best.</p>

<h3>3. Import into Premiere</h3>
<p><b>File → Import…</b> and choose the <i>…_synced.xml</i> file in the project folder.
Each device gets its own video track and one audio track per channel.</p>

<h3>4. What the colours mean</h3>
<table cellpadding="4">
<tr><td><b>No colour</b></td><td>Synced by sound with at least one other device.</td></tr>
<tr><td><b style="color:#e8912d">Orange</b></td><td>Placed by date: shares no sound with another
device (cutaways, drone, a camera rolling while the recorder was off). Positioned by its device's
clock, checked against nearby synced clips. Worth a look.</td></tr>
<tr><td><b style="color:#d64545">Red</b></td><td>Not placed: no usable sound or date. Parked
after the end of the timeline.</td></tr>
</table>
<p>The report (<b>Open Report</b>) lists every clip to check, how reliable each device's clock
was, clock drift on long takes, and silent channels.</p>

<h3>Audio only (podcasts, music, interviews)</h3>
<p>Tick <b>Also export audio files</b> before syncing. SlingSync writes one WAV file per
microphone/channel into a <i>…_audio</i> folder. Drop them all at the very start of the timeline
in any audio editor (Audacity, Reaper, Logic, Descript, GarageBand…) and they are in sync, to
the audio sample. No Premiere or video needed: a folder of recorder and phone audio works.
Long shooting days make big files (about 0.5 GB per hour per channel).</p>

<h3>Compact timeline (review, transcripts)</h3>
<p>Tick <b>Also make a compact timeline</b> to get a second XML, <i>…_compact.xml</i>: the
same sync with every stretch where nothing was recording cut out, so the whole day plays as
one continuous block. Clips that overlap stay in sync. Handy for reviewers, or to make one
transcript of everything recorded that day.</p>

<h3>5. Next shooting day</h3>
<p>Click <b>New Sync</b> (⌘N) or <b>Sync Another Folder</b>, or just drop another folder on
the window.</p>

<h3>Tips</h3>
<ul>
<li>Syncing by sound needs no timecode. Timecode and correct camera clocks help place clips
that share no sound.</li>
<li>Give every camera some scratch audio, even a poor on-camera mic.</li>
<li>Work from an SSD or a reliable drive. Bus-powered USB hard drives can disconnect during
long reads.</li>
</ul>

<p>More: <a href="{docs}user-guide.md">full user guide</a> ·
<a href="{docs}troubleshooting.md">troubleshooting</a> ·
<a href="{repo}/issues">report a problem</a></p>
""".format(docs=DOCS, repo=REPO)


def reveal(path):
    if sys.platform == "darwin":
        subprocess.run(["open", "-R", path])
    else:
        QDesktopServices.openUrl(QUrl.fromLocalFile(os.path.dirname(path)))


def open_file(path):
    if sys.platform == "darwin":
        subprocess.run(["open", path])
    else:
        QDesktopServices.openUrl(QUrl.fromLocalFile(path))


# ---- background work --------------------------------------------------------
class ScanWorker(QObject):
    done = Signal(list)
    failed = Signal(str)

    def __init__(self, folder):
        super().__init__()
        self.folder = folder

    def go(self):
        try:
            devs = engine.scan_devices(self.folder)
            for d in devs:
                d["channels"] = engine.device_channels(d["files"])
            self.done.emit(devs)
        except Exception as e:
            self.failed.emit(str(e))


class SyncWorker(QObject):
    progress = Signal(float, str)
    done = Signal(dict)
    failed = Signal(str)

    def __init__(self, kwargs):
        super().__init__()
        self.kwargs = kwargs
        self.cancel = threading.Event()

    def go(self):
        try:
            res = engine.run(progress=lambda f, m: self.progress.emit(f, m),
                             cancel=self.cancel, **self.kwargs)
            self.done.emit(res)
        except engine.Cancelled:
            self.failed.emit("Cancelled.")
        except Exception as e:
            self.failed.emit(str(e) or e.__class__.__name__)


def start_in_thread(owner, worker):
    th = QThread(owner)
    worker.moveToThread(th)
    th.started.connect(worker.go)
    for sig in ("done", "failed"):
        getattr(worker, sig).connect(th.quit)
    if not hasattr(owner, "_threads"):
        owner._threads = []
    pair = (th, worker)
    owner._threads.append(pair)
    th.finished.connect(lambda: owner._threads.remove(pair))
    th.finished.connect(th.deleteLater)
    th.start()
    return th


# ---- widgets ----------------------------------------------------------------
class DropZone(QFrame):
    folderDropped = Signal(str)

    def __init__(self):
        super().__init__()
        self.setAcceptDrops(True)
        self.setObjectName("drop")
        self.setMinimumHeight(120)
        lay = QVBoxLayout(self)
        lay.setAlignment(Qt.AlignCenter)
        self.title = QLabel("Drop your project folder here")
        f = self.title.font()
        f.setPointSize(f.pointSize() + 3)
        f.setBold(True)
        self.title.setFont(f)
        self.title.setAlignment(Qt.AlignCenter)
        hint = QLabel("Inside it, one subfolder per camera or recorder")
        hint.setAlignment(Qt.AlignCenter)
        hint.setObjectName("muted")
        self.button = QPushButton("Choose Folder…")
        self.button.clicked.connect(self.choose)
        lay.addWidget(self.title)
        lay.addWidget(hint)
        row = QHBoxLayout()
        row.addStretch()
        row.addWidget(self.button)
        row.addStretch()
        lay.addLayout(row)
        self._style(False)

    def _style(self, hot):
        self.setStyleSheet(
            "#drop { border: 2px dashed %s; border-radius: 12px; }"
            % ("palette(highlight)" if hot else "palette(mid)"))

    def choose(self):
        d = QFileDialog.getExistingDirectory(self, "Choose the project folder")
        if d:
            self.folderDropped.emit(d)

    def dragEnterEvent(self, e):
        urls = e.mimeData().urls()
        if urls and os.path.isdir(urls[0].toLocalFile()):
            e.acceptProposedAction()
            self._style(True)

    def dragLeaveEvent(self, e):
        self._style(False)

    def dropEvent(self, e):
        self._style(False)
        path = e.mimeData().urls()[0].toLocalFile()
        if os.path.isdir(path):
            self.folderDropped.emit(path)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("SlingSync")
        self.resize(760, 720)
        self.folder = None
        self.devices = []
        self.worker = None
        self.result = None
        self.remote = None          # sync requested by the Premiere panel
        self._last_status = 0.0

        root = QWidget()
        self.setCentralWidget(root)
        lay = QVBoxLayout(root)
        lay.setContentsMargins(22, 18, 22, 18)
        lay.setSpacing(12)

        header = QHBoxLayout()
        header.setSpacing(14)
        mark = QLabel()
        mark.setPixmap(logo(56))
        header.addWidget(mark)
        titles = QVBoxLayout()
        titles.setSpacing(0)
        title = QLabel("SlingSync")
        tf = title.font()
        tf.setPointSize(tf.pointSize() + 10)
        tf.setBold(True)
        title.setFont(tf)
        sub = QLabel("Sync cameras and multitrack audio by sound. No timecode required.")
        sub.setObjectName("muted")
        titles.addWidget(title)
        titles.addWidget(sub)
        header.addLayout(titles, 1)
        self.new_btn = QPushButton("New Sync")
        self.new_btn.setToolTip("Clear everything and start a new shooting day (⌘N)")
        self.new_btn.clicked.connect(self.reset)
        self.new_btn.setVisible(False)
        help_btn = QPushButton("Help")
        help_btn.clicked.connect(self.show_help)
        header.addWidget(self.new_btn, 0, Qt.AlignTop)
        header.addWidget(help_btn, 0, Qt.AlignTop)
        lay.addLayout(header)

        self.drop = DropZone()
        self.drop.folderDropped.connect(self.load_folder)
        lay.addWidget(self.drop)

        self.folder_label = QLabel("")
        self.folder_label.setObjectName("muted")
        self.folder_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        lay.addWidget(self.folder_label)

        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["Device", "Files", "Type", "Sync using"])
        h = self.table.horizontalHeader()
        h.setSectionResizeMode(0, QHeaderView.Stretch)
        for c in (1, 2):
            h.setSectionResizeMode(c, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionMode(QAbstractItemView.NoSelection)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setMinimumHeight(140)
        lay.addWidget(self.table)

        opts = QHBoxLayout()
        opts.addWidget(QLabel("Sequence frame rate:"))
        self.fps = QComboBox()
        for label, _ in FPS_CHOICES:
            self.fps.addItem(label)
        opts.addWidget(self.fps)
        opts.addStretch()
        lay.addLayout(opts)
        self.drop_dead = QCheckBox("Leave out channels that are silent in every file of a device")
        self.drop_dead.setChecked(True)
        self.drop_each = QCheckBox("Also leave out channels that are silent in individual clips")
        self.fresh = QCheckBox("Re-analyse everything (ignore saved analysis)")
        self.stems = QCheckBox("Also export audio files: one aligned WAV per microphone, for any "
                               "audio editor (podcasts, music, no Premiere needed)")
        self.stems.setToolTip("Written to a '…_audio' folder in the project. Import them all at "
                              "the start of the timeline in Audacity, Reaper, Logic, Descript, "
                              "GarageBand… and they line up. Long shooting days make big files.")
        self.compact = QCheckBox("Also make a compact timeline: every stretch where nothing was "
                                 "recording cut out (for review or a transcript)")
        self.compact.setToolTip("Writes a second XML, '…_compact.xml': the same sync as one "
                                "continuous block. Clips that overlap stay in sync with each other.")
        for w in (self.drop_dead, self.drop_each, self.fresh, self.stems, self.compact):
            lay.addWidget(w)

        row = QHBoxLayout()
        self.sync_btn = QPushButton("Sync")
        self.sync_btn.setDefault(True)
        self.sync_btn.setMinimumHeight(36)
        self.sync_btn.setMinimumWidth(140)
        self.sync_btn.setEnabled(False)
        self.sync_btn.clicked.connect(self.start_sync)
        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.setVisible(False)
        self.cancel_btn.clicked.connect(self.cancel_sync)
        row.addWidget(self.sync_btn)
        row.addWidget(self.cancel_btn)
        row.addStretch()
        lay.addLayout(row)

        self.bar = QProgressBar()
        self.bar.setRange(0, 1000)
        self.bar.setTextVisible(False)
        self.bar.setVisible(False)
        self.status = QLabel("")
        self.status.setWordWrap(True)
        lay.addWidget(self.bar)
        lay.addWidget(self.status)

        # results
        self.results = QFrame()
        rl = QVBoxLayout(self.results)
        rl.setContentsMargins(0, 0, 0, 0)
        self.summary = QLabel("")
        self.summary.setWordWrap(True)
        self.check_label = QLabel("")
        self.check_list = QListWidget()
        self.check_list.setMinimumHeight(90)
        self.check_list.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        btns = QHBoxLayout()
        self.reveal_btn = QPushButton("Show XML in Finder")
        self.reveal_btn.clicked.connect(lambda: reveal(self.result["xml"]))
        self.report_btn = QPushButton("Open Report")
        self.report_btn.clicked.connect(lambda: open_file(self.result["report"]))
        self.stems_btn = QPushButton("Show Audio Files")
        self.stems_btn.clicked.connect(lambda: reveal(self.result["stems"][0]))
        self.again_btn = QPushButton("Sync Another Folder")
        self.again_btn.clicked.connect(self.reset)
        btns.addWidget(self.reveal_btn)
        btns.addWidget(self.report_btn)
        btns.addWidget(self.stems_btn)
        btns.addStretch()
        btns.addWidget(self.again_btn)
        hint = QLabel("In Premiere: File → Import… and choose the XML. Audio files: drop them all "
                      "at the start of your audio editor's timeline.")
        hint.setWordWrap(True)
        hint.setObjectName("muted")
        rl.addWidget(self.summary)
        rl.addLayout(btns)
        rl.addWidget(hint)
        rl.addWidget(self.check_label)
        rl.addWidget(self.check_list)
        self.results.setVisible(False)
        lay.addWidget(self.results, 1)
        lay.addStretch(0)

        self.setStyleSheet("QLabel#muted { color: #8a8a8a; }")
        self._menus()

    # ---- menus, help, about ----
    def _menus(self):
        mb = self.menuBar()
        filem = mb.addMenu("File")
        new = QAction("New Sync", self)
        new.setShortcut(QKeySequence.New)
        new.triggered.connect(self.reset)
        choose = QAction("Choose Folder…", self)
        choose.setShortcut(QKeySequence.Open)
        choose.triggered.connect(self.drop.choose)
        filem.addAction(new)
        filem.addAction(choose)
        helpm = mb.addMenu("Help")
        guide = QAction("SlingSync Quick Guide", self)
        guide.setShortcut(QKeySequence.HelpContents)
        guide.triggered.connect(self.show_help)
        helpm.addAction(guide)
        for label, url in (("Full User Guide (online)", DOCS + "user-guide.md"),
                           ("Troubleshooting (online)", DOCS + "troubleshooting.md"),
                           ("Report a Problem…", REPO + "/issues")):
            a = QAction(label, self)
            a.triggered.connect(lambda _=False, u=url: QDesktopServices.openUrl(QUrl(u)))
            helpm.addAction(a)
        about = QAction("About SlingSync", self)
        about.setMenuRole(QAction.AboutRole)        # goes to the app menu on macOS
        about.triggered.connect(self.show_about)
        helpm.addSeparator()
        helpm.addAction(about)

    def show_help(self):
        dlg = QDialog(self)
        dlg.setWindowTitle("SlingSync Quick Guide")
        dlg.resize(620, 640)
        v = QVBoxLayout(dlg)
        text = QTextBrowser()
        text.setOpenExternalLinks(True)
        text.setHtml(GUIDE_HTML)
        v.addWidget(text)
        bb = QDialogButtonBox(QDialogButtonBox.Close)
        bb.rejected.connect(dlg.reject)
        v.addWidget(bb)
        dlg.exec()

    def show_about(self):
        dlg = QDialog(self)
        dlg.setWindowTitle("About SlingSync")
        v = QVBoxLayout(dlg)
        v.setSpacing(8)
        v.setContentsMargins(28, 24, 28, 18)
        mark = QLabel()
        mark.setPixmap(logo(96))
        mark.setAlignment(Qt.AlignCenter)
        name = QLabel(f"<h2>SlingSync</h2>Version {full_version()}")
        name.setTextInteractionFlags(Qt.TextSelectableByMouse)
        name.setAlignment(Qt.AlignCenter)
        body = QLabel(
            "Free multicam sync for Premiere Pro, by sound.<br>"
            "Also as a panel inside Premiere Pro 2027 (in development).<br><br>"
            f'Made by <a href="{CREATOR_URL}">Daniel Yanez</a>, documentary editor.<br>'
            "Free and open source under the MIT License.<br>"
            f"{COPYRIGHT}<br><br>"
            f'<a href="{REPO}">{REPO.replace("https://", "")}</a><br>'
            f'<a href="{REPO}/issues">Report a problem or suggest a feature</a>'
            + (f'<br><br>If SlingSync saves you time, you can '
               f'<a href="{SUPPORT_URL}">support its development</a>.' if SUPPORT_URL else ""))
        body.setAlignment(Qt.AlignCenter)
        body.setOpenExternalLinks(True)
        body.setWordWrap(True)
        for w in (mark, name, body):
            v.addWidget(w)
        bb = QDialogButtonBox(QDialogButtonBox.Ok)
        bb.accepted.connect(dlg.accept)
        v.addWidget(bb)
        dlg.exec()

    # ---- start over ----
    def reset(self):
        """Back to an empty window, ready for the next shooting day (options are kept)."""
        if self.worker:
            return
        self.folder = None
        self.devices = []
        self.result = None
        self.folder_label.setText("")
        self.table.setRowCount(0)
        self.sync_btn.setEnabled(False)
        self.fresh.setChecked(False)
        self.status.setText("")
        self.summary.setText("")
        self.check_list.clear()
        self.results.setVisible(False)
        self.new_btn.setVisible(False)
        self.drop.title.setText("Drop your project folder here")

    # ---- folder handling ----
    # ---- requests from the Premiere panel (slingsync://sync?folder=...&id=...) ----
    def remote_request(self, url):
        q = QUrlQuery(url)
        folder = q.queryItemValue("folder", QUrl.FullyDecoded)
        rid = q.queryItemValue("id", QUrl.FullyDecoded)
        audio = q.queryItemValue("audio") == "1"
        self.showNormal()
        self.raise_()
        self.activateWindow()
        if not folder or not os.path.isdir(folder):
            if folder:
                write_status(folder, id=rid, state="error", message="Folder not found.")
            return
        if self.worker:
            write_status(folder, id=rid, state="error",
                         message="SlingSync is busy with another sync. Try again when it finishes.")
            return
        self.remote = {"folder": folder, "id": rid}
        self.stems.setChecked(audio)
        write_status(folder, id=rid, state="scanning", progress=0.0,
                     message="SlingSync is looking at the folder…")
        self.load_folder(folder)

    def _remote_status(self, force=False, **fields):
        if not self.remote:
            return
        now = time.time()
        if not force and now - self._last_status < 0.5:
            return
        self._last_status = now
        write_status(self.remote["folder"], id=self.remote["id"], **fields)

    def load_folder(self, folder):
        if self.worker:
            return
        self.folder = folder
        self.results.setVisible(False)
        self.new_btn.setVisible(True)
        self.drop.title.setText("Drop a different folder to switch")
        self.folder_label.setText(folder)
        self.table.setRowCount(0)
        self.sync_btn.setEnabled(False)
        self.status.setText("Looking at the folder…")
        w = ScanWorker(folder)
        w.done.connect(self.show_devices)
        w.failed.connect(self._scan_failed)
        start_in_thread(self, w)

    def _scan_failed(self, msg):
        self.status.setText(msg)
        if self.remote:
            self._remote_status(force=True, state="error", message=msg)
            self.remote = None

    def show_devices(self, devs):
        self.devices = devs
        self.table.setRowCount(len(devs))
        total = 0
        for r, d in enumerate(devs):
            total += len(d["files"])
            self.table.setItem(r, 0, QTableWidgetItem(d["name"]))
            n = QTableWidgetItem(str(len(d["files"])))
            n.setTextAlignment(Qt.AlignCenter)
            self.table.setItem(r, 1, n)
            kind = "Camera" if d["camera"] else "Audio"
            if d["channels"]:
                kind += f" · {d['channels']} ch"
            if d.get("proxies_used"):
                kind += " · proxies" if d["proxies_used"] == len(d["files"]) else \
                    f" · {d['proxies_used']} proxies"
            self.table.setItem(r, 2, QTableWidgetItem(kind))
            box = QComboBox()
            box.addItem(AUTO_CH)
            for ch in range(1, d["channels"] + 1):
                box.addItem(f"Only channel {ch}")
            box.setEnabled(d["channels"] > 1)
            self.table.setCellWidget(r, 3, box)
        if not devs:
            self.status.setText("No video or audio files found. Put each camera or recorder's "
                                "files in its own subfolder inside this folder, then drop it again.")
        elif total == 0:
            self.status.setText("No video or audio files found in the subfolders.")
        else:
            loose = not any(os.path.isdir(os.path.join(self.folder or "", d["name"])) for d in devs)
            self.status.setText(f"{total} files in {len(devs)} devices. Ready to sync."
                                + ("  No device subfolders, so devices were guessed from file "
                                   "names: check the list." if loose else ""))
            self.sync_btn.setEnabled(True)
            if self.remote and self.remote["folder"] == self.folder:
                self.start_sync()               # requested from Premiere: go straight ahead
                return
        if self.remote and self.remote["folder"] == self.folder:
            self._remote_status(force=True, state="error", message=self.status.text())
            self.remote = None

    # ---- syncing ----
    def start_sync(self):
        ref = {}
        for r, d in enumerate(self.devices):
            i = self.table.cellWidget(r, 3).currentIndex()
            if i > 0:
                ref[d["name"]] = i
        kwargs = dict(project=self.folder, ref_channels=ref,
                      fps=FPS_CHOICES[self.fps.currentIndex()][1],
                      keep_silent=not self.drop_dead.isChecked(),
                      skip_silent_clips=self.drop_each.isChecked(),
                      clear_cache=self.fresh.isChecked(),
                      stems=self.stems.isChecked(),
                      compact=self.compact.isChecked())
        self.worker = SyncWorker(kwargs)
        self.worker.progress.connect(self.on_progress)
        self.worker.done.connect(self.on_done)
        self.worker.failed.connect(self.on_failed)
        self.set_busy(True)
        start_in_thread(self, self.worker)

    def cancel_sync(self):
        if self.worker:
            self.worker.cancel.set()
            self.status.setText("Stopping…")

    def set_busy(self, busy):
        self.sync_btn.setEnabled(not busy)
        self.cancel_btn.setVisible(busy)
        self.drop.setEnabled(not busy)
        self.table.setEnabled(not busy)
        self.new_btn.setEnabled(not busy)
        self.bar.setVisible(busy)
        self.results.setVisible(False)
        if busy:
            self.bar.setValue(0)

    def on_progress(self, frac, msg):
        self.bar.setValue(int(frac * 1000))
        self.status.setText(msg)
        self._remote_status(state="syncing", progress=frac, message=msg)

    def on_done(self, res):
        self.worker = None
        self.result = res
        if self.remote:
            c = res["counts"]
            self._remote_status(force=True, state="done", progress=1.0, xml=res["xml"],
                                report=res["report"], stems=res.get("stems") or [],
                                synced=c.get("synced", 0), files=res["files"],
                                check=len(res["need_check"]),
                                message="Done.")
            self.remote = None
        self.set_busy(False)
        c = res["counts"]
        synced = c.get("synced", 0)
        self.status.setText("")
        self.summary.setText(
            f"<b>Done.</b> {synced} of {res['files']} clips synced by sound · "
            f"{res['video_tracks']} video and {res['audio_tracks']} audio tracks at "
            f"{res['fps']:.3f} fps."
            + (f" · {len(res['stems'])} audio files." if res.get("stems") else "")
            + (" · Compact timeline: <i>…_compact.xml</i>." if res.get("compact_xml") else ""))
        self.stems_btn.setVisible(bool(res.get("stems")))
        need = res["need_check"]
        self.check_list.clear()
        if need:
            self.check_label.setText(f"<b>Check these by eye ({len(need)}):</b> they share no sound "
                                     "with another device, so they were placed by their device's "
                                     "clock (orange) or parked at the end (red). Details in the "
                                     "report.")
            for n in need:
                note = f" ({n['note']})" if n["note"] else ""
                self.check_list.addItem(f"{n['at']}   {n['status']}   {n['file']}{note}")
        else:
            self.check_label.setText("Everything synced by sound. Nothing to check.")
        self.check_list.setVisible(bool(need))
        self.results.setVisible(True)

    def on_failed(self, msg):
        self.worker = None
        if self.remote:
            self._remote_status(force=True, state="cancelled" if msg == "Cancelled." else "error",
                                message=msg)
            self.remote = None
        self.set_busy(False)
        self.status.setText(msg)
        if msg != "Cancelled.":
            QMessageBox.warning(self, "SlingSync", msg)

    def closeEvent(self, e):
        if self.worker:
            self.worker.cancel.set()
        super().closeEvent(e)


class SlingSyncApp(QApplication):
    """Receives slingsync:// links (macOS sends them as file-open events), including the
    one that launched the app, which can arrive before the window exists."""

    def __init__(self, argv):
        super().__init__(argv)
        self.window = None
        self.pending = []

    def event(self, e):
        if e.type() == QEvent.FileOpen and e.url().scheme() == "slingsync":
            if self.window:
                self.window.remote_request(e.url())
            else:
                self.pending.append(e.url())
            return True
        return super().event(e)


def main():
    app = SlingSyncApp(sys.argv)
    app.setApplicationName("SlingSync")
    app.setApplicationVersion(__version__)
    app.setWindowIcon(QIcon(ICON))
    w = MainWindow()
    w.show()
    app.window = w
    for url in app.pending:
        QTimer.singleShot(0, lambda u=url: w.remote_request(u))
    app.pending = []
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
