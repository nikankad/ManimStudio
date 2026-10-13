"""Import manim code: a Python file with a Scene becomes a Manim Studio document (codegen.py in reverse).

Each statement of ``construct()`` becomes the document element that codegen compiles back to it:

* ``name = SomeMobject(...)``, with the method calls on ``name`` right after it: an object, created where
  the code creates it (``after``: the timeline step it follows; none for objects made before any step).
* ``self.play(Create(c), c.animate.shift(UP), run_time=2)``: a play step with its animations.
  Compositions (``AnimationGroup``, ``LaggedStart``, ``Succession``) keep their child animations.
* ``self.wait(1)``, ``self.add(a, b)``, ``self.remove(a)``: wait, add and remove steps.
* ``obj.next_to(u, UP)``, ``group[0].set_color(RED)``: methods called on an object later in the scene, an apply
  step (it happens at once, between the statements around it).
* anything else (loops, updaters, helper variables…): a code step, kept as written. Consecutive
  statements of this kind form one code step.

Module-level code other than the scene (imports, helpers, custom Mobject classes) becomes the header (the
footer: what comes after the scene class), the scene's decorators and other members are kept as written, and the comments above statements stay with them. So the
code generated from the imported document runs exactly like the original.

With ``base`` (the document the code was generated from), statements that are unchanged keep their document
elements as they were: ids, constructions, equation terms, disabled animations and steps.
"""

from __future__ import annotations

import ast
import copy
import functools
import inspect
import re
import textwrap
import uuid
from dataclasses import dataclass, field
from typing import Any

from . import catalog, codegen, construct, project, tex

# Lines codegen writes itself; dropped from the header so they aren't written twice.
_AUTO_IMPORTS = {"from manim import *", "import numpy as np", "import svgelements as se", construct.TERMS_IMPORT}
_HELPERS = (construct.CONSTRAINTS_SOURCE, construct.GEOMETRY_SOURCE, construct.TERMS_SOURCE, tex.NUMBERS_SOURCE)
_CONFIG_NUMBERS = {"pixel_width", "pixel_height", "frame_rate"}
_NUMBER = r"-?\d+(?:\.\d+)?(?:e-?\d+)?"


class CodeError(Exception):
    """The code can't be imported (syntax error, no Scene)."""

    def __init__(self, message: str, line: int | None = None):
        super().__init__(message)
        self.message = message
        self.line = line


@dataclass
class Imported:
    doc: dict
    scenes: list[str]  # every Scene class in the file; ``doc`` is one of them
    notes: list[str] = field(default_factory=list)  # what was kept as code, and why


def _id(prefix: str) -> str:
    return prefix + uuid.uuid4().hex[:7]


def _parse(src: str) -> ast.Module:
    try:
        return ast.parse(src)
    except SyntaxError as exc:
        raise CodeError(f"Python can't read this code: {exc.msg} (line {exc.lineno})", exc.lineno) from None


def _is_scene_class(node: ast.ClassDef, scenes: set[str], local: dict[str, ast.ClassDef]) -> bool:
    for b in node.bases:
        name = ast.unparse(b).split(".")[-1]
        if name in scenes or (name in local and local[name] is not node and _is_scene_class(local[name], scenes, local)):
            return True
    return False


def _manim_scenes() -> set[str]:
    m = catalog.manim()
    return {k for k, v in vars(m).items() if isinstance(v, type) and issubclass(v, m.Scene)}


def _has_construct(node: ast.ClassDef) -> bool:
    return any(isinstance(n, ast.FunctionDef) and n.name == "construct" for n in node.body)


def scenes_in(src: str) -> list[str]:
    """Names of the Scene classes defined in ``src`` that have a ``construct``, in file order."""
    tree = _parse(src)
    classes = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
    scenes = _manim_scenes()
    return [n.name for n in classes.values() if _is_scene_class(n, scenes, classes) and _has_construct(n)]


# ----------------------------------------------------------------------------- reading values

