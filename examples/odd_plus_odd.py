from manim import *


class OddPlusOdd(Scene):
    def construct(self):
        # ---- Title
        title = Text("Odd + Odd = Even", font_size=72, t2c={"Odd": YELLOW, "Even": GREEN})
        subtitle = Text("Why adding two odd numbers always gives an even number", font_size=28, color=GREY_B)
        subtitle.next_to(title, DOWN, buff=0.4)
        self.play(Write(title), run_time=1.5)
        self.play(FadeIn(subtitle, shift=UP * 0.3))
        self.wait(1.5)
        self.play(FadeOut(title, subtitle))

        # ---- Even numbers pair up; odd numbers have one left over
        heading = Text("Even numbers pair up. Odd numbers have one left over.", font_size=34).to_edge(UP, buff=0.6)
        six = VGroup(*[Dot(radius=0.2, color=BLUE) for _ in range(6)]).arrange_in_grid(rows=2, cols=3, buff=0.4)
        six.shift(LEFT * 3.2 + UP * 0.3)
        seven = VGroup(*[Dot(radius=0.2, color=BLUE) for _ in range(6)]).arrange_in_grid(rows=2, cols=3, buff=0.4)
        seven.shift(RIGHT * 2.4 + UP * 0.3)
        seven_extra = Dot(radius=0.2, color=YELLOW).next_to(seven, RIGHT, buff=0.4).align_to(seven, UP)
        six_label = Text("6 = 2k  →  even", font_size=34, t2c={"even": GREEN}).next_to(six, DOWN, buff=0.7)
        seven_label = Text("7 = 2k + 1  →  odd", font_size=34, t2c={"+ 1": YELLOW, "odd": YELLOW}).next_to(seven, DOWN, buff=0.7)
        self.play(Write(heading))
        self.play(LaggedStartMap(GrowFromCenter, six, lag_ratio=0.1), LaggedStartMap(GrowFromCenter, seven, lag_ratio=0.1))
        self.play(FadeIn(seven_extra, scale=2))
        self.play(Indicate(seven_extra, color=YELLOW, scale_factor=1.6))
        self.play(Write(six_label), Write(seven_label))
        self.wait(2)
        self.play(FadeOut(heading, six, seven, seven_extra, six_label, seven_label))

        # ---- The algebra
        heading2 = Text("Add any two odd numbers", font_size=44).to_edge(UP, buff=0.6)
        line1 = Text("m = 2a + 1,    n = 2b + 1", font_size=40, t2c={"+ 1": YELLOW}).next_to(heading2, DOWN, buff=0.7)
        line2 = Text("m + n = (2a + 1) + (2b + 1)", font_size=40, t2c={"+ 1": YELLOW}).next_to(line1, DOWN, buff=0.45)
        line3 = Text("= 2a + 2b + 2", font_size=40, t2c={"[11:13]": GREEN}).next_to(line2, DOWN, buff=0.45)
        line4 = Text("= 2(a + b + 1)", font_size=40).next_to(line3, DOWN, buff=0.45)
        line5 = Text("= 2k", font_size=40, t2c={"2k": GREEN}).next_to(line4, DOWN, buff=0.45)
        line3.align_to(line2[3], LEFT)
        line4.align_to(line2[3], LEFT)
        line5.align_to(line2[3], LEFT)
        note3 = Text("the two 1s make 2", font_size=26, color=GREY_B).next_to(line3, RIGHT, buff=0.6)
        note4 = Text("take out a 2", font_size=26, color=GREY_B).next_to(line4, RIGHT, buff=0.6)
        note5 = Text("where k = a + b + 1", font_size=26, color=GREY_B).next_to(line5, RIGHT, buff=0.6)
        box = SurroundingRectangle(line5, color=GREEN, buff=0.15)
        self.play(Write(heading2))
        self.play(Write(line1))
        self.wait(0.5)
        self.play(Write(line2))
        self.wait(0.5)
        self.play(Write(line3), FadeIn(note3, shift=LEFT * 0.2))
        self.wait(0.5)
        self.play(Write(line4), FadeIn(note4, shift=LEFT * 0.2))
        self.wait(0.5)
        self.play(Write(line5), FadeIn(note5, shift=LEFT * 0.2))
        self.play(Create(box))
        self.play(Indicate(line5, color=GREEN))
        self.wait(2)
        self.play(FadeOut(heading2, line1, line2, line3, line4, line5, note3, note4, note5, box))

        # ---- See it with dots: the two left-over dots make one more pair
        heading3 = Text("See it with dots:  5 + 7", font_size=44).to_edge(UP, buff=0.6)
        five = VGroup(*[Dot(radius=0.2, color=BLUE) for _ in range(4)]).arrange_in_grid(rows=2, cols=2, buff=0.4)
        five.shift(LEFT * 3 + UP * 0.3)
        five_extra = Dot(radius=0.2, color=YELLOW).next_to(five, RIGHT, buff=0.4).align_to(five, UP)
        seven2 = VGroup(*[Dot(radius=0.2, color=BLUE) for _ in range(6)]).arrange_in_grid(rows=2, cols=3, buff=0.4)
        seven2.shift(RIGHT * 2.4 + UP * 0.3)
        seven2_extra = Dot(radius=0.2, color=YELLOW).next_to(seven2, RIGHT, buff=0.4).align_to(seven2, UP)
        five_label = Text("5", font_size=40).next_to(VGroup(five, five_extra), DOWN, buff=0.5)
        seven_label2 = Text("7", font_size=40).next_to(VGroup(seven2, seven2_extra), DOWN, buff=0.5)
        self.play(Write(heading3))
        self.play(LaggedStartMap(FadeIn, five, lag_ratio=0.1), LaggedStartMap(FadeIn, seven2, lag_ratio=0.1))
        self.play(FadeIn(five_extra, scale=2), FadeIn(seven2_extra, scale=2), Write(five_label), Write(seven_label2))
        self.wait(1)
        # the two left-overs meet in the middle
        self.play(
            five_extra.animate.move_to(five[1].get_center() + RIGHT * 2.2),
            seven2_extra.animate.move_to(five[3].get_center() + RIGHT * 2.2),
            FadeOut(five_label, seven_label2),
            run_time=1.5,
        )
        dominoes = VGroup(*[SurroundingRectangle(VGroup(a, b), buff=0.12, corner_radius=0.18, color=GREEN)
                            for a, b in [(five[0], five[2]), (five[1], five[3]), (five_extra, seven2_extra),
                                         (seven2[0], seven2[3]), (seven2[1], seven2[4]), (seven2[2], seven2[5])]])
        count = Text("5 + 7 = 12 = 6 pairs, nothing left over: even", font_size=34, t2c={"even": GREEN}).next_to(seven2, DOWN, buff=0.9)
        count.set_x(0)
        general = Text("The two left-over ones always make one more pair", font_size=30, color=GREY_B).next_to(count, DOWN, buff=0.35)
        self.play(LaggedStartMap(Create, dominoes, lag_ratio=0.2), run_time=2.5)
        self.play(Indicate(dominoes[2], color=YELLOW))
        self.play(Write(count))
        self.play(FadeIn(general, shift=UP * 0.2))
        self.wait(2)
        self.play(FadeOut(heading3, five, five_extra, seven2, seven2_extra, dominoes, count, general))

        # ---- Conclusion
        final = Text("Odd + Odd = Even", font_size=72, t2c={"Odd": YELLOW, "Even": GREEN})
        proof = Text("(2a + 1) + (2b + 1) = 2(a + b + 1)", font_size=40, t2c={"2(a + b + 1)": GREEN}).next_to(final, DOWN, buff=0.5)
        self.play(Write(final))
        self.play(FadeIn(proof, shift=UP * 0.2))
        self.wait(3)
