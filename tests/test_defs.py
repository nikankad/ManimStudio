"""Definitions (Scene › Definitions): values, lists and functions written in math become Python above the scene,
graphs and constructions use them by name, and reading the code back keeps them."""

import math

import pytest

from conftest import add_all, doc, obj
from mathengine import codegen, defs, importer, mathexpr as M, runtime

THETA = {"id": "d1", "name": "theta", "kind": "function", "params": ["t"],
         "expr": "t/2 ln(t/(2pi)) - t/2 - pi/8 + 1/(48t)"}
Z = {"id": "d2", "name": "Z", "kind": "function", "params": ["t"],
     "where": [{"name": "n", "expr": "floor(sqrt(t/(2pi)))"}],
     "expr": "2 sum(k, 1, n, cos(theta(t) - t ln(k))/sqrt(k))"}
ZEROS = {"id": "d3", "name": "ZEROS", "kind": "list", "items": ["14.134725", "21.02204", "25.010858"]}
TAU = {"id": "d4", "name": "period", "kind": "value", "expr": "2 pi"}


def hardy_z(t):
    theta = t / 2 * math.log(t / (2 * math.pi)) - t / 2 - math.pi / 8 + 1 / (48 * t)
    n = math.floor(math.sqrt(t / (2 * math.pi)))
    return 2 * sum(math.cos(theta - t * math.log(k)) / math.sqrt(k) for k in range(1, n + 1))


def test_math_forms():
    sc = {"L": ("list",), "f": ("func", 2), "c": ("value",)}
    py = lambda text, **kw: M.to_python(M.parse(text, set(), allow_x=False, scope=sc, **kw).ast)
    assert py("sum(k, 1, 10, 1/k^2)") == "sum(1 / k ** 2 for k in range(1, 11))"
    assert py("L[1] + L[len(L)]") == "L[0] + L[int(len(L)) - 1]"
    assert py("if(c < 0, 0, f(c, 2))") == "(0 if c < 0 else f(c, 2))"
    assert "isprime" in M.parse("isprime(7)", set(), allow_x=False, scope=sc).helpers
    assert M.parse("q + c(1)", set(), allow_x=False, scope=sc).params == ["q"]  # c(1) is c times 1, as a(x+1) is
    for bad, fragment in [("L", "[1]"), ("f(1)", "2 inputs"), ("L(2)", "[1]")]:
        with pytest.raises(M.ExprError) as e:
            M.parse(bad, set(), allow_x=False, scope=sc)
        assert fragment in e.value.message + e.value.hint


def test_compile_and_evaluate():
    found = [THETA, Z, ZEROS, TAU]
    comp = defs.compile_defs(found)
    assert not comp.errors
    ns = defs.namespace(found)
    for t in (12.0, 14.134725, 30.5, 77.0):
        assert ns["Z"](t) == pytest.approx(hardy_z(t), abs=1e-12)
    info = defs.evaluate(found)
    assert info["d4"]["value"] == pytest.approx(2 * math.pi)
    assert info["d3"]["length"] == 3


@pytest.mark.parametrize("d,fragment", [
    ({"id": "a", "name": "sin", "kind": "value", "expr": "1"}, "already"),
    ({"id": "a", "name": "Circle", "kind": "value", "expr": "1"}, "manim"),
    ({"id": "a", "name": "2x", "kind": "value", "expr": "1"}, "can't be a name"),
    ({"id": "a", "name": "v", "kind": "value", "expr": "a + 1"}, "isn't defined"),
])
def test_errors_are_explained(d, fragment):
    comp = defs.compile_defs([d], defs.manim_names())
    msg, hint = comp.errors["a"]
    assert fragment in msg + hint


