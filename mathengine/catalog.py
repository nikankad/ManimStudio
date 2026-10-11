"""Introspect manim to build the GUI palette and property forms.

Nothing here is hand-curated per class except `FEATURED` (palette ordering and
starter arguments); every Mobject/Animation exported by manim, plus any class
defined in the project's header code, is available with its real signature.
"""

from __future__ import annotations

import ast
import enum
import functools
import inspect
import textwrap
import re
import typing
from typing import Any

import numpy as np

from .runtime import manim

# Starter arguments for popular classes so a drag-and-drop gives something visible.
FEATURED_MOBJECTS: dict[str, dict[str, str]] = {
    "Circle": {"color": "BLUE"},
    "Square": {"color": "YELLOW"},
    "Rectangle": {"width": "4", "height": "2", "color": "GREEN"},
    "Triangle": {"color": "TEAL"},
    "RegularPolygon": {"n": "6", "color": "PURPLE"},
    "Star": {"color": "GOLD"},
    "Ellipse": {"width": "3", "height": "1.5"},
    "Arc": {"radius": "1", "angle": "PI"},
    "Line": {"start": "LEFT", "end": "RIGHT"},
    "Arrow": {"start": "LEFT", "end": "RIGHT"},
    "DoubleArrow": {"start": "LEFT", "end": "RIGHT"},
    "Vector": {"*": "[2, 1]"},
    "Dot": {},
    "MathTex": {"*": 'r"e^{i\\pi} + 1 = 0"'},
    "Tex": {"*": 'r"Hello \\LaTeX"'},
    "Text": {"*": '"Hello"'},
    "MarkupText": {"*": '"<b>Bold</b> idea"'},
    "DecimalNumber": {"*": "3.14159", "num_decimal_places": "2"},
    "Integer": {"*": "42"},
    "Axes": {"x_range": "[-5, 5, 1]", "y_range": "[-3, 3, 1]", "x_length": "10", "y_length": "6"},
    "NumberPlane": {},
    "NumberLine": {"x_range": "[-5, 5, 1]", "include_numbers": "True"},
    "ComplexPlane": {},
    "PolarPlane": {},
    "Matrix": {"*": "[[1, 2], [3, 4]]"},
    "BarChart": {"values": "[3, 5, 2, 7]"},
    "ParametricFunction": {"function": "lambda t: np.array([np.cos(t), np.sin(2 * t), 0])", "t_range": "[0, TAU]"},
    "FunctionGraph": {"function": "lambda x: np.sin(x)", "x_range": "[-PI, PI]"},
    "Brace": {"mobject": "@target", "direction": "DOWN"},
    "SurroundingRectangle": {"*": "@target"},
    "BackgroundRectangle": {"*": "@target"},
    "Underline": {"mobject": "@target"},
    "Cross": {"mobject": "@target"},
    "VGroup": {},
    "Code": {"code_string": '"print(\'hello\')"', "language": '"python"'},
    "Sector": {"radius": "2", "angle": "PI / 3"},
    "Annulus": {},
    "AnnularSector": {},
    "RoundedRectangle": {"corner_radius": "0.3"},
    "Polygon": {"*": "UP * 2, DL * 2, DR * 2"},
    "ValueTracker": {"*": "0"},
    "ConvexHull": {"*": "UP * 2, DL * 2, DR * 2, RIGHT * 2"},
    "Graph": {"vertices": "[1, 2, 3, 4]", "edges": "[(1, 2), (2, 3), (3, 4), (4, 1)]"},
    "Angle": {"line1": "Line(ORIGIN, RIGHT * 2)", "line2": "Line(ORIGIN, UR * 2)"},
}

FEATURED_ANIMATIONS = [
    "Create", "Write", "FadeIn", "FadeOut", "Transform", "ReplacementTransform",
    "TransformMatchingTex", "TransformMatchingShapes", "GrowFromCenter", "DrawBorderThenFill",
    "Uncreate", "Unwrite", "Indicate", "Circumscribe", "Flash", "Wiggle", "FocusOn",
    "ShowPassingFlash", "Rotate", "SpinInFromNothing", "GrowArrow", "MoveAlongPath",
    "ApplyWave", "ShrinkToCenter", "FadeTransform", "CounterclockwiseTransform", "ClockwiseTransform",
]

# Animation classes that don't take a single mobject as first argument.
SKIP_ANIMATIONS = {"Animation", "AnimationGroup", "LaggedStart", "LaggedStartMap", "Succession", "Wait", "Add",
                   "ApplyPointwiseFunctionToCenter"}  # broken in manim itself: never passes its mobject on

COMMON_METHODS = [
    "shift", "move_to", "next_to", "to_edge", "to_corner", "align_to", "scale", "rotate", "flip",
    "stretch", "set_color", "set_fill", "set_stroke", "set_opacity", "set_z_index", "arrange",
    "arrange_in_grid", "match_height", "match_width", "set_width", "set_height", "add_updater",
    "add_background_rectangle", "set_color_by_gradient", "become", "fade", "center",
]

DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT", "UL", "UR", "DL", "DR", "ORIGIN", "IN", "OUT"]


# The animated mobject is the clip's target, not a form field.
TARGET_PARAMS = {"mobject", "mobjects", "vmobject"}

# Dict-valued kwargs whose keys are the kwargs of a known class (or method):
# the GUI edits them with that signature's fields.
DICT_HINTS = {
    "axis_config": "NumberLine", "x_axis_config": "NumberLine", "y_axis_config": "NumberLine",
    "z_axis_config": "NumberLine", "background_line_style": "Line", "faded_line_style": "Line",
    "line_config": "Line", "edge_config": "Line", "brace_config": "Brace", "vector_config": "Vector",
    "tip_style": "ArrowTriangleFilledTip", "decimal_number_config": "DecimalNumber",
    "paragraph_config": "Paragraph", "vertex_config": "Dot", "faces_config": "Polygon",
    "arrange_in_grid_config": "VGroup.arrange_in_grid", "background_config": "Rectangle",
    "frame_config": "Rectangle", "box_config": "Rectangle",
}
COLOR_MAPS = {"t2c", "tex_to_color_map"}
TEXT_WEIGHTS = ["NORMAL", "BOLD", "THIN", "ULTRALIGHT", "LIGHT", "SEMILIGHT", "BOOK", "MEDIUM",
                "SEMIBOLD", "ULTRABOLD", "HEAVY", "ULTRAHEAVY"]
