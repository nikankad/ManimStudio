"""Browser checks for everyday workflow: recovery, leaving a project, shortcuts, preferences, the toolbar's fit.

Unlike ui_smoke.py (which drives the drawing tools) this starts its own editor server for every scenario, with a
temporary app folder and no project, so scenarios don't see each other's saves. Needs Playwright and a Chromium:

    uv pip install playwright
    python scripts/ui_workflow.py [scenario ...]        # no names: all of them

Environment: CHROMIUM (a Chromium executable, optional), AXE_JS (path to axe.min.js from the axe-core package: adds
an accessibility scenario), SKIP_EXPORT=1 (leave out the scenario that renders a video).
"""
import glob
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from contextlib import contextmanager

from playwright.sync_api import sync_playwright

CHROMIUM = os.environ.get("CHROMIUM") or None


@contextmanager
def editor(project=None):
    """A fresh editor server (opened on ``project`` when given): (url, app folder). Stops it afterwards."""
    home = tempfile.mkdtemp(prefix="manim-studio-ui-")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "MANIM_STUDIO_HOME": home, "MATHENGINE_NO_UPDATE_CHECK": "1"}
    proc = subprocess.Popen([sys.executable, "-m", "mathengine", "--serve", "--port", str(port), *([project] if project else [])], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}/"
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(url, timeout=1).read()
                break
            except OSError:
                time.sleep(0.5)
        else:
            raise RuntimeError("the editor server didn't start")
        yield url, home
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def page_in(browser, url, width=1500, height=900):
    ctx = browser.new_context(viewport={"width": width, "height": height})  # a new profile: empty browser storage
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(url)
    pg.wait_for_selector(".home, .toolbar", timeout=30000)
    pg.wait_for_timeout(500)
    return ctx, pg


def new_project(pg, name=None):
    pg.get_by_text("New project…").first.click()
    dlg = pg.get_by_role("dialog", name="New project")
    if name:
        pg.keyboard.type(name)
    dlg.get_by_role("button", name="Create", exact=True).click()
    pg.wait_for_selector(".toolbar")
    pg.wait_for_timeout(800)


def add(pg, cls):
    pg.locator(".lib-item", has_text=cls).first.dblclick()
    pg.wait_for_timeout(700)


def clips(pg):
    """Animation clips on the timeline (not pauses or the strip of other steps)."""
    return pg.locator(".tl-lanes .clip.anim").count()


# ---------------------------------------------------------------------------------------------------- scenarios


def recovery(b):
    """Unsaved changes survive a crash, come back from Home, and go away when saved."""
    with editor() as (url, home):
        save_to = os.path.join(home, "talk.manimstudio")
        copies = lambda: glob.glob(os.path.join(home, "recovery", "*.json"))
        ctx, pg = page_in(b, url)
        pg.on("dialog", lambda d: d.accept(save_to if d.type == "prompt" else None))
        new_project(pg)
        assert not copies(), "nothing to keep before an edit"
        add(pg, "Circle")
        pg.wait_for_timeout(3500)
        assert len(copies()) == 1, "the edit was copied to the app folder"
        pg.get_by_text("⌂ Home").click()
        pg.wait_for_timeout(1500)
        assert pg.get_by_text("Unsaved work").count() == 0, "Home doesn't list the project that is open right now"
        ctx.close()  # the crash
        ctx, pg = page_in(b, url)
        pg.on("dialog", lambda d: d.accept(save_to if d.type == "prompt" else None))
        assert pg.get_by_text("Unsaved work").count() == 1
        pg.get_by_role("button", name="Restore").click()
        pg.wait_for_timeout(2500)
        assert pg.title().startswith("•"), pg.title()
        pg.keyboard.press("Control+s")
        pg.wait_for_timeout(2500)
        assert os.path.exists(save_to) and not copies(), "saving removes the copy"
        # a saved project edited and then lost: opening its file offers the changes
        add(pg, "Square")
        pg.wait_for_timeout(3500)
        assert len(copies()) == 1
        ctx.close()
        ctx, pg = page_in(b, url)  # the server reopens the last saved project, as a launch with that file would
        dlg = pg.get_by_role("alertdialog", name="Unsaved changes found")
        assert dlg.count() == 1, "opening the file offers its unsaved changes"
        dlg.get_by_role("button", name="Keep the saved file").click()
        pg.wait_for_timeout(1200)
        assert not copies()
        assert not pg.errors, pg.errors


def leaving(b):
    """Leaving a project with unsaved changes asks Save / Don't save / Cancel (and Esc / Enter / dialogs behave)."""
    with editor() as (url, home):
        save_to = os.path.join(home, "kept.manimstudio")
        ctx, pg = page_in(b, url)
        pg.on("dialog", lambda d: d.accept(save_to if d.type == "prompt" else None))
        new_project(pg)
        add(pg, "Circle")
        pg.get_by_text("⌂ Home").click()
        pg.wait_for_timeout(1000)
        pg.get_by_text("Riemann sums").first.click()
        assert pg.get_by_role("alertdialog").count() == 1
        pg.get_by_role("button", name="Cancel").click()
        assert pg.get_by_text("← Back to Untitled").count() == 1, "Cancel stays"
        pg.keyboard.press("Escape")  # Esc on Home goes back to the project
        pg.wait_for_timeout(500)
        assert pg.locator(".home").count() == 0
        # New project: Enter creates, the dialog stays open under the question, Save keeps the work
        pg.keyboard.press("Control+n")
        pg.wait_for_timeout(300)
        assert pg.evaluate("document.activeElement.tagName") == "INPUT", "the name is focused"
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(500)
        assert pg.locator(".new-project").count() == 1 and pg.get_by_role("alertdialog").count() == 1
        pg.get_by_role("alertdialog").get_by_role("button", name="Save", exact=True).click()
        pg.wait_for_timeout(2500)
        assert os.path.exists(save_to) and pg.locator(".new-project").count() == 0
        assert not pg.errors, pg.errors


def shortcuts(b):
    """Space plays after mouse use; / and Enter search the library; cut and paste clips."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url)
        new_project(pg)
        playing = lambda: pg.evaluate("document.querySelector('.icon.play').innerText.includes('❚')")
        add(pg, "Circle")
        n = clips(pg)
        pg.keyboard.press("Home")
        pg.keyboard.press("Space")
        pg.wait_for_timeout(300)
        assert clips(pg) == n and playing(), "Space plays (it doesn't add the class again) after a double-click"
        pg.keyboard.press("Space")
        rec = pg.locator(".toolbar").get_by_label("● Record")
        rec.check()
        pg.keyboard.press("Home")
        pg.keyboard.press("Space")
        pg.wait_for_timeout(300)
        assert rec.is_checked() and playing(), "Space plays, not toggles the checkbox that still has focus"
        pg.keyboard.press("Space")
        rec.uncheck()
        pg.keyboard.press("End")  # new objects start at the playhead: at the end they get their own self.play
        # library search: / focuses, Enter adds the top result
        pg.keyboard.press("/")
        assert pg.evaluate("document.activeElement.className") == "search"
        pg.keyboard.type("tria")
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(1200)
        assert pg.locator(".search").input_value() == "" and clips(pg) == n + 1, "Enter added the triangle"
        # keyboard-only: Tab focus + Enter adds
        pg.locator(".lib-item", has_text="Square").first.focus()
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(1000)
        assert clips(pg) == n + 2
        # cut and paste a clip
        before = clips(pg)
        pg.locator(".clip", has_text="Create").last.click()
        pg.keyboard.press("Control+x")
        pg.wait_for_timeout(500)
        assert clips(pg) == before - 1
        pg.keyboard.press("Control+v")
        pg.wait_for_timeout(500)
        assert clips(pg) >= before, "paste puts the clip back (at the playhead, perhaps in a new self.play)"
        assert not pg.errors, pg.errors


def system_keys(b):
    """Ctrl / Alt combinations of single-key shortcuts are left to the system (⌘M minimises; Ctrl+= zooms the page)."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url)
        new_project(pg)
        add(pg, "Circle")
        markers = lambda: pg.locator(".marker").count()
        before = markers()
        pg.keyboard.press("Control+m")
        pg.keyboard.press("Alt+m")
        pg.wait_for_timeout(200)
        assert markers() == before, "Ctrl/Alt+M must not add a marker"
        pg.keyboard.press("m")
        pg.wait_for_timeout(200)
        assert markers() == before + 1, "plain M adds one"
        width = lambda: pg.evaluate("document.querySelector('.tl-lanes .clip.anim').getBoundingClientRect().width")
        w0 = width()
        pg.keyboard.press("Control+=")
        pg.keyboard.press("Control+-")
        pg.wait_for_timeout(200)
        assert width() == w0, "Ctrl+= must not zoom the timeline"
        pg.keyboard.press("=")
        pg.wait_for_timeout(300)
        assert width() > w0 * 1.2, "plain = zooms it"
        assert not pg.errors, pg.errors


