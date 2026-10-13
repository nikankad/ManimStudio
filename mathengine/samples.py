"""Sample projects shown on the Home screen.

Each sample is a complete project built from the editor's own features (constructions, parameters,
timeline statements), so opening one shows how it was made. They only use Text for words, so they work
without LaTeX. Thumbnails live next to this file (``samples/<id>.jpg``, made by
scripts/sample_thumbnails.py).
"""

from __future__ import annotations

import base64
import copy
import functools
from pathlib import Path

from .project import new_project
from .timeline import add as _add, anim as _a, animate as _animate, group as _group, number, play as _play, switch as _switch, wait as _wait

THUMBS = Path(__file__).parent / "samples"


def _o(id: str, name: str, ctor: str, **kw) -> dict:
    return {"id": id, "name": name, "ctor": ctor, "args": kw.pop("args", {}), "pos": kw.pop("pos", None),
            "chain": kw.pop("chain", ""), **kw}


def _text(id: str, name: str, text: str, size: int = 32, color: str | None = None, **kw) -> dict:
    args = {"*": repr(text), "font_size": str(size), **({"color": color} if color else {}), **kw.pop("args", {})}
    return _o(id, name, "Text", args=args, **kw)


def _number(id: str, name: str, color: str, link: dict, size: int = 34, places: int = 2) -> dict:
    return _o(id, name, "DecimalNumber", args={"*": "0", "num_decimal_places": str(places), "font_size": str(size), "color": color}, link=link)


def _doc(scene: str, objects: list[dict], steps: list[dict]) -> dict:
    doc = new_project()
    doc["scene"]["name"] = scene
    doc["objects"] = objects
    doc["timeline"] = number(steps)
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
    steps = [
        _play(_a("Write", "title")),
        _play(_group("LaggedStart", _a("Create", "axes"), _a("Create", "slope_axes"), _a("FadeIn", "f_label"),
                     _a("FadeIn", "slope_label"), lag_ratio=0.25)),
        _play(_a("Create", "curve"), run_time=1.3),
        _play(_a("GrowFromCenter", "tangent"), _a("FadeIn", "P"), run_time=0.6),
        _play(_a("FadeIn", "slope"), _a("FadeIn", "D"), run_time=0.4),
        _add("trace"),
        _play(_animate("x0", ".set_value(2.4)"), run_time=6),
        _play(_a("Create", "derivative"), run_time=1.5),
        _wait(),
    ]
    return _doc("Derivative", objects, steps)


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
    steps = [
        _play(_a("Write", "title")),
        _play(_a("Create", "axes")),
        _play(_a("Create", "curve"), run_time=1.2),
        _play(_a("FadeIn", "rectangles")),
        _play(_group("LaggedStart", _a("FadeIn", "width_label"), _a("FadeIn", "width_value"), _a("FadeIn", "area_label"),
                     _a("FadeIn", "area_value"), lag_ratio=0.3)),
        _play(_animate("width", ".set_value(0.05)"), run_time=5),
        _wait(),
    ]
    return _doc("RiemannSums", objects, steps)


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
    steps = [
        _play(_a("Write", "title")),
        _add("A", "B", "C"),
        _play(_group("LaggedStart", _a("Create", "side_c"), _a("Create", "side_a"), _a("Create", "side_b"), lag_ratio=0.4),
              _a("FadeIn", "label_A"), _a("FadeIn", "label_B"), _a("FadeIn", "label_C")),
        _play(_group("Succession", _a("Create", "altitude_c"), _a("Create", "altitude_a"), _a("Create", "altitude_b")),
              run_time=2.4),
        _play(_a("GrowFromCenter", "H"), _a("FadeIn", "label_H"), run_time=0.5),
        _play(_animate("C", ".move_to(np.array([-2.2, 2.4, 0]))"), run_time=2),
        _play(_animate("B", ".move_to(np.array([2.4, -1.2, 0]))"), run_time=1.6),
        _play(_animate("C", ".move_to(np.array([1.8, 1.4, 0]))"), run_time=2),
        _wait(0.5),
    ]
    return _doc("Orthocenter", objects, steps)


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
    steps = [
        _play(_a("Write", "title")),
        _add("A", "B", "label_A", "label_B"),
        _play(_a("Create", "segment"), run_time=0.8),
        _play(_a("GrowFromCenter", "M"), _a("FadeIn", "label_M"), _a("FadeIn", "caption_coupled"), run_time=0.5),
        _play(_animate("B", ".shift(UP * 2.5)"), run_time=1.4),
        _play(_animate("A", ".shift(RIGHT * 1.5)"), run_time=1.2),
        _switch("uncouple", "M"),
        _play(_a("FadeOut", "caption_coupled"), _a("FadeIn", "caption_uncoupled"), run_time=0.5),
        _play(_animate("M", ".shift(UP * 1.6 + RIGHT * 1.5)"), run_time=1.2),
        _play(_animate("B", ".shift(DOWN * 2.5)"), run_time=1.2),
        _play(_a("FadeOut", "caption_uncoupled"), _a("FadeIn", "caption_again"), run_time=0.5),
        _switch("couple", "M", duration=1.4),
        _wait(),
    ]
    return _doc("Coupling", objects, steps)