NAME_OPTIONS = {
    "weight": TEXT_WEIGHTS,
    "slant": ["NORMAL", "ITALIC", "OBLIQUE"],
    "alignment": ['"left"', '"center"', '"right"'],
    "azimuth_units": ['"PI radians"', '"TAU radians"', '"degrees"', '"gradians"', "None"],
    "azimuth_direction": ['"CCW"', '"CW"'],
    "tex_environment": ['"align*"', '"center"', '"equation*"', '"gather*"', '"flushleft"', '"flushright"', "None"],
    "language": ['"python"', '"javascript"', '"typescript"', '"c"', '"cpp"', '"rust"', '"go"', '"java"',
                 '"haskell"', '"julia"', '"latex"', '"bash"', '"json"', '"html"', '"css"', '"sql"'],
}
PATH_PARAMS = {"file_name", "code_file", "filename_or_array", "background_image"}
SCALE_OPTIONS = ["LinearBase()", "LogBase()", "LogBase(base=10, custom_labels=True)"]
# Classes users pass as references to other mobjects.
_MOB_REF = ("Mobject", "VMobject", "Line", "Arc", "Group", "VGroup", "MovingCamera", "Rectangle", "Square", "CoordinateSystem")


def _expr_repr(value: Any, colors: dict[str, str], dirs: dict[tuple, str], depth: int = 0) -> str:
    """Python-source representation of a default value."""
    m = manim()
    if value is inspect.Parameter.empty:
        return ""
    if isinstance(value, m.ManimColor):
        hexv = value.to_hex().upper()
        return colors.get(hexv, repr(hexv))
    if isinstance(value, enum.Enum):
        return f"{type(value).__name__}.{value.name}"
    if isinstance(value, np.ndarray):
        key = tuple(np.round(value.astype(float), 6).tolist()) if value.ndim == 1 else None
        if key in dirs:
            return dirs[key]
        return f"np.array({np.round(value, 6).tolist()!r})"
    if isinstance(value, (list, tuple)) and depth < 2 and len(value) <= 12:
        inner = ", ".join(_expr_repr(v, colors, dirs, depth + 1) for v in value)
        return f"[{inner}]" if isinstance(value, list) else f"({inner}{',' if len(value) == 1 else ''})"
    if isinstance(value, dict) and depth < 2 and len(value) <= 12:
        return "{" + ", ".join(f"{k!r}: {_expr_repr(v, colors, dirs, depth + 1)}" for k, v in value.items()) + "}"
    if callable(value) and hasattr(value, "__name__"):
        return "" if value.__name__ == "<lambda>" else value.__name__
    r = repr(value)
    if r.startswith("<") and type(value).__name__ in vars(m):
        return f"{type(value).__name__}()"
    return r if len(r) < 120 else r[:117] + "..."


def _names_in(ann: str) -> list[str]:
    return re.findall(r"[A-Za-z_][A-Za-z0-9_]*", ann)


def _callable_template(ann: str, name: str) -> str:
    """A working starter lambda for a callable parameter (never `...`, which would be Ellipsis)."""
    inner = re.match(r"Callable\[\[([^\]]*)\],\s*(.*)\]$", re.sub(r"\s*\|\s*None$", "", ann))
    argt = [a.strip() for a in inner.group(1).split(",") if a.strip()] if inner else []
    ret = inner.group(2) if inner else ""
    n = len(argt) or 1
    if "homotopy" in name:
        return "lambda x, y, z, t: (x, y + 0.2 * np.sin(x + t), z)"
    if name == "length_func":
        return "lambda norm: min(norm, 0.5)"
    if argt and ("Point3D" in argt[0] or "Vector3D" in argt[0]):  # vector fields, color schemes
        return "lambda p: np.linalg.norm(p)" if "float" in ret else "lambda p: np.array([-p[1], p[0], 0])"
    if n == 1 and ("Point3D" in ret or "ndarray" in ret or name == "function" and "Point" in ann):
        return "lambda t: np.array([np.cos(t), np.sin(t), 0])"
    if n == 2 and "ndarray" in ret:
        return "lambda u, v: np.array([u, v, 0.3 * np.sin(u * v)])"
    if n == 2:
        return "lambda x, y: x**2 + y**2 - 4"
    if n == 4:
        return "lambda x, y, z, t: (x, y, z)"
    if "VMobject" in ret or "Mobject" in ret:
        return "lambda value: MathTex(value)"
    return "lambda x: np.sin(x)"


