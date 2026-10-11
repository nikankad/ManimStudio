"""Project files (.manimstudio; .mathengine from earlier versions): the scene document as pretty-printed JSON.

Format history (each upgrade is explicit and lossless):

* 1: a sequential list of steps.
* 2: objects, tracks and timed clips.
* 3: adds constructions. Objects may carry ``link`` (a relationship to other
  objects by id, see construct.py), ``eq`` (an equation split into terms with
  stable ids), ``param`` (slider bounds of a ValueTracker parameter) and
  ``instance`` (membership of an inserted construction); clips may carry
  ``terms`` (term correspondence of a TransformTerms clip); the document has
  ``constructions`` (reusable templates saved with the project). Version 2
  documents are valid version 3 documents without any of these.
* 4: the timeline is the ordered list of ``construct()`` statements (``timeline``, see timeline.py):
  ``self.play`` with its animations, ``self.wait``, ``self.add``, ``self.remove`` and code, instead of
  clips at free times on tracks. Each step is one manim statement, so the editor and the code match one
  to one. Clips are converted to the statements the old editor compiled them to (overlapping clips
  become one ``self.play``; a clip that started later inside it waits first with ``Succession(Wait(t), …)``).
  Construction templates get a ``timeline`` too.

  Optional, for code read with importer.py (manim code -> document): objects may carry ``after`` (the
  step they are created after, as in the code; none: at the top of construct()) and ``comment`` (comment
  lines above them in the code), steps may carry ``comment``, and ``scene`` may carry ``members`` and
  ``members_after`` (other code of the scene class, before and after construct()).
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from . import timeline

FORMAT_VERSION = 4


def _id(prefix: str) -> str:
    return prefix + uuid.uuid4().hex[:7]


def new_project() -> dict:
    return {
        "version": FORMAT_VERSION,
        "scene": {"name": "MainScene", "base": "Scene"},
        "config": {"pixel_width": 1920, "pixel_height": 1080, "frame_rate": 60, "background_color": "#000000"},
        "header": "",
        "objects": [],
        "timeline": [],
        "markers": [],
        "constructions": [],
    }


def load_project(path: str | Path) -> dict:
    doc = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    return upgrade(doc)


def upgrade(doc: dict) -> dict:
    """Bring a document of any supported version to FORMAT_VERSION."""
    version = doc.get("version", 1)
    if version > FORMAT_VERSION:
        raise ValueError(f"This project was saved by a newer Manim Studio (format {version}; this version reads up to {FORMAT_VERSION}).")
    if version < 2:
        doc = upgrade_v1(doc)
    if doc.get("version", 1) < 3:
        doc = upgrade_v2(doc)
    if doc.get("version", 1) < 4:
        doc = upgrade_v3(doc)
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


def upgrade_v2(doc: dict) -> dict:
    """Version 3 only adds optional fields; existing objects, clips and Python sources are kept verbatim."""
    out = dict(doc)
    out["version"] = 3
    out.setdefault("markers", [])
    out.setdefault("constructions", [])
    return out


def upgrade_v3(doc: dict) -> dict:
    """Clips at times on tracks become the statements they compiled to (timeline.from_clips)."""
    out = {k: v for k, v in doc.items() if k not in ("clips", "tracks")}
    out["version"] = 4
    out["timeline"] = timeline.from_clips(doc.get("clips") or [], doc.get("tracks") or [])
    out["constructions"] = [upgrade_template(t) for t in doc.get("constructions") or []]
    return out


def upgrade_template(t: dict) -> dict:
    """A construction template with ``clips`` (relative times, format 3) gets the equivalent ``timeline``."""
    if "clips" not in t:
        return t
    clips = [{"id": _id("c"), "track": "t1", **c} for c in t.get("clips") or []]
    for c in clips:
        c.setdefault("start", 0)
        c.setdefault("duration", 1 if c.get("kind") in ("anim", "hold", "code") else 0)
    out = {k: v for k, v in t.items() if k != "clips"}
    out["timeline"] = timeline.from_clips(clips, [])
    return out


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
    out.update(version=2, clips=clips)
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
