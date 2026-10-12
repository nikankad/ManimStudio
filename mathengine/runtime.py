"""Run a scene document in-process with manim and render a single frame at time t.

Seeking works by executing the generated ``construct()`` with the renderer's
``play`` replaced by one that runs manim's own frame loop (at the project's
frame rate) without drawing, stopping at the frame shown at the requested
time. The scene's ``play``/``wait`` run as written, so overrides, stop
conditions, frozen waits and ``dt`` updaters behave as in ``manim render``.
The frame is then drawn with the scene's own camera, so the preview is
pixel-identical to the final render.

The same run measures the timeline: when each statement starts and ends, and
when manim runs each animation, including the ones inside AnimationGroup,
LaggedStart and Succession (read from manim's own ``anims_with_timings``). The
editor draws the timeline from these times, so it shows what manim does.
"""

from __future__ import annotations

import base64
import hashlib
import io
import linecache
import math
import re
import time as _time
import traceback
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import codegen, tex

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
    curve: list[float] | None = None  # an animation's progress at evenly spaced times from start to end


@dataclass
class RunResult:
    duration: float = 0.0
    steps: list[StepTiming] = field(default_factory=list)
    anims: list[StepTiming] = field(default_factory=list)  # when manim runs each animation
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
            "anims": [{"id": s.id, "start": round(float(s.start), 6), "end": round(float(s.end), 6),
                       **({"curve": s.curve} if s.curve else {})} for s in self.anims],
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

    def _me_init(self, target: float | None) -> None:
        self._me_target = target
        self.renderer.play = self._me_render_play
        self._me_registry: dict[str, tuple[Any, str]] = {}
        self._me_open: dict[str, float] = {}
        self._me_steps: list[StepTiming] = []
        self._me_anims: list[StepTiming] = []
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

    def _me_tag(self, anim: Any, aid: str) -> Any:
        """Mark an animation of the timeline so its timing can be reported (manim's own prepare_animation)."""
        from manim.animation.animation import prepare_animation

        anim = prepare_animation(anim)
        anim._me_id = aid
        return anim

    def _me_time(self, anim: Any, scene_at: Any) -> None:
        """Record when manim runs ``anim`` and, inside compositions, each child (scene seconds).
        ``scene_at(alpha)``: the scene time at which ``anim`` is interpolated to ``alpha``."""
        aid = getattr(anim, "_me_id", None)
        if aid:
            start, end = scene_at(0.0), scene_at(1.0)
            # Only for the timeline's measuring run (no target): seeking doesn't need it.
            curve = _curve(anim.rate_func, scene_at, start, end) if self._me_target is None else None
            self._me_anims.append(StepTiming(aid, start, end, curve))
        timings = getattr(anim, "anims_with_timings", None)
        total = float(getattr(anim, "max_end_time", 0) or 0)
        if timings is None or total <= 0:
            return
        # AnimationGroup / Succession.interpolate: group time = rate_func(alpha) * max_end_time, and a child's
        # alpha is linear in group time. The group's own alpha comes from its parent's, so easings compose.
        for row in timings:
            s, e = float(row["start"]), float(row["end"])

            def child_at(c: float, s=s, e=e) -> float:
                return scene_at(_inverse(anim.rate_func, (s + c * (e - s)) / total))

            self._me_time(row["anim"], child_at)

    def _me_needs_stepping(self) -> bool:
        # Constructions (construct.Constraints) depend only on the current state, not on dt, so
        # updating once at the target time is exact; other updaters may integrate over time.
        if self.stop_condition is not None:
            return True
        if self.always_update_mobjects or any(not getattr(u, "mathengine_constraints", False) for u in self.updaters):
            return True
        return any(m.has_time_based_updater() for m in self.get_mobject_family_members())

    def _me_render_play(self, scene: Any, *args: Any, **kwargs: Any) -> None:
        """Stands in for ``CairoRenderer.play`` (Scene.play -> Manager.play -> renderer.play), so the scene's own
        ``play``/``wait`` (and any override of them) run as written. Steps through manim's own frame loop
        (``Scene.play_internal``) without drawing; the clock moves by whole frames, as in the video."""
        m = manim()
        r = self.renderer
        r.skip_animations = r._original_skipping_status
        r.update_skipping_status()
        self.compile_animation_data(*args, **kwargs)
        self._me_plays += 1
        t0 = r.time
        duration = self.duration
        self.begin_animations()
        for anim in self.animations:
            self._me_time(anim, lambda a, t0=t0, rt=float(anim.run_time): t0 + a * rt)

        dt = 1 / m.config.frame_rate
        target = self._me_target
        if r.skip_animations:  # a skipped section: no frames, the clock still moves by the duration
            if target is not None and target < t0 + duration - 1e-9:
                r.time = target
                raise _Stop()
            if not self.is_current_animation_frozen_frame():
                times = np.arange(0, duration, dt) if self.stop_condition is not None else [duration]
                for t in times:
                    self.update_to_time(t)
                    if self.stop_condition is not None and self.stop_condition():
                        break
            frames_end = t0 + duration
        elif self.is_current_animation_frozen_frame():  # a wait with nothing updating: one frame held
            frames_end = t0 + int(duration / dt) * dt
            if target is not None and target < frames_end - 1e-9:
                r.time = target
                raise _Stop()
        else:
            times = np.arange(0, duration, dt)
            # The frame of this play shown at the target time.
            stop = None
            if target is not None and target < t0 + len(times) * dt - 1e-9:
                stop = min(len(times) - 1, max(0, math.floor((target - t0) / dt + 1e-9)))
            if self._me_needs_stepping():
                played = len(times)
                for i, t in enumerate(times):
                    r.time = t0 + i * dt
                    self.update_to_time(t)
                    if i == stop:
                        r.time = target
                        raise _Stop()
                    if self.stop_condition is not None and self.stop_condition():
                        played = i + 1
                        break
            else:
                # Nothing depends on the frames in between (no dt updaters or stop condition): go straight there.
                played = len(times)
                i = played - 1 if stop is None else stop
                if i >= 0:
                    r.time = t0 + i * dt
                    self.update_to_time(times[i])
                if stop is not None:
                    r.time = target
                    raise _Stop()
            frames_end = t0 + played * dt

        for anim in self.animations:
            anim.finish()
            anim.clean_up_from_scene(self)
        if not r.skip_animations:
            self.update_mobjects(0)
        r.static_image = None
        r.time = frames_end
        r.num_plays += 1


