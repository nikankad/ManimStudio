"""Clips on the timeline named in words (frontend/src/words.ts): from the phrasebook (phrases.json), the user's own
wording, or the code's names read as words."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from mathengine import importer

WORDS = Path(__file__).parent.parent / "frontend" / "scripts" / "words.mjs"
pytestmark = pytest.mark.skipif(not shutil.which("node") or not (WORDS.parent.parent / "node_modules" / "vite").exists(),
                                reason="needs node and the frontend's node_modules")

SCENE = '''from manim import *

ZEROS = [14.134725, 21.02204]


class S(Scene):
    def construct(self):
        a = Circle()
        b = Square()
        dots = VGroup(*[Dot() for _ in range(3)])
        t = ValueTracker(1)
        self.next_section("Intro")
        self.play(FadeIn(a, shift=UP))
        self.play(Transform(a, b))
        self.play(Rotate(b, PI / 2), Rotate(a, angle=90 * DEGREES))
        self.play(b.animate.shift(DOWN * 0.6).set_color(RED))
        self.play(a.animate.next_to(b, DOWN).to_corner(UR))
        self.play(t.animate.set_value(ZEROS[int(2) - 1]), run_time=2)
        self.play(GrowFromCenter(b), SpinInFromNothing(a))
        b.next_to(a)
        for i in range(1, 4):
            self.play(Indicate(a))
        for i, d in enumerate(dots):
            self.wait(0.1)
        k = 0
        while k < 2:
            k += 1
        if k >= 2 and t.get_value() != 0:
            self.wait()
        else:
            self.wait(2)
        self.play(*[FadeOut(m) for m in self.mobjects if m is not a and type(m) is not Mobject])
        self.add(a)
'''


def words(overrides: dict | None = None) -> list[tuple[str, str]]:
    doc = importer.import_code(SCENE).doc
    res = subprocess.run(["node", str(WORDS)], input=json.dumps({"doc": doc, "overrides": overrides or {}, "constants": ["RED", "YELLOW", "UP", "DOWN", "UR"]}),
                         capture_output=True, text=True, timeout=120, cwd=WORDS.parent.parent)
    assert res.returncode == 0, res.stderr
    return [(n, s) for k, n, s in json.loads(res.stdout) if k != "play"]


def test_clips_read_in_words():
    got = words()
    for clip in [("Section “Intro”", ""), ("a", "Fade in"), ("a", "Turn into b"), ("b", "Rotate π / 2"), ("a", "Rotate 90°"),
                 ("b", "Move down 0.6, color red"), ("a", "Below b, to the top-right corner"), ("t", "To ZEROS[2]"),
                 ("b", "Grow from the center"), ("a", "Spin in"), ("b", "Right of a"), ("Repeat, i = 1 to 3", ""), ("a", "Pulse"),
                 ("Each d in dots", ""), ("Pause", "0.1s"), ("k", "set to 0"), ("While k < 2", ""), ("k", "up by 1"),
                 ("If k ≥ 2 and t ≠ 0", ""), ("Otherwise", ""), ("Fade out all but a", ""), ("Show", "a")]:
        assert clip in got, (clip, got)


def test_the_users_wording():
    """A changed entry renames every clip that uses it; a template fills in arguments, looked up in lists."""
    got = words({"animations": {"FadeIn": "Appear", "Indicate": "Flash {1|color=YELLOW}"}, "methods": {"next_to": "beside {1} ({2:move=RIGHT})"},
                 "blocks": {"repeat": "Do it {to} times"}})
    for clip in [("a", "Appear"), ("a", "Flash yellow"), ("b", "Beside a (right)"), ("a", "Beside b (down), to the top-right corner"), ("Do it 3 times", "")]:
        assert clip in got, (clip, got)