def timeline_keys(b):
    """Tab reaches a clip, Enter selects it, Delete removes it, and a mouse click still leaves Space as play."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url)
        new_project(pg)
        add(pg, "Circle")
        add(pg, "Square")
        before = clips(pg)
        clip = pg.locator(".tl-lanes .clip.anim").first
        clip.focus()
        assert pg.evaluate("document.activeElement.classList.contains('clip')")
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(300)
        assert clip.get_attribute("aria-pressed") == "true", "Enter selects the focused clip"
        assert "Effect Controls" in pg.locator(".inspector, aside").last.inner_text()
        pg.keyboard.press("Delete")
        pg.wait_for_timeout(400)
        assert clips(pg) == before - 1, "Delete removed it"
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(300)
        assert clips(pg) == before
        # the mouse still works: a click selects, and Space then plays (it doesn't "press" the focused clip)
        pg.locator(".tl-lanes .clip.anim").last.click()
        pg.keyboard.press("Home")
        pg.keyboard.press("Space")
        pg.wait_for_timeout(300)
        assert pg.evaluate("document.querySelector('.icon.play').innerText.includes('❚')")
        assert not pg.errors, pg.errors


def broken_files(b):
    """A file that isn't a project: launching with it lands on Home with the reason, and so does opening it."""
    bad_dir = tempfile.mkdtemp(prefix="manim-studio-bad-")
    bad = os.path.join(bad_dir, "damaged.manimstudio")
    open(bad, "w").write("{ this is not a project")
    with editor(bad) as (url, home):
        ctx, pg = page_in(b, url)
        assert pg.locator(".home").count() == 1, "starts at Home, not in a blank editor"
        toast = pg.locator(".toast").inner_text()
        assert "damaged.manimstudio" in toast and "isn't a Manim Studio project" in toast, toast
        pg.on("dialog", lambda d: d.accept(bad if d.type == "prompt" else None))
        pg.wait_for_timeout(4500)  # let the first message go
        pg.get_by_role("button", name="Open project…").click()
        pg.wait_for_selector(".toast")
        assert "isn't a Manim Studio project" in pg.locator(".toast").inner_text()
        assert pg.locator(".home").count() == 1
        assert not pg.errors, pg.errors


def early_settings(b):
    """Dialogs opened before manim's catalog has loaded (the first seconds of a launch) don't crash the editor."""
    with editor() as (url, home):
        ctx = b.new_context(viewport={"width": 1500, "height": 900})
        pg = ctx.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.route("**/api/catalog", lambda route: route.abort())  # it never arrives
        pg.goto(url)
        pg.wait_for_selector(".home")
        new_project(pg)
        for name in ["Settings", "Export video"]:
            pg.get_by_role("button", name=name, exact=True).click()
            pg.wait_for_timeout(400)
            assert pg.locator(".modal-back").count() == 1, name
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(400)
            assert pg.locator(".toolbar").count() == 1, f"the editor survived closing {name}"
        pg.get_by_role("button", name="Settings", exact=True).click()
        pg.wait_for_selector(".modal-back")
        pg.locator(".modal").get_by_text("Base class").wait_for()
        assert not pg.errors, pg.errors


def failing_backend(b):
    """With every request but the first load refused or failing, the editor stays up and every dialog opens."""
    keep = ("/api/project/initial", "/api/home", "/api/prefs", "/api/version")
    with editor() as (url, home):
        for mode in ("abort", "500"):
            ctx = b.new_context(viewport={"width": 1500, "height": 900})
            pg = ctx.new_page()
            pg.errors = []
            pg.on("pageerror", lambda e: pg.errors.append(str(e)))

            def handle(route, mode=mode):
                if any(k in route.request.url for k in keep):
                    return route.continue_()
                if mode == "abort":
                    return route.abort()
                return route.fulfill(status=500, content_type="application/json", body='{"error": "boom"}')

            pg.route("**/api/**", handle)
            pg.goto(url)
            pg.wait_for_selector(".home")
            new_project(pg)
            for tab in ["Effects", "Build", "Scene", "Objects"]:
                pg.get_by_role("button", name=tab, exact=True).first.click()
                pg.wait_for_timeout(200)
            for opener in [lambda: pg.locator("[data-tour=graph]").click(),
                           lambda: pg.get_by_role("button", name="Settings", exact=True).click(),
                           lambda: pg.get_by_role("button", name="Export video", exact=True).click(),
                           lambda: pg.get_by_role("button", name="? Help", exact=True).click()]:
                opener()
                pg.wait_for_timeout(400)
                assert pg.locator(".modal-back").count() == 1, f"a dialog opens ({mode})"
                pg.keyboard.press("Escape")
                pg.wait_for_timeout(200)
            pg.get_by_role("button", name="</> Code").click()
            pg.wait_for_timeout(500)
            pg.get_by_role("button", name="Program").click()
            pg.get_by_role("button", name="+ Wait").click()
            pg.wait_for_timeout(300)
            assert pg.locator(".toolbar").count() == 1, f"the editor is still there ({mode})"
            assert not pg.errors, (mode, pg.errors)
            ctx.close()


def dropped_files(b):
    """A file dropped on the window doesn't navigate away: a .py opens as a project, anything else is explained."""
    drop = """([name, text, type]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, {type}));
      const over = new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: dt});
      document.body.dispatchEvent(over);
      const ev = new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt});
      document.body.dispatchEvent(ev);
      return [over.defaultPrevented, ev.defaultPrevented];
    }"""
    code = "from manim import *\n\nclass Dropped(Scene):\n    def construct(self):\n        c = Circle()\n        self.play(Create(c))\n"
    with editor() as (url, home):
        ctx, pg = page_in(b, url)
        assert pg.evaluate(drop, ["photo.png", "x", "image/png"]) == [True, True], "dragover and drop are taken over"
        pg.wait_for_selector(".toast")
        assert "Use Open" in pg.locator(".toast").inner_text()
        assert pg.locator(".home").count() == 1
        assert pg.evaluate(drop, ["scene.py", code, "text/x-python"]) == [True, True]
        pg.wait_for_selector(".toolbar")
        pg.wait_for_timeout(1500)
        assert "Dropped" in pg.locator(".monitor-title").first.inner_text() or "Dropped" in pg.content()
        assert pg.title().startswith("•"), pg.title()
        assert not pg.errors, pg.errors


