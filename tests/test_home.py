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
    end = runtime.run(doc, None, render=False).duration
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
        assert [r["name"] for r in home["recent"]] == ["mine"] and "samples" not in home  # Home doesn't wait for them
        assert len(call("/api/samples")["samples"]) == len(samples.SAMPLES)
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


def test_saving_an_unchanged_project_does_not_render_its_preview_again(tmp_path):
    from mathengine.server import AppState, Handler

    handler = object.__new__(Handler)
    handler.app = AppState(None)
    path = str(tmp_path / "talk.manimstudio")
    doc = {"version": 4, "objects": [], "timeline": []}
    save_project(path, doc)
    assert handler._wants_thumbnail(path, doc) is True  # never had one
    assert handler._wants_thumbnail(path, doc) is True  # still none on disk (the render may have failed): try again
    recent.add(path, "data:image/jpeg;base64,/9j/AA==")  # saving lists the project on Home, with its preview
    assert handler._wants_thumbnail(path, doc) is False  # the preview matches this document
    assert handler._wants_thumbnail(path, {**doc, "objects": [{"id": "o1"}]}) is True  # edited: a new one
    recent.remove(path)
    assert handler._wants_thumbnail(path, {**doc, "objects": [{"id": "o1"}]}) is True  # removed from Home: make it again


def test_recovery_keeps_unsaved_work_until_cleared(tmp_path):
    from mathengine import recovery

    assert recovery.listing() == []
    doc = {"version": 4, "scene": {"name": "Demo"}}
    recovery.save("abc123456", None, doc)
    recovery.save("def123456", str(tmp_path / "talk.manimstudio"), {**doc, "scene": {"name": "Talk"}})
    items = recovery.listing()
    assert {i["id"]: (i["name"], i["scene"]) for i in items} == {"abc123456": ("Untitled", "Demo"), "def123456": ("talk", "Talk")}
    assert all("doc" not in i for i in items)
    assert recovery.load("abc123456")["doc"] == doc
    recovery.clear("abc123456")
    recovery.clear("abc123456")  # already gone
    assert [i["id"] for i in recovery.listing()] == ["def123456"]
    assert recovery.load("abc123456") is None


def test_recovery_is_found_by_project_path(tmp_path):
    from mathengine import recovery

    a, b = tmp_path / "a.manimstudio", tmp_path / "b.manimstudio"
    recovery.save("aaaa11111", str(a), {"scene": {"name": "A"}})
    recovery.save("bbbb11111", str(b), {"scene": {"name": "B"}})
    recovery.save("cccc11111", None, {"scene": {"name": "C"}})
    assert [e["id"] for e in recovery.for_path(a)] == ["aaaa11111"]
    assert [e["id"] for e in recovery.for_path(tmp_path / "sub" / ".." / "b.manimstudio")] == ["bbbb11111"]
    assert recovery.for_path(tmp_path / "other.manimstudio") == []


def test_recovery_ids_cannot_leave_the_folder_and_old_copies_go(monkeypatch):
    from mathengine import recovery

    clock = iter(range(1_000_000, 2_000_000))  # a clock that always moves on (Windows' can tick coarsely)
    monkeypatch.setattr(recovery.time, "time", lambda: next(clock))
    for bad in ("../x", "a/b", "", "short"):
        with pytest.raises(ValueError):
            recovery.save(bad, None, {})
    for i in range(recovery.LIMIT + 3):
        recovery.save(f"session{i:04d}", None, {"scene": {"name": str(i)}})
    kept = recovery.listing()
    assert len(kept) == recovery.LIMIT
    assert kept[0]["scene"] == str(recovery.LIMIT + 2)  # the newest survives