class _Source:
    def __init__(self, src: str):
        self.src = src
        self.lines = src.splitlines()

    def seg(self, node: ast.AST) -> str:
        text = ast.get_source_segment(self.src, node) or ast.unparse(node)
        if "\n" in text:  # continuation lines keep their indentation relative to each other
            first, rest = text.split("\n", 1)
            text = first + "\n" + textwrap.dedent(rest)
        return text

    def block(self, first: int, last: int) -> str:
        """Lines ``first``..``last`` (1-based, inclusive), dedented."""
        return textwrap.dedent("\n".join(self.lines[first - 1:last])).strip("\n")

    def comment_after(self, node: ast.AST) -> str:
        """The comment at the end of the last line of ``node`` (``self.play(...)  # draw it``), or ""."""
        end, col = getattr(node, "end_lineno", None), getattr(node, "end_col_offset", None)
        if not end or col is None:
            return ""
        rest = self.lines[end - 1].encode("utf-8")[col:].decode("utf-8", "ignore").strip()  # (offsets count bytes)
        return rest if rest.startswith("#") else ""

    def verbatim(self, first: ast.stmt, last: ast.stmt) -> str | None:
        """The text of statements ``first``..``last`` as written (indentation relative to the first), or None when
        they share a line with other code (``a = 1; b = 2``)."""
        end = last.end_lineno or last.lineno
        lines = self.lines[first.lineno - 1:end]
        col = first.col_offset
        tail = lines[-1].encode("utf-8")
        cut = tail[:last.end_col_offset or len(tail)].decode("utf-8", "ignore")
        if lines[0][:col].strip() or (rest := tail[last.end_col_offset or len(tail):].decode("utf-8", "ignore").strip()) and not rest.startswith("#"):
            return None
        lines[-1] = cut
        out = [lines[0][col:]] + [ln[col:] if not ln[:col].strip() else ln.lstrip() for ln in lines[1:]]
        return "\n".join(out).rstrip()

    def blank_between(self, after: int, before: int) -> bool:
        """Whether a blank line separates line ``after`` from line ``before`` (1-based, both excluded)."""
        return any(not self.lines[k - 1].strip() for k in range(after + 1, before))

    def comments_above(self, line: int, floor: int) -> tuple[int, str]:
        """The full-line comments directly above ``line`` (below line ``floor``): (first line, text)."""
        i = line - 1
        found: list[str] = []
        while i > floor and self.lines[i - 1].strip().startswith("#"):
            found.insert(0, self.lines[i - 1].strip())
            i -= 1
        return i + 1, "\n".join(found)


def _first_line(node: ast.AST) -> int:
    decorators = getattr(node, "decorator_list", None) or []
    return min([node.lineno] + [d.lineno for d in decorators])


