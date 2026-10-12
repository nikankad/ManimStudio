"""Small user preferences (update-check opt-out, the welcome card, the timeline's height…).

Kept in ``prefs.json`` in the app's folder (see ``recent.app_dir``) rather than in the browser's storage: the
editor's address changes with its port at every launch, so the window starts with empty storage each time.
"""

from __future__ import annotations

import json
import re
import threading
from typing import Any

from .recent import app_dir

MAX_KEYS = 100
MAX_VALUE = 1000  # characters
_KEY = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_lock = threading.Lock()


def _file():
    return app_dir() / "prefs.json"


def load() -> dict[str, str]:
    try:
        data = json.loads(_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def set_pref(key: Any, value: Any) -> dict[str, str]:
    """Remember ``key`` = ``value`` (a string), or forget ``key`` when ``value`` is None. Returns all preferences."""
    if not isinstance(key, str) or not _KEY.fullmatch(key):
        raise ValueError("bad preference name")
    if value is not None and (not isinstance(value, str) or len(value) > MAX_VALUE):
        raise ValueError("a preference is a short string")
    with _lock:  # the server answers requests on several threads: two quick changes must not overwrite each other
        prefs = load()
        if value is None:
            prefs.pop(key, None)
        else:
            if key not in prefs and len(prefs) >= MAX_KEYS:
                raise ValueError("too many preferences")
            prefs[key] = value
        p = _file()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(prefs, indent=2), encoding="utf-8")
        tmp.replace(p)
        return prefs
