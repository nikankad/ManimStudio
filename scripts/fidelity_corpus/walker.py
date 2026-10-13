"""A dot walking a path: a while loop with a condition on a tracker, a with block, a try, updaters on and off."""

import contextlib

from manim import *


class Walker(Scene):
    def construct(self):
        path = VMobject().set_points_smoothly([LEFT * 4, LEFT * 2 + UP, ORIGIN, RIGHT * 2 + DOWN, RIGHT * 4])
        self.play(Create(path), run_time=1.5)
        t = ValueTracker(0)
        dot = Dot(color=YELLOW)
        dot.add_updater(lambda d: d.move_to(path.point_from_proportion(t.get_value())))
        label = always_redraw(lambda: Text(f"{t.get_value():.1f}", font_size=24).next_to(dot, UP))
        self.add(dot, label)
        step = 0.25
        while t.get_value() < 1 - 1e-6:
            self.play(t.animate.increment_value(step), run_time=0.5)
            if t.get_value() >= 0.5 and step > 0.1:
                step = 0.125
            elif t.get_value() < 0.5:
                self.wait(0.1)
        dot.clear_updaters()
        with contextlib.suppress(ValueError):
            self.play(dot.animate.scale(2))
        try:
            self.play(FadeOut(label))
        except Exception:
            self.remove(label)
        finally:
            self.play(Flash(dot))
        self.wait()
