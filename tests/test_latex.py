"""Without LaTeX: numbers and simple labels still draw (with Text); equations say what's missing."""

import pytest

from conftest import doc, obj
from mathengine import codegen, runtime, starters, tex


@pytest.fixture
def no_latex(monkeypatch, tmp_path):
    """A computer without LaTeX: not on PATH, not in any standard place, and no TeX output cached."""
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setattr(tex, "_candidates", lambda: [])
    assert not tex.latex_available(refresh=True)
    yield
    monkeypatch.undo()
    tex.find_tex(refresh=True)


def show(objects):
    d = doc(objects)
    d["clips"] = [{"id": "add", "kind": "add", "track": "t1", "start": 0, "duration": 0,
                   "targets": [o["name"] for o in objects if o["ctor"] != "ValueTracker"]}]
    return d


def test_simple_tex_as_text():
    assert tex.plain_text(r"\theta") == "θ"
    assert tex.plain_text("x^2 + y_1") == "x² + y₁"
    assert tex.plain_text(r"\text{area} = \pi r^{2}") == "area = π r²"
    assert tex.plain_text(r"90^\circ") == "90°"
    assert tex.plain_text(r"\frac{a}{b}") is None and tex.plain_text(r"e^{i\pi}") is None and tex.plain_text(r"\sqrt{2}") is None
    assert tex.text_fallback("MathTex", {"*": r'r"\theta"', "color": "YELLOW", "tex_template": "T"}) == ("Text", {"*": "'θ'", "color": "YELLOW", "font_size": "33.12"})
    assert tex.text_fallback("MathTex", {"*": '"A"', "font_size": "size"})[1]["font_size"] == "(size) * 0.69"
    assert tex.text_fallback("MathTex", {"*": r'r"\frac{1}{2}"'}) is None


def test_numbers_and_labels_draw_without_latex(no_latex):
    d = show([
        obj("n", "angle_value", "DecimalNumber", args={"*": "42.5", "unit": r'r"^\circ"', "num_decimal_places": "1"}),
        obj("i", "count", "Integer", args={"*": "-7"}, pos=[0, -1]),
        obj("a", "axes", "Axes", args={"x_range": "[-3, 3, 1]", "y_range": "[-2, 2, 1]", "axis_config": '{"include_numbers": True}'}),
        obj("l", "label", "MathTex", args={"*": r'r"\theta"'}, pos=[2, 2]),
    ])
    gen = codegen.generate(d)
    assert "DecimalNumber._string_to_mob = _me_number_part" in gen.source
    assert "label = Text('θ', font_size=33.12)" in gen.source
    assert [x["level"] for x in gen.diagnostics if x["id"] == "l"] == ["warning"]
    r = runtime.run(d, 0, render=True)
    assert r.error is None, r.error and r.error["trace"]
    o = {x["name"]: x for x in r.objects}
    assert o["angle_value"]["visible"] and o["angle_value"]["box"][2] - o["angle_value"]["box"][0] > 0.5


def test_starters_work_without_latex(no_latex):
    for template in starters.starters():
        r = runtime.run(starters.as_document(template), 60, render=True)
        assert r.error is None, (template["name"], r.error and r.error["message"])


def test_equations_explain_what_is_missing(no_latex):
    d = show([obj("e", "formula", "MathTex", args={"*": r'r"\frac{a}{b}"'})])
    gen = codegen.generate(d)
    assert any(x["id"] == "e" and x["level"] == "error" and "needs LaTeX" in x["message"] for x in gen.diagnostics)
    r = runtime.run(d, 0, render=False)
    assert r.error and r.error["id"] == "e" and "formula needs LaTeX" in r.error["message"] and "Install" in r.error["message"]


def test_nothing_changes_with_latex():
    d = show([obj("n", "v", "DecimalNumber", args={"*": "1"}), obj("l", "label", "MathTex", args={"*": r'r"\theta"'})])
    assert codegen.generate(d, latex=True).source == codegen.generate(d, latex=True).source
    src = codegen.generate(d, latex=True).source
    assert "_me_number_part" not in src and 'label = MathTex(r"\\theta")' in src


def test_text_numbers_match_tex_size(no_latex):
    d = show([obj("n", "v", "DecimalNumber", args={"*": "0.71"})])
    r = runtime.run(d, 0, render=False)
    box = {x["name"]: x for x in r.objects}["v"]["box"]
    assert 0.3 < box[3] - box[1] < 0.4  # TeX draws it 0.348 tall
