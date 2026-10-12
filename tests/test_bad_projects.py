"""Files that aren't (or aren't quite) projects: clear messages, and the editor never starts from a broken document."""

import json

import pytest

from mathengine.project import ProjectError, load_project, new_project
from mathengine.server import AppState, Handler


@pytest.fixture(autouse=True)
def _app_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("MANIM_STUDIO_HOME", str(tmp_path / "home"))


def write(tmp_path, name, data):
    path = tmp_path / name
    path.write_bytes(data if isinstance(data, bytes) else json.dumps(data).encode())
    return path


@pytest.mark.parametrize("name, data, expect", [
    ("empty.manimstudio", b"", "is empty"),
    ("blank.manimstudio", b"  \n ", "is empty"),
    ("garbage.manimstudio", b"this is not json", "aren't valid project data"),
    ("binary.manimstudio", bytes(range(128, 256)) * 4, "isn't a text file"),
    ("list.manimstudio", [1, 2, 3], "doesn't hold a scene"),
    ("number.manimstudio", 7, "doesn't hold a scene"),
])
def test_a_file_that_is_not_a_project_says_so(tmp_path, name, data, expect):
    with pytest.raises(ProjectError) as err:
        load_project(write(tmp_path, name, data))
    assert name in str(err.value) and expect in str(err.value)


def test_a_missing_file_and_a_newer_format(tmp_path):
    with pytest.raises(ProjectError, match="doesn't exist any more"):
        load_project(tmp_path / "gone.manimstudio")
    with pytest.raises(ValueError, match="newer Manim Studio"):
        load_project(write(tmp_path, "newer.manimstudio", {"version": 99}))


def test_wrong_kinds_of_values_fall_back_to_empty(tmp_path):
    doc = load_project(write(tmp_path, "nulls.manimstudio", {
        "version": 4, "objects": None, "timeline": "oops", "markers": 3, "constructions": {}, "scene": [], "header": 5, "config": None,
    }))
    assert doc["objects"] == [] and doc["timeline"] == [] and doc["markers"] == [] and doc["constructions"] == []
    assert doc["scene"] == new_project()["scene"] and doc["header"] == "" and doc["config"] == new_project()["config"]


def handler(path):
    out = object.__new__(Handler)
    out.app = AppState(str(path))
    return out


def test_launching_with_a_broken_file_starts_at_home_with_the_reason(tmp_path):
    bad = write(tmp_path, "broken.manimstudio", b"{")
    r = handler(bad).api_project_initial({}, {})
    assert r["home"] is True and r["path"] is None and r["missing"] is None
    assert "broken.manimstudio" in r["error"] and "isn't a Manim Studio project" in r["error"]
    py = tmp_path / "scene.py"
    py.write_text("class A(Scene):\n    def construct(self:\n        pass\n", encoding="utf-8")
    r = handler(py).api_project_initial({}, {})
    assert r["home"] is True and r["error"].startswith("scene.py: ")


def test_errors_meant_for_people_go_out_without_a_type_prefix():
    import threading
    import urllib.error
    import urllib.request

    from mathengine.server import make_server

    server, app = make_server(None, 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        def post(path, body):
            req = urllib.request.Request(f"http://127.0.0.1:{server.server_address[1]}{path}?token={app.token}", data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
            try:
                return json.load(urllib.request.urlopen(req))
            except urllib.error.HTTPError as exc:
                return json.load(exc)

        assert post("/api/project/open", {"path": "/nonexistent/x.manimstudio"})["error"].startswith("x.manimstudio doesn't exist")
        assert post("/api/recovery/open", {"id": "../x"})["error"] == "bad recovery id"
        assert post("/api/prefs", {"key": "a b", "value": "1"})["error"] == "bad preference name"
    finally:
        server.shutdown()
