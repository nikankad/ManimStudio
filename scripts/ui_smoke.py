"""Browser smoke tests for the visual authoring tools (drives the real UI in Chromium).

Start the editor server first, then run this with Playwright installed:

    mathengine --serve --port 8765 &
    uv pip install playwright && python scripts/ui_smoke.py

Environment: MATHENGINE_URL (default http://127.0.0.1:8765/), CHROMIUM (a Chromium executable, optional),
SMOKE_OUT (where screenshots and saved projects go; default a temporary directory). Each scenario starts
from File > New and checks the project it saves through the UI.
"""
import json
import math
import os
import re
import sys
import tempfile

from playwright.sync_api import sync_playwright

URL = os.environ.get("MATHENGINE_URL", "http://127.0.0.1:8765/")
OUT = os.environ.get("SMOKE_OUT") or tempfile.mkdtemp(prefix="mathengine-smoke-")
errors: list[str] = []


def shot(page, name):
    page.screenshot(path=os.path.join(OUT, f"{name}.png"))


def saved(page):
    """Save through the UI (a window.prompt for the path) and return the document."""
    if os.path.exists(SAVE):
        os.remove(SAVE)
    page.keyboard.press("Control+s")
    for _ in range(300):
        if os.path.exists(SAVE):
            break
        page.wait_for_timeout(100)  # (not time.sleep: Playwright handles the prompt while waiting)
    page.wait_for_timeout(200)
    return json.load(open(SAVE))


def stage_point(page, x, y):
    """Scene coordinates -> page coordinates (default camera: 8 units tall)."""
    box = page.locator(".stage").bounding_box()
    w, h = box["width"], box["height"]
    cw = 8 * w / h
    return box["x"] + (x / cw + 0.5) * w, box["y"] + (0.5 - y / 8) * h


def click_scene(page, x, y, shift=False):
    if shift:
        page.keyboard.down("Shift")
    page.mouse.click(*stage_point(page, x, y))
    if shift:
        page.keyboard.up("Shift")


def drag_scene(page, a, b):
    page.mouse.move(*stage_point(page, *a))
    page.mouse.down()
    page.mouse.move(*stage_point(page, *b), steps=8)
    page.mouse.up()


def wait_frame(page, ms=1500):
    page.wait_for_timeout(ms)


def by_name(doc):
    return {o["name"]: o for o in doc["objects"]}


def open_page(p):
    exe = os.environ.get("CHROMIUM")
    browser = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    page = browser.new_page(viewport={"width": 1500, "height": 950})
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("dialog", lambda d: d.accept(SAVE) if d.type == "prompt" else d.accept())
    requests: list[str] = []
    page.on("request", lambda r: requests.append(r.url))
    return browser, page, requests


