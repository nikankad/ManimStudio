"""manim code -> document -> manim code: the imported scene runs exactly like the original."""

import json

import numpy as np
import pytest

from mathengine import codegen, importer, runtime, samples
from mathengine.importer import CodeError, import_code

SCENE = '''
from manim import *
import numpy as np

config.background_color = "#101020"


def helper(x):
    return x ** 2


class Intro(Scene):
    """A docstring."""
    colors = [BLUE, RED]

    def construct(self):
        # The title
        title = Text("Hello", font_size=48).to_edge(UP)
        circle = Circle(radius=1.5, color=BLUE)
        square = Square(2).shift(RIGHT * 2)
        square.set_fill(RED, opacity=0.5)
        self.play(Write(title))
        self.play(Create(circle), FadeIn(square, shift=UP), run_time=2)
        self.wait(0.5)
        # move it
        self.play(circle.animate.shift(LEFT * 2).set_color(YELLOW), rate_func=linear)
        dots = VGroup(*[Dot() for _ in range(5)]).arrange(RIGHT)
        dots.next_to(circle, DOWN)
        self.play(LaggedStart(*[FadeIn(d) for d in dots], lag_ratio=0.2))
        self.play(AnimationGroup(Indicate(circle), Rotate(square, PI / 4), lag_ratio=0.5))
        for d in dots:
            d.set_color(GREEN)
        self.add(dots)
        self.play(Transform(circle, square), LaggedStartMap(FadeOut, dots))
        t = ValueTracker(0)
        num = always_redraw(lambda: Text(f"{t.get_value():.2f}").next_to(title, DOWN))
        self.add(num)
        self.play(t.animate.set_value(5), run_time=1.5)
        self.remove(num)
        self.play(*[FadeOut(m) for m in [title, circle]])
        self.wait()

    def helper2(self):
        return helper(2)


class Camera(MovingCameraScene):
    def setup(self):
        super().setup()
        self.box_color = YELLOW

    def construct(self):
        text = Text("Moving the camera").scale(1.2)
        self.play(Write(text))
        framebox = SurroundingRectangle(text, buff=.1, color=self.box_color)
        self.play(Create(framebox))
        self.play(self.camera.frame.animate.scale(0.5).move_to(text))
        self.wait(0.3)
        sq = Square()
        sq.save_state()
        self.play(sq.animate.shift(UP), Succession(Wait(0.5), FadeIn(Circle())), run_time=2)
        self.play(Restore(sq))
        self.play(ReplacementTransform(sq, Triangle()), ApplyMatrix([[1, 1], [0, 1]], text))
        self.play(Rotate(text, angle=PI, about_point=ORIGIN), MoveAlongPath(framebox, Circle()))
        a = Arrow(LEFT, RIGHT)
        self.play(GrowArrow(a), Wait(run_time=0.5))
        b = a.copy().shift(DOWN)
        self.play(TransformFromCopy(a, b))
        self.play(FadeOut(a, b, shift=DOWN), FadeOut(*[text, framebox]))
'''


def run_source(src, scene):
    """Run manim code as manim would (without rendering): its length, play count and final picture."""
    m = runtime.manim()
    with m.tempconfig({"dry_run": True, "write_to_movie": False, "disable_caching": True, "verbosity": "WARNING",
                       "progress_bar": "none"}):
        ns = {"__name__": "scene"}
        exec(compile(src, "<scene>", "exec"), ns)
        cls = type(scene, (runtime.PreviewMixin, ns[scene]), {})
        sc = cls()
        sc._me_init(None)
        sc.setup()
        sc.construct()
        state = sorted((type(mob).__name__, tuple(np.round(mob.get_center(), 3))) for mob in sc.mobjects)
        return round(float(sc.renderer.time), 4), sc._me_plays, state


@pytest.mark.parametrize("scene", ["Intro", "Camera"])
def test_imported_scene_runs_like_the_original(scene):
    doc = import_code(SCENE, scene).doc
    src = codegen.generate(doc, latex=True).source
    assert run_source(src, scene) == run_source(SCENE, scene)
    # Importing the generated code again changes nothing.
    assert codegen.generate(import_code(src, scene).doc, latex=True).source == src


