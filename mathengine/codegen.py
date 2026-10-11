"""Compile a Manim Studio scene document into a plain ManimCE Python file.

Every value in the document is stored as Python source (e.g. ``"BLUE"``,
``"UP * 2"``, ``"lambda x: x**2"``), so anything manim accepts can be used
from the GUI.

The timeline is non-linear: clips sit on tracks at absolute times and may
overlap or leave gaps. Compilation groups clips whose time ranges overlap:

* gaps become ``self.wait(...)``
* a group whose clips all start together becomes an ordinary ``self.play(...)``
* any other group becomes ``self.play(TimedAnimations(...))`` (see timed.py),
  which starts each clip at its exact time
* code clips run raw Python at their position (they may contain their own
  ``self.play`` calls, so the clips after them wait on ``self.time``)

``generate(doc, preview=True)`` also emits hooks the preview runtime uses to
map variables to mobjects and to time code clips.
"""

from __future__ import annotations

import json
import keyword
import re
import textwrap
from dataclasses import dataclass, field

from . import construct, tex
from .timed import SOURCE as TIMED_SOURCE

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
EPS = 1e-6


@dataclass
class Generated:
    source: str
    # 1-based line number -> (kind, id) of the document element that produced it
    linemap: dict[int, tuple[str, str]] = field(default_factory=dict)
    # problems with constructions (missing sources, cycles, conflicts…); the scene still compiles
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


def anim_expr(clip: dict, run_time: float | None, doc: dict | None = None, plan: construct.Plan | None = None) -> str:
    """Python expression for an animation clip; ``run_time`` None leaves it to self.play."""
    cls = (clip.get("cls") or "").strip()
    if cls == "TransformTerms" and doc is not None and plan is not None:
        return construct.terms_expr(clip, doc, plan, None if run_time is None else _num(run_time))
    target = (clip.get("target") or "").strip()
    args = {k: v for k, v in (clip.get("args") or {}).items() if k != "run_time"}
    extra = {"run_time": _num(run_time)} if run_time is not None and not _sets_run_time(cls) else {}
    if cls == "animate":
        kw = _call_args(args, extra=extra)
        head = f"{target}.animate({kw})" if kw else f"{target}.animate"
        return head + _join_chain(clip.get("chain", ""))
    kw_target = _target_keyword(cls)
    if kw_target and target:  # ApplyMatrix(matrix, mobject): the target isn't the first argument
        return f"{cls}({_call_args({**args, kw_target: target}, [], extra)})"
    return f"{cls}({_call_args(args, [target], extra, _leading(cls, skip=1))})"


def _leading(ctor: str, skip: int = 0) -> tuple[str, ...]:
    if not re.fullmatch(r"[A-Za-z_]\w*", ctor or ""):
        return ()
    try:
        from .catalog import leading_positionals
    except Exception:
        return ()
    return leading_positionals(ctor, skip)


def _sets_run_time(cls: str) -> bool:
    if not re.fullmatch(r"[A-Za-z_]\w*", cls or ""):
        return False
    try:
        from .catalog import sets_run_time
    except Exception:
        return False
    return sets_run_time(cls)


def _target_keyword(cls: str) -> str | None:
    try:
        from .catalog import target_keyword
    except Exception:
        return None
    return target_keyword(cls)


def _end(c: dict) -> float:
    return float(c["start"]) + float(c.get("duration", 0))


def _groups(clips: list[dict]) -> list[list[dict]]:
    """Split clips into groups of transitively overlapping time ranges."""
    groups: list[list[dict]] = []
    end = -1.0
    for c in sorted(clips, key=lambda c: float(c["start"])):
        s = float(c["start"])
        if groups and s < end - EPS:
            groups[-1].append(c)
            end = max(end, _end(c))
        else:
            groups.append([c])
            end = _end(c)
    return groups


class _Writer:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.linemap: dict[int, tuple[str, str]] = {}

    def emit(self, text: str, ref: tuple[str, str] | None = None, indent: int = 0) -> None:
        for raw in text.splitlines() or [""]:
            self.lines.append(" " * indent + raw if raw.strip() else "")
            if ref:
                self.linemap[len(self.lines)] = ref


def _active_clips(doc: dict, skip: set[str] = frozenset()) -> list[dict]:
    hidden = {t["id"] for t in doc.get("tracks", []) if t.get("hidden")}
    out = []
    for c in doc.get("clips", []):
        if c.get("disabled") or c.get("track") in hidden or c["id"] in skip:
            continue
        if c.get("kind") == "anim" and not (c.get("cls") or "").strip():
            continue
        out.append(c)
    return out


