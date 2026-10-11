"""A small math expression language for the visual authoring tools.

Users type math, not Python: ``y = a*x^2 + b``, ``2sin(3x)``, ``sqrt(x)/x``.
This module parses that, explains unsupported syntax in plain words, turns it
into Python for the generated manim code (parameters become
``name.get_value()`` reads of their ValueTrackers), and analyses explicit
functions numerically (extent, undefined regions, discontinuities) for the
graph builder.

Only explicit 2D functions of ``x`` are supported. Implicit equations,
inequalities, parametric/polar curves and piecewise definitions are rejected
with an explanation. Nothing here evaluates arbitrary Python.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import numpy as np

# name -> numpy source in generated code
FUNCTIONS: dict[str, str] = {
    "sin": "np.sin", "cos": "np.cos", "tan": "np.tan",
    "asin": "np.arcsin", "acos": "np.arccos", "atan": "np.arctan",
    "arcsin": "np.arcsin", "arccos": "np.arccos", "arctan": "np.arctan",
    "sinh": "np.sinh", "cosh": "np.cosh", "tanh": "np.tanh",
    "exp": "np.exp", "ln": "np.log", "log": "np.log10", "log2": "np.log2",
    "sqrt": "np.sqrt", "abs": "np.abs", "floor": "np.floor", "ceil": "np.ceil",
    "sign": "np.sign", "sec": "1 / np.cos", "csc": "1 / np.sin", "cot": "1 / np.tan",
}
_NUMPY = {
    "sin": np.sin, "cos": np.cos, "tan": np.tan, "asin": np.arcsin, "acos": np.arccos, "atan": np.arctan,
    "arcsin": np.arcsin, "arccos": np.arccos, "arctan": np.arctan, "sinh": np.sinh, "cosh": np.cosh,
    "tanh": np.tanh, "exp": np.exp, "ln": np.log, "log": np.log10, "log2": np.log2, "sqrt": np.sqrt,
    "abs": np.abs, "floor": np.floor, "ceil": np.ceil, "sign": np.sign,
    "sec": lambda v: 1 / np.cos(v), "csc": lambda v: 1 / np.sin(v), "cot": lambda v: 1 / np.tan(v),
}
CONSTANTS = {"pi": ("np.pi", math.pi), "e": ("np.e", math.e), "tau": ("(2 * np.pi)", math.tau)}
VARIABLE = "x"


class ExprError(ValueError):
    """A parse error with a plain-language explanation of what isn't supported."""

    def __init__(self, message: str, hint: str = ""):
        super().__init__(message)
        self.message = message
        self.hint = hint


@dataclass
class Expr:
    """A parsed expression: AST plus what it refers to."""

    text: str
    ast: tuple
    params: list[str] = field(default_factory=list)  # free names other than x, in first-use order
    uses_x: bool = False
    notes: list[str] = field(default_factory=list)


# ----------------------------------------------------------------------------- tokenizer

_TOKEN = re.compile(r"\s*(?:(\d+\.\d*|\.\d+|\d+)(?:[eE]([+-]?\d+))?|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/^(),|=<>!{}\[\];:]))")
_UNICODE = {"π": "pi", "τ": "tau", "·": "*", "×": "*", "÷": "/", "−": "-", "²": "^2", "³": "^3", "√": "sqrt",
            "≤": "<", "≥": ">", "≠": "!"}


def _tokens(text: str) -> list[tuple[str, str]]:
    for k, v in _UNICODE.items():
        text = text.replace(k, v)
    out: list[tuple[str, str]] = []
    pos = 0
    text = text.rstrip()
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m or m.end() == pos:
            ch = text[pos:].lstrip()[:1]
            raise ExprError(f"Unexpected character {ch!r}.", "Use numbers, x, parameter names, + - * / ^ and functions like sin(x).")
        pos = m.end()
        if m.group(1) is not None:
            out.append(("num", m.group(0).strip()))
        elif m.group(3):
            out.append(("name", m.group(3)))
        else:
            out.append(("op", m.group(4)))
    return out


# ----------------------------------------------------------------------------- parser