def _numeric(node: ast.AST) -> float | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return float(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        v = _numeric(node.operand)
        return None if v is None else -v
    return None


def _num(v: float) -> float | int:
    return int(v) if v == int(v) else v


def _self_call(stmt: ast.stmt, *names: str) -> ast.Call | None:
    """``self.<name>(...)`` as a statement."""
    if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
        f = stmt.value.func
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "self" and f.attr in names:
            return stmt.value
    return None


def _method_calls(node: ast.AST) -> tuple[ast.AST, list[ast.Call]] | None:
    """``root.a(...).b(...)`` -> (root, [call a, call b]); None if anything but method calls follows the root."""
    calls: list[ast.Call] = []
    cur = node
    while isinstance(cur, ast.Call) and isinstance(cur.func, ast.Attribute):
        calls.append(cur)
        cur = cur.func.value
    if not calls:
        return None
    return cur, calls[::-1]


# ----------------------------------------------------------------------------- the importer

@functools.lru_cache(maxsize=512)
def _chainable(cls: type) -> frozenset[str]:
    return frozenset(catalog.methods_of(cls))


class _Importer:
    def __init__(self, source: _Source, ns: dict[str, Any], base: dict | None):
        self.s = source
        self.ns = ns
        self.m = catalog.manim()
        self.objects: list[dict] = []
        self.steps: list[dict] = []
        self.known: dict[str, type | None] = {}  # object name -> its class (None: unknown)
        self.pending: list[ast.stmt] = []  # statements of the code step being collected
        self.pending_from = 0  # first line of that code step (its comments included)
        self.notes: list[str] = []
        self.base_doc = base
        self.scene_cls: type | None = None
        self.scene_methods: list[str] = []
        self.blocks = _base_blocks(base) if base else {}
        self.reused_steps: set[str] = set()
        self.gap = False  # a blank line before the statement being read
        self.pending_gap = False

    # ---- helpers
    def cls_of(self, name: str) -> type | None:
        v = self.ns.get(name)
        return v if isinstance(v, type) else None

    def mobject_class(self, ret: str) -> type | None:
        v = self.ns.get(ret.split("|")[0].strip().split(".")[-1])
        return v if isinstance(v, type) and issubclass(v, self.m.Mobject) else None

    def ctor_class(self, ctor: ast.AST) -> tuple[bool, type | None]:
        """Whether a call of ``ctor`` builds a mobject, and its class when known."""
        if isinstance(ctor, ast.Name):
            v = self.ns.get(ctor.id)
            if isinstance(v, type):
                return (issubclass(v, self.m.Mobject), v if issubclass(v, self.m.Mobject) else None)
            if callable(v):
                ret = catalog._returns(v)
                cls = self.mobject_class(ret) if ret else None
                return (cls is not None or ret in ("M", "Mobject", "VMobject"), cls)
            return (False, None)
        if isinstance(ctor, ast.Attribute) and isinstance(ctor.value, ast.Name) and ctor.value.id in self.known:
            owner = self.known[ctor.value.id]
            fn = getattr(owner, ctor.attr, None) if owner else None
            if not callable(fn):
                return (False, None)
            ret = catalog._returns(fn)
            if ret == "Self":
                return (True, owner)
            cls = self.mobject_class(ret) if ret else None
            return (cls is not None, cls)
        return (False, None)

    def callee(self, ctor: ast.AST) -> Any:
        """The class or function a constructor expression calls (``Circle``, ``axes.plot``)."""
        if isinstance(ctor, ast.Name):
            return self.ns.get(ctor.id)
        if isinstance(ctor, ast.Attribute) and isinstance(ctor.value, ast.Name):
            owner = self.known.get(ctor.value.id)
            return getattr(owner, ctor.attr, None) if owner else None
        return None

    def call_args(self, call: ast.Call) -> str:
        parts = [self.s.seg(a) for a in call.args]
        parts += [f"{k.arg}={self.s.seg(k.value)}" if k.arg else f"**{self.s.seg(k.value)}" for k in call.keywords]
        return ", ".join(parts)

    def keywords(self, call: ast.Call) -> dict[str, str] | None:
        if any(k.arg is None for k in call.keywords):
            return None  # **kwargs can't be a document argument
        return {k.arg: self.s.seg(k.value) for k in call.keywords}

    def assign(self, fn: Any, values: list[str], skip: str | None = None, ctor: str = "") -> dict[str, str]:
        """Document arguments for the positional ``values`` of a call of ``fn`` (a class, or a function or method).

        Like the editor stores them: for a class, the first positional argument under ``*`` (it fills the first
        parameter) and the others by parameter name; for a function, all by name. Classes and functions taking
        ``*args`` keep them all under ``*``. ``skip``: the animation's target parameter (already taken).
        """
        if not values:
            return {}
        everything = {"*": ", ".join(values)}
        if fn is None:
            return everything
        is_class = isinstance(fn, type)
        try:
            params = list(inspect.signature(fn.__init__ if is_class else fn).parameters.values())
        except (TypeError, ValueError):
            return everything
        if is_class or getattr(fn, "__qualname__", "").count("."):  # drop self
            params = params[1:]
        params = [p for p in params if p.name != skip]
        if any(p.kind is p.VAR_POSITIONAL for p in params):
            lead = codegen._leading(ctor) if is_class and ctor else ()
            if lead and len(values) > len(lead):
                return {**dict(zip(lead, values)), "*": ", ".join(values[len(lead):])}
            return everything
        positional = [p for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
        if len(values) > len(positional) or any(p.kind is p.POSITIONAL_ONLY for p in positional[1 if is_class else 0:len(values)]):
            return everything
        if is_class:
            return {"*": values[0], **{positional[i].name: v for i, v in enumerate(values[1:], 1)}}
        return {p.name: v for p, v in zip(positional, values)}

    # ---- animations
    def animation(self, node: ast.AST) -> dict | None:
        """An animation of ``self.play`` as a document animation, or None if it isn't one we can describe."""
        a = self.animate(node)
        if a is not None:
            return a
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
            return None
        cls_name = node.func.id
        klass = self.ns.get(cls_name)
        if isinstance(klass, type) and issubclass(klass, self.m.Mobject):
            return None
        kw = self.keywords(node)
        if kw is None:
            return None
        if isinstance(klass, type) and issubclass(klass, self.m.AnimationGroup) and _takes_varargs(klass) \
                and not any(isinstance(x, ast.Starred) for x in node.args):
            children = [self.animation(x) for x in node.args]
            if all(c is not None for c in children):
                return {"id": _id("a"), "cls": cls_name, "target": "", "args": kw, "anims": children}
        values = [self.s.seg(x) for x in node.args]
        anim = {"id": _id("a"), "cls": cls_name, "target": "", "args": kw}
        if isinstance(klass, type) and issubclass(klass, self.m.Animation):
            kind = catalog.target_kind(klass)
            if kind == "mobjects":  # FadeIn(*mobjects): all of them are the target
                anim["target"] = ", ".join(values)
                return anim
            if kind == "animations":  # a composition of animations built by an expression
                if values:
                    anim["args"] = {"*": ", ".join(values), **kw}
                return anim
            if kind == "none":  # Wait(1): animates no mobject
                given = self.assign(klass, values, ctor=cls_name)
                anim["args"] = {**given, **kw}
                _keep_positional(anim, given, values)
                return anim
            target = catalog.target_param(klass)
            names = _positional_names(klass)
            if target in names and names.index(target) > 0:  # ApplyMatrix(matrix, mobject)
                i = names.index(target)
                if len(values) > i:
                    anim["target"] = values.pop(i)
                anim["args"] = {**self.assign(klass, values, skip=target, ctor=cls_name), **kw}
                return anim
        if values:
            anim["target"] = values.pop(0)
        is_anim = isinstance(klass, type) and issubclass(klass, self.m.Animation)
        given = self.assign(klass if is_anim else None, values, skip=catalog.target_param(klass) if is_anim else None, ctor=cls_name)
        anim["args"] = {**given, **kw}
        _keep_positional(anim, given, values)
        return anim

    def animate(self, node: ast.AST) -> dict | None:
        """``target.animate(**args).method(...)...``"""
        calls: list[ast.Call] = []
        cur = node
        animate_call: ast.Call | None = None
        while True:
            if isinstance(cur, ast.Call) and isinstance(cur.func, ast.Attribute):
                if cur.func.attr == "animate":
                    animate_call, target = cur, cur.func.value
                    break
                calls.append(cur)
                cur = cur.func.value
                continue
            if isinstance(cur, ast.Attribute) and cur.attr == "animate":
                target = cur.value
                break
            return None
        if not calls:
            return None
        args: dict[str, str] = {}
        if animate_call is not None:
            if animate_call.args:
                return None
            kw = self.keywords(animate_call)
            if kw is None:
                return None
            args = kw
        chain = "".join(f".{c.func.attr}({self.call_args(c)})" for c in reversed(calls))  # type: ignore[union-attr]
        return {"id": _id("a"), "cls": "animate", "target": self.s.seg(target), "args": args, "chain": chain}

    # ---- statements
    def play(self, call: ast.Call) -> dict | None:
        anims = [self.animation(a) for a in call.args]
        kw = self.keywords(call)
        if not anims or any(a is None for a in anims) or kw is None:
            return None
        return {"id": _id("s"), "kind": "play", "anims": anims, "args": kw}

    def wait(self, call: ast.Call) -> dict | None:
        kw = self.keywords(call)
        if kw is None or len(call.args) > 1:
            return None
        if call.args:
            if "duration" in kw:
                return None
            kw = {"duration": self.s.seg(call.args[0]), **kw}
        return {"id": _id("s"), "kind": "wait", "args": kw}

    def add_remove(self, call: ast.Call, kind: str) -> dict | None:
        if call.keywords or not call.args or not all(isinstance(a, ast.Name) for a in call.args):
            return None
        return {"id": _id("s"), "kind": kind, "targets": [a.id for a in call.args]}  # type: ignore[attr-defined]

    def scene_call(self, call: ast.Call) -> dict | None:
        """``self.next_section(...)``, ``self.add_sound(...)``, ``self.move_camera(...)``: a method of the scene's class."""
        method = call.func.attr  # type: ignore[union-attr]
        fn = getattr(self.scene_cls, method, None) if self.scene_cls else None
        kw = self.keywords(call)
        if fn is None or kw is None or method not in self.scene_methods or any(isinstance(a, ast.Starred) for a in call.args) and len(call.args) > 1:
            return None
        values = [self.s.seg(a) for a in call.args]
        given = self.assign(fn, values, ctor="")
        step = {"id": _id("s"), "kind": "call", "method": method, "args": {**given, **kw}}
        _keep_positional(step, given, values)
        return step

    def apply(self, stmt: ast.stmt) -> dict | None:
        """``obj.next_to(u, UP)``, ``group[0].set_color(RED)``, ``self.camera.frame.save_state()``: methods called
        on one of the scene's objects (or a part of one, or the camera's frame), later in the scene."""
        if not isinstance(stmt, ast.Expr):
            return None
        mc = _method_calls(stmt.value)
        if mc is None:
            return None
        root, calls = mc
        base = root
        while isinstance(base, (ast.Attribute, ast.Subscript)):
            base = base.value
        camera = ast.unparse(root) == "self.camera.frame"
        if not camera and not (isinstance(base, ast.Name) and base.id in self.known):
            return None
        if any(c.func.attr == "animate" for c in calls):  # type: ignore[union-attr]
            return None
        chain = "".join(f".{c.func.attr}({self.call_args(c)})" for c in calls)  # type: ignore[union-attr]
        return {"id": _id("s"), "kind": "apply", "target": self.s.seg(root), "chain": chain}

    def statement_step(self, stmt: ast.stmt) -> dict | None:
        if (step := self.apply(stmt)) is not None:
            return step
        if (call := _self_call(stmt, "play")) is not None:
            return self.play(call)
        if (call := _self_call(stmt, "wait")) is not None:
            return self.wait(call)
        if (call := _self_call(stmt, "add", "remove")) is not None:
            return self.add_remove(call, call.func.attr)  # type: ignore[union-attr]
        if (call := _self_call(stmt, *self.scene_methods)) is not None:
            return self.scene_call(call)
        return None

    def object_def(self, stmt: ast.stmt) -> tuple[dict, type | None] | None:
        """``name = Ctor(...)`` (optionally followed by method calls on it) of a name not used before."""
        if not (isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name)):
            return None
        name = stmt.targets[0].id
        if name in self.known or name in construct.RESERVED_NAMES or not isinstance(stmt.value, ast.Call):
            return None
        calls: list[ast.Call] = []
        cur: ast.AST = stmt.value
        while isinstance(cur, ast.Call) and isinstance(cur.func, ast.Attribute) and isinstance(cur.func.value, ast.Call):
            calls.append(cur)
            cur = cur.func.value
        if not isinstance(cur, ast.Call):
            return None
        is_mob, cls = self.ctor_class(cur.func)
        if not is_mob:
            return None
        if calls and (cls is None or any(c.func.attr not in _chainable(cls) for c in calls)):  # type: ignore[union-attr]
            return None  # a method that doesn't return the object: the variable isn't the mobject
        kw = self.keywords(cur)
        if kw is None:
            return None
        ctor = self.s.seg(cur.func)
        values = [self.s.seg(a) for a in cur.args]
        given = self.assign(self.callee(cur.func), values, ctor=ctor)
        chain = "".join(f".{c.func.attr}({self.call_args(c)})" for c in reversed(calls))  # type: ignore[union-attr]
        obj = {"id": _id("o"), "name": name, "ctor": ctor, "args": {**given, **kw}, "pos": None, "chain": chain}
        _keep_positional(obj, given, values)
        return obj, cls

    def setup_calls(self, name: str, cls: type | None, stmt: ast.stmt) -> list[ast.Call] | None:
        """``name.a(...).b(...)`` as a statement, where every method returns the object (part of its setup)."""
        if cls is None or not isinstance(stmt, ast.Expr):
            return None
        mc = _method_calls(stmt.value)
        if mc is None or not (isinstance(mc[0], ast.Name) and mc[0].id == name):
            return None
        if any(c.func.attr not in _chainable(cls) for c in mc[1]):  # type: ignore[union-attr]
            return None
        return mc[1]

    def transform_fields(self, obj: dict, calls: list[list[ast.Call]]) -> list[list[ast.Call]]:
        """Read codegen's own transform lines (stretch, scale, rotate, move_to) at the end into the object's fields."""
        order = ["move_to", "rotate", "scale", "stretch1", "stretch0"]
        while calls and len(calls[-1]) == 1 and order:
            c = calls[-1][0]
            meth = c.func.attr  # type: ignore[union-attr]
            if c.keywords:
                break
            if meth == "move_to" and "move_to" in order and len(c.args) == 1:
                m = re.fullmatch(rf"np\.array\(\[({_NUMBER}), ({_NUMBER}), 0\]\)", ast.unparse(c.args[0]))
                if not m:
                    break
                obj["pos"] = [_num(float(m.group(1))), _num(float(m.group(2)))]
                order = order[order.index("move_to") + 1:]
            elif meth == "rotate" and "rotate" in order and len(c.args) == 1:
                m = re.fullmatch(rf"({_NUMBER}) \* DEGREES", ast.unparse(c.args[0]))
                if not m:
                    break
                obj["rotation"] = _num(float(m.group(1)))
                order = order[order.index("rotate") + 1:]
            elif meth == "scale" and "scale" in order and len(c.args) == 1 and _numeric(c.args[0]) is not None:
                obj["scale"] = _num(_numeric(c.args[0]))  # type: ignore[arg-type]
                order = order[order.index("scale") + 1:]
            elif meth == "stretch" and len(c.args) == 2 and _numeric(c.args[0]) is not None and _numeric(c.args[1]) in (0, 1):
                dim = int(_numeric(c.args[1]))  # type: ignore[arg-type]
                if f"stretch{dim}" not in order:
                    break
                st = obj.setdefault("stretch", [1, 1])
                st[dim] = _num(_numeric(c.args[0]))  # type: ignore[arg-type]
                order = order[order.index(f"stretch{dim}") + 1:]
            else:
                break
            calls = calls[:-1]
        return calls

    # ---- assembling
    def last_step(self) -> str | None:
        return self.steps[-1]["id"] if self.steps else None

    def add_object(self, obj: dict, comment: str) -> None:
        after = self.last_step()
        if after:
            obj["after"] = after
        else:
            obj.pop("after", None)
        _set_comment(obj, comment)
        _set_gap(obj, self.gap)
        self.objects.append(obj)

    def add_step(self, step: dict, comment: str) -> None:
        _set_comment(step, comment)
        _set_gap(step, self.gap)
        self.steps.append(step)

    def flush(self) -> None:
        if not self.pending:
            return
        code = self.s.block(self.pending_from, self.pending[-1].end_lineno or self.pending[-1].lineno)
        step = {"id": _id("s"), "kind": "code", "code": code}
        _set_gap(step, self.pending_gap)
        self.steps.append(step)
        self.pending = []

    def keep_as_code(self, stmt: ast.stmt, first_line: int) -> None:
        if not self.pending:
            self.pending_from = first_line
            self.pending_gap = self.gap
        self.pending.append(stmt)

    def run(self, body: list[ast.stmt], floor: int) -> None:
        texts = [ast.unparse(s) for s in body]
        i = 0
        prev_end = floor
        while i < len(body):
            stmt = body[i]
            first, comment = self.s.comments_above(stmt.lineno, prev_end)
            # a blank line before it (and its comments), as the code separates its paragraphs
            self.gap = i > 0 and self.s.blank_between(prev_end, first)
            # Unchanged statements keep the document element they were generated from.
            hit = self.match_base(texts, i)
            if hit is not None:
                kind, elem, n = hit
                comment = _join_comments(comment, self.s.comment_after(body[i + n - 1]))
                self.flush()
                if kind == "object":
                    self.add_object(elem, comment)
                    self.known[elem["name"]] = self.cls_of(elem["ctor"]) or self.ctor_class(_expr(elem["ctor"]))[1]
                elif kind == "step":
                    self.add_step(elem, comment)
                    self.reused_steps.add(elem["id"])
                prev_end = body[i + n - 1].end_lineno or body[i + n - 1].lineno
                i += n
                continue
            made = self.object_def(stmt)
            if made is not None:
                obj, cls = made
                j = i + 1
                runs: list[list[ast.Call]] = []
                while j < len(body) and (calls := self.setup_calls(obj["name"], cls, body[j])) is not None \
                        and not self.s.comments_above(body[j].lineno, body[j - 1].end_lineno or 0)[1]:
                    runs.append(calls)
                    j += 1
                rest = self.transform_fields(obj, runs)
                pieces = ["".join(f".{c.func.attr}({self.call_args(c)})" for c in calls) for calls in rest]  # type: ignore[union-attr]
                # how the code spreads them over lines, when it isn't codegen's one line after the constructor
                if obj["chain"] or len(pieces) > 1:
                    obj["chain_layout"] = [obj["chain"], *pieces]
                obj["chain"] += "".join(pieces)
                self.flush()
                obj["_src"] = self.s.verbatim(stmt, body[j - 1])
                self.add_object(obj, _join_comments(comment, self.s.comment_after(body[j - 1])))
                self.known[obj["name"]] = cls
                prev_end = body[j - 1].end_lineno or body[j - 1].lineno
                i = j
                continue
            step = self.statement_step(stmt)
            if step is not None:
                step["_src"] = self.s.verbatim(stmt, stmt)
                self.flush()
                self.add_step(step, _join_comments(comment, self.s.comment_after(stmt)))
            else:
                if _self_call(stmt, "play") is not None:
                    self.notes.append(f"Line {stmt.lineno}: this self.play is kept as code (its animations are built by "
                                      "an expression, such as a list or a variable).")
                self.keep_as_code(stmt, first)
            prev_end = stmt.end_lineno or stmt.lineno
            i += 1
        self.flush()

    def match_base(self, texts: list[str], i: int) -> tuple[str, dict, int] | None:
        for kind, elem, block in sorted(self.blocks.get(texts[i], []), key=lambda b: -len(b[2])):
            n = len(block)
            if texts[i:i + n] == block:
                self.blocks[texts[i]].remove((kind, elem, block))
                return kind, copy.deepcopy(elem), n
        return None


def _expr(src: str) -> ast.AST:
    try:
        return ast.parse(src, mode="eval").body
    except SyntaxError:
        return ast.Constant(None)


def _join_comments(above: str, trailing: str) -> str:
    return "\n".join(c for c in (above, trailing) if c)


def _keep_written(doc: dict, plan: construct.Plan) -> None:
    """Where codegen would write an element differently from the code (its own line breaks, spacing, quotes), keep
    the code's text: codegen writes it as it was for as long as the element is unchanged."""
    skip = plan.invalid_anims
    for elem in [*doc["objects"], *doc["timeline"]]:
        if "_src" not in elem:
            continue
        src = elem.pop("_src")
        if "kind" in elem:
            lines = [text for text, _ in codegen.statement(elem, doc, plan, False, skip)]
        else:
            lines = codegen.object_lines(elem, plan)
        gen = "\n".join(lines)
        if src is not None and src != gen and lines:
            elem["written"] = {"gen": gen, "as": src}
        else:
            elem.pop("written", None)


def _keep_top(code: str, scene: ast.ClassDef, doc: dict, plan: construct.Plan) -> None:
    """The top of the file (above the scene class) as the code has it, while codegen would write it differently:
    codegen writes it as it was for as long as what it is made from (imports, config, header) is unchanged."""
    lines = code.split("\n")
    at = next((i for i, ln in enumerate(lines) if re.match(rf"class\s+{re.escape(scene.name)}\b", ln)), None)
    if at is None:
        return
    while at > 0 and lines[at - 1].startswith("@"):  # its decorators are written with the class
        at -= 1
    top = "\n".join(lines[:at])
    numbers = "\n" + tex.NUMBERS_SOURCE.strip("\n") + "\n\n"  # what codegen adds below it when LaTeX is missing
    if top.endswith(numbers):
        top = top[: -len(numbers)]
    gen = "\n".join(t for t, _ in codegen.top_lines(doc, plan, False, True))
    if top not in (gen, "\n".join(t for t, _ in codegen.top_lines(doc, plan, False, False))):
        doc["top_written"] = {"gen": gen, "as": top}


def _set_gap(elem: dict, gap: bool) -> None:
    if gap:
        elem["gap"] = True
    else:
        elem.pop("gap", None)


def _set_comment(elem: dict, comment: str) -> None:
    if comment:
        elem["comment"] = comment
    else:
        elem.pop("comment", None)


def _keep_positional(elem: dict, given: dict, values: list[str]) -> None:
    """Remember which document arguments the code passed by position (``assign`` made ``given`` of the positional
    ``values``, in order), when codegen wouldn't write them so on its own: it writes ``*`` by position and the
    others as keywords, so ``Line(a, b)`` would come back as ``Line(a, end=b)``."""
    names = list(given) if values else []
    if any(n != "*" for n in names):
        elem["positional"] = names


def _takes_varargs(klass: type) -> bool:
    try:
        return any(p.kind is p.VAR_POSITIONAL for p in inspect.signature(klass.__init__).parameters.values())
    except (TypeError, ValueError):
        return False


def _positional_names(klass: type) -> list[str]:
    try:
        params = list(inspect.signature(klass.__init__).parameters.values())[1:]
    except (TypeError, ValueError):
        return []
    return [p.name for p in params if p.kind is p.POSITIONAL_OR_KEYWORD]


def _base_blocks(base: dict) -> dict[str, list[tuple[str, dict, list[str]]]]:
    """The statements codegen writes for each object and step of ``base``, keyed by the first statement."""
    gen = codegen.generate(base, latex=True)
    try:
        tree = ast.parse(gen.source)
    except SyntaxError:
        return {}
    scene = (base.get("scene") or {}).get("name") or "MainScene"
    cls = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == scene), None)
    fn = next((n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "construct"), None) if cls else None
    if fn is None:
        return {}
    step_of: dict[str, str] = {}
    steps = {s["id"]: s for s in base.get("timeline") or []}
    for s in steps.values():
        for a in _walk(s.get("anims") or []):
            step_of[a["id"]] = s["id"]
    objects = {o["id"]: o for o in base.get("objects") or []}
    groups: list[tuple[tuple[str, str] | None, list[str]]] = []
    for stmt in fn.body:
        ref = gen.linemap.get(stmt.lineno)
        if ref and ref[0] == "anim":
            ref = ("step", step_of.get(ref[1], ""))
        if groups and groups[-1][0] == ref and ref is not None:
            groups[-1][1].append(ast.unparse(stmt))
        else:
            groups.append((ref, [ast.unparse(stmt)]))
    out: dict[str, list[tuple[str, dict, list[str]]]] = {}
    for ref, texts in groups:
        if ref is None:
            continue
        elem = objects.get(ref[1]) if ref[0] == "object" else steps.get(ref[1]) if ref[0] == "step" else None
        if elem is None:
            continue
        out.setdefault(texts[0], []).append(("object" if ref[0] == "object" else "step", elem, texts))
    return out