def _introduces(cls: str) -> bool:
    if not re.fullmatch(r"[A-Za-z_]\w*", cls or ""):
        return False
    try:
        from .catalog import is_introducer
    except Exception:
        return False
    return is_introducer(cls)


def _check_order(clips: list[dict], plan: construct.Plan) -> None:
    """Warn about clips that animate an object before its intro (Create, FadeIn, Add…) on the timeline.

    manim puts an object on screen as soon as anything animates it, so it would be visible from that
    clip on, and the intro would then draw it again.
    """
    appears: dict[str, tuple[float, str]] = {}
    for c in clips:
        if c.get("kind") == "add":
            names, how = c.get("targets") or [], "an Add clip"
        elif c.get("kind") == "anim" and _introduces((c.get("cls") or "").strip()):
            names, how = [(c.get("target") or "").strip()], (c.get("cls") or "").strip()
        else:
            continue
        for n in names:
            if n and (n not in appears or float(c["start"]) < appears[n][0]):
                appears[n] = (float(c["start"]), how)
    for c in clips:
        name = (c.get("target") or "").strip()
        if c.get("kind") != "anim" or name not in appears or _introduces((c.get("cls") or "").strip()):
            continue
        t, how = appears[name]
        if float(c["start"]) < t - EPS:
            plan.diag(c["id"], "warning", f"{name} only appears at {_num(t)}s ({how}), but this clip animates it at {_num(c['start'])}s: "
                      f"manim shows it from here, and {how} then draws it again. Move this clip after {_num(t)}s, or move the intro earlier.",
                      "clip")


def _is_instant(c: dict) -> bool:
    """Clips that happen at one instant: add, remove, uncouple, and couple without a glide."""
    return c.get("kind") in ("add", "remove", "uncouple") or (c.get("kind") == "couple" and float(c.get("duration") or 0) <= EPS)


def _gliding(c: dict) -> bool:
    return c.get("kind") == "couple" and float(c.get("duration") or 0) > EPS


def _instant_call(c: dict, plan: construct.Plan | None = None) -> str | None:
    if c.get("kind") in construct.SWITCH_CLIPS:
        names = [t for t in c.get("targets", []) if plan and t in plan.switchable]
        if not names:
            return None
        return f"{plan.constraints_var}.{'pause' if c['kind'] == 'uncouple' else 'resume'}({', '.join(names)})"
    targets = ", ".join(t for t in c.get("targets", []) if t)
    return f"self.{c['kind']}({targets})" if targets else None


def _glide_call(c: dict, plan: construct.Plan, run_time: float) -> str | None:
    """A couple clip with a duration: the objects move back into place over it."""
    names = [t for t in c.get("targets", []) if t in plan.switchable]
    return f"{plan.constraints_var}.couple({', '.join(names)}, run_time={_num(run_time)})" if names else None


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
    clips = _active_clips(doc, plan.invalid_clips)
    _check_order(clips, plan)
    code_clips = sorted((c for c in clips if c.get("kind") == "code"), key=lambda c: float(c["start"]))
    timed_clips = [c for c in clips if c.get("kind") != "code"]
    groups = _groups(timed_clips)
    needs_helper = any(not _simple(g) for g in groups)

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
    if needs_helper:
        emit("")
        emit(TIMED_SOURCE.strip("\n"))
    for used, src in ((plan.uses_constraints, construct.CONSTRAINTS_SOURCE), (plan.uses_geometry, construct.GEOMETRY_SOURCE),
                      (plan.uses_terms, construct.TERMS_SOURCE)):
        if used:
            emit("")
            emit(src.strip("\n"))
    emit("")
    emit("")
    emit(f"class {scene_name}({base}):")
    emit("def construct(self):", indent=4)
    B = 8
    start_len = len(w.lines)
    if plan.uses_constraints:
        emit(f"{plan.constraints_var} = Constraints(self)", None, B)

    for obj in doc.get("objects", []):
        ref = ("object", obj["id"])
        name = obj["name"]
        if obj["id"] in plan.lines:
            for line in plan.lines[obj["id"]]:
                emit(line, ref, B)
            for line in plan.after.get(obj["id"], []):
                emit(line, ref, B)
            if preview:
                emit(f"self._me_reg({name!r}, {name}, {obj['id']!r})", ref, B)
            continue
        emit(f"{name} = {(obj.get('ctor') or '').strip()}({_call_args(obj.get('args'), before_star=_leading((obj.get('ctor') or '').strip()))})", ref, B)
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

    # Interleave clip groups with code clips (code runs once everything before it has played).
    state = {"cursor": 0.0, "dynamic": False}

    def wait_until(t: float, ref: tuple[str, str] | None) -> None:
        if state["dynamic"]:
            emit(f"if self.time < {_num(t)} - 1e-3:", ref, B)
            emit(f"    self.wait({_num(t)} - self.time)", ref, B)
        elif t - state["cursor"] > EPS:
            emit(f"self.wait({_num(t - state['cursor'])})", ref, B)
        state["cursor"] = max(state["cursor"], t)

    gi = 0
    for code in code_clips + [None]:
        limit = float(code["start"]) if code else float("inf")
        while gi < len(groups) and float(groups[gi][0]["start"]) < limit - EPS:
            _emit_group(groups[gi], emit, wait_until, state, B, preview, doc, plan)
            gi += 1
        if code is None:
            break
        ref = ("clip", code["id"])
        wait_until(float(code["start"]), ref)
        if preview:
            emit(f"self._me_step({code['id']!r})", ref, B)
        body = textwrap.dedent(code.get("code") or "").rstrip()
        if body.strip():
            emit(body, ref, B)
        if preview:
            emit(f"self._me_step_end({code['id']!r})", ref, B)
        if "self.play" in body or "self.wait" in body or "self.pause" in body:
            state["dynamic"] = True

    if len(w.lines) == start_len:
        emit("pass", None, B)
    return Generated("\n".join(w.lines) + "\n", w.linemap, [d.to_json() for d in plan.diagnostics], plan.part_index)


