"""Introspect manim to build the GUI palette and property forms.

Nothing here is hand-curated per class except `FEATURED` (palette ordering and
starter arguments); every Mobject/Animation exported by manim, plus any class
defined in the project's header code, is available with its real signature.
"""

from __future__ import annotations

import enum
import inspect
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
    "language": ['"python"', '"javascript"', '"typescript"', '"c"', '"cpp"', '"rust"', '"go"', '"java"',
                 '"haskell"', '"julia"', '"latex"', '"bash"', '"json"', '"html"', '"css"', '"sql"'],
}
PATH_PARAMS = {"file_name", "code_file", "filename_or_array", "background_image"}
SCALE_OPTIONS = ["LinearBase()", "LogBase()", "LogBase(base=10, custom_labels=True)"]
# Classes users pass as references to other mobjects.
_MOB_REF = ("Mobject", "VMobject", "Line", "Arc", "Group", "VGroup", "MovingCamera", "Rectangle", "Square")


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
    inner = re.match(r"Callable\[\[([^\]]*)\]", ann)
    n = len([a for a in inner.group(1).split(",") if a.strip()]) if inner else 1
    if name in ("homotopy",):
        return "lambda x, y, z, t: (x, y + 0.2 * np.sin(x + t), z)"
    if "Point3D" in ann or name in ("func",) and "Vector3D" in ann:
        return "lambda p: np.array([-p[1], p[0], 0])"
    args = ["x", "y", "z", "t"][:n] if n <= 4 else ["*a"]
    if n == 2 and name == "func":
        args = ["u", "v"]
    return f"lambda {', '.join(args)}: " + ("x" if n == 1 else "...")


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
        bases = [ns[n] for n in names if isinstance(ns.get(n), type)]
        opts = sorted({c.__name__ for c in vars(m).values() if isinstance(c, type) and bases
                       and issubclass(c, tuple(bases)) and not c.__name__.startswith(("OpenGL", "_"))})
        return {"kind": "choice", "options": opts[:80]}
    if isinstance(default, enum.Enum) or any(isinstance(ns.get(n), type) and issubclass(ns[n], enum.Enum) for n in names):
        cls = type(default) if isinstance(default, enum.Enum) else next(ns[n] for n in names if isinstance(ns.get(n), type) and issubclass(ns[n], enum.Enum))
        if cls.__name__ not in ns:
            return {"kind": "expr"}
        return {"kind": "choice", "options": [f"{cls.__name__}.{e.name}" for e in cls]}
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
    if name in ("matrix", "table") and "Iterable[Iterable" in ann:
        return {"kind": "matrix"}
    if name in NAME_OPTIONS:
        return {"kind": "choice", "options": NAME_OPTIONS[name]}
    if name == "formatter_style":
        try:
            from pygments.styles import get_all_styles
            return {"kind": "choice", "options": sorted(repr(s) for s in get_all_styles())}
        except Exception:
            return {"kind": "string"}
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
    refs = [n for n in names if n in _MOB_REF or n == "OpenGLGroup"]
    if refs and not re.search(r"Point|Vector|ndarray", ann) and "type[" not in ann and "Callable" not in ann:
        many = name == "*" or "Iterable[" in ann or name in ("mobjects",)
        return {"kind": "mobjects" if many else "mobject"}
    if name.endswith("_range") and re.search(r"Sequence|tuple|list", ann):
        return {"kind": "range"}
    if re.search(r"(Iterable|Sequence|MutableSequence|list)\[(float|int)", ann):
        return {"kind": "numbers"}
    if isinstance(default, (int, float)) and not isinstance(default, bool) or ann.startswith(("float", "int")):
        return {"kind": "number", "int": is_int or (isinstance(default, int) and not ann)}
    if re.search(r"(Iterable|Sequence|list)\[str", ann):
        return {"kind": "strings"}
    if isinstance(default, np.ndarray) or re.search(r"Point3D|Vector3D|Vector2D|np\.ndarray", ann):
        return {"kind": "vector", "objects": "Mobject" in ann}
    if name.endswith("_range") and isinstance(default, (tuple, list)):
        return {"kind": "range"}
    if isinstance(default, str) or low.startswith(("str", "strpath")):
        return {"kind": "string"}
    return {"kind": "expr"}


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