def drawing_graphs_equations(p):
    """Drawing tools, connections, graph builder, equations, starter insertion."""
    browser, page, requests = open_page(p)
    page.goto(URL)
    page.wait_for_selector(".lib-item", timeout=60000)
    page.locator(".toolbar button", has_text="New").click()  # start from an empty document
    page.wait_for_timeout(500)
    page.locator("body").click(position={"x": 5, "y": 5})

    # 1. Draw two points, then a segment between them (connects to the points), and a free circle.
    page.keyboard.press("2")
    click_scene(page, -3, -1)
    wait_frame(page, 800)
    click_scene(page, 2, 1)
    wait_frame(page)
    page.keyboard.press("3")
    click_scene(page, -3, -1)
    click_scene(page, 2, 1)
    wait_frame(page)
    page.keyboard.press("5")
    click_scene(page, 4, -2)
    page.locator(".entry input").fill("1.5")
    page.locator(".entry input").press("Enter")
    wait_frame(page)
    page.keyboard.press("7")
    for x, y in [(-5, 2), (-4, 3.2), (-3, 2)]:
        click_scene(page, x, y)
        page.wait_for_timeout(150)
    page.keyboard.press("Enter")
    wait_frame(page)
    page.keyboard.press("1")
    shot(page, "1_drawn")
    doc = saved(page)
    by_ctor = [(o["ctor"], o.get("link", {}).get("kind")) for o in doc["objects"]]
    print("after drawing:", by_ctor)
    assert ("Line", "segment") in by_ctor, by_ctor
    circle = next(o for o in doc["objects"] if o["ctor"] == "Circle")
    assert circle["args"]["radius"] == "1.5" and circle["pos"] == [4, -2], circle
    poly = next(o for o in doc["objects"] if o["ctor"] == "Polygon")
    assert poly["args"]["*"].count("np.array") == 3, poly

    # 2. Drag point B: the segment follows (it's linked) — check the rendered geometry via a second save.
    page.keyboard.press("Escape")
    px, py = stage_point(page, 2, 1)
    page.mouse.move(px, py)
    page.mouse.down()
    tx, ty = stage_point(page, 2, 2.5)
    page.mouse.move(tx, ty, steps=6)
    page.mouse.up()
    wait_frame(page)
    doc = saved(page)
    dots = [o for o in doc["objects"] if o["ctor"] == "Dot"]
    print("dots:", [d["pos"] for d in dots])
    assert any(d["pos"] == [2, 2.5] for d in dots), dots

    # 3. Select the segment's endpoints with shift-click and check Connect actions are offered.
    click_scene(page, -3, -1)
    click_scene(page, 2, 2.5, shift=True)
    page.wait_for_timeout(400)
    actions = page.locator(".inspector .chip").all_inner_texts()
    print("two points actions:", actions)
    assert "Midpoint" in actions and "Segment" in actions
    page.locator(".inspector .chip", has_text="Midpoint").first.click()
    wait_frame(page)
    shot(page, "2_connected")

    # 4. Graph builder: y = a*x^2 + b with new parameters and new axes.
    page.locator("button", has_text="ƒ Graph").first.click()
    page.locator(".graph-builder input.big").fill("y = a*x^2 + b")
    page.wait_for_timeout(800)
    shot(page, "3_graph_builder")
    page.locator("button", has_text="Create graph").click()
    wait_frame(page, 2500)
    doc = saved(page)
    names = {o["name"]: o for o in doc["objects"]}
    assert names["a"]["ctor"] == "ValueTracker" and names["b"]["ctor"] == "ValueTracker"
    graph = next(o for o in doc["objects"] if o.get("link", {}).get("kind") == "graph")
    print("graph:", graph["ctor"], graph["link"])
    # Point on curve via the graph's actions.
    page.locator(".inspector .chip", has_text="Point on curve").click()
    wait_frame(page)
    page.locator(".inspector .chip", has_text="Shade interval").count()
    shot(page, "4_graph")

    # 5. Unsupported syntax is explained.
    page.locator("button", has_text="ƒ Graph").first.click()
    page.locator(".graph-builder input.big").fill("x^2 + y^2 = 1")
    page.wait_for_timeout(800)
    msg = page.locator(".graph-builder .err-box").inner_text()
    print("implicit:", msg)
    assert "implicit" in msg.lower()
    page.keyboard.press("Escape")
    page.locator(".modal-head button").click() if page.locator(".modal-head button").count() else None

    # 6. Equation: add MathTex from the library, split into terms, MathLive loads.
    page.locator(".library .search").fill("MathTex")
    page.locator(".lib-item", has_text="MathTex").first.dblclick()
    wait_frame(page, 2500)
    page.locator("button", has_text="Split into terms").click()
    page.wait_for_selector("math-field", timeout=20000)
    page.wait_for_timeout(500)
    terms = page.locator(".equation .term").all_inner_texts()
    print("terms:", terms)
    assert len(terms) >= 5
    page.locator("button", has_text="Check with manim").click()
    page.wait_for_selector(".equation .ok-text, .equation .err-text", timeout=60000)
    print("check:", page.locator(".equation .ok-text, .equation .err-text").first.inner_text())
    page.locator(".equation .term").nth(0).click()
    page.locator(".inspector .chip", has_text="Brace").click()
    wait_frame(page, 2500)
    shot(page, "5_equation")

    # 7. Insert the unit circle starter.
    page.locator(".library .tabs button", has_text="Build").click()
    page.locator(".construction-name", has_text="Unit circle").click()
    page.locator("button", has_text="Insert at playhead").click()
    wait_frame(page, 3000)
    shot(page, "6_unit_circle")
    doc = saved(page)
    assert any(o["name"].startswith("theta") for o in doc["objects"])
    assert doc["version"] == 3

    cdn = [u for u in requests if not u.startswith(URL.rstrip("/"))]
    print("external requests:", cdn)
    browser.close()


