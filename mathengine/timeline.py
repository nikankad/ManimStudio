"""The timeline: the statements of ``construct()`` after the objects are built, in order.

Every step is exactly one manim statement, so the editor shows what the code does and the code is
what the editor shows:

* ``play``: ``self.play(*anims, **args)``. Each animation is a manim Animation class applied to a
  target (``Create(circle, run_time=2)``), ``target.animate(**args).method(...)``, or a composition
  (``AnimationGroup``, ``LaggedStart``, ``Succession``…) whose ``anims`` are its child animations.
  ``args`` are ``self.play`` keyword arguments: manim sets them on every animation of the call.
* ``wait``: ``self.wait(**args)``.
* ``add`` / ``remove``: ``self.add(*targets)`` / ``self.remove(*targets)``.
* ``call``: another method of the scene, ``self.<method>(**args)``: ``self.next_section(...)``,
  ``self.add_sound(...)``, ``self.bring_to_front(...)``, ``ThreeDScene.move_camera(...)``…
* ``apply``: methods called on something, ``target.next_to(u, UP).set_color(RED)``: at once, like a jump.
* ``assign``: a value given a name or a place, ``k = 2``, ``x += 1``, ``obj.color = RED``.
* ``code``: any other Python statement, run in place.
* ``block`` / ``end``: a compound statement around the steps between them: ``head`` is its header without the
  colon (``for d in dots``, ``if k > 2``, ``with self.voiceover(...) as t``, ``try``). A block whose head starts
  with ``elif``, ``else``, ``except`` or ``finally`` is the next clause of the open one. The steps in between are
  its body, run as many times as the code runs it; manim's measurement says when each run happens.
* ``couple`` / ``uncouple``: switch constructions (see construct.py) on or off.

Timing is manim's: a step starts when the one before it ends, a ``self.play`` lasts as long as its
longest animation, and animations inside compositions start when manim starts them (lag_ratio). The
editor reads the measured times back from manim (runtime.py) instead of computing its own.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterator

EPS = 1e-6
INSTANT = ("add", "remove", "uncouple", "apply", "assign", "block", "end")
CLAUSE = re.compile(r"\s*(elif|else|except|finally)\b")


def is_clause(step: dict) -> bool:
    """A block step that continues the open compound statement (``elif …``, ``else``, ``except …``, ``finally``)."""
    return step.get("kind") == "block" and bool(CLAUSE.match(step.get("head") or ""))


def compounds(steps_: list[dict]) -> dict[str, tuple[list[str], str | None]]:
    """For each block step opening a compound statement: its clauses' ids and its end's id (None: not closed)."""
    out: dict[str, tuple[list[str], str | None]] = {}
    stack: list[str] = []
    for s in steps_:
        kind = s.get("kind")
        if kind == "block" and not is_clause(s):
            stack.append(s["id"])
            out[s["id"]] = ([], None)
        elif kind == "block" and stack:
            out[stack[-1]][0].append(s["id"])
        elif kind == "end" and stack:
            opener = stack.pop()
            out[opener] = (out[opener][0], s["id"])
    return out


def _id(prefix: str) -> str:
    return prefix + uuid.uuid4().hex[:7]


def walk(anims: list[dict], include_disabled: bool = False) -> Iterator[dict]:
    """Animations and, depth first, the animations inside compositions."""
    for a in anims or []:
        if a.get("disabled") and not include_disabled:
            continue
        yield a
        yield from walk(a.get("anims") or [], include_disabled)


def steps(doc: dict, include_disabled: bool = False) -> list[dict]:
    return [s for s in doc.get("timeline") or [] if include_disabled or not s.get("disabled")]


def all_anims(doc: dict, include_disabled: bool = False) -> Iterator[tuple[dict, dict]]:
    """(step, animation) for every animation of every play step."""
    for s in steps(doc, include_disabled):
        if s.get("kind") == "play":
            for a in walk(s.get("anims") or [], include_disabled):
                yield s, a


def targets_of(anim: dict) -> list[str]:
    """Object names an animation (and the animations inside it) acts on."""
    out = []
    for a in walk([anim]):
        t = (a.get("target") or "").strip()
        if t:
            out.extend(x.strip() for x in t.split(",") if x.strip())
    return out


# ----------------------------------------------------------------------------- building statements (samples, starters, tests)

def anim(cls: str, target: str = "", **args) -> dict:
    """An animation: ``cls(target, **args)``."""
    return {"cls": cls, "target": target, "args": {k: str(v) for k, v in args.items()}}


def animate(target: str, chain: str, **args) -> dict:
    """``target.animate(**args)`` followed by ``chain``."""
    return {**anim("animate", target, **args), "chain": chain}


def group(cls: str, *anims: dict, **args) -> dict:
    """A composition (AnimationGroup, LaggedStart, Succession…) of ``anims``."""
    return {**anim(cls, "", **args), "anims": list(anims)}


def play(*anims: dict, **args) -> dict:
    """``self.play(*anims, **args)``."""
    return {"kind": "play", "anims": list(anims), "args": {k: str(v) for k, v in args.items()}}


def wait(duration: float | None = None) -> dict:
    """``self.wait(duration)``."""
    return {"kind": "wait", "args": {"duration": str(duration)} if duration is not None else {}}


def add(*targets: str) -> dict:
    return {"kind": "add", "targets": list(targets)}


def remove(*targets: str) -> dict:
    return {"kind": "remove", "targets": list(targets)}


def call(method: str, **args) -> dict:
    """``self.<method>(**args)``: a scene method other than play / wait / add / remove."""
    return {"kind": "call", "method": method, "args": {k: str(v) for k, v in args.items()}}


def switch(kind: str, *targets: str, duration: float | None = None) -> dict:
    """``couple`` / ``uncouple`` constructions (a couple with a duration glides them back into place)."""
    return {"kind": kind, "targets": list(targets), **({"duration": duration} if duration else {})}


def number(steps_: list[dict]) -> list[dict]:
    """Give statements ids s1, s2… and animations a1, a2… (in place); returns ``steps_``."""
    count = {"s": 0, "a": 0}

    def ident(prefix: str) -> str:
        count[prefix] += 1
        return f"{prefix}{count[prefix]}"

    def tag(anims: list[dict]) -> None:
        for a in anims:
            a["id"] = ident("a")
            tag(a.get("anims") or [])

    for step in steps_:
        step["id"] = ident("s")
        tag(step.get("anims") or [])
    return steps_


# ----------------------------------------------------------------------------- upgrade from format 3

def _end(c: dict) -> float:
    return float(c["start"]) + float(c.get("duration") or 0)


def _groups(clips: list[dict]) -> list[list[dict]]:
    """Clips whose time ranges overlap, transitively."""
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


def _split_at_instants(group: list[dict]) -> list[list[dict]]:
    """Cut a group where an instant clip (add, remove…) happens while nothing spans that moment.

    Then the instant clip becomes its own statement (``self.add``) between two ``self.play`` calls,
    exactly as a manim author would write it.
    """
    spans = [c for c in group if not _instant(c)]
    cuts = sorted({float(c["start"]) for c in group if _instant(c)
                   if not any(float(s["start"]) < float(c["start"]) - EPS and _end(s) > float(c["start"]) + EPS for s in spans)})
    if not cuts:
        return [group]
    out, rest = [], sorted(group, key=lambda c: (float(c["start"]), not _instant(c)))
    for t in cuts:
        before = [c for c in rest if float(c["start"]) < t - EPS or (abs(float(c["start"]) - t) < EPS and _instant(c))]
        if before:
            out.append(before)
        rest = [c for c in rest if c not in before]
    if rest:
        out.append(rest)
    return [g for part in out for g in _groups(part)] if len(out) > 1 else out


def _instant(c: dict) -> bool:
    return c.get("kind") in INSTANT or (c.get("kind") == "couple" and float(c.get("duration") or 0) <= EPS)


def _num(v: float) -> str:
    v = round(float(v), 4)
    return repr(int(v)) if v == int(v) else repr(v)


def _anim(c: dict, run_time: float | None) -> dict:
    a = {"id": c["id"], "cls": (c.get("cls") or "").strip(), "target": c.get("target") or "",
         "args": {k: v for k, v in (c.get("args") or {}).items() if k != "run_time"}}
    if c.get("chain"):
        a["chain"] = c["chain"]
    if c.get("terms"):
        a["terms"] = c["terms"]
    if run_time is not None and not _computes_run_time(a["cls"]):
        a["args"]["run_time"] = _num(run_time)
    return a


def _computes_run_time(cls: str) -> bool:
    try:
        from .catalog import sets_run_time
    except Exception:
        return False
    return cls.isidentifier() and sets_run_time(cls)


def _instant_step(c: dict) -> dict:
    step = {"id": c["id"], "kind": c["kind"], "targets": list(c.get("targets") or [])}
    if c.get("kind") == "couple" and float(c.get("duration") or 0) > EPS:
        step["duration"] = float(c["duration"])
    return step


def _wait(duration: float) -> dict:
    return {"id": _id("s"), "kind": "wait", "args": {"duration": _num(duration)}}


def _simple(group: list[dict]) -> bool:
    actions = [c for c in group if c.get("kind") != "hold"]
    if not actions:
        return True
    if any(c.get("kind") == "couple" and float(c.get("duration") or 0) > EPS for c in actions):
        return False
    start = float(group[0]["start"])
    if any(abs(float(c["start"]) - start) > EPS for c in actions):
        return False
    anims = [c for c in actions if c.get("kind") == "anim"]
    if anims and len(anims) != len(actions):
        return False
    targets = [c.get("target") for c in anims]
    return len(targets) == len(set(targets))


def _group_steps(group: list[dict]) -> list[dict]:
    """Statements for clips that overlap in time (format 3), in manim's own terms."""
    start = float(min(c["start"] for c in group))
    actions = [c for c in group if c.get("kind") != "hold"]
    if not actions:
        return []
    if _simple(group):
        anims = [c for c in actions if c.get("kind") == "anim"]
        if not anims:
            return [_instant_step(c) for c in actions]
        durs = {round(float(c["duration"]), 4) for c in anims}
        shared = durs.pop() if len(durs) == 1 else None
        step = {"id": _id("s"), "kind": "play", "anims": [_anim(c, None if shared is not None else float(c["duration"])) for c in anims],
                "args": {"run_time": _num(shared)} if shared is not None else {}}
        return [step]
    # Staggered clips: one self.play where a clip that starts later waits first, the way manim's docs
    # place things mid-animation: Succession(Wait(run_time=0.5), Create(axes)).
    anims, after = [], []
    for c in sorted(actions, key=lambda c: float(c["start"])):
        offset = float(c["start"]) - start
        if c.get("kind") == "anim":
            a = _anim(c, float(c["duration"]))
        elif c.get("kind") == "add":
            a = {"id": c["id"], "cls": "Add", "target": ", ".join(c.get("targets") or []), "args": {}}
        else:
            after.append(c)  # no animation does this mid-play: it runs right after the play
            continue
        if offset > EPS:
            a = {"id": _id("a"), "cls": "Succession", "target": "", "args": {},
                 "anims": [{"id": _id("a"), "cls": "Wait", "target": "", "args": {"run_time": _num(offset)}}, a]}
        anims.append(a)
    out = [{"id": _id("s"), "kind": "play", "anims": anims, "args": {}}] if anims else []
    return out + [_instant_step(c) for c in after]


