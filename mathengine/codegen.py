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

import ast
import io
import json
import keyword
import re
import textwrap
import tokenize
from dataclasses import dataclass, field

from . import construct, defs, tex, timeline

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
    # element id (object, step, animation) -> where its code is: (line, col, end line, end col), 1-based lines,
    # 0-based columns in characters, end exclusive. An animation's is its exact expression inside the self.play.
    spans: dict[str, list[tuple[int, int, int, int]]] = field(default_factory=dict)


def is_valid_name(name: str) -> bool:
    return bool(IDENT.match(name)) and not keyword.iskeyword(name)


def _num(v: float) -> str:
    v = round(float(v), 4)
    return repr(int(v)) if v == int(v) else repr(v)


def _call_args(args: dict | None, leading: list[str] | None = None, extra: dict | None = None,
               before_star: tuple[str, ...] = (), positional: list[str] | None = None) -> str:
    """``positional``: the arguments the code passed by position, in order (as it was written: ``Line(a, b)``, not
    ``Line(a, end=b)``). They stay positional as long as none before them is gone; the rest are keywords."""
    parts = [p for p in (leading or []) if p and p.strip()]
    merged = dict(args or {})
    merged.update(extra or {})
    for name in positional or []:
        val = str(merged.get(name, "")).strip()
        if not val:
            break
        parts.append(val)
        merged.pop(name)
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
    lines = [line.strip() for line in (chain or "").splitlines() if line.strip()]
    chain = "".join(("" if not k or line.startswith(".") else " ") + line for k, line in enumerate(lines))  # .a() .b(): .a().b()
    if chain and not chain.startswith("."):
        chain = "." + chain
    return chain


def is_composition(anim: dict) -> bool:
    """An animation made of other animations (AnimationGroup, LaggedStart, Succession…): its children are ``anims``."""
    return anim.get("anims") is not None


def _primary(expr: str) -> str:
    """``expr`` as something ``.animate`` can follow: ``(a + b)``, not ``a + b`` (which animates only ``b``)."""
    try:
        node = ast.parse(expr, mode="eval").body
    except SyntaxError:
        return expr
    simple = (ast.Name, ast.Attribute, ast.Subscript, ast.Call, ast.Constant, ast.List, ast.Tuple)
    if isinstance(node, simple) and not (isinstance(node, ast.Tuple) and not expr.lstrip().startswith("(")):
        return expr
    return f"({expr})"


def _pure(expr: str) -> bool:
    """Whether evaluating ``expr`` only reads (names, attributes, items): safe to evaluate again to measure it."""
    try:
        node = ast.parse(expr, mode="eval").body
    except SyntaxError:
        return False
    while isinstance(node, (ast.Attribute, ast.Subscript)):
        if isinstance(node, ast.Subscript) and not isinstance(node.slice, (ast.Constant, ast.Name, ast.UnaryOp)):
            return False
        node = node.value
    return isinstance(node, ast.Name)


def anim_expr(anim: dict, doc: dict | None = None, plan: construct.Plan | None = None, tag: bool = False,
              skip: set[str] = frozenset()) -> str:
    """Python expression for one animation, as written in ``self.play(...)``.

    ``tag``: wrap it for the preview runtime, which then measures when manim runs it (``self._me_tag``).
    """
    cls = (anim.get("cls") or "").strip()
    target = (anim.get("target") or "").strip()
    args = anim.get("args") or {}
    if cls == "expr":  # built by an expression (``*[FadeIn(m) for m in dots]``, a variable): as written
        src = (anim.get("src") or "").strip()
        return f"self._me_tag({src}, {anim['id']!r})" if tag and src and not src.startswith("*") else src
    if cls == "TransformTerms" and doc is not None and plan is not None:
        expr = construct.terms_expr(anim, doc, plan)
    elif cls == "animate":
        kw = _call_args(args)
        target = _primary(target)
        expr = (f"{target}.animate({kw})" if kw else f"{target}.animate") + _join_chain(anim.get("chain", ""))
    elif is_composition(anim):
        children = [anim_expr(c, doc, plan, tag, skip) for c in anim.get("anims") or []
                    if not c.get("disabled") and c["id"] not in skip]
        expr = f"{cls}({_call_args(args, children)})"
    elif (kw_target := _target_keyword(cls)) and target:  # ApplyMatrix(matrix, mobject): the target isn't the first argument
        expr = f"{cls}({_target_after(cls, kw_target, target, args)})"
    else:
        expr = f"{cls}({_call_args(args, [target], None, _leading(cls, skip=1), anim.get('positional'))})"
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