def test_statements_become_steps_objects_and_code():
    res = import_code(SCENE)
    doc = res.doc
    assert res.scenes == ["Intro", "Camera"]
    assert doc["scene"]["name"] == "Intro" and doc["config"]["background_color"] == "#101020"
    assert "def helper(x)" in doc["header"] and "from manim import" not in doc["header"]
    assert "class Camera" in doc["footer"]  # module code after the scene stays after it
    assert "colors = [BLUE, RED]" in doc["scene"]["members"] and "def helper2" in doc["scene"]["members_after"]
    objs = {o["name"]: o for o in doc["objects"]}
    assert objs["title"]["ctor"] == "Text" and objs["title"]["args"] == {"*": '"Hello"', "font_size": "48"}
    assert objs["title"]["chain"] == ".to_edge(UP)" and objs["title"]["comment"] == "# The title"
    assert objs["square"]["chain"] == ".shift(RIGHT * 2).set_fill(RED, opacity=0.5)"
    # Objects are made where the code makes them: dots after the move, t after the Transform.
    kinds = [s["kind"] for s in doc["timeline"]]
    assert kinds == ["play", "play", "wait", "play", "play", "play", "code", "add", "play", "add", "play", "remove", "code", "wait"]
    steps = doc["timeline"]
    assert "after" not in objs["circle"] and objs["dots"]["after"] == steps[3]["id"] and objs["t"]["after"] == steps[8]["id"]
    play = steps[1]
    assert play["args"] == {"run_time": "2"}
    assert [(a["cls"], a["target"], a["args"]) for a in play["anims"]] == [("Create", "circle", {}), ("FadeIn", "square", {"shift": "UP"})]
    assert steps[3]["anims"][0] | {"id": ""} == {"id": "", "cls": "animate", "target": "circle", "args": {},
                                                "chain": ".shift(LEFT * 2).set_color(YELLOW)"}
    assert steps[3]["comment"] == "# move it"
    lagged = steps[4]["anims"][0]  # children built by a list comprehension: kept as an argument
    assert lagged["cls"] == "LaggedStart" and lagged["args"] == {"*": "*[FadeIn(d) for d in dots]", "lag_ratio": "0.2"}
    group = steps[5]["anims"][0]
    assert group["cls"] == "AnimationGroup" and [(c["cls"], c["target"]) for c in group["anims"]] == [("Indicate", "circle"), ("Rotate", "square")]
    assert steps[6]["code"] == "for d in dots:\n    d.set_color(GREEN)"
    assert [(a["cls"], a["target"], a["args"]) for a in steps[8]["anims"]] == [("Transform", "circle", {"*": "square"}),
                                                                               ("LaggedStartMap", "dots", {"*": "FadeOut"})]
    assert any("Line" in n and "kept as code" in n for n in res.notes)


def test_codegen_places_objects_where_they_are_made():
    src = codegen.generate(import_code(SCENE).doc, latex=True).source
    body = src[src.index("def construct"):]
    assert body.index("self.play(circle.animate") < body.index("dots = VGroup") < body.index("self.play(LaggedStart")


def test_an_object_waits_for_what_it_is_built_from():
    doc = import_code(SCENE).doc
    doc["objects"].insert(0, {"id": "lbl", "name": "lbl", "ctor": "Text", "args": {"*": '"x"'}, "pos": None,
                              "chain": ".next_to(dots, UP)"})
    body = codegen.generate(doc, latex=True).source
    assert body.index("dots = VGroup") < body.index("lbl = Text")


def test_transform_lines_become_object_fields():
    doc = import_code('''
from manim import *
class S(Scene):
    def construct(self):
        c = Circle()
        c.set_fill(BLUE, 0.5)
        c.stretch(2, 0)
        c.scale(1.5)
        c.rotate(30 * DEGREES)
        c.move_to(np.array([1, -2.5, 0]))
        self.add(c)
''').doc
    c = doc["objects"][0]
    assert c["chain"] == ".set_fill(BLUE, 0.5)" and c["stretch"] == [2, 1] and c["scale"] == 1.5 and c["rotation"] == 30
    assert c["pos"] == [1, -2.5]


