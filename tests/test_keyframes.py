"""Keyframes: the values an animation takes its object from and to (what the keyframe editor shows), and keyframe
edits made in the editor (frontend/src/keyframes.ts) written as plain manim code that reads back the same."""

from mathengine import runtime
from mathengine.importer import import_code

SCENE = '''from manim import *


class K(Scene):
    def construct(self):
        c = Square(color=BLUE)
        t = ValueTracker(1)
        self.play(Create(c))
        self.play(c.animate.shift(RIGHT * 2).set_color(YELLOW), t.animate.set_value(3))
        self.play(c.animate.set_opacity(0.5).scale(2), run_time=0.5)
'''


def test_animations_report_their_object_before_and_after():
    doc = import_code(SCENE).doc
    res = runtime.run(doc, None, False).to_json()
    by = {a["id"]: a for a in res["anims"]}
    plays = [s for s in doc["timeline"] if s["kind"] == "play"]
    move, value = (by[a["id"]] for a in plays[1]["anims"])
    assert move["from"]["center"] == [0, 0] and move["to"]["center"] == [2, 0]
    assert move["from"]["color"] == "#58C4DD" and move["to"]["color"] == "#F7D96F"
    assert value["from"] == {"value": 1} and value["to"] == {"value": 3}
    grow = by[plays[2]["anims"][0]["id"]]
    assert grow["from"]["width"] == 2 and grow["to"]["width"] == 4 and grow["to"]["opacity"] == 0.5
    # seeking (a frame at a time) doesn't measure them
    assert all("to" not in a for a in runtime.run(doc, 1.5, False).to_json()["anims"])


# ---------------------------------------------------------------------------- keyframe edits (keyframes.ts)

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from mathengine import codegen

OPS = Path(__file__).parent.parent / "frontend" / "scripts" / "keyframe_ops.mjs"
needs_node = pytest.mark.skipif(not shutil.which("node") or not (OPS.parent.parent / "node_modules" / "vite").exists(),
                                reason="needs node and the frontend's node_modules")

EDIT = '''from manim import *
import numpy as np


class K(Scene):
    def construct(self):
        c = Square(color=BLUE)
        t = ValueTracker(1)
        self.play(Create(c))
        self.play(c.animate.shift(RIGHT * 2).set_color(YELLOW), t.animate.set_value(3))
        self.wait(2)
        self.play(c.animate.move_to(np.array([1, -1, 0])).scale(2), run_time=0.5)
        self.play(Rotate(c, PI / 2))
        self.play(t.animate.increment_value(2))
'''


def edit(doc: dict, measured: dict | None, *cases: dict) -> list[dict]:
    res = subprocess.run(["node", str(OPS)], input=json.dumps({"doc": doc, "measured": measured, "cases": list(cases)}),
                         capture_output=True, text=True, timeout=120, cwd=OPS.parent.parent)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def roundtrip(doc: dict) -> str:
    """The edited document's code reads back as the same document."""
    src = codegen.generate(doc, latex=True).source
    assert json.dumps(import_code(src, base=doc).doc, sort_keys=True) == json.dumps(doc, sort_keys=True)
    return src


def measure(doc: dict) -> dict:
    return runtime.run(doc, None, False).to_json()


def anim_state(res: dict, aid: str) -> dict:
    return next(a for a in res["anims"] if a["id"] == aid)["to"]


@needs_node
def test_keyframe_edits_write_plain_manim_that_reads_back_the_same():
    doc = import_code(EDIT).doc
    measured = measure(doc)
    src0 = codegen.generate(doc, latex=True).source
    out = edit(doc, measured,
               {"op": "set", "name": "c", "channel": "position", "index": 0, "value": [2, 1]},  # the shift
               {"op": "set", "name": "c", "channel": "position", "index": 1, "value": [-1, 0.5]},  # the move_to
               {"op": "set", "name": "c", "channel": "scale", "index": 0, "value": 3},
               {"op": "set", "name": "c", "channel": "rotation", "index": 0, "value": 45},
               {"op": "set", "name": "c", "channel": "color", "index": 0, "value": "GREEN"},
               {"op": "set", "name": "t", "channel": "value", "index": 0, "value": 5},
               {"op": "set", "name": "t", "channel": "value", "index": 1, "value": 4},  # increment_value from 3
               {"op": "set", "name": "c", "channel": "position", "index": 0, "value": [2, 0]},  # its own value: no change
               )
    shift, move, scale, rot, color, value, inc, same = out
    for r in out:
        assert r["error"] is None, r["error"]
    # the keyframes as read from the code and the measurement
    assert [k["value"] for k in shift["keys"]] == [[2, 0], [1, -1]]
    assert [k["method"] for k in shift["keys"]] == ["shift", "move_to"]
    lines = {name: roundtrip(r["doc"]) for name, r in zip(("shift", "move", "scale", "rot", "color", "value", "inc"), out)}
    assert "c.animate.shift(RIGHT * 2 + UP).set_color(YELLOW)" in lines["shift"], "only the shift's argument changed, in its style"
    assert "c.animate.move_to(np.array([-1, 0.5, 0])).scale(2)" in lines["move"]
    assert ".scale(3)" in lines["scale"]  # its size goes from 1 to 3
    assert "Rotate(c, PI / 4)" in lines["rot"]
    assert ".set_color(GREEN)" in lines["color"]
    assert "t.animate.set_value(5)" in lines["value"]
    assert "t.animate.increment_value(1)" in lines["inc"]
    assert codegen.generate(same["doc"], latex=True).source == src0, "setting a keyframe to its value changes nothing"
    # and manim agrees
    plays = [s for s in doc["timeline"] if s["kind"] == "play"]
    m = measure(shift["doc"])
    assert anim_state(m, plays[1]["anims"][0]["id"])["center"] == [2, 1]
    m = measure(move["doc"])
    assert anim_state(m, plays[2]["anims"][0]["id"])["center"] == [-1, 0.5]
    m = measure(inc["doc"])
    assert anim_state(m, plays[4]["anims"][0]["id"]) == {"value": 4}