def test_graph_uses_a_definition_and_round_trips():
    d = doc([
        obj("ox", "axes", "Axes", args={"x_range": "[10, 40, 5]", "y_range": "[-4, 4, 1]"}),
        obj("og", "graph", "axes.plot", link={"kind": "graph", "axes": "ox", "expr": "y = Z(x)", "x_min": 10, "x_max": 40}),
    ])
    d["defs"] = [THETA, Z, ZEROS, TAU]
    d["timeline"] = [add_all(d)]
    src = codegen.generate(d).source
    assert "def Z(t):" in src and src.index("def Z(t):") < src.index("class ")
    r = runtime.run(d, 0, render=False)
    assert r.error is None, r.error and r.error["trace"]
    back = importer.import_code(src, base=d).doc
    assert [x["name"] for x in back["defs"]] == ["theta", "Z", "ZEROS", "period"]
    assert codegen.generate(back).source == src
    # edited by hand: no longer what the definitions generate, so they become ordinary code above the scene
    edited = src.replace("period = 2 * np.pi", "period = 6.28")
    back = importer.import_code(edited, base=d).doc
    assert not back.get("defs")
    assert codegen.generate(back).source.count("def Z(t):") == 1


def test_shown_as_math():
    r = M.analyze_function("y = if(x < 0, 0, x^2) + sum(k, 1, 3, sin(k x)/k)", None, (-3, 3))
    assert r["ok"] and r["normalized"] == "if(x < 0, 0, x ^ 2) + sum(k, 1, 3, sin(k * x) / k)"


@pytest.mark.parametrize("r,head", [
    ({"var": "k", "from": "1", "to": "6"}, "for k in range(1, 7)"),
    ({"var": "k", "from": "1", "to": "len(ZEROS)"}, "for k in range(1, len(ZEROS) + 1)"),
    ({"var": "k", "from": "2", "to": "period"}, "for k in range(2, int(2 * np.pi) + 1)".replace("2 * np.pi", "period")),
    ({"var": "z", "each": "ZEROS"}, "for z in ZEROS"),
])
def test_repeat_headers(r, head):
    assert defs.repeat_head(r, defs.scope([ZEROS, TAU])) == head


@pytest.mark.parametrize("r,fragment", [
    ({"var": "ZEROS", "from": "1", "to": "2"}, "definition"),
    ({"var": "k", "each": "period"}, "isn't a list"),
    ({"var": "k", "from": "1", "to": "q"}, "isn't defined"),
    ({"var": "for", "from": "1", "to": "2"}, "can't be"),
])
def test_repeat_errors(r, fragment):
    with pytest.raises(M.ExprError) as e:
        defs.repeat_head(r, defs.scope([ZEROS, TAU]))
    assert fragment in e.value.message


def repeat_doc(after="b1"):
    d = doc([obj("ox", "axes", "Axes", args={"x_range": "[-1, 2, 1]", "y_range": "[0, 30, 10]"}),
             obj("od", "dot", "Dot", after=after, link={"kind": "coords", "axes": "ox", "x": "0.5", "y": "ZEROS[k]"})])
    d["defs"] = [ZEROS]
    d["timeline"] = [{"id": "s0", "kind": "add", "targets": ["axes"]},
                     {"id": "b1", "kind": "block", "head": "for i in range(2)", "repeat": {"var": "k", "from": "1", "to": "len(ZEROS)"}},
                     {"id": "p1", "kind": "play", "anims": [{"id": "a1", "cls": "GrowFromCenter", "target": "dot", "args": {}}], "args": {}},
                     {"id": "e1", "kind": "end"}]
    return d


def test_repeat_counter_in_math_fields():
    """Each run of the loop makes its own dot at its own zero (the updater keeps its run's k, not the last)."""
    d = repeat_doc()
    src = codegen.generate(d).source
    assert "for k in range(1, len(ZEROS) + 1):" in src and "lambda m, k=k: m.move_to(axes.c2p(0.5, ZEROS[int(k) - 1]))" in src
    from manim import tempconfig

    ns = {}
    with tempconfig({"dry_run": True, "disable_caching": True, "verbosity": "ERROR"}):
        exec(compile(src, "scene", "exec"), ns)
        scene = ns["MainScene"]()
        scene.render()
        ys = sorted(round(float(m.get_center()[1]), 3) for m in scene.mobjects if type(m).__name__ == "Dot")
    assert len(ys) == 3 and len(set(ys)) == 3
    back = importer.import_code(src, base=d).doc
    assert back["timeline"][1]["repeat"] == d["timeline"][1]["repeat"]
    assert codegen.generate(back).source == src


