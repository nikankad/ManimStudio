"""A small math expression language for the visual authoring tools.

Users type math, not Python: ``y = a*x^2 + b``, ``2sin(3x)``, ``sqrt(x)/x``.
This module parses that, explains unsupported syntax in plain words, turns it
into Python for the generated manim code (parameters become
``name.get_value()`` reads of their ValueTrackers), and analyses explicit
functions numerically (extent, undefined regions, discontinuities) for the
graph builder.

Only explicit 2D functions of ``x`` are supported. Implicit equations,
inequalities as curves and parametric/polar curves are rejected
with an explanation. Nothing here evaluates arbitrary Python.

Beyond the graph builder, expressions can use the scene's definitions (mathengine/defs.py): values and lists
(``ZEROS[k]``, counting from 1) and functions (``Z(t)``), and a few forms for writing them: ``sum(k, 1, n, 1/k^2)`` and
``prod(…)``, ``if(t < 10, 0, t)`` with comparisons, ``mod``, ``min``, ``max``, ``atan2``, ``round``, ``isprime``
and ``len``.
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
# functions of several arguments: name -> (numpy source, number of arguments)
MULTI: dict[str, tuple[str, int]] = {"mod": ("np.mod", 2), "min": ("np.minimum", 2), "max": ("np.maximum", 2),
                                     "atan2": ("np.arctan2", 2), "round": ("np.round", 1)}
SPECIAL = {"sum", "prod", "if", "isprime", "len"}  # forms with their own syntax
COMPARISONS = ("<", "<=", ">", ">=", "==", "!=")
# the Python of the helpers an expression can need (written once at the top of the scene's file)
HELPERS = {"isprime": (
    "def isprime(n):\n"
    "    n = int(n)\n"
    "    return n > 1 and all(n % d for d in range(2, int(n ** 0.5) + 1))\n"
)}
RESERVED = set(FUNCTIONS) | set(CONSTANTS) | set(MULTI) | SPECIAL | {VARIABLE, "y"}


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
    names: list[str] = field(default_factory=list)  # definitions it uses (mathengine/defs.py)
    helpers: set[str] = field(default_factory=set)  # HELPERS it needs


# ----------------------------------------------------------------------------- tokenizer

_TOKEN = re.compile(r"\s*(?:(\d+\.\d*|\.\d+|\d+)(?:[eE]([+-]?\d+))?|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|<=|>=|==|!=|[-+*/^(),|=<>!{}\[\];:]))")
_UNICODE = {"π": "pi", "τ": "tau", "·": "*", "×": "*", "÷": "/", "−": "-", "²": "^2", "³": "^3", "√": "sqrt",
            "≤": "<=", "≥": ">=", "≠": "!="}


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
    def __init__(self, toks: list[tuple[str, str]], known_params: set[str], allow_x: bool,
                 scope: dict[str, tuple] | None = None, local: set[str] | None = None):
        self.toks = toks
        self.i = 0
        self.known = known_params
        self.allow_x = allow_x
        self.params: list[str] = []
        self.uses_x = False
        self.notes: list[str] = []
        # definitions: name -> ("value",) | ("list",) | ("func", number of inputs); local: a function's inputs and
        # where-names, a sum's index
        self.scope = scope or {}
        self.local = set(local or ())
        self.names: list[str] = []
        self.helpers: set[str] = set()

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
        node = self.cmp()
        t = self.peek()
        if t is not None:
            if t == ("op", ","):
                raise ExprError("Lists and parametric pairs aren't supported.", "Enter one explicit function of x, such as y = sin(x).")
            if t == ("op", "!"):
                raise ExprError("Factorials aren't supported.")
            raise ExprError(f"Unexpected {t[1]!r}.")
        return node

    def cmp(self) -> tuple:
        """An expression, or a comparison of two (``t < 10``: true or false, for if())."""
        node = self.expr()
        t = self.peek()
        if t is not None and t[0] == "op" and t[1] in COMPARISONS:
            op = self.take()[1]
            node = ("cmp", op, node, self.expr())
        return node

    def args(self, name: str, count: int | None = None) -> list[tuple]:
        """``(a, b, …)`` after a function's name."""
        self.expect("(")
        out = [self.cmp()]
        while self.peek() == ("op", ","):
            self.take()
            out.append(self.cmp())
        self.expect(")")
        if count is not None and len(out) != count:
            raise ExprError(f"{name}() takes {count} input{'s' if count != 1 else ''}, not {len(out)}.")
        return out

    def special(self, val: str) -> tuple:
        if val in ("sum", "prod"):
            self.expect("(")
            t = self.take()
            if t[0] != "name":
                raise ExprError(f"{val}() starts with the name of its index: {val}(k, 1, n, …).")
            var = t[1]
            self.expect(",")
            lo = self.expr()
            self.expect(",")
            hi = self.expr()
            self.expect(",")
            had = var in self.local
            self.local.add(var)
            body = self.cmp()
            if not had:
                self.local.discard(var)
            self.expect(")")
            return ("sum", val, var, lo, hi, body)
        if val == "if":
            c, a, b = self.args("if", 3)
            return ("if", c, a, b)
        if val == "isprime":
            self.helpers.add("isprime")
            return ("isprime", self.args("isprime", 1)[0])
        # len(list)
        self.expect("(")
        t = self.take()
        if t[0] != "name" or self.scope.get(t[1], ("",))[0] != "list":
            raise ExprError("len() takes the name of a list.")
        self.expect(")")
        self.names.append(t[1]) if t[1] not in self.names else None
        return ("len", t[1])

    def defined(self, val: str) -> tuple:
        sym = self.scope[val]
        if val not in self.names:
            self.names.append(val)
        if sym[0] == "list":
            if self.peek() != ("op", "["):
                raise ExprError(f"{val} is a list: use one of its items, {val}[1] (the first), {val}[k]…")
            self.take()
            k = self.expr()
            self.expect("]")
            return ("index", val, k)
        if sym[0] == "func":
            if self.peek() != ("op", "("):
                raise ExprError(f"{val} is a function: give it its input{'s' if sym[1] != 1 else ''}, {val}(…).")
            return ("ucall", val, self.args(val, sym[1]))
        return ("name", val)

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
            node = self.cmp()
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
        if low in self.local:
            return ("name", low)
        if low in self.scope:
            return self.defined(low)
        if low in SPECIAL and self.peek() == ("op", "("):
            return self.special(low)
        if low in MULTI and self.peek() == ("op", "("):
            fn, count = MULTI[low]
            return ("mcall", low, self.args(low, count))
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