def classify(name: str, default: Any, annotation: str) -> dict:
    """GUI field kind for a parameter, with any choices/hints the control needs."""
    m = manim()
    ns = vars(m)
    ann = annotation.replace("typing.", "")
    low = ann.lower()
    names = _names_in(ann)
    is_int = ann.startswith("int") and "float" not in ann

    if name == "rate_func" or name.endswith("_rate_func") or name == "wave_func" or "RateFunction" in ann:
        return {"kind": "rate_func"}
    if name in PATH_PARAMS:
        return {"kind": "path"}
    if ann.startswith("type[") or "| type[" in ann:
        return {"kind": "choice", "options": _class_options(name, [ns[n] for n in names if isinstance(ns.get(n), type)])}
    if "Resampling" in ann:
        return {"kind": "choice", "options": [f'RESAMPLING_ALGORITHMS["{k}"]' for k in ("nearest", "bilinear", "bicubic")]}
    if "AngleQuadrant" in ann or (name == "corner" and isinstance(default, tuple) and default == (1, 1)):
        return {"kind": "choice", "options": ["(1, 1)", "(1, -1)", "(-1, 1)", "(-1, -1)"]}
    if name == "depth" and ann == "Any":
        return {"kind": "number"}
    if isinstance(default, enum.Enum) or any(isinstance(ns.get(n), type) and issubclass(ns[n], enum.Enum) for n in names):
        cls = type(default) if isinstance(default, enum.Enum) else next(ns[n] for n in names if isinstance(ns.get(n), type) and issubclass(ns[n], enum.Enum))
        if cls.__name__ not in ns:
            return {"kind": "expr"}
        return {"kind": "choice", "options": [f"{cls.__name__}.{e.name}" for e in cls]}
    if "TexTemplate" in ann:
        fonts = sorted(n for n in dir(m.TexFontTemplates) if not n.startswith("_"))
        return {"kind": "choice", "options": [f"TexTemplateLibrary.{n}" for n in ("default", "simple", "threeb1b", "ctex")]
                + [f"TexFontTemplates.{n}" for n in fonts]}
    if "se.Path" in ann:
        return {"kind": "svgpath"}
    if re.fullmatch(r"Animation( \| None)?", ann):
        return {"kind": "animation"}
    if ann.startswith("list[dict]"):
        out = {"kind": "dicts"}
        if name == "arc_config":
            out["hint"] = "Arc"
        return out
    if "MethodType" in ann or "MappingFunction" in ann:
        return {"kind": "function", "template": "lambda p: p + 0.2 * np.sin(p)"}
    if "_Updater" in ann:
        return {"kind": "function", "template": "lambda m, dt: m.rotate(dt)"}
    if name == "condition" and "NDArray" in ann:
        return {"kind": "function", "template": "lambda p: p[0] > 0"}
    if ann == "MatrixMN":
        return {"kind": "matrix"}
    if re.search(r"tuple\[Hashable, Hashable\]", ann) or (name == "*" and ann.startswith("tuple[Hashable")):
        return {"kind": "pairs"}
    if re.search(r"(list|Sequence)\[(list\[|Sequence\[)?Hashable", ann):
        return {"kind": "values"}
    if re.fullmatch(r"(Hashable|tuple\[Hashable\])( \| None)?", ann) and name != "*":
        return {"kind": "vertex" if name == "root_vertex" else "key"}
    if name == "alpha" and ann == "Any":
        return {"kind": "number"}
    if ann.startswith("complex"):
        return {"kind": "number"}
    if "_ScaleBase" in ann:
        return {"kind": "choice", "options": SCALE_OPTIONS}
    lit = re.search(r"Literal\[([^\]]*)\]", ann)
    if lit and "False" not in lit.group(1):
        return {"kind": "choice", "options": [o.strip() for o in lit.group(1).split(",")]}
    if "LayoutName" in ann:
        from manim.mobject.graph import LayoutName
        return {"kind": "choice", "options": [repr(o) for o in typing.get_args(LayoutName)]}
    if "AngleQuadrant" in ann:
        return {"kind": "choice", "options": ["(1, 1)", "(1, -1)", "(-1, 1)", "(-1, -1)"]}
    if name in ("matrix", "table") and ("Iterable[Iterable" in ann or "ndarray" in ann or ann == "MatrixMN"):
        return {"kind": "matrix"}
    if name in NAME_OPTIONS:
        return {"kind": "choice", "options": NAME_OPTIONS[name]}
    if name == "font" and low.startswith("str"):
        return {"kind": "choice", "options": _fonts()}
    if name == "formatter_style":
        try:
            from pygments.styles import get_all_styles
            return {"kind": "choice", "options": sorted(repr(s) for s in get_all_styles())}
        except Exception:
            return {"kind": "string"}
    if "ParsableManimColor" in ann and "Literal[False]" in ann:
        return {"kind": "colors"}  # a color list, or False (via {} raw) to switch it off
    if isinstance(default, bool) or low in ("bool", "bool | none"):
        return {"kind": "bool"}
    if ann.startswith("Callable") or (" | Callable" in ann and "Mobject" not in ann):
        return {"kind": "function", "template": _callable_template(ann, name)}
    if name in COLOR_MAPS or re.match(r"dict\[str, ParsableManimColor\]", ann):
        return {"kind": "colormap"}
    if isinstance(default, dict) or low.startswith("dict") or name in DICT_HINTS:
        out: dict = {"kind": "dict"}
        if name in DICT_HINTS:
            out["hint"] = DICT_HINTS[name]
        return out
    if name.endswith("color") or isinstance(default, m.ManimColor) or low.startswith(("parsablemanimcolor", "manimcolor")):
        return {"kind": "color"}
    if re.search(r"(Iterable|Sequence|list)\[ParsableManimColor", ann) or name.endswith("colors"):
        return {"kind": "colors"}
    if "Point3DLike_Array" in ann or (name == "*" and "Point3DLike" in ann and "Mobject" not in ann):
        return {"kind": "points"}
    refs = [n for n in names if n in _MOB_REF or n == "OpenGLGroup" or _mobject_class(n)]
    if refs and not re.search(r"Point3D|Point2D|Vector|ndarray", ann) and "type[" not in ann and "Callable" not in ann:
        many = name == "*" or "Iterable[" in ann or name in ("mobjects",)
        out = {"kind": "mobjects" if many else "mobject"}
        accepts = _accepts(refs)
        if accepts:
            out["accepts"] = accepts
        return out
    if name.endswith("_range") and re.search(r"Sequence|tuple|list", ann):
        return {"kind": "range"}
    if name == "coords" and "ManimFloat" in ann:
        return {"kind": "vector"}
    if re.search(r"(Iterable|Sequence|MutableSequence|list)\[(float|int)", ann) and not ann.startswith(("int", "float")):
        return {"kind": "numbers"}
    if isinstance(default, (int, float)) and not isinstance(default, bool) or ann.startswith(("float", "int")):
        return {"kind": "number", "int": is_int or (isinstance(default, int) and not ann)}
    if re.search(r"(Iterable|Sequence|list)\[str", ann):
        return {"kind": "strings"}
    if isinstance(default, np.ndarray) or re.search(r"Point3D|Point2D|Vector3D|Vector2D|np\.ndarray|NDArray", ann):
        return {"kind": "vector", "objects": "Mobject" in ann}
    if name.endswith("_range") and isinstance(default, (tuple, list)):
        return {"kind": "range"}
    if isinstance(default, str) or low.startswith(("str", "strpath")):
        return {"kind": "string"}
    return {"kind": "expr"}


