"""Project (.mathengine) files: the scene document as pretty-printed JSON."""

from __future__ import annotations

import json
from pathlib import Path

FORMAT_VERSION = 1


def new_project() -> dict:
    return {
        "version": FORMAT_VERSION,
        "scene": {"name": "MainScene", "base": "Scene"},
        "config": {"pixel_width": 1920, "pixel_height": 1080, "frame_rate": 60, "background_color": "#000000"},
        "header": "",
        "objects": [],
        "steps": [],
    }


def load_project(path: str | Path) -> dict:
    doc = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    base = new_project()
    base.update(doc)
    base["config"] = {**new_project()["config"], **doc.get("config", {})}
    return base


def save_project(path: str | Path, doc: dict) -> None:
    p = Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    tmp.replace(p)
