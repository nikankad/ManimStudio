"""Constructions compile, stay attached while things animate, and report broken links."""

import math
import subprocess
import sys

import pytest

from conftest import add_all, doc, needs_latex, obj
from mathengine import codegen, runtime


def run(d, t):
    r = runtime.run(d, t, render=False)
    assert r.error is None, r.error and r.error["trace"]
    return r, {o["name"]: o for o in r.objects}


def two_points(**more):
    return [obj("oA", "A", "Dot", pos=[-2, -1]), obj("oB", "B", "Dot", pos=[2, 1])]


def test_segment_and_midpoint_follow_animation():
    d = doc(two_points() + [
        obj("oS", "seg", "Line", args={"color": "BLUE"}, link={"kind": "segment", "a": "oA", "b": "oB"}),
        obj("oM", "mid", "Dot", link={"kind": "midpoint", "a": "oA", "b": "oB"}),
        obj("oN", "mid2", "Dot", link={"kind": "midpoint", "a": "oS"}),
    ])
    d["clips"] = [add_all(d), {"id": "c2", "kind": "anim", "track": "t2", "start": 0, "duration": 1, "cls": "animate",
                               "target": "B", "args": {"rate_func": "linear"}, "chain": ".shift(UP * 2)"}]
    r, o = run(d, 0.5)
    assert o["seg"]["geom"]["end"] == pytest.approx([2, 2])
    assert o["mid"]["center"] == pytest.approx([0, 0.5])
    assert o["mid2"]["center"] == pytest.approx([0, 0.5])
    r, o = run(d, 5)
    assert o["mid"]["center"] == pytest.approx([0, 1])
    assert r.diagnostics == []


def test_style_animation_is_not_overwritten_by_redraw():
    d = doc(two_points() + [obj("oS", "seg", "Line", args={"color": "BLUE"}, link={"kind": "segment", "a": "oA", "b": "oB"})])
    d["clips"] = [add_all(d),
                  {"id": "c2", "kind": "anim", "track": "t2", "start": 0, "duration": 1, "cls": "animate", "target": "seg", "args": {}, "chain": ".set_color(RED)"},
                  {"id": "c3", "kind": "anim", "track": "t3", "start": 1, "duration": 1, "cls": "animate", "target": "A", "args": {}, "chain": ".shift(LEFT)"}]
    gen = codegen.generate(d)
    ns = {}
    from manim import tempconfig, RED

    with tempconfig({"dry_run": True, "disable_caching": True, "verbosity": "ERROR"}):
        exec(compile(gen.source, "scene", "exec"), ns)
        scene = ns["MainScene"]()
        scene.render()
        seg = next(m for m in scene.mobjects if type(m).__name__ == "Line")
        assert seg.get_color().to_hex().upper() == RED.to_hex().upper()
        assert seg.get_start() == pytest.approx([-3, -1, 0])


def test_attached_label_offset_and_equation_terms():
    d = doc([obj("oA", "A", "Dot", pos=[1, 1]),
             obj("oL", "lab", "Text", args={"*": '"A"'}, link={"kind": "attach", "to": "oA", "offset": [0.3, 0.4]})])
    d["clips"] = [add_all(d)]
    r, o = run(d, 0)
    assert o["lab"]["center"] == pytest.approx([1.3, 1.4], abs=1e-6)


