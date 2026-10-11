"""Keyboard integration checks with real Chromium and a mocked manim API.

Run `cd frontend && npx vite --host 127.0.0.1`, then
`python scripts/keyboard_smoke.py` (requires playwright and `playwright install chromium`).
The Vite server is needed to inspect the store; manim and LaTeX are not needed.
Set KEYBOARD_URL to override http://127.0.0.1:5173/.
"""
import copy
import json
import os

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get("KEYBOARD_URL", "http://127.0.0.1:5173/")
DOC = {
    "version": 3, "scene": {"name": "KeyboardScene", "base": "Scene"},
    "config": {"pixel_width": 1920, "pixel_height": 1080, "frame_rate": 60, "background_color": "#000000"},
    "header": "", "markers": [], "constructions": [],
    "tracks": [{"id": "t1", "name": "V1"}, {"id": "t2", "name": "V2", "locked": True}],
    "objects": [
        {"id": "a", "name": "a", "ctor": "Circle", "args": {"radius": "0.4"}, "pos": [-2, 0], "chain": ""},
        {"id": "b", "name": "b", "ctor": "Circle", "args": {"radius": "0.4"}, "pos": [2, 0], "chain": ""},
    ],
    "clips": [
        {"id": "c1", "kind": "hold", "track": "t1", "start": 0, "duration": 3},
        {"id": "c2", "kind": "hold", "track": "t2", "start": 0, "duration": 2},
    ],
}


def state(page):
    return page.evaluate("async () => (await import('/src/store.ts')).getState()")


def reset(page, selection=None):
    page.evaluate("""async ({doc, selection}) => {
      const s = await import('/src/store.ts');
      s.setPlaying(false);
      s.setState({ autoRender: false, record: false, panel: null, tour: null, tool: 'select', viewerMaximized: false, snap: true });
      s.loadDoc(doc, '/tmp/keyboard.manimstudio');
      s.setState({selection});
    }""", {"doc": copy.deepcopy(DOC), "selection": selection})
    page.locator(".monitor").focus()
    page.keyboard.press("0")
    page.wait_for_function("async () => (await import('/src/store.ts')).getState().frame?.objects.length === 2")