class _Parser:
    def __init__(self, toks: list[tuple[str, str]], known_params: set[str], allow_x: bool):
        self.toks = toks
        self.i = 0
        self.known = known_params
        self.allow_x = allow_x
        self.params: list[str] = []
        self.uses_x = False
        self.notes: list[str] = []

    def peek(self, k: int = 0) -> tuple[str, str] | None:
        j = self.i + k
        return self.toks[j] if j < len(self.toks) else None

    def take(self) -> tuple[str, str]:
        t = self.peek()
        if t is None:
            raise ExprError("The expression ends too early.", "Check for a missing operand or closing parenthesis.")
        self.i += 1
        return t

    def expect(self, op: str) -> None:
        t = self.take()
        if t != ("op", op):
            raise ExprError(f"Expected {op!r} but found {t[1]!r}.")

    def parse(self) -> tuple:
        node = self.expr()
        t = self.peek()
        if t is not None:
            if t == ("op", ","):
                raise ExprError("Lists and parametric pairs aren't supported.", "Enter one explicit function of x, such as y = sin(x).")
            if t == ("op", "!"):
                raise ExprError("Factorials aren't supported.")
            raise ExprError(f"Unexpected {t[1]!r}.")
        return node

    def expr(self) -> tuple:
        node = self.term()
        while self.peek() in (("op", "+"), ("op", "-")):
            op = self.take()[1]
            node = ("bin", op, node, self.term())
        return node

    def _starts_atom(self, t: tuple[str, str] | None) -> bool:
        return t is not None and (t[0] in ("num", "name") or t == ("op", "("))

    def term(self) -> tuple:
        node = self.unary()
        while True:
            t = self.peek()
            if t in (("op", "*"), ("op", "/")):
                op = self.take()[1]
                node = ("bin", op, node, self.unary())
            elif self._starts_atom(t):  # implicit multiplication: 2x, 3(x+1), a sin(x)
                if node[0] == "num" and t[0] == "num":
                    raise ExprError(f"Two numbers in a row ({node[1]} {t[1]}).", "Add an operator between them.")
                node = ("bin", "*", node, self.unary())
            else:
                return node

    def unary(self) -> tuple:
        t = self.peek()
        if t == ("op", "-"):
            self.take()
            return ("neg", self.unary())
        if t == ("op", "+"):
            self.take()
            return self.unary()
        return self.power()

    def power(self) -> tuple:
        base = self.atom()
        if self.peek() in (("op", "^"), ("op", "**")):
            self.take()
            return ("bin", "^", base, self.unary())  # right-associative, binds tighter than unary minus on the left
        return base

    def atom(self) -> tuple:
        t = self.take()
        kind, val = t
        if kind == "num":
            return ("num", val)
        if t == ("op", "("):
            node = self.expr()
            self.expect(")")
            return node
        if t == ("op", "|"):
            node = self.expr()
            self.expect("|")
            return ("call", "abs", [node])
        if kind == "op":
            if val in "{[":
                raise ExprError("Piecewise definitions and brackets aren't supported.", "Use one expression; restrict the domain in the graph settings instead.")
            if val == "!":
                raise ExprError("Factorials aren't supported.")
            raise ExprError(f"Unexpected {val!r}.")
        return self.name(val)

    def name(self, val: str) -> tuple:
        low = val
        if low in FUNCTIONS:
            if self.peek() != ("op", "("):
                # sin x -> sin(x): take the next power-level operand
                arg = self.power()
                return ("call", low, [arg])
            self.take()
            args = [self.expr()]
            while self.peek() == ("op", ","):
                self.take()
                args.append(self.expr())
            self.expect(")")
            if len(args) != 1:
                raise ExprError(f"{low}() takes one argument.")
            return ("call", low, args)
        if low in CONSTANTS and low not in self.known:
            return ("const", low)
        if low == VARIABLE and (self.allow_x or low not in self.known):
            return self.var()
        if low == "y" and low not in self.known and self.allow_x:
            raise ExprError("y appears on the right-hand side, which makes this an implicit equation.",
                            "Only explicit functions y = f(x) are supported. Solve for y first.")
        if low in self.known:
            return self.param(low)
        # "ax" -> a*x, "abx" -> a*b*x: single letters glued to x (common in typed math).
        if "x" in low and re.fullmatch(r"[A-Za-z]+", low) and len(low) <= 4 and self.allow_x:
            parts = [self.var() if ch == "x" else self.param(ch) for ch in low]
            self.notes.append(f"Read {val!r} as {' * '.join(low)}.")
            node = parts[0]
            for p in parts[1:]:
                node = ("bin", "*", node, p)
            return node
        if self.peek() == ("op", "("):
            self.notes.append(f"Read {val}(…) as {val} · (…): {val} isn't a known function.")
        return self.param(low)

    def var(self) -> tuple:
        if not self.allow_x:
            raise ExprError("x isn't available here.", "Use numbers and parameter names only.")
        self.uses_x = True
        return ("var", VARIABLE)

    def param(self, name: str) -> tuple:
        if name not in self.params:
            self.params.append(name)
        return ("param", name)


