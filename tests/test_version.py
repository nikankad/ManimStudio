"""Release channels: which builds look for which updates."""

import pytest

from mathengine import version

SHA_A, SHA_B = "a" * 40, "b" * 40


@pytest.fixture
def build(monkeypatch):
    def make(channel, ver="0.2.0", commit=SHA_A, releases=None):
        monkeypatch.setattr(version, "CHANNEL", channel)
        monkeypatch.setattr(version, "VERSION", ver)
        monkeypatch.setattr(version, "COMMIT", commit)
        monkeypatch.delenv("MATHENGINE_NO_UPDATE_CHECK", raising=False)
        calls = []

        def fake_get(url, timeout):
            calls.append(url)
            if releases is None:
                raise OSError("offline")
            return releases[url.rsplit("/", 1)[-1]]

        monkeypatch.setattr(version, "_get", fake_get)
        return calls
    return make


def test_stable_sees_newer_stable_only(build):
    rel = {"latest": {"tag_name": "v0.10.0", "html_url": "https://github.com/nikankad/MathEngine/releases/tag/v0.10.0"}}
    build("stable", "0.9.3", releases=rel)
    u = version.check_for_update()
    assert u["available"] and u["latest"] == "0.10.0" and u["url"].endswith("v0.10.0")  # numeric, not text, comparison
    build("stable", "0.10.0", releases=rel)
    assert not version.check_for_update()["available"]


def test_nightly_sees_a_build_of_another_commit(build):
    rel = {"nightly": {"name": "MathEngine nightly 0.2.0-nightly.9", "body": f"> Built from {SHA_B}.",
                       "html_url": "https://github.com/nikankad/MathEngine/releases/tag/nightly"}}
    build("nightly", "0.2.0-nightly.8", commit=SHA_A, releases=rel)
    u = version.check_for_update()
    assert u["available"] and u["latest"] == "nightly 0.2.0-nightly.9"
    build("nightly", "0.2.0-nightly.9", commit=SHA_B, releases=rel)
    assert not version.check_for_update()["available"]


def test_source_installs_and_opt_out_never_ask(build, monkeypatch):
    calls = build("dev")
    assert not version.check_for_update()["available"] and calls == []
    calls = build("stable")
    monkeypatch.setenv("MATHENGINE_NO_UPDATE_CHECK", "1")
    assert not version.check_for_update()["available"] and calls == []


def test_offline_is_no_update(build):
    build("stable", releases=None)
    assert version.check_for_update()["available"] is False


def test_only_this_projects_release_pages_open():
    assert version.release_page("https://github.com/nikankad/MathEngine/releases/tag/v1.0.0")
    assert not version.release_page("https://example.com/releases")
    assert not version.release_page("file:///etc/passwd")
