"""Run a scene document in-process with manim and render a single frame at time t.

Seeking works by executing the generated ``construct()`` with a replacement
``play`` that skips through animations without rendering, stopping mid-play
when the requested time is reached. The frame is then drawn with the scene's
own camera, so the preview is pixel-identical to the final render.
"""

from __future__ import annotations

import base64
import hashlib
import io
import linecache
import math
import time as _time
import traceback
from dataclasses import dataclass, field
from typing import Any

from . import codegen

_manim = None


def manim():
    """Import manim lazily (it takes ~1s) and silence its console logging."""
    global _manim
    if _manim is None:
        import logging
        import manim as m

        logging.getLogger("manim").setLevel(logging.WARNING)
        _manim = m
    return _manim


class _Stop(Exception):
    """Raised inside play() once the target time has been reached."""


@dataclass
class StepTiming:
    id: str
    start: float
    end: float


@dataclass
class RunResult:
    duration: float = 0.0
    steps: list[StepTiming] = field(default_factory=list)
    objects: list[dict] = field(default_factory=list)
    camera: dict | None = None
    plays: int = 0
    image: str | None = None  # data: URL
    error: dict | None = None
    elapsed_ms: float = 0.0
    values: dict[str, float] = field(default_factory=dict)  # ValueTracker values at this time
    diagnostics: list[dict] = field(default_factory=list)  # construction problems (see construct.py)

    def to_json(self) -> dict:
        return {
            "duration": float(self.duration),
            "steps": [{"id": s.id, "start": float(s.start), "end": float(s.end)} for s in self.steps],
            "objects": self.objects,
            "camera": self.camera,
            "plays": self.plays,
            "image": self.image,
            "error": self.error,
            "elapsed_ms": round(self.elapsed_ms, 1),
            "values": self.values,
            "diagnostics": self.diagnostics,
        }


class PreviewMixin:
    """Mixed in front of the user's Scene class during preview."""

    _me_target: float | None = None
    _me_step_fps: float = 30.0

    def _me_init(self, target: float | None) -> None:
        self._me_target = target
        self._me_registry: dict[str, tuple[Any, str]] = {}
        self._me_open: dict[str, float] = {}
        self._me_steps: list[StepTiming] = []
        self._me_current_step: str | None = None
        self._me_plays = 0

    # hooks emitted by codegen(preview=True)
    def _me_reg(self, name: str, mob: Any, oid: str) -> None:
        self._me_registry[name] = (mob, oid)

    def _me_step(self, sid: str) -> None:
        self._me_current_step = sid
        self._me_open[sid] = self.renderer.time

    def _me_step_end(self, sid: str) -> None:
        start = self._me_open.pop(sid, self.renderer.time)
        self._me_steps.append(StepTiming(sid, start, self.renderer.time))

    def _me_needs_stepping(self) -> bool:
        # Constructions (construct.Constraints) depend only on the current state, not on dt, so
        # updating once at the target time is exact; other updaters may integrate over time.
        if self.always_update_mobjects or any(not getattr(u, "mathengine_constraints", False) for u in self.updaters):
            return True
        return any(m.has_time_based_updater() for m in self.get_mobject_family_members())

    def play(self, *args: Any, subcaption=None, subcaption_duration=None, subcaption_offset=0, **kwargs: Any) -> None:
        self._me_plays += 1
        self.compile_animation_data(*args, **kwargs)
        animations = self.animations
        duration = self.duration
        t0 = self.renderer.time
        self.begin_animations()

        stop_at = None
        if self._me_target is not None and self._me_target < t0 + duration - 1e-9:
            stop_at = max(0.0, self._me_target - t0)
        end = duration if stop_at is None else stop_at

        if end > 0 and self._me_needs_stepping():
            n = max(1, math.ceil(end * self._me_step_fps))
            for i in range(1, n + 1):
                self.update_to_time(end * i / n)
                self.renderer.time = t0 + end * i / n
        else:
            self.update_to_time(end)

        if stop_at is not None:
            self.renderer.time = t0 + stop_at
            raise _Stop()

        for anim in animations:
            anim.finish()
            anim.clean_up_from_scene(self)
        self.update_mobjects(0)
        self.renderer.time = t0 + duration
        self.animations = None