def parse(text: str, known_params: set[str] | None = None, allow_x: bool = True) -> Expr:
    """Parse an expression (no ``y =`` prefix)."""
    if not text or not text.strip():
        raise ExprError("The expression is empty.")
    toks = _tokens(text)
    for t in toks:
        if t in (("op", "<"), ("op", ">")):
            raise ExprError("Inequalities aren't supported.", "Enter an explicit function such as y = x^2, then use 'Shade interval' for regions.")
        if t == ("op", "="):
            raise ExprError("Only one '=' is allowed, in the form y = f(x).")
        if t in (("op", ";"), ("op", ":")):
            raise ExprError(f"{t[1]!r} isn't supported.")
    p = _Parser(toks, set(known_params or ()), allow_x)
    ast = p.parse()
    return Expr(text=text.strip(), ast=ast, params=p.params, uses_x=p.uses_x, notes=p.notes)


def parse_function(text: str, known_params: set[str] | None = None) -> Expr:
    """Parse ``y = f(x)``, ``f(x) = …`` or a bare right-hand side as an explicit function of x."""
    src = (text or "").strip()
    if not src:
        raise ExprError("Enter a function, for example y = a*x^2 + b.")
    if src.count("=") > 1:
        raise ExprError("Only one '=' is allowed, in the form y = f(x).")
    if "=" in src:
        lhs, rhs = (s.strip() for s in src.split("=", 1))
        lhs_n = lhs.replace(" ", "")
        if lhs_n in ("y", "f(x)", "g(x)", "h(x)") or re.fullmatch(r"[A-Za-z]\(x\)", lhs_n):
            src = rhs
        elif lhs_n == "x":
            raise ExprError("x = … describes a vertical line or a function of y, which isn't supported.",
                            "Only explicit functions y = f(x) are supported for now.")
        elif lhs_n == "r":
            raise ExprError("Polar curves (r = …) aren't supported yet.", "Use manim's PolarPlane / ParametricFunction through the library for now.")
        elif lhs_n in ("(x,y)", "x,y"):
            raise ExprError("Parametric curves aren't supported yet.", "Use ParametricFunction from the library.")
        elif "y" in re.findall(r"[A-Za-z_]\w*", lhs) or "y" in re.findall(r"[A-Za-z_]\w*", rhs):
            raise ExprError("This is an implicit equation (y isn't alone on the left).",
                            "Only explicit functions y = f(x) are supported. Solve for y first, e.g. y = sqrt(1 - x^2).")
        else:
            raise ExprError(f"The left-hand side {lhs!r} isn't y or f(x).", "Write it as y = f(x).")
    expr = parse(src, known_params, allow_x=True)
    return expr


# ----------------------------------------------------------------------------- output

_PREC = {"+": 1, "-": 1, "*": 2, "/": 2, "neg": 3, "^": 4}


def to_python(node: tuple, param_source: dict[str, str] | None = None, x_source: str = "x") -> str:
    """Python source for the AST. ``param_source`` maps parameter names to Python (default ``name.get_value()``)."""
    ps = param_source or {}

    def go(n: tuple, parent: int = 0, right: bool = False) -> str:
        kind = n[0]
        if kind == "num":
            return n[1]
        if kind == "var":
            return x_source
        if kind == "const":
            return CONSTANTS[n[1]][0]
        if kind == "param":
            return ps.get(n[1], f"{n[1]}.get_value()")
        if kind == "call":
            fn = FUNCTIONS[n[1]]
            inner = go(n[2][0])
            out = f"({fn}({inner}))" if fn.startswith("1 /") else f"{fn}({inner})"
            return out
        if kind == "neg":
            s = "-" + go(n[1], _PREC["neg"])
            return f"({s})" if parent > _PREC["neg"] else s
        op = n[1]
        prec = _PREC[op]
        if op == "^":
            s = f"{go(n[2], prec, False)} ** {go(n[3], prec - 1, True)}"
        else:
            s = f"{go(n[2], prec)} {op} {go(n[3], prec, op in '-/')}"
        return f"({s})" if prec < parent or (right and prec == parent) else s

    return go(node)


