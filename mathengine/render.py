"""Full-quality rendering through the real ``manim`` CLI in a subprocess.

Running out-of-process keeps the editor responsive, uses manim's own partial
movie cache (only changed animations re-render), and guarantees the output is
exactly what ``manim render`` would produce from the exported ``.py`` file.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path

from . import codegen

QUALITIES = {
    # name: (width, height, fps)
    "preview": (854, 480, 30),
    "720p": (1280, 720, 30),
    "1080p": (1920, 1080, 60),
    "1440p": (2560, 1440, 60),
    "4k": (3840, 2160, 60),
}


def cache_root() -> Path:
    base = os.environ.get("LOCALAPPDATA") if sys.platform == "win32" else None
    root = Path(base) if base else Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    path = root / "mathengine"
    path.mkdir(parents=True, exist_ok=True)
    return path


def manim_command() -> list[str]:
    """How to run manim's command line: ``python -m manim``, or the packaged app's console executable,
    which runs manim when given ``manim`` as its first argument (see __main__.py and packaging/)."""
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable)
        cli = exe.with_name("manim-studio" + (".exe" if sys.platform == "win32" else ""))
        return [str(cli if cli.exists() else exe), "manim"]
    return [sys.executable, "-m", "manim"]


def partial_movie_readable(path: Path) -> bool:
    """Whether a cached partial movie can be read. manim writes each one in place and takes any file that exists for
    a finished animation, so a render killed midway (every edit cancels the running preview) leaves one with no
    index that fails every later render of that animation with "Invalid data found"."""
    try:
        if path.stat().st_size < 64:
            return False
        import av

        with av.open(str(path)) as container:
            return any(stream.type == "video" for stream in container.streams)
    except Exception:
        return False


def purge_broken_partials(media: Path) -> int:
    """Delete the cached partial movies that can't be read (the next render makes them again); how many went."""
    gone = 0
    for movie in media.glob("videos/**/partial_movie_files/**/*.mp4"):
        if not partial_movie_readable(movie):
            movie.unlink(missing_ok=True)
            gone += 1
    return gone


CACHE_MAX_AGE = 14 * 86400  # seconds: a cached piece nobody has rendered for two weeks is not worth keeping
CACHE_MAX_BYTES = 2 * 1024**3  # per project; 4K renders cache pieces of tens of megabytes


def prune_cache(media: Path, max_age: float = CACHE_MAX_AGE, max_bytes: int = CACHE_MAX_BYTES, now: float | None = None) -> int:
    """Keep a project's cache of partial movies from growing for ever: delete the pieces older than ``max_age``, then
    the oldest of the rest while the total is over ``max_bytes``. Returns how many went. (Only partial movies and the
    videos assembled from them; the next render makes whatever it needs again.)"""
    import time

    now = time.time() if now is None else now
    pieces = []
    for movie in media.glob("videos/**/*.mp4"):
        try:
            st = movie.stat()
        except OSError:
            continue
        pieces.append((st.st_mtime, st.st_size, movie))
    pieces.sort()  # oldest first
    total = sum(size for _, size, _ in pieces)
    gone = 0
    for mtime, size, movie in pieces:
        if now - mtime > max_age or total > max_bytes:
            try:
                movie.unlink()
            except OSError:
                continue
            total -= size
            gone += 1
    return gone


