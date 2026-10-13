from manim import *


class Morphs(MovingCameraScene):
    def construct(self):
        sq = Square(color=BLUE, fill_opacity=0.5)
        circ = Circle(color=RED, fill_opacity=0.5)
        tri = Triangle(color=GREEN, fill_opacity=0.5).shift(RIGHT * 3)
        self.play(DrawBorderThenFill(sq))
        self.play(Transform(sq, circ))
        self.play(ReplacementTransform(sq, tri))
        self.play(self.camera.frame.animate.move_to(tri).set(width=6))
        star = Star(color=YELLOW).move_to(tri)
        self.play(FadeTransform(tri, star))
        self.play(Rotate(star, PI / 3), star.animate.set_fill(ORANGE, opacity=1))
        self.play(Restore(self.camera.frame) if hasattr(self.camera.frame, "saved_state") else self.camera.frame.animate.move_to(ORIGIN).set(width=14.22))
        word = Text("shapes")
        self.play(TransformMatchingShapes(star, word))
        self.play(Wiggle(word))
        self.play(Unwrite(word))
