# PyInstaller spec: a self-contained Manim Studio for the platform it runs on.
#
#   pip install . pyinstaller   (on Linux also: pywebview[qt])
#   pyinstaller packaging/manim-studio.spec
#
# Builds dist/ManimStudio/ with two executables sharing one set of libraries:
#   ManimStudio      the editor (a window, no console); "Manim Studio.app" on macOS
#   manim-studio     console version: `render`, `code`, and the `manim` command line renders run through
# LaTeX isn't bundled: MathTex/Tex need a LaTeX installation on the machine (Text works without it).
#
# The app icon is icon.png at the repository root (converted to .ico / .icns with Pillow). Without it the
# app builds with the platform's default icon.
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

ROOT = Path(SPECPATH).parent  # noqa: F821 (defined by PyInstaller)
ICON = ROOT / "icon.png"
icon = str(ICON) if ICON.is_file() else None
if icon is None:
    print("WARNING: icon.png not found at the repository root; building without an app icon.")

datas, binaries, hiddenimports = [], [], []
# manim and its native and data-carrying dependencies (templates, shaders, fonts, ffmpeg in av…).
for pkg in ("mathengine", "manim", "manimpango", "cairo", "av", "pathops", "mapbox_earcut", "moderngl", "moderngl_window",
            "glcontext", "screeninfo", "isosurfaces", "svgelements", "srt", "cloup", "pydub", "webview"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
if sys.platform.startswith("linux"):
    hiddenimports += ["qtpy", "PyQt6.QtWebEngineWidgets", "PyQt6.QtWebEngineCore", "PyQt6.QtWebChannel"]

a = Analysis(
    ["launch.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "jupyter", "pytest"],
    # The library reads manim's source (inspect.getsource) to build parameter forms: ship it.
    module_collection_mode={"manim": "pyz+py"},
)
pyz = PYZ(a.pure)

gui = EXE(pyz, a.scripts, [], exclude_binaries=True, name="ManimStudio", console=False, icon=icon)
cli = EXE(pyz, a.scripts, [], exclude_binaries=True, name="manim-studio", console=True, icon=icon)
coll = COLLECT(gui, cli, a.binaries, a.datas, name="ManimStudio")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="Manim Studio.app",
        icon=icon,
        bundle_identifier="app.manimstudio.editor",
        info_plist={
            "CFBundleName": "Manim Studio",
            "CFBundleDisplayName": "Manim Studio",
            "NSHighResolutionCapable": True,
            "CFBundleDocumentTypes": [{"CFBundleTypeName": "Manim Studio project", "CFBundleTypeExtensions": ["manimstudio", "mathengine"],
                                       "CFBundleTypeRole": "Editor"}],
        },
    )