def timeline_edit(b):
    """Animation groups without a bar: click the shading to select a group, drag clips and groups, trim a pause,
    marquee from inside a group, disable a group from its menu."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        new_project(pg)
        add(pg, "Circle")  # group 1: Create circle, 0-1 s
        add(pg, "Square")  # group 2: Create square, 1-2 s
        pg.get_by_role("button", name="+ Wait").click()  # a pause at the end, 2-3 s
        pg.wait_for_timeout(600)
        label = lambda loc: loc.get_attribute("aria-label")
        start = lambda loc: label(loc).split(", ")[-1].split(" to ")[0]
        square = pg.locator(".tl-lanes .clip.anim", has_text="square")
        circle = pg.locator(".tl-lanes .clip.anim", has_text="circle")
        assert "Create" in square.inner_text() and square.inner_text().index("square") < square.inner_text().index("Create"), \
            "clips read object first"
        assert pg.locator(".track-head", has_text="Statements").count() == 0, "no statement lane"
        assert pg.locator(".tl-lanes .clip.step.pause").count() == 1, "the pause spans the tracks"
        bands = pg.locator(".play-band")
        assert bands.count() == 2

        # 1. click the empty shading of group 1 (below its clip, on track 2): the group is selected
        cb = circle.bounding_box()
        pg.mouse.click(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] + 40)
        pg.wait_for_timeout(300)
        assert bands.nth(0).get_attribute("aria-pressed") == "true", "a click on the shading selects the group"
        assert pg.locator("aside h3").last.inner_text() == "Play together"

        # 2. drag a clip of the selected group: the whole group moves (its start changes)
        before = start(bands.nth(0))
        pg.mouse.move(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(cb["x"] + cb["width"] / 2 + 150, cb["y"] + cb["height"] / 2, steps=8)
        pg.mouse.up()
        pg.wait_for_timeout(500)
        assert start(circle) != "00:00:00:00", ("the group moved", before, start(circle))
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(400)
        assert start(circle) == "00:00:00:00", "undo puts it back"

        # 3. drag a single clip (its group not selected): that clip moves
        pg.mouse.click(5 + pg.locator(".tl-lanes").bounding_box()["x"], pg.locator(".tl-lanes").bounding_box()["y"] + 5)  # deselect
        sb = square.bounding_box()
        s0 = start(square)
        pg.mouse.move(sb["x"] + sb["width"] / 2, sb["y"] + sb["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(sb["x"] + sb["width"] / 2 + 120, sb["y"] + sb["height"] / 2, steps=8)
        pg.mouse.up()
        pg.wait_for_timeout(500)
        assert start(square) != s0, ("the clip moved", s0, start(square))
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(400)
        assert start(square) == s0

        # 4. trim the pause by its right edge
        pause = pg.locator(".tl-lanes .clip.step.pause")
        pb = pause.bounding_box()
        l0 = label(pause)
        pg.mouse.move(pb["x"] + pb["width"] - 3, pb["y"] + 20)
        pg.mouse.down()
        pg.mouse.move(pb["x"] + pb["width"] + 100, pb["y"] + 20, steps=8)
        pg.mouse.up()
        pg.wait_for_timeout(500)
        assert label(pause) != l0 and "Pause" in label(pause), ("the pause got longer", l0, label(pause))

        # 5. a marquee started inside a group's shading selects clips (it isn't swallowed by the band)
        cb = circle.bounding_box()
        sb = square.bounding_box()
        pg.mouse.move(cb["x"] + 5, cb["y"] + cb["height"] + 60)
        pg.mouse.down()
        pg.mouse.move(sb["x"] + sb["width"] - 5, cb["y"] + 2, steps=8)
        pg.mouse.up()
        pg.wait_for_timeout(300)
        assert pg.locator('.tl-lanes .clip.anim[aria-pressed="true"]').count() == 2, "both clips selected"

        # 6. right-click a group's shading: Disable takes its clips away and shows it in the strip; undo restores
        pg.mouse.click(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] + 40, button="right")
        pg.locator(".menu-item", has_text="Disable").click()
        pg.wait_for_timeout(500)
        assert clips(pg) == 1 and pg.locator(".steps-lane").count() == 1, "disabled group: out of the tracks, into the strip"
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(500)
        assert clips(pg) == 2 and pg.locator(".steps-lane").count() == 0

        # 7. a selected group moves as one: with two animations in it, dragging one moves the other too
        pg.keyboard.press("Home")
        add(pg, "Triangle")  # at the start: it joins group 1 (plays with the circle)
        triangle = pg.locator(".tl-lanes .clip.anim", has_text="triangle")
        assert start(triangle) == start(circle) == "00:00:00:00", (start(triangle), start(circle))
        cb = circle.bounding_box()
        pg.mouse.click(cb["x"] + cb["width"] / 2, cb["y"] + 2 * cb["height"] + 60)  # the shading, below both clips
        pg.wait_for_timeout(300)
        assert bands.nth(0).get_attribute("aria-pressed") == "true"
        tb = triangle.bounding_box()
        pg.mouse.move(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(tb["x"] + tb["width"] / 2 + 150, tb["y"] + tb["height"] / 2, steps=8)
        pg.mouse.up()
        pg.wait_for_timeout(500)
        assert start(circle) != "00:00:00:00" and start(circle) == start(triangle), ("moved together", start(circle), start(triangle))
        assert not pg.errors, pg.errors


def preferences(b):
    """What you set up stays between launches (each launch is a new browser profile)."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url, 1700, 900)
        new_project(pg)
        assert pg.locator(".welcome-card").count() == 1
        pg.get_by_role("button", name="Not now").click()
        tb = pg.locator(".toolbar")
        tb.get_by_label("Snap").uncheck()
        tb.get_by_label("Auto-intro").uncheck()
        box = pg.locator(".splitter").bounding_box()
        pg.mouse.move(box["x"] + 300, box["y"] + 2)
        pg.mouse.down()
        pg.mouse.move(box["x"] + 300, box["y"] - 100, steps=5)
        pg.mouse.up()
        pg.wait_for_timeout(600)
        height = pg.evaluate("document.querySelector('[data-tour=timeline]').getBoundingClientRect().height")
        ctx.close()
        ctx, pg = page_in(b, url, 1700, 900)
        if pg.locator(".home").count():
            new_project(pg)
        tb = pg.locator(".toolbar")
        assert pg.locator(".welcome-card").count() == 0, "the welcome card doesn't come back"
        assert not tb.get_by_label("Snap").is_checked() and not tb.get_by_label("Auto-intro").is_checked()
        assert tb.get_by_label("Auto-render").is_checked()
        again = pg.evaluate("document.querySelector('[data-tour=timeline]').getBoundingClientRect().height")
        assert abs(again - height) < 3, (height, again)
        assert json.load(open(os.path.join(home, "prefs.json")))["ui.snap"] == "0"


def toolbar(b):
    """Export, Settings and Help stay in view at every window width, with a long project name too."""
    with editor() as (url, home):
        long_name = os.path.join(home, "an_extremely_long_project_name_for_a_talk_2026.manimstudio")
        ctx, pg = page_in(b, url, 1700, 800)
        pg.on("dialog", lambda d: d.accept(long_name if d.type == "prompt" else None))
        new_project(pg)
        pg.keyboard.press("Control+s")
        pg.wait_for_timeout(2000)
        for width in [1700, 1500, 1300, 1100, 1024, 1000, 1200, 1700]:
            pg.set_viewport_size({"width": width, "height": 800})
            pg.wait_for_timeout(400)
            over = pg.evaluate("(() => { const t = document.querySelector('.toolbar'); return t.scrollWidth - t.clientWidth; })()")
            assert over <= 1, f"the toolbar overflows by {over}px at {width}px"
            assert pg.get_by_role("button", name="Export video").is_visible()
        # in a folded toolbar the toggles live in the Options menu
        pg.set_viewport_size({"width": 1100, "height": 800})
        pg.wait_for_timeout(400)
        pg.get_by_role("button", name="Options").click()
        menu = pg.locator(".options-menu")
        menu.get_by_label("Snap").uncheck()
        pg.keyboard.press("Escape")
        assert pg.locator(".options-menu").count() == 0
        pg.get_by_role("button", name="Options").click()
        assert not pg.locator(".options-menu").get_by_label("Snap").is_checked()


def export(b):
    """Export asks for a file name, renders, and offers Show in folder / Play."""
    with editor() as (url, home):
        out = os.path.join(home, "exported.mp4")
        ctx, pg = page_in(b, url)
        seen = []

        def on_dialog(d):
            seen.append((d.type, d.default_value))
            d.accept(out if d.type == "prompt" else None)

        pg.on("dialog", on_dialog)
        new_project(pg)
        add(pg, "Circle")
        pg.get_by_role("button", name="Export video").click()
        dlg = pg.get_by_role("dialog", name="Export video")
        dlg.locator("select").select_option("720p")
        dlg.get_by_role("button", name="Render with manim").click()
        pg.wait_for_function("/Saved/.test(document.querySelector('.export-status')?.innerText || '')", timeout=180000)
        assert os.path.getsize(out) > 1000
        assert seen == [("prompt", "MyScene.mp4")], seen
        assert dlg.get_by_role("button", name="Show in folder").count() == 1 and dlg.get_by_role("button", name="Play").count() == 1


