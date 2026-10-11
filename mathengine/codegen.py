"""Compile a Manim Studio scene document into a plain ManimCE Python file.

Every value in the document is stored as Python source (e.g. ``"BLUE"``,
``"UP * 2"``, ``"lambda x: x**2"``), so anything manim accepts can be used
from the GUI.

The timeline is the list of ``construct()`` statements (timeline.py). Each step
compiles to exactly one statement, in order, with nothing added:

* ``play``   -> ``self.play(Create(circle), axes.animate.shift(UP), run_time=2)``
* ``wait``   -> ``self.wait(1.5)``
* ``add``    -> ``self.add(circle, square)`` (``remove`` likewise)
* ``code``   -> the code, as written
* ``couple`` / ``uncouple`` -> switch a construction (construct.py)

so reading the exported file is reading the timeline, and the editor's timing is
manim's: a statement starts when the previous one ends.

``generate(doc, preview=True)`` also emits hooks the preview runtime uses to
map variables to mobjects and to measure when each statement and animation runs.
"""

from __future__ import annotations

import json
import keyword
import re
import textwrap
from dataclasses import dataclass, field

from . import construct, tex, timeline

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
EPS = 1e-6


@dataclass
class Generated:
    source: str
    # 1-based line number -> (kind, id) of the document element that produced it: ("object", id),
    # ("step", id), ("anim", id) or ("header", "header")
    linemap: dict[int, tuple[str, str]] = field(default_factory=dict)
    # problems with constructions and the timeline (missing sources, cycles…); the scene still compiles
    diagnostics: list[dict] = field(default_factory=list)
    # equation object id -> term id -> submobject index
    part_index: dict[str, dict[str, int]] = field(default_factory=dict)


def is_valid_name(name: str) -> bool:
    return bool(IDENT.match(name)) and not keyword.iskeyword(name)


def _num(v: float) -> str:
    v = round(float(v), 4)
    return repr(int(v)) if v == int(v) else repr(v)


def _call_args(args: dict | None, leading: list[str] | None = None, extra: dict | None = None,
               before_star: tuple[str, ...] = ()) -> str:
    parts = [p for p in (leading or []) if p and p.strip()]
    merged = dict(args or {})
    merged.update(extra or {})
    star = str(merged.pop("*", "")).strip()
    if star and before_star:
        # f(a, *rest): parameters declared before *args can't follow it as keywords.
        for name in before_star:
            val = str(merged.pop(name, "") or "None").strip()
            parts.append(val)
    if star:
        parts.append(star)
    for key, val in merged.items():
        val = str(val).strip()
        if val:
            parts.append(f"{key}={val}")
    return ", ".join(parts)


def _join_chain(chain: str) -> str:
    chain = " ".join(line.strip() for line in (chain or "").splitlines() if line.strip())
    if chain and not chain.startswith("."):
        chain = "." + chain
    return chain


def is_composition(anim: dict) -> bool:
    """An animation made of other animations (AnimationGroup, LaggedStart, Succession…): its children are ``anims``."""
    return anim.get("anims") is not None


def anim_expr(anim: dict, doc: dict | None = None, plan: construct.Plan | None = None, tag: bool = False,
              skip: set[str] = frozenset()) -> str:
    """Python expression for one animation, as written in ``self.play(...)``.

    ``tag``: wrap it for the preview runtime, which then measures when manim runs it (``self._me_tag``).
    """
    cls = (anim.get("cls") or "").strip()
    target = (anim.get("target") or "").strip()
    args = anim.get("args") or {}
    if cls == "TransformTerms" and doc is not None and plan is not None:
        expr = construct.terms_expr(anim, doc, plan)
    elif cls == "animate":
        kw = _call_args(args)
        expr = (f"{target}.animate({kw})" if kw else f"{target}.animate") + _join_chain(anim.get("chain", ""))
    elif is_composition(anim):
        children = [anim_expr(c, doc, plan, tag, skip) for c in anim.get("anims") or []
                    if not c.get("disabled") and c["id"] not in skip]
        expr = f"{cls}({_call_args(args, children)})"
    elif (kw_target := _target_keyword(cls)) and target:  # ApplyMatrix(matrix, mobject): the target isn't the first argument
        expr = f"{cls}({_target_after(cls, kw_target, target, args)})"
    else:
        expr = f"{cls}({_call_args(args, [target], None, _leading(cls, skip=1))})"
    return f"self._me_tag({expr}, {anim['id']!r})" if tag else expr