def storyboard_derivative() -> dict:
    """A complete explanation authored as four beats, with an explicit tangent at the end."""
    from .starters import secant_to_tangent

    objects = secant_to_tangent()["objects"]
    objects.insert(0, _text("title", "title", "From a secant to a tangent", 38, pos=[0, 3.45]))
    steps = [
        _play(_a("Write", "title"),
              {"id": "reveal_graph", "cls": "LaggedStart", "target": "", "args": {"lag_ratio": "0.4"},
               "anims": [_a("Create", "axes"), _a("Create", "curve")]}, run_time=2),
        _wait(0.5),
        _play(_a("GrowFromCenter", "P"), _a("GrowFromCenter", "Q"), _a("Create", "secant"),
              _a("FadeIn", "secant_slope"), run_time=1.25),
        _wait(1),
        _play(_animate("h", ".set_value(0.1)"), run_time=3),
        _wait(0.5),
        _play(_a("Create", "tangent"), _a("FadeIn", "tangent_slope"), run_time=0.75),
        _wait(1.75),
    ]
    doc = _doc("StoryboardDerivative", objects, steps)
    titles = ["Introduce the curve", "Construct a secant", "Shrink the separation", "Explain the tangent"]
    scripts = [
        "Start with a curve. We want to understand its slope at one point.",
        "These two points determine a secant. Its slope measures the average rate of change.",
        "Bring Q closer to P. As the separation shrinks, watch the secant and its slope change together.",
        "The green tangent shows the limiting slope at P. We stop h above zero and construct the tangent explicitly.",
    ]
    doc["storyboard"] = {"beats": [
        {"id": f"explain_{i}", "title": title, "steps": [s["id"] for s in doc["timeline"][2*i:2*i+2]],
         "script": scripts[i], "cues": ([{"id": "closer", "phrase": "Bring Q closer to P", "step": doc["timeline"][4]["id"],
                                         "edge": "start", "offset": 0}] if i == 2 else [])}
        for i, title in enumerate(titles)
    ]}
    return doc


SAMPLES = [
    ("storyboard", "From secant to tangent", "Four explanation beats with a parameter sweep, live relationships and narration cues.", storyboard_derivative),
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
            "duration": _duration(sid),
            "thumbnail": "data:image/jpeg;base64," + base64.b64encode(thumb.read_bytes()).decode() if thumb.is_file() else None,
        })
    return out


@functools.lru_cache(maxsize=None)
def _duration(sid: str) -> float:
    """The sample's length as manim plays it (measured once)."""
    from . import runtime

    return round(runtime.run(sample(sid), None, render=False).duration, 2)


def sample(sid: str) -> dict:
    for s, _name, _description, build in SAMPLES:
        if s == sid:
            return copy.deepcopy(build())
    raise KeyError(f"No sample {sid!r}")
