"""Unsaved work, kept so a crash or a closed window doesn't lose it.

While a project has unsaved changes the editor sends a copy here every few seconds. Each editing session has
its own file in ``recovery/`` under the app's folder (see ``recent.app_dir``); Home lists them so the work can
be restored. Saving or discarding a project removes its copy. Only the newest few are kept.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

from .recent import app_dir

LIMIT = 8
MAX_AGE = 14 * 86400  # seconds
_ID = re.compile(r"[A-Za-z0-9_-]{6,64}")


def _dir() -> Path:
    return app_dir() / "recovery"


def _file(rid: str) -> Path:
    if not isinstance(rid, str) or not _ID.fullmatch(rid):
        raise ValueError("bad recovery id")
    return _dir() / f"{rid}.json"


def _read(p: Path) -> dict | None:
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("doc"), dict) else None


def save(rid: str, path: str | None, doc: dict) -> None:
    """Keep ``doc`` as the unsaved state of editing session ``rid`` (of the project at ``path``, or untitled)."""
    p = _file(rid)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({"id": rid, "path": path, "saved": time.time(), "doc": doc}), encoding="utf-8")
    tmp.replace(p)
    _prune(p)


def clear(rid: str) -> None:
    _file(rid).unlink(missing_ok=True)


def load(rid: str) -> dict | None:
    """``{"id", "path", "saved", "doc"}`` of one saved session, or None."""
    return _read(_file(rid))


def listing() -> list[dict]:
    """What Home offers to restore, newest first: ``{"id", "path", "name", "scene", "saved"}`` (no documents)."""
    out = []
    for p in _dir().glob("*.json"):
        data = _read(p)
        if not data or not _ID.fullmatch(str(data.get("id", ""))):
            continue
        path = data.get("path")
        out.append({
            "id": data["id"], "path": path,
            "name": Path(path).stem if path else "Untitled",
            "scene": (data["doc"].get("scene") or {}).get("name", ""),
            "saved": data.get("saved") or p.stat().st_mtime,
        })
    return sorted(out, key=lambda e: e["saved"], reverse=True)


def for_path(path: str | Path) -> list[dict]:
    """The saved sessions of the project at ``path``, newest first (offered when that file is opened directly)."""
    want = _same(path)
    return [e for e in listing() if e["path"] and _same(e["path"]) == want]


def _same(path: str | Path) -> str:
    try:
        return str(Path(path).expanduser().resolve())
    except OSError:
        return str(path)


def _prune(newest: Path) -> None:
    """Runs at every autosave (``newest`` was just written): by the files' times, without reading the documents."""
    now = time.time()
    entries = []
    for p in _dir().glob("*.json"):
        try:
            entries.append((p == newest, p.stat().st_mtime, p))
        except OSError:
            continue
    entries.sort(key=lambda e: e[:2], reverse=True)  # the one just written, then newest first
    for i, (_, mtime, p) in enumerate(entries):
        if i >= LIMIT or now - mtime > MAX_AGE:
            p.unlink(missing_ok=True)
    for tmp in _dir().glob("*.tmp"):  # left by a write that was cut off
        if now - tmp.stat().st_mtime > 3600:
            tmp.unlink(missing_ok=True)
