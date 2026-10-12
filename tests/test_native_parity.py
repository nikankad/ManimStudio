"""The editor against manim itself: imported code previews (and regenerates) exactly as ``manim render`` runs it.

Each scene runs natively (``Scene.render()``, no output written) and through the editor (import -> runtime.run),
and both are compared: the scene's length and the values its trackers reach, at the end and mid-play.
"""

import pytest

from mathengine import codegen, runtime
from mathengine.importer import import_code

DT_UPDATER = '''
class S(Scene):
    def construct(self):
        t = ValueTracker(0)
        t.add_updater(lambda m, dt: m.increment_value({expr}))
        self.add(t)
        self.wait(1)
        self.play(t.animate.increment_value(1), run_time=0.5)
'''

SCENES = {
    # wait() ends at the first frame its stop condition holds
    "stop_condition": '''
class S(Scene):
    def construct(self):
        t = ValueTracker(0)
        t.add_updater(lambda m, dt: m.increment_value(dt))
        self.add(t)
        self.wait(2, stop_condition=lambda: t.get_value() >= 0.5)
''',
    # a frozen frame runs no updaters
    "frozen_frame": '''
class S(Scene):
    def construct(self):
        t = ValueTracker(0)
        t.add_updater(lambda m, dt: m.increment_value(dt))
        self.add(t)
        self.wait(2, frozen_frame=True)
        self.pause(0.5)
''',
    # updaters run once per frame of the project's frame rate
    "dt_squared": DT_UPDATER.format(expr="dt * dt"),
    # the scene's own play() runs
    "custom_play": '''
class S(Scene):
    def play(self, *args, **kwargs):
        kwargs["run_time"] = 2
        super().play(*args, **kwargs)

    def construct(self):
        t = ValueTracker(0)
        self.play(t.animate.set_value(1))
''',
    # decorators of the scene class stay
    "decorator": '''
def hold2(cls):
    cls.hold = 2
    return cls


@hold2
class S(Scene):
    hold = 1

    def construct(self):
        self.wait(self.hold)
''',
    # code after the scene class stays after it
    "footer": '''
class S(Scene):
    hold = 1

    def construct(self):
        self.wait(self.hold)


S.hold = 1.5
''',
    # the clock moves by whole frames: 0.3s is 9 frames at 30fps (and 18 at 60), 0.31s is one more
    "frame_quantized": '''
class S(Scene):
    def construct(self):
        t = ValueTracker(0)
        t.add_updater(lambda m, dt: m.increment_value(dt))
        self.add(t)
        self.wait(0.31)
        self.play(t.animate.increment_value(1), run_time=0.31)
''',
}


def native(src: str, fps: int, until: float | None = None) -> tuple[float, dict]:
    """Run ``src`` with manim; the clock and every ValueTracker of construct() (at the end, or in the frame
    of the video at time ``until``)."""
    m = runtime.manim()
    ns: dict = {}
    exec("from manim import *\n" + src, ns)
    seen: dict = {}

    class Probe(ns["S"]):
        def update_to_time(self, t):
            super().update_to_time(t)
            if until is not None and self.renderer.time <= until + 1e-9:  # the last frame starting by then
                seen.update(trackers(self))

    def trackers(scene):
        return {f"t{i}": round(float(mob.get_value()), 6) for i, mob in enumerate(scene._probe_trackers)}

    orig_init = m.ValueTracker.__init__
    made: list = []

    def track(self, *a, **k):
        orig_init(self, *a, **k)
        made.append(self)

    m.ValueTracker.__init__ = track
    try:
        with m.tempconfig({"format": "none", "disable_caching": True, "frame_rate": fps, "pixel_width": 128,
                           "pixel_height": 72, "verbosity": "ERROR", "progress_bar": "none"}):
            scene = Probe()
            scene._probe_trackers = made
            scene.render()
    finally:
        m.ValueTracker.__init__ = orig_init
    return round(float(scene.renderer.time), 6), (seen if until is not None else trackers(scene))


def editor(src: str, fps: int, until: float | None = None) -> tuple[float, dict]:
    doc = import_code("from manim import *\n" + src).doc
    doc["config"]["frame_rate"] = fps
    r = runtime.run(doc, until, render=False)
    assert r.error is None, r.error["trace"]
    values = [round(v, 6) for v in r.values.values()]
    return round(r.duration, 6), {f"t{i}": v for i, v in enumerate(values)}


@pytest.mark.parametrize("fps", [30, 60])
@pytest.mark.parametrize("name", list(SCENES))
def test_preview_runs_like_manim(name, fps):
    src = SCENES[name]
    assert editor(src, fps) == native(src, fps)


@pytest.mark.parametrize("name", list(SCENES))
def test_regenerated_code_runs_like_the_original(name):
    src = SCENES[name]
    regenerated = codegen.generate(import_code("from manim import *\n" + src).doc).source
    assert native(regenerated.replace("from manim import *\n", "", 1), 30) == native(src, 30)


@pytest.mark.parametrize("fps", [24, 60])
@pytest.mark.parametrize("until", [0.25, 0.5, 1.1, 1.3])
def test_seeking_shows_the_frame_manim_writes(until, fps):
    src = DT_UPDATER.format(expr="dt * dt + 0.5 * dt")
    _, at = editor(src, fps, until)
    assert at == native(src, fps, until)[1]


def test_children_of_an_eased_group_follow_its_easing():
    from conftest import add_all, anim, doc, group, obj, play

    d = doc([obj("o1", "sq", "Square")])
    succession = group("s", "Succession", anim("w1", "Wait", run_time=1), anim("w2", "Wait", run_time=3))
    d["timeline"] = [add_all(d), play(group("g", "AnimationGroup", succession, rate_func="ease_in_quad"))]
    r = runtime.run(d, render=False)
    assert r.error is None, r.error["trace"]
    times = {a.id: (round(a.start, 4), round(a.end, 4)) for a in r.anims}
    # Group time is 4 * (t / 4)^2: the second child starts when that reaches 1, at t = 2 (not at 1).
    assert times["w1"] == (0, 2) and times["w2"] == (2, 4) and times["g"] == (0, 4)


def test_clips_draw_the_curve_manim_uses():
    from conftest import add_all, anim, doc, obj, play

    d = doc([obj("o1", "sq", "Square"), obj("o2", "t", "Text", args={"*": '"hi"'})])
    d["timeline"] = [add_all(d), play(anim("w", "Write", "t")), play(anim("c", "Create", "sq", rate_func="smooth"), rate_func="linear"),
                     play(anim("i", "Indicate", "sq"))]
    curves = {a["id"]: a["curve"] for a in runtime.run(d, render=False).to_json()["anims"]}
    linear = [round(i / 20, 4) for i in range(21)]
    assert curves["w"] == linear  # Write's own default is linear, not Animation's smooth
    assert curves["c"] == linear  # the play's rate_func replaces the animation's
    assert curves["i"][0] == 0 and curves["i"][10] == 1 and curves["i"][-1] == 0  # there_and_back
