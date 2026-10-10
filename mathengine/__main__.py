"""MathEngine command line.

    mathengine [project.mathengine]          open the editor (native window)
    mathengine --browser [project]           open the editor in the default browser
    mathengine render project -q 1080p -o out.mp4
    mathengine code project > scene.py       print the generated manim code
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
import warnings
from pathlib import Path


def _open_editor(project: str | None, browser: bool, port: int, serve_only: bool = False) -> None:
    from .server import make_server

    server, app = make_server(str(Path(project).resolve()) if project else None, port)
    url = f"http://127.0.0.1:{app.port}/"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # Warm up manim + the catalog while the window opens.
    threading.Thread(target=_warmup, daemon=True).start()

    if serve_only:
        print(f"MathEngine serving at {url}  (Ctrl+C to quit)", flush=True)
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
        import webbrowser

        print(f"MathEngine running at {url}  (Ctrl+C to quit)")
        webbrowser.open(url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return

    window = webview.create_window("MathEngine", url, width=1500, height=940, min_size=(1000, 640),
                                   background_color="#111216")

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
    webview.start()
    server.shutdown()


def _warmup() -> None:
    from . import catalog

    catalog.build()


def _render(project: str, quality: str, output: str | None) -> int:
    from . import render, runtime
    from .project import load_project

    doc = load_project(project)
    check = runtime.run(doc, None, render=False)
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


def main(argv: list[str] | None = None) -> int:
    warnings.filterwarnings("ignore", category=SyntaxWarning)
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] in ("render", "code"):
        cmd = argv[0]
        p = argparse.ArgumentParser(prog=f"mathengine {cmd}")
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

        print(generate(load_project(args.project)).source, end="")
        return 0

    p = argparse.ArgumentParser(prog="mathengine", description="Visual editor for manim scenes.")
    p.add_argument("project", nargs="?", help="a .mathengine project file to open")
    p.add_argument("--browser", action="store_true", help="use the default browser instead of a native window")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--serve", action="store_true", help="only run the local server (no window)")
    args = p.parse_args(argv)
    _open_editor(args.project, args.browser, args.port, args.serve)
    return 0


if __name__ == "__main__":
    sys.exit(main())
