"""Sample projects shown on the Home screen.

Each sample is a complete project built from the editor's own features (constructions, parameters,
timeline clips), so opening one shows how it was made. They only use Text for words, so they work
without LaTeX. Thumbnails live next to this file (``samples/<id>.jpg``, made by
scripts/sample_thumbnails.py).
"""

from __future__ import annotations

import base64
import copy
from pathlib import Path

from .project import new_project, pack_tracks

THUMBS = Path(__file__).parent / "samples"


def _o(id: str, name: str, ctor: str, **kw) -> dict:
    return {"id": id, "name": name, "ctor": ctor, "args": kw.pop("args", {}), "pos": kw.pop("pos", None),
            "chain": kw.pop("chain", ""), **kw}


def _text(id: str, name: str, text: str, size: int = 32, color: str | None = None, **kw) -> dict:
    args = {"*": repr(text), "font_size": str(size), **({"color": color} if color else {}), **kw.pop("args", {})}
    return _o(id, name, "Text", args=args, **kw)


def _number(id: str, name: str, color: str, link: dict, size: int = 34, places: int = 2) -> dict:
    return _o(id, name, "DecimalNumber", args={"*": "0", "num_decimal_places": str(places), "font_size": str(size), "color": color}, link=link)


def _clip(kind: str, start: float, duration: float = 0, **kw) -> dict:
    return {"kind": kind, "start": start, "duration": duration, **kw}


def _anim(cls: str, target: str, start: float, duration: float = 1, **kw) -> dict:
    return _clip("anim", start, duration, cls=cls, target=target, args=kw.pop("args", {}), **kw)


def _animate(target: str, chain: str, start: float, duration: float, rate: str | None = None) -> dict:
    return _clip("anim", start, duration, cls="animate", target=target, chain=chain, args={"rate_func": rate} if rate else {})


def _doc(scene: str, objects: list[dict], clips: list[dict], end: float) -> dict:
    doc = new_project()
    doc["scene"]["name"] = scene
    doc["objects"] = objects
    clips = [*clips, _clip("hold", 0, end)]  # the video's length
    for i, c in enumerate(clips):
        c["id"] = f"c{i + 1}"
    doc["tracks"] = pack_tracks(clips)
    doc["clips"] = clips
    return doc


