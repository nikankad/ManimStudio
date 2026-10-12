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
def editor():
    """A fresh editor server: (url, app folder). Stops it afterwards."""
    home = tempfile.mkdtemp(prefix="manim-studio-ui-")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "MANIM_STUDIO_HOME": home, "MATHENGINE_NO_UPDATE_CHECK": "1"}
    proc = subprocess.Popen([sys.executable, "-m", "mathengine", "--serve", "--port", str(port)], env=env,
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
    return pg.locator(".tl-lanes .clip").count()


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
        assert pg.locator(".search").input_value() == "" and clips(pg) == n + 2, "Enter added the triangle"
        # keyboard-only: Tab focus + Enter adds
        pg.locator(".lib-item", has_text="Square").first.focus()
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(1000)
        assert clips(pg) == n + 4
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
        pg.get_by_role("button", name="</> Code").click()
        pg.wait_for_timeout(1500)
        found["Code tab"] = violations(pg)
        bad = {k: v for k, v in found.items() if v}
        assert not bad, bad


SCENARIOS = [recovery, leaving, shortcuts, system_keys, timeline_keys, preferences, toolbar, export, accessibility]


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
