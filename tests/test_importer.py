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
    assert "def helper(x)" in doc["header"] and "class Camera" in doc["header"] and "from manim import" not in doc["header"]
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