def derivative() -> dict:
    """A tangent slides along a cubic; its slope is plotted on the right and traces the derivative."""
    left = {"x_range": "[-3, 3, 1]", "y_range": "[-3, 3, 1]", "x_length": "6.2", "y_length": "5.2", "tips": "False",
            "axis_config": '{"color": GREY_B}'}
    right = {**left, "y_range": "[-2, 4, 1]"}
    objects = [
        _o("x0", "x0", "ValueTracker", args={"*": "-2.4"}, param={"min": -2.5, "max": 2.5, "step": 0.05}),
        _text("title", "title", "The derivative is a slope", 40, pos=[0, 3.45]),
        _o("ax", "axes", "Axes", args=left, pos=[-3.45, -0.45]),
        _o("ax2", "slope_axes", "Axes", args=right, pos=[3.45, -0.45]),
        _text("lf", "f_label", "f(x)", 28, "BLUE", pos=[-3.45, 2.6]),
        _text("ld", "slope_label", "slope of the tangent", 28, "GREEN", pos=[3.45, 2.6]),
        _o("f", "curve", "axes.plot", args={"color": "BLUE", "stroke_width": "5"},
           link={"kind": "graph", "axes": "ax", "expr": "y = 0.25x^3 - x", "x_min": -2.8, "x_max": 2.8}),
        _o("tan", "tangent", "Line", args={"color": "GREEN", "stroke_width": "5"},
           link={"kind": "tangent", "graph": "f", "x": "x0", "length": "2.4"}),
        _o("P", "P", "Dot", args={"color": "YELLOW", "radius": "0.1"}, link={"kind": "on_graph", "graph": "f", "x": "x0"}),
        _number("slope", "slope", "GREEN", {"kind": "measure", "what": "slope", "of": "tan", "offset": [0, 0.75]}),
        _o("d", "derivative", "axes.plot", args={"color": "GREEN", "stroke_opacity": "0.45", "stroke_width": "3"},
           link={"kind": "graph", "axes": "ax2", "expr": "y = 0.75x^2 - 1", "x_min": -2.5, "x_max": 2.5}),
        _o("D", "D", "Dot", args={"color": "GREEN", "radius": "0.1"},
           link={"kind": "coords", "axes": "ax2", "x": "x0", "y": "0.75*x0^2 - 1"}),
        # The slope graph drawn up to x0, so it grows as D moves (an updater: it depends only on x0's value).
        _o("trace", "trace", "slope_axes.plot", args={"function": "lambda x: 0.75 * x**2 - 1", "x_range": "[-2.5, -2.4]", "color": "GREEN"},
           chain=".add_updater(lambda m: m.become(slope_axes.plot(lambda x: 0.75 * x**2 - 1, "
                 "x_range=[-2.5, max(-2.45, x0.get_value())], color=GREEN, stroke_width=5)))"),
    ]
    clips = [
        _anim("Write", "title", 0, 1),
        _anim("Create", "axes", 0.5, 1), _anim("Create", "slope_axes", 0.5, 1),
        _anim("FadeIn", "f_label", 1, 0.6), _anim("FadeIn", "slope_label", 1, 0.6),
        _anim("Create", "curve", 1.2, 1.3),
        _anim("GrowFromCenter", "tangent", 2.6, 0.6), _anim("FadeIn", "P", 2.6, 0.4),
        _anim("FadeIn", "slope", 3, 0.4), _anim("FadeIn", "D", 3, 0.4),
        _clip("add", 3.6, targets=["trace"]),
        _animate("x0", ".set_value(2.4)", 3.6, 6),
        _anim("Create", "derivative", 9.8, 1.5),
    ]
    return _doc("Derivative", objects, clips, 12)


def riemann() -> dict:
    """Rectangles under a curve get thinner and fill the area."""
    objects = [
        _o("w", "width", "ValueTracker", args={"*": "1"}, param={"min": 0.05, "max": 1, "step": 0.01}),
        _text("title", "title", "Area under a curve", 40, pos=[0, 3.45]),
        _o("ax", "axes", "Axes", args={"x_range": "[0, 4, 1]", "y_range": "[0, 5, 1]", "x_length": "8", "y_length": "5",
                                        "tips": "False", "axis_config": '{"color": GREY_B}'}, pos=[-1.4, -0.6]),
        _o("f", "curve", "axes.plot", args={"color": "YELLOW", "stroke_width": "5"},
           link={"kind": "graph", "axes": "ax", "expr": "y = 0.25x^2 + 0.5", "x_min": 0, "x_max": 4}),
        _o("r", "rectangles", "axes.get_riemann_rectangles", args={"fill_opacity": "0.7", "stroke_width": "1"},
           link={"kind": "riemann", "graph": "f", "a": "0.5", "b": "3.5", "dx": "width", "sample": "left"}),
        # The exact area over the same interval: never shown, it anchors and computes the area readout.
        _o("ar", "exact_area", "axes.get_area", args={"opacity": "0"}, link={"kind": "area", "graph": "f", "a": "0.5", "b": "3.5"}),
        _text("lw", "width_label", "rectangle width", 26, "BLUE", pos=[4.6, 1.2]),
        {**_number("vw", "width_value", "BLUE", {"kind": "measure", "what": "value", "expr": "width"}), "pos": [4.6, 0.6]},
        _text("la", "area_label", "area under the curve", 26, "YELLOW", pos=[4.6, -0.6]),
        _number("va", "area_value", "YELLOW", {"kind": "measure", "what": "integral", "of": "ar", "offset": [6.0, 0.1]}, places=3),
    ]
    clips = [
        _anim("Write", "title", 0, 1),
        _anim("Create", "axes", 0.5, 1),
        _anim("Create", "curve", 1.2, 1.2),
        _anim("FadeIn", "rectangles", 2.6, 1),
        _anim("FadeIn", "width_label", 3, 0.5), _anim("FadeIn", "width_value", 3, 0.5),
        _anim("FadeIn", "area_label", 3.4, 0.5), _anim("FadeIn", "area_value", 3.4, 0.5),
        _animate("width", ".set_value(0.05)", 4.5, 5, "smooth"),
    ]
    return _doc("RiemannSums", objects, clips, 11)