def accessibility(b):
    """axe-core finds nothing on Home, the editor, its dialogs and the Code tab (needs AXE_JS)."""
    axe = os.environ.get("AXE_JS")
    if not axe:
        print("   (set AXE_JS to the path of axe.min.js to run this one)")
        return
    source = open(axe).read()

    def violations(pg):
        pg.evaluate(source)
        res = pg.evaluate("axe.run(document, {runOnly: ['wcag2a','wcag2aa'], resultTypes: ['violations']})")
        return [(v["id"], str(n["target"])) for v in res["violations"] for n in v["nodes"]]

    with editor() as (url, home):
        ctx, pg = page_in(b, url)
        found = {"Home": violations(pg)}
        pg.get_by_text("Altitudes of a triangle").first.click()
        pg.wait_for_selector(".toolbar")
        pg.wait_for_timeout(4000)
        try:
            pg.get_by_role("button", name="Not now").click(timeout=800)
        except Exception:
            pass
        found["editor"] = violations(pg)
        for name in ["Export video", "Settings", "ƒ Graph", "? Help"]:
            pg.get_by_role("button", name=name).first.click()
            pg.wait_for_timeout(500)
            found[name] = violations(pg)
            pg.keyboard.press("Escape")
        pg.get_by_role("button", name="Scene", exact=True).first.click()
        rows = pg.locator(".outline-row")
        for i in range(min(rows.count(), 5)):
            rows.nth(i).click()
            pg.wait_for_timeout(400)
            found[f"object {i}"] = violations(pg)
        pg.locator(".tl-lanes .clip.anim").first.click()  # Effect Controls, with its object's keyframe rows
        pg.wait_for_timeout(400)
        assert pg.locator(".kf-channels").count() == 1
        found["clip"] = violations(pg)
        for view in ["Drawing order", "Markers"]:
            pg.get_by_role("button", name=view).click()
            pg.wait_for_timeout(300)
            found[view] = violations(pg)
        pg.keyboard.press("m")
        pg.locator(".ruler .marker").first.click()
        pg.get_by_role("group", name="Marker kind").get_by_role("button", name="Review").click()
        pg.wait_for_timeout(300)
        found["marker"] = violations(pg)
        pg.keyboard.press("Escape")
        pg.locator(".transport").click(position={"x": 2, "y": 2})
        pg.keyboard.press("Home")
        pg.keyboard.press("i")
        pg.keyboard.press("End")
        pg.keyboard.press("o")
        assert pg.locator(".work-area").count() == 1
        found["range"] = violations(pg)
        pg.get_by_role("button", name="? Help").first.click()
        pg.get_by_role("button", name="Try this: your first animation").click()
        pg.wait_for_timeout(300)
        found["try this"] = violations(pg)
        pg.get_by_role("button", name="</> Code").click()
        pg.wait_for_timeout(1500)
        found["Code tab"] = violations(pg)
        bad = {k: v for k, v in found.items() if v}
        assert not bad, bad


def clip_roles(b):
    """Clips show what their animation does to its object, like transitions and keyframes in a video editor (an intro
    ramps up, an outro ramps down, a swap does both, an effect has a keyframe at each end), read from what manim
    reports on screen; Effect Controls have easing presets and step through the object's keyframes."""
    code = ("from manim import *\n\nclass Shown(Scene):\n    def construct(self):\n"
            "        a = Circle()\n        b = Square()\n"
            "        self.play(FadeIn(a))\n        self.play(a.animate.shift(RIGHT))\n"
            "        self.play(ReplacementTransform(a, b))\n        self.play(Indicate(b))\n        self.play(FadeOut(b))\n")
    drop_file = """([name, text]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, {type: 'text/x-python'}));
      document.body.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));
    }"""
    with editor() as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        pg.evaluate(drop_file, ["shown.py", code])
        pg.wait_for_selector(".toolbar")
        pg.wait_for_selector(".tl-lanes .clip.anim:not(.estimated)", timeout=30000)
        pg.wait_for_timeout(500)
        clip = lambda text: pg.locator(".tl-lanes .clip.anim", has_text=text)
        role = lambda text: clip(text).get_attribute("aria-label").split(", ")[-2]
        assert [role(t) for t in ["FadeIn", ".animate", "ReplacementTransform", "Indicate", "FadeOut"]] == \
            ["intro", "effect", "swap", "effect", "outro"], [role(t) for t in ["FadeIn", ".animate", "ReplacementTransform", "Indicate", "FadeOut"]]
        assert clip("FadeIn").locator(".ramp.in").count() == 1 and clip("FadeOut").locator(".ramp.out").count() == 1
        assert clip("ReplacementTransform").locator(".ramp").count() == 2, "a swap ramps one out and one in"
        assert clip(".animate").locator(".kf").count() == 2, "an effect has a keyframe at each end"

        # easing presets: Linear writes rate_func=linear; Ease in-out (the usual) takes it away again
        clip(".animate").click()
        ease = pg.locator(".seg.ease")
        assert ease.get_by_role("button", name="Ease in-out").get_attribute("aria-pressed") == "true"
        ease.get_by_role("button", name="Linear").click()
        pg.wait_for_timeout(400)
        assert ease.get_by_role("button", name="Linear").get_attribute("aria-pressed") == "true"
        assert pg.locator('aside select.field:has(option[value="linear"])').first.input_value() == "linear", "the full rate_func agrees"
        ease.get_by_role("button", name="Ease in-out").click()
        pg.wait_for_timeout(400)
        assert pg.locator('aside select.field:has(option[value="linear"])').first.input_value() == ""

        # keyframes of a: ◀ ▶ step the playhead through its animations' starts and ends (0, 1, 2, 3 s)
        now = lambda: pg.locator(".tl-header .timecode").first.inner_text()
        pg.keyboard.press("Home")
        kf = pg.locator(".kf-row")
        assert kf.locator(".kf-dot").count() == 6 and kf.locator(".kf-dot.mine").count() == 2
        seen = []
        for _ in range(3):
            kf.get_by_role("button", name="Next keyframe of a").click()
            seen.append(now())
        assert seen == ["00:00:01:00", "00:00:02:00", "00:00:03:00"], seen
        assert kf.get_by_role("button", name="Next keyframe of a").is_disabled()
        kf.get_by_role("button", name="Previous keyframe of a").click()
        assert now() == "00:00:02:00", now()
        kf.locator(".kf-dot").first.click()  # FadeIn's start: selects it
        pg.wait_for_timeout(300)
        assert now() == "00:00:00:00" and clip("FadeIn").get_attribute("aria-pressed") == "true"
        assert not pg.errors, pg.errors