@needs_node
def test_adding_and_removing_keyframes():
    doc = import_code(EDIT).doc
    measured = measure(doc)
    out = edit(doc, measured,
               {"op": "add", "name": "c", "channel": "opacity", "t": 3.0, "value": 0.25},  # in the pause (2 to 4 s)
               {"op": "add", "name": "t", "channel": "value", "t": 4.25, "value": 7},  # inside a Play together (4 to 4.5 s)
               {"op": "add", "name": "t", "channel": "value", "t": 8.0, "value": 10},  # after the end (6.5 s)
               {"op": "add", "name": "c", "channel": "rotation", "t": 3.5, "value": 180},
               {"op": "delete", "name": "c", "channel": "color", "index": 0},  # one call of a chain
               {"op": "delete", "name": "t", "channel": "value", "index": 1},  # a whole clip: its time stays
               {"op": "add", "name": "c", "channel": "opacity", "t": 0, "value": 0.5},
               {"op": "add", "name": "c", "channel": "position", "t": 1.5, "value": [0, 2]},  # c is animated there already
               )
    pause, joined, after, rotate, uncolor, unvalue, at0, busy = out
    for r in out[:-2]:
        assert r["error"] is None, r["error"]
    assert at0["error"] and "already animated" in busy["error"]
    src = roundtrip(pause["doc"])
    assert "t.animate.set_value(3))\n        self.play(c.animate.set_opacity(0.25))\n        self.wait(1)\n" in src, src
    src = roundtrip(joined["doc"])
    assert "c.animate(run_time=0.5).move_to(np.array([1, -1, 0])).scale(2),\n            t.animate(run_time=0.25).set_value(7),\n        )" in src, src
    src = roundtrip(after["doc"])
    assert src.rstrip().endswith("self.play(t.animate.increment_value(2))\n        self.wait(0.5)\n        self.play(t.animate.set_value(10))"), src
    src = roundtrip(rotate["doc"])
    assert "Rotate(c, angle=180 * DEGREES)" in src, src
    src = roundtrip(uncolor["doc"])
    assert "c.animate.shift(RIGHT * 2), t.animate.set_value(3)" in src
    src = roundtrip(unvalue["doc"])
    assert "increment_value" not in src and src.rstrip().endswith("self.wait(1)"), src
    # manim agrees with where the new keyframes are
    m = measure(pause["doc"])
    new = next(a for a in m["anims"] if a["id"] == pause["id"])
    assert (new["start"], new["end"], new["to"]["opacity"]) == (2.0, 3.0, 0.25)
    m = measure(joined["doc"])
    new = next(a for a in m["anims"] if a["id"] == joined["id"])
    assert (new["start"], new["end"], new["to"]) == (4.0, 4.25, {"value": 7})
    m = measure(after["doc"])
    new = next(a for a in m["anims"] if a["id"] == after["id"])
    assert (new["start"], new["end"], new["to"]) == (7.0, 8.0, {"value": 10})