_CURVE_SAMPLES = 21


def _curve(rate_func: Any, scene_at: Any, start: float, end: float) -> list[float] | None:
    """The progress manim gives an animation (its own rate function, after the easing of the groups it is in)
    at evenly spaced scene times from ``start`` to ``end``: what its clip on the timeline draws."""
    if end - start < 1e-9:
        return None
    try:
        alphas = np.linspace(0, 1, 2 * _CURVE_SAMPLES - 1)
        xs = np.array([(scene_at(a) - start) / (end - start) for a in alphas])
        ys = np.array([float(rate_func(float(a))) for a in alphas])
        out = np.interp(np.linspace(0, 1, _CURVE_SAMPLES), xs, ys)
    except Exception:
        return None
    return [round(float(v), 4) for v in out]


def _inverse(rate_func: Any, value: float) -> float:
    """The first alpha at which ``rate_func(alpha)`` reaches ``value`` (when a child of a group starts or ends)."""
    if value <= 0:
        return 0.0
    if value >= 1:
        return 1.0
    n = 400
    prev = 0.0
    try:
        for i in range(1, n + 1):
            alpha = i / n
            y = float(rate_func(alpha))
            if y >= value - 1e-12:
                y0 = float(rate_func(prev))
                return prev + (alpha - prev) * ((value - y0) / (y - y0) if y > y0 else 1)
            prev = alpha
    except Exception:
        return value
    return 1.0


def _needs_latex(exc: BaseException) -> bool:
    """manim failed because LaTeX (or dvisvgm) isn't installed."""
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, FileNotFoundError) and re.search(r"\b(latex|dvisvgm|xelatex)\b", str(exc)) and not tex.latex_available():
            return True
        exc = exc.__cause__ or exc.__context__
    return False


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
    if _needs_latex(exc):
        diag = next((d for d in gen.diagnostics if ref and d["id"] == ref[1] and d["level"] == "error"), None)
        msg = diag["message"] if diag and "LaTeX" in diag["message"] else tex.missing_message("This object")
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
        "frame_rate": int(cfg.get("frame_rate", 60)),  # updaters step once per frame, as in the video
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
            result.anims = scene._me_anims
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
