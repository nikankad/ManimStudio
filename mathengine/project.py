"""Project (.mathengine) files: the scene document as pretty-printed JSON."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

FORMAT_VERSION = 2


def _id(prefix: str) -> str:
    return prefix + uuid.uuid4().hex[:7]


def new_project() -> dict:
    return {
        "version": FORMAT_VERSION,
        "scene": {"name": "MainScene", "base": "Scene"},
        "config": {"pixel_width": 1920, "pixel_height": 1080, "frame_rate": 60, "background_color": "#000000"},
        "header": "",
        "objects": [],
        "tracks": [{"id": f"t{i + 1}", "name": f"V{i + 1}"} for i in range(3)],
        "clips": [],
    }


def load_project(path: str | Path) -> dict:
    doc = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    if doc.get("version", 1) < 2:
        doc = upgrade_v1(doc)
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


def upgrade_v1(doc: dict) -> dict:
    """Version 1 had a sequential list of steps; lay them out as timed clips on tracks."""
    def track_for(_key: str) -> str:
        return "t1"  # reassigned by pack_tracks

    clips: list[dict] = []
    t = 0.0
    for step in doc.get("steps", []):
        kind = step.get("kind")
        if kind == "play":
            anims = step.get("anims", [])
            dur = _float(step.get("run_time"), 1.0)
            lag = _float(step.get("lag_ratio"), 0.0)
            for i, a in enumerate(anims):
                clips.append({
                    "id": a.get("id") or _id("c"), "kind": "anim", "track": track_for(a.get("target", "")),
                    "start": round(t + i * lag * dur, 4), "duration": dur,
                    "cls": a.get("cls", ""), "target": a.get("target", ""),
                    "args": {**a.get("args", {}), **({"rate_func": step["rate_func"]} if step.get("rate_func") else {})},
                    "chain": a.get("chain", ""), "disabled": step.get("disabled", False),
                })
            t += dur * (1 + max(0, len(anims) - 1) * lag)
        elif kind == "wait":
            dur = _float(step.get("duration"), 1.0)
            clips.append({"id": step["id"], "kind": "hold", "track": track_for("__hold"), "start": t, "duration": dur})
            t += dur
        elif kind == "code":
            clips.append({"id": step["id"], "kind": "code", "track": track_for("__code"), "start": t, "duration": 1.0,
                          "code": step.get("code", ""), "disabled": step.get("disabled", False)})
            t += 1.0
        elif kind in ("add", "remove"):
            clips.append({"id": step["id"], "kind": kind, "track": track_for("__code"), "start": t, "duration": 0,
                          "targets": step.get("targets", [])})
    out = {k: v for k, v in doc.items() if k != "steps"}
    out.update(version=FORMAT_VERSION, clips=clips)
    out["tracks"] = pack_tracks(clips)
    return out


def pack_tracks(clips: list[dict], minimum: int = 3) -> list[dict]:
    """Assign clips to as few tracks as possible (first free track, earliest clips first)."""
    ends: list[float] = []
    for c in sorted(clips, key=lambda c: (c["start"], c["id"])):
        idx = next((i for i, e in enumerate(ends) if e <= c["start"] + 1e-9), None)
        if idx is None:
            ends.append(0.0)
            idx = len(ends) - 1
        ends[idx] = c["start"] + max(c.get("duration", 0), 0.05)
        c["track"] = f"t{idx + 1}"
    return [{"id": f"t{i + 1}", "name": f"V{i + 1}"} for i in range(max(minimum, len(ends)))]


def _float(v, default: float) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default
