"""The timeline is construct()'s statements: each step is exactly one manim statement, timed by manim."""

import pytest

from conftest import add_all, anim, animate, doc, group, obj, play, switch, wait
from mathengine import codegen, runtime
from mathengine.project import upgrade


def body(d):
    """The statements of construct() after the objects are built."""
    src = codegen.generate(d, latex=False).source
    lines = src[src.index("def construct(self):"):].splitlines()[1:]
    return [ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith(("sq =", "sq.", "c =", "c.", "k =", "t ="))]


def run(d, t=None):
    r = runtime.run(d, t, render=False)
    assert r.error is None, r.error and r.error["trace"]
    return r


def scene(*steps, objects=None):
    return doc(objects or [obj("o1", "sq", "Square", pos=[0, 0]), obj("o2", "c", "Circle", pos=[2, 0])], steps)


def test_each_step_is_one_statement():
    d = scene(
        play(anim("a1", "Create", "sq")),
        play(anim("a2", "FadeIn", "c", shift="UP"), animate("a3", "sq", ".shift(RIGHT).set_color(RED)", rate_func="linear"), run_time=2),
        wait(0.5),
        {"id": "x", "kind": "remove", "targets": ["c"]},
        play(group("g", "LaggedStart", anim("a4", "Rotate", "sq", angle="PI"), anim("a5", "Indicate", "sq"), lag_ratio=0.5)),
        {"id": "k", "kind": "code", "code": "self.wait(0.25)"},
        wait(),
    )
    assert body(d) == [
        "self.play(Create(sq))",
        "self.play(FadeIn(c, shift=UP), sq.animate(rate_func=linear).shift(RIGHT).set_color(RED), run_time=2)",
        "self.wait(0.5)",
        "self.remove(c)",
        "self.play(LaggedStart(Rotate(sq, angle=PI), Indicate(sq), lag_ratio=0.5))",
        "self.wait(0.25)",
        "self.wait()",
    ]
    assert "TimedAnimations" not in codegen.generate(d).source


def test_disabled_steps_and_animations_are_left_out():
    d = scene(play(anim("a1", "Create", "sq"), {**anim("a2", "Create", "c"), "disabled": True}), {**wait(2), "disabled": True})
    assert body(d) == ["self.play(Create(sq))"]


def test_timings_are_manims():
    d = scene(
        add_all(scene()),
        play(anim("w", "Write", "t")),  # Write picks its own run_time from the text's length
        play(anim("a", "Create", "sq", run_time=2), anim("b", "FadeIn", "c")),  # the play lasts as long as its longest animation
        play(group("g", "LaggedStart", anim("l1", "Indicate", "sq"), anim("l2", "Indicate", "c"), anim("l3", "Indicate", "sq"),
                   lag_ratio=0.5)),
        play(group("s", "Succession", anim("s1", "Indicate", "sq"), anim("s2", "Indicate", "c")), run_time=3),
        wait(0.5, id="end"),
        objects=[obj("o1", "sq", "Square"), obj("o2", "c", "Circle"), obj("o3", "t", "Text", args={"*": '"a fairly long title here"'})],
    )
    r = run(d)
    steps = {s.id: (round(s.start, 4), round(s.end, 4)) for s in r.steps}
    anims = {a.id: (round(a.start, 4), round(a.end, 4)) for a in r.anims}
    assert steps["s_add"] == (0, 0)
    assert anims["w"] == (0, 2)  # 15+ letters: manim writes it in 2s
    assert anims["a"] == (2, 4) and anims["b"] == (2, 3) and steps["p_a"] == (2, 4)
    # LaggedStart: each child starts when lag_ratio of the previous one has played.
    assert anims["g"] == (4, 6) and anims["l1"] == (4, 5) and anims["l2"] == (4.5, 5.5) and anims["l3"] == (5, 6)
    # A Succession stretched to 3s plays its children one after the other, 1.5s each.
    assert anims["s1"] == (6, 7.5) and anims["s2"] == (7.5, 9)
    assert steps["end"] == (9, 9.5) and r.duration == pytest.approx(9.5)


def test_rate_func_of_a_group_moves_its_children():
    d = scene(add_all(scene()), play(group("g", "Succession", anim("a", "Indicate", "sq"), anim("b", "Indicate", "c"),
                                           rate_func="smooth")))
    r = run(d)
    b = next(a for a in r.anims if a.id == "b")
    assert b.start == pytest.approx(1.0, abs=0.01)  # smooth is symmetric: half its progress at half the time
    assert b.end == pytest.approx(2.0)


def test_timings_match_a_real_render():
    from manim import tempconfig

    d = scene(play(anim("a1", "Create", "sq")), play(group("g", "LaggedStart", anim("a2", "FadeIn", "c"), anim("a3", "Indicate", "sq"))),
              wait(0.4))
    ns = {}
    with tempconfig({"dry_run": True, "disable_caching": True, "verbosity": "ERROR"}):
        exec(compile(codegen.generate(d).source, "scene", "exec"), ns)
        sc = ns["MainScene"]()
        sc.render()
        assert run(d).duration == pytest.approx(sc.renderer.time)