def orthocenter() -> dict:
    """The three altitudes of a triangle always meet in one point, wherever the vertices go."""
    def seg(id, name, a, b):
        return _o(id, name, "Line", args={"color": "BLUE_B", "stroke_width": "5"}, link={"kind": "segment", "a": a, "b": b})

    def altitude(id, name, line, through):
        return _o(id, name, "DashedLine", args={"color": "YELLOW", "stroke_width": "3"},
                  link={"kind": "perpendicular", "line": line, "through": through, "mode": "foot"})

    def label(id, name, text, to, offset, color="WHITE"):
        return _text(id, name, text, 30, color, link={"kind": "attach", "to": to, "offset": offset})

    objects = [
        _text("title", "title", "Three altitudes, one point", 40, pos=[0, 3.45]),
        _o("A", "A", "Dot", pos=[-3.2, -2.2]),
        _o("B", "B", "Dot", pos=[3.4, -2.2]),
        _o("C", "C", "Dot", pos=[0.6, 2.1]),
        seg("ab", "side_c", "A", "B"), seg("bc", "side_a", "B", "C"), seg("ca", "side_b", "C", "A"),
        altitude("hc", "altitude_c", "ab", "C"), altitude("ha", "altitude_a", "bc", "A"), altitude("hb", "altitude_b", "ca", "B"),
        _o("H", "H", "Dot", args={"color": "RED", "radius": "0.11"}, link={"kind": "intersection", "a": "hc", "b": "ha"}),
        label("la", "label_A", "A", "A", [-0.35, -0.3]), label("lb", "label_B", "B", "B", [0.35, -0.3]),
        label("lc", "label_C", "C", "C", [0, 0.4]), label("lh", "label_H", "H", "H", [0.35, 0.3], "RED"),
    ]
    clips = [
        _anim("Write", "title", 0, 1),
        _clip("add", 0.6, targets=["A", "B", "C"]),
        _anim("Create", "side_c", 0.6, 0.8), _anim("Create", "side_a", 0.9, 0.8), _anim("Create", "side_b", 1.2, 0.8),
        _anim("FadeIn", "label_A", 1.2, 0.5), _anim("FadeIn", "label_B", 1.2, 0.5), _anim("FadeIn", "label_C", 1.2, 0.5),
        _anim("Create", "altitude_c", 2.2, 0.8), _anim("Create", "altitude_a", 3, 0.8), _anim("Create", "altitude_b", 3.8, 0.8),
        _anim("GrowFromCenter", "H", 4.7, 0.5), _anim("FadeIn", "label_H", 4.9, 0.4),
        _animate("C", ".move_to(np.array([-2.2, 2.4, 0]))", 5.6, 2),
        _animate("B", ".move_to(np.array([2.4, -1.2, 0]))", 7.8, 1.6),
        _animate("C", ".move_to(np.array([1.8, 1.4, 0]))", 9.6, 2),
    ]
    return _doc("Orthocenter", objects, clips, 12.5)


