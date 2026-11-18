# PyInstaller spec for the macOS app. Build with: bash scripts/build_mac.sh
import re

version = re.search(r'__version__ = "(.+?)"', open("slingsync/__init__.py").read()).group(1)

a = Analysis(
    ["app.py"],
    pathex=["."],
    datas=[("slingsync/resources/icon.png", "slingsync/resources")],
    excludes=[
        "tkinter", "matplotlib", "pandas", "IPython",
        "PySide6.QtWebEngineCore", "PySide6.QtWebEngineWidgets", "PySide6.QtWebEngineQuick",
        "PySide6.QtQml", "PySide6.QtQuick", "PySide6.QtQuickWidgets", "PySide6.Qt3DCore",
        "PySide6.QtMultimedia", "PySide6.QtCharts", "PySide6.QtDataVisualization",
        "PySide6.QtPdf", "PySide6.QtPdfWidgets", "PySide6.QtSql", "PySide6.QtTest",
        "PySide6.QtBluetooth", "PySide6.QtPositioning", "PySide6.QtSensors",
    ],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="SlingSync", console=False)
coll = COLLECT(exe, a.binaries, a.datas, name="SlingSync")
app = BUNDLE(
    coll,
    name="SlingSync.app",
    icon="build/SlingSync.icns",
    bundle_identifier="io.github.slingsync",
    version=version,
    info_plist={
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "12.0",
        "NSRequiresAquaSystemAppearance": False,
    },
)
