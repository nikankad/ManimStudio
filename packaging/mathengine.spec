# PyInstaller spec: a self-contained MathEngine for the platform it runs on.
#
#   pip install . pyinstaller   (on Linux also: pywebview[qt])
#   pyinstaller packaging/mathengine.spec
#
# Builds dist/MathEngine/ with two executables sharing one set of libraries:
#   MathEngine       the editor (a window, no console); MathEngine.app on macOS
#   mathengine-cli   console version: `render`, `code`, and the `manim` command line renders run through
# LaTeX isn't bundled: MathTex/Tex need a LaTeX installation on the machine (Text works without it).
import sys

from PyInstaller.utils.hooks import collect_all

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

icon = None  # (no icon yet)
gui = EXE(pyz, a.scripts, [], exclude_binaries=True, name="MathEngine", console=False, icon=icon)
cli = EXE(pyz, a.scripts, [], exclude_binaries=True, name="mathengine-cli", console=True, icon=icon)
coll = COLLECT(gui, cli, a.binaries, a.datas, name="MathEngine")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="MathEngine.app",
        icon=icon,
        bundle_identifier="app.mathengine.editor",
        info_plist={
            "CFBundleDisplayName": "MathEngine",
            "NSHighResolutionCapable": True,
            "CFBundleDocumentTypes": [{"CFBundleTypeName": "MathEngine project", "CFBundleTypeExtensions": ["mathengine"],
                                       "CFBundleTypeRole": "Editor"}],
        },
    )