TEXT_LIKE = ("MathTex", "Tex", "Text", "MarkupText", "Paragraph", "DecimalNumber", "Integer", "SingleStringMathTex")


def _class_options(name: str, bases: list[type]) -> list[str]:
    """Classes a ``type[...]`` parameter can sensibly take, given the role its name implies."""
    m = manim()
    if len(re.findall(r"type\[", " ".join(b.__name__ for b in bases))) == 0 and name == "shape":
        return sorted(b.__name__ for b in bases)  # Circumscribe checks `shape is Rectangle/Circle` exactly
    if not bases:
        return list(TEXT_LIKE) if name in ("element_to_mobject", "label_constructor", "mob_class", "var_type") else []
    cands = [c for c in vars(m).values() if isinstance(c, type) and issubclass(c, tuple(bases))
             and not c.__name__.startswith(("OpenGL", "_"))]
    if name in ("element_to_mobject", "label_constructor", "mob_class", "var_type"):
        cands = [c for c in cands if c.__name__ in TEXT_LIKE]  # built from a single value
    elif name == "edge_type":
        cands = [c for c in cands if issubclass(c, m.Line) and not issubclass(c, m.NumberLine) and _no_required(c)
                 and {"start", "end"} <= {p["name"] for p in class_params(c)}
                 and not any(p["required"] for p in class_params(c))]
    elif name == "vertex_type":
        cands = [c for c in cands if issubclass(c, m.VMobject) and _builds_bare(c.__name__)]
    else:
        cands = [c for c in cands if _no_required(c)]
    return sorted({c.__name__ for c in cands})


@functools.lru_cache(maxsize=None)
def _fonts() -> list[str]:
    """Fonts Pango (manim's Text renderer) can use on this machine."""
    try:
        import manimpango

        return [repr(f) for f in sorted(set(manimpango.list_fonts()), key=str.lower) if not f.startswith(".")]
    except Exception:
        return ['"sans-serif"', '"serif"', '"monospace"']


@functools.lru_cache(maxsize=None)
def _builds_bare(name: str) -> bool:
    """Whether ``Cls()`` works (and quickly): Graph vertex types are built with no arguments."""
    m = manim()
    cls = vars(m).get(name)
    if not isinstance(cls, type) or not _no_required(cls) or "three_d" in cls.__module__ or "text" in cls.__module__:
        return False
    try:
        mob = cls()
        return isinstance(mob, m.VMobject) and len(mob.get_family()) > 0 and mob.has_points() or bool(mob.submobjects)
    except Exception:
        return False


def _no_required(cls: type) -> bool:
    try:
        params = list(inspect.signature(cls.__init__).parameters.values())[1:]
    except (TypeError, ValueError):
        return False
    return all(p.default is not inspect.Parameter.empty or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD) for p in params)


# Mobject plumbing: changing these breaks point storage (dim=2, cubic curves of other orders).
INTERNAL_PARAMS = {"dim", "n_points_per_cubic_curve"}


GENERIC_REFS = {"Mobject", "VMobject", "Group", "VGroup", "OpenGLGroup", "OpenGLVGroup", "OpenGLMobject", "OpenGLVMobject"}


def _accepts(refs: list[str]) -> list[str]:
    """Classes an object reference must be (Angle.line1 -> Line and subclasses); [] when any mobject will do."""
    m = manim()
    ns = vars(m)
    if any(r in GENERIC_REFS for r in refs):
        return []
    bases = tuple(ns[r] for r in refs if isinstance(ns.get(r), type))
    if not bases:
        return []
    return sorted(n for n, c in ns.items() if isinstance(c, type) and issubclass(c, bases) and not n.startswith(("OpenGL", "_")))


def _ann_str(p: inspect.Parameter) -> str:
    a = p.annotation
    if a is inspect.Parameter.empty:
        return ""
    return a if isinstance(a, str) else getattr(a, "__name__", str(a))


def _param(p: inspect.Parameter, name: str, label: str, source: str, required: bool) -> dict:
    colors, dirs = _lookup_tables()
    ann = _ann_str(p)
    out = {"name": name, "label": label, "default": _expr_repr(p.default, colors, dirs),
           "required": required, "annotation": ann, "from": source}
    out.update(classify(name, p.default, ann))
    return out


@functools.lru_cache(maxsize=None)
def _super_call(klass: type) -> tuple[int, frozenset[str], bool, bool]:
    """What ``klass.__init__`` hands its parent.

    Returns (positional count, keyword names it sets itself, forwards **kwargs, forwards *args).
    Parent parameters the subclass fills in (``Square`` sets Rectangle's ``height``/``width``,
    ``Brace`` builds ``path_obj``) are not real options of the subclass, so the forms hide them;
    when **kwargs isn't forwarded to the parent at all (``Flash`` sends it to child animations),
    the parent's parameters aren't options either.
    """
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(klass.__dict__["__init__"])))
    except (OSError, TypeError, SyntaxError, KeyError):
        return 0, frozenset(), True, True
    fn = tree.body[0] if tree.body and isinstance(tree.body[0], ast.FunctionDef) else None
    own = {a.arg for a in fn.args.args + fn.args.kwonlyargs} if fn else set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "__init__"):
            continue
        owner = node.func.value
        via_super = isinstance(owner, ast.Call) and getattr(owner.func, "id", "") == "super"
        args = list(node.args)
        if not via_super:
            if not args:  # X.__init__(self, ...): drop self
                continue
            args = args[1:]
        npos = 0
        star = False
        for a in args:
            if isinstance(a, ast.Starred):
                star = True
                break
            npos += 1
        # x=x only passes the user's value through when x is this __init__'s own parameter.
        names = frozenset(k.arg for k in node.keywords
                          if k.arg and not (isinstance(k.value, ast.Name) and k.value.id == k.arg and k.arg in own))
        forwards = any(k.arg is None for k in node.keywords)
        return npos, names, forwards, star
    return 0, frozenset(), True, True  # no direct parent call: can't tell, keep following