def _method_leading(doc: dict | None, method: str) -> tuple[str, ...]:
    """Parameters of a scene method declared before ``*args``; they must stay positional."""
    try:
        import inspect

        from .catalog import manim

        base = ((doc or {}).get("scene") or {}).get("base") or "Scene"
        cls = next((c for c in (getattr(manim(), b.strip(), None) for b in base.split(",")) if isinstance(c, type)), manim().Scene)
        params = list(inspect.signature(getattr(cls, method)).parameters.values())[1:]
    except Exception:
        return ()
    out = []
    for p in params:
        if p.kind is p.VAR_POSITIONAL:
            return tuple(out)
        if p.kind is not p.POSITIONAL_OR_KEYWORD:
            break
        out.append(p.name)
    return ()


def _target_after(cls: str, kw_target: str, target: str, args: dict) -> str:
    """Arguments of an animation whose target comes after other parameters, all passed positionally up to the
    target: ``LaggedStartMap(FadeOut, dots)`` (manim's Animation.__new__ takes its first argument as the mobject,
    so ``LaggedStartMap(FadeOut, mobject=dots)`` fails)."""
    try:
        from .catalog import manim
        import inspect

        names = [p.name for p in list(inspect.signature(getattr(manim(), cls).__init__).parameters.values())[1:]
                 if p.kind is p.POSITIONAL_OR_KEYWORD]
    except Exception:
        names = []
    if kw_target not in names:
        return _call_args({**args, kw_target: target})
    rest = dict(args)
    lead = []
    for i, name in enumerate(names[:names.index(kw_target)]):
        val = str(rest.pop(name, "") or (rest.pop("*", "") if i == 0 else "")).strip()
        if not val:
            return _call_args({**args, kw_target: target})
        lead.append(val)
    return _call_args(rest, lead + [target])


def _leading(ctor: str, skip: int = 0) -> tuple[str, ...]:
    if not re.fullmatch(r"[A-Za-z_]\w*", ctor or ""):
        return ()
    try:
        from .catalog import leading_positionals
    except Exception:
        return ()
    return leading_positionals(ctor, skip)


def _target_keyword(cls: str) -> str | None:
    if not re.fullmatch(r"[A-Za-z_]\w*", cls or ""):
        return None
    try:
        from .catalog import target_keyword
    except Exception:
        return None
    return target_keyword(cls)


def _flag(cls: str, name: str) -> bool:
    if not re.fullmatch(r"[A-Za-z_]\w*", cls or ""):
        return False
    try:
        from . import catalog
    except Exception:
        return False
    return getattr(catalog, name)(cls)


class _Writer:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.linemap: dict[int, tuple[str, str]] = {}

    def emit(self, text: str, ref: tuple[str, str] | None = None, indent: int = 0) -> None:
        for raw in text.splitlines() or [""]:
            self.lines.append(" " * indent + raw if raw.strip() else "")
            if ref:
                self.linemap[len(self.lines)] = ref


def _playable(step: dict, skip: set[str]) -> list[dict]:
    return [a for a in step.get("anims") or [] if not a.get("disabled") and a["id"] not in skip]


