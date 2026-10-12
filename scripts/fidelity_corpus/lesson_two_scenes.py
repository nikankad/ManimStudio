from manim import *

ACCENT = YELLOW


def caption(text, size=36):
    return Text(text, font_size=size).to_edge(DOWN)


class Intro(Scene):
    def construct(self):
        title = Text("Sorting", font_size=64)
        sub = caption("three ways to put things in order")
        self.play(Write(title))
        self.play(FadeIn(sub, shift=UP))
        self.wait()
        self.play(title.animate.to_edge(UP).scale(0.6), FadeOut(sub))
        bars = VGroup(*[Rectangle(width=0.5, height=h, fill_opacity=0.8) for h in [3, 1, 2.5, 0.5, 2]])
        bars.arrange(RIGHT, buff=0.2, aligned_edge=DOWN)
        self.play(LaggedStart(*[GrowFromEdge(b, DOWN) for b in bars], lag_ratio=0.15))
        self.play(bars[1].animate.set_color(ACCENT), bars[3].animate.set_color(ACCENT))
        self.play(Swap(bars[1], bars[3]))
        self.wait(0.5)


class Outro(Scene):
    def construct(self):
        dot = Dot(color=ACCENT)
        ring = Circle(radius=2)
        self.add(ring)
        self.play(GrowFromCenter(dot))
        self.play(MoveAlongPath(dot, ring), run_time=2, rate_func=linear)
        self.play(Indicate(dot))
        self.play(FadeOut(dot, ring))
