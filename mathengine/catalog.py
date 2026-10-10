"""Introspect manim to build the GUI palette and property forms.

Nothing here is hand-curated per class except `FEATURED` (palette ordering and
starter arguments); every Mobject/Animation exported by manim, plus any class
defined in the project's header code, is available with its real signature.
"""

from __future__ import annotations

import inspect
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
}

FEATURED_ANIMATIONS = [
    "Create", "Write", "FadeIn", "FadeOut", "Transform", "ReplacementTransform",
    "TransformMatchingTex", "TransformMatchingShapes", "GrowFromCenter", "DrawBorderThenFill",
    "Uncreate", "Unwrite", "Indicate", "Circumscribe", "Flash", "Wiggle", "FocusOn",
    "ShowPassingFlash", "Rotate", "SpinInFromNothing", "GrowArrow", "MoveAlongPath",
    "ApplyWave", "ShrinkToCenter", "FadeTransform", "CounterclockwiseTransform", "ClockwiseTransform",
]

# Animation classes that don't take a single mobject as first argument.
SKIP_ANIMATIONS = {"Animation", "AnimationGroup", "LaggedStart", "LaggedStartMap", "Succession", "Wait", "Add"}

COMMON_METHODS = [
    "shift", "move_to", "next_to", "to_edge", "to_corner", "align_to", "scale", "rotate", "flip",
    "stretch", "set_color", "set_fill", "set_stroke", "set_opacity", "set_z_index", "arrange",
    "arrange_in_grid", "match_height", "match_width", "set_width", "set_height", "add_updater",
    "add_background_rectangle", "set_color_by_gradient", "become", "fade", "center",
]

DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT", "UL", "UR", "DL", "DR", "ORIGIN", "IN", "OUT"]


def _expr_repr(value: Any, colors: dict[str, str], dirs: dict[tuple, str]) -> str:
    """Python-source representation of a default value."""
    m = manim()
    if value is inspect.Parameter.empty:
        return ""
    if isinstance(value, m.ManimColor):
        hexv = value.to_hex().upper()
        return colors.get(hexv, repr(hexv))
    if isinstance(value, np.ndarray):
        key = tuple(np.round(value.astype(float), 6).tolist()) if value.ndim == 1 else None
        if key in dirs:
            return dirs[key]
        return f"np.array({np.round(value, 6).tolist()!r})"
    if callable(value) and hasattr(value, "__name__"):
        return value.__name__
    r = repr(value)
    return r if len(r) < 120 else r[:117] + "..."


def _kind(name: str, default: Any, annotation: str) -> str:
    m = manim()
    ann = annotation.lower()
    if name == "rate_func":
        return "rate_func"
    if isinstance(default, bool) or ann in ("bool", "bool | none"):
        return "bool"
    if name.endswith("color") or isinstance(default, m.ManimColor) or ann.startswith(("parsablemanimcolor", "manimcolor")):
        return "color"
    if isinstance(default, (int, float)) and not isinstance(default, bool):
        return "number"
    if ann.startswith("float") or ann.startswith("int"):
        return "number"
    if isinstance(default, str) or ann.startswith("str"):
        return "string"
    if isinstance(default, np.ndarray) or "point3d" in ann or "vector3d" in ann:
        return "vector"
    return "expr"


def _ann_str(p: inspect.Parameter) -> str:
    a = p.annotation
    if a is inspect.Parameter.empty:
        return ""
    return a if isinstance(a, str) else getattr(a, "__name__", str(a))


def class_params(cls: type, skip_first: bool = False) -> list[dict]:
    """Constructor parameters, following **kwargs up the MRO like manim does."""
    colors, dirs = _lookup_tables()
    out: list[dict] = []
    seen: set[str] = set()
    star_done = False
    first = True
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
        for p in params:
            if p.kind is p.VAR_KEYWORD:
                has_kwargs = True
                continue
            if skip_first and first and level == 0:
                first = False
                if p.kind is not p.VAR_POSITIONAL:
                    seen.add(p.name)
                    continue
            if p.kind is p.VAR_POSITIONAL:
                if not star_done and level == 0:
                    star_done = True
                    out.append({"name": "*", "label": f"*{p.name}", "kind": "expr", "default": "",
                                "required": not skip_first, "annotation": _ann_str(p), "from": klass.__name__})
                continue
            if p.name in seen:
                continue
            seen.add(p.name)
            ann = _ann_str(p)
            out.append({
                "name": p.name,
                "label": p.name,
                "kind": _kind(p.name, p.default, ann),
                "default": _expr_repr(p.default, colors, dirs),
                "required": p.default is inspect.Parameter.empty,
                "annotation": ann,
                "from": klass.__name__ if level else "",
            })
        if not has_kwargs:
            break
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


def _doc(cls: type) -> str:
    doc = inspect.getdoc(cls) or ""
    return doc.split("\n\n")[0].replace("\n", " ")[:300]


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
        cls = ns.get((object_classes or {}).get(var, ""))
        if isinstance(cls, type):
            target = getattr(cls, meth, None)
    else:
        target = ns.get(expr)
    if isinstance(target, type):
        is_anim = issubclass(target, m.Animation)
        return {"name": expr, "params": class_params(target, skip_first=is_anim), "doc": _doc(target),
                "animation": is_anim, "vector": _is_vmobject(target)}
    if callable(target):
        colors, dirs = _lookup_tables()
        params = []
        try:
            sig = inspect.signature(target)
        except (TypeError, ValueError):
            sig = None
        for p in list(sig.parameters.values())[1:] if sig else []:
            if p.kind is p.VAR_KEYWORD:
                continue
            ann = _ann_str(p)
            params.append({"name": "*" if p.kind is p.VAR_POSITIONAL else p.name, "label": p.name,
                           "kind": _kind(p.name, p.default, ann), "default": _expr_repr(p.default, colors, dirs),
                           "required": p.default is inspect.Parameter.empty, "annotation": ann, "from": ""})
        return {"name": expr, "params": params, "doc": (inspect.getdoc(target) or "").split("\n\n")[0][:300],
                "animation": False, "vector": True}
    return {"name": expr, "params": [], "doc": "", "animation": False, "vector": False, "unknown": True}


def header_namespace(header: str) -> dict[str, Any]:
    """Execute the project's header code to discover user-defined classes."""
    if not header.strip():
        return {}
    m = manim()
    ns: dict[str, Any] = dict(vars(m))
    ns["np"] = np
    try:
        exec(compile(header, "<mathengine-header>", "exec"), ns)
    except Exception:
        return {}
    base = set(vars(m))
    return {k: v for k, v in ns.items() if k not in base and k != "np" and not k.startswith("__")}
