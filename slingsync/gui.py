"""SlingSync desktop app (PySide6)."""
import os
import subprocess
import sys
import threading

from PySide6.QtCore import QObject, Qt, QThread, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QCheckBox, QComboBox,
                               QFileDialog, QFrame, QHBoxLayout, QHeaderView, QLabel,
                               QListWidget, QMainWindow, QMessageBox, QProgressBar,
                               QPushButton, QSizePolicy, QTableWidget, QTableWidgetItem,
                               QVBoxLayout, QWidget)

from . import __version__
from . import engine

FPS_CHOICES = [("Match first camera", None), ("23.976", 24000 / 1001), ("24", 24.0),
               ("25", 25.0), ("29.97", 30000 / 1001), ("30", 30.0), ("50", 50.0),
               ("59.94", 60000 / 1001), ("60", 60.0)]
AUTO_CH = "All live channels (recommended)"


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

        root = QWidget()
        self.setCentralWidget(root)
        lay = QVBoxLayout(root)
        lay.setContentsMargins(22, 18, 22, 18)
        lay.setSpacing(12)

        title = QLabel("SlingSync")
        tf = title.font()
        tf.setPointSize(tf.pointSize() + 10)
        tf.setBold(True)
        title.setFont(tf)
        sub = QLabel("Sync cameras and multitrack audio by sound. No timecode required.")
        sub.setObjectName("muted")
        lay.addWidget(title)
        lay.addWidget(sub)

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
        for w in (self.drop_dead, self.drop_each, self.fresh):
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
        btns.addWidget(self.reveal_btn)
        btns.addWidget(self.report_btn)
        btns.addStretch()
        hint = QLabel("In Premiere: File → Import… and choose the XML.")
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

    # ---- folder handling ----
    def load_folder(self, folder):
        if self.worker:
            return
        self.folder = folder
        self.results.setVisible(False)
        self.folder_label.setText(folder)
        self.table.setRowCount(0)
        self.sync_btn.setEnabled(False)
        self.status.setText("Looking at the folder…")
        w = ScanWorker(folder)
        w.done.connect(self.show_devices)
        w.failed.connect(lambda m: self.status.setText(m))
        start_in_thread(self, w)

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
                      clear_cache=self.fresh.isChecked())
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
        self.bar.setVisible(busy)
        self.results.setVisible(False)
        if busy:
            self.bar.setValue(0)

    def on_progress(self, frac, msg):
        self.bar.setValue(int(frac * 1000))
        self.status.setText(msg)

    def on_done(self, res):
        self.worker = None
        self.result = res
        self.set_busy(False)
        c = res["counts"]
        synced = c.get("synced", 0)
        self.status.setText("")
        self.summary.setText(
            f"<b>Done.</b> {synced} of {res['files']} clips synced by sound · "
            f"{res['video_tracks']} video and {res['audio_tracks']} audio tracks at "
            f"{res['fps']:.3f} fps.")
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
        self.set_busy(False)
        self.status.setText(msg)
        if msg != "Cancelled.":
            QMessageBox.warning(self, "SlingSync", msg)

    def closeEvent(self, e):
        if self.worker:
            self.worker.cancel.set()
        super().closeEvent(e)


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("SlingSync")
    app.setApplicationVersion(__version__)
    w = MainWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
