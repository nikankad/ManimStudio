"""Closing the native window asks first when the project has unsaved changes."""

from types import SimpleNamespace

from mathengine.__main__ import close_allowed
from mathengine.server import AppState, Handler


def asked(answer):
    calls = []

    def confirm(title, message):
        calls.append((title, message))
        if isinstance(answer, Exception):
            raise answer
        return answer

    return confirm, calls


def test_a_saved_project_closes_without_asking():
    confirm, calls = asked(False)
    assert close_allowed(SimpleNamespace(dirty=False), confirm) is True
    assert not calls


def test_unsaved_changes_ask_and_the_answer_decides():
    confirm, calls = asked(False)
    assert close_allowed(SimpleNamespace(dirty=True), confirm) is False  # stay
    assert len(calls) == 1 and calls[0][0] == "Unsaved changes"
    assert close_allowed(SimpleNamespace(dirty=True), asked(True)[0]) is True  # close anyway


def test_a_dialog_that_fails_or_says_nothing_never_traps_the_user():
    assert close_allowed(SimpleNamespace(dirty=True), asked(None)[0]) is True
    assert close_allowed(SimpleNamespace(dirty=True), asked(RuntimeError("no GUI"))[0]) is True


def test_the_page_reports_whether_the_project_is_unsaved():
    handler = object.__new__(Handler)
    handler.app = AppState(None)
    assert handler.app.dirty is False
    handler.api_title({}, {"title": "• talk - Manim Studio", "dirty": True})
    assert handler.app.dirty is True
    handler.api_title({}, {"title": "talk - Manim Studio", "dirty": False})
    assert handler.app.dirty is False