def string_lines(text: str) -> set[int]:
    """The lines of ``text`` (0-based) that start inside a string (a triple-quoted one's second line on): they are
    the string's content, so indenting or dedenting the code must leave them as they are."""
    inside: set[int] = set()
    opened: list[int] = []  # f-strings: the line each open one started on
    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type == tokenize.STRING:
                inside.update(range(tok.start[0], tok.end[0]))
            elif tok.type == getattr(tokenize, "FSTRING_START", -1):
                opened.append(tok.start[0])
            elif tok.type == getattr(tokenize, "FSTRING_END", -1) and opened:
                inside.update(range(opened.pop(), tok.end[0]))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        pass
    return inside


def dedent_code(text: str, keep_first: bool = False) -> str:
    """``textwrap.dedent`` that leaves the content of multi-line strings as it is. ``keep_first``: the first line
    is already where it belongs (a statement's continuation lines keep their indentation relative to each other)."""
    lines = text.split("\n")
    inside = string_lines(text)
    code = [i for i, ln in enumerate(lines) if ln.strip() and i not in inside and not (keep_first and i == 0)]
    margin = min((len(lines[i]) - len(lines[i].lstrip()) for i in code), default=0)
    return "\n".join(ln if i in inside or (keep_first and i == 0) else ln[margin:] if ln.strip() else ""
                     for i, ln in enumerate(lines))


class _Writer:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.linemap: dict[int, tuple[str, str]] = {}

    def emit(self, text: str, ref: tuple[str, str] | None = None, indent: int = 0) -> None:
        inside = string_lines(text) if indent and "\n" in text else set()
        for k, raw in enumerate(text.splitlines() or [""]):
            self.lines.append(raw if k in inside else " " * indent + raw if raw.strip() else "")
            if ref:
                self.linemap[len(self.lines)] = ref


def _playable(step: dict, skip: set[str]) -> list[dict]:
    return [a for a in step.get("anims") or [] if not a.get("disabled") and a["id"] not in skip]


def _keyword(step: dict) -> str:
    """The keyword a block's header starts with (``for``, ``elif``, ``except``…; ``async for`` is ``for``)."""
    words = (step.get("head") or "").split()
    words = words[1:] if words[:1] == ["async"] else words
    return re.split(r"\W", words[0], maxsplit=1)[0] if words else "if"


def _fits(opener: str, seen: list[str], clause: str) -> bool:
    """Whether a compound statement that starts with ``opener`` and has the clauses ``seen`` can take ``clause``."""
    if opener == "if":
        return clause in ("elif", "else") and "else" not in seen
    if opener in ("for", "while"):
        return clause == "else" and not seen
    if opener == "try":
        if clause == "except":
            return not {"else", "finally"} & set(seen)
        if clause == "else":
            return "except" in seen and not {"else", "finally"} & set(seen)
        return clause == "finally" and "finally" not in seen
    return False


def _target_names(step: dict) -> list[str]:
    """The names an add step shows: its targets are names or expressions (``*dots``, ``VGroup(a, b)``)."""
    return [w for t in step.get("targets") or [] for w in _WORD.findall(_STRING.sub("", t))]