def _walk(anims: list[dict]):
    for a in anims:
        yield a
        yield from _walk(a.get("anims") or [])


def _restore_disabled(base: dict, steps: list[dict], reused: set[str]) -> list[dict]:
    """Disabled steps aren't in the code: put each back after the step it followed, if that step is unchanged."""
    out = list(steps)
    prev: str | None = None
    for s in base.get("timeline") or []:
        if not s.get("disabled"):
            prev = s["id"]
            continue
        if prev is None:
            if reused:
                out.insert(0, copy.deepcopy(s))
            continue
        if prev in reused:
            i = next((k for k, x in enumerate(out) if x["id"] == prev), None)
            if i is not None:
                out.insert(i + 1, copy.deepcopy(s))
                prev = s["id"]
                reused = reused | {s["id"]}
    return out


def _header(src: _Source, tree: ast.Module, scene: ast.ClassDef, config: dict) -> tuple[str, str]:
    """Module-level code other than the scene and what codegen writes itself, before and after the scene class
    (code after it can use it, so it stays after it); reads ``config.x = …`` into ``config``."""
    drop: set[int] = set()

    def skip(node: ast.AST) -> None:
        drop.update(range(_first_line(node), (node.end_lineno or node.lineno) + 1))

    for node in tree.body:
        if node is scene:
            skip(node)
            continue
        text = ast.unparse(node)
        if text in _AUTO_IMPORTS:
            skip(node)
        elif isinstance(node, ast.ImportFrom) and node.module == "manim.utils.rate_functions" and all(a.name.startswith("ease_") for a in node.names):
            skip(node)
        elif (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Attribute)
              and isinstance(node.targets[0].value, ast.Name) and node.targets[0].value.id == "config"):
            key = node.targets[0].attr
            if key == "background_color" and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                config["background_color"] = node.value.value
                skip(node)
            elif key in _CONFIG_NUMBERS and (v := _numeric(node.value)) is not None and v > 0:
                config[key] = int(v)
                skip(node)
    split = _first_line(scene)

    def text(lines: list[str]) -> str:
        out = re.sub(r"\n{3,}", "\n\n\n", "\n".join(lines)).strip("\n")
        return out + "\n" if out else ""

    keep = [(i, ln) for i, ln in enumerate(src.lines, 1) if i not in drop]
    return text([ln for i, ln in keep if i < split]), text([ln for i, ln in keep if i > split])


