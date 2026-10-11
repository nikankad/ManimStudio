"""Overlapping clips on the same object add up, in the preview and in exported scenes."""

import pytest

from conftest import doc, obj
from mathengine import codegen, runtime


def run(d, t):
    r = runtime.run(d, t, render=False)
    assert r.error is None, r.error and r.error["trace"]
    return {o["name"]: o for o in r.objects}


def anim(id, track, start, dur, cls="animate", chain=None, target="sq", **args):
    c = {"id": id, "kind": "anim", "track": track, "start": start, "duration": dur, "cls": cls, "target": target, "args": args}
    if chain:
        c["chain"] = chain
    return c


def scene(*clips, objects=None):
    d = doc(objects or [obj("o1", "sq", "Square", pos=[0, 0])])
    d["tracks"] = [{"id": "t1", "name": "V1"}, {"id": "t2", "name": "V2"}, {"id": "t3", "name": "V3"}]
    names = [o["name"] for o in d["objects"] if o["ctor"] != "ValueTracker"]
    d["clips"] = [{"id": "add", "kind": "add", "track": "t1", "start": 0, "duration": 0, "targets": names}, *clips]
    return d


MOVE = anim("move", "t1", 0, 2, chain=".shift(RIGHT * 2)", rate_func="linear")


def test_two_moves_add_up():
    d = scene(MOVE, anim("up", "t2", 1, 2, chain=".shift(UP * 2)", rate_func="linear"))
    assert run(d, 0.5)["sq"]["center"] == pytest.approx([0.5, 0])
    assert run(d, 1.5)["sq"]["center"] == pytest.approx([1.5, 0.5])
    assert run(d, 2.5)["sq"]["center"] == pytest.approx([2, 1.5])
    assert run(d, 5)["sq"]["center"] == pytest.approx([2, 2])


@pytest.mark.parametrize("second", [
    anim("color", "t2", 1, 1, chain=".set_color(RED)"),
    anim("rot", "t2", 0.5, 1, cls="Rotate", angle="PI / 2"),
    anim("ind", "t2", 0.5, 1, cls="Indicate"),
    anim("scale", "t2", 1, 0.5, chain=".scale(1)"),
])
def test_style_rotation_and_indication_keep_the_move(second):
    d = scene(MOVE, second)
    assert run(d, 1.5)["sq"]["center"] == pytest.approx([1.5, 0], abs=1e-6)
    o = run(d, 5)["sq"]
    assert o["center"] == pytest.approx([2, 0], abs=1e-6)
    assert o["box"] == pytest.approx([1, -1, 3, 1], abs=1e-6)  # same size (a square turned 90° has the same box)


def test_fade_out_while_moving():
    d = scene(MOVE, anim("out", "t2", 1, 1, cls="FadeOut"))
    o = run(d, 1.5)["sq"]
    assert o["visible"] and o["center"] == pytest.approx([1.5, 0])
    assert not run(d, 5)["sq"]["visible"]


def test_value_tracker_set_value_later_wins():
    d = scene(anim("a", "t1", 0, 2, chain=".set_value(5)", target="k", rate_func="linear"),
              anim("b", "t2", 1, 1, chain=".set_value(1)", target="k", rate_func="linear"),
              objects=[obj("ok", "k", "ValueTracker", args={"*": "0"}), obj("o1", "sq", "Square")])
    r = runtime.run(d, 5, render=False)
    assert r.error is None and r.values["k"] == pytest.approx(1)


def test_transform_into_another_shape_overlapping_a_move_still_runs():
    d = scene(MOVE, anim("tr", "t2", 1, 1, cls="Transform", target_mobject="Circle()"))
    run(d, 1.5)
    assert run(d, 5)["sq"]["visible"]


def test_overlap_in_an_exported_scene():
    """The same composition in a normal manim render (not the preview runtime)."""
    from manim import RED, tempconfig

    d = scene(MOVE, anim("up", "t2", 1, 2, chain=".shift(UP * 2)"), anim("color", "t3", 0.5, 1, chain=".set_color(RED)"))
    src = codegen.generate(d).source
    assert "TimedAnimations(" in src
    ns = {}
    with tempconfig({"dry_run": True, "disable_caching": True, "verbosity": "ERROR"}):
        exec(compile(src, "scene", "exec"), ns)
        sc = ns["MainScene"]()
        sc.render()
        sq = next(m for m in sc.mobjects if type(m).__name__ == "Square")
        assert sq.get_center()[:2] == pytest.approx([2, 2])
        assert sq.get_color().to_rgb() == pytest.approx(RED.to_rgb(), abs=1e-3)
        assert sq.width == pytest.approx(2)


def test_animating_before_the_intro_is_flagged():
    d = scene(anim("early", "t1", 0, 1, chain=".shift(RIGHT)"), anim("intro", "t2", 2, 1, cls="Create"),
              anim("later", "t1", 3, 1, cls="Indicate"))
    d["clips"] = d["clips"][1:]  # no Add clip: the Create at 2s is the square's intro
    gen = codegen.generate(d)
    by = {x["id"]: x for x in gen.diagnostics}
    assert set(by) == {"early"} and by["early"]["kind"] == "clip" and "appears at 2s (Create)" in by["early"]["message"]
    # An Add clip counts as the intro too, and an animation of an object with no intro at all is fine (it adds it).
    d["clips"] = [{"id": "add", "kind": "add", "track": "t3", "start": 0.5, "duration": 0, "targets": ["sq"]}, d["clips"][0]]
    assert [x["id"] for x in codegen.generate(d).diagnostics] == ["early"]
    d["clips"] = d["clips"][1:]
    assert codegen.generate(d).diagnostics == []
