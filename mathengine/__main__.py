"""Manim Studio command line (``manim-studio``; ``mathengine`` is the same command).

    manim-studio [project.manimstudio]       open the editor (native window)
    manim-studio scene.py                      open a manim file in the editor (as a new project)
    manim-studio --browser [project]           open the editor in the default browser
    manim-studio render project -q 1080p -o out.mp4
    manim-studio code project > scene.py       print the generated manim code
    manim-studio import scene.py -o project.manimstudio   turn a manim file into a project
    manim-studio manim …                       run manim's own command line (used by packaged apps)
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
import warnings
from pathlib import Path


CLOSE_QUESTION = ("This project has unsaved changes. Close anyway?\n\n"
                  "A copy is kept: Home offers to restore it the next time you open Manim Studio.")


def close_allowed(app, confirm) -> bool:
    """Whether the window may close: yes unless the project has unsaved changes and the user says to stay.
    ``confirm(title, message)`` asks; anything but an explicit "no" lets the window close, so a failing dialog
    can never trap the user in the app."""
    if not getattr(app, "dirty", False):
        return True
    try:
        return confirm("Unsaved changes", CLOSE_QUESTION) is not False
    except Exception:
        return True


def _open_editor(project: str | None, browser: bool, port: int, serve_only: bool = False) -> None:
    from .server import make_server

    server, app = make_server(str(Path(project).resolve()) if project else None, port)
    url = f"http://127.0.0.1:{app.port}/"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # Warm up manim + the catalog while the window opens.
    threading.Thread(target=_warmup, daemon=True).start()

    if serve_only:
        print(f"Manim Studio serving at {url}  (Ctrl+C to quit)", flush=True)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return

    webview = None
    if not browser:
        try:
            import webview  # type: ignore[no-redef]
        except ImportError:
            print("pywebview not installed; opening in your browser instead.")
    if webview is None:
        return _open_editor_in_browser(url)

    try:
        window = webview.create_window("Manim Studio", url, width=1500, height=940, min_size=(1000, 640),
                                       background_color="#111216")
    except Exception as exc:  # no usable GUI toolkit (e.g. a Linux system without Qt or GTK)
        print(f"Can't open a window ({exc}); opening in your browser instead.")
        return _open_editor_in_browser(url)

    def dialogs(kind: str, filename: str, types: list[str]) -> str | None:
        file_types = tuple(types) if types else ()
        if kind == "save":
            res = window.create_file_dialog(webview.FileDialog.SAVE, save_filename=filename or "", file_types=file_types)
        else:
            res = window.create_file_dialog(webview.FileDialog.OPEN, file_types=file_types)
        if not res:
            return None
        return res if isinstance(res, str) else res[0]

    app.dialogs = dialogs
    app.set_title = window.set_title
    try:  # the page's own "leave site?" prompt doesn't exist in a native window: ask here instead
        window.events.closing += lambda: None if close_allowed(app, window.create_confirmation_dialog) else False
    except Exception:  # an older pywebview: the window just closes (unsaved changes are kept for Home to restore)
        pass
    icon = Path(__file__).parent / "web" / "icon.png"  # the window icon on Linux (Windows and macOS use the app's)
    try:
        try:
            webview.start(icon=str(icon) if icon.is_file() else None)
        except TypeError:  # an older pywebview without icon=
            webview.start()
    except Exception as exc:
        print(f"Can't open a window ({exc}); opening in your browser instead.")
        app.dialogs = None
        app.set_title = None
        return _open_editor_in_browser(url)
    server.shutdown()


def _open_editor_in_browser(url: str) -> None:
    import webbrowser

    print(f"Manim Studio running at {url}  (Ctrl+C to quit)")
    webbrowser.open(url)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        return


def _warmup() -> None:
    from . import catalog

    catalog.build()


def _render(project: str, quality: str, output: str | None) -> int:
    from . import render, runtime
    from .project import load_project

    doc = load_project(project)
    check = runtime.run(doc, None, render=False)
    _print_diagnostics(check.diagnostics)
    if check.error:
        print(f"error: {check.error['message']}", file=sys.stderr)
        return 1
    out = output or str(Path(project).with_suffix(".mp4"))
    job = render.RenderJob(doc, quality, out, str(Path(project).resolve()), check.plays)
    job.start()
    while job.state in ("queued", "running"):
        print(f"\r{job.message:<40} {job.progress * 100:5.1f}%", end="", flush=True)
        time.sleep(0.25)
    print()
    if job.state != "done":
        print(f"error: {job.message}\n{job.log[-2000:]}", file=sys.stderr)
        return 1
    print(job.message)
    return 0


def _import(file: str, scene: str | None, output: str | None) -> int:
    from .importer import CodeError, import_code
    from .project import save_project

    try:
        res = import_code(Path(file).read_text(encoding="utf-8"), scene)
    except CodeError as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return 1
    out = output or str(Path(file).with_suffix(".manimstudio"))
    save_project(out, res.doc)
    for note in res.notes:
        print(f"note: {note}", file=sys.stderr)
    others = [s for s in res.scenes if s != res.doc["scene"]["name"]]
    if others:
        print(f"note: imported {res.doc['scene']['name']}; the file also has {', '.join(others)} (choose with -s)", file=sys.stderr)
    print(out)
    return 0


def _print_diagnostics(diagnostics: list[dict]) -> None:
    """Construction problems don't stop a render (broken links are emitted unconstrained); show them."""
    for d in diagnostics:
        print(f"{d['level']}: {d['kind']} {d['id']}: {d['message']}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    warnings.filterwarnings("ignore", category=SyntaxWarning)
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "manim":  # manim's command line, for renders from a packaged app
        from manim.__main__ import main as manim_main

        sys.argv = ["manim", *argv[1:]]
        try:
            manim_main()
        except SystemExit as exc:
            return int(exc.code or 0) if not isinstance(exc.code, str) else 1
        return 0
    if argv and argv[0] == "import":
        p = argparse.ArgumentParser(prog="manim-studio import", description="Turn a manim .py file into a project.")
        p.add_argument("file")
        p.add_argument("-s", "--scene", help="which Scene class (default: the first one)")
        p.add_argument("-o", "--output", help="project file to write (default: next to the .py file)")
        args = p.parse_args(argv[1:])
        return _import(args.file, args.scene, args.output)
    if argv and argv[0] in ("render", "code"):
        cmd = argv[0]
        p = argparse.ArgumentParser(prog=f"manim-studio {cmd}")
        p.add_argument("project")
        if cmd == "render":
            p.add_argument("-q", "--quality", default="project",
                           help="preview | 720p | 1080p | 1440p | 4k | project (use the project's settings)")
            p.add_argument("-o", "--output")
        args = p.parse_args(argv[1:])
        if cmd == "render":
            return _render(args.project, args.quality, args.output)
        from .codegen import generate
        from .project import load_project

        gen = generate(load_project(args.project))
        _print_diagnostics(gen.diagnostics)
        print(gen.source, end="")
        return 0

    p = argparse.ArgumentParser(prog="manim-studio", description="Manim Studio: a visual editor for manim scenes.")
    p.add_argument("project", nargs="?", help="a project file to open (.manimstudio, or .mathengine from earlier versions), or a manim .py file")
    p.add_argument("--browser", action="store_true", help="use the default browser instead of a native window")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--serve", action="store_true", help="only run the local server (no window)")
    args = p.parse_args(argv)
    _open_editor(args.project, args.browser, args.port, args.serve)
    return 0


if __name__ == "__main__":
    sys.exit(main())