def test_graph_constructions_follow_parameter():
    d = doc([
        obj("oa", "a", "ValueTracker", args={"*": "1"}, param={"min": 0, "max": 3, "step": 0.1}),
        obj("ox", "axes", "Axes", args={"x_range": "[-4, 4, 1]", "y_range": "[-3, 3, 1]", "x_length": "8", "y_length": "6"}),
        obj("og", "graph", "axes.plot", link={"kind": "graph", "axes": "ox", "expr": "y = a*x^2 - 1", "x_min": -3, "x_max": 3}),
        obj("op", "P", "Dot", link={"kind": "on_graph", "graph": "og", "x": "a"}),
        obj("ot", "tan", "Line", link={"kind": "tangent", "graph": "og", "x": "1", "length": "2"}),
        obj("os", "sec", "Line", link={"kind": "secant", "graph": "og", "x": "0", "dx": "1"}),
        obj("ar", "area", "axes.get_area", link={"kind": "area", "graph": "og", "a": "0", "b": "1"}),
        obj("ri", "rects", "axes.get_riemann_rectangles", link={"kind": "riemann", "graph": "og", "a": "0", "b": "2", "dx": "0.5"}),
        obj("oi", "integ", "DecimalNumber", args={"*": "0"}, link={"kind": "measure", "what": "integral", "of": "ar"}),
        obj("ok", "slope", "DecimalNumber", args={"*": "0"}, link={"kind": "measure", "what": "slope", "of": "ot"}),
        obj("ov", "aval", "DecimalNumber", args={"*": "0"}, pos=[3, 3], link={"kind": "measure", "what": "value", "expr": "2*a"}),
    ])
    d["clips"] = [add_all(d), {"id": "c2", "kind": "anim", "track": "t2", "start": 0, "duration": 2, "cls": "animate",
                               "target": "a", "args": {"rate_func": "linear"}, "chain": ".set_value(2)"}]
    r, o = run(d, 1.0)
    assert r.values["a"] == pytest.approx(1.5)
    # P sits on y = a x^2 - 1 at x = a (axes are 1 unit per unit, centered).
    assert o["P"]["center"] == pytest.approx([1.5, 1.5 * 1.5 ** 2 - 1], abs=1e-4)
    assert o["axes"]["axes"]["ux"] == pytest.approx([1, 0])
    assert len(o["rects"]["box"]) == 4
    gen = codegen.generate(d)
    assert "Geometry.integral(graph, 0, 1)" in gen.source and "Geometry.slope_at(graph, 1)" in gen.source
    assert o["aval"]["center"] == pytest.approx([3, 3], abs=0.05)  # set_value keeps the left edge fixed
    # Exact values through the generated helpers:
    ns = {}
    exec(compile(gen.source, "s", "exec"), ns)
    import numpy as np

    g = type("G", (), {"underlying_function": staticmethod(lambda x: 1.5 * x ** 2 - 1)})()
    assert ns["Geometry"].integral(g, 0, 1) == pytest.approx(0.5 - 1, abs=1e-6)
    assert ns["Geometry"].slope_at(g, 1) == pytest.approx(3.0, abs=1e-5)
    assert ns["Geometry"].secant_slope(g, 0, 1) == pytest.approx(1.5)


def test_circle_polygon_angle_coords_numberline():
    d = doc([
        obj("oO", "O", "Dot", pos=[0, 0]), obj("oU", "U", "Dot", pos=[2, 0]), obj("oV", "V", "Dot", pos=[0, 2]),
        obj("oc", "circ", "Circle", link={"kind": "circle2", "a": "oO", "b": "oU"}),
        obj("od", "circd", "Circle", link={"kind": "circle2", "a": "oO", "b": "oU", "mode": "diameter"}),
        obj("oP", "P", "Dot", link={"kind": "on_circle", "circle": "oc", "angle": "pi/2"}),
        obj("og", "tri", "Polygon", link={"kind": "polygon", "points": ["oO", "oU", "oV"]}),
        obj("l1", "l1", "Line", link={"kind": "segment", "a": "oO", "b": "oU"}),
        obj("l2", "l2", "Line", link={"kind": "segment", "a": "oO", "b": "oV"}),
        obj("an", "ang", "Angle", link={"kind": "angle", "l1": "l1", "l2": "l2", "radius": "0.5"}),
        obj("am", "angval", "DecimalNumber", args={"*": "0"}, link={"kind": "measure", "what": "angle", "of": "an", "offset": [0.5, 0.5]}),
        obj("ln", "len", "DecimalNumber", args={"*": "0"}, link={"kind": "measure", "what": "length", "of": "l1"}),
        obj("nl", "nline", "NumberLine", args={"x_range": "[-3, 3, 1]"}, pos=[0, -3]),
        obj("np", "Q", "Dot", link={"kind": "coords", "axes": "nl", "x": "2"}),
        obj("ar", "arrow", "Arrow", link={"kind": "segment", "a": "oc", "b": "oV", "mode": "boundary"}),
    ])
    d["clips"] = [add_all(d)]
    r, o = run(d, 0)
    assert r.diagnostics == []
    assert o["circ"]["geom"]["radius"] == pytest.approx(2, abs=1e-3)
    assert o["circd"]["geom"]["center"] == pytest.approx([1, 0])
    assert o["P"]["center"] == pytest.approx([0, 2], abs=1e-3)
    assert sorted(map(tuple, o["tri"]["geom"]["vertices"])) == [(0, 0), (0, 2), (2, 0)]
    assert o["Q"]["center"] == pytest.approx([2 * o["nline"]["axes"]["ux"][0], -3], abs=1e-3)
    gen = codegen.generate(d)
    assert "Arrow(circ, V)" in gen.source


