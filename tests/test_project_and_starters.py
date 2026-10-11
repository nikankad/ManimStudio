import json

import pytest

from conftest import needs_latex
from mathengine import codegen, runtime, starters
from mathengine.project import FORMAT_VERSION, load_project, save_project, upgrade


def test_v2_project_upgrades(tmp_path):
    src = json.loads(open(__file__.replace("tests/test_project_and_starters.py", "examples/sine_tracker.manimstudio")).read())
    assert src["version"] == 2
    up = upgrade(json.loads(json.dumps(src)))
    assert up["version"] == FORMAT_VERSION == 4
    assert up["constructions"] == [] and "clips" not in up and "tracks" not in up
    # Objects and Python sources are untouched; clips became the statements they compiled to.
    assert up["objects"] == src["objects"] and up["header"] == src["header"]
    assert [s["kind"] for s in up["timeline"]][:2] == ["play", "play"]
    r = runtime.run(up, None, render=False)
    assert r.error is None, r.error and r.error["trace"]
    p = tmp_path / "x.mathengine"
    save_project(p, up)
    assert load_project(p) == up


def test_v1_steps_still_upgrade():
    up = upgrade({"version": 1, "objects": [], "steps": [{"id": "s1", "kind": "wait", "duration": 2}]})
    assert up["version"] == 4 and up["timeline"] == [{"id": up["timeline"][0]["id"], "kind": "wait", "args": {"duration": "2"}}]


def test_newer_format_is_refused():
    with pytest.raises(ValueError):
        upgrade({"version": FORMAT_VERSION + 1})


@needs_latex
@pytest.mark.parametrize("template", starters.starters(), ids=lambda t: t["id"])
def test_starters_build_without_diagnostics(template):
    d = starters.as_document(template)
    gen = codegen.generate(d)
    assert gen.diagnostics == []
    ids = {o["id"] for o in template["objects"]}
    for inp in template["inputs"]:
        assert all(t["object"] in ids for t in inp["targets"])
    for t in (0.0, 2.2, 10.0):
        r = runtime.run(d, t, render=True, preview_width=320)
        assert r.error is None, r.error and r.error["trace"]


@needs_latex
def test_secant_becomes_tangent():
    d = starters.as_document(starters.secant_to_tangent())
    gen = codegen.generate(d)
    ns = {}
    exec(compile(gen.source, "s", "exec"), ns)
    r = runtime.run(d, 10.0, render=False)
    assert r.values["h"] == pytest.approx(0.01)
