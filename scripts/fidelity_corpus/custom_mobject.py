from manim import *


class Gauge(VGroup):
    def __init__(self, tracker, radius=1.5, **kwargs):
        super().__init__(**kwargs)
        self.tracker = tracker
        self.dial = Arc(radius=radius, start_angle=PI, angle=-PI, color=GREY)
        self.needle = always_redraw(lambda: Line(ORIGIN, radius * 0.9 * np.array([np.cos(PI - PI * tracker.get_value()), np.sin(PI - PI * tracker.get_value()), 0]), color=RED))
        self.add(self.dial, self.needle)


class GaugeScene(Scene):
    def construct(self):
        level = ValueTracker(0)
        gauge = Gauge(level)
        readout = DecimalNumber(0, num_decimal_places=2).next_to(gauge, DOWN)
        readout.add_updater(lambda d: d.set_value(level.get_value()))
        self.play(Create(gauge.dial))
        self.add(gauge.needle, readout)
        self.play(level.animate.set_value(0.8), run_time=2)
        self.play(level.animate.set_value(0.25), rate_func=there_and_back)
        self.wait()
        box = SurroundingRectangle(readout, color=YELLOW)
        self.play(Create(box))
        self.play(Circumscribe(gauge.dial))
        self.play(level.animate.increment_value(0.5))
        self.wait(0.5)