def target_param(cls: type) -> str | None:
    """Name of the animated-mobject parameter of an Animation class (None for *mobjects)."""
    try:
        params = [p for p in list(inspect.signature(cls.__init__).parameters.values())[1:]
                  if p.kind in (p.POSITIONAL_OR_KEYWORD, p.VAR_POSITIONAL)]
    except (TypeError, ValueError):
        return None
    for p in params:
        if p.kind is p.POSITIONAL_OR_KEYWORD and p.name in TARGET_PARAMS:
            return p.name
    if params and params[0].kind is p.POSITIONAL_OR_KEYWORD:
        return params[0].name
    return None


@functools.lru_cache(maxsize=256)
def leading_positionals(cls_name: str, skip: int = 0) -> tuple[str, ...]:
    """Parameters declared before ``*args`` (Cutout(main_shape, *mobjects)); they must be passed positionally."""
    cls = vars(manim()).get(cls_name)
    if not isinstance(cls, type):
        return ()
    try:
        params = list(inspect.signature(cls.__init__).parameters.values())[1 + skip:]
    except (TypeError, ValueError):
        return ()
    out = []
    for p in params:
        if p.kind is p.VAR_POSITIONAL:
            return tuple(out)
        if p.kind is not p.POSITIONAL_OR_KEYWORD:
            break
        out.append(p.name)
    return ()


@functools.lru_cache(maxsize=256)
def sets_run_time(cls_name: str) -> bool:
    """True for animations that compute run_time themselves (ChangeSpeed): passing one would clash."""
    cls = vars(manim()).get(cls_name)
    if not isinstance(cls, type):
        return False
    return any("run_time" in _super_call(k)[1] for k in cls.__mro__ if "__init__" in k.__dict__)


@functools.lru_cache(maxsize=256)
def is_introducer(cls_name: str) -> bool:
    """True for animations that put their mobject on screen to stay (Create, Write, FadeIn, GrowFromCenter…).

    A flash that adds and removes a copy (ShowPassingFlash) doesn't count.
    """
    m = manim()
    cls = vars(m).get(cls_name)
    if not isinstance(cls, type) or not issubclass(cls, m.Animation):
        return False
    for extra in ((), (m.ORIGIN,)):  # GrowFromPoint(mobject, point) needs a point
        try:
            anim = cls(m.Square(), *extra)
            return bool(anim.is_introducer() and not anim.is_remover())
        except Exception:
            pass
    # Can't build one with a square: read the defaults instead.
    flags = {}
    for klass in cls.__mro__:
        if "__init__" not in klass.__dict__:
            continue
        try:
            params = inspect.signature(klass.__init__).parameters
        except (TypeError, ValueError):
            continue
        for name in ("introducer", "remover"):
            if name in params and params[name].default is not inspect.Parameter.empty:
                flags.setdefault(name, bool(params[name].default))
    return flags.get("introducer", False) and not flags.get("remover", False)


@functools.lru_cache(maxsize=256)
def target_keyword(cls_name: str) -> str | None:
    """Keyword the clip target must be passed as, when it isn't the first argument (ApplyMatrix(matrix, mobject))."""
    cls = vars(manim()).get(cls_name)
    if not isinstance(cls, type):
        return None
    try:
        first = next(p for p in list(inspect.signature(cls.__init__).parameters.values())[1:])
    except (StopIteration, TypeError, ValueError):
        return None
    name = target_param(cls)
    return name if name and first.name != name else None


def class_params(cls: type, skip_first: bool = False) -> list[dict]:
    """Constructor parameters, following **kwargs up the MRO like manim does."""
    out: list[dict] = []
    seen: set[str] = set()
    star_done = False
    pos = 0
    target = target_param(cls) if skip_first else None
    fixed_pos, fixed_names = 0, frozenset()  # what the previous __init__ already passes up
    docs = param_docs(cls)
    is_anim = issubclass(cls, manim().Animation)
    for level, klass in enumerate(cls.__mro__):
        init = klass.__dict__.get("__init__")
        if init is None:
            continue
        try:
            sig = inspect.signature(init)
        except (TypeError, ValueError):
            break
        has_kwargs = False
        params = list(sig.parameters.values())[1:]
        hidden = set(fixed_names) | _computed_by(cls)
        hidden.update(p.name for p in [q for q in params if q.kind is q.POSITIONAL_OR_KEYWORD][:fixed_pos])
        for p in params:
            if p.kind is p.VAR_KEYWORD:
                has_kwargs = True
                continue
            if skip_first and (p.name in TARGET_PARAMS or (level == 0 and (p.name == target or (target is None and p.kind is p.VAR_POSITIONAL)))):
                seen.add(p.name)
                continue
            if p.kind is p.VAR_POSITIONAL:
                if not star_done and level == 0:
                    star_done = True
                    if issubclass(cls, manim().Line) and not skip_first:
                        continue  # Arrow(*args) only forwards Line's start/end, which have their own fields
                    entry = _param(p, "*", f"*{p.name}", klass.__name__, False)
                    entry.update(_special(cls, "*", entry))
                    entry["doc"] = _help(p.name, docs, is_anim)
                    out.append(entry)
                continue
            if p.name in seen or p.name.startswith("_") or p.name in hidden or p.name in INTERNAL_PARAMS:
                seen.add(p.name)
                continue
            seen.add(p.name)
            # Private bases (manim's _Fade etc.) hold the class's real parameters: treat them as its own.
            own = level == 0 or klass.__name__.startswith("_")
            entry = _param(p, p.name, p.name, "" if own else klass.__name__, p.default is inspect.Parameter.empty)
            entry.update(_special(cls, p.name, entry))
            entry["doc"] = _help(p.name, docs, is_anim)
            if level == 0 and p.kind is p.POSITIONAL_OR_KEYWORD and not star_done:
                entry["pos"] = pos
                pos += 1
            out.append(entry)
        if not has_kwargs:
            break
        npos, names, forwards, star_fwd = _super_call(klass)
        if not forwards:
            break
        # Positionals we received into *args and pass on via *args reach the parent too (Vector -> Arrow -> Line).
        before_star = len([q for q in params if q.kind is q.POSITIONAL_OR_KEYWORD])
        absorbed = max(0, fixed_pos - before_star) if any(q.kind is q.VAR_POSITIONAL for q in params) else 0
        fixed_pos, fixed_names = npos + (absorbed if star_fwd else 0), fixed_names | names
    return out


