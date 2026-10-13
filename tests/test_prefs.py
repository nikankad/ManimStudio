"""Preferences kept with the app (the editor's own browser storage is empty at every launch)."""

import pytest

from mathengine import prefs
from mathengine.server import AppState, Handler


@pytest.fixture(autouse=True)
def _app_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("MANIM_STUDIO_HOME", str(tmp_path / "home"))


def test_preferences_are_remembered_and_forgotten():
    assert prefs.load() == {}
    prefs.set_pref("mathengine.welcomed", "1")
    prefs.set_pref("mathengine.timelineHeight", "300")
    assert prefs.load() == {"mathengine.welcomed": "1", "mathengine.timelineHeight": "300"}
    assert prefs.set_pref("mathengine.welcomed", None) == {"mathengine.timelineHeight": "300"}
    assert prefs.load() == {"mathengine.timelineHeight": "300"}


def test_bad_names_and_values_are_refused():
    for key in ("", "a b", "../x", "x" * 65, 3, None):
        with pytest.raises(ValueError):
            prefs.set_pref(key, "1")
    for value in (1, ["a"], "x" * (prefs.MAX_VALUE + 1)):
        with pytest.raises(ValueError):
            prefs.set_pref("ok", value)
    assert prefs.load() == {}


def test_changes_from_several_threads_are_all_kept():
    import threading

    names = [f"ui.switch{i}" for i in range(40)]
    threads = [threading.Thread(target=prefs.set_pref, args=(n, "1")) for n in names]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(prefs.load()) == sorted(names)


def test_a_damaged_file_means_defaults(tmp_path):
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "prefs.json").write_text("{not json", encoding="utf-8")
    assert prefs.load() == {}
    (tmp_path / "home" / "prefs.json").write_text('{"a": "1", "b": 2, "c": ["x"]}', encoding="utf-8")
    assert prefs.load() == {"a": "1"}  # only string values
    assert prefs.set_pref("d", "4") == {"a": "1", "d": "4"}


def test_the_server_serves_and_updates_them():
    handler = object.__new__(Handler)
    handler.app = AppState(None)
    assert handler.api_prefs({}, {}) == {"prefs": {}}
    assert handler.api_set_pref({}, {"key": "mathengine.checkUpdates", "value": "off"}) == {"prefs": {"mathengine.checkUpdates": "off"}}
    assert handler.api_prefs({}, {}) == {"prefs": {"mathengine.checkUpdates": "off"}}