def _check_timeline(steps: list[dict], plan: construct.Plan, skip: set[str]) -> None:
    """What manim will do that the author may not expect, statement by statement.

    * An animation of an object that isn't on screen yet: ``self.play`` adds it at the start of the play,
      without an intro, unless the animation is an intro itself (Create, FadeIn, Write…).
    * Two animations of the same object in one ``self.play``: manim runs both on it at once, and where they
      change the same properties the later one in the list wins.
    * An empty composition: manim can't play it.
    """
    shown: set[str] = set()
    # objects brought on screen on purpose later (an intro, self.add): animating one before that is a mistake
    introduced_at: dict[str, int] = {}
    for i, step in enumerate(steps):
        names: list[str] = _target_names(step) if step.get("kind") == "add" else []
        for a in timeline.walk(_playable(step, skip)) if step.get("kind") == "play" else []:
            if (a.get("cls") or "").strip() == "Add" or _flag((a.get("cls") or "").strip(), "is_introducer"):
                names += [t.strip() for t in (a.get("target") or "").split(",") if t.strip()]
        for n in names:
            introduced_at.setdefault(n, i)
    for i, step in enumerate(steps):
        kind = step.get("kind")
        if kind == "add":
            shown.update(_target_names(step))
        elif kind == "remove":
            shown.difference_update(t.lstrip("*").strip() for t in step.get("targets") or [])
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
                    if introduced_at.get(t, -1) > i:
                        plan.diag(a["id"], "warning", f"{t} isn't on screen before this self.play, so manim adds it as the play "
                                  f"starts, with no intro, and its intro later finds it already there. Move the intro before "
                                  f"it (or this after the intro).", "anim")
                    else:  # how manim code often brings an object on: it appears as it starts to move
                        plan.diag(a["id"], "info", f"{t} comes on screen with this animation: manim adds it as the play "
                                  f"starts (no intro).", "anim")
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

    top = top_lines(doc, plan, preview, latex)
    written = doc.get("top_written")
    if not preview and written and written.get("gen") == "\n".join(t for t, _ in top_lines(doc, plan, False, True)):
        # the top of the file as the code had it (its imports, config, helpers, blank lines)
        for line in written.get("as", "").split("\n"):
            emit(line, ("header", "header"))
        if not latex and tex.NUMBERS_SOURCE.strip("\n") not in written.get("as", ""):
            emit(tex.NUMBERS_SOURCE.strip("\n"))
            emit("")
            emit("")
    else:
        for text, ref in top:
            emit(text, ref)
    decorators = (scene.get("decorators") or "").strip("\n")
    if decorators:
        emit(decorators, ("header", "header"))
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
    spans: dict[str, list[tuple[int, int, int, int]]] = {}

    def placed(elem: dict, start: int, step: dict | None = None) -> None:
        if not preview:
            _spans(w.lines, start, len(w.lines), elem["id"], step, skip, spans)

    for obj in groups.get(-1, []):
        at = len(w.lines)
        _emit_object(obj, emit, B, preview, plan)
        placed(obj, at)
    # Compound statements (block … end): their bodies are indented one level more. What doesn't balance is
    # repaired so the code always runs: a clause or end with no open block is left out, and so is a clause its
    # block can't have there (an else after a with, an except after a for, a second else; its steps stay in the
    # clause before it); an empty body gets `pass`, a try left without except or finally gets `finally: pass`,
    # a block left open is closed at the end. A disabled block leaves its whole statement out.
    shapes = timeline.compounds(full)
    loops = defs.loop_scope(doc)  # what a Repeat's math can use
    open_: list[dict] = []  # {"id", "end", "at": line of its header, "clause": (id, line) of the open clause, "body"}
    hidden: list[int] = []  # depth of a disabled block being skipped

    def indent() -> int:
        return B + 4 * len(open_)

    def close_body(frame: dict) -> None:
        if not any(ln.strip() and not ln.lstrip().startswith("#") for ln in w.lines[frame["body"]:]):
            emit("pass", ("step", frame["clause"][0]), indent())
        if not preview:
            _spans(w.lines, frame["clause"][1], len(w.lines), frame["clause"][0], None, skip, spans)

    def close(frame: dict) -> None:
        close_body(frame)
        if frame["kw"] == "try" and not {"except", "finally"} & set(frame["seen"]):
            emit("finally:", None, indent() - 4)
            emit("pass", None, indent())
        open_.pop()
        if preview and frame["end"]:
            emit(f"self._me_step_end({frame['end']!r})", ("step", frame["end"]), indent())
        if not preview:
            _spans(w.lines, frame["at"], len(w.lines), frame["id"], None, skip, spans)

    def header(step: dict, depth: int) -> None:
        ref = ("step", step["id"])
        if step.get("gap") and not preview:
            emit("")
        _emit_comment(step, emit, B + 4 * depth, ref)
        line = f"{defs.block_head(step, loops)}:"
        emit(line if preview else _with_eol(step, [line])[0], ref, B + 4 * depth)

    for i, step in enumerate(full):
        kind = step.get("kind")
        if hidden:
            if kind == "block" and not timeline.is_clause(step):
                hidden[-1] += 1
            elif kind == "end":
                hidden[-1] -= 1
                if hidden[-1] < 0:
                    hidden.pop()
        elif kind == "block" and timeline.is_clause(step):
            if open_ and _fits(open_[-1]["kw"], open_[-1]["seen"], _keyword(step)):
                frame = open_[-1]
                frame["seen"].append(_keyword(step))
                close_body(frame)
                header(step, len(open_) - 1)
                frame["clause"], frame["body"] = (step["id"], len(w.lines) - 1), len(w.lines)
                if preview:
                    emit(f"self._me_enter({step['id']!r})", ("step", step["id"]), indent())
        elif kind == "block":
            if step.get("disabled"):
                hidden.append(0)
            else:
                end = shapes.get(step["id"], ([], None))[1]
                if preview and end:
                    emit(f"self._me_step({end!r})", ("step", end), indent())
                at = len(w.lines)
                header(step, len(open_))
                open_.append({"id": step["id"], "end": end, "at": at, "clause": (step["id"], at), "body": len(w.lines),
                              "kw": _keyword(step), "seen": []})
                if preview:
                    emit(f"self._me_enter({step['id']!r})", ("step", step["id"]), indent())
        elif kind == "end":
            if open_:
                close(open_[-1])
        elif not step.get("disabled"):
            at = len(w.lines)
            _emit_step(step, emit, indent(), preview, doc, plan, skip)
            placed(step, at, step)
        for obj in groups.get(i, []):
            at = len(w.lines)
            _emit_object(obj, emit, indent(), preview, plan)
            placed(obj, at)
    while open_:
        close(open_[-1])

    if len(w.lines) == start_len:
        emit("pass", None, B)
    after = (scene.get("members_after") or "").strip("\n")
    if after:
        emit("")
        emit(after, ("header", "members"), 4)
    footer = (doc.get("footer") or "").rstrip()
    if footer:
        emit("")
        emit("")
        emit(footer, ("header", "header"))
    return Generated("\n".join(w.lines) + "\n", w.linemap, [d.to_json() for d in plan.diagnostics], plan.part_index, spans)