def _computed_by(cls: type) -> set[str]:
    """Parameters a class computes itself in ways the super() call doesn't show."""
    m = manim()
    if issubclass(cls, m.ApplyMethod) or cls.__name__ in ("MoveToTarget", "Restore"):
        return {"target_mobject"}
    if issubclass(cls, m.Line3D):  # set_start_and_end_attrs builds the Cylinder from start/end/thickness
        return {"radius", "direction", "height", "show_ends"}
    return set()


def _special(cls: type, name: str, entry: dict) -> dict:
    """Kind overrides that depend on the owning class."""
    m = manim()
    if entry["kind"] != "expr":
        return {}
    if name == "*" and entry["label"] in ("*mobjects", "*vmobjects", "*submobjects"):
        return {"kind": "mobjects"}
    if name == "*":
        # Line(*args) / Arrow(*args) forward start and end points; others are free positional values.
        return {"kind": "points"} if issubclass(cls, m.Line) else {"kind": "values"}
    from manim.mobject.graph import GenericGraph

    if issubclass(cls, GenericGraph):
        return {"vertices": {"kind": "values"}, "partitions": {"kind": "values"},
                "edges": {"kind": "pairs"}, "root_vertex": {"kind": "vertex"}}.get(name, {})
    return {}


# Methods that return something other than the mobject (break a chain) or are internal plumbing.
_NON_CHAIN = ("get_", "has_", "is_", "init_", "generate_", "interpolate", "align_", "pointwise_", "reset_",
              "nonempty_", "throw_", "push_self", "family_members", "consider_", "proportion_", "point_from",
              "split", "length_over", "insert_n", "apply_points", "apply_over", "add_animation_override",
              "animation_override_for", "assign_tip_attr", "create_tip", "append_points", "clear_points",
              "add_n_more", "add_background_rectangle_to", "apply_to_family", "update_", "suspend_updating",
              "resume_updating", "set_points", "start_new_path", "add_points", "add_subpath", "add_cubic", "add_quadratic",
              "add_smooth", "add_line_to", "set_anchors", "change_anchor", "close_path", "resize_points", "copy",
              "match_points", "save_state", "restore", "append_vectorized", "invert", "force_direction", "gen_",
              "point_at", "stop_angle", "save_image", "show", "null_point", "reduce_", "position_tip", "pop_tips",
              "polyline_to", "path_to", "get_mob_from")


def _returns(fn: Any) -> str:
    try:
        r = inspect.signature(fn).return_annotation
    except (TypeError, ValueError):
        return ""
    if r is inspect.Signature.empty:
        return ""
    return r if isinstance(r, str) else getattr(r, "__name__", str(r))


def _mobject_class(name: str) -> type | None:
    m = manim()
    obj = vars(m).get(name.split("|")[0].strip().split(".")[-1])
    return obj if isinstance(obj, type) and issubclass(obj, m.Mobject) else None


def _is_forwarder(fn: Any) -> bool:
    try:
        params = list(inspect.signature(fn).parameters.values())[1:]
    except (TypeError, ValueError):
        return False
    return bool(params) and all(p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD) and p.annotation in (p.empty, "Any") for p in params)


def methods_of(cls: type) -> list[str]:
    """Public chainable methods (they return the mobject itself) of a mobject class, common ones first."""
    own = {k.__name__ for k in cls.__mro__}
    names = []
    for n in dir(cls):
        if n.startswith("_") or n.startswith(_NON_CHAIN):
            continue
        attr = inspect.getattr_static(cls, n, None)
        fn = getattr(cls, n, None)
        if isinstance(attr, (property, type, classmethod, staticmethod)) or not callable(fn):
            continue
        ret = _returns(fn)
        if ret and ret not in ("Self", "None") and ret not in own:
            continue  # returns a value or a new object: not part of a chain
        if _is_forwarder(fn):
            continue  # f(*args, **kwargs) aliases (shuffle_submobjects -> shuffle): use the real method
        names.append(n)
    common = [n for n in COMMON_METHODS if n in names]
    return common + [n for n in names if n not in common]


def factories_of(cls: type) -> list[str]:
    """Methods that build a new mobject from this one (axes.plot, axes.get_area, brace.get_tex...)."""
    own = {k.__name__ for k in cls.__mro__}
    out = []
    for n in dir(cls):
        # get_subdivision_braces_and_labels: broken in manim itself (passes min_num_quads to Brace).
        if n.startswith(("_", "get_mob_from", "polyline_to", "path_to", "get_point_mobject")) or n in (
                "get_subdivision_braces_and_labels", "copy", "become", "repeat_submobject", "polyline_to_mobject", "path_to_mobject",
                                      "get_family", "get_mobject_family_members", "get_group_class", "get_top_level_mobjects"):
            continue
        attr = inspect.getattr_static(cls, n, None)
        fn = getattr(cls, n, None)
        if isinstance(attr, (property, type, classmethod, staticmethod)) or not callable(fn):
            continue
        ret = _returns(fn)
        if ret and ret != "Self" and ret not in own and _mobject_class(ret):
            out.append(n)
    return out


_tables: tuple[dict[str, str], dict[tuple, str]] | None = None


def _lookup_tables() -> tuple[dict[str, str], dict[tuple, str]]:
    global _tables
    if _tables is None:
        m = manim()
        colors: dict[str, str] = {}
        for name in color_names():
            colors.setdefault(getattr(m, name).to_hex().upper(), name)
        dirs = {tuple(np.round(getattr(m, d).astype(float), 6).tolist()): d for d in DIRECTIONS}
        _tables = (colors, dirs)
    return _tables