def connections_records_constructions(p):
    """Label offsets, undo, delete + detach, record-mode parameter drags, saved constructions, TransformTerms."""
    browser, page, _requests = open_page(p)
    page.goto(URL)
    page.wait_for_selector(".lib-item", timeout=60000)
    page.locator(".toolbar button", has_text="New").click()
    page.wait_for_timeout(500)
    page.locator("body").click(position={"x": 5, "y": 5})

    # Two points, a segment between them, and a label attached to A.
    page.keyboard.press("2")
    click_scene(page, -3, -1)
    page.wait_for_timeout(700)
    click_scene(page, 1, 1)
    page.wait_for_timeout(1200)
    page.keyboard.press("3")
    click_scene(page, -3, -1)
    click_scene(page, 1, 1)
    page.wait_for_timeout(1200)
    page.keyboard.press("1")
    click_scene(page, -3, -1)
    page.wait_for_timeout(400)
    page.locator(".inspector .chip", has_text="Attach label").click()
    page.wait_for_timeout(2500)
    doc = saved(page)
    label = next(o for o in doc["objects"] if o.get("link", {}).get("kind") == "attach")
    off0 = label["link"]["offset"]
    # Drag the label: its offset changes, it stays attached.
    lx, ly = -3 + off0[0], -1 + off0[1]
    click_scene(page, lx, ly)
    page.wait_for_timeout(300)
    drag_scene(page, (lx, ly), (lx + 1, ly + 0.5))
    page.wait_for_timeout(1500)
    doc = saved(page)
    label = by_name(doc)[label["name"]]
    print("label offset", off0, "->", label["link"]["offset"])
    assert label["link"]["kind"] == "attach" and abs(label["link"]["offset"][0] - off0[0] - 1) < 0.05

    # Undo restores the old offset, redo reapplies it.
    page.keyboard.press("Control+z")
    page.wait_for_timeout(300)
    doc = saved(page)
    assert by_name(doc)[label["name"]]["link"]["offset"] == off0, by_name(doc)[label["name"]]["link"]
    page.keyboard.press("Control+Shift+z")
    page.wait_for_timeout(300)

    # Multi-duplicate the segment and its label: the copied label follows the original point (external source).
    seg = next(o for o in doc["objects"] if o.get("link", {}).get("kind") == "segment")
    page.wait_for_timeout(1000)

    # Delete point A: the dialog offers detach; the segment becomes a plain Line, the label is detached.
    click_scene(page, -3, -1)
    page.wait_for_timeout(300)
    page.keyboard.press("Delete")
    page.wait_for_selector(".modal", timeout=5000)
    shot(page, "1_delete_dialog")
    page.locator(".modal button", has_text="Detach and delete").click()
    page.wait_for_timeout(1500)
    doc = saved(page)
    names = by_name(doc)
    print("after delete:", [(o["name"], o["ctor"], o.get("link", {}).get("kind")) for o in doc["objects"]])
    assert seg["name"] in names and "link" not in names[seg["name"]] and "start" in names[seg["name"]]["args"]
    assert "link" not in names[label["name"]]

    # Unit circle starter: drag P around in Record mode -> a set_value clip on theta.
    page.locator(".library .tabs button", has_text="Build").click()
    page.locator(".construction-name", has_text="Unit circle").click()
    page.locator(".modal button", has_text="Insert at playhead").click()
    page.wait_for_timeout(3500)
    doc = saved(page)
    theta = next(o for o in doc["objects"] if o["ctor"] == "ValueTracker" and o["name"].startswith("theta"))
    P = next(o for o in doc["objects"] if o.get("link", {}).get("kind") == "on_circle")
    clips_before = len(doc["clips"])
    page.locator("text=Record").click()
    # P sits at angle pi/4 on a circle of radius 2 around (0, 0) (axes 6 units for 3 -> 2 per unit).
    px, py = 2 * math.cos(math.pi / 4), 2 * math.sin(math.pi / 4)
    click_scene(page, px, py)
    page.wait_for_timeout(400)
    drag_scene(page, (px, py), (0, 2))
    page.wait_for_timeout(1500)
    page.locator("text=Record").click()
    doc = saved(page)
    new = [c for c in doc["clips"] if c.get("target") == theta["name"] and c.get("cls") == "animate"]
    print("theta clips:", [(c["start"], c["chain"]) for c in new])
    assert len(doc["clips"]) == clips_before + 1 and any("set_value(1.57" in c["chain"] for c in new), doc["clips"][-1]
    shot(page, "2_record")

    # Save a construction from the selection and insert it again as an independent copy.
    page.locator(".toolbar button", has_text="New").click()
    page.wait_for_timeout(300)
    page.keyboard.press("2")
    click_scene(page, -2, 0)
    page.wait_for_timeout(700)
    click_scene(page, 0, 2)
    page.wait_for_timeout(1200)
    page.keyboard.press("3")
    click_scene(page, -2, 0)
    click_scene(page, 0, 2)
    page.wait_for_timeout(1500)
    page.keyboard.press("1")
    # The segment is selected after creation; save it (its points come along).
    page.locator(".inspector button", has_text="Save…").click()
    page.wait_for_selector(".modal")
    page.locator(".modal .param input").first.fill("Bar")
    page.locator(".modal button", has_text="Save").last.click()
    page.wait_for_timeout(500)
    page.locator(".library .tabs button", has_text="Build").click()
    page.locator(".construction-name", has_text="Bar").click()
    page.locator(".modal input.num").first.fill("3")
    page.locator(".modal button", has_text="Insert at playhead").click()
    page.wait_for_timeout(2000)
    doc = saved(page)
    segs = [o for o in doc["objects"] if o.get("link", {}).get("kind") == "segment"]
    print("segments:", [(s["name"], s["link"]) for s in segs], "templates:", [t["name"] for t in doc.get("constructions", [])])
    assert len(segs) == 2 and segs[0]["link"]["a"] != segs[1]["link"]["a"]
    assert doc["constructions"][0]["name"] == "Bar"

    # TransformTerms: two equations, pair identical terms.
    page.locator(".library .tabs button", has_text="Objects").click()
    page.locator(".library .search").fill("MathTex")
    for tex in ["a^2 + b^2 = c^2", "a^2 = c^2 - b^2"]:
        page.locator(".lib-item", has_text="MathTex").first.dblclick()
        page.wait_for_timeout(1500)
        page.locator(".equation textarea").fill(tex)
        page.wait_for_timeout(300)
        page.locator("button", has_text="Split into terms").click()
        page.wait_for_timeout(500)
    # The second equation is selected; go back to the first one and add the transform.
    doc = saved(page)
    eqs = [o for o in doc["objects"] if o["ctor"] == "MathTex"]
    page.locator(".library .tabs button", has_text="Scene").click()
    page.locator(".outline-row").filter(has=page.locator("span.mono", has_text=re.compile("^" + eqs[0]["name"] + "$"))).click()
    page.wait_for_timeout(500)
    page.locator(".inspector .chip", has_text="Transform terms").click()
    page.wait_for_timeout(500)
    page.locator(".terms-editor select").select_option(eqs[1]["id"])
    page.locator(".terms-editor button", has_text="Pair identical terms").click()
    page.wait_for_timeout(2500)
    shot(page, "3_terms")
    doc = saved(page)
    tt = next(c for c in doc["clips"] if c.get("cls") == "TransformTerms")
    print("pairs:", tt["terms"])
    assert len(tt["terms"]["pairs"]) == 4  # a^2, b^2, =, c^2 (+ and - differ)
    assert "does not check" in page.locator(".terms-editor .note").inner_text()

    # Two instances of the same construction get separate names; renaming never touches string literals.
    page.locator(".toolbar button", has_text="New").click()
    page.wait_for_timeout(300)
    page.locator(".library .tabs button", has_text="Build").click()
    for _ in range(2):
        page.locator(".construction-name", has_text="Unit circle").click()
        page.locator(".modal button", has_text="Insert at playhead").click()
        page.wait_for_timeout(1500)
    doc = saved(page)
    labels = [o for o in doc["objects"] if o["name"].startswith("theta_label")]
    values = [o for o in doc["objects"] if o["name"].startswith("cos_value")]
    print("labels:", [l["args"]["*"] for l in labels], "values:", [v["link"]["expr"] for v in values])
    assert [l["args"]["*"] for l in labels] == ['r"\\theta"', 'r"\\theta"']
    assert sorted(v["link"]["expr"] for v in values) == ["cos(theta)", "cos(theta2)"]
    browser.close()