def test_animating_an_object_before_its_intro_is_flagged():
    d = scene(play(animate("early", "sq", ".shift(RIGHT)")), play(anim("intro", "Create", "sq")), play(anim("later", "Indicate", "sq")))
    by = {x["id"]: x for x in codegen.generate(d).diagnostics}
    assert set(by) == {"early"} and by["early"]["kind"] == "anim" and "isn't on screen" in by["early"]["message"]
    # self.add counts as the intro; a FadeOut takes it off screen again.
    d = scene({"id": "add", "kind": "add", "targets": ["sq"]}, play(animate("a", "sq", ".shift(RIGHT)")), play(anim("out", "FadeOut", "sq")),
              play(anim("again", "Indicate", "sq")))
    assert [x["id"] for x in codegen.generate(d).diagnostics] == ["again"]
    # ValueTrackers aren't drawn: animating one never needs an intro.
    d = scene(play(animate("v", "k", ".set_value(1)")), objects=[obj("ok", "k", "ValueTracker", args={"*": "0"})])
    assert codegen.generate(d).diagnostics == []


def test_two_animations_of_one_object_in_one_play_are_flagged():
    d = scene(add_all(scene()), play(animate("m", "sq", ".shift(RIGHT)"), anim("r", "Rotate", "sq", angle="PI"), anim("f", "FadeIn", "c")))
    by = {x["id"]: x["message"] for x in codegen.generate(d).diagnostics}
    assert set(by) == {"r"} and "later one in the list wins" in by["r"]
    # In a Succession they run one after the other: that's fine.
    d = scene(add_all(scene()), play(group("g", "Succession", animate("m", "sq", ".shift(RIGHT)"), anim("r", "Rotate", "sq", angle="PI"))))
    assert codegen.generate(d).diagnostics == []


def test_empty_composition_is_an_error():
    d = scene(add_all(scene()), play(group("g", "AnimationGroup")))
    assert [(x["id"], x["level"]) for x in codegen.generate(d).diagnostics] == [("g", "error")]


def test_couple_steps_compile_to_constraint_calls():
    d = doc([obj("oA", "A", "Dot", pos=[-1, 0]), obj("oB", "B", "Dot", pos=[1, 0]),
             obj("oM", "M", "Dot", link={"kind": "midpoint", "a": "oA", "b": "oB"})])
    d["timeline"] = [add_all(d), switch("u", "uncouple", ["M"]), switch("c", "couple", ["M"], duration=1.5)]
    lines = body(d)
    assert "constraints.pause(M)" in lines and "self.play(constraints.couple(M), run_time=1.5)" in lines


# ----------------------------------------------------------------------------- format 3 projects

def v3(clips, objects=None):
    d = {"version": 3, "objects": objects or [obj("o1", "sq", "Square"), obj("o2", "c", "Circle")],
         "tracks": [{"id": "t1", "name": "V1"}, {"id": "t2", "name": "V2"}, {"id": "t3", "name": "V3", "hidden": True}], "clips": clips}
    return upgrade(d)


def clip(id, start, dur, cls="Create", target="sq", track="t1", **kw):
    return {"id": id, "kind": "anim", "track": track, "start": start, "duration": dur, "cls": cls, "target": target, "args": {}, **kw}


def test_v3_sequential_clips_become_plays_and_waits():
    d = v3([clip("a", 0, 1), clip("b", 1, 1, "FadeIn", "c"), clip("c", 3, 2, "Indicate"),
            {"id": "h", "kind": "hold", "track": "t2", "start": 0, "duration": 6}])
    assert body(d) == ["self.play(Create(sq), run_time=1)", "self.play(FadeIn(c), run_time=1)", "self.wait(1)",
                       "self.play(Indicate(sq), run_time=2)", "self.wait(1)"]


def test_v3_clips_starting_together_share_a_play():
    d = v3([clip("a", 0, 1), clip("b", 0, 2, "FadeIn", "c", track="t2")])
    assert body(d) == ["self.play(Create(sq, run_time=1), FadeIn(c, run_time=2))"]


def test_v3_staggered_clips_wait_inside_one_play():
    d = v3([clip("a", 0, 2), clip("b", 0.5, 1, "FadeIn", "c", track="t2"),
            {"id": "ad", "kind": "add", "track": "t1", "start": 3, "duration": 0, "targets": ["c"]}])
    assert body(d) == [
        "self.play(Create(sq, run_time=2), Succession(Wait(run_time=0.5), FadeIn(c, run_time=1)))",
        "self.wait(1)",
        "self.add(c)",
    ]
    r = run(d)
    times = {a.id: (round(a.start, 4), round(a.end, 4)) for a in r.anims}
    assert times["a"] == (0, 2) and times["b"] == (0.5, 1.5)  # same times as the clips had


def test_v3_disabled_and_hidden_clips_are_kept_disabled():
    d = v3([clip("a", 0, 1), clip("b", 1, 1, "FadeIn", "c", disabled=True), clip("x", 2, 1, "Indicate", track="t3")])
    kinds = [(s["kind"], bool(s.get("disabled"))) for s in d["timeline"]]
    assert kinds == [("play", False), ("play", True), ("play", True)]
    assert body(d) == ["self.play(Create(sq), run_time=1)"]


def test_an_object_coming_on_with_its_first_animation_is_only_noted():
    d = scene(play(animate("move", "sq", ".shift(RIGHT)")), play(anim("later", "Indicate", "sq")))
    by = {x["id"]: x for x in codegen.generate(d).diagnostics}
    assert set(by) == {"move"} and by["move"]["level"] == "info", by