def test_diagnostics_missing_incompatible_order_cycle_and_conflict():
    d = doc(two_points() + [
        obj("x1", "missing", "Line", link={"kind": "segment", "a": "oA", "b": "gone"}),
        obj("x2", "bad", "Angle", link={"kind": "angle", "l1": "oA", "l2": "oB"}),
        obj("x3", "early", "Dot", link={"kind": "midpoint", "a": "oA", "b": "late"}),
        obj("late", "late", "Dot"),
        obj("c1", "c1", "Text", args={"*": '"1"'}, link={"kind": "attach", "to": "c2"}),
        obj("c2", "c2", "Text", args={"*": '"2"'}, link={"kind": "attach", "to": "c1"}),
        obj("x4", "undef", "Dot", link={"kind": "coords", "axes": "oA", "x": "k"}),
        obj("ok", "seg", "Line", link={"kind": "segment", "a": "oA", "b": "oB"}),
    ])
    d["clips"] = [add_all(d), {"id": "mv", "kind": "anim", "track": "t2", "start": 0, "duration": 1, "cls": "animate", "target": "seg",
                               "args": {}, "chain": ".shift(UP)"}]
    gen = codegen.generate(d)
    by = {}
    for x in gen.diagnostics:
        by.setdefault(x["id"], []).append(x["message"])
    assert "deleted" in by["x1"][0]
    assert "needs a line" in by["x2"][0]
    assert "defined after" in by["x3"][0]
    assert "cycle" in by["c1"][0] and "cycle" in by["c2"][0]
    assert "x4" in by  # a Dot isn't axes
    assert "undone" in by["mv"][0]
    assert "ok" not in by
    # Broken constructions don't break the scene.
    r = runtime.run(d, 0.5, render=False)
    assert r.error is None


def test_frozen_link_builds_once():
    d = doc(two_points() + [obj("oS", "seg", "Line", link={"kind": "segment", "a": "oA", "b": "oB", "frozen": True})])
    gen = codegen.generate(d)
    assert "Constraints" not in gen.source and "seg = Line(A.get_center(), B.get_center())" in gen.source


