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
            cmd = [
                sys.executable, "-m", "manim", "render", str(script), scene_name,
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
            if code != 0:
                self.state = "error"
                self.message = _last_error(self.log) or f"manim exited with code {code}"
                return
            found = sorted(media.glob(f"videos/**/{out_name}.mp4"), key=lambda p: p.stat().st_mtime)
            if not found:
                self.state = "error"
                self.message = "manim finished but no video was produced"
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