def parse(text: str, known_params: set[str] | None = None, allow_x: bool = True,
          scope: dict[str, tuple] | None = None, local: set[str] | None = None) -> Expr:
    """Parse an expression (no ``y =`` prefix). ``scope``: the definitions it can use; ``local``: plain names it can
    use (a function's inputs)."""
    if not text or not text.strip():
        raise ExprError("The expression is empty.")
    toks = _tokens(text)
    depth = 0
    for t in toks:
        if t[0] == "op" and t[1] in "([":
            depth += 1
        elif t[0] == "op" and t[1] in ")]":
            depth -= 1
        elif t[0] == "op" and t[1] in COMPARISONS and depth == 0 and allow_x:
            raise ExprError("Inequalities aren't supported.", "Enter an explicit function such as y = x^2, then use 'Shade interval' "
                            "for regions. (A comparison can choose between two values: if(x < 0, -x, x).)")
        if t == ("op", "="):
            raise ExprError("Only one '=' is allowed, in the form y = f(x).")
        if t in (("op", ";"), ("op", ":")):
            raise ExprError(f"{t[1]!r} isn't supported.")
    p = _Parser(toks, set(known_params or ()), allow_x, scope, local)
    ast = p.parse()
    return Expr(text=text.strip(), ast=ast, params=p.params, uses_x=p.uses_x, notes=p.notes, names=p.names, helpers=p.helpers)


def parse_function(text: str, known_params: set[str] | None = None, scope: dict[str, tuple] | None = None) -> Expr:
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
    expr = parse(src, known_params, allow_x=True, scope=scope)
    return expr


# ----------------------------------------------------------------------------- output

_PREC = {"+": 1, "-": 1, "*": 2, "/": 2, "neg": 3, "^": 4}


