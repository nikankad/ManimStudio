"""Constructions compile, stay attached while things animate, and report broken links."""

import ast
import math
import subprocess
import sys

import pytest

from conftest import add_all, anim, animate, doc, needs_latex, obj, play, wait
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
    d["timeline"] = [add_all(d), play(animate("c2", "B", ".shift(UP * 2)", rate_func="linear"), run_time=1)]
    r, o = run(d, 0.5)
    assert o["seg"]["geom"]["end"] == pytest.approx([2, 2])
    assert o["mid"]["center"] == pytest.approx([0, 0.5])
    assert o["mid2"]["center"] == pytest.approx([0, 0.5])
    r, o = run(d, 5)
    assert o["mid"]["center"] == pytest.approx([0, 1])
    assert r.diagnostics == []


def test_style_animation_is_not_overwritten_by_redraw():
    d = doc(two_points() + [obj("oS", "seg", "Line", args={"color": "BLUE"}, link={"kind": "segment", "a": "oA", "b": "oB"})])
    d["timeline"] = [add_all(d), play(animate("c2", "seg", ".set_color(RED)"), run_time=1),
                     play(animate("c3", "A", ".shift(LEFT)"), run_time=1)]
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
    d["timeline"] = [add_all(d)]
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
    d["timeline"] = [add_all(d), play(animate("c2", "a", ".set_value(2)", rate_func="linear"), run_time=2)]
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
    d["timeline"] = [add_all(d)]
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
    d["timeline"] = [add_all(d), play(animate("mv", "seg", ".shift(UP)"), run_time=1)]
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
    d["timeline"] = [
        {"id": "c0", "kind": "add", "targets": ["eq1", "br", "hl", "lab"]},
        wait(1),
        play({**anim("c1", "TransformTerms", "eq1"), "terms": {"to": "e2", "pairs": [["p1", "q1"], ["p3", "q5"], ["p4", "q2"], ["p5", "q3"]]}}),
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
    d["timeline"] = [add_all(d), play(animate("c2", "a", ".set_value(1)"), run_time=1)]
    src = codegen.generate(d).source
    path = tmp_path / "scene.py"
    path.write_text(src)
    res = subprocess.run([sys.executable, "-m", "manim", "render", "-ql", "--disable_caching", "--media_dir", str(tmp_path / "media"),
                          str(path), "MainScene"], capture_output=True, text=True, timeout=300)
    assert res.returncode == 0, res.stderr[-3000:]
    assert list((tmp_path / "media").rglob("MainScene.mp4"))


@needs_latex
def test_transform_terms_in_a_play_with_other_animations():
    """A TransformTerms animation inside a LaggedStart, next to another animation."""
    eq1 = obj("e1", "eq1", "MathTex", eq={"parts": [{"id": "p1", "tex": "x"}, {"id": "p2", "tex": "+"}, {"id": "p3", "tex": "1"}]})
    eq2 = obj("e2", "eq2", "MathTex", eq={"parts": [{"id": "q1", "tex": "1"}, {"id": "q2", "tex": "+"}, {"id": "q3", "tex": "x"}]})
    dot = obj("d", "dot", "Dot", pos=[0, -2])
    d = doc([eq1, eq2, dot])
    terms = {**anim("c1", "TransformTerms", "eq1"), "terms": {"to": "e2", "pairs": [["p1", "q3"], ["p2", "q2"], ["p3", "q1"]]}}
    d["timeline"] = [
        {"id": "c0", "kind": "add", "targets": ["eq1", "dot"]},
        wait(1),
        play({"id": "g", "cls": "LaggedStart", "target": "", "args": {"lag_ratio": "0.5"}, "anims": [terms, anim("c2", "Indicate", "dot")]}),
    ]
    gen = codegen.generate(d)
    calls = [n for n in ast.walk(ast.parse(gen.source)) if isinstance(n, ast.Call)]
    played = next(n for n in calls if isinstance(n.func, ast.Attribute) and n.func.attr == "play")
    group = played.args[0]
    assert isinstance(group, ast.Call) and isinstance(group.func, ast.Name) and group.func.id == "LaggedStart"
    transform = group.args[0]
    assert isinstance(transform, ast.Call) and isinstance(transform.func, ast.Name) and transform.func.id == "TransformTerms"
    assert [n.id for n in transform.args[:2]] == ["eq1", "eq2"]
    for t in (1.5, 1.9):
        run(d, t)
    r, o = run(d, 10)
    assert o["eq2"]["visible"] and not o["eq1"]["visible"]


def test_intersections_of_lines_and_circles_follow_animation():
    r3 = math.sqrt(3)
    d = doc([
        obj("oA", "A", "Dot", pos=[-2, -1]), obj("oB", "B", "Dot", pos=[2, 1]),
        obj("oC", "C", "Dot", pos=[-2, 1]), obj("oD", "D", "Dot", pos=[2, -1]),
        obj("l1", "l1", "Line", link={"kind": "segment", "a": "oA", "b": "oB"}),
        obj("l2", "l2", "Line", link={"kind": "segment", "a": "oC", "b": "oD"}),
        obj("oX", "X", "Dot", link={"kind": "intersection", "a": "l1", "b": "l2"}),
        # Lines are extended: these short segments don't reach each other.
        obj("s1", "s1", "Line", args={"start": "[-3, 2, 0]", "end": "[-2, 2, 0]"}),
        obj("s2", "s2", "Line", args={"start": "[1, -3, 0]", "end": "[1, -2, 0]"}),
        obj("oY", "Y", "Dot", link={"kind": "intersection", "a": "s1", "b": "s2"}),
        obj("oO", "O", "Dot", pos=[0, 0]), obj("oU", "U", "Dot", pos=[2, 0]),
        obj("c1", "c1", "Circle", link={"kind": "circle2", "a": "oO", "b": "oU"}),
        obj("c2", "c2", "Circle", link={"kind": "circle2", "a": "oU", "b": "oO"}),
        obj("h", "h", "Line", args={"start": "[-3, 1, 0]", "end": "[3, 1, 0]"}),
        obj("k0", "K0", "Dot", link={"kind": "intersection", "a": "h", "b": "c1", "which": 0}),
        obj("k1", "K1", "Dot", link={"kind": "intersection", "a": "c1", "b": "h", "which": 1}),
        obj("k2", "K2", "Dot", pos=[3, 3], link={"kind": "intersection", "a": "h", "b": "c1", "which": 2}),
        obj("cc0", "CC0", "Dot", link={"kind": "intersection", "a": "c1", "b": "c2", "which": 0}),
        obj("cc1", "CC1", "Dot", link={"kind": "intersection", "a": "c1", "b": "c2", "which": 1}),
    ])
    d["timeline"] = [add_all(d), play(animate("c2", "B", ".shift(UP * 2)", rate_func="linear"), run_time=1)]
    r, o = run(d, 0)
    assert r.diagnostics == []
    assert o["X"]["center"] == pytest.approx([0, 0], abs=1e-6)
    assert o["Y"]["center"] == pytest.approx([1, 2], abs=1e-6)
    assert o["K0"]["center"] == pytest.approx([-r3, 1], abs=1e-4)  # first along h, from its start
    assert o["K1"]["center"] == pytest.approx([r3, 1], abs=1e-4)
    assert o["K2"]["center"] == pytest.approx([3, 3], abs=1e-6)  # no third intersection: keeps its place
    assert o["CC0"]["center"] == pytest.approx([1, r3], abs=1e-4)  # left of c1 -> c2 first
    assert o["CC1"]["center"] == pytest.approx([1, -r3], abs=1e-4)
    # While B moves up (B = (2, 2) at t = 0.5), l1 is y = 0.75 x + 0.5 and l2 is y = -x / 2.
    r, o = run(d, 0.5)
    assert o["X"]["center"] == pytest.approx([-0.4, 0.2], abs=1e-4)
    r, o = run(d, 5)
    assert o["X"]["center"] == pytest.approx([-2 / 3, 1 / 3], abs=1e-4)
    gen = codegen.generate(d)
    assert "Geometry.intersection(Geometry.as_line(h), Geometry.as_circle(c1), 0)" in gen.source


def test_graph_intersections_roots_and_asymptotes():
    d = doc([
        obj("ox", "axes", "Axes", args={"x_range": "[-4, 4, 1]", "y_range": "[-3, 3, 1]", "x_length": "8", "y_length": "6"}),
        obj("og", "f", "axes.plot", link={"kind": "graph", "axes": "ox", "expr": "y = x^2 - 1", "x_min": -3, "x_max": 3}),
        obj("og2", "g", "axes.plot", link={"kind": "graph", "axes": "ox", "expr": "y = 1 - x^2", "x_min": -2, "x_max": 2}),
        obj("ogi", "inv", "axes.plot", link={"kind": "graph", "axes": "ox", "expr": "y = 1/x", "x_min": -3, "x_max": 2.9,
                                            "discontinuities": [0], "gap": 0.05}),
        obj("diag", "diag", "Line", args={"start": "[-3, -3, 0]", "end": "[3, 3, 0]"}),
        obj("r0", "R0", "Dot", link={"kind": "intersection", "a": "og", "b": "ox", "which": 0}),
        obj("r1", "R1", "Dot", link={"kind": "intersection", "a": "ox", "b": "og", "which": 1}),
        obj("q1", "Q1", "Dot", link={"kind": "intersection", "a": "og", "b": "diag", "which": 1}),
        obj("gg", "GG", "Dot", link={"kind": "intersection", "a": "og", "b": "og2", "which": 0}),
        obj("ai", "AI", "Dot", pos=[2, 2], link={"kind": "intersection", "a": "ogi", "b": "ox"}),
        obj("yi", "YI", "Dot", link={"kind": "intersection", "a": "og", "b": "ox", "axis": "y"}),
    ])
    d["timeline"] = [add_all(d)]
    r, o = run(d, 0)
    assert r.diagnostics == []
    assert o["R0"]["center"] == pytest.approx([-1, 0], abs=1e-4)
    assert o["R1"]["center"] == pytest.approx([1, 0], abs=1e-4)
    phi = (1 + math.sqrt(5)) / 2
    assert o["Q1"]["center"] == pytest.approx([phi, phi], abs=1e-4)
    assert o["GG"]["center"] == pytest.approx([-1, 0], abs=1e-4)
    assert o["AI"]["center"] == pytest.approx([2, 2], abs=1e-6)  # 1/x never crosses the x-axis (the jump at 0 isn't a root)
    assert o["YI"]["center"] == pytest.approx([0, -1], abs=1e-4)  # with the y-axis


def test_perpendicular_parallel_and_feet():
    d = doc([
        obj("oA", "A", "Dot", pos=[-2, 0]), obj("oB", "B", "Dot", pos=[2, 0]), obj("oC", "C", "Dot", pos=[1, 2]),
        obj("ab", "ab", "Line", link={"kind": "segment", "a": "oA", "b": "oB"}),
        obj("alt", "alt", "DashedLine", link={"kind": "perpendicular", "line": "ab", "through": "oC", "mode": "foot"}),
        obj("perp", "perp", "Line", link={"kind": "perpendicular", "line": "ab", "through": "oC", "length": "2"}),
        obj("par", "par", "Line", link={"kind": "parallel", "line": "ab", "through": "oC"}),
        obj("par2", "par2", "Line", link={"kind": "parallel", "line": "ab", "through": "oC", "length": "1"}),
        obj("ft", "H", "Dot", link={"kind": "projection", "point": "oC", "onto": "ab"}),
        obj("ox", "axes", "Axes", args={"x_range": "[-4, 4, 1]", "y_range": "[-3, 3, 1]", "x_length": "8", "y_length": "6"}),
        obj("fx", "FX", "Dot", link={"kind": "projection", "point": "oC", "onto": "ox"}),
        obj("fy", "FY", "Dot", link={"kind": "projection", "point": "oC", "onto": "ox", "axis": "y"}),
        obj("pa", "pa", "Line", link={"kind": "perpendicular", "line": "ox", "through": "oC", "axis": "y", "mode": "foot"}),
    ])
    d["timeline"] = [add_all(d), play(animate("c2", "B", ".shift(UP * 4)", rate_func="linear"), run_time=1)]
    r, o = run(d, 0)
    assert r.diagnostics == []
    assert o["alt"]["geom"]["start"] == pytest.approx([1, 2], abs=1e-4) and o["alt"]["geom"]["end"] == pytest.approx([1, 0], abs=1e-4)
    assert o["perp"]["geom"]["start"] == pytest.approx([1, 1], abs=1e-4) and o["perp"]["geom"]["end"] == pytest.approx([1, 3], abs=1e-4)
    assert o["par"]["geom"]["start"] == pytest.approx([-1, 2], abs=1e-4) and o["par"]["geom"]["end"] == pytest.approx([3, 2], abs=1e-4)
    assert o["par2"]["geom"]["start"] == pytest.approx([0.5, 2], abs=1e-4)
    assert o["H"]["center"] == pytest.approx([1, 0], abs=1e-4)
    assert o["FX"]["center"] == pytest.approx([1, 0], abs=1e-4)
    assert o["FY"]["center"] == pytest.approx([0, 2], abs=1e-4)
    assert o["pa"]["geom"]["end"] == pytest.approx([0, 2], abs=1e-4)
    # B ends at (2, 4): ab is y = x + 2, so the foot from C(1, 2) is (0.5, 2.5).
    r, o = run(d, 5)
    assert o["H"]["center"] == pytest.approx([0.5, 2.5], abs=1e-4)
    assert o["alt"]["geom"]["end"] == pytest.approx([0.5, 2.5], abs=1e-4)
    gen = codegen.generate(d)
    assert "Geometry.perpendicular_line(DashedLine, ab, C.get_center(), foot=True)" in gen.source
    assert "axes.c2p(axes.p2c(C.get_center())[0], 0)" in gen.source


def test_new_construction_diagnostics():
    d = doc([
        obj("oA", "A", "Dot", pos=[-2, 0]), obj("oB", "B", "Dot", pos=[2, 0]),
        obj("ab", "ab", "Line", link={"kind": "segment", "a": "oA", "b": "oB"}),
        obj("ax1", "ax1", "Axes"), obj("ax2", "ax2", "Axes"),
        obj("g1", "g1", "ax1.plot", args={"function": "lambda x: x"}),
        obj("g2", "g2", "ax2.plot", args={"function": "lambda x: -x"}),
        obj("x1", "same", "Dot", link={"kind": "intersection", "a": "ab", "b": "ab"}),
        obj("x2", "axes2", "Dot", link={"kind": "intersection", "a": "ax1", "b": "ax2"}),
        obj("x3", "graphs", "Dot", link={"kind": "intersection", "a": "g1", "b": "g2"}),
        obj("x4", "pt", "Dot", link={"kind": "intersection", "a": "oA", "b": "ab"}),
        obj("x5", "neg", "Dot", link={"kind": "intersection", "a": "ab", "b": "g1", "which": -1}),
        obj("x6", "onto_pt", "Dot", link={"kind": "projection", "point": "oB", "onto": "oA"}),
        obj("x7", "perp_self", "Line", link={"kind": "perpendicular", "line": "ab", "through": "ab"}),
    ])
    d["timeline"] = [add_all(d)]
    gen = codegen.generate(d)
    by = {x["id"]: x["message"] for x in gen.diagnostics}
    assert "two different" in by["x1"]
    assert "not two axes" in by["x2"]
    assert "same axes" in by["x3"]
    assert "needs a" in by["x4"]
    assert "which intersection" in by["x5"]
    assert "needs a" in by["x6"]
    assert "different objects" in by["x7"]
    r = runtime.run(d, 0, render=False)
    assert r.error is None


def test_redrawn_dashed_line_keeps_every_dash_visible():
    """A dashed construction rebuilt many times keeps all its dashes and its animated color (become() pads
    with invisible copies, whose opacity used to spread to later rebuilds until the line disappeared)."""
    from mathengine import construct

    ns = {}
    exec("from manim import *\nimport numpy as np\n" + construct.CONSTRAINTS_SOURCE, ns)

    class Scene:
        def add_updater(self, f):
            pass

        def add(self, *m):
            pass

    c = ns["Constraints"](Scene())
    a, b = ns["Dot"]([-3, 0, 0]), ns["Dot"]([3, 0, 0])
    line = c.redraw(lambda: ns["DashedLine"](a.get_center(), b.get_center(), color=ns["YELLOW"]), a, b)
    line.set_color(ns["RED"])
    for i in range(60):
        b.move_to([3 - i * 0.08 if i < 40 else -0.2 + (i - 40) * 0.3, i * 0.04, 0])
        c.update()
        parts = line.family_members_with_points()
        fresh = ns["DashedLine"](a.get_center(), b.get_center())
        assert len(parts) == len(fresh.submobjects)
        assert all(p.get_stroke_opacity() > 0.5 for p in parts)
    assert {p.get_color().to_hex() for p in parts} == {ns["RED"].to_hex()}
