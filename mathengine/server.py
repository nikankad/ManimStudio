"""Local HTTP server connecting the web UI to manim.

Bound to 127.0.0.1 only. Because the API executes scene code, every API call
must carry a per-session token (embedded in the served page) and a matching
Host header, so other websites open in a browser can't drive it.
"""

from __future__ import annotations

import json
import mimetypes
import re
import secrets
import shutil
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from . import catalog, codegen, importer, mathexpr, recent, recovery, render, runtime, samples, starters, tex, version
from .project import load_project, new_project, resolve_project_path, save_project, upgrade_template

LIBRARY_PATH = Path.home() / ".mathengine" / "constructions.json"

WEB_DIR = Path(__file__).parent / "web"


class AppState:
    def __init__(self, project_path: str | None):
        self.token = secrets.token_urlsafe(24)
        self.project_path = str(resolve_project_path(project_path)) if project_path else None
        self.manim_lock = threading.Lock()
        self.jobs: dict[str, render.RenderJob] = {}
        self.catalog_cache: dict[str, dict] = {}
        self.dialogs: Any = None  # set by the desktop shell (pywebview)
        self.port = 0


class Handler(BaseHTTPRequestHandler):
    app: AppState
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # keep the console quiet
        pass

    # ---- plumbing -------------------------------------------------------
    def _host_ok(self) -> bool:
        host = self.headers.get("Host", "")
        return host in (f"127.0.0.1:{self.app.port}", f"localhost:{self.app.port}")

    def _authorized(self, query: dict[str, list[str]]) -> bool:
        token = self.headers.get("X-MathEngine-Token") or (query.get("token") or [""])[0]
        return self._host_ok() and secrets.compare_digest(token, self.app.token)

    def _send(self, status: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, data: Any, status: int = 200) -> None:
        self._send(status, json.dumps(data).encode(), "application/json")

    # ---- routing --------------------------------------------------------
    def do_GET(self) -> None:
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if not self._host_ok():
            return self._send(403, b"forbidden", "text/plain")
        if url.path.startswith("/api/") or url.path.startswith("/media/"):
            if not self._authorized(query):
                return self._send(403, b"forbidden", "text/plain")
            return self._route("GET", url.path, query, {})
        return self._static(url.path)

    do_HEAD = do_GET

    def do_POST(self) -> None:
        url = urlparse(self.path)
        query = parse_qs(url.query)
        # Read the body first, even for a refused request: left unread, it would be taken for the next request on
        # this connection (a page left open from before a restart still sends requests with its old token).
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if not self._authorized(query):
            return self._send(403, b"forbidden", "text/plain")
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        self._route("POST", url.path, query, body)

    def _route(self, method: str, path: str, query: dict, body: dict) -> None:
        routes: dict[tuple[str, str], Callable[[dict, dict], Any]] = {
            ("POST", "/api/catalog"): self.api_catalog,
            ("POST", "/api/tex"): self.api_tex,
            ("GET", "/api/version"): self.api_version,
            ("POST", "/api/update_check"): self.api_update_check,
            ("POST", "/api/open_release"): self.api_open_release,
            ("POST", "/api/signature"): self.api_signature,
            ("POST", "/api/run"): self.api_run,
            ("POST", "/api/code"): self.api_code,
            ("POST", "/api/import_code"): self.api_import_code,
            ("POST", "/api/render"): self.api_render,
            ("GET", "/api/project/initial"): self.api_project_initial,
            ("POST", "/api/project/open"): self.api_project_open,
            ("POST", "/api/project/save"): self.api_project_save,
            ("GET", "/api/home"): self.api_home,
            ("POST", "/api/recent/remove"): self.api_recent_remove,
            ("POST", "/api/recovery/save"): self.api_recovery_save,
            ("POST", "/api/recovery/open"): self.api_recovery_open,
            ("POST", "/api/recovery/clear"): self.api_recovery_clear,
            ("POST", "/api/samples/open"): self.api_sample_open,
            ("POST", "/api/export_code"): self.api_export_code,
            ("POST", "/api/dialog"): self.api_dialog,
            ("POST", "/api/expr"): self.api_expr,
            ("POST", "/api/check_equation"): self.api_check_equation,
            ("GET", "/api/constructions"): self.api_constructions,
            ("POST", "/api/constructions"): self.api_save_constructions,
        }
        try:
            handler = routes.get((method, path))
            if handler:
                return self._json(handler(query, body))
            m = re.fullmatch(r"/api/render/(\w+)(/cancel)?", path)
            if m:
                job = self.app.jobs.get(m.group(1))
                if not job:
                    return self._json({"error": "no such job"}, 404)
                if m.group(2):
                    job.cancel()
                return self._json(job.to_json())
            m = re.fullmatch(r"/media/(\w+)\.mp4", path)
            if m:
                job = self.app.jobs.get(m.group(1))
                if job and job.result and job.result.exists():
                    return self._file(job.result)
            self._json({"error": "not found"}, 404)
        except Exception as exc:  # report backend bugs to the UI instead of dropping the connection
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    # ---- static & media -------------------------------------------------
    def _static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        file = (WEB_DIR / rel).resolve()
        if not str(file).startswith(str(WEB_DIR.resolve())) or not file.is_file():
            file = WEB_DIR / "index.html"
            if not file.is_file():
                return self._send(500, b"Frontend not built. Run: cd frontend && npm install && npm run build", "text/plain")
        if file.name == "index.html":
            html = file.read_text(encoding="utf-8").replace(
                "<head>", f'<head><meta name="me-token" content="{self.app.token}">', 1)
            return self._send(200, html.encode(), "text/html; charset=utf-8")
        ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        self._send(200, file.read_bytes(), ctype, {"Cache-Control": "max-age=3600"})

    def _file(self, file: Path) -> None:
        """Serve a file with HTTP Range support (needed for <video> seeking)."""
        size = file.stat().st_size
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if rng and (m := re.match(r"bytes=(\d*)-(\d*)", rng)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = size - int(m.group(2))
            end = min(end, size - 1)
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(file, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(1 << 16, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)

    # ---- API ------------------------------------------------------------
    def api_catalog(self, _q: dict, body: dict) -> dict:
        header = body.get("header", "")
        if header not in self.app.catalog_cache:
            with self.app.manim_lock:
                extra = catalog.header_namespace(header)
                data = catalog.build(extra)
            data["latex"] = tex.latex_available()
            data["latex_hint"] = tex.install_hint()
            data["ffmpeg"] = shutil.which("ffmpeg") is not None
            self.app.catalog_cache = {header: data}
        return self.app.catalog_cache[header]

    def api_version(self, _q: dict, _body: dict) -> dict:
        return version.info()

    def api_update_check(self, _q: dict, _body: dict) -> dict:
        return version.check_for_update()

    def api_open_release(self, _q: dict, body: dict) -> dict:
        """Open this project's release page in the system browser (the app window has no address bar)."""
        url = str(body.get("url", ""))
        if not version.release_page(url):
            return {"ok": False}
        import webbrowser

        return {"ok": bool(webbrowser.open(url))}

    def api_tex(self, _q: dict, _body: dict) -> dict:
        """Look for LaTeX again (after the user installed it), without restarting."""
        found = tex.latex_available(refresh=True)
        for data in self.app.catalog_cache.values():
            data["latex"] = found
        return {"latex": found, "dir": tex.find_tex(), "hint": tex.install_hint()}

    def api_signature(self, _q: dict, body: dict) -> dict:
        with self.app.manim_lock:
            ns = catalog.header_namespace(body.get("header", ""))
            return catalog.signature(body["expr"], ns, body.get("object_classes"))

    def api_run(self, _q: dict, body: dict) -> dict:
        t = body.get("t")
        with self.app.manim_lock:
            res = runtime.run(body["doc"], None if t is None else float(t),
                              render=body.get("render", True), preview_width=int(body.get("width", 960)))
        return res.to_json()

    def api_code(self, _q: dict, body: dict) -> dict:
        """The document as manim code, and which element each line comes from (written as if LaTeX is installed,
        so the code is the document's, wherever it's shown)."""
        gen = codegen.generate(body["doc"], latex=True)
        return {"code": gen.source, "linemap": {str(k): list(v) for k, v in gen.linemap.items()}}

    def api_import_code(self, _q: dict, body: dict) -> dict:
        """manim code -> a document. ``base``: the document the code was generated from (unchanged parts keep it)."""
        try:
            code = str(body.get("code", ""))
            scene = body.get("scene") or None
            with self.app.manim_lock:
                if scene and scene not in importer.scenes_in(code):
                    scene = None  # renamed in the code: follow it
                res = importer.import_code(code, scene, body.get("base"))
        except importer.CodeError as exc:
            return {"ok": False, "error": exc.message, "line": exc.line}
        return {"ok": True, "doc": res.doc, "scenes": res.scenes, "notes": res.notes}

    def api_export_code(self, _q: dict, body: dict) -> dict:
        path = Path(body["path"]).expanduser()
        path.write_text(codegen.generate(body["doc"]).source, encoding="utf-8")
        return {"path": str(path)}

    def api_render(self, _q: dict, body: dict) -> dict:
        key = self.app.project_path or "untitled"
        with self.app.manim_lock:  # validate first so errors show in the editor, not a log
            check = runtime.run(body["doc"], None, render=False)
        if check.error:
            return {"state": "error", "message": check.error["message"], "error": check.error}
        job = render.RenderJob(body["doc"], body.get("quality", "preview"), body.get("output"), key, check.plays)
        if body.get("quality") == "preview":
            for old in list(self.app.jobs.values()):
                if old.quality == "preview" and old.state in ("queued", "running"):
                    old.cancel()
        self.app.jobs[job.id] = job
        job.start()
        return job.to_json()

    def api_project_initial(self, _q: dict, _b: dict) -> dict:
        """The project to start with. Launched without one, the editor starts at the Home screen."""
        path = self.app.project_path
        if path and Path(path).exists():
            recent.add(path)
            if path.endswith(".py"):
                return {**self._import_file(path), "home": False}
            return {"doc": load_project(path), "path": path, "home": False}
        # No project given, or the file given doesn't exist (moved, renamed): start at Home.
        self.app.project_path = None
        return {"doc": new_project(), "path": None, "home": True, "missing": path}

    def _import_file(self, path: str) -> dict:
        """A manim .py file opens as a new, unsaved project made from its code."""
        with self.app.manim_lock:
            res = importer.import_code(Path(path).expanduser().read_text(encoding="utf-8"))
        self.app.project_path = None
        return {"doc": res.doc, "path": None, "imported": path, "notes": res.notes, "scenes": res.scenes}

    def api_project_open(self, _q: dict, body: dict) -> dict:
        path = str(resolve_project_path(body["path"]))
        if path.endswith(".py"):
            try:
                out = self._import_file(path)
            except importer.CodeError as exc:
                raise ValueError(exc.message) from None
            recent.add(path)
            return out
        doc = load_project(path)
        self.app.project_path = path
        recent.add(path)
        return {"doc": doc, "path": path}

    def api_project_save(self, _q: dict, body: dict) -> dict:
        save_project(body["path"], body["doc"])
        self.app.project_path = body["path"]
        recent.add(body["path"])
        threading.Thread(target=self._thumbnail, args=(body["path"], body["doc"]), daemon=True).start()
        return {"path": body["path"]}

    def _thumbnail(self, path: str, doc: dict) -> None:
        """The Home screen's preview of a saved project: its frame at 70% of the video (in the background)."""
        try:
            with self.app.manim_lock:
                end = runtime.run(doc, None, render=False).duration
                frame = runtime.run(doc, end * 0.7, render=True, preview_width=320)
            if frame.image and not frame.error:
                recent.set_thumbnail(path, frame.image)
        except Exception:  # a broken scene just has no preview
            pass

    def api_home(self, _q: dict, _b: dict) -> dict:
        with self.app.manim_lock:  # sample lengths are measured by running them once
            listing = samples.sample_list()
        return {"recent": recent.listing(), "samples": listing, "recovery": recovery.listing()}

    def api_recent_remove(self, _q: dict, body: dict) -> dict:
        recent.remove(str(body.get("path", "")))
        return {"recent": recent.listing()}

    def api_recovery_save(self, _q: dict, body: dict) -> dict:
        """Keep the unsaved state of the open project, so a crash or a closed window doesn't lose it."""
        path = body.get("path")
        recovery.save(str(body.get("id", "")), str(path) if path else None, body["doc"])
        return {"ok": True}

    def api_recovery_open(self, _q: dict, body: dict) -> dict:
        data = recovery.load(str(body.get("id", "")))
        if not data:
            raise ValueError("That unsaved work is gone")
        return {"doc": data["doc"], "path": data.get("path")}

    def api_recovery_clear(self, _q: dict, body: dict) -> dict:
        recovery.clear(str(body.get("id", "")))
        return {"recovery": recovery.listing()}

    def api_sample_open(self, _q: dict, body: dict) -> dict:
        """A sample opens as a new, unsaved project (saving asks where, so the sample itself never changes)."""
        return {"doc": samples.sample(str(body.get("id", ""))), "path": None}

    def api_expr(self, _q: dict, body: dict) -> dict:
        """Analyse a math expression: a function for the graph builder, or a value over parameters."""
        if body.get("mode") == "value":
            try:
                py, params = mathexpr.compile_value(str(body.get("expr", "")), set(body.get("params") or []))
                return {"ok": True, "python": py, "params": params, "literal": mathexpr.literal(str(body.get("expr", "")))}
            except mathexpr.ExprError as exc:
                return {"ok": False, "error": exc.message, "hint": exc.hint}
        dom = body.get("domain") or [-5, 5]
        yr = body.get("y_range")
        return mathexpr.analyze_function(str(body.get("expr", "")), {k: float(v) for k, v in (body.get("params") or {}).items()},
                                         (float(dom[0]), float(dom[1])), (float(yr[0]), float(yr[1])) if yr else None)

    def api_check_equation(self, _q: dict, body: dict) -> dict:
        """Compile an equation's terms with manim's own MathTex and report glyphs per term."""
        with self.app.manim_lock:
            return check_equation(body.get("parts") or [], body.get("ctor") or "MathTex")

    def api_constructions(self, _q: dict, _b: dict) -> dict:
        library: list = []
        if LIBRARY_PATH.exists():
            try:
                library = json.loads(LIBRARY_PATH.read_text(encoding="utf-8")).get("constructions", [])
            except (OSError, ValueError):
                library = []
        library = [upgrade_template(t) for t in library]  # saved with clips by earlier versions
        return {"starters": starters.starters(), "library": library, "path": str(LIBRARY_PATH)}

    def api_save_constructions(self, _q: dict, body: dict) -> dict:
        LIBRARY_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = LIBRARY_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": 1, "constructions": body.get("library", [])}, indent=2), encoding="utf-8")
        tmp.replace(LIBRARY_PATH)
        return {"path": str(LIBRARY_PATH)}

    def api_dialog(self, _q: dict, body: dict) -> dict:
        if not self.app.dialogs:
            return {"path": None, "unsupported": True}
        return {"path": self.app.dialogs(body.get("kind", "open"), body.get("filename", ""), body.get("types", []))}


def check_equation(parts: list[str], ctor: str = "MathTex") -> dict:
    """Build ``ctor(*parts)`` with manim (real LaTeX) and count the glyphs of each term.

    A term with no glyphs (e.g. a lone closing brace) can't be colored, braced or matched, so the
    editor flags it. This checks rendering only, not mathematics.
    """
    import logging

    m = runtime.manim()
    texs = [str(p).replace("{{", "{ {") for p in parts if str(p).strip()]
    if not texs:
        return {"ok": False, "error": "The equation has no terms.", "glyphs": []}
    cls = getattr(m, ctor, None) if ctor in ("MathTex", "Tex") else m.MathTex
    logger = logging.getLogger("manim")
    level = logger.level
    logger.setLevel(logging.CRITICAL)
    try:
        with m.tempconfig({"verbosity": "CRITICAL"}):
            mob = cls(*texs)
        glyphs = [len(sm.family_members_with_points()) for sm in mob.submobjects]
        return {"ok": len(glyphs) == len(texs), "glyphs": glyphs, "error": None if len(glyphs) == len(texs) else
                f"manim made {len(glyphs)} groups for {len(texs)} terms."}
    except Exception as exc:  # LaTeX errors are expected input errors
        msg = str(exc)
        log = re.findall(r"^! .*$", msg, flags=re.M)
        return {"ok": False, "glyphs": [], "error": (log[0] if log else msg.splitlines()[0] if msg else type(exc).__name__)[:400]}
    finally:
        logger.setLevel(level)


def make_server(project_path: str | None, port: int = 0) -> tuple[ThreadingHTTPServer, AppState]:
    app = AppState(project_path)
    handler = type("BoundHandler", (Handler,), {"app": app})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    app.port = server.server_address[1]
    return server, app
