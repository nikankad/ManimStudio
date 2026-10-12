"""What is on screen before and after each step: the timeline's object view draws each object's clip from it."""

from mathengine import runtime
from mathengine.importer import import_code

CODE = '''
from manim import *


class Shown(Scene):
    def construct(self):
        a = Circle()
        b = Square()
        c = Triangle()
        d = Dot()
        g = VGroup(Dot(), Dot())
        self.play(FadeIn(a))
        self.play(a.animate.shift(RIGHT))
        self.play(ReplacementTransform(a, b))
        self.play(Transform(b, c))
        self.add(d)
        self.wait()
        self.play(FadeOut(b))
        self.play(LaggedStartMap(FadeIn, g))
'''


def test_each_step_reports_what_was_on_screen_before_and_after_it():
    doc = import_code(CODE).doc
    oid = {o["name"]: o["id"] for o in doc["objects"]}
    name = {v: k for k, v in oid.items()}
    res = runtime.run(doc, None, render=False)
    assert res.error is None, res.error
    by_step = {s.id: s for s in res.steps}
    seen = []
    for step in doc["timeline"]:
        t = by_step[step["id"]]
        seen.append((sorted(name[i] for i in t.shown_before), sorted(name[i] for i in t.shown_after)))
    assert seen == [
        ([], ["a"]),                # FadeIn(a): a appears
        (["a"], ["a"]),             # a.animate.shift: stays
        (["a"], ["b"]),             # ReplacementTransform(a, b): a goes, b comes
        (["b"], ["b"]),             # Transform(b, c): c is never on screen
        (["b"], ["b", "d"]),        # self.add(d)
        (["b", "d"], ["b", "d"]),   # wait
        (["b", "d"], ["d"]),        # FadeOut(b)
        (["d"], ["d", "g"]),        # LaggedStartMap(FadeIn, g) adds g's members, not g itself
    ], seen
    out = res.to_json()["steps"][0]
    assert out["before"] == [] and out["after"] == [oid["a"]]


def test_seeking_a_frame_does_not_pay_for_it():
    doc = import_code(CODE).doc
    res = runtime.run(doc, 1.5, render=False)
    assert all(s.shown_after is None for s in res.steps)
    assert all("after" not in s for s in res.to_json()["steps"])


LAYERS = '''
from manim import *


class Layers(Scene):
    def construct(self):
        a = Circle()
        b = Square()
        c = Dot()
        self.add(a, b)
        self.wait()
        self.add(a)
        self.wait()
'''


def test_frames_report_drawing_order():
    doc = import_code(LAYERS).doc
    order = lambda t: {o["name"]: o["layer"] for o in runtime.run(doc, t, render=False).objects}
    first, later = order(0.5), order(1.5)
    assert first["b"] > first["a"] and first["c"] is None, first  # added after: drawn on top; c isn't on screen
    assert later["a"] > later["b"], later  # added again: brought to the top