def test_unchanged_code_keeps_the_document():
    for sid in ("derivative", "riemann", "orthocenter", "coupling"):
        d = samples.sample(sid)
        d["timeline"][1]["disabled"] = True  # disabled steps aren't in the code, but survive
        src = codegen.generate(d, latex=True).source
        assert json.dumps(import_code(src, base=d).doc, sort_keys=True) == json.dumps(d, sort_keys=True), sid


TRAILING = '''
from manim import *


class Demo(Scene):
    def construct(self):
        circle = Circle(radius=1.5)  # the main shape
        label = Text("a # b")  # not a comment inside the string
        self.play(Create(circle))  # draw it
        self.play(Write(label), FadeIn(circle))  # both together
        self.wait(2)  # let it sink in
        self.play(FadeOut(label))
'''


def test_comments_at_the_end_of_a_line_stay_with_their_statement():
    res = import_code(TRAILING)
    by_name = {o["name"]: o for o in res.doc["objects"]}
    assert by_name["circle"]["comment"] == "# the main shape"
    assert by_name["label"]["comment"] == "# not a comment inside the string"  # the "#" inside the string is text
    comments = [s.get("comment") for s in res.doc["timeline"]]
    assert comments == ["# draw it", "# both together", "# let it sink in", None], comments
    src = codegen.generate(res.doc).source
    for text in ["# the main shape", "# draw it", "# both together", "# let it sink in"]:
        assert src.count(text) == 1, text
    assert 'Text("a # b")' in src


def test_a_comment_that_moved_above_its_statement_stays_put():
    first = codegen.generate(import_code(TRAILING).doc).source
    second = codegen.generate(import_code(first).doc).source
    assert first == second


def test_the_no_latex_helper_is_not_copied_into_the_header_on_import(monkeypatch):
    from mathengine import tex

    monkeypatch.setattr(tex, "latex_available", lambda: False)
    first = codegen.generate(import_code(TRAILING).doc).source
    assert first.count("_me_number_parts = {}") == 1
    doc = import_code(first).doc
    assert doc["header"] == "", "the helper is codegen's to write, not part of the user's header"
    assert codegen.generate(doc).source == first
    # on a machine with LaTeX codegen no longer writes it, but code that came with it keeps working
    monkeypatch.setattr(tex, "latex_available", lambda: True)
    assert "_me_number_parts = {}" in import_code(first).doc["header"]


def test_edited_code_keeps_the_rest():
    d = samples.sample("derivative")
    src = codegen.generate(d, latex=True).source
    edited = src.replace("self.wait()", "self.wait(0.25)", 1)
    new = import_code(edited, base=d).doc
    changed = [s for s in new["timeline"] if s["id"] not in {x["id"] for x in d["timeline"]}]
    assert len(changed) == 1 and changed[0]["kind"] == "wait" and changed[0]["args"] == {"duration": "0.25"}
    assert [o["id"] for o in new["objects"]] == [o["id"] for o in d["objects"]]
    assert [o.get("link") for o in new["objects"]] == [o.get("link") for o in d["objects"]]


def test_constructions_in_code_without_their_document_still_run():
    d = samples.sample("orthocenter")
    res = import_code(codegen.generate(d, latex=True).source)
    assert "class Constraints" in res.doc["header"]
    assert runtime.run(res.doc, None, render=False).duration == pytest.approx(runtime.run(d, None, render=False).duration)


def test_errors():
    with pytest.raises(CodeError, match="no Scene"):
        import_code("from manim import *\nx = 1\n")
    with pytest.raises(CodeError, match="line 2"):
        import_code("class S(Scene):\n    def construct(self)\n")
    with pytest.raises(CodeError, match="no Scene called Nope"):
        import_code(SCENE, "Nope")
    assert importer.scenes_in(SCENE) == ["Intro", "Camera"]