def coupling() -> dict:
    """A midpoint follows its endpoints, is uncoupled to move on its own, then glides back into place."""
    def caption(id, name, text, color):
        return _text(id, name, text, 30, color, pos=[0, -3.35])

    objects = [
        _text("title", "title", "Couple, uncouple, couple again", 40, pos=[0, 3.45]),
        _o("A", "A", "Dot", args={"radius": "0.1"}, pos=[-3.5, -1]),
        _o("B", "B", "Dot", args={"radius": "0.1"}, pos=[3.5, -1]),
        _o("ab", "segment", "Line", args={"color": "BLUE_B", "stroke_width": "5"}, link={"kind": "segment", "a": "A", "b": "B"}),
        _o("M", "M", "Dot", args={"color": "YELLOW", "radius": "0.13"}, link={"kind": "midpoint", "a": "A", "b": "B"}),
        _text("lm", "label_M", "M", 30, "YELLOW", link={"kind": "attach", "to": "M", "offset": [0, 0.45]}),
        _text("la", "label_A", "A", 30, link={"kind": "attach", "to": "A", "offset": [-0.4, 0]}),
        _text("lb", "label_B", "B", 30, link={"kind": "attach", "to": "B", "offset": [0.4, 0]}),
        caption("c1", "caption_coupled", "Coupled: M stays the midpoint of A and B", "GREEN"),
        caption("c2", "caption_uncoupled", "Uncoupled: M moves on its own", "ORANGE"),
        caption("c3", "caption_again", "Coupled again: M glides back to the midpoint", "GREEN"),
    ]
    clips = [
        _anim("Write", "title", 0, 1),
        _clip("add", 0.6, targets=["A", "B", "label_A", "label_B"]),
        _anim("Create", "segment", 0.6, 0.8),
        _anim("GrowFromCenter", "M", 1.4, 0.4), _anim("FadeIn", "label_M", 1.5, 0.4),
        _anim("FadeIn", "caption_coupled", 1.6, 0.5),
        _animate("B", ".shift(UP * 2.5)", 2.4, 1.4), _animate("A", ".shift(RIGHT * 1.5)", 3.9, 1.2),
        _clip("uncouple", 5.4, targets=["M"]),
        _anim("FadeOut", "caption_coupled", 5.4, 0.4), _anim("FadeIn", "caption_uncoupled", 5.6, 0.4),
        _animate("M", ".shift(UP * 1.6 + RIGHT * 1.5)", 5.8, 1.2),
        _animate("B", ".shift(DOWN * 2.5)", 7.2, 1.2),
        _clip("couple", 8.8, 1.4, targets=["M"]),
        _anim("FadeOut", "caption_uncoupled", 8.6, 0.4), _anim("FadeIn", "caption_again", 8.8, 0.4),
    ]
    return _doc("Coupling", objects, clips, 11.5)


SAMPLES = [
    ("derivative", "The derivative is a slope", "A tangent slides along a curve while its slope traces the derivative on the right.", derivative),
    ("riemann", "Riemann sums", "Rectangles under a curve get thinner until they fill the area; the area is computed live.", riemann),
    ("orthocenter", "Altitudes of a triangle", "The three altitudes meet in one point that follows the vertices wherever they go.", orthocenter),
    ("coupling", "Couple and uncouple", "A midpoint follows its endpoints, is uncoupled to move freely, then glides back into place.", coupling),
]


def sample_list() -> list[dict]:
    """Samples for the Home screen: id, name, description, length (seconds) and a thumbnail (data URL)."""
    out = []
    for sid, name, description, build in SAMPLES:
        doc = build()
        thumb = THUMBS / f"{sid}.jpg"
        out.append({
            "id": sid, "name": name, "description": description,
            "duration": max(float(c["start"]) + float(c["duration"]) for c in doc["clips"]),
            "thumbnail": "data:image/jpeg;base64," + base64.b64encode(thumb.read_bytes()).decode() if thumb.is_file() else None,
        })
    return out


def sample(sid: str) -> dict:
    for s, _name, _description, build in SAMPLES:
        if s == sid:
            return copy.deepcopy(build())
    raise KeyError(f"No sample {sid!r}")