class RenderJob:
    def __init__(self, doc: dict, quality: str, output: str | None, project_key: str, plays: int = 1):
        self.id = uuid.uuid4().hex[:12]
        self.doc = doc
        self.quality = quality
        self.output = output
        self.state = "queued"  # queued | running | done | error | cancelled
        self.progress = 0.0
        self.message = ""
        self.result: Path | None = None
        self.log = ""
        self._proc: subprocess.Popen | None = None
        self.workdir = cache_root() / "projects" / hashlib.sha1(project_key.encode()).hexdigest()[:12]
        self.total_plays = max(1, plays)
        self._retried = False

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "progress": round(self.progress, 4),
            "message": self.message,
            "output": str(self.result) if self.result else None,
            "log": self.log[-3000:] if self.state == "error" else "",
        }

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()

    def cancel(self) -> None:
        self.state = "cancelled"
        if self._proc and self._proc.poll() is None:
            self._proc.kill()

    def _run(self) -> None:
        self.state = "running"
        try:
            self.workdir.mkdir(parents=True, exist_ok=True)
            scene_name = self.doc.get("scene", {}).get("name") or "MainScene"
            script = self.workdir / "scene.py"
            script.write_text(codegen.generate(self.doc).source, encoding="utf-8")
            if self.quality in QUALITIES:
                w, h, fps = QUALITIES[self.quality]
            else:
                cfg = self.doc.get("config", {})
                w, h, fps = cfg.get("pixel_width", 1920), cfg.get("pixel_height", 1080), cfg.get("frame_rate", 60)
            out_name = "preview" if self.quality == "preview" else "render"
            media = self.workdir / "media"
            # A video left by an earlier render of this project must not pass for this one's (a scene without
            # self.play makes no video at all).
            for old in media.glob(f"videos/**/{out_name}.mp4"):
                old.unlink(missing_ok=True)
            purge_broken_partials(media)  # left by a render that was cancelled or killed
            prune_cache(media)
            cmd = [
                *manim_command(), "render", str(script), scene_name,
                "--media_dir", str(media), "-o", out_name,
                "-r", f"{w},{h}", "--fps", str(fps), "--progress_bar", "display",
            ]
            env = dict(os.environ, PYTHONWARNINGS="ignore", PYTHONUNBUFFERED="1", COLUMNS="200")
            self.message = "Rendering…"
            self._proc = subprocess.Popen(
                cmd, cwd=self.workdir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
                **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}),
            )
            self._pump(self._proc)
            code = self._proc.wait()
            if self.state == "cancelled":
                return
            if code != 0 and not self._retried and "Invalid data found" in self.log and purge_broken_partials(media):
                self._retried = True  # a cached piece was damaged after all: it is gone now, so once more
                self.log = ""
                self.progress = 0.0
                return self._run()
            if code != 0:
                self.state = "error"
                self.message = _last_error(self.log) or f"manim exited with code {code}"
                return
            found = sorted(media.glob(f"videos/**/{out_name}.mp4"), key=lambda p: p.stat().st_mtime)
            if not found:
                self.state = "error"
                self.message = ("Nothing to play: the scene has no self.play or self.wait" if "no play calls" in self.log
                                else "manim finished but no video was produced")
                return
            self.result = found[-1]
            if self.output:
                dest = Path(self.output).expanduser()
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(self.result, dest)
                self.result = dest
            self.progress = 1.0
            self.state = "done"
            self.message = f"Saved {self.result}"
        except Exception as exc:
            self.state = "error"
            self.message = str(exc)

    def _pump(self, proc: subprocess.Popen) -> None:
        anim_re = re.compile(rb"Animation (\d+)")
        pct_re = re.compile(rb"(\d+)%\|")
        buf = b""
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
            if not chunk:
                break
            buf = (buf + chunk)[-8000:]
            self.log = (self.log + chunk.decode("utf-8", "replace"))[-20000:]
            anims = anim_re.findall(buf)
            pcts = pct_re.findall(buf)
            if anims:
                idx = int(anims[-1])
                frac = int(pcts[-1]) / 100 if pcts else 0
                self.progress = min(0.99, (idx + frac) / self.total_plays)
                self.message = f"Animation {idx + 1}/{self.total_plays}"
            elif b"Combining" in buf or b"File ready" in buf:
                self.message = "Combining…"


def _last_error(log: str) -> str:
    lines = [ln.strip() for ln in log.splitlines() if ln.strip()]
    for ln in reversed(lines):
        if "Error" in ln or "error" in ln:
            return re.sub(r"\x1b\[[0-9;]*m", "", ln)[:500]
    return ""