def _spans(lines: list[str], start: int, end: int, eid: str, step: dict | None, skip: set[str],
           out: dict[str, list[tuple[int, int, int, int]]]) -> None:
    """Where an element's code is, in ``lines[start:end]`` (what was just written for it): the statement, without its
    comment and blank lines; for a self.play, each animation's own expression too (found in the code's syntax, so it
    holds for code kept as it was written)."""
    code = [i for i in range(start, end) if lines[i].strip() and not lines[i].lstrip().startswith("#")]
    if not code:
        return
    first, last = code[0], code[-1]
    top = next(i for i in range(start, end) if lines[i].strip())  # its comment above it is part of its block
    out[eid] = [(top + 1, len(lines[top]) - len(lines[top].lstrip()), last + 1, len(lines[last]))]
    if not step or step.get("kind") != "play":
        return
    block = lines[first:last + 1]
    text = dedent_code("\n".join(block))
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return
    shift = [len(a) - len(b) for a, b in zip(block, text.split("\n"))]
    call = next((n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                 and n.func.attr == "play" and isinstance(n.func.value, ast.Name) and n.func.value.id == "self"), None)
    if call is None:
        return

    def col(line: int, byte: int) -> int:  # ast columns are utf-8 bytes
        src = text.split("\n")[line - 1]
        return len(src.encode()[:byte].decode(errors="ignore")) + shift[line - 1]

    def place(anims: list[dict], nodes: list[ast.expr]) -> None:
        live = [a for a in anims if not a.get("disabled") and a["id"] not in skip]
        if len(nodes) < len(live) or any(isinstance(n, ast.Starred) for n in nodes[:len(live)]):
            return  # not one argument per animation: the statement stands for them
        for a, n in zip(live, nodes):
            out[a["id"]] = [(first + n.lineno, col(n.lineno, n.col_offset), first + n.end_lineno, col(n.end_lineno, n.end_col_offset))]
            if a.get("anims") and isinstance(n, ast.Call):
                place(a["anims"], list(n.args))

    place(step.get("anims") or [], list(call.args))