def color_names() -> list[str]:
    m = manim()
    names = [n for n in dir(m) if n.isupper() and isinstance(getattr(m, n), m.ManimColor)]
    # Prefer the short canonical names (BLUE over BLUE_C, PURE_BLUE...) first.
    return sorted(names, key=lambda n: (("_" in n), n))


def rate_func_names() -> list[str]:
    from manim.utils import rate_functions as rf

    return sorted(n for n, f in vars(rf).items()
                  if inspect.isfunction(f) and f.__module__ == rf.__name__ and not n.startswith("_")
                  and n not in ("unit_interval", "zero"))


def _category(cls: type) -> str:
    parts = cls.__module__.split(".")
    if len(parts) >= 3 and parts[0] == "manim":
        raw = parts[2] if parts[1] in ("mobject", "animation") else parts[1]
        if parts[1] == "animation" and len(parts) >= 4 and raw == "transform_matching_parts":
            raw = "transform"
        return raw.replace("_", " ").title()
    return "Custom"


# What the settings every animation shares do, in the editor's terms (manim's own descriptions are
# technical or missing for these). They win over docstrings.
ANIMATION_HELP = {
    "rate_func": "How the motion is paced within the clip. smooth eases in and out, linear keeps a constant "
                 "speed, there_and_back goes to the end and returns. Changing it changes how the motion feels, "
                 "not how long the clip is or where it ends (except for there-and-back styles, which end where "
                 "they started).",
    "lag_ratio": "Staggers the animation across the object's parts (the letters of a text, the members of a "
                 "group). 0: every part at once. 1: one part after another. In between: they overlap. The whole "
                 "animation still takes the clip's duration, so a larger value makes each part faster.",
    "introducer": "Whether this animation puts the object on screen when it starts. Automatic uses the class's "
                  "own choice (yes for Create, Write, FadeIn). Turn it off to animate an object that is already "
                  "on screen; turn it on to make the object appear with this clip.",
    "remover": "Whether the object leaves the screen when the animation ends. Automatic uses the class's own "
               "choice (yes for FadeOut, Uncreate). Turn it on to remove the object after this clip.",
    "suspend_mobject_updating": "Pauses the object's updaters, and its MathEngine construction, while this clip "
                                "plays, so the animation alone moves it. Turn it off to keep them running during "
                                "the clip (the object then follows both).",
    "reverse_rate_function": "Plays the animation backwards: it starts from the end state and finishes at the "
                             "start state.",
    "run_time": "How long the animation takes, in seconds. On the timeline this is the clip's duration.",
    "name": "A name for the animation, used only in manim's logs. It changes nothing on screen.",
    "use_override": "Lets a mobject class supply its own version of this animation (manim's override_animation). "
                    "Rarely needs changing.",
    "reverse": "Runs it in the opposite order: the last part first.",
}
# Common mobject settings, used when a class's docstring doesn't describe them.
MOBJECT_HELP = {
    "color": "The object's color (outline and fill, unless those are set separately).",
    "fill_color": "Color of the object's interior.",
    "fill_opacity": "How opaque the interior is: 0 is transparent (only the outline shows), 1 is solid.",
    "stroke_color": "Color of the outline.",
    "stroke_width": "Thickness of the outline. 0 hides it.",
    "stroke_opacity": "How opaque the outline is: 0 hides it, 1 is solid.",
    "background_stroke_width": "Width of the dark outline drawn behind the object (used to make text readable over "
                               "other objects).",
    "z_index": "Drawing order: objects with a higher z_index are drawn on top.",
    "sheen_factor": "Strength of a gradient highlight across the object's fill.",
    "font_size": "Size of the text.",
    "radius": "Radius, in scene units (the scene is 8 units tall).",
    "buff": "Gap, in scene units, between this object and what it's placed against.",
    "about_point": "The point that stays fixed while it scales or rotates. Empty: the object's center.",
    "about_edge": "Scale or rotate around this edge or corner of the object (UP, DL…) instead of its center.",
    "family": "Also apply to the object's parts (its submobjects). Off: only the object itself.",
    "arc_center": "Position of the center, in scene coordinates.",
}


def _plain(text: str) -> str:
    """reST to plain text: roles (:class:`~.Mobject`) become names, literals lose their backticks."""
    text = re.sub(r":math:`([^`]*)`", lambda mt: mt.group(1).replace("\\", ""), text)
    text = re.sub(r":\w+:`~?\.?([^`<]*?)(?:\s*<[^>]*>)?`", lambda mt: mt.group(1).split(".")[-1], text)
    text = text.replace("temporally", "temporarily")  # a recurring typo in manim's docstrings
    return re.sub(r"\s+", " ", text.replace("``", "").replace("`", "")).strip()


def _numpydoc_params(doc: str) -> dict[str, str]:
    """Parameter descriptions from a numpydoc ``Parameters`` section."""
    lines = (doc or "").expandtabs().splitlines()
    out: dict[str, str] = {}
    i = next((k + 1 for k in range(len(lines) - 1) if lines[k].strip() == "Parameters" and set(lines[k + 1].strip()) == {"-"}), None)
    if i is None:
        return out
    names: list[str] = []
    body: list[str] = []

    def flush() -> None:
        text = _plain(" ".join(body))
        if len(text) > 420:  # keep whole sentences
            cut = text.rfind(". ", 0, 420)
            text = text[: cut + 1] if cut > 80 else text[:417] + "…"
        for n in names:
            if text and n not in out:
                out[n] = text

    for k in range(i + 1, len(lines)):
        line = lines[k]
        if not line.strip():
            body.append("")
            continue
        if not line.startswith(" "):
            if k + 1 < len(lines) and set(lines[k + 1].strip()) == {"-"}:
                break  # next section
            flush()
            names = [n.strip().lstrip("*") for n in line.split(":")[0].split(",") if n.strip()]
            body = []
        else:
            body.append(line.strip())
    flush()
    return out