def test_counter_outside_its_loop_is_explained():
    d = repeat_doc(after=None)
    r = runtime.run(d, 0, render=False)
    assert any("counter of a Repeat" in x["message"] for x in r.diagnostics), r.diagnostics


def text_doc(template="t = {t:2}"):
    d = doc([obj("ot", "t", "ValueTracker", args={"*": "10"}, param={"min": 0, "max": 50, "step": 0.1}),
             obj("ox", "axes", "Axes", args={"x_range": "[10, 50, 10]"}),
             obj("or", "readout", "Text", args={"*": '"old"', "font_size": "24"}, chain=".next_to(axes, DOWN)",
                 link={"kind": "text", "template": template}),
             obj("og", "tag", "Text", pos=[1, 2], link={"kind": "text", "template": "½ + {ZEROS[2]:3}i, {{braces}}"})])
    d["defs"] = [ZEROS]
    d["timeline"] = [{"id": "s0", "kind": "add", "targets": ["axes", "readout", "tag"]},
                     {"id": "p", "kind": "play", "anims": [{"id": "a", "cls": "animate", "target": "t", "chain": ".set_value(20)", "args": {}}], "args": {}}]
    return d


def test_text_with_values():
    """A value of a definition is written once; a parameter's is kept up to date as it changes."""
    d = text_doc()
    src = codegen.generate(d).source
    assert 'tag = Text(f"½ + {ZEROS[1]:.3f}i, {{braces}}")' in src
    assert 'readout = constraints.redraw(lambda: Text(f"t = {t.get_value():.2f}", font_size=24).next_to(axes, DOWN), t)' in src
    from manim import tempconfig

    ns = {}
    with tempconfig({"dry_run": True, "disable_caching": True, "verbosity": "ERROR"}):
        exec(compile(src, "scene", "exec"), ns)
        scene = ns["MainScene"]()
        scene.render()
        Text = ns["Text"]
        readout = min((m for m in scene.mobjects if type(m).__name__ == "Text"), key=lambda m: m.get_center()[1])  # the one under the axes
        glyphs = lambda m: [float(v) for g in m.submobjects for v in (g.width, g.height)]  # noqa: E731
        shapes = {v: glyphs(Text(f"t = {v}", font_size=24)) for v in ("10.00", "20.00")}
        now = glyphs(readout)
    assert shapes["10.00"] != pytest.approx(shapes["20.00"], abs=1e-3)
    assert now == pytest.approx(shapes["20.00"], abs=1e-3)  # redrawn for the value t reached
    back = importer.import_code(src, base=d).doc
    assert codegen.generate(back).source == src
    assert next(o for o in back["objects"] if o["name"] == "readout")["link"]["template"] == "t = {t:2}"


@pytest.mark.parametrize("template,fragment", [("t = {t", "no }"), ("a } b", "no {"), ("x {} y", "empty"), ("{q}", "q")])
def test_text_template_errors(template, fragment):
    r = runtime.run(text_doc(template), 0, render=False)
    assert any(fragment in x["message"] for x in r.diagnostics if x["id"] == "or"), r.diagnostics


def test_fade_out_the_rest():
    """Everything on screen goes but the kept object, loop-made objects included; constructions keep updating."""
    d = repeat_doc()
    d["objects"].insert(0, obj("oT", "title", "Text", args={"*": '"RH"'}))
    d["timeline"].insert(0, {"id": "s9", "kind": "add", "targets": ["title"]})
    d["timeline"].append({"id": "pf", "kind": "play", "args": {}, "anims": [
        {"id": "af", "cls": "expr", "target": "", "args": {},
         "src": "*[FadeOut(m) for m in self.mobjects if m is not title and type(m) is not Mobject]"}]})
    src = codegen.generate(d).source
    r = runtime.run(d, 100, render=False)
    assert r.error is None, r.error and r.error["trace"]
    from manim import tempconfig

    ns = {}
    with tempconfig({"dry_run": True, "disable_caching": True, "verbosity": "ERROR"}):
        exec(compile(src, "scene", "exec"), ns)
        scene = ns["MainScene"]()
        scene.render()
        left = sorted(type(m).__name__ for m in scene.mobjects)
    assert left == ["Mobject", "Text"], left