def main():
    calls = []
    errors = []

    def api(route):
        path = route.request.url.split("/api/")[1]
        body = route.request.post_data_json if route.request.post_data else {}
        calls.append((path, body))
        if path == "project/initial":
            result = {"doc": DOC, "path": "/tmp/keyboard.manimstudio"}
        elif path == "catalog":
            result = {"mobjects": [{"name": "Circle", "kind": "mobject", "category": "Geometry", "featured": 0, "starter": {}, "bases": [], "vector": True, "doc": "Circle"}],
                      "animations": [], "colors": [], "color_hex": {}, "directions": [], "rate_funcs": [], "methods": [], "scene_bases": ["Scene"], "latex": False, "ffmpeg": True, "manim_version": "mock"}
        elif path == "run":
            doc = body["doc"]
            objects = []
            for o in doc["objects"]:
                x, y = o.get("pos") or [0, 0]
                r = float(o.get("args", {}).get("radius", 0.1))
                objects.append({"id": o["id"], "name": o["name"], "visible": True, "center": [x, y], "box": [x-r, y-r, x+r, y+r], "geom": {"kind": "circle", "center": [x, y], "radius": r}})
            result = {"duration": 3, "steps": [], "objects": objects, "camera": {"center": [0, 0], "width": 128/9, "height": 8}, "plays": 0, "image": None, "error": None, "elapsed_ms": 0, "values": {}, "diagnostics": []}
        elif path == "signature":
            result = {"name": body["expr"], "params": [], "doc": "", "animation": False, "vector": True, "methods": [], "factories": []}
        elif path == "constructions":
            result = {"starters": [], "library": [], "path": ""}
        elif path == "dialog":
            result = {"path": "/tmp/test.manimstudio"}
        elif path == "project/open":
            result = {"doc": DOC, "path": body["path"]}
        elif path == "render":
            result = {"state": "error", "message": "Mock preview"}
        elif path == "code":
            result = {"code": "from manim import *"}
        elif path in ("version", "update_check"):
            result = {"version": "test", "channel": "dev", "commit": "", "available": False}
        else:
            result = {"ok": True, "path": body.get("path", "")}
        route.fulfill(content_type="application/json", body=json.dumps(result))

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.add_init_script("localStorage.setItem('mathengine.welcomed', '1'); localStorage.setItem('mathengine.checkUpdates', 'off')")
        page.route("**/api/**", api)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        page.goto(URL)
        expect(page.locator(".lib-item")).to_be_visible()

        # Multi-object nudge is atomic and one undo restores both objects.
        reset(page, {"kind": "objects", "ids": ["a", "b"]})
        page.keyboard.press("ArrowRight")
        s = state(page)
        assert [o["pos"][0] for o in s["doc"]["objects"]] == [-1.75, 2.25]
        assert len(s["past"]) == 1
        page.keyboard.press("Control+z")
        assert state(page)["doc"]["objects"] == DOC["objects"]
        page.keyboard.press("Meta+Shift+z")
        assert state(page)["doc"]["objects"][0]["pos"][0] == -1.75

        # Explicit timeline focus steps frames despite an object selection.
        page.keyboard.press("Alt+4")
        page.keyboard.press("Shift+ArrowRight")
        assert abs(state(page)["time"] - 5/60) < 1e-8
        page.keyboard.press("Control+a")
        assert state(page)["selection"] == {"kind": "clips", "ids": ["c1"]}
        page.keyboard.press("Control+d")
        clips = state(page)["doc"]["clips"]
        assert len(clips) == 3 and clips[-1]["start"] == 3
        page.keyboard.press("Control+c")
        page.keyboard.press("Home")
        page.keyboard.press("Control+v")
        assert len(state(page)["doc"]["clips"]) == 4
        assert state(page)["doc"]["clips"][-1]["start"] == 0

        # Text, contenteditable, and shadow math inputs keep their native keys.
        reset(page, {"kind": "object", "id": "a"})
        page.keyboard.press("/")
        expect(page.locator(".search")).to_be_focused()
        page.keyboard.type("12 r s l f")
        assert state(page)["tool"] == "select" and not state(page)["playing"]
        assert not state(page)["record"] and not state(page)["viewerMaximized"]
        page.keyboard.press("Control+a")
        assert state(page)["selection"] == {"kind": "object", "id": "a"}
        page.keyboard.press("Escape")
        expect(page.locator(".search")).to_have_value("")
        page.keyboard.press("Escape")
        expect(page.locator(".monitor")).to_be_focused()
        for html in ['<div contenteditable="true" id="typing"></div>', '<math-field id="typing" tabindex="0"></math-field>']:
            page.evaluate("html => { document.body.insertAdjacentHTML('beforeend', html); document.querySelector('#typing').focus(); }", html)
            before = state(page)["doc"]
            page.keyboard.press("Delete")
            page.keyboard.press("r")
            assert state(page)["doc"] == before and not state(page)["record"]
            page.evaluate("document.querySelector('#typing').remove()")

        # Dialog Escape works even inside inputs; shortcuts behind a dialog do nothing.
        page.locator(".monitor").focus()
        page.keyboard.press("Control+,")
        expect(page.get_by_role("dialog")).to_be_visible()
        page.get_by_role("dialog").get_by_role("heading", name="Scene settings").click()
        page.keyboard.press("2")
        page.keyboard.press("Delete")
        page.keyboard.press(" ")
        assert state(page)["tool"] == "select" and len(state(page)["doc"]["objects"]) == 2 and not state(page)["playing"]
        page.get_by_role("dialog").locator("input").first.focus()
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_have_count(0)

        # Drawing Backspace / Escape consume the key before delete or deselection.
        reset(page, {"kind": "object", "id": "a"})
        page.keyboard.press("7")
        box = page.locator(".stage").bounding_box()
        page.mouse.click(box["x"] + box["width"] * .5, box["y"] + box["height"] * .5)
        expect(page.locator(".draft circle")).to_have_count(1)
        page.keyboard.press("Backspace")
        expect(page.locator(".draft circle")).to_have_count(0)
        assert len(state(page)["doc"]["objects"]) == 2
        page.keyboard.press("Escape")
        assert state(page)["tool"] == "select" and state(page)["selection"]["id"] == "a"

        # Tour arrows navigate the tour rather than nudging selected objects.
        page.evaluate("async () => (await import('/src/store.ts')).setState({tour: 0})")
        page.keyboard.press("ArrowRight")
        assert state(page)["tour"] == 1 and state(page)["doc"]["objects"] == DOC["objects"]
        page.keyboard.press("Escape")
        assert state(page)["tour"] is None

        # Viewer navigation changes only the view, and transforms preserve drawing coordinates.
        reset(page, {"kind": "object", "id": "a"})
        before = state(page)["doc"]
        page.keyboard.press("=")
        expect(page.locator(".viewer-controls .mono")).to_have_text("125%")
        stage_before = page.locator(".stage").bounding_box()
        page.mouse.move(stage_before["x"] + stage_before["width"] / 2, stage_before["y"] + stage_before["height"] / 2)
        page.mouse.wheel(0, 30)
        page.wait_for_function("document.querySelector('.stage').style.transform.includes('-30px')")
        assert state(page)["doc"] == before
        page.keyboard.press("0")
        expect(page.locator(".viewer-controls .mono")).to_have_text("100%")
        page.keyboard.press("=")
        expect(page.locator(".viewer-controls .mono")).to_have_text("125%")
        page.keyboard.press("Shift+f")
        expect(page.locator(".viewer-controls .mono")).to_have_text("800%")
        assert state(page)["doc"] == before
        page.keyboard.press("0")
        expect(page.locator(".viewer-controls .mono")).to_have_text("100%")
        page.keyboard.press("=")
        expect(page.locator(".viewer-controls .mono")).to_have_text("125%")
        box = page.locator(".stage").bounding_box()
        page.keyboard.press("2")
        page.mouse.click(box["x"] + box["width"] * .5, box["y"] + box["height"] * .375)
        assert state(page)["doc"]["objects"][-1]["pos"] == [0, 1]
        page.keyboard.press("Escape")
        page.keyboard.press("f")
        expect(page.locator(".monitor")).to_have_class("monitor maximized")
        page.keyboard.press("?")
        expect(page.get_by_role("dialog")).to_be_visible()
        expect(page.locator(".help-body h2")).to_have_text("Keyboard shortcuts")
        page.keyboard.press("Escape")
        assert state(page)["viewerMaximized"]
        page.keyboard.press("Escape")
        assert not state(page)["viewerMaximized"]

        # Record nudges create simultaneous clips and a single undo restores the group.
        reset(page, {"kind": "objects", "ids": ["a", "b"]})
        page.keyboard.press("r")
        page.keyboard.press("Shift+ArrowUp")
        s = state(page)
        assert [c["start"] for c in s["doc"]["clips"][2:]] == [0, 0]
        assert s["time"] == 1 and len(s["past"]) == 1
        page.keyboard.press("Control+z")
        assert state(page)["doc"]["clips"] == DOC["clips"]

        # Search can add its first result; project actions reach the right API.
        reset(page)
        for tab in ["Scene", "Build"]:
            page.locator(".library .tabs").get_by_role("button", name=tab, exact=True).click()
            page.keyboard.press("/")
            expect(page.locator(".search")).to_be_focused()
            page.keyboard.press("Alt+2")
            expect(page.locator(".monitor")).to_be_focused()
        page.keyboard.press("/")
        page.locator(".search").fill("Circle")
        page.keyboard.press("Enter")
        assert len(state(page)["doc"]["objects"]) == 3
        expect(page.locator(".monitor")).to_be_focused()
        page.keyboard.press("Control+s")
        page.wait_for_timeout(100)
        assert any(path == "project/save" for path, _ in calls)
        page.keyboard.press("Control+Shift+s")
        page.wait_for_timeout(100)
        assert any(path == "dialog" and body["kind"] == "save" for path, body in calls)
        page.keyboard.press("Control+o")
        page.wait_for_timeout(100)
        assert any(path == "project/open" for path, _ in calls)
        assert not errors, errors
        browser.close()
    print("Keyboard browser checks passed")


if __name__ == "__main__":
    main()