@needs_latex
def test_equation_terms_braces_and_transform_terms():
    eq1 = obj("e1", "eq1", "MathTex", eq={"parts": [{"id": "p1", "tex": "a^2"}, {"id": "p2", "tex": "+"}, {"id": "p3", "tex": "b^2"},
                                                    {"id": "p4", "tex": "="}, {"id": "p5", "tex": "c^2", "color": "YELLOW"}]}, pos=[0, 1])
    eq2 = obj("e2", "eq2", "MathTex", eq={"parts": [{"id": "q1", "tex": "a^2"}, {"id": "q2", "tex": "="}, {"id": "q3", "tex": "c^2"},
                                                    {"id": "q4", "tex": "-"}, {"id": "q5", "tex": "b^2"}]}, pos=[0, -1])
    br = obj("b1", "br", "Brace", link={"kind": "brace", "target": "e1", "parts": ["p1", "p2", "p3"], "direction": "DOWN"})
    hl = obj("h1", "hl", "SurroundingRectangle", link={"kind": "highlight", "target": "e1", "parts": ["p5"]})
    lab = obj("l1", "lab", "MathTex", args={"*": 'r"\\text{sum}"'}, link={"kind": "attach", "to": "e1", "parts": ["p3"], "offset": [0, -0.8]})
    d = doc([eq1, eq2, br, hl, lab])
    d["clips"] = [
        {"id": "c0", "kind": "add", "track": "t1", "start": 0, "duration": 0, "targets": ["eq1", "br", "hl", "lab"]},
        {"id": "c1", "kind": "anim", "track": "t1", "start": 1, "duration": 1, "cls": "TransformTerms", "target": "eq1",
         "terms": {"to": "e2", "pairs": [["p1", "q1"], ["p3", "q5"], ["p4", "q2"], ["p5", "q3"]]}, "args": {}},
    ]
    gen = codegen.generate(d)
    assert 'eq1 = MathTex(r"a^2", r"+", r"b^2", r"=", r"c^2")' in gen.source
    assert "eq1[4].set_color(YELLOW)" in gen.source
    assert "Brace(VGroup(eq1[0], eq1[1], eq1[2]), direction=DOWN)" in gen.source
    assert 'source_keys=["k0", None, "k1", "k2", "k3"]' in gen.source
    assert gen.diagnostics == []
    r, o = run(d, 0)
    parts = {p["id"]: p["box"] for p in o["eq1"]["parts"]}
    assert set(parts) == {"p1", "p2", "p3", "p4", "p5"} and all(parts.values())
    # The label follows term p3's center.
    assert o["lab"]["center"][0] == pytest.approx((parts["p3"][0] + parts["p3"][2]) / 2, abs=1e-3)
    r, o = run(d, 3)
    assert o["eq2"]["visible"] and not o["eq1"]["visible"]


@needs_latex
def test_empty_and_double_brace_terms_keep_indices():
    e = obj("e1", "eq", "MathTex", eq={"parts": [{"id": "p1", "tex": "x"}, {"id": "p2", "tex": "  "}, {"id": "p3", "tex": "{{y}}"}]})
    d = doc([e])
    gen = codegen.generate(d)
    assert gen.part_index["e1"] == {"p1": 0, "p3": 1}
    r, o = run(d, 0)
    assert [p["id"] for p in o["eq"]["parts"] if p["box"]] == ["p1", "p3"]


def test_exported_file_renders_with_manim_cli(tmp_path):
    d = doc([
        obj("oa", "a", "ValueTracker", args={"*": "0.5"}),
        obj("ox", "axes", "Axes", args={"x_range": "[-3, 3, 1]", "y_range": "[-2, 2, 1]"}),
        obj("og", "graph", "axes.plot", link={"kind": "graph", "axes": "ox", "expr": "a*x^2", "x_min": -2, "x_max": 2}),
        obj("op", "P", "Dot", link={"kind": "on_graph", "graph": "og", "x": "1"}),
        obj("ot", "tan", "Line", link={"kind": "tangent", "graph": "og", "x": "1"}),
    ])
    d["config"].update(pixel_width=320, pixel_height=180, frame_rate=10)
    d["clips"] = [add_all(d), {"id": "c2", "kind": "anim", "track": "t2", "start": 0, "duration": 1, "cls": "animate", "target": "a",
                               "args": {}, "chain": ".set_value(1)"}]
    src = codegen.generate(d).source
    path = tmp_path / "scene.py"
    path.write_text(src)
    res = subprocess.run([sys.executable, "-m", "manim", "render", "-ql", "--disable_caching", "--media_dir", str(tmp_path / "media"),
                          str(path), "MainScene"], capture_output=True, text=True, timeout=300)
    assert res.returncode == 0, res.stderr[-3000:]
    assert list((tmp_path / "media").rglob("MainScene.mp4"))
