"""A render killed midway leaves a cut-off partial movie in manim's cache; it must not break the renders after it."""

import time

import pytest

from conftest import anim, doc, obj, play
from mathengine import render


def write_movie(path, frames=5):
    import av

    path.parent.mkdir(parents=True, exist_ok=True)
    with av.open(str(path), "w") as container:
        stream = container.add_stream("libx264", rate=30)
        stream.width, stream.height, stream.pix_fmt = 64, 48, "yuv420p"
        for _ in range(frames):
            for packet in stream.encode(av.VideoFrame(64, 48, "yuv420p")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def test_a_cut_off_movie_is_not_readable(tmp_path):
    good = tmp_path / "good.mp4"
    write_movie(good)
    assert render.partial_movie_readable(good)
    cut = tmp_path / "cut.mp4"
    cut.write_bytes(good.read_bytes()[: good.stat().st_size // 2])  # no index at the end: what a killed render leaves
    assert not render.partial_movie_readable(cut)
    empty = tmp_path / "empty.mp4"
    empty.write_bytes(b"")
    assert not render.partial_movie_readable(empty)
    assert not render.partial_movie_readable(tmp_path / "missing.mp4")


def test_only_the_broken_partials_are_purged(tmp_path):
    folder = tmp_path / "media" / "videos" / "scene" / "480p30" / "partial_movie_files" / "MyScene"
    good, bad = folder / "aaa.mp4", folder / "bbb.mp4"
    write_movie(good)
    bad.write_bytes(good.read_bytes()[:300])
    final = tmp_path / "media" / "videos" / "scene" / "480p30" / "preview.mp4"
    write_movie(final)  # not a partial: left alone even if it were broken
    assert render.purge_broken_partials(tmp_path / "media") == 1
    assert good.exists() and not bad.exists() and final.exists()
    assert render.purge_broken_partials(tmp_path / "media") == 0


def test_a_render_recovers_from_a_damaged_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(render, "cache_root", lambda: tmp_path / "cache")
    d = doc([obj("o1", "square", "Square")], [play(anim("a1", "FadeIn", "square"))])

    def run():
        job = render.RenderJob(d, "preview", None, "cache-test", plays=1)
        job.start()
        deadline = time.time() + 240
        while job.state in ("queued", "running") and time.time() < deadline:
            time.sleep(0.5)
        return job

    first = run()
    assert first.state == "done", first.message
    partials = list(first.workdir.glob("media/videos/**/partial_movie_files/**/*.mp4"))
    assert partials, "manim cached the animation"
    damaged = partials[0]
    damaged.write_bytes(damaged.read_bytes()[:200])  # as if the first render had been killed while writing it
    second = run()
    assert second.state == "done", second.message
    assert render.partial_movie_readable(damaged), "the damaged piece was made again"
