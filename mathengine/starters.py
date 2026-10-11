"""Built-in reusable constructions (templates).

A template is a self-contained set of objects whose links refer only to each
other (template-local ids), an optional ``timeline`` (manim statements inserted
at the playhead, targets by template-local *name*), and ``inputs``: the
parameters, labels, colors and visibility switches offered when inserting it.

Inserting a template (frontend ``insertTemplate``) gives every object a new id
and a unique name, so instances are independent of each other. An instance is
either an independent copy, or linked to its template: linked instances record
``instance = {template, instance, local}`` on each object and are regenerated
(keeping their ids, names and input values) when the template is updated.

Input kinds:

* ``param``: the initial value of a ValueTracker (``targets`` = that object).
* ``text``: a label's text, written to each target's ``*`` argument as a raw string.
* ``color``: a color written to ``key`` (default ``color``) of every target.
* ``visible``: whether the targets are shown (hidden objects are left out of the
  timeline but still constructed, so things built from them keep working).
"""

from __future__ import annotations

from .timeline import add, anim, animate, group, number, play, wait


def _o(id: str, name: str, ctor: str, **kw) -> dict:
    return {"id": id, "name": name, "ctor": ctor, "args": kw.pop("args", {}), "pos": kw.pop("pos", None),
            "chain": kw.pop("chain", ""), **kw}


def _seg(id, name, a, b, color="WHITE", **kw):
    return _o(id, name, "Line", args={"color": color, **kw.pop("args", {})}, link={"kind": "segment", "a": a, "b": b}, **kw)


def _label(id, name, tex, to, offset, **kw):
    return _o(id, name, "MathTex", args={"*": f'r"{tex}"', **kw.pop("args", {})}, link={"kind": "attach", "to": to, "offset": offset}, **kw)


def labeled_triangle() -> dict:
    return {
        "id": "starter.labeled_triangle",
        "name": "Labeled triangle",
        "description": "Three free vertices, the sides between them, and vertex labels that stay attached when you drag the points.",
        "objects": [
            _o("A", "A", "Dot", pos=[-2.5, -1.5]),
            _o("B", "B", "Dot", pos=[2.5, -1.5]),
            _o("C", "C", "Dot", pos=[0.5, 1.75]),
            _seg("ab", "side_c", "A", "B", "BLUE"),
            _seg("bc", "side_a", "B", "C", "BLUE"),
            _seg("ca", "side_b", "C", "A", "BLUE"),
            _label("la", "label_A", "A", "A", [-0.35, -0.35]),
            _label("lb", "label_B", "B", "B", [0.35, -0.35]),
            _label("lc", "label_C", "C", "C", [0, 0.4]),
        ],
        "timeline": number([
            add("A", "B", "C"),
            play(anim("Create", "side_c"), anim("Create", "side_a"), anim("Create", "side_b")),
            play(anim("Write", "label_A"), anim("Write", "label_B"), anim("Write", "label_C"), run_time=0.6),
        ]),
        "inputs": [
            {"id": "ta", "kind": "text", "label": "Label A", "default": "A", "targets": [{"object": "la"}]},
            {"id": "tb", "kind": "text", "label": "Label B", "default": "B", "targets": [{"object": "lb"}]},
            {"id": "tc", "kind": "text", "label": "Label C", "default": "C", "targets": [{"object": "lc"}]},
            {"id": "col", "kind": "color", "label": "Side color", "default": "BLUE",
             "targets": [{"object": "ab", "key": "color"}, {"object": "bc", "key": "color"}, {"object": "ca", "key": "color"}]},
            {"id": "vis", "kind": "visible", "label": "Show labels", "default": "True", "targets": [{"object": "la"}, {"object": "lb"}, {"object": "lc"}]},
        ],
    }