def to_text(node: tuple) -> str:
    """Normalized math text (for display)."""
    return to_python(node, {}, "x").replace(".get_value()", "").replace("np.", "").replace("**", "^").replace("log10", "log").replace("arcsin", "asin").replace("arccos", "acos").replace("arctan", "atan")


def evaluate(node: tuple, x: np.ndarray | float, params: dict[str, float]) -> np.ndarray:
    """Evaluate with numpy (invalid operations give nan/inf, never raise)."""
    with np.errstate(all="ignore"):
        return np.asarray(_ev(node, x, params), dtype=float)


def _ev(n: tuple, x, ps: dict[str, float]):
    kind = n[0]
    if kind == "num":
        return float(n[1])
    if kind == "var":
        return x
    if kind == "const":
        return CONSTANTS[n[1]][1]
    if kind == "param":
        return float(ps.get(n[1], 1.0))
    if kind == "call":
        return _NUMPY[n[1]](_ev(n[2][0], x, ps))
    if kind == "neg":
        return -_ev(n[1], x, ps)
    a, b = _ev(n[2], x, ps), _ev(n[3], x, ps)
    op = n[1]
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return np.true_divide(a, b)
    return np.power(np.asarray(a, dtype=float), b)


def compile_value(text: str, params: set[str]) -> tuple[str, list[str]]:
    """Python for a scalar expression (no x) over known parameters; raises ExprError for unknown names."""
    e = parse(str(text), params, allow_x=False)
    unknown = [p for p in e.params if p not in params]
    if unknown:
        raise ExprError(f"Undefined parameter {unknown[0]!r}.", "Create it as a parameter (a ValueTracker) or use a number.")
    return to_python(e.ast), e.params


def compile_function(text: str, params: set[str], x_source: str = "x") -> tuple[str, list[str]]:
    """Python for the body of ``lambda x: …``; raises ExprError for unknown names."""
    e = parse_function(str(text), params)
    unknown = [p for p in e.params if p not in params]
    if unknown:
        raise ExprError(f"Undefined parameter {unknown[0]!r}.", "Create it as a parameter (a ValueTracker) or use a number.")
    return to_python(e.ast, x_source=x_source), e.params


def literal(text: str) -> float | None:
    """The value of a plain number (``2``, ``-1.5``), else None (drags only edit literals or single parameters)."""
    try:
        return float(str(text).strip())
    except ValueError:
        return None


# ----------------------------------------------------------------------------- analysis

def _refine_jump(f, a: float, b: float, threshold: float) -> float | None:
    """Bisect towards the largest jump in [a, b]; return its location if it stays a jump."""
    fa, fb = f(a), f(b)
    for _ in range(48):
        m = (a + b) / 2
        fm = f(m)
        left = abs(fm - fa) if np.isfinite(fm) and np.isfinite(fa) else math.inf
        right = abs(fb - fm) if np.isfinite(fm) and np.isfinite(fb) else math.inf
        if left >= right:
            b, fb = m, fm
        else:
            a, fa = m, fm
        if b - a < 1e-10:
            break
    jump = abs(fb - fa) if np.isfinite(fa) and np.isfinite(fb) else math.inf
    return (a + b) / 2 if jump > threshold else None