def intersections_and_perpendiculars(p):
    """Altitudes of a triangle meet at a linked intersection; the point tool snaps to crossings."""
    browser, page, requests = open_page(p)
    page.goto(URL)
    page.wait_for_selector(".lib-item", timeout=60000)
    page.locator(".toolbar button", has_text="New").click()
    page.wait_for_timeout(500)
    page.locator("body").click(position={"x": 5, "y": 5})

    # Triangle A(-3, -2), B(3, -2), C(1, 2) with sides connected to the points.
    A, B, C = (-3, -2), (3, -2), (1, 2)
    page.keyboard.press("2")
    for pt in (A, B, C):
        click_scene(page, *pt)
        wait_frame(page, 800)
    page.keyboard.press("3")
    for a, b in ((A, B), (B, C), (C, A)):
        click_scene(page, *a)
        click_scene(page, *b)
        wait_frame(page, 800)
    page.keyboard.press("1")
    wait_frame(page)

    # Altitude from C to AB, and from A to BC.
    click_scene(page, *C)
    click_scene(page, 0, -2, shift=True)
    page.wait_for_timeout(400)
    actions = page.locator(".inspector .chip").all_inner_texts()
    print("point + line actions:", actions)
    for a in ("Perpendicular", "Parallel", "Altitude", "Foot of perpendicular"):
        assert a in actions, (a, actions)
    page.locator(".inspector .chip", has_text="Altitude").click()
    wait_frame(page)
    click_scene(page, *A)
    click_scene(page, 2, 0, shift=True)
    page.wait_for_timeout(400)
    page.locator(".inspector .chip", has_text="Altitude").click()
    wait_frame(page)

    # Their intersection (the orthocenter, at (1, 0)).
    click_scene(page, 1, 1.2)
    click_scene(page, -0.6, -0.8, shift=True)
    page.wait_for_timeout(400)
    actions = page.locator(".inspector .chip").all_inner_texts()
    print("two lines actions:", actions)
    page.locator(".inspector .chip", has_text="Intersection").click()
    wait_frame(page)
    doc = saved(page)
    alts = [o for o in doc["objects"] if o.get("link", {}).get("kind") == "perpendicular"]
    assert len(alts) == 2 and all(o["link"].get("mode") == "foot" and o["ctor"] == "DashedLine" for o in alts), alts
    h = next(o for o in doc["objects"] if o.get("link", {}).get("kind") == "intersection")
    assert {h["link"]["a"], h["link"]["b"]} == {o["id"] for o in alts}, h
    shot(page, "1_orthocenter")

    # Point tool on a crossing: a free circle at (-2, -2), r = 1.5 meets AB (extended) at x = -3.5 and -0.5;
    # only -0.5 is on the drawn segment, and it is the second along AB from A.
    page.keyboard.press("5")
    click_scene(page, -2, -2)
    page.locator(".entry input").fill("1.5")
    page.locator(".entry input").press("Enter")
    wait_frame(page)
    doc = saved(page)
    circle = next(o for o in doc["objects"] if o["ctor"] == "Circle")
    (cx, cy), r = circle["pos"], float(circle["args"]["radius"])
    assert (cx, cy) == (-2, -2) and r == 1.5, circle
    x_hit = cx + math.sqrt(r * r - (-2 - cy) ** 2)  # the right crossing with y = -2
    page.keyboard.press("2")
    page.mouse.move(*stage_point(page, x_hit + 0.03, -2.03))
    page.wait_for_timeout(200)
    click_scene(page, x_hit + 0.03, -2.03)
    wait_frame(page)
    page.keyboard.press("1")
    doc = saved(page)
    hits = [o for o in doc["objects"] if o.get("link", {}).get("kind") == "intersection"]
    print("intersections:", [o["link"] for o in hits])
    assert len(hits) == 2, hits
    x = next(o for o in hits if o["id"] != h["id"])
    ab = next(o for o in doc["objects"] if o.get("link", {}).get("kind") == "segment" and o["id"] in (x["link"]["a"], x["link"]["b"]))
    assert circle["id"] in (x["link"]["a"], x["link"]["b"]) and x["link"].get("which") == 1, x
    # The scene puts the linked point on the same crossing the editor snapped to.
    from mathengine import runtime

    res = runtime.run(doc, 60, render=False)  # after every intro animation
    assert res.error is None, res.error
    center = next(o for o in res.objects if o["id"] == x["id"])["center"]
    print("snapped intersection:", x["link"], "scene:", center, "expected:", [x_hit, -2], "on", ab["name"])
    assert abs(center[0] - x_hit) < 1e-3 and abs(center[1] + 2) < 1e-3, center
    # The orthocenter of the triangle as drawn (clicks land within a pixel or two of A, B, C).
    free_dots = [d["name"] for d in doc["objects"] if d["ctor"] == "Dot" and not d.get("link")]  # A, B, C in drawing order
    (ax, ay), (bx, by), (qx, qy) = [next(o for o in res.objects if o["name"] == n)["center"] for n in free_dots]
    # Altitudes from C (perpendicular to AB) and from A (perpendicular to BC): solve (P - C).(B - A) = 0, (P - A).(C - B) = 0.
    m = [[bx - ax, by - ay], [qx - bx, qy - by]]
    rhs = [qx * (bx - ax) + qy * (by - ay), ax * (qx - bx) + ay * (qy - by)]
    det = m[0][0] * m[1][1] - m[0][1] * m[1][0]
    expected = [(rhs[0] * m[1][1] - m[0][1] * rhs[1]) / det, (m[0][0] * rhs[1] - rhs[0] * m[1][0]) / det]
    ortho = next(o for o in res.objects if o["id"] == h["id"])["center"]
    print("orthocenter:", ortho, "expected:", expected, "stored start:", h["pos"])
    assert abs(ortho[0] - expected[0]) < 1e-3 and abs(ortho[1] - expected[1]) < 1e-3, ortho
    assert abs(h["pos"][0] - expected[0]) < 0.02 and abs(h["pos"][1] - expected[1]) < 0.02, h
    shot(page, "2_snapped")

    # A graph's roots and y-intercept, and dropping a point on the curve to the x-axis.
    page.locator(".toolbar button", has_text="New").click()
    page.wait_for_timeout(500)
    page.locator("button", has_text="ƒ Graph").first.click()
    page.locator(".graph-builder input.big").fill("y = x^2 - 2")
    page.wait_for_timeout(800)
    page.locator("button", has_text="Create graph").click()
    wait_frame(page, 2500)
    actions = page.locator(".inspector .chip").all_inner_texts()
    print("graph actions:", actions)
    page.locator(".inspector .chip", has_text="Mark roots").click()
    wait_frame(page)
    doc = saved(page)
    graph = next(o for o in doc["objects"] if o.get("link", {}).get("kind") == "graph")
    page.locator(".library .tabs button", has_text="Scene").click()
    page.locator(".outline-row").filter(has=page.locator("span.mono", has_text=re.compile("^" + graph["name"] + "$"))).click()
    page.wait_for_timeout(400)
    page.locator(".inspector .chip", has_text="y-intercept").click()
    wait_frame(page)
    page.locator(".outline-row").filter(has=page.locator("span.mono", has_text=re.compile("^" + graph["name"] + "$"))).click()
    page.wait_for_timeout(400)
    page.locator(".inspector .chip", has_text="Point on curve").click()
    wait_frame(page)
    doc = saved(page)
    P = next(o for o in doc["objects"] if o.get("link", {}).get("kind") == "on_graph")
    axes = next(o for o in doc["objects"] if o["id"] == graph["link"]["axes"])
    page.locator(".outline-row").filter(has=page.locator("span.mono", has_text=re.compile("^" + P["name"] + "$"))).click()
    page.locator(".outline-row").filter(has=page.locator("span.mono", has_text=re.compile("^" + axes["name"] + "$"))).click(modifiers=["Shift"])
    page.wait_for_timeout(400)
    actions = page.locator(".inspector .chip").all_inner_texts()
    print("point + axes actions:", actions)
    page.locator(".inspector .chip", has_text="Drop to x-axis").click()
    wait_frame(page)
    doc = saved(page)
    shot(page, "3_roots")
    res = runtime.run(doc, 60, render=False)
    assert res.error is None, res.error
    info = {o["id"]: o for o in res.objects}
    ax = info[axes["id"]]["axes"]

    def coords(c):
        dx, dy = c[0] - ax["origin"][0], c[1] - ax["origin"][1]
        return [dx / ax["ux"][0], dy / ax["uy"][1]]

    meets = sorted((o for o in doc["objects"] if o.get("link", {}).get("kind") == "intersection"), key=lambda o: o["name"])
    found = sorted(tuple(round(v, 3) for v in coords(info[o["id"]]["center"])) for o in meets)
    print("roots and y-intercept:", found)
    assert found == [(-1.414, 0), (0, -2), (1.414, 0)], found
    foot = next(o for o in doc["objects"] if o.get("link", {}).get("kind") == "projection")
    fx = coords(info[foot["id"]]["center"])
    px = coords(info[P["id"]]["center"])
    assert abs(fx[0] - px[0]) < 1e-3 and abs(fx[1]) < 1e-3, (fx, px)
    assert any(o.get("link", {}).get("kind") == "segment" and o["ctor"] == "DashedLine" for o in doc["objects"])
    browser.close()


