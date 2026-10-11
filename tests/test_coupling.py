"""Relationships can be uncoupled (kept, paused) and coupled again, in the editor and over time."""

import pytest

from conftest import add_all, animate, doc, obj, play, switch, wait
from mathengine import codegen, runtime


def run(d, t):
    r = runtime.run(d, t, render=False)
    assert r.error is None, r.error and r.error["trace"]
    return r, {o["name"]: o for o in r.objects}


def shift(anim_id, target, chain, duration=1):
    """``self.play(target.animate(rate_func=linear).<chain>, run_time=duration)``."""
    return play(animate(anim_id, target, chain, rate_func="linear"), run_time=duration)


def points():
    return [obj("oA", "A", "Dot", pos=[-2, 0]), obj("oB", "B", "Dot", pos=[2, 0])]


def test_uncoupled_standalone_objects_are_ordinary():
    d = doc(points() + [
        obj("oM", "M", "Dot", pos=[1, 1], link={"kind": "midpoint", "a": "oA", "b": "oB", "off": True}),
        obj("oS", "seg", "Line", args={"start": "np.array([0, 2, 0])", "end": "np.array([1, 2, 0])"},
            link={"kind": "segment", "a": "oA", "b": "oB", "off": True}),
    ])
    d["timeline"] = [add_all(d), shift("c1", "A", ".shift(LEFT)")]
    gen = codegen.generate(d)
    assert "Constraints" not in gen.source
    _, o = run(d, 2)
    assert o["M"]["center"] == pytest.approx([1, 1])
    assert o["seg"]["geom"]["start"] == pytest.approx([0, 2])
    assert gen.diagnostics == []


def test_uncoupled_redraw_kinds_are_built_once():
    d = doc(points() + [obj("oC", "C", "Dot", pos=[0, 2]),
                        obj("oL1", "l1", "Line", link={"kind": "segment", "a": "oA", "b": "oC"}),
                        obj("oL2", "l2", "Line", link={"kind": "segment", "a": "oB", "b": "oC"}),
                        obj("oG", "ang", "Angle", link={"kind": "angle", "l1": "oL1", "l2": "oL2", "off": True})])
    gen = codegen.generate(d)
    assert "ang = Angle(l1, l2)" in gen.source


def test_uncouple_and_couple_steps_switch_over_time():
    # M is the midpoint of A and B. Uncoupled at 1s, it stays put while B moves and while it's moved itself;
    # coupled again at 3s, it snaps back to the midpoint.
    d = doc(points() + [obj("oM", "M", "Dot", link={"kind": "midpoint", "a": "oA", "b": "oB"})])
    d["timeline"] = [add_all(d), wait(1), switch("u", "uncouple", ["M"]), shift("c1", "B", ".shift(UP * 2)"),
                     shift("c2", "M", ".shift(DOWN)"), switch("k", "couple", ["M"]), wait(2, id="w2")]
    _, o = run(d, 0.5)
    assert o["M"]["center"] == pytest.approx([0, 0])
    _, o = run(d, 1.5)
    assert o["M"]["center"] == pytest.approx([0, 0])
    _, o = run(d, 2.5)
    assert o["M"]["center"] == pytest.approx([0, -0.5])
    _, o = run(d, 4)
    assert o["M"]["center"] == pytest.approx([0, 1])
    r, _ = run(d, 4)
    assert not [x for x in r.diagnostics if x["id"] == "c2"]  # moving it while uncoupled is fine


def test_couple_clip_with_duration_glides_into_place():
    d = doc(points() + [obj("oM", "M", "Dot", pos=[0, 2], link={"kind": "midpoint", "a": "oA", "b": "oB", "off": True})])
    d["timeline"] = [add_all(d), wait(1), switch("k", "couple", ["M"], duration=2), wait(1, id="w2")]
    gen = codegen.generate(d)
    assert "constraints.follow(M, " in gen.source and "paused=True" in gen.source
    _, o = run(d, 0.5)
    assert o["M"]["center"] == pytest.approx([0, 2])
    _, o = run(d, 2)
    assert 0.1 < o["M"]["center"][1] < 1.9
    _, o = run(d, 3.5)
    assert o["M"]["center"] == pytest.approx([0, 0])


def test_uncoupled_segment_couples_again_over_time():
    d = doc(points() + [obj("oS", "seg", "Line", args={"start": "np.array([0, 2, 0])", "end": "np.array([1, 2, 0])"},
                            link={"kind": "segment", "a": "oA", "b": "oB", "off": True})])
    d["timeline"] = [add_all(d), wait(1), switch("k", "couple", ["seg"]), wait(1, id="w2")]
    _, o = run(d, 0.5)
    assert o["seg"]["geom"]["start"] == pytest.approx([0, 2])
    _, o = run(d, 1.5)
    assert o["seg"]["geom"]["start"] == pytest.approx([-2, 0])
    assert o["seg"]["geom"]["end"] == pytest.approx([2, 0])


def test_conflict_warning_only_while_coupled_and_switch_step_diagnostics():
    d = doc(points() + [obj("oM", "M", "Dot", link={"kind": "midpoint", "a": "oA", "b": "oB"}), obj("oP", "P", "Dot")])
    d["timeline"] = [add_all(d), shift("c1", "M", ".shift(UP)"), switch("u", "uncouple", ["M", "P"]),
                     shift("c2", "M", ".shift(UP)")]
    diags = {x["id"]: x for x in codegen.generate(d).diagnostics}
    assert "c1" in diags and "c2" not in diags
    assert "P has no relationship" in diags["u"]["message"]