def _simple(group: list[dict]) -> bool:
    """Can this group be an ordinary self.play / self.add?"""
    actions = [c for c in group if c.get("kind") != "hold"]
    if not actions:
        return True
    if any(_gliding(c) for c in actions):
        return False
    start = float(group[0]["start"])
    if any(abs(float(c["start"]) - start) > EPS for c in actions):
        return False
    anims = [c for c in actions if c.get("kind") == "anim"]
    if anims and len(anims) != len(actions):
        return False  # instant actions mixed with animations
    targets = [c.get("target") for c in anims]
    return len(targets) == len(set(targets))


def _emit_group(group, emit, wait_until, state, B, preview, doc=None, plan=None) -> None:
    start = float(group[0]["start"])
    end = max(_end(c) for c in group)
    first_ref = ("clip", group[0]["id"])
    actions = [c for c in group if c.get("kind") != "hold"]
    wait_until(start, first_ref)
    if not actions:
        wait_until(end, first_ref)
        return

    if _simple(group):
        anims = [c for c in actions if c.get("kind") == "anim"]
        if not anims:  # instant add/remove
            for c in actions:
                call = _instant_call(c, plan)
                if call:
                    emit(call, ("clip", c["id"]), B)
            wait_until(end, first_ref)
            return
        durs = {round(float(c["duration"]), 4) for c in anims}
        shared = durs.pop() if len(durs) == 1 else None
        exprs = [(anim_expr(c, None if shared is not None else float(c["duration"]), doc, plan), c) for c in anims]
        tail = f", run_time={_num(shared)}" if shared is not None else ""
        if len(exprs) == 1:
            emit(f"self.play({exprs[0][0]}{tail})", ("clip", exprs[0][1]["id"]), B)
        else:
            emit("self.play(", first_ref, B)
            for expr, c in exprs:
                emit(f"    {expr},", ("clip", c["id"]), B)
            if tail:
                emit(f"    {tail[2:]},", first_ref, B)
            emit(")", first_ref, B)
        state["cursor"] = max(state["cursor"], max(_end(c) for c in anims))
        wait_until(end, first_ref)
        return

    emit("self.play(TimedAnimations(", first_ref, B)
    for c in sorted(group, key=lambda c: float(c["start"])):
        ref = ("clip", c["id"])
        offset = _num(float(c["start"]) - start)
        if c.get("kind") == "anim":
            emit(f"    ({offset}, lambda: {anim_expr(c, float(c['duration']), doc, plan)}),", ref, B)
        elif _is_instant(c):
            call = _instant_call(c, plan)
            if call:
                emit(f"    ({offset}, lambda: {call}),", ref, B)
        elif _gliding(c):
            call = _glide_call(c, plan, float(c["duration"]))
            if call:
                emit(f"    ({offset}, lambda: {call}),", ref, B)
    emit(f"    run_time={_num(end - start)},", first_ref, B)
    emit("))", first_ref, B)
    state["cursor"] = end