def _map_error(exc: BaseException, filename: str, gen: codegen.Generated) -> dict:
    line = None
    if isinstance(exc, SyntaxError) and exc.filename == filename:
        line = exc.lineno
    else:
        for frame in traceback.extract_tb(exc.__traceback__):
            if frame.filename == filename:
                line = frame.lineno
    ref = gen.linemap.get(line) if line else None
    msg = "".join(traceback.format_exception_only(type(exc), exc)).strip()
    return {
        "message": msg,
        "line": line,
        "kind": ref[0] if ref else None,
        "id": ref[1] if ref else None,
        "trace": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-4000:],
    }


def _render_png(scene: Any, max_width: int) -> str:
    from PIL import Image

    renderer = scene.renderer
    renderer.static_image = None
    renderer.update_frame(scene, ignore_skipping=True)
    img = Image.fromarray(renderer.get_frame()).convert("RGB")
    if img.width > max_width:
        img = img.resize((max_width, round(img.height * max_width / img.width)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _pt(p: Any) -> list[float]:
    return [round(float(p[0]), 4), round(float(p[1]), 4)]


def _sample_path(mob: Any, limit: int = 160) -> list[list[float]] | None:
    pts = [sm.points for sm in mob.family_members_with_points()]
    if not pts:
        return None
    import numpy as np

    allp = np.concatenate(pts)
    step = max(1, len(allp) // limit)
    return [_pt(p) for p in allp[::step]]


def _geometry(mob: Any, oid: str, part_index: dict[str, dict[str, int]]) -> dict:
    """Shape data the canvas needs for handles, snapping and hit testing (scene units)."""
    m = manim()
    out: dict[str, Any] = {}
    try:
        if isinstance(mob, m.Line):
            out["geom"] = {"kind": "line", "start": _pt(mob.get_start()), "end": _pt(mob.get_end())}
        elif isinstance(mob, m.Dot):
            out["geom"] = {"kind": "point", "center": _pt(mob.get_center())}
        elif isinstance(mob, m.Circle):
            out["geom"] = {"kind": "circle", "center": _pt(mob.get_center()), "radius": round(float(mob.width) / 2, 4)}
            out["path"] = _sample_path(mob, 64)
        elif isinstance(mob, m.Polygram):
            out["geom"] = {"kind": "polygon", "vertices": [_pt(v) for v in mob.get_vertices()]}
        elif isinstance(mob, m.ParametricFunction):
            out["path"] = _sample_path(mob)
        if isinstance(mob, m.CoordinateSystem) and hasattr(mob, "c2p"):
            o = mob.c2p(0, 0)
            out["axes"] = {"origin": _pt(o), "ux": _pt(mob.c2p(1, 0) - o), "uy": _pt(mob.c2p(0, 1) - o),
                           "x_range": [float(v) for v in mob.x_range[:2]], "y_range": [float(v) for v in mob.y_range[:2]]}
        elif isinstance(mob, m.NumberLine):
            o = mob.n2p(0)
            out["axes"] = {"origin": _pt(o), "ux": _pt(mob.n2p(1) - o), "uy": [0.0, 0.0],
                           "x_range": [float(v) for v in mob.x_range[:2]], "y_range": [0.0, 0.0]}
        if oid in part_index:
            parts = []
            for pid, i in part_index[oid].items():
                sub = mob.submobjects[i] if i < len(mob.submobjects) else None
                if sub is not None and any(sm.has_points() for sm in sub.get_family()):
                    ul, dr = sub.get_corner(m.UL), sub.get_corner(m.DR)
                    parts.append({"id": pid, "box": [float(ul[0]), float(dr[1]), float(dr[0]), float(ul[1])]})
                else:
                    parts.append({"id": pid, "box": None})
            out["parts"] = parts
    except Exception:  # geometry is a convenience for the editor; never fail a frame over it
        pass
    return out


def _object_boxes(scene: Any, part_index: dict[str, dict[str, int]] | None = None) -> list[dict]:
    m = manim()
    on_screen = set(id(x) for x in scene.get_mobject_family_members())
    out = []
    for name, (mob, oid) in scene._me_registry.items():
        visible = id(mob) in on_screen
        box = None
        try:
            if any(sm.has_points() for sm in mob.get_family()):
                ul, dr = mob.get_corner(m.UL), mob.get_corner(m.DR)
                c = mob.get_center()
                box = [float(ul[0]), float(dr[1]), float(dr[0]), float(ul[1])]
                center = [float(c[0]), float(c[1])]
            else:
                center = None
        except Exception:
            center = None
        info = {"id": oid, "name": name, "visible": visible, "box": box, "center": center}
        info.update(_geometry(mob, oid, part_index or {}))
        out.append(info)
    return out


def _tracker_values(scene: Any) -> dict[str, float]:
    m = manim()
    return {name: float(mob.get_value()) for name, (mob, _oid) in scene._me_registry.items() if isinstance(mob, m.ValueTracker)}


def _media_dir():
    from .render import cache_root

    return cache_root() / "preview-media"


def run(doc: dict, target: float | None = None, render: bool = True, preview_width: int = 960) -> RunResult:
    """Execute the document. With ``target`` set, stop at that time and render a frame."""
    m = manim()
    t_start = _time.perf_counter()
    result = RunResult()
    gen = codegen.generate(doc, preview=True)
    result.diagnostics = gen.diagnostics
    digest = hashlib.sha1(gen.source.encode()).hexdigest()[:12]
    filename = f"<mathengine-scene-{digest}>"
    linecache.cache[filename] = (len(gen.source), None, gen.source.splitlines(True), filename)

    cfg = doc.get("config", {})
    full_w = int(cfg.get("pixel_width", 1920))
    full_h = int(cfg.get("pixel_height", 1080))
    pw = min(preview_width, full_w)
    ph = round(full_h * pw / full_w)
    overrides = {
        "pixel_width": pw,
        "pixel_height": ph,
        "frame_rate": 30,
        "background_color": cfg.get("background_color", "#000000"),
        "disable_caching": True,
        "write_to_movie": False,
        "save_last_frame": False,
        "dry_run": True,
        "verbosity": "WARNING",
        "progress_bar": "none",
        "media_dir": str(_media_dir()),
    }

    with m.tempconfig(overrides):
        scene = None
        try:
            ns: dict[str, Any] = {"__name__": "mathengine_scene"}
            exec(compile(gen.source, filename, "exec"), ns)
            scene_cls = ns[doc.get("scene", {}).get("name") or "MainScene"]
            preview_cls = type(scene_cls.__name__, (PreviewMixin, scene_cls), {})
            scene = preview_cls()
            scene._me_init(target)
            scene.setup()
            try:
                scene.construct()
            except _Stop:
                pass
        except Exception as exc:  # user code errors are expected; report them
            result.error = _map_error(exc, filename, gen)

        if scene is not None and hasattr(scene, "_me_steps"):
            # Close a step interrupted by _Stop or an error so it still shows on the timeline.
            for sid, start in scene._me_open.items():
                scene._me_steps.append(StepTiming(sid, start, scene.renderer.time))
            result.steps = scene._me_steps
            result.duration = scene.renderer.time
            result.plays = scene._me_plays
            result.objects = _object_boxes(scene, gen.part_index)
            result.values = _tracker_values(scene)
            cam = scene.camera
            fc = cam.frame_center
            result.camera = {
                "center": [float(fc[0]), float(fc[1])],
                "width": float(cam.frame_width),
                "height": float(cam.frame_height),
            }
            if render:
                try:
                    result.image = _render_png(scene, pw)
                except Exception as exc:
                    result.error = result.error or _map_error(exc, filename, gen)
    result.elapsed_ms = (_time.perf_counter() - t_start) * 1000
    return result
