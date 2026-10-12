"""Showing a finished export in the file manager, or playing it."""

from pathlib import Path

from mathengine import opener


def test_commands_per_platform():
    p = Path("/videos/scene.mp4")
    assert opener.command(p, True, "darwin") == ["open", "-R", str(p)]
    assert opener.command(p, False, "darwin") == ["open", str(p)]
    assert opener.command(p, True, "win32") == ["explorer", f"/select,{p}"]
    assert opener.command(p, False, "win32") is None  # os.startfile
    assert opener.command(p, True, "linux") == ["xdg-open", str(p.parent)]
    assert opener.command(p, False, "linux") == ["xdg-open", str(p)]


def test_open_path_launches_the_command_and_refuses_missing_files(tmp_path, monkeypatch):
    launched = []
    monkeypatch.setattr(opener.subprocess, "Popen", lambda cmd, **kw: launched.append(cmd))
    monkeypatch.setattr(opener.sys, "platform", "linux")
    video = tmp_path / "out.mp4"
    assert opener.open_path(video) is False and not launched  # not written
    video.write_bytes(b"x")
    assert opener.open_path(video, reveal=True) is True
    assert launched == [["xdg-open", str(tmp_path)]]


def test_reveal_only_serves_finished_render_jobs(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from mathengine.server import AppState, Handler

    opened = []
    monkeypatch.setattr(opener, "open_path", lambda path, reveal=False: opened.append((path, reveal)) or True)
    video = tmp_path / "out.mp4"
    handler = object.__new__(Handler)
    handler.app = AppState(None)
    handler.app.jobs = {
        "done1": SimpleNamespace(state="done", result=video),
        "busy1": SimpleNamespace(state="running", result=None),
    }
    assert handler.api_reveal({}, {"id": "nope", "how": "open"}) == {"ok": False}  # no such job
    assert handler.api_reveal({}, {"id": "busy1", "how": "open"}) == {"ok": False}  # not finished
    assert handler.api_reveal({}, {"id": str(video), "how": "open"}) == {"ok": False}  # a path is not a job
    assert not opened
    assert handler.api_reveal({}, {"id": "done1", "how": "show"}) == {"ok": True}
    assert opened == [(video, True)]


def test_open_path_reports_a_missing_launcher(tmp_path, monkeypatch):
    def fail(*a, **k):
        raise FileNotFoundError("xdg-open")

    monkeypatch.setattr(opener.subprocess, "Popen", fail)
    monkeypatch.setattr(opener.sys, "platform", "linux")
    video = tmp_path / "out.mp4"
    video.write_bytes(b"x")
    assert opener.open_path(video) is False