def track_heights(b):
    """Each V track has its own height: drag the line under its name (the clips grow with it), double-click for the
    usual height; heights are remembered between launches."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        new_project(pg)
        add(pg, "Circle")
        heads = pg.locator(".track-head:not(.steps-head)")
        height = lambda i: round(heads.nth(i).bounding_box()["height"])
        assert height(0) == height(1) == 46, (height(0), height(1))
        clip0 = pg.locator(".tl-lanes .clip.anim").first.bounding_box()["height"]
        grip = pg.get_by_role("separator", name="V1 height").bounding_box()
        pg.mouse.move(grip["x"] + 40, grip["y"] + grip["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(grip["x"] + 40, grip["y"] + grip["height"] / 2 + 60, steps=6)
        pg.mouse.up()
        pg.wait_for_timeout(300)
        assert height(0) == 106 and height(1) == 46, (height(0), height(1))
        assert pg.locator(".tl-lanes .clip.anim").first.bounding_box()["height"] == clip0 + 60, "the clip grows with its track"
        assert heads.nth(1).bounding_box()["y"] == heads.nth(0).bounding_box()["y"] + 106, "V2 moves down"
        assert json.load(open(os.path.join(home, "prefs.json")))["ui.trackHeights"] == "106"
        assert not pg.errors, pg.errors
        ctx.close()

        ctx, pg = page_in(b, url, 1500, 900)
        if pg.locator(".home").count():
            new_project(pg)
        heads = pg.locator(".track-head:not(.steps-head)")
        assert height(0) == 106, "remembered"
        pg.get_by_role("separator", name="V1 height").dblclick()
        pg.wait_for_timeout(300)
        assert height(0) == 46
        assert "ui.trackHeights" not in json.load(open(os.path.join(home, "prefs.json")))


def add_tracks(b):
    """+ Add track adds empty V tracks (remembered between launches); a clip moved onto one plays after the others in
    its group (the next free track); × removes the last track while it is empty."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url, 1500, 1000)
        new_project(pg)
        add(pg, "Circle")  # group 1, V1
        add(pg, "Square")  # group 2, V1
        heads = lambda: pg.locator(".track-head:not(.steps-head)").count()
        assert heads() == 3
        for _ in range(3):
            pg.get_by_role("button", name="+ Add track").click()
        assert heads() == 6
        assert json.load(open(os.path.join(home, "prefs.json")))["ui.tracks"] == "6"

        # drag the square onto V6 in the circle's column: it joins the circle's group, on V2
        circle = pg.locator(".tl-lanes .clip.anim", has_text="circle")
        square = pg.locator(".tl-lanes .clip.anim", has_text="square")
        cb, sb = circle.bounding_box(), square.bounding_box()
        v6 = pg.locator(".track-head:not(.steps-head)").nth(5).bounding_box()
        pg.mouse.move(sb["x"] + 10, sb["y"] + sb["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(cb["x"] + 10, v6["y"] + v6["height"] / 2, steps=10)
        pg.mouse.up()
        pg.wait_for_timeout(600)
        sb = square.bounding_box()
        assert abs(sb["x"] - cb["x"]) < 2 and abs(sb["y"] - (cb["y"] + cb["height"] + 6)) < 3, ("next free track", cb, sb)

        # × on the last (empty) track removes it; a track with clips has none
        pg.get_by_role("button", name="Remove V6").click()
        assert heads() == 5 and pg.get_by_role("button", name="Remove V5").count() == 1
        for n in [5, 4, 3]:
            pg.get_by_role("button", name=f"Remove V{n}").click()
        assert heads() == 2 and pg.get_by_role("button", name="Remove V2").count() == 0, "V2 holds the square"
        assert not pg.errors, pg.errors
        ctx.close()
        ctx, pg = page_in(b, url, 1500, 1000)
        if pg.locator(".home").count():
            new_project(pg)
        assert heads() == 2, "remembered"


def timeline_fixes(b):
    """Regressions: a scrolled timeline (marquee under the pointer, ruler click, drag between tracks); a trim and a move
    show at once (not after manim measures again); ▶ steps past a keyframe between two frames; moving a group past
    an object created after it keeps the code runnable."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        new_project(pg)
        for cls in ["Circle", "Square", "Triangle"]:
            pg.keyboard.press("Home")
            add(pg, cls)  # one group, V1–V3
        for _ in range(6):
            pg.get_by_role("button", name="+ Add track").click()
        pg.wait_for_selector(".tl-lanes .clip.anim:not(.estimated)", timeout=30000)
        body = pg.locator(".tl-body")
        body.evaluate("e => e.scrollTop = 92")
        pg.wait_for_timeout(200)
        heads = pg.locator(".track-head:not(.steps-head)")
        lanes = pg.locator(".tl-lanes").bounding_box()
        x0, y0 = lanes["x"] + 600, heads.nth(4).bounding_box()["y"] + 10
        pg.mouse.move(x0, y0)
        pg.mouse.down()
        pg.mouse.move(x0 + 60, y0 + 30, steps=4)
        mq = pg.locator(".marquee").bounding_box()
        pg.mouse.up()
        assert abs(mq["y"] - y0) < 2, ("the marquee starts under the pointer", y0, mq)
        rb = pg.locator(".ruler").bounding_box()
        pg.mouse.click(rb["x"] + 400, rb["y"] + rb["height"] / 2)
        pg.wait_for_timeout(200)
        assert pg.locator(".tl-header .timecode").inner_text() != "00:00:01:00", "a click on the ruler moves the playhead"
        tri = pg.locator(".tl-lanes .clip.anim", has_text="triangle")
        sq = pg.locator(".tl-lanes .clip.anim", has_text="square")
        tb, sb = tri.bounding_box(), sq.bounding_box()
        pg.mouse.move(tb["x"] + 20, tb["y"] + 20)
        pg.mouse.down()
        pg.mouse.move(tb["x"] + 22, sb["y"] + 20, steps=6)
        pg.mouse.up()
        pg.wait_for_timeout(400)
        assert abs(tri.bounding_box()["y"] - sb["y"]) < 2, "the triangle moved up a track"
        pg.keyboard.press("Control+z")

        # a trim shows while dragging, before manim measures it
        body.evaluate("e => e.scrollTop = 0")
        cb = pg.locator(".tl-lanes .clip.anim", has_text="circle").bounding_box()
        pg.mouse.move(cb["x"] + cb["width"] - 3, cb["y"] + cb["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(cb["x"] + cb["width"] + 100, cb["y"] + cb["height"] / 2, steps=8)
        grown = pg.locator(".tl-lanes .clip.anim", has_text="circle").bounding_box()["width"]
        pg.mouse.up()
        assert grown > cb["width"] + 80, ("the trim shows while dragging", cb["width"], grown)
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(300)

        # ▶ steps through keyframes that fall between frames
        pg.locator(".tl-lanes .clip.anim", has_text="circle").click()
        row = pg.locator(".fx-row", has_text="Duration").first
        row.locator(".scrub").first.click()
        row.locator("input.scrub-edit").fill("1.01")
        row.locator("input.scrub-edit").press("Enter")
        pg.wait_for_timeout(500)
        pg.keyboard.press("Home")
        nxt = pg.get_by_role("button", name="Next keyframe of circle")
        nxt.click()
        first = pg.locator(".tl-header .timecode").inner_text()
        assert nxt.is_disabled() or (nxt.click() or pg.locator(".tl-header .timecode").inner_text() != first), "▶ doesn't get stuck"
        assert not pg.errors, pg.errors
        ctx.close()

    code = ("from manim import *\n\nclass Anchored(Scene):\n    def construct(self):\n        c = Circle()\n"
            "        self.play(Create(c))\n        s = Square().shift(RIGHT * 2)\n        self.play(Create(s))\n")
    project = os.path.join(tempfile.mkdtemp(prefix="manim-studio-ui-"), "anchored.py")
    open(project, "w").write(code)
    with editor(project) as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        pg.wait_for_selector(".tl-lanes .clip.anim:not(.estimated)", timeout=30000)
        circle = pg.locator(".tl-lanes .clip.anim").first  # Create(c), the first group
        cb = circle.bounding_box()
        pg.mouse.click(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] + 30)  # the group's shading
        pg.mouse.move(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(cb["x"] + cb["width"] / 2 + 3 * cb["width"], cb["y"] + cb["height"] / 2, steps=10)
        pg.mouse.up()
        pg.wait_for_timeout(4000)
        assert pg.locator(".tl-lanes .clip.err").count() == 0, "s is created before Create(s) runs"
        assert "UnboundLocalError" not in pg.content()


def editing_fixes(b):
    """Regressions: Enter renames an object (Esc puts the old name back); playback runs on (frame by frame) when the
    preview video can't play in the window."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        new_project(pg)
        add(pg, "Circle")
        pg.get_by_role("button", name="Scene", exact=True).first.click()
        pg.locator(".outline-row").filter(has_text="circle").first.click()
        name = pg.get_by_label("Object name")
        name.fill("hoop")
        name.press("Escape")
        assert name.input_value() == "circle"
        name.fill("ring")
        name.press("Enter")
        pg.wait_for_timeout(500)
        assert "ring" in pg.locator(".tl-lanes .clip.anim").first.get_attribute("aria-label"), "Enter renames"
        if pg.evaluate("document.createElement('video').canPlayType('video/mp4; codecs=\"avc1.42E01E\"')") == "":
            pg.get_by_role("button", name="Objects", exact=True).first.click()
            add(pg, "Square")
            pg.wait_for_function("document.querySelector('video')?.getAttribute('src')", timeout=120000)
            pg.keyboard.press("Home")
            pg.locator(".tl-lanes").click(position={"x": 5, "y": 200})
            pg.keyboard.press("Space")
            pg.wait_for_timeout(1200)
            assert pg.locator(".tl-header .timecode").inner_text() >= "00:00:00:30", "playback moves on"
            assert "can’t play" in " ".join(pg.locator(".toast").all_inner_texts())
        assert not pg.errors, pg.errors


def drawing_order(b):
    """The V lanes are animation lanes, not drawing layers: Scene › Drawing order lists what is on top at the playhead
    (later-added objects over earlier ones), and the timeline says which is which."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        new_project(pg)
        add(pg, "Circle")
        add(pg, "Square")
        assert "Animation lanes" in pg.locator(".tl-corner").inner_text()
        assert "Not a drawing layer" in pg.locator(".track-head:not(.steps-head)").first.get_attribute("title")
        assert pg.locator(".play-band").first.get_attribute("aria-label").startswith("Play together:")
        pg.keyboard.press("End")
        pg.get_by_role("button", name="Scene", exact=True).first.click()
        pg.get_by_role("button", name="Drawing order").click()
        rows = pg.locator(".outline .outline-row")
        rows.first.wait_for(timeout=30000)
        pg.wait_for_function("document.querySelectorAll('.outline .outline-row').length === 2", timeout=30000)
        labels = [rows.nth(i).get_attribute("aria-label") for i in range(rows.count())]
        assert labels == ["square, on top", "circle, 2 from the top"], labels
        rows.nth(1).click()
        assert "sel" in rows.nth(1).get_attribute("class")
        assert not pg.errors, pg.errors


def retiming(b):
    """Drags say what they will do (where a clip lands, how later beats move) and Esc cancels them. With Keep later
    timing on, making a clip longer takes the time from the pause after it (never more than there is), in one undo
    step, from the timeline or from Effect Controls; later beats keep their measured time."""
    code = ("from manim import *\n\nclass K(Scene):\n    def construct(self):\n        a = Circle()\n        b = Square()\n"
            "        self.play(Create(a))\n        self.wait(2)\n        self.play(Create(b))\n")
    project = os.path.join(tempfile.mkdtemp(prefix="manim-studio-ui-"), "retime.py")
    open(project, "w").write(code)
    with editor(project) as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        measured = lambda: pg.wait_for_function("document.querySelector('.tl-lanes .clip.anim') && !document.querySelector('.tl-lanes .clip.anim.estimated')", timeout=60000)
        measured()
        clip = lambda n: pg.locator(f'.tl-lanes .clip.anim[aria-label^="Create {n},"]')
        label = lambda n: clip(n).get_attribute("aria-label")
        note = lambda: " ".join(pg.locator(".drag-note").all_inner_texts())
        a0, b0 = label("a"), label("b")
        assert a0.endswith("00:00:00:00 to 00:00:01:00") and b0.endswith("00:00:03:00 to 00:00:04:00"), (a0, b0)
        sec = clip("a").bounding_box()["width"]  # pixels per second (a lasts 1 s)

        def drag_edge(n, seconds, release=True):
            bb = clip(n).bounding_box()
            y = bb["y"] + bb["height"] / 2
            pg.mouse.move(bb["x"] + bb["width"] - 2, y)
            pg.mouse.down()
            pg.mouse.move(bb["x"] + bb["width"] - 2 + seconds * sec, y, steps=8)
            text = note()
            if release:
                pg.mouse.up()
                pg.wait_for_timeout(400)
            return text

        # off: later beats move along, and the note says by how much; Esc cancels and leaves no undo step
        text = drag_edge("a", 0.5, release=False)
        assert "Lasts 1.5 s (+0.5 s)" in text and "later beats move by +0.5 s" in text, text
        pg.keyboard.press("Escape")
        pg.mouse.up()
        pg.wait_for_timeout(300)
        assert (label("a"), label("b")) == (a0, b0) and not pg.locator(".drag-note").count()
        pg.keyboard.press("Control+z")  # nothing to undo: the cancelled drag left no step
        pg.wait_for_timeout(300)
        assert (label("a"), label("b")) == (a0, b0)

        # on: the pause after it gives the time; later beats keep their measured time
        pg.get_by_role("button", name="Keep later timing").click()
        text = drag_edge("a", 0.5)
        assert "later beats keep their time: the pause after it gets shorter" in text, text
        measured()
        assert label("a").endswith("to 00:00:01:30") and label("b") == b0, (label("a"), label("b"))

        # not more than the pause holds: it stops there and says why
        text = drag_edge("a", 2.5)
        assert "Only 1.5 s of pause after it" in text, text
        measured()
        assert label("a").endswith("to 00:00:03:00") and label("b") == b0, (label("a"), label("b"))
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(400)
        assert label("a").endswith("to 00:00:01:30") and label("b").startswith("Create b, intro, 00:00:03:00"), "one undo step"

        # a pause is the hold itself: with Keep on, making it longer or shorter still moves what comes after
        wait = pg.locator(".tl-lanes .clip.step.pause").first
        wb = wait.bounding_box()
        pg.mouse.move(wb["x"] + wb["width"] - 2, wb["y"] + 10)
        pg.mouse.down()
        pg.mouse.move(wb["x"] + wb["width"] - 2 + 0.5 * sec, wb["y"] + 10, steps=8)
        text = note()
        pg.mouse.up()
        pg.wait_for_timeout(400)
        assert "No pause" not in text and "later beats move by +0.5 s" in text, text
        measured()
        assert label("b").startswith("Create b, intro, 00:00:03:30"), label("b")
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(400)
        assert label("b") == b0

        # Effect Controls do the same
        clip("a").click()
        row = pg.locator(".fx-row", has_text="Duration").first
        row.locator(".scrub").first.click()
        row.locator("input.scrub-edit").fill("2")
        row.locator("input.scrub-edit").press("Enter")
        measured()
        assert label("a").endswith("to 00:00:02:00") and label("b") == b0, (label("a"), label("b"))

        # a clip dropped onto another group starts with it, at its start, not where the pointer let go
        bb, ab = clip("b").bounding_box(), clip("a").bounding_box()
        pg.mouse.move(bb["x"] + 10, bb["y"] + bb["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(ab["x"] + ab["width"] * 0.6, ab["y"] + ab["height"] * 1.5, steps=10)
        text = note()
        assert "Starts with Create a at 00:00:00:00" in text, text
        pg.keyboard.press("Escape")
        pg.mouse.up()
        assert not pg.errors, pg.errors


def markers(b):
    """M with a clip selected adds a marker attached to it: it moves when the clip moves (undo too). Double-click
    edits it (name, kind, notes); the cue list finds it; deleting its clip leaves it where it was, and says so."""
    code = ("from manim import *\n\nclass K(Scene):\n    def construct(self):\n        a = Circle()\n        b = Square()\n"
            "        self.play(Create(a))\n        self.wait(2)\n        self.play(Create(b))\n")
    project = os.path.join(tempfile.mkdtemp(prefix="manim-studio-ui-"), "cues.py")
    open(project, "w").write(code)
    with editor(project) as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        pg.wait_for_function("document.querySelector('.tl-lanes .clip.anim') && !document.querySelector('.tl-lanes .clip.anim.estimated')", timeout=60000)
        clip = lambda n: pg.locator(f'.tl-lanes .clip.anim[aria-label^="Create {n},"]')
        marker = pg.locator(".ruler .marker")
        clip("b").click()
        tc = pg.locator(".tl-header .timecode")
        tc.click()
        pg.locator(".tl-header input.timecode").fill("00:00:03:30")
        pg.keyboard.press("Enter")
        clip("b").click()
        pg.keyboard.press("m")
        assert marker.count() == 1 and marker.get_attribute("aria-label") == "Marker at 00:00:03:30, attached", marker.get_attribute("aria-label")

        # double-click: its settings, the name ready to type
        marker.dblclick()
        name = pg.get_by_label("Marker name")
        pg.wait_for_function("document.activeElement?.getAttribute('aria-label') === 'Marker name'")
        name.fill("Reveal square")
        name.press("Enter")
        pg.get_by_role("group", name="Marker kind").get_by_role("button", name="Visual event").click()
        pg.get_by_label("Marker notes").fill("say: and here is the square")
        assert "Attached to the start of Create b + 0.5 s" in pg.locator(".marker-insp").inner_text()
        assert marker.get_attribute("aria-label") == "Marker Reveal square at 00:00:03:30, attached"

        # the clip moves (a gets 1 s longer): the marker moves with it; undo puts both back
        ab = clip("a").bounding_box()
        pg.mouse.move(ab["x"] + ab["width"] - 2, ab["y"] + ab["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(ab["x"] + 2 * ab["width"] - 2, ab["y"] + ab["height"] / 2, steps=8)
        assert marker.get_attribute("aria-label").startswith("Marker Reveal square at 00:00:04:30"), "it follows while dragging"
        pg.mouse.up()
        pg.wait_for_timeout(400)
        assert marker.get_attribute("aria-label").startswith("Marker Reveal square at 00:00:04:30")
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(300)
        assert marker.get_attribute("aria-label").startswith("Marker Reveal square at 00:00:03:30")

        # the cue list: search and filter
        pg.get_by_role("button", name="Scene", exact=True).first.click()
        pg.get_by_role("button", name="Markers (1)").click()
        row = pg.locator(".cue-list .outline-row")
        assert row.get_attribute("aria-label") == "Reveal square at 00:00:03:30, Visual event", row.get_attribute("aria-label")
        pg.get_by_label("Search markers").fill("square")
        assert row.count() == 1
        pg.get_by_role("group", name="Show markers of kind").get_by_role("button", name="Chapter").click()
        assert row.count() == 0 and "No marker matches" in pg.locator(".cue-list").inner_text()
        pg.get_by_role("group", name="Show markers of kind").get_by_role("button", name="All").click()
        pg.keyboard.press("Home")
        row.click()
        assert pg.locator(".tl-header .timecode").inner_text() == "00:00:03:30"

        # deleting the clip it is attached to: it stays where it was, and a note says so
        clip("b").click()
        pg.keyboard.press("Delete")
        pg.wait_for_timeout(300)
        assert "stays at 00:00:03:30" in " ".join(pg.locator(".toast").all_inner_texts())
        assert marker.get_attribute("aria-label") == "Marker Reveal square at 00:00:03:30"
        assert not pg.errors, pg.errors


def work_area(b):
    """I and O set a range (editor state, not the document), with a readout of its length in seconds and frames.
    Play In to Out stops at Out; with Loop on it starts over at In. An Out before In clears In and says so. The range's
    ends drag on the ruler (Esc puts them back), and Ctrl+Shift+X clears it."""
    code = ("from manim import *\n\nclass K(Scene):\n    def construct(self):\n        a = Circle()\n        b = Square()\n"
            "        self.play(Create(a))\n        self.wait(2)\n        self.play(Create(b))\n")
    project = os.path.join(tempfile.mkdtemp(prefix="manim-studio-ui-"), "range.py")
    open(project, "w").write(code)
    with editor(project) as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        pg.wait_for_function("document.querySelector('.tl-lanes .clip.anim') && !document.querySelector('.tl-lanes .clip.anim.estimated')", timeout=60000)
        tc = pg.locator(".tl-header .timecode")
        readout = pg.locator(".range-readout")
        pg.get_by_role("button", name="Program").click()  # the monitor with the transport (a .py file opens on its code)

        def seek(code):
            tc.click()
            pg.locator(".tl-header input.timecode").fill(code)
            pg.keyboard.press("Enter")

        assert readout.inner_text() == "" and not pg.locator(".work-area").count()
        seek("00:00:01:00")
        pg.keyboard.press("i")
        seek("00:00:02:00")
        pg.keyboard.press("o")
        assert readout.inner_text().startswith("In 00:00:01:00 → Out 00:00:02:00: 1 s, 60 frames"), readout.inner_text()
        assert pg.locator(".work-area").count() == 1

        # Play In to Out stops at Out
        pg.keyboard.press("Home")
        pg.keyboard.press("Shift+Space")
        pg.wait_for_timeout(200)
        assert "00:00:01" in tc.inner_text(), tc.inner_text()
        pg.wait_for_function("document.querySelector('.tl-header .timecode').textContent === '00:00:02:00'", timeout=5000)
        pg.wait_for_timeout(500)
        assert tc.inner_text() == "00:00:02:00", "stopped at Out"

        # Loop: it starts over at In
        pg.get_by_role("button", name="Loop").click()
        pg.keyboard.press("Shift+Space")
        pg.wait_for_timeout(1700)
        t = tc.inner_text()
        pg.keyboard.press("k")
        assert t.startswith("00:00:01:"), ("looping In to Out", t)
        pg.get_by_role("button", name="Loop").click()

        # Esc puts dragged handles back; a drag moves In
        h = pg.get_by_role("slider", name="In").bounding_box()
        sec = pg.locator(".tl-lanes .clip.anim").first.bounding_box()["width"]
        pg.mouse.move(h["x"] + h["width"] / 2, h["y"] + h["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(h["x"] + h["width"] / 2 + 0.5 * sec, h["y"] + h["height"] / 2, steps=6)
        pg.keyboard.press("Escape")
        pg.mouse.up()
        assert readout.inner_text().startswith("In 00:00:01:00 → Out 00:00:02:00"), readout.inner_text()
        pg.mouse.move(h["x"] + h["width"] / 2, h["y"] + h["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(h["x"] + h["width"] / 2 + 0.5 * sec, h["y"] + h["height"] / 2, steps=6)
        pg.mouse.up()
        assert readout.inner_text().startswith("In 00:00:01:30 → Out 00:00:02:00: 0.5 s, 30 frames"), readout.inner_text()

        # an Out before In clears In, and says so
        seek("00:00:00:30")
        pg.keyboard.press("o")
        assert "In is cleared" in " ".join(pg.locator(".toast").all_inner_texts())
        assert readout.inner_text().startswith("Start → Out 00:00:00:30"), readout.inner_text()

        pg.keyboard.press("Control+Shift+X")
        assert readout.inner_text() == "" and not pg.locator(".work-area").count()
        assert not pg.errors, pg.errors


def preview_freshness(b):
    """A frame that arrives after another project was opened never shows in it; a frame the backend didn't draw says
    so with Retry; a failed preview render can be retried."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        new_project(pg)
        add(pg, "Circle")
        pg.wait_for_selector("img.frame", timeout=30000)
        pg.wait_for_timeout(800)

        # a late frame for the project open before
        held, holding = [], [True]
        pg.route("**/api/run", lambda r: held.append(r) if holding[0] else r.continue_())
        pg.locator(".tl-lanes").click(position={"x": 5, "y": 5})
        pg.keyboard.press("End")
        for _ in range(50):
            if held:
                break
            pg.wait_for_timeout(100)
        assert held, "a frame was asked for"
        late = held.pop(0)
        pg.get_by_text("⌂ Home").click()
        pg.get_by_text("Riemann sums").first.click()
        pg.get_by_role("alertdialog").get_by_role("button", name="Don’t save").click()
        pg.wait_for_selector(".toolbar")
        pg.wait_for_timeout(500)
        late.continue_()
        pg.wait_for_timeout(1500)
        assert pg.locator("img.frame").count() == 0, "the other project's frame doesn't show"
        holding[0] = False
        for r in held:
            r.continue_()
        pg.wait_for_selector("img.frame", timeout=60000)
        pg.unroute("**/api/run")

        # the backend doesn't answer: the monitor says so, Retry draws it
        pg.route("**/api/run", lambda r: r.abort())
        pg.locator(".tl-lanes").click(position={"x": 5, "y": 5})
        pg.keyboard.press("Home")
        status = pg.locator(".frame-status.failed")
        status.wait_for(timeout=10000)
        assert "This frame couldn’t be drawn" in status.inner_text()
        pg.unroute("**/api/run")
        status.get_by_role("button", name="Retry").click()
        status.wait_for(state="detached", timeout=60000)

        # a preview render that failed: Retry renders again
        pg.route("**/api/render", lambda r: r.fulfill(json={"id": None, "state": "error", "message": "manim stopped"}))
        button = pg.locator(".render-status")
        add(pg, "Square")  # a new version of the scene: auto-render (or the button) renders it
        pg.wait_for_timeout(2000)
        if "Render preview" in button.inner_text():
            button.click()
        pg.wait_for_function("document.querySelector('.render-status')?.textContent.includes('Render failed · Retry')", timeout=10000)
        pg.unroute("**/api/render")
        button.click()
        pg.wait_for_function("/Rendering|Preview ready/.test(document.querySelector('.render-status')?.textContent)", timeout=30000)
        assert not pg.errors, pg.errors


def try_this(b):
    """Help › Try this walks through a first animation with the controls only: each step ticks itself from the scene
    (add a circle, reveal it, move it, preview, export), the card doesn't get in the timeline's way, and it closes."""
    with editor() as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        pg.on("dialog", lambda d: d.accept(os.path.join(home, "first.mp4") if d.type == "prompt" else None))
        new_project(pg)
        pg.get_by_role("button", name="? Help").click()
        pg.get_by_role("button", name="Try this: your first animation").click()
        card = pg.get_by_role("region", name="Try this: your first animation")
        current = lambda: card.locator("li[aria-current=step] .try-title").inner_text()
        done = lambda: card.locator("li.done").count()
        assert current().endswith("Add a circle") and done() == 0
        card.get_by_role("button", name="Show me").click()
        assert "try-flash" in pg.locator('[data-tour="library"]').get_attribute("class")

        add(pg, "Circle")  # Auto-intro reveals it with Create
        assert done() == 2 and current().endswith("Move it"), (done(), current())
        pg.get_by_role("button", name="Scene", exact=True).first.click()
        pg.locator(".outline-row").filter(has_text="circle").first.click()
        pg.locator(".inspector").get_by_role("button", name=".animate", exact=True).click()
        assert done() == 3 and current().endswith("Preview it")

        # the timeline works as usual with the card up
        pg.locator(".tl-lanes .clip.anim").first.click()
        assert pg.locator(".tl-lanes .clip.anim.sel").count() == 1
        pg.keyboard.press("Home")
        pg.keyboard.press("Space")
        pg.wait_for_timeout(300)
        pg.keyboard.press("k")
        assert done() == 4 and current().endswith("Export it")

        pg.route("**/api/render", lambda r: r.fulfill(json={"id": "j1", "state": "running", "progress": 0, "message": "Rendering"}))
        pg.route("**/api/render/j1", lambda r: r.fulfill(json={"id": "j1", "state": "running", "progress": 0.5, "message": "Rendering"}))
        pg.get_by_role("button", name="Export video").click()
        pg.get_by_role("dialog", name="Export video").get_by_role("button", name="Render with manim").click()
        pg.wait_for_timeout(500)
        pg.keyboard.press("Escape")
        assert done() == 5 and "Done: a whole animation without code" in card.inner_text()
        assert pg.locator(".code-monitor").count() == 0, "no code needed"
        card.get_by_role("button", name="Close", exact=True).click()
        assert card.count() == 0
        assert not pg.errors, pg.errors


def keyframe_controls(b):
    """Effect Controls show the object's keyframes per property at the playhead, and editing them writes plain manim:
    the value of a keyframe is the argument of its method (written as it was), ◆ adds a clip that ends at the
    playhead (taking a second of a pause), add-then-change is one undo step, and a keyframe where the object is
    already animated is refused with why."""
    code = ("from manim import *\n\nclass K(Scene):\n    def construct(self):\n        c = Square(color=BLUE)\n"
            "        self.play(Create(c))\n        self.play(c.animate.shift(RIGHT * 2))\n        self.wait(2)\n")
    project = os.path.join(tempfile.mkdtemp(prefix="manim-studio-ui-"), "keys.py")
    open(project, "w").write(code)
    with editor(project) as (url, home):
        ctx, pg = page_in(b, url, 1500, 900)
        measured = lambda: pg.wait_for_function("document.querySelector('.tl-lanes .clip.anim') && !document.querySelector('.tl-lanes .clip.anim.estimated')", timeout=60000)
        measured()
        pg.get_by_role("button", name="Program").click()
        tc = pg.locator(".tl-header .timecode")

        def seek(t):
            tc.click()
            pg.locator(".tl-header input.timecode").fill(t)
            pg.keyboard.press("Enter")
            pg.wait_for_timeout(300)

        def saved():  # the scene's code, as the Code tab shows it
            pg.wait_for_timeout(300)
            pg.locator(".monitor-title .tab-btn", has_text="Code").first.click()
            pg.wait_for_timeout(700)
            text = pg.locator(".code-monitor textarea").first.input_value()
            pg.get_by_role("button", name="Program").click()
            pg.wait_for_timeout(200)
            return text

        def toasts():
            return " ".join(pg.locator(".toast").all_inner_texts())

        row = lambda ch: pg.locator(f'.kf-channel[data-channel="{ch}"]')
        pg.locator(".tl-lanes .clip.anim").nth(1).click()
        assert pg.locator(".kf-channels h4", has_text="Keyframes of c").count() == 1
        assert row("position").locator(".kf-dot").count() == 1 and row("scale").locator(".kf-dot").count() == 0

        # on the shift's keyframe: its value is where it lands, and editing it rewrites the shift, in its own words
        seek("00:00:02:00")
        toggle = row("position").locator(".kf-toggle")
        assert toggle.get_attribute("aria-pressed") == "true"
        x = row("position").locator(".scrub").first
        assert x.inner_text() == "2", x.inner_text()
        x.click()
        row("position").locator("input.scrub-edit").fill("3")
        row("position").locator("input.scrub-edit").press("Enter")
        src = saved()
        assert "self.play(c.animate.shift(RIGHT * 3))" in src, src

        # in the pause: ◆ then a value adds one .animate clip ending here; one undo removes both
        seek("00:00:03:00")
        row("scale").locator(".kf-toggle").click()
        row("scale").locator(".scrub").first.click()
        row("scale").locator("input.scrub-edit").fill("2")
        row("scale").locator("input.scrub-edit").press("Enter")
        src = saved()
        assert "self.play(c.animate.scale(2))" in src and "self.wait(1)" in src, src
        assert row("scale").locator(".kf-toggle").get_attribute("aria-pressed") == "true"
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(300)
        src = saved()
        assert ".scale(" not in src and "self.wait(2)" in src, src

        # dragging a value off a keyframe adds one clip there and then changes it: one clip, no complaints, one undo
        seek("00:00:03:00")
        x = row("position").locator(".scrub").first
        bb = x.bounding_box()
        pg.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(bb["x"] + bb["width"] / 2 + 40, bb["y"] + bb["height"] / 2, steps=10)
        pg.mouse.up()
        pg.wait_for_timeout(300)
        assert not toasts(), toasts()
        src = saved()
        assert src.count("c.animate.move_to(") == 1 and "self.wait(1)" in src, src
        assert row("position").locator(".kf-toggle").get_attribute("aria-pressed") == "true"
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(300)
        src = saved()
        assert "move_to" not in src and "self.wait(2)" in src, src

        # ◆ on a keyframe removes it: the shift clip goes, and its time stays as a pause
        seek("00:00:02:00")
        row("position").locator(".kf-toggle").click()
        src = saved()
        assert "shift" not in src, src
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(300)

        # inside Create(c), c is already animated: refused, and nothing changes
        seek("00:00:00:15")
        row("rotation").locator(".kf-toggle").click()
        pg.wait_for_timeout(300)
        assert "already animated" in toasts(), toasts()
        src = saved()
        assert "Rotate" not in src and "self.play(c.animate.shift(RIGHT * 3))" in src, src
        assert not pg.errors, pg.errors


SCENARIOS = [recovery, leaving, shortcuts, system_keys, timeline_keys, timeline_edit, clip_roles, track_heights, add_tracks, timeline_fixes, editing_fixes, drawing_order, retiming, keyframe_controls, markers, work_area, preview_freshness, try_this, broken_files, early_settings, failing_backend, dropped_files, preferences, toolbar, export, accessibility]


def main() -> int:
    wanted = sys.argv[1:]
    todo = [s for s in SCENARIOS if (not wanted or s.__name__ in wanted) and not (s is export and os.environ.get("SKIP_EXPORT"))]
    failed = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROMIUM)
        for scenario in todo:
            started = time.time()
            try:
                scenario(browser)
                print(f"ok    {scenario.__name__}  ({time.time() - started:.0f}s)  {scenario.__doc__.splitlines()[0]}")
            except Exception as exc:  # report every scenario, not just the first failure
                failed.append(scenario.__name__)
                print(f"FAIL  {scenario.__name__}: {type(exc).__name__}: {exc}")
        browser.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