def top_lines(doc: dict, plan: construct.Plan, preview: bool, latex: bool) -> list[tuple[str, tuple[str, str] | None]]:
    """What codegen writes above the scene class: imports, config, the header (the code's own module-level code), the
    helpers the document needs, and the blank lines before the class."""
    out: list[tuple[str, tuple[str, str] | None]] = []

    def emit(text: str, ref: tuple[str, str] | None = None) -> None:
        out.extend((raw, ref) for raw in (text.splitlines() or [""]))

    cfg = doc.get("config", {})
    emit("from manim import *")
    if plan.uses_terms:
        emit(construct.TERMS_IMPORT)
    # ease_* rate functions aren't in manim's star export; import the ones this scene uses.
    # (not in the top as the code had it: what it imports must not decide whether it is still what codegen writes)
    text = json.dumps({k: v for k, v in doc.items() if k != "top_written"})
    eases = sorted(set(re.findall(r"\bease_[a-z_]+\b", text)))
    if eases:
        emit(f"from manim.utils.rate_functions import {', '.join(eases)}")
    emit("import numpy as np")
    if "se.Path(" in text:
        emit("import svgelements as se")
    if not preview:
        bg = cfg.get("background_color")
        if bg:
            emit(f"config.background_color = {bg!r}")
    if not latex and tex.NUMBERS_SOURCE.strip("\n") not in (doc.get("header") or ""):
        emit("")
        emit(tex.NUMBERS_SOURCE.strip("\n"))
    comp = defs.compile_defs(doc.get("defs") or [], defs.manim_names())
    comp.helpers |= plan.helpers
    if comp.source:
        emit("")
        emit("")
        emit(comp.source.rstrip("\n"), ("header", "defs"))
    header = (doc.get("header") or "").rstrip()
    gap = bool(comp.source)  # after the definitions' functions: two blank lines, as Python is written
    if header:
        emit("")
        if gap:
            emit("")
        emit(header, ("header", "header"))
        gap = False
    for used, src in ((plan.uses_constraints, construct.CONSTRAINTS_SOURCE), (plan.uses_geometry, construct.GEOMETRY_SOURCE),
                      (plan.uses_terms, construct.TERMS_SOURCE)):
        if used:
            emit("")
            if gap:
                emit("")
                gap = False
            emit(src.strip("\n"))
    emit("")
    emit("")
    return out


def object_lines(obj: dict, plan: construct.Plan) -> list[str]:
    """The statements that make an object (no comments), as codegen writes them."""
    if obj["id"] in plan.lines:
        return list(plan.lines[obj["id"]])
    name = obj["name"]
    out: list[str] = []
    ctor = (obj.get("ctor") or "").strip()
    made = f"{name} = {ctor}({_call_args(obj.get('args'), before_star=_leading(ctor), positional=obj.get('positional'))})"
    chain = _join_chain(obj.get("chain", ""))
    # Written as the code had it: methods on the line that makes it, and each line of calls after it. When the
    # methods were changed since, the ones still on that line stay there and the others follow on one line.
    layout = [_join_chain(p) for p in obj.get("chain_layout") or []]
    if layout and "".join(layout) == chain:
        out.append(made + layout[0])
        out += [f"{name}{piece}" for piece in layout[1:] if piece]
    elif layout and layout[0] and chain.startswith(layout[0]):
        out.append(made + layout[0])
        if chain[len(layout[0]):]:
            out.append(f"{name}{chain[len(layout[0]):]}")
    else:
        out.append(made)
        if chain:
            out.append(f"{name}{chain}")
    stretch = obj.get("stretch") or [1, 1]
    for dim, f in enumerate(stretch[:2]):
        if abs(float(f) - 1) > EPS:
            out.append(f"{name}.stretch({_num(f)}, {dim})")
    if obj.get("scale") not in (None, 1, 1.0):
        out.append(f"{name}.scale({_num(obj['scale'])})")
    if obj.get("rotation"):
        out.append(f"{name}.rotate({_num(obj['rotation'])} * DEGREES)")
    pos = obj.get("pos")
    if pos is not None:
        out.append(f"{name}.move_to(np.array([{_num(pos[0])}, {_num(pos[1])}, 0]))")
    return out


