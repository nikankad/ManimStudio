"""A sorting lesson: bars swapped in nested loops, a branch for each comparison, a value counting swaps."""

from manim import *

VALUES = [5, 2, 4, 1, 3]


def bar(v: int) -> Rectangle:
    return Rectangle(width=0.6, height=v * 0.6, fill_opacity=0.8, color=BLUE)


class BubbleSort(Scene):
    def construct(self):
        title = Text("Bubble sort", font_size=40).to_edge(UP)
        self.play(Write(title))
        bars = VGroup(*[bar(v) for v in VALUES]).arrange(RIGHT, buff=0.3, aligned_edge=DOWN)
        self.play(LaggedStart(*[GrowFromEdge(b, DOWN) for b in bars], lag_ratio=0.2))
        values = list(VALUES)
        swaps = 0
        counter = Text("swaps: 0", font_size=28).to_corner(DR)
        self.add(counter)

        # one pass per bar
        for i in range(len(values)):
            for j in range(len(values) - i - 1):
                a, b = bars[j], bars[j + 1]
                self.play(a.animate.set_color(YELLOW), b.animate.set_color(YELLOW), run_time=0.3)
                if values[j] > values[j + 1]:  # out of order
                    values[j], values[j + 1] = values[j + 1], values[j]
                    self.play(Swap(a, b), run_time=0.4)
                    bars.submobjects[j], bars.submobjects[j + 1] = b, a
                    swaps += 1
                    self.remove(counter)
                    counter = Text(f"swaps: {swaps}", font_size=28).to_corner(DR)
                    self.add(counter)
                else:
                    self.wait(0.1)
                self.play(a.animate.set_color(BLUE), b.animate.set_color(BLUE), run_time=0.2)
            self.play(bars[len(values) - i - 1].animate.set_color(GREEN), run_time=0.2)

        self.play(Indicate(bars))
        self.wait()
