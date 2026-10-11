"""Which MathEngine this is, and whether a newer one has been released.

Release builds carry ``_build.py`` (written by .github/workflows/release.yml): version, channel ("stable"
for tagged releases, "nightly" for builds of every push to main), commit and repository. Anything else
(running from source) is the "dev" channel and never checks for updates.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request

try:
    from . import _build  # type: ignore[attr-defined]
except ImportError:
    _build = None

REPOSITORY = getattr(_build, "REPOSITORY", "nikankad/MathEngine")
CHANNEL = getattr(_build, "CHANNEL", "dev")
COMMIT = getattr(_build, "COMMIT", "")


def _installed_version() -> str:
    try:
        from importlib.metadata import version

        return version("mathengine")
    except Exception:
        return "0.0.0"


VERSION = getattr(_build, "VERSION", _installed_version())


def info() -> dict:
    return {"version": VERSION, "channel": CHANNEL, "commit": COMMIT[:7], "repository": REPOSITORY,
            "releases": f"https://github.com/{REPOSITORY}/releases"}


def _numbers(v: str) -> tuple[int, ...]:
    """Comparable release number: "0.2.10" -> (0, 2, 10) (a "-nightly…" suffix is ignored)."""
    return tuple(int(x) for x in re.findall(r"\d+", v.split("-")[0])[:3])


def _get(url: str, timeout: float) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "MathEngine"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.load(res)


def check_for_update(timeout: float = 5.0) -> dict:
    """Is a newer release out? Stable builds look at the latest stable release, nightly builds at the latest
    nightly. One request to GitHub's public API; never raises (offline means "no update")."""
    out = {"available": False, **info()}
    if CHANNEL not in ("stable", "nightly") or os.environ.get("MATHENGINE_NO_UPDATE_CHECK"):
        return out
    try:
        if CHANNEL == "stable":
            rel = _get(f"https://api.github.com/repos/{REPOSITORY}/releases/latest", timeout)
            latest = str(rel.get("tag_name", "")).lstrip("v")
            if latest and _numbers(latest) > _numbers(VERSION):
                out.update(available=True, latest=latest, url=rel.get("html_url") or out["releases"])
        else:
            rel = _get(f"https://api.github.com/repos/{REPOSITORY}/releases/tags/nightly", timeout)
            built_from = re.search(r"\b([0-9a-f]{40})\b", rel.get("body") or "")
            if built_from and COMMIT and built_from.group(1) != COMMIT:
                out.update(available=True, latest=rel.get("name", "nightly").replace("MathEngine ", ""),
                           url=rel.get("html_url") or out["releases"])
    except Exception:
        pass
    return out


def release_page(url: str) -> bool:
    """URLs the app may open in the browser: this project's releases."""
    return url.startswith(f"https://github.com/{REPOSITORY}/releases")
