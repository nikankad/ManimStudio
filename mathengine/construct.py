"""Constructions: objects defined by their relationship to other objects.

A scene object may carry a ``link``: a structured definition that refers to
other objects by their stable ``id`` (never by variable name, so renames are
safe) and to parameters (ValueTracker objects) through math expressions
(see mathexpr.py). Examples: a segment between two points, a label attached to
a point, a point constrained to a graph, an angle marker between two lines,
the area under a graph between two bounds.

Two families, which decide which properties the construction owns:

* **follow** links own only the *position* of an otherwise ordinary object
  (attached labels, constrained points, midpoints, intersections, feet of
  perpendiculars, measurements). Its
  constructor, style, scale and rotation stay editable and animatable.
* **redraw** links own the *geometry* (points) of the object, which is rebuilt
  from its sources (segments, circles through points, perpendicular and
  parallel lines, angle markers, graphs, tangents, shaded areas, braces). Style stays with the object.

Generated code keeps constructions correct during animation, timeline
scrubbing and in exported files with a small ``Constraints`` helper (plain
manim code, emitted into the file): a scene updater that re-evaluates every
construction each frame in document order, skipping any mobject an animation
is currently playing on (manim's ``updating_suspended``). Because animations
and constraints never write the same property at the same time, they don't
compete.

Construction order is document order. A link must refer to objects defined
before it; anything else (missing sources, wrong kinds of objects, cycles,
undefined parameters) is reported as a diagnostic and the construction is
emitted without its constraint instead of failing the whole scene.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from . import defs, mathexpr, timeline

# ----------------------------------------------------------------------------- classification

POINT_CTORS = {"Dot", "SmallDot", "AnnotationDot", "LabeledDot", "Dot3D"}
LINE_CTORS = {"Line", "DashedLine", "Arrow", "DoubleArrow", "Vector", "TangentLine"}
CIRCLE_CTORS = {"Circle"}
POLYGON_CTORS = {"Polygon", "Triangle", "Square", "Rectangle", "RegularPolygon", "RoundedRectangle", "Polygram"}
AXES_CTORS = {"Axes", "NumberPlane", "ComplexPlane"}
EQUATION_CTORS = {"MathTex", "Tex", "SingleStringMathTex"}
TEXT_CTORS = {"Text", "MarkupText", "DecimalNumber", "Integer", "Paragraph"}

FOLLOW_KINDS = {"attach", "midpoint", "on_graph", "on_circle", "coords", "measure", "intersection", "projection"}
REDRAW_KINDS = {"segment", "circle2", "polygon", "angle", "graph", "tangent", "secant", "area", "riemann", "brace", "highlight",
                "perpendicular", "parallel"}
KINDS = FOLLOW_KINDS | REDRAW_KINDS
# Kinds whose object is an ordinary one while uncoupled (a point at its position, a line with its own ends…);
# the others are built once from their sources while uncoupled.
STANDALONE_KINDS = FOLLOW_KINDS | {"segment", "circle2", "polygon", "perpendicular", "parallel", "tangent", "secant"}
SWITCH_CLIPS = ("couple", "uncouple")

# What each link kind makes, for compatibility checks and context menus.
KIND_TYPE = {
    "midpoint": "point", "on_graph": "point", "on_circle": "point", "coords": "point", "intersection": "point",
    "projection": "point", "segment": "line", "tangent": "line", "secant": "line", "perpendicular": "line",
    "parallel": "line", "circle2": "circle", "polygon": "polygon",
    "angle": "angle", "graph": "graph", "area": "area", "riemann": "riemann", "brace": "annotation",
    "highlight": "annotation",
}

# Objects that can be intersected, and objects that act as a straight line (an axes object means its
# x- or y-axis, picked by the link's ``axis``). Lines are extended both ways.
MEETS = {"line", "circle", "graph", "axes", "numberline"}
STRAIGHT = {"line", "axes", "numberline"}

# Source fields of each kind: (field, accepted types or None for any, required)
SOURCES: dict[str, list[tuple[str, set[str] | None, bool]]] = {
    "attach": [("to", None, True)],
    "midpoint": [("a", {"point", "line"}, True), ("b", {"point"}, False)],
    "on_graph": [("graph", {"graph"}, True)],
    "on_circle": [("circle", {"circle"}, True)],
    "coords": [("axes", {"axes", "numberline"}, True)],
    "intersection": [("a", MEETS, True), ("b", MEETS, True)],
    "projection": [("point", None, True), ("onto", STRAIGHT, True)],
    "measure": [("of", None, False)],
    "segment": [("a", None, True), ("b", None, True)],
    "circle2": [("a", None, True), ("b", None, True)],
    "perpendicular": [("line", STRAIGHT, True), ("through", None, True)],
    "parallel": [("line", STRAIGHT, True), ("through", None, True)],
    "polygon": [],  # "points": list, checked separately
    "angle": [("l1", {"line"}, True), ("l2", {"line"}, True)],
    "graph": [("axes", {"axes"}, True)],
    "tangent": [("graph", {"graph"}, True)],
    "secant": [("graph", {"graph"}, True)],
    "area": [("graph", {"graph"}, True), ("bounded", {"graph"}, False)],
    "riemann": [("graph", {"graph"}, True), ("bounded", {"graph"}, False)],
    "brace": [("target", None, True)],
    "highlight": [("target", None, True)],
}
# Expression fields (math text over parameters) of each kind.
EXPRS: dict[str, list[str]] = {
    "on_graph": ["x"], "on_circle": ["angle"], "coords": ["x", "y"], "measure": ["expr"],
    "tangent": ["x", "length"], "secant": ["x", "dx", "length"], "area": ["a", "b"], "riemann": ["a", "b", "dx"],
    "angle": ["radius"], "perpendicular": ["length"], "parallel": ["length"],
}
MEASURES = {"length": {"line"}, "angle": {"angle"}, "slope": {"line"}, "integral": {"area", "riemann"}, "value": None}

# Methods that move an object (conflict with follow links) / change its geometry (conflict with redraw links).
POSITION_METHODS = {"shift", "move_to", "next_to", "to_edge", "to_corner", "align_to", "center", "set_x", "set_y",
                    "set_z", "become", "move_to_target"}
GEOMETRY_METHODS = POSITION_METHODS | {"scale", "rotate", "flip", "stretch", "set_width", "set_height", "scale_to_fit_width",
                                       "scale_to_fit_height", "stretch_to_fit_width", "stretch_to_fit_height",
                                       "put_start_and_end_on", "set_points", "set_points_as_corners", "apply_function",
                                       "apply_matrix", "rotate_about_origin", "match_width", "match_height", "replace"}
GEOMETRY_ANIMATIONS = {"Rotate", "Rotating", "MoveAlongPath", "ScaleInPlace", "ApplyMatrix", "ApplyFunction",
                       "ApplyPointwiseFunction", "Homotopy", "Transform", "ReplacementTransform", "ClockwiseTransform",
                       "CounterclockwiseTransform", "MoveToTarget", "ApplyMethod", "SpiralIn"}


def base_ctor(obj: dict) -> str:
    return (obj.get("ctor") or "").strip()


def geo_type(obj: dict, by_name: dict[str, dict] | None = None) -> str:
    """Geometric role of an object: point, line, circle, polygon, graph, axes, numberline, equation, text, param…"""
    link = obj.get("link") or {}
    kind = link.get("kind")
    if kind in KIND_TYPE:
        return KIND_TYPE[kind]
    ctor = base_ctor(obj)
    if ctor in POINT_CTORS:
        return "point"
    if ctor in LINE_CTORS:
        return "line"
    if ctor in CIRCLE_CTORS:
        return "circle"
    if ctor in POLYGON_CTORS:
        return "polygon"
    if ctor in AXES_CTORS:
        return "axes"
    if ctor == "NumberLine":
        return "numberline"
    if ctor in EQUATION_CTORS:
        return "equation"
    if ctor in TEXT_CTORS:
        return "text"
    if ctor == "ValueTracker":
        return "param"
    if ctor == "Angle":
        return "angle"
    m = re.fullmatch(r"([A-Za-z_]\w*)\.(plot|get_graph)", ctor)
    if m and by_name is not None and geo_type(by_name.get(m.group(1), {}), None) == "axes":
        return "graph"
    if m and by_name is None:
        return "graph"
    return "other"


def graph_axes_id(graph: dict, by_name: dict[str, dict]) -> str | None:
    """Id of the axes a graph is plotted on (a ``graph`` link's axes, or ``axes`` in ``axes.plot``)."""
    link = graph.get("link") or {}
    if link.get("kind") == "graph":
        return link.get("axes")
    m = re.fullmatch(r"([A-Za-z_]\w*)\.(plot|get_graph)", base_ctor(graph))
    if m and m.group(1) in by_name:
        return by_name[m.group(1)]["id"]
    return None


def link_sources(obj: dict) -> list[str]:
    """Ids of the objects this object's link refers to (not parameters)."""
    link = obj.get("link") or {}
    kind = link.get("kind")
    out = [link.get(f) for f, _, _ in SOURCES.get(kind, [])]
    if kind == "polygon":
        out += list(link.get("points") or [])
    return [s for s in out if s]


# ----------------------------------------------------------------------------- helper source (emitted into scenes)

CONSTRAINTS_SOURCE = '''
class Constraints:
    """Keeps constructed objects attached to what they are built from (Manim Studio).

    Every frame, each construction is re-evaluated in the order it was added (sources first),
    except while an animation is playing on its mobject: manim suspends updating then, so
    Create, FadeIn and .animate work as usual. A construction owns either the position
    (follow) or the shape (redraw) of its mobject; color and opacity stay with the mobject and
    its animations. ``pause`` uncouples mobjects (they stay where they are and can be animated
    freely), ``resume`` couples them again at once and ``couple`` is an animation that moves them
    back into place.
    """

    def __init__(self, scene):
        self.items = []
        self.paused = set()

        def step(dt):
            self.update()

        # Scene updaters run last in every frame, after animations and mobject updaters...
        step.mathengine_constraints = True  # (the Manim Studio preview doesn't need to sub-step for this)
        scene.add_updater(step)
        # ...but not after an animation finishes, when manim only updates mobjects. This invisible
        # carrier brings constructions to the final state of each self.play().
        self.carrier = Mobject()
        self.carrier.add_updater(lambda m: self.update())
        scene.add(self.carrier)

    def redraw(self, build, *sources, mob=None, paused=False):
        """A mobject rebuilt by ``build()`` whenever one of ``sources`` changes (``mob``: an existing one to reshape)."""
        if mob is None:
            mob = build()
        state = {"key": self._key(sources)}

        def target(m):
            new = build()
            self._restyle(new, m)
            return new

        def update(m, force=False):
            key = self._key(sources)
            if key == state["key"] and not force:
                return
            state["key"] = key
            try:
                new = target(m)
            except Exception:  # e.g. an Angle while its lines are parallel: keep the last shape
                return
            self._replace(m, new)

        return self._add(mob, update, target, paused)

    def follow(self, mob, place, *sources, paused=False):
        """Position ``mob`` with ``place(mob)`` whenever one of ``sources`` changes."""
        if not paused:
            place(mob)
        state = {"key": self._key(sources)}

        def target(m):
            new = m.copy()
            place(new)
            return new

        def update(m, force=False):
            key = self._key(sources)
            if key != state["key"] or force:
                state["key"] = key
                place(m)

        return self._add(mob, update, target, paused)

    def _add(self, mob, update, target, paused):
        self.items.append((mob, update, target))
        if paused:
            self.paused.add(id(mob))
        return mob

    def update(self):
        for mob, update, _ in self.items:
            if not mob.updating_suspended and id(mob) not in self.paused:
                update(mob)

    def pause(self, *mobs):
        """Uncouple: the mobjects keep their current place and shape until resumed."""
        self.paused.update(id(m) for m in mobs)

    def resume(self, *mobs):
        """Couple again: the mobjects snap back to their constructions."""
        for m in mobs:
            self.paused.discard(id(m))
        for mob, update, _ in self.items:
            if any(mob is m for m in mobs):
                update(mob, force=True)

    def couple(self, *mobs, **kwargs):
        """Animation that moves the mobjects back into their constructed place or shape, then couples them."""
        glides = [Constraints.Glide(self, m, **kwargs) for m in mobs]
        return glides[0] if len(glides) == 1 else AnimationGroup(*glides, **kwargs)

    def target_of(self, mob):
        for m, _, target in self.items:
            if m is mob:
                return target(mob)
        return mob.copy()

    class Glide(Animation):
        def __init__(self, constraints, mob, **kwargs):
            super().__init__(mob, **kwargs)
            self.constraints = constraints

        def begin(self):
            self.constraints.pause(self.mobject)
            self.start = self.mobject.copy()
            super().begin()

        def interpolate_mobject(self, alpha):
            alpha = self.rate_func(alpha)
            try:
                end = self.constraints.target_of(self.mobject)
            except Exception:
                return
            start = self.start.copy()
            start.align_data(end)
            now = start.copy()
            now.interpolate(start, end, alpha)
            Constraints._replace(self.mobject, now)

        def finish(self):
            super().finish()
            # Back to the parts and style it had (the glide's in-between shapes have padding parts),
            # then coupled: rebuilt in place.
            Constraints._replace(self.mobject, self.start)
            self.constraints.resume(self.mobject)

    @staticmethod
    def _restyle(new, old):
        """Give ``new`` the current style of ``old`` (colors and opacity set by animations), part by part.

        A part ``old`` doesn't have (a dashed line that got longer has more dashes) takes the style of its
        last part, so the new dashes look like the others.
        """
        parts = old.family_members_with_points()
        if parts:
            for i, part in enumerate(new.family_members_with_points()):
                part.match_style(parts[min(i, len(parts) - 1)], family=False)

    @staticmethod
    def _replace(mob, new):
        """``mob.become(new)``, with ``new``'s exact structure. (become() pads a mobject with fewer parts
        with invisible copies; their opacity would then be carried into every later rebuild.)"""
        if len(mob.get_family()) != len(new.get_family()):
            mob.remove(*mob.submobjects)
            mob.add(*[part.copy() for part in new.submobjects])
        mob.become(new)

    @staticmethod
    def _key(sources):
        return b"".join(s.get_all_points().tobytes() for s in sources)
'''

GEOMETRY_SOURCE = '''
class Geometry:
    """Constructions used by Manim Studio scenes (tangents, secants, slopes, integrals, intersections, perpendiculars)."""

    @staticmethod
    def function(graph):
        return graph.underlying_function

    @staticmethod
    def tangent_line(axes, graph, x, length=4, h=1e-4, **kwargs):
        """Line tangent to ``graph`` at ``x`` (direction measured on screen)."""
        f = Geometry.function(graph)
        p = axes.c2p(x, f(x))
        d = axes.c2p(x + h, f(x + h)) - axes.c2p(x - h, f(x - h))
        d = d / (np.linalg.norm(d) or 1)
        return Line(p - d * length / 2, p + d * length / 2, **kwargs)

    @staticmethod
    def secant_line(axes, graph, x, dx, extend=1, **kwargs):
        """Line through the graph points at ``x`` and ``x + dx``, extended by ``extend`` on both sides."""
        f = Geometry.function(graph)
        p, q = axes.c2p(x, f(x)), axes.c2p(x + dx, f(x + dx))
        d = q - p
        if np.linalg.norm(d) < 1e-9:
            return Geometry.tangent_line(axes, graph, x, length=2 * extend, **kwargs)
        d = d / np.linalg.norm(d)
        return Line(p - d * extend, q + d * extend, **kwargs)

    @staticmethod
    def slope_at(graph, x, h=1e-5):
        f = Geometry.function(graph)
        return (f(x + h) - f(x - h)) / (2 * h)

    @staticmethod
    def secant_slope(graph, x, dx):
        f = Geometry.function(graph)
        return (f(x + dx) - f(x)) / dx if dx else Geometry.slope_at(graph, x)

    @staticmethod
    def integral(graph, a, b, n=2000):
        """Numerical integral of the graph's function from a to b (trapezoid rule: an approximation)."""
        f = Geometry.function(graph)
        xs = np.linspace(a, b, n + 1)
        ys = np.array([f(x) for x in xs], dtype=float)
        return float(np.sum((ys[1:] + ys[:-1]) / 2 * np.diff(xs)))

    # Lines, circles and graphs as plain data for intersections: lines are extended both ways.
    @staticmethod
    def as_line(m):
        return ("line", np.array(m.get_start()[:2], dtype=float), np.array(m.get_end()[:2], dtype=float))

    @staticmethod
    def as_circle(m):
        return ("circle", np.array(m.get_center()[:2], dtype=float), m.width / 2)

    @staticmethod
    def as_graph(axes, graph):
        return ("graph", axes, graph)

    @staticmethod
    def intersections(a, b):
        """Every point where ``a`` and ``b`` meet, in a stable order.

        Line and circle: along the line, from its start. Two circles: the point left of the line
        from the first center to the second, then the right one. Anything with a graph: by x.
        """
        if a[0] == "graph" or b[0] == "graph":
            g, other = (a, b) if a[0] == "graph" else (b, a)
            return Geometry._graph_hits(g, other)
        if a[0] == "line" and b[0] == "line":
            return Geometry._line_line(a, b)
        if a[0] == "circle" and b[0] == "circle":
            return Geometry._circle_circle(a, b)
        line, circle = (a, b) if a[0] == "line" else (b, a)
        return Geometry._line_circle(line, circle)

    @staticmethod
    def intersection(a, b, which=0):
        """The ``which``-th point where ``a`` and ``b`` meet, or None while they don't."""
        hits = Geometry.intersections(a, b)
        return hits[which] if 0 <= which < len(hits) else None

    @staticmethod
    def place(m, p):
        """Move ``m`` to ``p``; keep it where it is when ``p`` is None (e.g. the objects don't meet)."""
        if p is not None:
            m.move_to(np.array([p[0], p[1], 0.0]))
        return m

    @staticmethod
    def _cross(u, v):
        return u[0] * v[1] - u[1] * v[0]

    @staticmethod
    def _line_line(a, b):
        p, d = a[1], a[2] - a[1]
        q, e = b[1], b[2] - b[1]
        den = Geometry._cross(d, e)
        if abs(den) < 1e-12 * (np.dot(d, d) * np.dot(e, e)) ** 0.5 or not den:
            return []  # parallel
        return [p + d * Geometry._cross(q - p, e) / den]

    @staticmethod
    def _line_circle(line, circle):
        p, d = line[1], line[2] - line[1]
        c, r = circle[1], circle[2]
        aa = np.dot(d, d)
        if aa < 1e-18:
            return []
        f = p - c
        bb, cc = 2 * np.dot(f, d), np.dot(f, f) - r * r
        disc = bb * bb - 4 * aa * cc
        if disc < -1e-12 * max(1.0, bb * bb):
            return []
        if disc <= 1e-12 * max(1.0, bb * bb):
            return [p + d * (-bb / (2 * aa))]  # tangent
        s = disc ** 0.5
        return [p + d * ((-bb - s) / (2 * aa)), p + d * ((-bb + s) / (2 * aa))]

    @staticmethod
    def _circle_circle(a, b):
        c1, r1, c2, r2 = a[1], a[2], b[1], b[2]
        v = c2 - c1
        dist = float(np.linalg.norm(v))
        if dist < 1e-12 or dist > r1 + r2 + 1e-9 or dist < abs(r1 - r2) - 1e-9:
            return []
        u = v / dist
        x = (dist * dist + r1 * r1 - r2 * r2) / (2 * dist)
        h = max(r1 * r1 - x * x, 0.0) ** 0.5
        mid, n = c1 + u * x, np.array([-u[1], u[0]])
        if h < 1e-9:
            return [mid]
        return [mid + n * h, mid - n * h]

    @staticmethod
    def _graph_hits(g, other, samples=600, iterations=60):
        """Roots of a signed distance between the graph and ``other``, found by sampling and bisection."""
        axes, graph = g[1], g[2]
        f = Geometry.function(graph)

        def at(x):
            return np.array(axes.c2p(x, f(x))[:2], dtype=float)

        if other[0] == "line":
            p, d = other[1], other[2] - other[1]
            d = d / (np.linalg.norm(d) or 1)
            h = lambda x: Geometry._cross(d, at(x) - p)
        elif other[0] == "circle":
            c, r = other[1], other[2]
            h = lambda x: float(np.linalg.norm(at(x) - c)) - r
        else:
            f2 = Geometry.function(other[2])
            h = lambda x: float(axes.c2p(x, f(x))[1] - other[1].c2p(x, f2(x))[1])

        def safe(x):
            try:
                v = float(h(x))
            except (ArithmeticError, ValueError):
                return float("nan")
            return v if np.isfinite(v) else float("nan")

        lo, hi = float(graph.t_min), float(graph.t_max)
        xs = np.linspace(lo, hi, samples + 1)
        vs = [safe(x) for x in xs]
        tol = 1e-6 * max(1.0, hi - lo)
        roots = []
        for i in range(samples):
            x0, x1, v0, v1 = xs[i], xs[i + 1], vs[i], vs[i + 1]
            if np.isnan(v0) or np.isnan(v1):
                continue
            if v0 == 0:
                roots.append(x0)
                continue
            if v0 * v1 > 0:
                continue
            for _ in range(iterations):
                xm = (x0 + x1) / 2
                vm = safe(xm)
                if np.isnan(vm):
                    break
                if v0 * vm <= 0:
                    x1, v1 = xm, vm
                else:
                    x0, v0 = xm, vm
            x = (x0 + x1) / 2
            if abs(safe(x)) < 1e-4:  # a sign change across a jump (an asymptote) is not a crossing
                roots.append(x)
        if vs[-1] == 0:
            roots.append(xs[-1])
        out = []
        for x in roots:
            if not out or x - out[-1] > tol:
                out.append(x)
        return [at(x) for x in out]

    @staticmethod
    def project(p, line):
        """Foot of the perpendicular from ``p`` to ``line`` (extended)."""
        a, b = np.array(line.get_start(), dtype=float), np.array(line.get_end(), dtype=float)
        d = b - a
        n = float(np.dot(d, d))
        if n < 1e-18:
            return a
        return a + d * float(np.dot(np.array(p, dtype=float) - a, d)) / n

    @staticmethod
    def perpendicular_line(cls, line, p, length=4, foot=False, **kwargs):
        """Line through ``p`` perpendicular to ``line``: centered on ``p``, or from ``p`` to the foot."""
        p = np.array(p, dtype=float)
        d = np.array(line.get_end(), dtype=float) - np.array(line.get_start(), dtype=float)
        d = d / (np.linalg.norm(d) or 1)
        n = np.array([-d[1], d[0], 0.0])
        if foot:
            q = Geometry.project(p, line)
            if np.linalg.norm(q - p) < 1e-6:  # p is on the line: keep a valid (tiny) line
                q = p + n * 1e-6
            return cls(p, q, **kwargs)
        return cls(p - n * length / 2, p + n * length / 2, **kwargs)

    @staticmethod
    def parallel_line(cls, line, p, length=None, **kwargs):
        """Line through ``p`` parallel to ``line``, centered on ``p`` (as long as ``line`` by default)."""
        p = np.array(p, dtype=float)
        d = np.array(line.get_end(), dtype=float) - np.array(line.get_start(), dtype=float)
        if length is None:
            length = float(np.linalg.norm(d)) or 1.0
        d = d / (np.linalg.norm(d) or 1)
        return cls(p - d * length / 2, p + d * length / 2, **kwargs)
'''

TERMS_SOURCE = '''
class TransformTerms(TransformMatchingAbstractBase):
    """Transform one equation into another term by term (Manim Studio).

    Each part of the two MathTex objects gets a key; parts sharing a key transform into each
    other and the others fade out or in. The correspondence is purely visual: it does not
    check that the two equations are mathematically equivalent.
    """

    def __init__(self, mobject, target_mobject, source_keys, target_keys, **kwargs):
        for i, part in enumerate(mobject.submobjects):
            part.mathengine_key = (source_keys[i] if i < len(source_keys) else None) or f"_source{i}"
        for j, part in enumerate(target_mobject.submobjects):
            part.mathengine_key = (target_keys[j] if j < len(target_keys) else None) or f"_target{j}"
        super().__init__(mobject, target_mobject, **kwargs)

    @staticmethod
    def get_mobject_parts(mobject):
        return mobject.submobjects

    @staticmethod
    def get_mobject_key(mobject):
        return mobject.mathengine_key
'''
# Names the generated code defines at module level; objects can't use them.
RESERVED_NAMES = {"Constraints", "Geometry", "TransformTerms", "TransformMatchingAbstractBase", "np", "self"}
TERMS_IMPORT = "from manim.animation.transform_matching_parts import TransformMatchingAbstractBase"


# ----------------------------------------------------------------------------- planning

@dataclass
class Diagnostic:
    id: str  # object, step or animation id
    level: str  # "error" | "warning"
    message: str
    kind: str = "object"

    def to_json(self) -> dict:
        return {"id": self.id, "level": self.level, "message": self.message, "kind": self.kind}


@dataclass
class Plan:
    """What codegen needs to emit the constructed parts of a document."""

    lines: dict[str, list[str]] = field(default_factory=dict)  # object id -> statements (replaces the generic ones)
    after: dict[str, list[str]] = field(default_factory=dict)  # object id -> statements after its ordinary ones
    switchable: set[str] = field(default_factory=set)  # names of objects couple/uncouple steps can switch
    diagnostics: list[Diagnostic] = field(default_factory=list)
    part_index: dict[str, dict[str, int]] = field(default_factory=dict)  # equation id -> part id -> submobject index
    eq_ctor: dict[str, str] = field(default_factory=dict)  # equation id -> constructor expression
    eq_colors: dict[str, list[str]] = field(default_factory=dict)  # equation id -> per-term color statements
    uses_constraints: bool = False
    uses_geometry: bool = False
    uses_terms: bool = False
    constraints_var: str = "constraints"
    invalid_anims: set[str] = field(default_factory=set)  # animations that can't be compiled (left out)
    trackers: set[str] = field(default_factory=set)
    mobject_names: set[str] = field(default_factory=set)  # objects that are drawn (not ValueTrackers)
    helpers: set[str] = field(default_factory=set)  # math helpers its expressions need (mathexpr.HELPERS)

    def diag(self, oid: str, level: str, message: str, kind: str = "object") -> None:
        self.diagnostics.append(Diagnostic(oid, level, message, kind))


def num(v: float) -> str:
    v = round(float(v), 4)
    return repr(int(v)) if v == int(v) else repr(v)


def pystr(s: str) -> str:
    """Python literal for TeX source (raw string when possible)."""
    if '"' not in s and "\n" not in s and not s.endswith("\\"):
        return f'r"{s}"'
    return repr(s)


def _call_kwargs(args: dict, drop: set[str]) -> str:
    parts = []
    for k, v in (args or {}).items():
        if k in drop or k == "*":
            continue
        v = str(v).strip()
        if v:
            parts.append(f"{k}={v}")
    return ", ".join(parts)


def _with(prefix: str, rest: str) -> str:
    return f"{prefix}, {rest}" if rest and prefix else (prefix or rest)


def _join_chain(chain: str) -> str:
    chain = " ".join(line.strip() for line in (chain or "").splitlines() if line.strip())
    if chain and not chain.startswith("."):
        chain = "." + chain
    return chain


class _Ctx:
    def __init__(self, doc: dict, plan: Plan):
        self.doc = doc
        self.plan = plan
        self.objects = doc.get("objects", [])
        self.by_id = {o["id"]: o for o in self.objects}
        self.by_name = {o["name"]: o for o in self.objects}
        self.index = {o["id"]: i for i, o in enumerate(self.objects)}
        self.trackers = {o["name"] for o in self.objects if base_ctor(o) == "ValueTracker"}
        self.scope = defs.scope(doc.get("defs") or [])  # the scene's definitions: math can use them by name
        self.tracker_index = {o["name"]: self.index[o["id"]] for o in self.objects if base_ctor(o) == "ValueTracker"}
        # the loop counters around where each object is created (math can use them; see _expr)
        self.loops: dict[str, list[str]] = {}
        self.all_loops: set[str] = set()
        stack: list[str | None] = []
        around: dict[str, list[str]] = {}
        for st in doc.get("timeline") or []:
            if st.get("kind") == "block" and not timeline.is_clause(st):
                v = defs.loop_var(st)
                stack.append(v)
                if v:
                    self.all_loops.add(v)
            elif st.get("kind") == "end" and stack:
                stack.pop()
            around[st["id"]] = [v for v in stack if v]
        for o in self.objects:
            self.loops[o["id"]] = around.get(o.get("after") or "", [])
        self.bound: set[str] = set()  # the counters the object being built uses

    def scope_for(self, obj: dict) -> dict[str, tuple]:
        return {**self.scope, **{v: ("value", "loop") for v in self.loops.get(obj["id"], []) if v not in self.scope}}

    def name(self, oid: str) -> str:
        return self.by_id[oid]["name"]

    def type_of(self, oid: str) -> str:
        return geo_type(self.by_id[oid], self.by_name)


def _cycles(ctx: _Ctx) -> set[str]:
    """Ids of objects on a link-dependency cycle."""
    on_cycle: set[str] = set()
    state: dict[str, int] = {}
    stack: list[str] = []

    def visit(oid: str) -> None:
        state[oid] = 1
        stack.append(oid)
        for src in link_sources(ctx.by_id[oid]):
            if src not in ctx.by_id:
                continue
            if state.get(src) == 1:
                on_cycle.update(stack[stack.index(src):])
            elif not state.get(src):
                visit(src)
        stack.pop()
        state[oid] = 2

    for o in ctx.objects:
        if not state.get(o["id"]):
            visit(o["id"])
    return on_cycle


def _check_link(obj: dict, ctx: _Ctx, cyclic: set[str]) -> str | None:
    """Why this object's link can't be built, or None."""
    link = obj.get("link") or {}
    kind = link.get("kind")
    if kind not in KINDS:
        return f"Unknown construction kind {kind!r}."
    if obj["id"] in cyclic:
        return "This construction depends on itself (a dependency cycle). Uncouple or forget one of the relationships in the cycle."
    me = ctx.index[obj["id"]]
    checks = list(SOURCES.get(kind, []))
    if kind == "polygon":
        pts = list(link.get("points") or [])
        if len(pts) < 3:
            return "A polygon needs at least three points."
        checks = [(f"points[{i}]", None, True) for i in range(len(pts))]
        values = {f"points[{i}]": p for i, p in enumerate(pts)}
    else:
        values = link
    for fname, accepts, required in checks:
        sid = values.get(fname)
        if not sid:
            if required:
                return f"Missing source: {fname} isn't set."
            continue
        src = ctx.by_id.get(sid)
        if src is None:
            return f"Missing source: the object for {fname} was deleted."
        if sid == obj["id"]:
            return "An object can't be built from itself."
        if ctx.index[sid] > me:
            return f"{src['name']} is defined after {obj['name']}; move {obj['name']} below it."
        if accepts is not None and ctx.type_of(sid) not in accepts:
            return f"{src['name']} is a {ctx.type_of(sid)}, but {fname} needs a {' or '.join(sorted(accepts))}."
    if kind in ("on_graph", "tangent", "secant", "area", "riemann"):
        axes = graph_axes_id(ctx.by_id[link["graph"]], ctx.by_name)
        if not axes or axes not in ctx.by_id:
            return "The graph isn't plotted on an Axes object in this scene."
    if kind == "intersection":
        a, b = link["a"], link["b"]
        if a == b:
            return "Pick two different objects to intersect."
        types = [ctx.type_of(a), ctx.type_of(b)]
        if sum(t in ("axes", "numberline") for t in types) == 2:
            return "Intersect a line, circle or graph with the axes, not two axes."
        graph_axes = []
        for sid in (a, b):
            if ctx.type_of(sid) == "graph":
                axes = graph_axes_id(ctx.by_id[sid], ctx.by_name)
                if not axes or axes not in ctx.by_id:
                    return f"{ctx.name(sid)} isn't plotted on an Axes object in this scene."
                graph_axes.append(axes)
        if len(graph_axes) == 2 and graph_axes[0] != graph_axes[1]:
            return "Both graphs must be plotted on the same axes."
        which = link.get("which", 0)
        if not isinstance(which, int) or isinstance(which, bool) or which < 0:
            return "Pick which intersection to use (0 for the first)."
    if kind in ("perpendicular", "parallel", "projection"):
        line = link["onto"] if kind == "projection" else link["line"]
        if line == (link.get("point") if kind == "projection" else link.get("through")):
            return "The point and the line must be different objects."
    if kind == "measure":
        what = link.get("what")
        if what not in MEASURES:
            return f"Unknown measurement {what!r}."
        need = MEASURES[what]
        if need is not None:
            if not link.get("of"):
                return f"Measuring {what} needs a source object."
            if ctx.type_of(link["of"]) not in need:
                return f"Measuring {what} needs a {' or '.join(sorted(need))}."
        if what == "value" and not str(link.get("expr", "")).strip():
            return "Enter the value to show."
        if base_ctor(obj) not in ("DecimalNumber", "Integer"):
            return "Measurements are shown with a DecimalNumber."
    if kind in ("brace", "highlight", "attach") and link.get("parts"):
        if ctx.type_of(link.get("target") or link.get("to")) != "equation":
            return "Terms can only be selected on an equation."
        tgt = link.get("target") or link.get("to")
        missing = [p for p in link["parts"] if p not in ctx.plan.part_index.get(tgt, {})]
        if missing:
            return "Some selected terms no longer exist in the equation."
    return None


def _expr(ctx: _Ctx, obj: dict, text, default: str, uses: list[str]) -> str:
    src = str(text if text not in (None, "") else default)
    here = ctx.scope_for(obj)
    try:
        py, params = mathexpr.compile_value(src, ctx.trackers, here, ctx.plan.helpers)
    except mathexpr.ExprError as e:
        outside = next((v for v in sorted(ctx.all_loops - set(here)) if re.search(rf"\b{v}\b", src)), None)
        if outside:
            raise mathexpr.ExprError(f"{outside} is the counter of a Repeat, and {obj['name']} is created outside it.",
                                     "Create it inside the Repeat: Properties › In the code › Created.") from e
        raise
    for v in ctx.loops.get(obj["id"], []):
        if v not in ctx.scope and re.search(rf"\b{v}\b", py):
            ctx.bound.add(v)
    me = ctx.index[obj["id"]]
    for p in params:
        if ctx.tracker_index[p] > me:
            raise mathexpr.ExprError(f"Parameter {p!r} is defined after {obj['name']}; move {obj['name']} below it.")
        if p not in uses:
            uses.append(p)
    return py


def _part_group(ctx: _Ctx, eq_id: str, part_ids: list[str]) -> str:
    name = ctx.name(eq_id)
    idx = sorted(ctx.plan.part_index[eq_id][p] for p in part_ids)
    if len(idx) == 1:
        return f"{name}[{idx[0]}]"
    return f"VGroup({', '.join(f'{name}[{i}]' for i in idx)})"


def _target(ctx: _Ctx, link: dict, key: str) -> str:
    tid = link[key]
    return _part_group(ctx, tid, link["parts"]) if link.get("parts") else ctx.name(tid)


def plan(doc: dict) -> Plan:
    p = Plan()
    ctx = _Ctx(doc, p)
    p.trackers = ctx.trackers
    p.mobject_names = {o["name"] for o in ctx.objects if not re.fullmatch(r"(Complex)?ValueTracker", base_ctor(o))}
    taken = {o["name"] for o in ctx.objects}
    while p.constraints_var in taken:
        p.constraints_var += "_"

    # Equation parts first: links refer to them.
    for obj in ctx.objects:
        if (obj.get("eq") or {}).get("parts") and _equation(obj, p):
            p.lines[obj["id"]] = _plain_equation_lines(obj, p)

    for obj in ctx.objects:
        if obj["name"] in RESERVED_NAMES:
            p.diag(obj["id"], "error", f"{obj['name']!r} is a name the generated code uses; rename this object.")

    cyclic = _cycles(ctx)
    switched = _switch_targets(doc, ctx)
    for obj in ctx.objects:
        link = obj.get("link")
        if not link:
            continue
        off = bool(link.get("off"))
        if off and link.get("kind") in STANDALONE_KINDS and obj["name"] not in switched:
            continue  # uncoupled for the whole scene: an ordinary object
        why = _check_link(obj, ctx, cyclic)
        if why is None:
            try:
                lines = _link_lines(obj, ctx, switched=obj["name"] in switched)
                if off and link["kind"] in STANDALONE_KINDS:
                    p.after[obj["id"]] = lines  # the ordinary object, then its construction (paused)
                else:
                    p.lines[obj["id"]] = lines
                if obj["name"] in switched and not link.get("frozen"):
                    p.switchable.add(obj["name"])
                continue
            except mathexpr.ExprError as exc:
                why = exc.message
            except KeyError as exc:
                why = f"Missing source ({exc})."
        if off and link.get("kind") in STANDALONE_KINDS:
            p.diag(obj["id"], "warning", f"{why} It stays uncoupled.")
            continue
        p.diag(obj["id"], "error", why)
        fallback = _fallback_lines(obj, ctx)
        if fallback is not None:
            p.lines[obj["id"]] = fallback

    _check_conflicts(doc, ctx)
    _check_term_anims(doc, ctx)
    _check_switch_steps(doc, ctx)
    return p


def _switches(doc: dict) -> list[dict]:
    return [s for s in timeline.steps(doc) if s.get("kind") in SWITCH_CLIPS]


def _switch_targets(doc: dict, ctx: _Ctx) -> set[str]:
    """Names of constructed objects that couple / uncouple steps switch."""
    out = set()
    for c in _switches(doc):
        for n in c.get("targets") or []:
            obj = ctx.by_name.get(n)
            if obj and obj.get("link"):
                out.add(n)
    return out


def _check_switch_steps(doc: dict, ctx: _Ctx) -> None:
    for c in _switches(doc):
        for n in c.get("targets") or []:
            obj = ctx.by_name.get(n)
            if obj is None:
                continue
            if not obj.get("link"):
                ctx.plan.diag(c["id"], "warning", f"{n} has no relationship to {c['kind']}; it is skipped.", "step")
            elif obj["link"].get("frozen"):
                ctx.plan.diag(c["id"], "warning", f"{n}'s construction is frozen (built once), so it can't be "
                              f"{c['kind']}d; it is skipped.", "step")
            elif n not in ctx.plan.switchable:
                ctx.plan.diag(c["id"], "warning", f"{n}'s construction has an error, so it can't be {c['kind']}d.", "step")


def _fallback_lines(obj: dict, ctx: _Ctx) -> list[str] | None:
    """An object whose construction is broken: a plain object (follow) or an empty placeholder (redraw).

    None means "emit it as an ordinary object" (equations keep their term lines from the first pass).
    """
    kind = (obj.get("link") or {}).get("kind")
    if kind in FOLLOW_KINDS:
        return None
    return [f"{obj['name']} = VMobject()  # construction error: see Manim Studio diagnostics"]


def _plain_equation_lines(obj: dict, p: Plan) -> list[str]:
    name = obj["name"]
    return [f"{name} = {p.eq_ctor[obj['id']]}"] + p.eq_colors[obj["id"]] + _transforms(obj, name, with_pos=True)


def _generic_ctor(obj: dict, ctx: _Ctx, drop: set[str] = frozenset()) -> str:
    """Constructor call for a follow-link object (its own ctor and args)."""
    ctor = base_ctor(obj)
    args = obj.get("args") or {}
    star = str(args.get("*", "")).strip()
    if obj["id"] in ctx.plan.eq_ctor:  # an equation split into terms
        return ctx.plan.eq_ctor[obj["id"]]
    return f"{ctor}({_with(star, _call_kwargs(args, set(drop)))})"


def _transforms(obj: dict, name: str, with_pos: bool) -> list[str]:
    out = []
    chain = _join_chain(obj.get("chain", ""))
    if chain:
        out.append(f"{name}{chain}")
    stretch = obj.get("stretch") or [1, 1]
    for dim, f in enumerate(stretch[:2]):
        if abs(float(f) - 1) > 1e-6:
            out.append(f"{name}.stretch({num(f)}, {dim})")
    if obj.get("scale") not in (None, 1, 1.0):
        out.append(f"{name}.scale({num(obj['scale'])})")
    if obj.get("rotation"):
        out.append(f"{name}.rotate({num(obj['rotation'])} * DEGREES)")
    pos = obj.get("pos")
    if with_pos and pos is not None:
        out.append(f"{name}.move_to(np.array([{num(pos[0])}, {num(pos[1])}, 0]))")
    return out


def _equation(obj: dict, p: Plan) -> bool:
    """MathTex built from explicit parts, one submobject per term."""
    ctor = base_ctor(obj)
    parts = (obj.get("eq") or {}).get("parts") or []
    if ctor not in EQUATION_CTORS or ctor == "SingleStringMathTex":
        p.diag(obj["id"], "error", "Term editing needs a MathTex or Tex object.")
        return False
    args = dict(obj.get("args") or {})
    if str(args.get("organize_left_to_right", "")).strip() == "True":
        p.diag(obj["id"], "error", "organize_left_to_right reorders terms, so it can't be used with term editing.")
        args.pop("organize_left_to_right")
    if "substrings_to_isolate" in args or "tex_to_color_map" in args:
        p.diag(obj["id"], "warning", "substrings_to_isolate / tex_to_color_map are ignored for term-split equations; color the terms instead.")
        args.pop("substrings_to_isolate", None)
        args.pop("tex_to_color_map", None)
    texs, index = [], {}
    for part in parts:
        tex = str(part.get("tex", ""))
        if not tex.strip():
            p.diag(obj["id"], "warning", "An empty term was skipped.")
            continue
        # manim splits strings at "{{" (start or after whitespace); "{ {" means the same in TeX.
        tex = tex.replace("{{", "{ {")
        index[part["id"]] = len(texs)
        texs.append(tex)
    if not texs:
        p.diag(obj["id"], "error", "The equation has no terms.")
        return False
    p.part_index[obj["id"]] = index
    name = obj["name"]
    p.eq_ctor[obj["id"]] = f"{ctor}({_with(', '.join(pystr(t) for t in texs), _call_kwargs(args, {'*'}))})"
    p.eq_colors[obj["id"]] = [f"{name}[{index[part['id']]}].set_color({part['color']})"
                              for part in parts if part.get("color") and part["id"] in index]
    return True


def _link_lines(obj: dict, ctx: _Ctx, switched: bool = False) -> list[str]:
    """Statements that build a constructed object (_build_link). Created in a loop and using its counter, the
    functions it is kept up with keep the counter of their own run (``lambda m, k=k:``), not the loop's last."""
    ctx.bound = set()
    lines = _build_link(obj, ctx, switched)
    if ctx.bound:
        bind = ", ".join(f"{v}={v}" for v in sorted(ctx.bound))
        lines = [ln.replace("lambda m: ", f"lambda m, {bind}: ").replace("lambda: ", f"lambda {bind}: ") for ln in lines]
    return lines


def _build_link(obj: dict, ctx: _Ctx, switched: bool = False) -> list[str]:
    """Statements that build a constructed object. ``switched``: couple / uncouple steps switch it.

    An uncoupled (``off``) standalone object is emitted as an ordinary object; these are then the
    statements that register its construction, paused. Other uncoupled kinds are built once from their
    sources (and registered paused when steps couple them later).
    """
    link = obj["link"]
    kind = link["kind"]
    name = obj["name"]
    p = ctx.plan
    frozen = bool(link.get("frozen"))
    off = bool(link.get("off")) and not frozen
    uses: list[str] = []  # parameters read
    srcs = [ctx.name(s) for s in link_sources(obj)]
    args = obj.get("args") or {}
    cvar = p.constraints_var

    def deps() -> str:
        names = list(dict.fromkeys(srcs + uses))
        return "".join(f", {n}" for n in names)

    # ---------------- follow kinds: ordinary object + a placement
    if kind in FOLLOW_KINDS:
        ctor_call = _generic_ctor(obj, ctx)
        place, extra = _placement(obj, ctx, uses)
        pre = [f"{name} = {ctor_call}"] + p.eq_colors.get(obj["id"], [])
        # A value label without an anchor keeps its own position; every other follow link owns it. An
        # intersection starts at its own position, where it stays while its sources don't meet.
        free = kind == "measure" and link.get("what") == "value" and not link.get("of")
        pre += _transforms(obj, name, with_pos=free or kind == "intersection")
        if frozen:
            return pre + [f"({place})({name})"]
        p.uses_constraints = True
        if extra:
            p.uses_geometry = True
        if off:
            return [f"{cvar}.follow({name}, {place}{deps()}, paused=True)"]
        return pre + [f"{cvar}.follow({name}, {place}{deps()})"]

    # ---------------- redraw kinds: geometry rebuilt from sources
    build = _builder(obj, ctx, uses)
    chain = _join_chain(obj.get("chain", ""))
    build = build + chain
    if frozen or (off and not switched):
        return [f"{name} = {build}"]
    p.uses_constraints = True
    if off and kind in STANDALONE_KINDS:
        return [f"{cvar}.redraw(lambda: {build}{deps()}, mob={name}, paused=True)"]
    if off:
        return [f"{name} = {cvar}.redraw(lambda: {build}{deps()}, paused=True)"]
    return [f"{name} = {cvar}.redraw(lambda: {build}{deps()})"]


def _offset(link: dict) -> str:
    off = link.get("offset") or [0, 0]
    if abs(float(off[0])) < 1e-9 and abs(float(off[1])) < 1e-9:
        return ""
    return f" + np.array([{num(off[0])}, {num(off[1])}, 0])"


def _placement(obj: dict, ctx: _Ctx, uses: list[str]) -> tuple[str, bool]:
    """``lambda m: …`` that positions a follow-link object; second value: needs geometry helpers."""
    link = obj["link"]
    kind = link["kind"]
    n = ctx.name
    if kind == "attach":
        return f"lambda m: m.move_to({_target(ctx, link, 'to')}.get_center(){_offset(link)})", False
    if kind == "midpoint":
        a = n(link["a"])
        if link.get("b"):
            return f"lambda m: m.move_to(({a}.get_center() + {n(link['b'])}.get_center()) / 2)", False
        return f"lambda m: m.move_to(({a}.get_start() + {a}.get_end()) / 2)", False
    if kind == "on_graph":
        g = ctx.by_id[link["graph"]]
        axes = n(graph_axes_id(g, ctx.by_name))
        x = _expr(ctx, obj, link.get("x"), "0", uses)
        if axes not in [ctx.name(s) for s in link_sources(obj)]:
            uses.append(axes)
        return f"lambda m: m.move_to({axes}.i2gp({x}, {n(link['graph'])}))", False
    if kind == "on_circle":
        ang = _expr(ctx, obj, link.get("angle"), "0", uses)
        return f"lambda m: m.move_to({n(link['circle'])}.point_at_angle({ang}))", False
    if kind == "coords":
        ax = n(link["axes"])
        x = _expr(ctx, obj, link.get("x"), "0", uses)
        if ctx.type_of(link["axes"]) == "numberline":
            return f"lambda m: m.move_to({ax}.n2p({x}))", False
        y = _expr(ctx, obj, link.get("y"), "0", uses)
        return f"lambda m: m.move_to({ax}.c2p({x}, {y}))", False
    if kind == "intersection":
        a, b = _shape(ctx, link, "a", uses), _shape(ctx, link, "b", uses)
        return f"lambda m: Geometry.place(m, Geometry.intersection({a}, {b}, {int(link.get('which', 0))}))", True
    if kind == "projection":
        pt = f"{n(link['point'])}.get_center()"
        onto = link["onto"]
        if ctx.type_of(onto) == "axes":
            ax = n(onto)
            foot = f"{ax}.c2p(0, {ax}.p2c({pt})[1])" if link.get("axis") == "y" else f"{ax}.c2p({ax}.p2c({pt})[0], 0)"
            return f"lambda m: m.move_to({foot})", False
        return f"lambda m: m.move_to(Geometry.project({pt}, {n(onto)}))", True
    if kind == "measure":
        what = link["what"]
        of = link.get("of")
        src = ctx.by_id.get(of) if of else None
        geometry = False
        if what == "length":
            value, anchor = f"{n(of)}.get_length()", f"{n(of)}.get_center()"
        elif what == "angle":
            deg = link.get("degrees", True)
            value, anchor = f"{n(of)}.get_value(degrees={bool(deg)})", f"{n(of)}.get_center()"
        elif what == "slope":
            sl = src.get("link") or {}
            if sl.get("kind") == "tangent":
                x = _expr(ctx, src, sl.get("x"), "0", uses)
                value = f"Geometry.slope_at({n(sl['graph'])}, {x})"
                geometry = True
                _add_dep(uses, ctx, sl.get("graph"))
            elif sl.get("kind") == "secant":
                x = _expr(ctx, src, sl.get("x"), "0", uses)
                dx = _expr(ctx, src, sl.get("dx"), "1", uses)
                value = f"Geometry.secant_slope({n(sl['graph'])}, {x}, {dx})"
                geometry = True
                _add_dep(uses, ctx, sl.get("graph"))
            else:
                value = f"{n(of)}.get_slope()"
            anchor = f"{n(of)}.get_center()"
        elif what == "integral":
            sl = src.get("link") or {}
            if sl.get("kind") not in ("area", "riemann"):
                raise mathexpr.ExprError("Integral values are measured on a shaded area or Riemann rectangles built by Manim Studio.")
            a = _expr(ctx, src, sl.get("a"), "0", uses)
            b = _expr(ctx, src, sl.get("b"), "1", uses)
            value = f"Geometry.integral({n(sl['graph'])}, {a}, {b})"
            geometry = True
            _add_dep(uses, ctx, sl.get("graph"))
            anchor = f"{n(of)}.get_center()"
        else:
            value = _expr(ctx, obj, link.get("expr"), "0", uses)
            anchor = f"{n(of)}.get_center()" if of else ""
        if anchor:
            return f"lambda m: m.set_value({value}).move_to({anchor}{_offset(link)})", geometry
        return f"lambda m: m.set_value({value})", geometry
    raise mathexpr.ExprError(f"Unknown construction kind {kind!r}.")


def _straight(ctx: _Ctx, link: dict, key: str) -> str:
    """A source used as a straight line: the object, or an axes object's x- or y-axis."""
    sid = link[key]
    if ctx.type_of(sid) == "axes":
        return f"{ctx.name(sid)}.get_{'y' if link.get('axis') == 'y' else 'x'}_axis()"
    return ctx.name(sid)


def _shape(ctx: _Ctx, link: dict, key: str, uses: list[str]) -> str:
    """A source as intersection data (``Geometry.as_line`` / ``as_circle`` / ``as_graph``)."""
    sid = link[key]
    t = ctx.type_of(sid)
    if t == "circle":
        return f"Geometry.as_circle({ctx.name(sid)})"
    if t == "graph":
        axes_id = graph_axes_id(ctx.by_id[sid], ctx.by_name)
        _add_dep(uses, ctx, axes_id)
        return f"Geometry.as_graph({ctx.name(axes_id)}, {ctx.name(sid)})"
    return f"Geometry.as_line({_straight(ctx, link, key)})"


def _add_dep(uses: list[str], ctx: _Ctx, oid: str | None) -> None:
    if oid and oid in ctx.by_id and ctx.name(oid) not in uses:
        uses.append(ctx.name(oid))


def _builder(obj: dict, ctx: _Ctx, uses: list[str]) -> str:
    """Expression that builds a redraw-link object from its sources."""
    link = obj["link"]
    kind = link["kind"]
    n = ctx.name
    args = obj.get("args") or {}
    ctor = base_ctor(obj)
    p = ctx.plan

    def kw(*drop: str) -> str:
        return _call_kwargs(args, set(drop))

    if kind == "segment":
        cls = ctor if ctor in LINE_CTORS and ctor not in ("Vector", "TangentLine") else "Line"
        a, b = n(link["a"]), n(link["b"])
        ends = f"{a}, {b}" if link.get("mode") == "boundary" else f"{a}.get_center(), {b}.get_center()"
        return f"{cls}({_with(ends, kw('start', 'end'))})"
    if kind == "circle2":
        a, b = f"{n(link['a'])}.get_center()", f"{n(link['b'])}.get_center()"
        rest = kw("radius", "arc_center")
        if link.get("mode") == "diameter":
            return f"Circle({_with(f'radius=np.linalg.norm({b} - {a}) / 2', rest)}).move_to(({a} + {b}) / 2)"
        return f"Circle({_with(f'radius=np.linalg.norm({b} - {a})', rest)}).move_to({a})"
    if kind in ("perpendicular", "parallel"):
        cls = ctor if ctor in LINE_CTORS and ctor not in ("Vector", "TangentLine") else "Line"
        line, through = _straight(ctx, link, "line"), f"{n(link['through'])}.get_center()"
        p.uses_geometry = True
        if kind == "perpendicular" and link.get("mode") == "foot":
            return f"Geometry.perpendicular_line({_with(f'{cls}, {line}, {through}, foot=True', kw('start', 'end'))})"
        if kind == "perpendicular":
            length = _expr(ctx, obj, link.get("length"), "4", uses)
            return f"Geometry.perpendicular_line({_with(f'{cls}, {line}, {through}, length={length}', kw('start', 'end'))})"
        length = (f", length={_expr(ctx, obj, link['length'], '', uses)}" if str(link.get("length", "")).strip() else "")
        return f"Geometry.parallel_line({_with(f'{cls}, {line}, {through}{length}', kw('start', 'end'))})"
    if kind == "polygon":
        pts = ", ".join(f"{n(s)}.get_center()" for s in link["points"])
        return f"Polygon({_with(pts, kw())})"
    if kind == "angle":
        extra = []
        if str(link.get("radius", "")).strip():
            extra.append(f"radius={_expr(ctx, obj, link['radius'], '0.5', uses)}")
        if link.get("other"):
            extra.append("other_angle=True")
        q = link.get("quadrant")
        if q and list(q) != [1, 1]:
            extra.append(f"quadrant=({int(q[0])}, {int(q[1])})")
        return f"Angle({_with(', '.join([n(link['l1']), n(link['l2'])] + extra), kw('line1', 'line2', 'radius', 'other_angle', 'quadrant'))})"
    if kind == "graph":
        axes = n(link["axes"])
        body, params = mathexpr.compile_function(str(link.get("expr", "")), ctx.trackers, scope=ctx.scope, helpers=ctx.plan.helpers)
        me = ctx.index[obj["id"]]
        for prm in params:
            if ctx.tracker_index[prm] > me:
                raise mathexpr.ExprError(f"Parameter {prm!r} is defined after {obj['name']}; move {obj['name']} below it.")
            if prm not in uses:
                uses.append(prm)
        extra = []
        lo, hi = link.get("x_min"), link.get("x_max")
        if lo not in (None, "") and hi not in (None, ""):
            extra.append(f"x_range=[{num(lo)}, {num(hi)}]")
        disc = [d for d in (link.get("discontinuities") or []) if d not in (None, "")]
        if disc:
            extra.append(f"discontinuities=[{', '.join(num(d) for d in disc)}]")
            extra.append(f"dt={num(link.get('gap') or 0.01)}")
            extra.append("use_smoothing=False")
        call = _with(f"lambda x: {body}", ", ".join(extra))
        return f"{axes}.plot({_with(call, kw('function', 'x_range', 'discontinuities', 'dt'))})"
    if kind in ("tangent", "secant"):
        g = ctx.by_id[link["graph"]]
        axes_id = graph_axes_id(g, ctx.by_name)
        axes = n(axes_id)
        _add_dep(uses, ctx, axes_id)
        x = _expr(ctx, obj, link.get("x"), "0", uses)
        g = n(link["graph"])
        p.uses_geometry = True
        if kind == "tangent":
            length = _expr(ctx, obj, link.get("length"), "4", uses)
            return f"Geometry.tangent_line({_with(f'{axes}, {g}, {x}, length={length}', kw('start', 'end'))})"
        dx = _expr(ctx, obj, link.get("dx"), "1", uses)
        ext = _expr(ctx, obj, link.get("length"), "1", uses)
        return f"Geometry.secant_line({_with(f'{axes}, {g}, {x}, {dx}, extend={ext}', kw('start', 'end'))})"
    if kind in ("area", "riemann"):
        g = ctx.by_id[link["graph"]]
        axes_id = graph_axes_id(g, ctx.by_name)
        axes = n(axes_id)
        _add_dep(uses, ctx, axes_id)
        a = _expr(ctx, obj, link.get("a"), "0", uses)
        b = _expr(ctx, obj, link.get("b"), "1", uses)
        la, lb = mathexpr.literal(a), mathexpr.literal(b)
        rng = (f"x_range=[{num(min(la, lb))}, {num(max(la, lb))}]" if la is not None and lb is not None
               else f"x_range=[min({a}, {b}), max({a}, {b})]")
        extra = [rng]
        if link.get("bounded"):
            extra.append(f"bounded_graph={n(link['bounded'])}")
        if kind == "area":
            return f"{axes}.get_area({_with(', '.join([n(link['graph'])] + extra), kw('graph', 'x_range', 'bounded_graph'))})"
        dx = _expr(ctx, obj, link.get("dx"), "0.5", uses)
        ldx = mathexpr.literal(dx)
        extra.append(f"dx={num(max(ldx, 0.001))}" if ldx is not None else f"dx=max({dx}, 0.001)")
        sample = link.get("sample") or "left"
        if sample in ("left", "right", "center"):
            extra.append(f'input_sample_type="{sample}"')
        return f"{axes}.get_riemann_rectangles({_with(', '.join([n(link['graph'])] + extra), kw('graph', 'x_range', 'dx', 'input_sample_type', 'bounded_graph'))})"
    if kind == "brace":
        direction = link.get("direction") or "DOWN"
        target = _target(ctx, link, "target")
        return f"Brace({_with(f'{target}, direction={direction}', kw('mobject', 'direction'))})"
    if kind == "highlight":
        style = link.get("style") or "box"
        cls = {"box": "SurroundingRectangle", "background": "BackgroundRectangle", "underline": "Underline"}.get(style, "SurroundingRectangle")
        return f"{cls}({_with(_target(ctx, link, 'target'), kw('mobject'))})"
    raise mathexpr.ExprError(f"Unknown construction kind {kind!r}.")


def _chain_methods(chain: str) -> list[str]:
    return re.findall(r"\.([A-Za-z_]\w*)\s*\(", chain or "")


def _check_conflicts(doc: dict, ctx: _Ctx) -> None:
    """Animations that would fight a construction over the same property.

    Walks the timeline in order: an object is uncoupled from an ``uncouple`` step until a ``couple`` step
    (or for the whole scene by its own setting), and animating it meanwhile is fine.
    """
    linked = {o["name"]: o for o in ctx.objects if o.get("link") and not o["link"].get("frozen")
              and (not o["link"].get("off") or o["name"] in ctx.plan.switchable)}
    off = {n for n, o in linked.items() if o["link"].get("off")}
    for step in timeline.steps(doc):
        if step.get("kind") == "uncouple":
            off.update(step.get("targets") or [])
        elif step.get("kind") == "couple":
            off.difference_update(step.get("targets") or [])
        if step.get("kind") != "play":
            continue
        for c in timeline.walk(step.get("anims") or []):
            obj = linked.get((c.get("target") or "").strip())
            if not obj or obj["name"] in off:
                continue
            kind = obj["link"]["kind"]
            owned = POSITION_METHODS if kind in FOLLOW_KINDS else GEOMETRY_METHODS
            what = "position" if kind in FOLLOW_KINDS else "shape and position"
            if c.get("cls") == "animate":
                bad = [m for m in _chain_methods(c.get("chain", "")) if m in owned]
                if bad:
                    ctx.plan.diag(c["id"], "warning", f"{obj['name']}'s {what} is controlled by its construction, so .{bad[0]}() is undone "
                                  "when the animation ends. Animate its sources (or a parameter) instead, or uncouple it before "
                                  "this animation.", "anim")
            elif c.get("cls") in GEOMETRY_ANIMATIONS and kind in REDRAW_KINDS:
                ctx.plan.diag(c["id"], "warning", f"{obj['name']}'s shape is controlled by its construction; it returns to the constructed "
                              f"shape after {c['cls']} ends.", "anim")
    for o in linked.values():
        kind = o["link"]["kind"]
        if o["link"].get("off"):
            continue
        moved = o.get("pos") is not None
        if kind in REDRAW_KINDS and (moved or o.get("scale") not in (None, 1, 1.0) or o.get("rotation")
                                     or (o.get("stretch") or [1, 1]) != [1, 1]):
            ctx.plan.diag(o["id"], "warning", "Position, scale and rotation are ignored: the construction defines this shape.")


def term_keys(source_parts: list[str], target_parts: list[str], pairs: list[list[str]]) -> tuple[list, list]:
    """Keys for TransformTerms from explicit (source part id, target part id) pairs.

    Connected pairs share one key, so many-to-one and one-to-many correspondences work.
    """
    parent: dict[str, str] = {}

    def find(a: str) -> str:
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for s, t in pairs:
        if s in source_parts and t in target_parts:
            parent[find("s:" + s)] = find("t:" + t)
    roots: dict[str, str] = {}
    paired = {"s:" + s for s, t in pairs if s in source_parts and t in target_parts} | {"t:" + t for s, t in pairs if s in source_parts and t in target_parts}

    def key(node: str) -> str | None:
        if node not in paired:
            return None
        r = find(node)
        roots.setdefault(r, f"k{len(roots)}")
        return roots[r]

    return [key("s:" + s) for s in source_parts], [key("t:" + t) for t in target_parts]


def _check_term_anims(doc: dict, ctx: _Ctx) -> None:
    for _step, c in timeline.all_anims(doc):
        if c.get("cls") != "TransformTerms":
            continue
        src = ctx.by_name.get((c.get("target") or "").strip())
        terms = c.get("terms") or {}
        tgt = ctx.by_id.get(terms.get("to") or "")
        why = None
        if not src or src["id"] not in ctx.plan.part_index:
            why = "The source must be an equation split into terms."
        elif not tgt or tgt["id"] not in ctx.plan.part_index:
            why = "Pick a destination equation split into terms."
        if why:
            ctx.plan.diag(c["id"], "error", why + " This animation is left out.", "anim")
            ctx.plan.invalid_anims.add(c["id"])
        else:
            ctx.plan.uses_terms = True


def terms_expr(anim: dict, doc: dict, plan_: Plan) -> str:
    """``TransformTerms(source, target, source_keys=…, target_keys=…)`` for a term-correspondence animation."""
    by_name = {o["name"]: o for o in doc.get("objects", [])}
    by_id = {o["id"]: o for o in doc.get("objects", [])}
    src = by_name[anim["target"].strip()]
    tgt = by_id[anim["terms"]["to"]]
    si, ti = plan_.part_index[src["id"]], plan_.part_index[tgt["id"]]
    s_order = sorted(si, key=si.get)
    t_order = sorted(ti, key=ti.get)
    sk, tk = term_keys(s_order, t_order, anim["terms"].get("pairs") or [])
    args = [f"source_keys={json.dumps(sk)}".replace("null", "None"), f"target_keys={json.dumps(tk)}".replace("null", "None")]
    for k, v in (anim.get("args") or {}).items():
        if str(v).strip():
            args.append(f"{k}={v}")
    return f"TransformTerms({src['name']}, {tgt['name']}, {', '.join(args)})"