def class_params(cls: type, skip_first: bool = False) -> list[dict]:
    """Constructor parameters, following **kwargs up the MRO like manim does."""
    out: list[dict] = []
    seen: set[str] = set()
    star_done = False
    first = True
    pos = 0
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
            if skip_first and (p.name in TARGET_PARAMS or (p.kind is p.VAR_POSITIONAL and level == 0 and first)):
                seen.add(p.name)
                first = False
                continue
            if skip_first and first and level == 0:
                first = False
                if p.kind is not p.VAR_POSITIONAL:
                    seen.add(p.name)
                    continue
            if p.kind is p.VAR_POSITIONAL:
                if not star_done and level == 0:
                    star_done = True
                    out.append(_param(p, "*", f"*{p.name}", klass.__name__, not skip_first))
                continue
            if p.name in seen or p.name.startswith("_"):
                continue
            seen.add(p.name)
            # Private bases (manim's _Fade etc.) hold the class's real parameters: treat them as its own.
            own = level == 0 or klass.__name__.startswith("_")
            entry = _param(p, p.name, p.name, "" if own else klass.__name__, p.default is inspect.Parameter.empty)
            if level == 0 and p.kind is p.POSITIONAL_OR_KEYWORD and not star_done:
                entry["pos"] = pos
                pos += 1
            out.append(entry)
        if not has_kwargs:
            break
    return out


# Methods that return something other than the mobject (break a chain) or are internal plumbing.
_NON_CHAIN = ("get_", "has_", "is_", "init_", "generate_", "interpolate", "align_", "pointwise_", "reset_",
              "nonempty_", "throw_", "push_self", "family_members", "consider_", "proportion_", "point_from",
              "split", "length_over", "insert_n", "apply_points", "apply_over", "add_animation_override",
              "animation_override_for", "assign_tip_attr", "create_tip", "append_points", "clear_points",
              "add_n_more", "add_background_rectangle_to", "apply_to_family", "update_", "suspend_updating",
              "resume_updating", "set_points", "start_new_path", "add_points", "add_subpath", "add_cubic", "add_quadratic",
              "add_smooth", "add_line_to", "set_anchors", "change_anchor", "close_path", "resize_points", "copy",
              "match_points", "save_state", "restore", "append_vectorized", "invert", "force_direction", "gen_",
              "point_at", "stop_angle", "save_image", "show", "null_point", "reduce_", "position_tip", "pop_tips")


def methods_of(cls: type) -> list[str]:
    """Public chainable methods of a mobject class, common ones first."""
    names = []
    for n in dir(cls):
        if n.startswith("_") or n.startswith(_NON_CHAIN):
            continue
        attr = inspect.getattr_static(cls, n, None)
        if isinstance(attr, (property, type, classmethod, staticmethod)) or not callable(getattr(cls, n, None)):
            continue
        names.append(n)
    common = [n for n in COMMON_METHODS if n in names]
    return common + [n for n in names if n not in common]


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
               "animation": is_anim, "vector": _is_vmobject(target)}
        if issubclass(target, m.Mobject):
            out["methods"] = methods_of(target)
        return out
    if callable(target):
        params = []
        try:
            sig = inspect.signature(target)
        except (TypeError, ValueError):
            sig = None
        for p in list(sig.parameters.values())[1:] if sig else []:
            if p.kind is p.VAR_KEYWORD or p.name.startswith("_"):
                continue
            star = p.kind is p.VAR_POSITIONAL
            params.append(_param(p, "*" if star else p.name, p.name, "", p.default is inspect.Parameter.empty and not star))
            if p.kind is p.KEYWORD_ONLY:
                params[-1]["kwonly"] = True
        return {"name": expr, "params": params, "doc": _clean_doc(inspect.getdoc(target) or ""),
                "animation": False, "vector": True}
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
