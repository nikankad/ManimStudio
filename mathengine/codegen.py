"""Compile a MathEngine scene document into a plain ManimCE Python file.

Every value in the document is stored as Python source (e.g. ``"BLUE"``,
``"UP * 2"``, ``"lambda x: x**2"``), so anything manim accepts can be used
from the GUI. ``generate(doc)`` gives a standalone file that runs with the
``manim`` CLI; ``generate(doc, preview=True)`` additionally emits hooks the
preview runtime uses to map time -> step and variable -> mobject.
"""

from __future__ import annotations

import keyword
import re
from dataclasses import dataclass, field

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass
class Generated:
    source: str
    # 1-based line number -> (kind, id) of the document element that produced it
    linemap: dict[int, tuple[str, str]] = field(default_factory=dict)


def is_valid_name(name: str) -> bool:
    return bool(IDENT.match(name)) and not keyword.iskeyword(name)


def _call_args(args: dict | None, leading: list[str] | None = None) -> str:
    parts = [p for p in (leading or []) if p and p.strip()]
    args = args or {}
    star = str(args.get("*", "")).strip()
    if star:
        parts.append(star)
    for key, val in args.items():
        if key == "*":
            continue
        val = str(val).strip()
        if val:
            parts.append(f"{key}={val}")
    return ", ".join(parts)


def anim_expr(anim: dict) -> str:
    cls = (anim.get("cls") or "").strip()
    target = (anim.get("target") or "").strip()
    if cls == "animate":
        chain = _join_chain(anim.get("chain", ""))
        kw = _call_args(anim.get("args"))
        head = f"{target}.animate({kw})" if kw else f"{target}.animate"
        return head + chain
    return f"{cls}({_call_args(anim.get('args'), [target])})"


def _join_chain(chain: str) -> str:
    chain = " ".join(line.strip() for line in (chain or "").splitlines() if line.strip())
    if chain and not chain.startswith("."):
        chain = "." + chain
    return chain


def play_expr(step: dict) -> str:
    anims = [anim_expr(a) for a in step.get("anims", []) if (a.get("cls") or "").strip()]
    lag = str(step.get("lag_ratio", "")).strip()
    if lag and len(anims) > 1:
        anims = [f"LaggedStart({', '.join(anims)}, lag_ratio={lag})"]
    kwargs = dict(step.get("args") or {})
    for key in ("run_time", "rate_func"):
        if str(step.get(key, "")).strip():
            kwargs[key] = step[key]
    return f"self.play({_call_args(kwargs, anims)})"


def generate(doc: dict, preview: bool = False) -> Generated:
    lines: list[str] = []
    linemap: dict[int, tuple[str, str]] = {}

    def emit(text: str, ref: tuple[str, str] | None = None, indent: int = 0) -> None:
        for raw in text.splitlines() or [""]:
            lines.append(" " * indent + raw if raw.strip() else "")
            if ref:
                linemap[len(lines)] = ref

    scene = doc.get("scene", {})
    scene_name = scene.get("name") or "MainScene"
    base = scene.get("base") or "Scene"
    cfg = doc.get("config", {})

    emit("from manim import *")
    emit("import numpy as np")
    if not preview:
        bg = cfg.get("background_color")
        if bg:
            emit(f"config.background_color = {bg!r}")
    header = (doc.get("header") or "").rstrip()
    if header:
        emit("")
        emit(header, ("header", "header"))
    emit("")
    emit("")
    emit(f"class {scene_name}({base}):")
    emit("def construct(self):", indent=4)
    body = 8
    start_len = len(lines)

    for obj in doc.get("objects", []):
        ref = ("object", obj["id"])
        name = obj["name"]
        ctor = (obj.get("ctor") or "").strip()
        emit(f"{name} = {ctor}({_call_args(obj.get('args'))})", ref, body)
        chain = _join_chain(obj.get("chain", ""))
        if chain:
            emit(f"{name}{chain}", ref, body)
        pos = obj.get("pos")
        if pos is not None:
            emit(f"{name}.move_to(np.array([{_num(pos[0])}, {_num(pos[1])}, 0.0]))", ref, body)
        if preview:
            emit(f"self._me_reg({name!r}, {name}, {obj['id']!r})", ref, body)

    for step in doc.get("steps", []):
        if step.get("disabled"):
            continue
        ref = ("step", step["id"])
        if preview:
            emit(f"self._me_step({step['id']!r})", ref, body)
        kind = step.get("kind")
        if kind == "play":
            if any((a.get("cls") or "").strip() for a in step.get("anims", [])):
                emit(play_expr(step), ref, body)
        elif kind == "wait":
            emit(f"self.wait({str(step.get('duration', '')).strip()})", ref, body)
        elif kind in ("add", "remove"):
            targets = ", ".join(t for t in step.get("targets", []) if t)
            if targets:
                emit(f"self.{kind}({targets})", ref, body)
        elif kind == "code":
            code = (step.get("code") or "").rstrip()
            if code.strip():
                emit(_dedent(code), ref, body)
        if preview:
            emit(f"self._me_step_end({step['id']!r})", ref, body)

    if len(lines) == start_len:
        emit("pass", None, body)
    return Generated("\n".join(lines) + "\n", linemap)


def _num(v: float) -> str:
    return repr(round(float(v), 4))


def _dedent(code: str) -> str:
    import textwrap
    return textwrap.dedent(code)
