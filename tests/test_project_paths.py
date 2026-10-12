"""Old launch and recent paths still open projects renamed to .manimstudio."""

import json

import pytest

from mathengine import recent
from mathengine.project import load_project, new_project, save_project
from mathengine.server import AppState, Handler


@pytest.fixture
def renamed_project(tmp_path, monkeypatch):
    monkeypatch.setenv("MANIM_STUDIO_HOME", str(tmp_path / "home"))
    path = tmp_path / "sine_tracker.manimstudio"
    doc = new_project()
    doc["scene"]["name"] = "SineTracker"
    save_project(path, doc)
    return path, path.with_suffix(".mathengine"), doc


def handler(path=None):
    out = object.__new__(Handler)
    out.app = AppState(str(path) if path is not None else None)
    return out


def test_startup_opens_renamed_legacy_project(renamed_project):
    path, old_path, doc = renamed_project
    app = handler(old_path)
    response = app.api_project_initial({}, {})
    assert response["home"] is False
    assert response["path"] == str(path)
    assert response["doc"] == doc
    assert "missing" not in response
    assert app.app.project_path == str(path)
    assert recent.listing()[0]["path"] == str(path)


def test_open_and_cli_loading_resolve_renamed_legacy_project(renamed_project):
    path, old_path, doc = renamed_project
    app = handler()
    response = app.api_project_open({}, {"path": str(old_path)})
    assert response == {"doc": doc, "path": str(path)}
    assert app.app.project_path == str(path)
    assert load_project(old_path) == doc


def test_existing_legacy_project_takes_precedence(renamed_project):
    _, old_path, _ = renamed_project
    doc = new_project()
    doc["scene"]["name"] = "OriginalLegacyProject"
    save_project(old_path, doc)
    assert load_project(old_path) == doc
    assert handler(old_path).api_project_initial({}, {})["path"] == str(old_path)


def test_unrelated_missing_project_still_starts_at_home(tmp_path, monkeypatch):
    monkeypatch.setenv("MANIM_STUDIO_HOME", str(tmp_path / "home"))
    old_path = tmp_path / "gone.mathengine"
    response = handler(old_path).api_project_initial({}, {})
    assert response["home"] is True
    assert response["path"] is None
    assert response["missing"] == str(old_path)
    with pytest.raises(FileNotFoundError):
        load_project(old_path)


def test_recent_legacy_path_opens_renamed_file_and_can_be_removed(renamed_project):
    path, old_path, _ = renamed_project
    recent.add(old_path)
    # Simulate a recent entry persisted before the project was renamed.
    recent_file = recent.app_dir() / "recent.json"
    entries = json.loads(recent_file.read_text())
    entries["projects"][0]["path"] = str(old_path)
    recent_file.write_text(json.dumps(entries))
    item = recent.listing()[0]
    assert item["exists"] is True
    assert item["path"] == str(path)
    recent.add(path)
    assert len(recent.listing()) == 1
    recent.remove(str(path))
    assert recent.listing() == []