def as_written(elem: dict, lines: list[str]) -> list[str]:
    """``lines`` of an element, or the code's own text for them (its line breaks, spacing, quotes) while the
    element is unchanged since the code was read: ``written`` holds both."""
    w = elem.get("written")
    if w and w.get("gen") == "\n".join(lines):
        return w.get("as", "").splitlines()
    return lines


def _emit_object(obj: dict, emit, B: int, preview: bool, plan: construct.Plan) -> None:
    ref = ("object", obj["id"])
    name = obj["name"]
    if obj.get("gap") and not preview:
        emit("")
    _emit_comment(obj, emit, B, ref)
    lines = object_lines(obj, plan)
    lines = lines if preview else _with_eol(obj, as_written(obj, lines))
    if lines:
        emit("\n".join(lines), ref, B)
    for line in plan.after.get(obj["id"], []):
        emit(line, ref, B)
    if preview:
        emit(f"self._me_reg({name!r}, {name}, {obj['id']!r})", ref, B)


def _with_eol(elem: dict, lines: list[str]) -> list[str]:
    """``lines`` with the element's end-of-line comment (``# …``) after the last one."""
    eol = (elem.get("eol") or "").strip()
    if not eol or not lines:
        return lines
    return [*lines[:-1], f"{lines[-1]}  {eol if eol.startswith('#') else '# ' + eol}"]


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
        return [(f"self.{method}({_call_args(step.get('args'), before_star=_method_leading(doc, method), positional=step.get('positional'))})", ref)]
    if kind == "apply":
        target, chain = (step.get("target") or "").strip(), _join_chain(step.get("chain") or "")
        if not target or not chain:
            return []
        line = f"{_primary(target)}{chain}"
        if preview and _pure(target):  # its object before and after, for the keyframe editor (the measuring run only)
            return [(f"self._me_state({step['id']!r}, {_primary(target)}, 0)", ref), (line, ref),
                    (f"self._me_state({step['id']!r}, {_primary(target)}, 1)", ref)]
        return [(line, ref)]
    if kind == "assign":
        target, op, value = (step.get("target") or "").strip(), (step.get("op") or "=").strip(), (step.get("value") or "").strip()
        if not target or not value:
            return []
        return [(line, ref) for line in f"{target} {op} {value}".splitlines()]
    if kind == "block":
        return [(f"{defs.block_head(step, defs.loop_scope(doc) if doc else None)}:", ref)]
    if kind == "code":
        body = dedent_code(step.get("code") or "").rstrip()
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
    if not preview and lines:
        written = as_written(step, [text for text, _ in lines])
        if written != [text for text, _ in lines]:
            lines = [(text, ref) for text in written]
    if lines and step.get("gap") and not preview:
        emit("")
    if lines:
        _emit_comment(step, emit, B, ref)
    if preview:
        emit(f"self._me_step({step['id']!r})", ref, B)
    elif lines and step.get("eol"):
        lines = [*lines[:-1], (_with_eol(step, [lines[-1][0]])[0], lines[-1][1])]
    inside = string_lines("\n".join(text for text, _ in lines))
    for k, (text, r) in enumerate(lines):
        emit(text, r, 0 if k in inside else B)
    if preview:
        emit(f"self._me_step_end({step['id']!r})", ref, B)