def analyze_function(text: str, params: dict[str, float] | None = None, domain: tuple[float, float] = (-5, 5),
                     y_range: tuple[float, float] | None = None, samples: int = 4001) -> dict:
    """Parse and sample an explicit function for the graph builder.

    Returns the parameters it needs (``undefined`` lists the ones not in ``params``), the Python
    lambda body, the sampled y extent, interior points where the function jumps (asymptotes or
    steps) as suggested ``discontinuities``, a ``gap`` (manim's ``dt``) that keeps asymptote
    branches inside ``y_range``, and intervals where the function is undefined.
    """
    params = dict(params or {})
    out: dict = {"ok": False, "error": None, "hint": "", "notes": [], "params": [], "undefined": [], "python": "",
                 "normalized": "", "discontinuities": [], "gap": None, "undefined_intervals": [], "y_extent": None,
                 "kind": "explicit"}
    try:
        e = parse_function(text, set(params))
    except ExprError as exc:
        out.update(error=exc.message, hint=exc.hint)
        return out
    out.update(ok=True, notes=e.notes, params=e.params, undefined=[p for p in e.params if p not in params],
               python=to_python(e.ast), normalized=to_text(e.ast))
    if not e.uses_x:
        out["notes"].append("The function doesn't depend on x, so it's a horizontal line.")
    lo, hi = float(domain[0]), float(domain[1])
    if not hi > lo:
        out["notes"].append("The domain is empty.")
        return out
    values = {p: params.get(p, 1.0) for p in e.params}
    xs = np.linspace(lo, hi, samples)
    ys = evaluate(e.ast, xs, values) * np.ones_like(xs)
    finite = np.isfinite(ys)
    if finite.any():
        out["y_extent"] = [float(np.min(ys[finite])), float(np.max(ys[finite]))]

    # Undefined intervals (sqrt/log of negatives, 0/0…).
    intervals = []
    i = 0
    while i < len(xs):
        if not finite[i]:
            j = i
            while j + 1 < len(xs) and not finite[j + 1]:
                j += 1
            if j > i:  # a single nan sample is a point singularity: handled as a discontinuity
                intervals.append([float(xs[i]), float(xs[j])])
            i = j + 1
        else:
            i += 1
    out["undefined_intervals"] = intervals
    if intervals:
        out["notes"].append("The function is undefined on part of the domain; manim can't plot through undefined values, "
                            "so narrow the domain to where it is defined.")

    # Jumps: a step between neighbouring samples far larger than typical that doesn't shrink when refined.
    f = lambda v: float(evaluate(e.ast, v, values))  # noqa: E731
    span = (y_range[1] - y_range[0]) if y_range else (out["y_extent"][1] - out["y_extent"][0] if out["y_extent"] else 1.0)
    span = max(span, 1e-6)
    dy = np.abs(np.diff(ys))
    typical = float(np.median(dy[np.isfinite(dy)])) if np.isfinite(dy).any() else 0.0
    threshold = max(typical * 50, span * 0.05)
    cands = []
    for k in range(len(xs) - 1):
        a_ok, b_ok = finite[k], finite[k + 1]
        if a_ok and b_ok and dy[k] <= threshold:
            continue
        if not a_ok and not b_ok:
            continue
        cands.append(k)
    found: list[float] = []
    for k in cands:
        loc =_refine_jump(f, float(xs[k]), float(xs[k + 1]), threshold)
        edge = (hi - lo) * 1e-6
        if loc is not None and lo + edge < loc < hi - edge and all(abs(loc - d) > (hi - lo) / samples * 3 for d in found):
            # Skip the boundaries of undefined intervals: those aren't jumps of a defined function.
            if any(a - 1e-6 <= loc <= b + 1e-6 for a, b in intervals):
                continue
            found.append(loc)
    found = [round(v, 6) + 0.0 for v in found]  # + 0.0 turns -0.0 into 0.0
    out["discontinuities"] = found

    # Gap: half-width removed around each discontinuity so asymptote branches end near the y-range.
    if found:
        limit = max(abs(y_range[0]), abs(y_range[1])) * 1.05 if y_range else max(abs(v) for v in out["y_extent"] or [1]) * 1.05
        gap = 1e-3
        for d in found:
            for side in (-1, 1):
                delta = 1e-4
                while delta < (hi - lo) / 4:
                    v = f(d + side * delta)
                    if np.isfinite(v) and abs(v) <= limit:
                        break
                    delta *= 1.25
                if delta < (hi - lo) / 4:
                    gap = max(gap, delta)
        out["gap"] = round(min(gap, (hi - lo) / 8), 4)
    return out