def to_python(node: tuple, param_source: dict[str, str] | None = None, x_source: str = "x", _math: bool = False) -> str:
    """Python source for the AST. ``param_source`` maps parameter names to Python (default ``name.get_value()``).
    (``_math``: the forms of the math language instead, for to_text.)"""
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
        if kind == "name":
            return n[1]
        if kind == "index":  # lists count from 1, as in math: ZEROS[1] is the first
            k = n[2]
            if _math:
                return f"{n[1]}[{go(k)}]"
            if k[0] == "num" and re.fullmatch(r"\d+", k[1]):
                return f"{n[1]}[{int(k[1]) - 1}]"
            return f"{n[1]}[int({go(k)}) - 1]"
        if kind == "ucall":
            return f"{n[1]}({', '.join(go(a) for a in n[2])})"
        if kind == "mcall":
            if _math:
                return f"{n[1]}({', '.join(go(a) for a in n[2])})"
            return f"{MULTI[n[1]][0]}({', '.join(go(a) for a in n[2])})"
        if kind == "isprime":
            return f"isprime({go(n[1])})"
        if kind == "len":
            return f"len({n[1]})"
        if kind == "cmp":
            s = f"{go(n[2], 1)} {n[1]} {go(n[3], 1)}"
            return f"({s})" if parent > 0 else s
        if kind == "if":
            if _math:
                return f"if({go(n[1])}, {go(n[2])}, {go(n[3])})"
            return f"({go(n[2])} if {go(n[1])} else {go(n[3])})"
        if kind == "sum":
            _, op, var, lo, hi, body = n
            if _math:
                return f"{op}({var}, {go(lo)}, {go(hi)}, {go(body)})"
            whole = lambda b: b[0] == "num" and re.fullmatch(r"\d+", b[1])  # noqa: E731
            start = lo[1] if whole(lo) else f"int({go(lo)})"
            stop = str(int(hi[1]) + 1) if whole(hi) else f"int({go(hi)}) + 1"
            gen = f"{go(body)} for {var} in range({start}, {stop})"
            return f"sum({gen})" if op == "sum" else f"np.prod([{gen}])"
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
    return to_python(node, {}, "x", _math=True).replace(".get_value()", "").replace("np.", "").replace("**", "^").replace("log10", "log").replace("arcsin", "asin").replace("arccos", "acos").replace("arctan", "atan")


_PLAIN = {"num", "var", "const", "param", "call", "neg", "bin"}


def _plain(node) -> bool:
    """Whether the expression only uses what numpy evaluates on whole arrays (no sums, ifs, definitions…)."""
    if not isinstance(node, tuple) or not node:
        return True
    if isinstance(node[0], str) and node[0] in ("num", "var", "const", "param"):
        return True
    if node[0] not in _PLAIN:
        return False
    return all(_plain(c) for part in node[1:] for c in (part if isinstance(part, list) else [part]) if isinstance(c, tuple))


def evaluate(node: tuple, x: np.ndarray | float, params: dict[str, float], namespace: dict | None = None) -> np.ndarray:
    """Evaluate with numpy (invalid operations give nan/inf, never raise). ``namespace``: the definitions'
    Python (mathengine/defs.py), for expressions that use them; those are evaluated point by point."""
    with np.errstate(all="ignore"):
        if _plain(node):
            return np.asarray(_ev(node, x, params), dtype=float)
        ns = {"np": np, "isprime": _isprime, **(namespace or {})}
        f = eval(f"lambda x, _p: {to_python(node, {k: f'_p[{k!r}]' for k in params})}", ns)  # our own Python, from the AST

        def one(v):
            try:
                return float(f(v, params))
            except Exception:  # an undefined value (log of 0, an index past the end…) is a gap in the graph
                return math.nan
        return np.vectorize(one, otypes=[float])(x)


def _isprime(n) -> bool:
    n = int(n)
    return n > 1 and all(n % d for d in range(2, int(n ** 0.5) + 1))


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


def compile_value(text: str, params: set[str], scope: dict[str, tuple] | None = None,
                  helpers: set[str] | None = None) -> tuple[str, list[str]]:
    """Python for a scalar expression (no x) over known parameters and definitions; raises ExprError for unknown
    names. ``helpers`` collects the HELPERS it needs."""
    e = parse(str(text), params, allow_x=False, scope=scope)
    if helpers is not None:
        helpers.update(e.helpers)
    unknown = [p for p in e.params if p not in params]
    if unknown:
        raise ExprError(f"Undefined parameter {unknown[0]!r}.", "Create it as a parameter (a ValueTracker) or a definition (Scene › Definitions), or use a number.")
    return to_python(e.ast), e.params


def compile_function(text: str, params: set[str], x_source: str = "x", scope: dict[str, tuple] | None = None,
                     helpers: set[str] | None = None) -> tuple[str, list[str]]:
    """Python for the body of ``lambda x: …``; raises ExprError for unknown names."""
    e = parse_function(str(text), params, scope)
    if helpers is not None:
        helpers.update(e.helpers)
    unknown = [p for p in e.params if p not in params]
    if unknown:
        raise ExprError(f"Undefined parameter {unknown[0]!r}.", "Create it as a parameter (a ValueTracker) or a definition (Scene › Definitions), or use a number.")
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
                     y_range: tuple[float, float] | None = None, samples: int = 4001,
                     scope: dict[str, tuple] | None = None, namespace: dict | None = None) -> dict:
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
        e = parse_function(text, set(params), scope)
    except ExprError as exc:
        out.update(error=exc.message, hint=exc.hint)
        return out
    if not _plain(e.ast):
        samples = min(samples, 801)  # evaluated point by point
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
    ys = evaluate(e.ast, xs, values, namespace) * np.ones_like(xs)
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
    f = lambda v: float(evaluate(e.ast, v, values, namespace))  # noqa: E731
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