def _check_timeline(steps: list[dict], plan: construct.Plan, skip: set[str]) -> None:
    """What manim will do that the author may not expect, statement by statement.

    * An animation of an object that isn't on screen yet: ``self.play`` adds it at the start of the play,
      without an intro, unless the animation is an intro itself (Create, FadeIn, Write…).
    * Two animations of the same object in one ``self.play``: manim runs both on it at once, and where they
      change the same properties the later one in the list wins.
    * An empty composition: manim can't play it.
    """
    shown: set[str] = set()
    for step in steps:
        kind = step.get("kind")
        if kind == "add":
            shown.update(step.get("targets") or [])
        elif kind == "remove":
            shown.difference_update(step.get("targets") or [])
        elif kind == "call":  # bring_to_front, add_foreground_mobjects…: trust it with the objects it names
            shown.update(w for v in (step.get("args") or {}).values() for w in _WORD.findall(_STRING.sub("", str(v))))
        elif kind == "code":
            # Code can show anything (loops, self.add of groups…): trust it with every object it mentions.
            shown.update(_WORD.findall(_STRING.sub("", step.get("code") or "")))
        if kind != "play":
            continue
        anims = _playable(step, skip)
        for a in timeline.walk(anims):  # animations built by an expression (LaggedStart(*[FadeIn(d) for d in dots]))
            if (a.get("args") or {}).get("*"):
                shown.update(_WORD.findall(_STRING.sub("", a["args"]["*"])))
        seen: dict[str, str] = {}
        for a in anims:
            label = ".animate" if a.get("cls") == "animate" else a.get("cls")
            for t in dict.fromkeys(timeline.targets_of(a)):
                if t in seen and not is_composition(a):
                    plan.diag(a["id"], "warning", f"{t} is also animated by {seen[t]} in this self.play. manim runs both on "
                              f"{t} at once, and where they change the same properties the later one in the list wins. "
                              "Play them one after the other (separate self.play calls, or a Succession), or make one "
                              ".animate with both changes.", "anim")
                seen.setdefault(t, label or "another animation")
        for a in timeline.walk(anims):
            if a["id"] in skip:
                continue
            cls = (a.get("cls") or "").strip()
            if is_composition(a) and not [c for c in a.get("anims") or [] if not c.get("disabled") and c["id"] not in skip]:
                plan.diag(a["id"], "error", f"{cls} has no animations to play. Add one, or delete it.", "anim")
            if is_composition(a) or cls in ("Wait", "TransformTerms"):
                continue
            names = [t.strip() for t in (a.get("target") or "").split(",") if t.strip()]
            if cls == "Add" or _flag(cls, "is_introducer"):
                continue
            # LaggedStartMap(FadeIn, dots): the animation it applies to each part is an intro
            if any(_flag(w, "is_introducer") for w in _WORD.findall(_STRING.sub("", str((a.get("args") or {}).get("*", ""))))):
                continue
            for t in names:
                if t not in shown and t in plan.mobject_names:
                    plan.diag(a["id"], "warning", f"{t} isn't on screen before this self.play, so manim adds it as the play "
                              f"starts, with no intro. Add an intro before it (Create, FadeIn, Write… or self.add).", "anim")
        for a in timeline.walk(anims):
            cls = (a.get("cls") or "").strip()
            names = [t.strip() for t in (a.get("target") or "").split(",") if t.strip()]
            if _flag(cls, "is_remover"):
                shown.difference_update(names)
            else:
                shown.update(names)


def _without_latex(doc: dict) -> tuple[dict, list[tuple[str, str, str]]]:
    """The document as this computer can draw it without LaTeX: simple MathTex/Tex labels become Text.

    Returns the (copied) document and diagnostics: a note on each converted label, an error on each object
    that still needs LaTeX (equations).
    """
    notes: list[tuple[str, str, str]] = []
    objects = []
    for obj in doc.get("objects", []):
        ctor = (obj.get("ctor") or "").strip()
        if ctor in tex.TEX_CTORS:
            fallback = None if (obj.get("eq") or {}).get("parts") else tex.text_fallback(ctor, obj.get("args") or {})
            if fallback:
                obj = {**obj, "ctor": fallback[0], "args": fallback[1]}
                notes.append((obj["id"], "warning", "Drawn with Text because LaTeX isn't installed on this computer. "
                              "Install LaTeX to draw it with TeX again."))
            else:
                notes.append((obj["id"], "error", tex.missing_message(obj.get("name", "This object"))))
        objects.append(obj)
    return {**doc, "objects": objects}, notes