@functools.lru_cache(maxsize=None)
def param_docs(cls: type) -> dict[str, str]:
    """Descriptions of a class's constructor parameters, from its docstrings and its bases'."""
    out: dict[str, str] = {}
    for klass in cls.__mro__:
        init = klass.__dict__.get("__init__")
        for doc in (klass.__dict__.get("__doc__"), getattr(init, "__doc__", None)):
            for name, text in _numpydoc_params(inspect.cleandoc(doc) if doc else "").items():
                out.setdefault(name, text)
    return out


def _help(name: str, docs: dict[str, str], animation: bool) -> str:
    if animation and name in ANIMATION_HELP:
        return ANIMATION_HELP[name]
    return docs.get(name) or MOBJECT_HELP.get(name, "")


def _clean_doc(doc: str) -> str:
    """First paragraph of a docstring with reST roles (:class:`~.Mobject`) reduced to plain names."""
    text = doc.split("\n\n")[0].replace("\n", " ")
    text = re.sub(r":\w+:`~?\.?([^`<]*?)(?:\s*<[^>]*>)?`", lambda mt: mt.group(1).split(".")[-1], text)
    return text.replace("``", "")[:300]


def _doc(cls: type) -> str:
    return _clean_doc(inspect.getdoc(cls) or "")


def _entry(cls: type, kind: str) -> dict:
    return {
        "name": cls.__name__,
        "kind": kind,
        "category": _category(cls),
        "doc": _doc(cls),
        "bases": [k.__name__ for k in cls.__mro__[1:6]],
        "vector": _is_vmobject(cls),
        "starter": FEATURED_MOBJECTS.get(cls.__name__, {}),
    }


def _is_vmobject(cls: type) -> bool:
    m = manim()
    return isinstance(cls, type) and issubclass(cls, m.VMobject)


def build(extra_namespace: dict[str, Any] | None = None) -> dict:
    m = manim()
    namespace = dict(vars(m))
    if extra_namespace:
        namespace.update(extra_namespace)
    mobjects, animations = [], []
    for name, obj in sorted(namespace.items()):
        if not isinstance(obj, type) or name.startswith("_") or name.startswith("OpenGL"):
            continue
        if issubclass(obj, m.Animation):
            if name not in SKIP_ANIMATIONS:
                animations.append(_entry(obj, "animation"))
        elif issubclass(obj, m.Mobject):
            mobjects.append(_entry(obj, "mobject"))
    featured_order = {n: i for i, n in enumerate(FEATURED_MOBJECTS)}
    for e in mobjects:
        e["featured"] = featured_order.get(e["name"], -1)
    anim_order = {n: i for i, n in enumerate(FEATURED_ANIMATIONS)}
    for e in animations:
        e["featured"] = anim_order.get(e["name"], -1)
    return {
        "manim_version": m.__version__,
        "mobjects": mobjects,
        "animations": animations,
        "colors": color_names(),
        "color_hex": {n: getattr(m, n).to_hex().upper() for n in color_names()},
        "directions": DIRECTIONS,
        "rate_funcs": rate_func_names(),
        "methods": COMMON_METHODS,
        "scene_bases": ["Scene", "MovingCameraScene", "ZoomedScene", "ThreeDScene", "VectorScene", "LinearTransformationScene"],
    }


def signature(expr: str, namespace: dict[str, Any] | None = None, object_classes: dict[str, str] | None = None) -> dict:
    """Parameters for a constructor or animation expression.

    ``expr`` is a class name (``"Circle"``) or ``"var.method"`` where ``var``
    is a document object whose constructor class is given in ``object_classes``
    (e.g. ``"axes.plot"`` -> ``Axes.plot``).
    """
    m = manim()
    ns = dict(vars(m))
    if namespace:
        ns.update(namespace)
    target = None
    is_anim = False
    if "." in expr:
        var, meth = expr.split(".", 1)
        cls = ns.get((object_classes or {}).get(var, var))
        if isinstance(cls, type):
            target = getattr(cls, meth, None)
    else:
        target = ns.get(expr)
    if isinstance(target, type):
        is_anim = issubclass(target, m.Animation)
        out = {"name": expr, "params": class_params(target, skip_first=is_anim), "doc": _doc(target),
               "animation": is_anim, "vector": _is_vmobject(target), "returns": expr if issubclass(target, m.Mobject) else ""}
        if issubclass(target, m.Mobject):
            out["methods"] = methods_of(target)
            out["factories"] = factories_of(target)
        return out
    if callable(target):
        params = []
        try:
            sig = inspect.signature(target)
        except (TypeError, ValueError):
            sig = None
        docs = _numpydoc_params(inspect.getdoc(target) or "")
        for p in list(sig.parameters.values())[1:] if sig else []:
            if p.kind is p.VAR_KEYWORD or p.name.startswith("_"):
                continue
            star = p.kind is p.VAR_POSITIONAL
            params.append(_param(p, "*" if star else p.name, p.name, "", p.default is inspect.Parameter.empty and not star))
            params[-1]["doc"] = _help(p.name, docs, False)
            if star and params[-1]["kind"] == "expr":
                params[-1]["kind"] = "values"
            if p.kind is p.KEYWORD_ONLY:
                params[-1]["kwonly"] = True
        ret = _returns(target)
        return {"name": expr, "params": params, "doc": _clean_doc(inspect.getdoc(target) or ""),
                "animation": False, "vector": True, "returns": ret if _mobject_class(ret) else ""}
    return {"name": expr, "params": [], "doc": "", "animation": False, "vector": False, "unknown": True}


def header_namespace(header: str) -> dict[str, Any]:
    """Execute the project's header code to discover user-defined classes."""
    if not header.strip():
        return {}
    m = manim()
    from manim.utils import rate_functions

    ns: dict[str, Any] = dict(vars(m))
    ns.update({k: v for k, v in vars(rate_functions).items() if not k.startswith("_")})
    ns["np"] = np
    try:
        exec(compile(header, "<mathengine-header>", "exec"), ns)
    except Exception:
        return {}
    base = set(vars(m)) | set(vars(rate_functions))
    return {k: v for k, v in ns.items() if k not in base and k != "np" and not k.startswith("__")}