def from_clips(clips: list[dict], tracks: list[dict]) -> list[dict]:
    """Format 3 (clips at times on tracks) to the statement list that plays the same way.

    The old editor compiled exactly this grouping (overlapping clips into one play); disabled clips
    (and clips on hidden tracks) become disabled statements at their place.
    """
    hidden = {t["id"] for t in tracks or [] if t.get("hidden")}
    usable = [c for c in clips or [] if not (c.get("kind") == "anim" and not (c.get("cls") or "").strip())]
    off = [c for c in usable if c.get("disabled") or c.get("track") in hidden]
    active = [c for c in usable if c not in off]
    code = sorted((c for c in active if c.get("kind") == "code"), key=lambda c: float(c["start"]))
    # Holds only kept the scene running (self.wait); gaps between clips are waits anyway, so a hold matters
    # where it runs past everything else.
    holds = [c for c in active if c.get("kind") == "hold"]
    groups = [g for grp in _groups([c for c in active if c.get("kind") not in ("code", "hold")]) for g in _split_at_instants(grp)]
    out: list[tuple[float, dict]] = []  # (start time, step)
    cursor = 0.0

    def wait_until(t: float) -> None:
        nonlocal cursor
        if t - cursor > EPS:
            out.append((cursor, _wait(t - cursor)))
        cursor = max(cursor, t)

    gi = 0
    for c in code + [None]:
        limit = float(c["start"]) if c else float("inf")
        while gi < len(groups) and float(min(x["start"] for x in groups[gi])) < limit - EPS:
            g = groups[gi]
            gi += 1
            start = float(min(x["start"] for x in g))
            wait_until(start)
            for s in _group_steps(g):
                out.append((start, s))
            cursor = max(cursor, max(_end(x) for x in g))
        if c is None:
            wait_until(max((_end(h) for h in holds), default=0.0))
            break
        wait_until(float(c["start"]))
        step = {"id": c["id"], "kind": "code", "code": c.get("code") or ""}
        if c.get("label"):
            step["label"] = c["label"]
        out.append((float(c["start"]), step))
    for c in sorted(off, key=lambda c: float(c["start"])):
        if c.get("kind") == "anim":
            step = {"id": _id("s"), "kind": "play", "anims": [_anim(c, float(c["duration"]))], "args": {}}
        elif c.get("kind") == "hold":
            step = _wait(float(c.get("duration") or 1))
        elif c.get("kind") == "code":
            step = {"id": c["id"], "kind": "code", "code": c.get("code") or ""}
        else:
            step = _instant_step(c)
        step["disabled"] = True
        i = next((k for k, (t, _) in enumerate(out) if t > float(c["start"]) + EPS), len(out))
        out.insert(i, (float(c["start"]), step))
    return [s for _, s in out]