def unit_circle() -> dict:
    axes_args = {"x_range": "[-1.5, 1.5, 0.5]", "y_range": "[-1.5, 1.5, 0.5]", "x_length": "6", "y_length": "6",
                 "axis_config": '{"include_tip": False}'}
    return {
        "id": "starter.unit_circle",
        "name": "Unit circle",
        "description": "A point at angle θ on the unit circle with its radius, angle marker, and the cos θ / sin θ projections.",
        "objects": [
            _o("theta", "theta", "ValueTracker", args={"*": "PI / 4"}, param={"min": 0, "max": 6.2832, "step": 0.01}),
            _o("ax", "axes", "Axes", args=axes_args),
            _o("O", "O", "Dot", args={"radius": "0.05"}, link={"kind": "coords", "axes": "ax", "x": "0", "y": "0"}),
            _o("U", "U", "Dot", args={"radius": "0.05"}, link={"kind": "coords", "axes": "ax", "x": "1", "y": "0"}),
            _o("circ", "circle", "Circle", args={"color": "BLUE"}, link={"kind": "circle2", "a": "O", "b": "U"}),
            _o("P", "P", "Dot", args={"color": "YELLOW"}, link={"kind": "on_circle", "circle": "circ", "angle": "theta"}),
            _o("F", "F", "Dot", args={"radius": "0.04"}, link={"kind": "coords", "axes": "ax", "x": "cos(theta)", "y": "0"}),
            _seg("ou", "base", "O", "U", "GREY"),
            _seg("op", "radius", "O", "P", "YELLOW"),
            _o("pf", "sine", "DashedLine", args={"color": "GREEN"}, link={"kind": "segment", "a": "P", "b": "F"}),
            _o("of", "cosine", "Line", args={"color": "RED", "stroke_width": "6"}, link={"kind": "segment", "a": "O", "b": "F"}),
            _o("ang", "angle", "Angle", link={"kind": "angle", "l1": "ou", "l2": "op", "radius": "0.4"}),
            _label("lt", "theta_label", "\\theta", "ang", [0.25, 0.15]),
            _o("vc", "cos_value", "DecimalNumber", args={"*": "0", "color": "RED", "font_size": "30"},
               link={"kind": "measure", "what": "value", "expr": "cos(theta)", "of": "of", "offset": [0, -0.35]}),
            _o("vs", "sin_value", "DecimalNumber", args={"*": "0", "color": "GREEN", "font_size": "30"},
               link={"kind": "measure", "what": "value", "expr": "sin(theta)", "of": "pf", "offset": [0.55, 0]}),
        ],
        "timeline": number([
            play(group("LaggedStart", anim("Create", "axes"), anim("Create", "circle"), lag_ratio=0.5)),
            add("O", "P", "F", "radius", "sine", "cosine", "angle", "theta_label", "cos_value", "sin_value"),
            wait(0.5),
            play(animate("theta", ".set_value(PI / 4 + TAU)", rate_func="linear"), run_time=4),
        ]),
        "inputs": [
            {"id": "th", "kind": "param", "label": "θ (radians)", "default": "PI / 4", "targets": [{"object": "theta"}]},
            {"id": "cc", "kind": "color", "label": "Circle color", "default": "BLUE", "targets": [{"object": "circ", "key": "color"}]},
            {"id": "vv", "kind": "visible", "label": "Show values", "default": "True", "targets": [{"object": "vc"}, {"object": "vs"}]},
        ],
    }


def number_line() -> dict:
    return {
        "id": "starter.number_line",
        "name": "Number line",
        "description": "A number line with a point at a parameter value and a live label showing it.",
        "objects": [
            _o("x", "x", "ValueTracker", args={"*": "1.5"}, param={"min": -5, "max": 5, "step": 0.1}),
            _o("nl", "number_line", "NumberLine", args={"x_range": "[-5, 5, 1]", "length": "10", "include_numbers": "True"}),
            _o("pt", "point", "Dot", args={"color": "YELLOW"}, link={"kind": "coords", "axes": "nl", "x": "x"}),
            _o("val", "value", "DecimalNumber", args={"*": "0", "color": "YELLOW"},
               link={"kind": "measure", "what": "value", "expr": "x", "of": "pt", "offset": [0, 0.5]}),
        ],
        "timeline": number([
            play(anim("Create", "number_line")),
            play(anim("FadeIn", "point"), anim("FadeIn", "value"), run_time=0.5),
            play(animate("x", ".set_value(-2)"), run_time=2),
        ]),
        "inputs": [
            {"id": "xv", "kind": "param", "label": "Start value", "default": "1.5", "targets": [{"object": "x"}]},
            {"id": "pc", "kind": "color", "label": "Point color", "default": "YELLOW", "targets": [{"object": "pt", "key": "color"}, {"object": "val", "key": "color"}]},
        ],
    }