@needs_node
def test_expressions_stay_as_written_and_values_as_created():
    src = '''from manim import *


class K(Scene):
    def construct(self):
        a = Dot()
        b = Square(color=BLUE).shift(LEFT)
        self.play(FadeIn(b))
        self.play(b.animate.move_to(a.get_center()).set_opacity(0.5))
        self.play(b.animate.next_to(a, UP))
'''
    doc = import_code(src).doc
    measured = measure(doc)
    expr, nxt, base_color, base_pos = edit(doc, measured,
        {"op": "set", "name": "b", "channel": "position", "index": 0, "value": [3, 3]},
        {"op": "set", "name": "b", "channel": "position", "index": 1, "value": [3, 3]},
        {"op": "base", "name": "b", "channel": "color", "value": "RED"},
        {"op": "base", "name": "b", "channel": "position", "value": [-2, 1]})
    assert "expression (a.get_center())" in expr["error"] and expr["doc"] == doc
    assert "next_to" in nxt["error"] and nxt["doc"] == doc
    # measured where it is, though not editable
    assert expr["keys"][0]["value"] == [0, 0] and expr["keys"][1]["value"][0] == 0
    assert "b = Square(color=RED)" in roundtrip(base_color["doc"])
    assert roundtrip(base_pos["doc"]).count("b.move_to(np.array([-2, 1, 0]))") == 1


CHANGES = '''from manim import *


class K(Scene):
    def construct(self):
        c = Square(color=BLUE)
        label = Text("hi")
        self.play(Create(c))
        label.next_to(c, UP)
        c.set_color(RED).shift(LEFT)
        self.play(FadeIn(label))
'''


@needs_node
def test_methods_called_later_are_keyframes_that_jump():
    doc = import_code(CHANGES).doc
    applies = [s for s in doc["timeline"] if s["kind"] == "apply"]
    assert [(s["target"], s["chain"]) for s in applies] == [("label", ".next_to(c, UP)"), ("c", ".set_color(RED).shift(LEFT)")]
    measured = runtime.run(doc, None, False).to_json()
    by = {s["id"]: s for s in measured["steps"]}
    assert by[applies[1]["id"]]["from"]["center"] == [0, 0] and by[applies[1]["id"]]["to"]["center"] == [-1, 0]
    color, move = edit(doc, measured, {"op": "set", "name": "c", "channel": "color", "index": 0, "value": "GREEN"},
                       {"op": "set", "name": "c", "channel": "position", "index": 0, "value": [-2, 1]})
    k = color["keys"][0]
    assert k["anim"] == applies[1]["id"] and k["start"] == k["t"] and k["editable"]  # a jump: no time before it
    assert "c.set_color(GREEN).shift(LEFT)" in roundtrip(color["doc"])
    assert "c.set_color(RED).shift(LEFT * 2 + UP)" in roundtrip(move["doc"])
    gone = edit(doc, measured, {"op": "delete", "name": "c", "channel": "color", "index": 0})[0]
    assert "        c.shift(LEFT)\n" in roundtrip(gone["doc"])


@needs_node
def test_expressions_and_relative_keyframes_are_edited_by_their_arguments():
    src = '''from manim import *


class K(Scene):
    def construct(self):
        a = Dot()
        b = Square(color=BLUE).shift(LEFT)
        self.play(FadeIn(b))
        self.play(b.animate.move_to(a.get_center()).set_opacity(0.5))
        self.play(b.animate.next_to(a, UP))
        self.play(Rotate(b, angle=a.get_x() + PI))
        b.to_edge(LEFT, buff=1)
'''
    doc = import_code(src).doc
    measured = measure(doc)
    expr, nxt, rot, bad, pin, pin_jump = edit(doc, measured,
        {"op": "args", "name": "b", "channel": "position", "index": 0, "value": "a.get_center() + UP"},
        {"op": "args", "name": "b", "channel": "position", "index": 1, "value": "a, DOWN, buff=0.5"},
        {"op": "args", "name": "b", "channel": "rotation", "index": 0, "value": "PI / 3"},
        {"op": "args", "name": "b", "channel": "position", "index": 1, "value": "a, DOWN)"},
        {"op": "pin", "name": "b", "channel": "position", "index": 1},
        {"op": "pin", "name": "b", "channel": "position", "index": 2})
    keys = expr["keys"]
    assert [k["args"] for k in keys] == ["a.get_center()", "a, UP", "LEFT, buff=1"]
    assert not keys[1]["editable"] and keys[1]["relative"] and not keys[0].get("relative")
    assert "b.animate.move_to(a.get_center() + UP).set_opacity(0.5)" in roundtrip(expr["doc"])
    assert "b.animate.next_to(a, DOWN, buff=0.5)" in roundtrip(nxt["doc"])
    assert "Rotate(b, angle=PI / 3)" in roundtrip(rot["doc"])
    assert "brackets" in bad["error"] and bad["doc"] == doc
    # pinned: where next_to put it (measured), as a plain point
    assert keys[1]["value"] == [0, 1.33]
    assert "self.play(b.animate.move_to(UP * 1.33))" in roundtrip(pin["doc"])
    assert "        b.move_to(LEFT * 5.111 + UP * 1.33)\n" in roundtrip(pin_jump["doc"])  # the to_edge step, pinned