def generate(doc: dict, preview: bool = False, latex: bool | None = None) -> Generated:
    """Python source for the document. ``latex``: whether LaTeX can be used (default: is it installed here)."""
    if latex is None:
        latex = tex.latex_available()
    notes: list[tuple[str, str, str]] = []
    if not latex:
        doc, notes = _without_latex(doc)
    w = _Writer()
    emit = w.emit
    scene = doc.get("scene", {})
    scene_name = scene.get("name") or "MainScene"
    base = scene.get("base") or "Scene"
    cfg = doc.get("config", {})
    plan = construct.plan(doc)
    for oid, level, message in notes:
        plan.diag(oid, level, message)
    skip = plan.invalid_anims
    steps = timeline.steps(doc)
    _check_timeline(steps, plan, skip)

    emit("from manim import *")
    if plan.uses_terms:
        emit(construct.TERMS_IMPORT)
    # ease_* rate functions aren't in manim's star export; import the ones this scene uses.
    eases = sorted(set(re.findall(r"\bease_[a-z_]+\b", json.dumps(doc))))
    if eases:
        emit(f"from manim.utils.rate_functions import {', '.join(eases)}")
    emit("import numpy as np")
    if "se.Path(" in json.dumps(doc):
        emit("import svgelements as se")
    if not preview:
        bg = cfg.get("background_color")
        if bg:
            emit(f"config.background_color = {bg!r}")
    if not latex:
        emit("")
        emit(tex.NUMBERS_SOURCE.strip("\n"))
    header = (doc.get("header") or "").rstrip()
    if header:
        emit("")
        emit(header, ("header", "header"))
    for used, src in ((plan.uses_constraints, construct.CONSTRAINTS_SOURCE), (plan.uses_geometry, construct.GEOMETRY_SOURCE),
                      (plan.uses_terms, construct.TERMS_SOURCE)):
        if used:
            emit("")
            emit(src.strip("\n"))
    emit("")
    emit("")
    emit(f"class {scene_name}({base}):")
    members = (scene.get("members") or "").strip("\n")
    if members:
        emit(members, ("header", "members"), 4)
        emit("")
    emit("def construct(self):", indent=4)
    B = 8
    start_len = len(w.lines)
    if plan.uses_constraints:
        emit(f"{plan.constraints_var} = Constraints(self)", None, B)

    # Objects are created where the code creates them: at the top, or right after the step they follow.
    full = doc.get("timeline") or []
    groups = placement_groups(doc)
    for obj in groups.get(-1, []):
        _emit_object(obj, emit, B, preview, plan)
    for i, step in enumerate(full):
        if not step.get("disabled"):
            _emit_step(step, emit, B, preview, doc, plan, skip)
        for obj in groups.get(i, []):
            _emit_object(obj, emit, B, preview, plan)

    if len(w.lines) == start_len:
        emit("pass", None, B)
    after = (scene.get("members_after") or "").strip("\n")
    if after:
        emit("")
        emit(after, ("header", "members"), 4)
    return Generated("\n".join(w.lines) + "\n", w.linemap, [d.to_json() for d in plan.diagnostics], plan.part_index)


def _emit_object(obj: dict, emit, B: int, preview: bool, plan: construct.Plan) -> None:
    ref = ("object", obj["id"])
    name = obj["name"]
    _emit_comment(obj, emit, B, ref)
    if obj["id"] in plan.lines:
        for line in plan.lines[obj["id"]]:
            emit(line, ref, B)
    else:
        ctor = (obj.get("ctor") or "").strip()
        emit(f"{name} = {ctor}({_call_args(obj.get('args'), before_star=_leading(ctor))})", ref, B)
        chain = _join_chain(obj.get("chain", ""))
        if chain:
            emit(f"{name}{chain}", ref, B)
        stretch = obj.get("stretch") or [1, 1]
        for dim, f in enumerate(stretch[:2]):
            if abs(float(f) - 1) > EPS:
                emit(f"{name}.stretch({_num(f)}, {dim})", ref, B)
        if obj.get("scale") not in (None, 1, 1.0):
            emit(f"{name}.scale({_num(obj['scale'])})", ref, B)
        if obj.get("rotation"):
            emit(f"{name}.rotate({_num(obj['rotation'])} * DEGREES)", ref, B)
        pos = obj.get("pos")
        if pos is not None:
            emit(f"{name}.move_to(np.array([{_num(pos[0])}, {_num(pos[1])}, 0]))", ref, B)
    for line in plan.after.get(obj["id"], []):
        emit(line, ref, B)
    if preview:
        emit(f"self._me_reg({name!r}, {name}, {obj['id']!r})", ref, B)


def _emit_comment(elem: dict, emit, B: int, ref: tuple[str, str]) -> None:
    for line in (elem.get("comment") or "").splitlines():
        line = line.strip()
        if line:
            emit(line if line.startswith("#") else "# " + line, ref, B)


_WORD = re.compile(r"\b[A-Za-z_]\w*\b")
_STRING = re.compile(r"""(?:[rRbBuUfF]{0,2})("{3}[\s\S]*?"{3}|'{3}[\s\S]*?'{3}|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')""")


def names_in(src: str) -> set[str]:
    """Identifiers a Python expression reads (not the words inside its string literals)."""
    import ast

    try:
        return {n.id for n in ast.walk(ast.parse(src.strip(), mode="eval")) if isinstance(n, ast.Name)}
    except SyntaxError:
        return set(_WORD.findall(_STRING.sub("", src)))


def placement_groups(doc: dict) -> dict[int, list[dict]]:
    """The objects created at each place (see ``placement``), each after the objects it is built from."""
    at, deps = _placement(doc)
    by_id = {o["id"]: o for o in doc.get("objects", [])}
    out: dict[int, list[dict]] = {}
    done: set[str] = set()

    def visit(oid: str, stack: set[str]) -> None:
        if oid in done or oid in stack:
            return
        stack.add(oid)
        for d in sorted(deps[oid], key=list(by_id).index):
            if at[d] == at[oid]:
                visit(d, stack)
        done.add(oid)
        out.setdefault(at[oid], []).append(by_id[oid])

    for oid in by_id:
        visit(oid, set())
    return out


