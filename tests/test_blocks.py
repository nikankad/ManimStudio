"""Blocks on the timeline (for, while, if, with, try): how the editor lays out their runs, and edits that keep them
balanced. The edits are frontend/src/timeline.ts, run by node (frontend/scripts/timeline_ops.mjs)."""

import ast
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from mathengine import codegen, runtime
from mathengine.importer import import_code

OPS = Path(__file__).parent.parent / "frontend" / "scripts" / "timeline_ops.mjs"
pytestmark = pytest.mark.skipif(not shutil.which("node") or not (OPS.parent.parent / "node_modules" / "vite").exists(),
                                reason="needs node and the frontend's node_modules")

LOOP = '''from manim import *


class L(Scene):
    def construct(self):
        title = Text("Dots")
        self.play(Write(title))
        dots = VGroup(*[Dot(RIGHT * k) for k in range(-2, 3)])
        for i, d in enumerate(dots):
            self.play(FadeIn(d), run_time=0.5)
            if i % 2 == 0:
                self.play(d.animate.set_color(RED), run_time=0.5)
            else:
                self.wait(0.25)
        self.play(FadeOut(title))
'''


def ops(doc: dict, measured: dict | None, *cases: dict) -> list[dict]:
    res = subprocess.run(["node", str(OPS)], input=json.dumps({"doc": doc, "measured": measured, "cases": list(cases)}),
                         capture_output=True, text=True, timeout=120, cwd=OPS.parent.parent)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def code_of(doc: dict) -> str:
    src = codegen.generate(doc, latex=True).source
    ast.parse(src)
    return src[src.index("def construct"):]


@pytest.fixture(scope="module")
def loop():
    doc = import_code(LOOP).doc
    measured = runtime.run(doc, render=False).to_json()
    assert measured["error"] is None
    return doc, measured


def test_a_loop_is_laid_out_as_its_first_run_then_its_later_runs(loop):
    doc, measured = loop
    tl = doc["timeline"]
    lay = ops(doc, measured, {"op": "layout"})[0]["layout"]
    outer, inner = lay["blocks"]
    assert outer["id"] == tl[1]["id"] and outer["runs"] == 5 and not outer["estimated"]
    # 5 runs: 3 of 1 s (FadeIn + set_color), 2 of 0.75 s (FadeIn + wait)
    assert abs(outer["start"] - 1) < 1e-6 and abs(outer["end"] - outer["start"] - 4.5) < 1e-6
    assert abs(outer["body"] - outer["start"] - 1) < 1e-6  # the first run: FadeIn, then set_color
    assert [c["runs"] for c in inner["clauses"]] == [3, 2]
    fade = tl[2]["anims"][0]["id"]
    assert len(lay["anims"][fade]["iters"]) == 4  # its later runs
    assert [round(i["start"] - 1, 6) for i in lay["anims"][fade]["iters"]] == [1, 1.75, 2.75, 3.5]
    # the else's pause doesn't run in the first run: it takes no time there, its two runs are drawn later
    pause = next(s for s in tl if s["kind"] == "wait")
    sp = lay["steps"][pause["id"]]
    assert sp["elsewhere"] and sp["end"] == sp["start"] and len(sp["iters"]) == 2
    # FadeOut(title) comes after all the runs
    assert abs(lay["steps"][tl[-1]["id"]]["start"] - 5.5) < 1e-6
    # not measured yet: estimated from range() / literal lists
    est = ops({**doc, "timeline": [{**tl[1], "head": "for d in range(3)"}, *tl[2:]]}, None, {"op": "layout"})[0]["layout"]
    assert est["blocks"][0]["estimated"] and est["blocks"][0].get("runs") is None
    assert abs(est["blocks"][0]["end"] - est["blocks"][0]["start"] - 3 * (est["blocks"][0]["body"] - est["blocks"][0]["start"])) < 1e-6


def test_deleting_a_block_removes_its_steps_and_leaves_its_time(loop):
    doc, measured = loop
    tl = doc["timeline"]
    end = next(s for s in tl if s["kind"] == "end" and tl.index(s) == len(tl) - 2)
    lifted, rippled, by_end = ops(doc, measured, {"op": "remove", "ids": [tl[1]["id"]]}, {"op": "ripple", "ids": [tl[1]["id"]]},
                                  {"op": "ripple", "ids": [end["id"]]})
    assert [s["kind"] for s in lifted["doc"]["timeline"]] == ["play", "wait", "play"]
    assert abs(float(lifted["doc"]["timeline"][1]["args"]["duration"]) - 4.5) < 1e-6
    assert [s["kind"] for s in rippled["doc"]["timeline"]] == ["play", "play"] == [s["kind"] for s in by_end["doc"]["timeline"]]
    for r in (lifted, rippled):
        assert "for i" not in code_of(r["doc"])
    # objects made inside it are made before it now
    assert "dots = VGroup" in code_of(rippled["doc"])


def test_deleting_a_clause_takes_its_body_and_keeps_the_rest(loop):
    doc, measured = loop
    tl = doc["timeline"]
    else_ = next(s for s in tl if s.get("head") == "else")
    out = ops(doc, measured, {"op": "ripple", "ids": [else_["id"]]})[0]["doc"]
    code = code_of(out)
    assert "else" not in code and "self.wait(0.25)" not in code and "if i % 2 == 0:" in code


def test_moving_a_block_moves_it_whole(loop):
    doc, measured = loop
    tl = doc["timeline"]
    moved = ops(doc, measured, {"op": "move", "ids": [tl[1]["id"]], "t": 0})[0]["doc"]
    code = code_of(moved)
    assert code.index("for i, d") < code.index("Write(title)")
    assert code.index("FadeIn(d)") > code.index("for i, d") and code.index("self.play(FadeOut(title))") > code.index("self.wait(0.25)")
    # a step dragged out of it runs once, where it lands
    body = ops(doc, measured, {"op": "move", "ids": [tl[2]["id"]], "t": 9})[0]["doc"]
    code = code_of(body)
    assert code.index("self.play(FadeIn(d), run_time=0.5)") > code.index("self.play(FadeOut(title))")