def test_server_imports_code_and_opens_py_files(tmp_path, monkeypatch):
    import threading
    import urllib.request

    from mathengine.server import make_server

    monkeypatch.setenv("MANIM_STUDIO_HOME", str(tmp_path / "home"))
    server, app = make_server(None, 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def call(path, body):
        req = urllib.request.Request(f"{base}{path}?token={app.token}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "Host": f"127.0.0.1:{server.server_address[1]}"})
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read())

    try:
        res = call("/api/import_code", {"code": SCENE, "scene": "Renamed"})  # a scene that isn't there: the first one
        assert res["ok"] and res["doc"]["scene"]["name"] == "Intro" and res["scenes"] == ["Intro", "Camera"]
        bad = call("/api/import_code", {"code": "class S(Scene):\n    def construct(self)\n"})
        assert not bad["ok"] and bad["line"] == 2
        code = call("/api/code", {"doc": res["doc"]})
        step = res["doc"]["timeline"][0]
        line = next(int(k) for k, v in code["linemap"].items() if v[1] == step["anims"][0]["id"])
        assert code["code"].splitlines()[line - 1].strip() == "self.play(Write(title))"
        py = tmp_path / "scene.py"
        py.write_text(SCENE)
        opened = call("/api/project/open", {"path": str(py)})
        assert opened["path"] is None and opened["imported"] == str(py) and opened["doc"]["scene"]["name"] == "Intro"
    finally:
        server.shutdown()


def test_cli_import(tmp_path):
    from mathengine.__main__ import main
    from mathengine.project import load_project

    py = tmp_path / "scene.py"
    py.write_text(SCENE)
    assert main(["import", str(py), "-s", "Camera"]) == 0
    doc = load_project(tmp_path / "scene.manimstudio")
    assert doc["scene"]["name"] == "Camera" and doc["scene"]["base"] == "MovingCameraScene"


def test_scene_method_calls_round_trip():
    src = """
from manim import *
class S(ThreeDScene):
    def construct(self):
        self.set_camera_orientation(phi=75 * DEGREES, theta=30 * DEGREES)
        sphere = Sphere(radius=1)
        self.next_section("intro", skip_animations=False)
        self.play(Create(sphere))
        self.bring_to_front(sphere)
        self.begin_ambient_camera_rotation(rate=0.2)
        self.wait(1)
        self.stop_ambient_camera_rotation()
        self.move_camera(phi=60 * DEGREES, run_time=1.5)
        self.add_subcaption("hello", duration=1)
"""
    doc = import_code(src).doc
    calls = [(s["method"], s["args"]) for s in doc["timeline"] if s["kind"] == "call"]
    assert calls[0] == ("set_camera_orientation", {"phi": "75 * DEGREES", "theta": "30 * DEGREES"})
    assert ("bring_to_front", {"*": "sphere"}) in calls and ("move_camera", {"phi": "60 * DEGREES", "run_time": "1.5"}) in calls
    out = codegen.generate(doc, latex=True).source
    assert "self.move_camera(phi=60 * DEGREES, run_time=1.5)" in out and "self.bring_to_front(sphere)" in out
    assert run_source(out, "S")[:2] == run_source(src, "S")[:2]
    r = runtime.run(doc, None, render=False)
    assert r.error is None and r.duration == pytest.approx(3.5)


def test_markers_keep_their_attachment_through_code_edits(tmp_path):
    """A marker attached to a clip keeps pointing at it when the code is edited elsewhere, and survives save/reopen
    with its name, kind, notes and attachment."""
    from mathengine import project

    src = ("from manim import *\n\nclass M(Scene):\n    def construct(self):\n        a = Circle()\n        b = Square()\n"
           "        self.play(Create(a))\n        self.wait(2)\n        self.play(Create(b))\n")
    d = import_code(src).doc
    anim = d["timeline"][-1]["anims"][0]["id"]
    d["markers"] = [{"id": "m1", "time": 3.5, "label": "Reveal", "notes": "say it", "category": "visual",
                     "anchor": {"id": anim, "edge": "start", "offset": 0.5}}]
    edited = codegen.generate(d, latex=True).source.replace("self.wait(2)", "self.wait(3)")
    new = import_code(edited, base=d).doc
    assert new["markers"] == d["markers"]
    assert any(a["id"] == anim for s in new["timeline"] for a in s.get("anims") or [])
    path = tmp_path / "m.manimstudio"
    project.save_project(path, new)
    assert project.load_project(path)["markers"] == d["markers"]


def test_an_expression_animated_keeps_its_parentheses():
    src = ("from manim import *\n\nclass S(Scene):\n    def construct(self):\n        a = Circle()\n        b = Square()\n"
           "        g = VGroup(a)\n        self.add(g, b)\n        self.play((g + b).animate.shift(RIGHT))\n")
    out = codegen.generate(import_code(src).doc).source
    assert "self.play((g + b).animate.shift(RIGHT))" in out or "self.play((g+b).animate.shift(RIGHT))" in out, out


def test_a_complex_tracker_previews():
    src = ("from manim import *\n\nclass S(Scene):\n    def construct(self):\n        z = ComplexValueTracker(1 + 1j)\n"
           "        self.add(z)\n        self.play(z.animate.set_value(2j))\n")
    r = runtime.run(import_code(src).doc, render=False)
    assert r.error is None, r.error


STYLE = '''from manim import *
import numpy as np


class S(Scene):
    def construct(self):
        a = Dot().shift(LEFT * 2)
        line = Line(LEFT, RIGHT, color=BLUE)
        line.set_color(RED)
        line.shift(UP)
        self.add(a, line)

        ex = Exclusion(Square(), Circle(), color=YELLOW)
        self.play(Create(ex), run_time=2)
'''


def _construct(src: str) -> str:
    return src[src.index("def construct"):]


def test_imported_code_comes_back_as_it_was_written():
    doc = import_code(STYLE).doc
    out = codegen.generate(doc).source
    assert _construct(out) == _construct(STYLE), out  # inline chains, lines of calls, positional args, blank lines
    assert import_code(out, base=doc).doc == doc
    # the whole file, top included: no config line or import it didn't have, its blank lines before the class
    top = "from manim import *\n\nclass S(Scene):\n    def construct(self):\n        self.wait()\n"
    doc = import_code(top).doc
    assert codegen.generate(doc, latex=True).source == top
    for latex in (True, False):  # without LaTeX the number helper is added below it, and taken out when read back
        assert import_code(codegen.generate(doc, latex=latex).source, base=doc).doc == doc
    doc["config"]["background_color"] = "#222222"  # changed in the app: written the usual way
    out = codegen.generate(doc, latex=True).source
    assert "config.background_color = '#222222'" in out and "import numpy as np" in out, out


def test_edited_code_falls_back_to_the_usual_style():
    doc = import_code(STYLE).doc
    line = next(o for o in doc["objects"] if o["name"] == "line")
    line["chain"] = ".set_color(GREEN)"  # methods changed in the editor: the layout no longer applies
    del line["args"]["*"]  # the first positional argument removed: the others can't stay positional
    a = next(o for o in doc["objects"] if o["name"] == "a")
    a["chain"] = ".shift(LEFT * 2).scale(2)"  # the part written inline is still there: it stays inline
    out = codegen.generate(doc).source
    assert "line = Line(end=RIGHT, color=BLUE)\n        line.set_color(GREEN)\n" in out, out
    assert "a = Dot().shift(LEFT * 2)\n        a.scale(2)\n" in out, out
    assert "ex = Exclusion(Square(), Circle(), color=YELLOW)" in out


LATER = '''from manim import *


class S(MovingCameraScene):
    def construct(self):
        g = VGroup(Dot(), Square())
        label = Text("hi")
        self.add(g, label)
        self.wait()
        label.next_to(g, UP, buff=0.5)
        g[0].set_color(RED)
        self.camera.frame.scale(1.5)
        self.play(FadeOut(label))
'''


def test_methods_called_later_become_steps_that_can_be_edited():
    doc = import_code(LATER).doc
    applies = [s for s in doc["timeline"] if s.get("kind") == "apply"]
    assert [(s["target"], s["chain"]) for s in applies] == [
        ("label", ".next_to(g, UP, buff=0.5)"), ("g[0]", ".set_color(RED)"), ("self.camera.frame", ".scale(1.5)")]
    assert _construct(codegen.generate(doc).source) == _construct(LATER)
    applies[0]["chain"] = ".next_to(g, DOWN)"  # edited in the inspector
    out = codegen.generate(doc).source
    assert "        label.next_to(g, DOWN)\n        g[0].set_color(RED)\n" in out, out
    r = runtime.run(doc, render=False)
    assert r.error is None, r.error


def test_a_call_on_something_unknown_stays_code():
    src = LATER.replace("        g[0].set_color(RED)\n", "        helper.set_color(RED)\n")
    doc = import_code(src).doc
    assert not any(s.get("target") == "helper" for s in doc["timeline"] if s.get("kind") == "apply")


WRAPPED = '''from manim import *


class S(Scene):
    def construct(self):
        a = Text(
            "long",
            font_size=30,
        )
        self.play(
            Write(a),
            run_time=2,
        )
'''


def test_statements_written_over_several_lines_come_back_the_same():
    doc = import_code(WRAPPED).doc
    out = codegen.generate(doc).source
    assert _construct(out) == _construct(WRAPPED), out
    assert import_code(out, base=doc).doc == doc
    play = next(s for s in doc["timeline"] if s.get("kind") == "play")
    play["args"]["run_time"] = "3"  # edited: the statement is written the usual way again
    out = codegen.generate(doc).source
    assert "self.play(Write(a), run_time=3)" in out, out
    assert 'a = Text(\n            "long",\n            font_size=30,\n        )\n' in out, out


SPANS = '''from manim import *


class S(Scene):
    def construct(self):
        a = Circle()
        b = Text("é b")
        self.play(FadeIn(a), Write(b))
        self.play(
            LaggedStart(FadeOut(a), b.animate.shift(UP), lag_ratio=0.5),
            run_time=2,
        )
        self.wait()
'''


def test_each_element_knows_where_its_code_is():
    doc = import_code(SPANS).doc
    gen = codegen.generate(doc, latex=True)
    lines = gen.source.split("\n")

    def text(eid):
        (l, c, el, ec), = gen.spans[eid]
        return lines[l - 1][c:ec] if l == el else "\n".join([lines[l - 1][c:], *lines[l:el - 1], lines[el - 1][:ec]])

    by = {o["name"]: o["id"] for o in doc["objects"]}
    assert text(by["b"]) == 'b = Text("é b")'
    one, lagged, wait = doc["timeline"]
    assert [text(a["id"]) for a in one["anims"]] == ["FadeIn(a)", "Write(b)"]  # characters, not utf-8 bytes
    assert text(lagged["id"]).startswith("self.play(\n") and text(lagged["id"]).endswith(")")
    group = lagged["anims"][0]
    assert text(group["id"]) == "LaggedStart(FadeOut(a), b.animate.shift(UP), lag_ratio=0.5)"
    assert [text(a["id"]) for a in group["anims"]] == ["FadeOut(a)", "b.animate.shift(UP)"]
    assert text(wait["id"]) == "self.wait()"
    wait["comment"] = "# rest"  # a statement's block starts at its comment
    gen = codegen.generate(doc, latex=True)
    lines = gen.source.split("\n")
    assert text(wait["id"]) == "# rest\n        self.wait()"


def test_an_unused_import_at_the_top_stays_as_written():
    src = ("from manim import *\nfrom manim.utils.rate_functions import ease_in_sine\n\nclass S(Scene):\n"
           "    def construct(self):\n        self.wait()\n")
    doc = import_code(src).doc
    assert codegen.generate(doc, latex=True).source == src