def placement(doc: dict) -> dict[str, int]:
    """Where each object is created: -1 at the top of construct(), i right after timeline step i.

    An object follows the step in its ``after`` (where the imported code created it), and never comes before
    an object it is built from.
    """
    return _placement(doc)[0]


def _placement(doc: dict) -> tuple[dict[str, int], dict[str, set[str]]]:
    index = {s["id"]: i for i, s in enumerate(doc.get("timeline") or [])}
    objects = doc.get("objects", [])
    by_name = {o["name"]: o["id"] for o in objects}
    ids = {o["id"] for o in objects}
    at = {o["id"]: index.get(o.get("after") or "", -1) for o in objects}
    deps: dict[str, set[str]] = {}
    for o in objects:
        words = names_in(o.get("ctor") or "") | names_in("__me__" + _join_chain(o.get("chain") or ""))
        for v in (o.get("args") or {}).values():
            words |= names_in(f"__me__({v})")
        found = {by_name[w] for w in words if w in by_name}
        found |= {s for s in construct.link_sources(o) if s in ids}
        found.discard(o["id"])
        deps[o["id"]] = found
    changed = True
    while changed:
        changed = False
        for o in objects:
            best = max([at[o["id"]], *(at[d] for d in deps[o["id"]])])
            if best != at[o["id"]]:
                at[o["id"]] = best
                changed = True
    return at, deps


def statement(step: dict, doc: dict | None = None, plan: construct.Plan | None = None, preview: bool = False,
              skip: set[str] = frozenset()) -> list[tuple[str, tuple[str, str]]]:
    """The source lines of one step, each with the element it comes from. Empty: nothing to run."""
    ref = ("step", step["id"])
    kind = step.get("kind")
    if kind == "play":
        anims = _playable(step, skip)
        if not anims:
            return []
        exprs = [(anim_expr(a, doc, plan, preview, skip), ("anim", a["id"])) for a in anims]
        kw = _call_args(step.get("args"))
        one = f"self.play({', '.join(e for e, _ in exprs)}{', ' + kw if kw else ''})"
        # One line when it fits; the preview build keeps one animation per line so errors point at the animation.
        if len(one) <= 100 and (len(exprs) == 1 or not preview):
            return [(one, exprs[0][1] if len(exprs) == 1 else ref)]
        out = [("self.play(", ref)] + [(f"    {e},", r) for e, r in exprs]
        if kw:
            out.append((f"    {kw},", ref))
        return out + [(")", ref)]
    if kind == "wait":
        args = dict(step.get("args") or {})
        duration = str(args.pop("duration", "")).strip()
        return [(f"self.wait({_call_args(args, [duration])})", ref)]
    if kind in ("add", "remove"):
        targets = ", ".join(t for t in step.get("targets") or [] if t)
        return [(f"self.{kind}({targets})", ref)] if targets else []
    if kind == "call":
        method = (step.get("method") or "").strip()
        if not IDENT.match(method):
            return []
        return [(f"self.{method}({_call_args(step.get('args'), before_star=_method_leading(doc, method))})", ref)]
    if kind == "code":
        body = textwrap.dedent(step.get("code") or "").rstrip()
        return [(line, ref) for line in body.splitlines()] if body.strip() else []
    if kind in construct.SWITCH_CLIPS and plan is not None:
        names = [t for t in step.get("targets") or [] if t in plan.switchable]
        if not names:
            return []
        if kind == "couple" and float(step.get("duration") or 0) > EPS:
            return [(f"self.play({plan.constraints_var}.couple({', '.join(names)}), run_time={_num(step['duration'])})", ref)]
        return [(f"{plan.constraints_var}.{'pause' if kind == 'uncouple' else 'resume'}({', '.join(names)})", ref)]
    return []


def _emit_step(step: dict, emit, B: int, preview: bool, doc: dict, plan: construct.Plan, skip: set[str]) -> None:
    lines = statement(step, doc, plan, preview, skip)
    ref = ("step", step["id"])
    if lines:
        _emit_comment(step, emit, B, ref)
    if preview:
        emit(f"self._me_step({step['id']!r})", ref, B)
    for text, r in lines:
        emit(text, r, B)
    if preview:
        emit(f"self._me_step_end({step['id']!r})", ref, B)
