import math

import pytest

from mathengine import mathexpr as M


@pytest.mark.parametrize("text,python,params", [
    ("y = a*x^2 + b", "a.get_value() * x ** 2 + b.get_value()", ["a", "b"]),
    ("f(x) = 2sin(3x)", "2 * np.sin(3 * x)", []),
    ("-x^2", "-x ** 2", []),
    ("2^-x", "2 ** -x", []),
    ("ax + b", "a.get_value() * x + b.get_value()", ["a", "b"]),
    ("|x - 1|", "np.abs(x - 1)", []),
    ("e^x + pi", "np.e ** x + np.pi", []),
    ("(x+1)(x-1)", "(x + 1) * (x - 1)", []),
    ("x/(2x)", "x / (2 * x)", []),
    ("1/x/2", "1 / x / 2", []),
    ("x-(1-x)", "x - (1 - x)", []),
])
def test_parse_function(text, python, params):
    e = M.parse_function(text)
    assert M.to_python(e.ast) == python
    assert e.params == params


@pytest.mark.parametrize("text,fragment", [
    ("x^2 + y^2 = 1", "implicit"),
    ("x = 3", "vertical line"),
    ("r = 2", "Polar"),
    ("y < x", "Inequalities"),
    ("y = (x, 2)", "Expected"),
    ("y = {x}", "Piecewise"),
    ("y = 3!", "Factorials"),
    ("y = ", "empty"),
])
def test_unsupported_syntax_is_explained(text, fragment):
    with pytest.raises(M.ExprError) as err:
        M.parse_function(text)
    assert fragment.lower() in (err.value.message + err.value.hint).lower()


def test_generated_python_evaluates_like_the_ast():
    import numpy as np

    for text in ["a*x^2 + b", "sin(x)^2 + cos(x)^2", "sqrt(abs(x)) - ln(x^2 + 1)", "-x^3/3 + 2^x", "tan(x/2)"]:
        e = M.parse_function(text)
        src = M.to_python(e.ast, {"a": "a", "b": "b"})
        for x in (-1.3, 0.2, 2.7):
            want = float(M.evaluate(e.ast, x, {"a": 2.0, "b": -1.0}))
            got = eval(src, {"np": np, "x": x, "a": 2.0, "b": -1.0})
            assert math.isclose(want, got, rel_tol=1e-12, abs_tol=1e-12)


def test_discontinuities_and_gap():
    r = M.analyze_function("y = tan(x)", {}, (-5, 5), (-4, 4))
    assert [round(d, 3) for d in r["discontinuities"]] == [-4.712, -1.571, 1.571, 4.712]
    # The gap keeps each branch inside the y-range: tan(pi/2 - gap) <= ~4.2
    assert abs(math.tan(math.pi / 2 - r["gap"])) <= 4.2 * 1.3
    r = M.analyze_function("1/(x - 1)", {}, (-5, 5), (-4, 4))
    assert r["discontinuities"] == [1.0]
    r = M.analyze_function("floor(x)", {}, (-2.5, 2.5), (-3, 3))
    assert r["discontinuities"] == [-2.0, -1.0, 0.0, 1.0, 2.0]
    r = M.analyze_function("x^3", {}, (-5, 5), (-4, 4))
    assert r["discontinuities"] == []  # steep but continuous


def test_undefined_regions_and_parameters():
    r = M.analyze_function("sqrt(x)", {}, (-4, 4))
    assert r["undefined_intervals"] and r["undefined_intervals"][0][0] == -4
    r = M.analyze_function("y = k*x + c", {"k": 2})
    assert r["params"] == ["k", "c"] and r["undefined"] == ["c"]


def test_compile_value_requires_known_parameters():
    assert M.compile_value("cos(theta)", {"theta"}) == ("np.cos(theta.get_value())", ["theta"])
    with pytest.raises(M.ExprError):
        M.compile_value("t + 1", set())
    with pytest.raises(M.ExprError):
        M.compile_value("x + 1", {"t"})  # no x outside functions