def _members(src: _Source, scene: ast.ClassDef, construct_fn: ast.FunctionDef) -> tuple[str, str]:
    """Source of the scene class's other members (helpers, setup, class attributes): before and after construct."""
    before: list[str] = []
    after: list[str] = []
    prev_end = scene.lineno
    for node in scene.body:
        start = _first_line(node)
        first, _ = src.comments_above(start, prev_end)
        prev_end = node.end_lineno or node.lineno
        if node is construct_fn:
            continue
        text = src.block(first, prev_end)
        (before if node.lineno < construct_fn.lineno else after).append(text)
    return "\n\n".join(before), "\n\n".join(after)


def import_code(code: str, scene: str | None = None, base: dict | None = None) -> Imported:
    """Read manim code into a document. ``scene``: which Scene class (default: the first with a construct)."""
    raw = code
    found = [h for h in _HELPERS if h.strip("\n") in code]
    for helper in found:
        code = code.replace(helper.strip("\n"), "")
    tree = _parse(code)
    classes = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
    known_scenes = _manim_scenes()
    scenes = [n for n in classes.values() if _is_scene_class(n, known_scenes, classes) and _has_construct(n)]
    if not scenes:
        raise CodeError("There is no Scene in this code: manim renders classes like `class MyScene(Scene):` with a "
                        "`def construct(self):` method.")
    node = next((n for n in scenes if n.name == scene), None) if scene else scenes[0]
    if node is None:
        raise CodeError(f"There is no Scene called {scene} in this code.")
    construct_fn = next(n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == "construct")
    src = _Source(code)

    doc = project.new_project()
    if base:
        doc.update({k: copy.deepcopy(v) for k, v in base.items() if k in ("config", "markers", "constructions")})
    doc["scene"] = {"name": node.name, "base": ", ".join(ast.unparse(b) for b in node.bases) or "Scene"}
    if node.decorator_list:  # they can change the class (its attributes, its methods), so they stay
        doc["scene"]["decorators"] = "\n".join("@" + src.seg(d) for d in node.decorator_list)
    before, after = _members(src, node, construct_fn)
    if before:
        doc["scene"]["members"] = before
    if after:
        doc["scene"]["members_after"] = after
    doc["header"], footer = _header(src, tree, node, doc["config"])
    if footer:
        doc["footer"] = footer

    ns = dict(vars(catalog.manim()))
    from manim.utils import rate_functions

    ns.update({k: v for k, v in vars(rate_functions).items() if not k.startswith("_")})
    ns.update(catalog.header_namespace(doc["header"]))
    imp = _Importer(src, ns, base)
    bases = [ns.get(ast.unparse(b).split(".")[-1]) for b in node.bases]
    imp.scene_cls = next((b for b in bases if isinstance(b, type) and issubclass(b, catalog.manim().Scene)), None)
    if imp.scene_cls is not None:
        own = {n.name for n in node.body if isinstance(n, ast.FunctionDef)}  # the class's own methods aren't the base's
        imp.scene_methods = [m for m in catalog.scene_methods(imp.scene_cls) if m not in own and m not in ("play", "wait", "add", "remove")]
    body = list(construct_fn.body)
    if base:  # the helper object codegen makes for constructions
        plan = construct.plan(base)
        var = plan.constraints_var if plan.uses_constraints else None
        body = [s for s in body if not (var and ast.unparse(s) == f"{var} = Constraints(self)")]
    if len(body) == 1 and isinstance(body[0], ast.Pass):
        body = []
    imp.run(body, construct_fn.lineno)
    doc["objects"] = imp.objects
    doc["timeline"] = _restore_disabled(base, imp.steps, imp.reused_steps) if base else imp.steps
    plan = construct.plan(doc)
    _keep_written(doc, plan)
    # Helpers codegen writes only for constructions: when the document no longer has those, the code still needs them.
    emitted = {construct.CONSTRAINTS_SOURCE: plan.uses_constraints, construct.GEOMETRY_SOURCE: plan.uses_geometry,
               construct.TERMS_SOURCE: plan.uses_terms,
               tex.NUMBERS_SOURCE: not tex.latex_available()}  # written again by codegen when LaTeX is missing
    missing = [h for h in found if not emitted.get(h)]
    if missing:
        extra = ([construct.TERMS_IMPORT] if construct.TERMS_SOURCE in missing else []) + [h.strip("\n") for h in missing]
        doc["header"] = "\n\n".join(x for x in [doc["header"].rstrip("\n"), *extra] if x) + "\n"
    _keep_top(raw, node, doc, plan)
    return Imported(doc, [n.name for n in scenes], imp.notes)
