"""A render killed midway leaves a cut-off partial movie in manim's cache; it must not break the renders after it."""

import time

import pytest

from conftest import anim, doc, obj, play
from mathengine import render
from mathengine.importer import import_code


def test_concurrent_project_renders_keep_their_own_script_and_video(tmp_path, monkeypatch):
    import threading
    import av

    monkeypatch.setattr(render, "cache_root", lambda: tmp_path / "cache")

    def scene(color, duration):
        return import_code(f"""from manim import *
class S(Scene):
    def construct(self):
        square = Square(color={color}, fill_opacity=1)
        self.add(square)
        self.wait({duration})
""").doc

    first = render.RenderJob(scene("RED", 0.2), "preview", None, "same-project")
    second = render.RenderJob(scene("BLUE", 0.4), "preview", None, "same-project")
    started, release, attempted = threading.Event(), threading.Event(), threading.Event()
    pump = render.RenderJob._pump

    def hold_first(job, proc):
        if job is first:
            started.set()
            assert release.wait(30)
        pump(job, proc)

    monkeypatch.setattr(render.RenderJob, "_pump", hold_first)
    a = threading.Thread(target=first._run_registered)

    def run_second():
        attempted.set()
        second._run_registered()

    b = threading.Thread(target=run_second)
    a.start()
    try:
        assert started.wait(30)
        b.start()
        assert attempted.wait(5)
        b.join(0.5)
        assert second.state == "queued", "same-project jobs must wait before touching the shared script/cache"
    finally:
        release.set()
        a.join(60)
        if b.ident is not None:
            b.join(60)
        if a.is_alive() or b.is_alive():
            first.cancel()
            second.cancel()
    assert first.state == second.state == "done", (first.message, second.message)
    assert first.result != second.result
    for job, frames, dominant in [(first, 6, 0), (second, 12, 2)]:
        with av.open(str(job.result)) as movie:
            images = [f.to_ndarray(format="rgb24") for f in movie.decode(video=0)]
        assert len(images) == frames
        pixel = images[-1][240, 427]
        assert int(pixel[dominant]) > int(pixel[2 - dominant]) + 50


def test_cancel_before_start_does_not_launch_or_revive_job(tmp_path, monkeypatch):
    monkeypatch.setattr(render, "cache_root", lambda: tmp_path / "cache")
    def unexpected_spawn(*args, **kwargs):
        pytest.fail("a cancelled job launched Manim")
    monkeypatch.setattr(render.subprocess, "Popen", unexpected_spawn)
    job = render.RenderJob(doc([]), "preview", None, "cancelled-project")
    job.cancel()
    job._run_registered()
    assert job.state == "cancelled"
    assert not job.workdir.exists()


@pytest.mark.parametrize('quality,expected', [('preview', (854, 480, 30)), ('project', (400, 300, 15))])
def test_selected_quality_overrides_imported_python_config(tmp_path, monkeypatch, quality, expected):
    """An imported module runs after manim parses its CLI flags; it must not undo the export dialog."""
    import av

    monkeypatch.setattr(render, 'cache_root', lambda: tmp_path / 'cache')
    source = '''from manim import *
config.pixel_width = 320
config.pixel_height = 240
config.frame_rate = 12

class S(Scene):
    def construct(self):
        square = Square()
        self.play(FadeIn(square), run_time=0.2)

config.frame_rate = 10
'''
    d = import_code(source).doc
    d['config'].update(pixel_width=400, pixel_height=300, frame_rate=15)
    # Keep the original top-level Python intact, as the importer normally does.
    job = render.RenderJob(d, quality, None, 'quality-test')
    job.start()
    deadline = time.monotonic() + 120
    while job.state in ('queued', 'running') and time.monotonic() < deadline:
        time.sleep(0.1)
    if job.state in ('queued', 'running'):
        job.cancel()
    assert job.state == 'done', job.message + '\n' + job.log
    with av.open(str(job.result)) as movie:
        video = movie.streams.video[0]
        assert (video.width, video.height, float(video.average_rate)) == expected


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


def test_the_cache_does_not_grow_for_ever(tmp_path):
    import os

    folder = tmp_path / "media" / "videos" / "scene" / "480p30" / "partial_movie_files" / "S"
    folder.mkdir(parents=True)
    now = 1_000_000_000.0
    files = {}
    for name, age_days, size in [("old", 20, 100), ("a", 5, 400), ("b", 3, 400), ("c", 1, 400)]:
        f = folder / f"{name}.mp4"
        f.write_bytes(b"x" * size)
        os.utime(f, (now - age_days * 86400, now - age_days * 86400))
        files[name] = f
    # by age: only the one nobody has rendered for two weeks goes
    assert render.prune_cache(tmp_path / "media", max_age=14 * 86400, max_bytes=10_000, now=now) == 1
    assert not files["old"].exists() and all(files[n].exists() for n in "abc")
    # by size: the oldest go until the rest fits
    assert render.prune_cache(tmp_path / "media", max_age=14 * 86400, max_bytes=900, now=now) == 1
    assert not files["a"].exists() and files["b"].exists() and files["c"].exists()
    assert render.prune_cache(tmp_path / "media", max_age=14 * 86400, max_bytes=900, now=now) == 0


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
