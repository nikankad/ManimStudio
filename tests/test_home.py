"""Home screen: sample projects run cleanly, and recently opened projects are remembered."""

import json
import time
import urllib.request

import pytest

from mathengine import codegen, recent, runtime, samples
from mathengine.project import save_project


@pytest.fixture(autouse=True)
def _app_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("MANIM_STUDIO_HOME", str(tmp_path / "home"))


@pytest.mark.parametrize("sid", [s[0] for s in samples.SAMPLES])
def test_samples_run_without_errors_or_warnings(sid):
    doc = samples.sample(sid)
    assert not codegen.generate(doc).diagnostics
    end = max(c["start"] + c["duration"] for c in doc["clips"])
    for t in (end * 0.5, end):
        r = runtime.run(doc, t, render=False)
        assert r.error is None, r.error and r.error["trace"]
        assert not r.diagnostics


def test_sample_list_has_thumbnails_and_lengths():
    listed = samples.sample_list()
    assert [s["id"] for s in listed] == [s[0] for s in samples.SAMPLES]
    for s in listed:
        assert s["thumbnail"] and s["thumbnail"].startswith("data:image/jpeg;base64,"), s["id"]
        assert s["duration"] > 5


def test_recent_projects_order_thumbnail_missing_and_remove(tmp_path):
    a, b = tmp_path / "a.manimstudio", tmp_path / "b.manimstudio"
    for p in (a, b):
        save_project(p, {"version": 3})
    recent.add(a, "data:image/jpeg;base64,/9j/AA==")
    recent.add(b)
    recent.add(a)  # opened again: first
    items = recent.listing()
    assert [i["name"] for i in items] == ["a", "b"]
    assert items[0]["thumbnail"] == "data:image/jpeg;base64,/9j/AA==" and items[1]["thumbnail"] is None
    assert items[0]["exists"] and items[0]["size"] > 0
    b.unlink()
    assert [i["exists"] for i in recent.listing()] == [True, False]
    recent.remove(str(b.resolve()))
    assert [i["name"] for i in recent.listing()] == ["a"]
    recent.add(a, "data:text/html;base64,PGI+")  # not a JPEG: ignored
    assert recent.listing()[0]["thumbnail"] == "data:image/jpeg;base64,/9j/AA=="


def test_home_endpoints(tmp_path):
    from mathengine.server import make_server
    import threading

    server, app = make_server(None, 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def call(path, body=None):
        req = urllib.request.Request(f"{base}{path}?token={app.token}", data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="GET" if body is None else "POST")
        with urllib.request.urlopen(req) as res:
            return json.load(res)

    try:
        assert call("/api/project/initial")["home"] is True
        opened = call("/api/samples/open", {"id": "orthocenter"})
        assert opened["path"] is None and opened["doc"]["scene"]["name"] == "Orthocenter"
        path = str(tmp_path / "mine.manimstudio")
        call("/api/project/save", {"path": path, "doc": opened["doc"]})
        home = call("/api/home")
        assert [r["name"] for r in home["recent"]] == ["mine"] and len(home["samples"]) == len(samples.SAMPLES)
        for _ in range(100):  # the preview is made in the background
            if call("/api/home")["recent"][0]["thumbnail"]:
                break
            time.sleep(0.1)
        assert call("/api/home")["recent"][0]["thumbnail"].startswith("data:image/jpeg;base64,")
        assert call("/api/recent/remove", {"path": home["recent"][0]["path"]})["recent"] == []
    finally:
        server.shutdown()


def test_missing_project_file_starts_at_home(tmp_path):
    from mathengine.server import make_server
    import threading

    server, app = make_server(str(tmp_path / "gone.mathengine"), 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{server.server_address[1]}/api/project/initial?token={app.token}")
        with urllib.request.urlopen(req) as res:
            r = json.load(res)
        assert r["home"] is True and r["path"] is None and r["missing"].endswith("gone.mathengine")
    finally:
        server.shutdown()
