from manim import *


class Walkthrough(Scene):
    def setup(self):
        self.grid = NumberPlane(x_range=[-4, 4], y_range=[-3, 3], background_line_style={"stroke_opacity": 0.4})
        self.points = [LEFT * 2 + DOWN, ORIGIN, RIGHT * 2 + UP]

    def show_points(self):
        dots = VGroup(*[Dot(p) for p in self.points])
        self.play(LaggedStartMap(FadeIn, dots, lag_ratio=0.3))
        return dots

    def construct(self):
        self.play(Create(self.grid), run_time=1.5)
        dots = self.show_points()
        path = VMobject(color=BLUE).set_points_smoothly(self.points)
        self.play(Create(path))
        mover = Dot(color=RED).move_to(self.points[0])
        self.add(mover)
        for p in self.points[1:]:
            self.play(mover.animate.move_to(p), run_time=0.75)
        label = Text("done", font_size=30).next_to(mover, UP)
        label.add_updater(lambda m: m.next_to(mover, UP))
        self.play(FadeIn(label))
        self.play(mover.animate.shift(LEFT * 3))
        label.clear_updaters()
        self.play(FadeOut(dots, path, label, mover))