def secant_to_tangent() -> dict:
    return {
        "id": "starter.secant_tangent",
        "name": "Secant to tangent",
        "description": "Secant through P and Q on a curve; animating h to 0 turns it into the tangent at P. Slopes are computed numerically.",
        "objects": [
            _o("x0", "x0", "ValueTracker", args={"*": "1"}, param={"min": -2.5, "max": 2.5, "step": 0.05}),
            _o("h", "h", "ValueTracker", args={"*": "1.5"}, param={"min": 0.01, "max": 2, "step": 0.01}),
            _o("ax", "axes", "Axes", args={"x_range": "[-3, 3, 1]", "y_range": "[-2, 4, 1]", "x_length": "8", "y_length": "6"}),
            _o("g", "curve", "axes.plot", args={"color": "BLUE"},
               link={"kind": "graph", "axes": "ax", "expr": "y = 0.2x^3 - 0.5x + 1", "x_min": -3, "x_max": 3}),
            _o("P", "P", "Dot", link={"kind": "on_graph", "graph": "g", "x": "x0"}),
            _o("Q", "Q", "Dot", args={"color": "YELLOW"}, link={"kind": "on_graph", "graph": "g", "x": "x0 + h"}),
            _o("sec", "secant", "Line", args={"color": "YELLOW"}, link={"kind": "secant", "graph": "g", "x": "x0", "dx": "h", "length": "1.5"}),
            _o("tan", "tangent", "DashedLine", args={"color": "GREEN"}, link={"kind": "tangent", "graph": "g", "x": "x0", "length": "5"}),
            _o("ss", "secant_slope", "DecimalNumber", args={"*": "0", "color": "YELLOW", "font_size": "32"},
               link={"kind": "measure", "what": "slope", "of": "sec", "offset": [1.2, 0.6]}),
            _o("ts", "tangent_slope", "DecimalNumber", args={"*": "0", "color": "GREEN", "font_size": "32"},
               link={"kind": "measure", "what": "slope", "of": "tan", "offset": [1.2, -0.4]}),
        ],
        "timeline": number([
            play(group("LaggedStart", anim("Create", "axes"), anim("Create", "curve"), lag_ratio=0.5)),
            add("P", "Q", "secant", "secant_slope"),
            play(anim("Create", "tangent"), run_time=0.5),
            add("tangent_slope"),
            wait(0.5),
            play(animate("h", ".set_value(0.01)"), run_time=3),
        ]),
        "inputs": [
            {"id": "px", "kind": "param", "label": "x at P", "default": "1", "targets": [{"object": "x0"}]},
            {"id": "ph", "kind": "param", "label": "Start h", "default": "1.5", "targets": [{"object": "h"}]},
            {"id": "cv", "kind": "color", "label": "Curve color", "default": "BLUE", "targets": [{"object": "g", "key": "color"}]},
            {"id": "vt", "kind": "visible", "label": "Show tangent", "default": "True", "targets": [{"object": "tan"}, {"object": "ts"}]},
        ],
    }


def starters() -> list[dict]:
    out = [labeled_triangle(), unit_circle(), number_line(), secant_to_tangent()]
    for t in out:
        t["builtin"] = True
    return out


def as_document(template: dict) -> dict:
    """A standalone project containing one instance of ``template`` with its default inputs (for tests and previews)."""
    import copy

    from .project import new_project, upgrade_template

    doc = new_project()
    template = upgrade_template(template)
    doc["objects"] = copy.deepcopy(template["objects"])
    doc["timeline"] = copy.deepcopy(template.get("timeline") or [])
    return doc
