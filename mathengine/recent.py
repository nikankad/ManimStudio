"""Recently opened projects, for the Home screen.

Kept in the app's folder (``~/.mathengine``, or ``$MANIM_STUDIO_HOME``): ``recent.json`` lists the projects,
newest first, and ``thumbnails/`` holds a small preview of each, taken from the editor when it was saved.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from pathlib import Path

from .project import resolve_project_path

LIMIT = 24
MAX_THUMBNAIL = 400_000  # bytes


def app_dir() -> Path:
    return Path(os.environ.get("MANIM_STUDIO_HOME") or Path.home() / ".mathengine")


def _list_path() -> Path:
    return app_dir() / "recent.json"


def _thumb(path: str) -> Path:
    return app_dir() / "thumbnails" / (hashlib.sha1(path.encode("utf-8")).hexdigest()[:16] + ".jpg")


def _norm(path: str | Path) -> str:
    return str(resolve_project_path(path).resolve())


def _load() -> list[dict]:
    try:
        entries = json.loads(_list_path().read_text(encoding="utf-8")).get("projects", [])
    except (OSError, ValueError):
        return []
    return [e for e in entries if isinstance(e, dict) and isinstance(e.get("path"), str)]


def _write(entries: list[dict]) -> None:
    p = _list_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({"version": 1, "projects": entries[:LIMIT]}, indent=2), encoding="utf-8")
    tmp.replace(p)


def add(path: str | Path, thumbnail: str | None = None) -> None:
    """Put a project first in the list (opened or saved just now), with its preview if given (a JPEG data URL)."""
    path = _norm(path)
    entries = [e for e in _load() if _norm(e["path"]) != path]
    entries.insert(0, {"path": path, "opened": time.time()})
    _write(entries)
    if thumbnail:
        set_thumbnail(path, thumbnail)


def set_thumbnail(path: str | Path, thumbnail: str) -> None:
    """Store a project's preview (a JPEG data URL; anything else is ignored)."""
    if not thumbnail.startswith("data:image/jpeg;base64,"):
        return
    try:
        data = base64.b64decode(thumbnail.split(",", 1)[1], validate=True)
    except ValueError:
        return
    if 0 < len(data) <= MAX_THUMBNAIL:
        t = _thumb(_norm(path))
        t.parent.mkdir(parents=True, exist_ok=True)
        t.write_bytes(data)


def has_thumbnail(path: str | Path) -> bool:
    return _thumb(_norm(path)).is_file()


def remove(path: str) -> None:
    """Take a project off the list (the file itself is left alone)."""
    entries = _load()
    path = _norm(path)
    kept = [e for e in entries if _norm(e["path"]) != path]
    if len(kept) != len(entries):
        _write(kept)
        for e in entries:
            if _norm(e["path"]) == path:
                _thumb(e["path"]).unlink(missing_ok=True)
        _thumb(path).unlink(missing_ok=True)


def listing() -> list[dict]:
    """The list for the Home screen: name, folder, when opened, size, whether the file still exists, preview."""
    out = []
    for e in _load():
        p = resolve_project_path(e["path"])
        try:
            st = p.stat()
            exists, size, modified = True, st.st_size, st.st_mtime
        except OSError:
            exists, size, modified = False, None, None
        thumb = _thumb(e["path"])
        if not thumb.is_file():
            thumb = _thumb(str(p))
        out.append({
            "path": str(p), "name": p.stem, "folder": str(p.parent), "opened": e.get("opened"),
            "modified": modified, "size": size, "exists": exists,
            "thumbnail": "data:image/jpeg;base64," + base64.b64encode(thumb.read_bytes()).decode() if exists and thumb.is_file() else None,
        })
    return out