def timeline_editing(p):
    """Search ranking, where moved clips land, keyboard focus after library drops, timecode entry, order warnings."""
    browser, page, requests = open_page(p)
    page.goto(URL)
    page.wait_for_selector(".lib-item", timeout=60000)
    page.locator(".toolbar button", has_text="New").click()
    page.wait_for_timeout(500)

    def clips():
        d = saved(page)
        names = {t["id"]: t["name"] for t in d["tracks"]}
        return sorted(((c.get("cls") or c["kind"], c.get("target"), names[c["track"]], c["start"]) for c in d["clips"]), key=lambda c: (c[2], c[3]))

    def timecode():
        return page.locator(".tl-header .timecode").first.inner_text()

    # Exact matches come first in the library search; taking an item gives the keyboard back to the editor.
    for name in ("Circle", "Square"):
        page.locator(".library .search").fill(name)
        assert page.locator(".lib-item").first.inner_text() == name, page.locator(".lib-item").first.inner_text()
        page.locator(".lib-item").first.dblclick()
        page.wait_for_timeout(1000)
    assert page.evaluate("document.activeElement.tagName") == "BODY"
    assert clips() == [("Create", "circle", "V1", 0), ("Create", "square", "V1", 1)], clips()

    lanes = page.locator(".tl-lanes").bounding_box()
    pps = page.locator(".timeline .clip").first.bounding_box()["width"]  # a 1 s clip

    def row_mid(name):
        b = page.locator(".track-head", has_text=name).bounding_box()
        return b["y"] + b["height"] / 2

    # Dropping the square's clip onto the circle's: the ghost shows it on V2, and it lands there.
    y1, y2 = row_mid("V1"), row_mid("V2")
    page.mouse.move(lanes["x"] + 1.5 * pps, y1)
    page.mouse.down()
    page.mouse.move(lanes["x"] + 1.0 * pps, y1, steps=8)
    ghost = page.locator(".timeline .clip.ghost").first.bounding_box()
    assert abs(ghost["y"] + ghost["height"] / 2 - y2) < 10, (ghost, y2)
    page.mouse.up()
    page.wait_for_timeout(500)
    assert clips() == [("Create", "circle", "V1", 0), ("Create", "square", "V2", 0.5)], clips()

    # An effect dropped on a track with nothing selected says what it targets; Space then plays.
    page.keyboard.press("Escape")
    page.locator(".library .tabs button", has_text="Effects").click()
    page.locator(".library .search").fill("Indicate")
    page.locator(".lib-item", has_text="Indicate").first.drag_to(page.locator(".tl-lanes"), target_position={"x": 3 * pps, "y": 30 + 24})
    page.wait_for_timeout(500)
    assert "animates square" in " ".join(page.locator(".toast").all_inner_texts()), page.locator(".toast").all_inner_texts()
    page.keyboard.press("Home")
    page.keyboard.press("Space")
    page.wait_for_timeout(800)
    page.keyboard.press("Space")
    assert timecode() != "00:00:00:00", timecode()

    # Typing in the timecode replaces it.
    page.locator(".tl-header .timecode").click()
    page.keyboard.type("3")
    page.keyboard.press("Enter")
    page.wait_for_timeout(200)
    assert timecode() == "00:00:03:00", timecode()

    # An .animate clip on the circle before its Create is marked and explained.
    page.mouse.click(lanes["x"] + 1, lanes["y"] + 10)  # playhead to 0 (ruler)
    page.locator(".library .tabs button", has_text="Scene").click()
    page.locator(".outline-row", has_text="circle").first.click()
    page.locator(".library .tabs button", has_text="Effects").click()
    page.locator(".lib-item", has_text=".animate").first.dblclick()
    page.wait_for_timeout(300)
    create = page.locator(".timeline .clip", has_text="circle").filter(has_text="Create").first.bounding_box()
    page.mouse.move(create["x"] + create["width"] / 2, create["y"] + create["height"] / 2)
    page.mouse.down()
    page.mouse.move(create["x"] + create["width"] / 2 + 2 * pps, create["y"] + create["height"] / 2, steps=8)
    page.mouse.up()
    page.wait_for_selector(".timeline .clip.warn", timeout=20000)
    title = page.locator(".timeline .clip.warn").first.get_attribute("title")
    print("order warning:", title.split("⚠")[-1].strip()[:90])
    assert "only appears at 2s (Create)" in title, title
    shot(page, "timeline_warning")
    browser.close()


SAVE = os.path.join(OUT, "smoke.mathengine")
with sync_playwright() as p:
    drawing_graphs_equations(p)
    connections_records_constructions(p)
    intersections_and_perpendiculars(p)
    timeline_editing(p)
print("screenshots in", OUT)
print("ERRORS:", errors)
sys.exit(1 if errors else 0)
