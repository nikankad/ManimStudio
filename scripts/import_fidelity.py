"""How much of real manim code the editor takes in as editable scenes, and whether it plays the same.

Usage: python scripts/import_fidelity.py [--out docs/research/import-fidelity.md] [--jobs 4]

The corpus: the examples in manim's own docstrings (the ``.. manim::`` blocks of the installed package, the gallery of
the manim docs), this repository's examples/, and scripts/fidelity_corpus/ (files shaped like a project: several
scenes, helper methods, state on ``self``, custom Mobject classes, updaters, camera moves).

Each scene is run natively by manim first; a scene manim itself can't render here (no LaTeX, OpenGL only, missing
asset files) is listed as skipped and left out of the numbers. Then, for each scene:

* Structure: how many of construct()'s statements became objects, plays, waits, adds and removes (editable on the
  timeline), and how many were kept as code steps (they run as written but are opaque to the editor), with the
  importer's reasons.
* Keyframes: the keyframes the Effect Controls rows show per channel, how many can be edited there and why not.
  Animations whose target isn't one of the document's objects (``group[0]``, ``self.camera.frame``) have no
  keyframe rows: counted apart.
* Parity: the code regenerated from the document, run by manim, against the original (length, number of plays, the
  frame at the end of every play and wait), and the editor's own preview run against manim (length).
* Code: whether the regenerated construct() is the same Python (AST) as the original, else which rewrite makes the
  difference: "split chains" (``x = Square().scale(2)`` written as ``x = Square()`` and ``x.scale(2)``), "keywords"
  (``Line(a, b)`` written as ``Line(a, end=b)``), or "other".

It is slow (a manim run or three per scene), so it is not part of the tests.
"""

from __future__ import annotations

import argparse
import ast
import collections
import copy
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FPS = 15
SIZE = (192, 108)


# ---------------------------------------------------------------------------------------------------- corpus


def docstring_examples(dest: Path) -> list[Path]:
    """Every ``.. manim:: Name`` block of the installed manim package, one file each."""
    import manim

    out = []
    pkg = Path(manim.__file__).parent
    for py in sorted(pkg.rglob("*.py")):
        lines = py.read_text(encoding="utf-8").splitlines()
        i = 0
        while i < len(lines):
            m = re.match(r"^(\s*)\.\. manim::\s*(\w+)", lines[i])
            if not m:
                i += 1
                continue
            indent, name = len(m.group(1)), m.group(2)
            body = []
            i += 1
            while i < len(lines) and (not lines[i].strip() or len(lines[i]) - len(lines[i].lstrip()) > indent):
                body.append(lines[i])
                i += 1
            code = [ln for ln in body if not re.match(r"^\s*:\w+:", ln)]
            src = textwrap.dedent("\n".join(code)).strip("\n")
            if f"class {name}" not in src:
                continue
            try:
                ast.parse(src)
            except SyntaxError:  # a doctest (>>>) or a fragment, not a file
                continue
            f = dest / f"{py.stem}__{name}.py"
            f.write_text(("" if "from manim import" in src else "from manim import *\n\n") + src + "\n")
            out.append(f)
    return out


def corpus(tmp: Path) -> list[tuple[str, Path]]:
    docs = tmp / "manim_docs"
    docs.mkdir()
    items = [("manim docs", p) for p in docstring_examples(docs)]
    items += [("examples/", p) for p in sorted((ROOT / "examples").glob("*.py"))]
    items += [("project-shaped", p) for p in sorted((ROOT / "scripts" / "fidelity_corpus").glob("*.py"))]
    return items


# ---------------------------------------------------------------------------------------------------- one scene


def native(src: str, scene: str) -> dict:
    """Run ``src``'s ``scene`` with manim: its length, plays, and final frame (as a numpy array)."""
    import random

    import numpy as np

    from mathengine import runtime

    m = runtime.manim()
    media = tempfile.mkdtemp(prefix="import-fidelity-media-")  # its own: scenes running side by side share no files
    with m.tempconfig({"format": "none", "disable_caching": True, "frame_rate": FPS, "pixel_width": SIZE[0],
                       "pixel_height": SIZE[1], "verbosity": "ERROR", "progress_bar": "none", "write_to_movie": False,
                       "media_dir": media}):
        ns: dict = {"__name__": "corpus_scene"}
        exec(compile(src, "<scene>", "exec"), ns)
        s = ns[scene]()
        frames = []

        def snap():
            s.renderer.update_frame(s)
            frames.append(np.array(s.renderer.get_frame(), dtype=np.int16))

        def play(*args, **kwargs):  # the frame at the end of every self.play and self.wait
            type(s).play(s, *args, **kwargs)
            snap()

        def wait(*args, **kwargs):
            type(s).wait(s, *args, **kwargs)
            snap()

        def construct():  # the same random numbers in both runs (a Scene reseeds when it is made)
            random.seed(0)
            np.random.seed(0)
            type(s).construct(s)

        s.play, s.wait, s.construct = play, wait, construct
        s.render()
        snap()
    return {"duration": round(float(s.renderer.time), 4), "plays": s.renderer.num_plays, "frames": frames}


def count_statements(code: str) -> int:
    try:
        return len(ast.parse(textwrap.dedent(code)).body)
    except SyntaxError:
        return len([ln for ln in code.splitlines() if ln.strip() and not ln.strip().startswith("#")])


def construct_of(src: str, scene: str):
    tree = ast.parse(src)
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == scene)
    return cls, next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "construct")


# ---- comparing code: the same, or the same up to one of the rewrites the importer makes


def _merge_chains(body: list) -> list:
    """``x = E`` then ``x.m(...)``: as ``x = E.m(...)``, the way manim code often writes it in one line."""
    out: list = []
    for st in body:
        prev = out[-1] if out else None
        if (isinstance(prev, ast.Assign) and len(prev.targets) == 1 and isinstance(prev.targets[0], ast.Name)
                and isinstance(st, ast.Expr) and isinstance(st.value, ast.Call) and isinstance(st.value.func, ast.Attribute)):
            root = st.value
            while isinstance(root, ast.Call) and isinstance(root.func, ast.Attribute):
                root = root.func.value
            if isinstance(root, ast.Name) and root.id == prev.targets[0].id:
                new = copy.deepcopy(st.value)
                cur = new
                while isinstance(cur.func.value, ast.Call) and isinstance(cur.func.value.func, ast.Attribute):
                    cur = cur.func.value
                cur.func.value = prev.value
                out[-1] = ast.Assign(targets=prev.targets, value=new, lineno=0)
                continue
        out.append(st)
    return out


class _NoKeywords(ast.NodeTransformer):
    """Calls with their argument values only: ``Line(a, b)`` and ``Line(a, end=b)`` read the same."""

    def visit_Call(self, node):
        self.generic_visit(node)
        values = [ast.dump(a) for a in node.args] + [ast.dump(k.value) for k in node.keywords if k.arg]
        node.args = [ast.Constant(v) for v in sorted(values)]
        node.keywords = [k for k in node.keywords if not k.arg]
        return node


def _dump(body: list, chains: bool = False, keywords: bool = False) -> str:
    m = ast.Module(copy.deepcopy(_merge_chains(body) if chains else body), [])
    return ast.dump(_NoKeywords().visit(m) if keywords else m)


def code_difference(a: list, b: list) -> str:
    """How construct()'s statements ``b`` differ from ``a``: not at all, or only in how they are written."""
    for kind, chains, keywords in [("same", False, False), ("split chains", True, False), ("keywords", False, True),
                                   ("split chains + keywords", True, True)]:
        if _dump(a, chains, keywords) == _dump(b, chains, keywords):
            return kind
    return "other"


def statement_kind(st: ast.stmt) -> str:
    """What a statement kept as code does, roughly: to see which kinds of code the editor doesn't take in."""
    if isinstance(st, (ast.For, ast.While)):
        return "loop"
    if isinstance(st, ast.FunctionDef):
        return "function definition"
    if isinstance(st, ast.Expr) and isinstance(st.value, ast.Call) and isinstance(st.value.func, ast.Attribute):
        on = ast.unparse(st.value.func.value)
        if on == "self":
            return f"self.{st.value.func.attr}(…) with computed arguments"
        if "updater" in st.value.func.attr:
            return "updater"
        if re.fullmatch(r"\w+", on):
            return "method call on an object, later in the scene (.set_color, .next_to, .move_to…)"
        return "method call on an expression (VGroup(...).arrange(), group[0].shift()…)"
    if isinstance(st, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
        v = st.value
        if isinstance(st, ast.Assign) and not all(isinstance(t, ast.Name) for t in st.targets):
            return "assignment to an attribute, item or several names"
        if isinstance(v, (ast.List, ast.Tuple, ast.Dict, ast.Constant, ast.Lambda, ast.BinOp, ast.UnaryOp)):
            return "plain value (number, list, dict, lambda…)"
        if isinstance(v, (ast.ListComp, ast.GeneratorExp, ast.DictComp)):
            return "list comprehension"
        if isinstance(st, ast.AugAssign):
            return "+= / -="
        if isinstance(v, ast.Call):
            return "object built by a call the importer doesn't take (a method, a helper function, *args…)"
        return "other assignment"
    return type(st).__name__


def leaves(anims):
    for a in anims or []:
        if a.get("anims"):
            yield from leaves(a["anims"])
        else:
            yield a


def one(path: str, scene: str) -> dict:
    from mathengine import codegen, runtime
    from mathengine.importer import CodeError, import_code

    src = Path(path).read_text()
    res: dict = {"scene": scene}
    try:
        nat = native(src, scene)
    except BaseException as e:  # noqa: BLE001 - a scene manim can't run here
        res["skip"] = f"{type(e).__name__}: {str(e).strip().splitlines()[0][:120] if str(e).strip() else ''}"
        return res
    res["blank"] = all(bool((f == f[0, 0]).all()) for f in nat["frames"])
    res["native_duration"] = nat["duration"]
    try:
        imp = import_code(src, scene=scene)
    except CodeError as e:
        res["import_error"] = e.message
        return res
    except Exception as e:  # noqa: BLE001
        res["import_error"] = f"{type(e).__name__}: {e}"
        return res
    doc = imp.doc
    doc["config"]["frame_rate"] = FPS
    res["notes"] = imp.notes
    res["scenes_in_file"] = len(imp.scenes)

    # structure
    cls, construct = construct_of(src, scene)
    res["statements"] = len(construct.body)
    res["code_statements"] = sum(count_statements(s.get("code", "")) for s in doc["timeline"] if s["kind"] == "code")
    kinds: collections.Counter = collections.Counter()
    for s in doc["timeline"]:
        if s["kind"] == "code":
            try:
                kinds.update(statement_kind(st) for st in ast.parse(textwrap.dedent(s.get("code", ""))).body)
            except SyntaxError:
                kinds["unreadable"] += 1
    res["code_kinds"] = dict(kinds)
    res["steps"] = dict(collections.Counter(s["kind"] for s in doc["timeline"]))
    res["objects"] = len(doc["objects"])
    res["other_members"] = len([n for n in cls.body if not (isinstance(n, ast.FunctionDef) and n.name == "construct")])
    names = {o["name"] for o in doc["objects"]}
    anims = [a for s in doc["timeline"] if s["kind"] == "play" for a in leaves(s.get("anims"))]
    res["anims"] = len(anims)
    res["anims_on_objects"] = sum(1 for a in anims if a.get("target") in names)
    res["anim_classes"] = dict(collections.Counter(a.get("cls") for a in anims))

    # parity: regenerated code under manim, and the editor's preview
    regenerated = codegen.generate(doc, latex=True).source
    try:
        again = native(regenerated, scene)
        res["regen_duration"] = [nat["duration"], again["duration"]]
        res["regen_plays"] = [nat["plays"], again["plays"]]
        # the frames at the end of each play and wait: the share of pixels that differ, at the worst of them
        pairs = list(zip(nat["frames"], again["frames"]))
        worst = 0.0 if len(nat["frames"]) == len(again["frames"]) else 1.0
        for f0, f1 in pairs:
            worst = max(worst, float((abs(f0 - f1).max(axis=-1) > 2).mean()) if f0.shape == f1.shape else 1.0)
        res["regen_frame_diff"] = worst
        res["frames_compared"] = len(pairs)
    except BaseException as e:  # noqa: BLE001
        res["regen_error"] = f"{type(e).__name__}: {str(e)[:160]}"
    try:
        r = runtime.run(doc, render=False)
        if r.error:
            res["editor_error"] = str(r.error.get("message", r.error))[:200]
        res["editor_duration"] = round(r.duration, 4)
        measured = r.to_json()
        measured.pop("image", None)
        res["measured"] = measured
    except BaseException as e:  # noqa: BLE001
        res["editor_error"] = f"{type(e).__name__}: {str(e)[:160]}"

    # code: the same Python?
    try:
        _, c2 = construct_of(regenerated, scene)
        res["code_diff"] = code_difference(construct.body, c2.body)
    except Exception:  # noqa: BLE001
        res["code_diff"] = "unreadable"
    res["same_ast"] = res["code_diff"] == "same"
    res["doc"] = doc
    return res


def scenes_of(path: Path) -> list[str]:
    from mathengine.importer import CodeError, import_code

    try:
        return import_code(path.read_text()).scenes
    except CodeError:
        try:
            tree = ast.parse(path.read_text())
        except SyntaxError:
            return []
        return [n.name for n in tree.body if isinstance(n, ast.ClassDef)][:1]


def run_one(args: tuple[str, str, str]) -> dict:
    path, scene, out = args
    try:
        subprocess.run([sys.executable, __file__, "--one", path, scene, out], cwd=ROOT, timeout=180,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        return json.loads(Path(out).read_text())
    except subprocess.TimeoutExpired:
        return {"scene": scene, "skip": "took over 3 minutes"}
    except (OSError, ValueError) as e:
        return {"scene": scene, "skip": f"crashed ({e.__class__.__name__})"}


# ---------------------------------------------------------------------------------------------------- report


def keyframe_stats(results: list[dict]) -> None:
    """Add each scene's keyframes (as Effect Controls show them), listed by frontend/scripts/keyframe_list.mjs."""
    todo = [r for r in results if "doc" in r]
    payload = json.dumps([{"doc": r["doc"], "measured": r.get("measured")} for r in todo])
    p = subprocess.run(["node", "scripts/keyframe_list.mjs"], cwd=ROOT / "frontend", input=payload, capture_output=True,
                       text=True, timeout=600, check=True)
    for r, keys in zip(todo, json.loads(p.stdout), strict=True):
        r["keys"] = keys


def pct(a: int, b: int) -> str:
    return f"{100 * a / b:.0f}%" if b else "–"


def report(results: list[dict], sources: dict) -> str:
    ran = [r for r in results if "skip" not in r]
    imported = [r for r in ran if "import_error" not in r]
    lines = ["# Import fidelity", "",
             "How much of real manim code becomes an editable scene, measured by `scripts/import_fidelity.py` "
             f"(manim {__import__('manim').__version__}, {FPS} fps, {SIZE[0]}×{SIZE[1]}). "
             "Scenes manim itself can't render here (no LaTeX on this machine, OpenGL only, missing asset files) are "
             "skipped and left out of the numbers.", ""]

    def section(title, rs):
        rs_ran = [r for r in rs if "skip" not in r]
        rs_imp = [r for r in rs_ran if "import_error" not in r]
        st = sum(r["statements"] for r in rs_imp)
        code = sum(min(r["code_statements"], r["statements"]) for r in rs_imp)
        anims = sum(r["anims"] for r in rs_imp)
        on_obj = sum(r["anims_on_objects"] for r in rs_imp)
        regen_ok = [r for r in rs_imp if "regen_error" not in r]
        same_len = sum(1 for r in regen_ok if r["regen_duration"][0] == r["regen_duration"][1] and r["regen_plays"][0] == r["regen_plays"][1])
        same_frame = sum(1 for r in regen_ok if r["regen_frame_diff"] == 0)
        nonblank = sum(1 for r in regen_ok if not r["blank"])
        ed = [r for r in rs_imp if "editor_error" not in r and "editor_duration" in r]
        ed_same = sum(1 for r in ed if abs(r["editor_duration"] - r["native_duration"]) < 1e-3)
        all_struct = sum(1 for r in rs_imp if r["code_statements"] == 0)
        same_ast = sum(1 for r in rs_imp if r["same_ast"])
        kinds = collections.Counter(r["code_diff"] for r in rs_imp if not r["same_ast"])
        rewrites = ", ".join(f"{n} {k}" for k, n in kinds.most_common()) or "none"
        return [f"## {title}", "",
                "| | |", "|---|---|",
                f"| Scenes | {len(rs)} ({len(rs) - len(rs_ran)} skipped: manim can't render them here) |",
                f"| Imported | {len(rs_imp)} of {len(rs_ran)} |",
                f"| construct() statements on the timeline (not code steps) | **{pct(st - code, st)}** ({st - code} of {st}) |",
                f"| Scenes with no code steps at all | {pct(all_struct, len(rs_imp))} ({all_struct} of {len(rs_imp)}) |",
                f"| Animations whose target is one of the scene's objects (keyframe rows) | {pct(on_obj, anims)} ({on_obj} of {anims}) |",
                f"| Regenerated code: same length and plays as the original under manim | {pct(same_len, len(regen_ok))} ({same_len} of {len(regen_ok)}; {len(rs_imp) - len(regen_ok)} failed to run) |",
                f"| Regenerated code: same frame at the end of every play and wait, pixel for pixel | {pct(same_frame, len(regen_ok))} ({same_frame} of {len(regen_ok)}; {nonblank} of these scenes show something) |",
                f"| Editor preview: same length as manim | {pct(ed_same, len(rs_imp))} ({ed_same} of {len(rs_imp)}) |",
                f"| Regenerated construct() is the same Python (AST) | {pct(same_ast, len(rs_imp))} ({same_ast} of {len(rs_imp)}; the others: {rewrites}) |", ""]

    groups = collections.defaultdict(list)
    for r in results:
        groups[r["source"]].append(r)
    for g in ["project-shaped", "examples/", "manim docs"]:
        if groups[g]:
            lines += section({"project-shaped": "Project-shaped files (scripts/fidelity_corpus)", "examples/": "This repository's examples/",
                              "manim docs": "manim's documentation examples"}[g], groups[g])

    # keyframes
    per = collections.Counter()
    editable = collections.Counter()
    why = collections.Counter()
    for r in imported:
        for name, ks in (r.get("keys") or {}).items():
            if name == "error":
                continue
            for k in ks:
                per[k["channel"]] += 1
                editable[k["channel"]] += bool(k["editable"])
                if not k["editable"]:
                    why[re.sub(r"\(.*\)", "(…)", k.get("why") or "?")] += 1
    lines += ["## Keyframes (all imported scenes)", "", "| Channel | Keyframes | Editable in Effect Controls |", "|---|---|---|"]
    for ch in ["position", "scale", "rotation", "opacity", "color", "value"]:
        lines.append(f"| {ch} | {per[ch]} | {pct(editable[ch], per[ch])} ({editable[ch]}) |")
    lines += ["", "Why a keyframe is read-only:", ""] + [f"- {n}× {w}" for w, n in why.most_common(8)] + [""]

    # what stays code
    notes = collections.Counter()
    for r in imported:
        for n in r.get("notes", []):
            notes[re.sub(r"`[^`]*`|\b\d+\b", "…", n)[:140]] += 1
    kinds = collections.Counter()
    for r in imported:
        kinds.update(r.get("code_kinds", {}))
    lines += ["## What the importer keeps as code", "", "Statements of construct() kept as code steps, by kind:", ""]
    lines += [f"- {n}× {w}" for w, n in kinds.most_common(15)]
    lines += ["", "The importer's own notes:", ""] + [f"- {n}× {w}" for w, n in notes.most_common(15)] + [""]

    cls = collections.Counter()
    for r in imported:
        cls.update(r.get("anim_classes", {}))
    lines += ["## Animation classes on the timeline", "", ", ".join(f"{c} {n}" for c, n in cls.most_common(30)), ""]

    skipped = collections.Counter(re.sub(r"'[^']*'|\"[^\"]*\"", "…", r["skip"])[:100] for r in results if "skip" in r)
    lines += ["## Skipped (manim can't render them here)", ""] + [f"- {n}× {w}" for w, n in skipped.most_common(10)] + [""]
    failed = [r for r in ran if "import_error" in r or "regen_error" in r or "editor_error" in r]
    lines += ["## Failures", ""]
    for r in failed:
        what = r.get("import_error") and f"import: {r['import_error']}" or r.get("regen_error") and f"regenerated: {r['regen_error']}" or f"preview: {r['editor_error']}"
        lines.append(f"- `{r['file']}` {r['scene']}: {what[:200]}")
    if not failed:
        lines.append("None.")
    lines += ["", "## Per scene", "", "| File | Scene | Statements on timeline | Anims on objects | Regenerated = original | Same AST |", "|---|---|---|---|---|---|"]
    for r in results:
        if "skip" in r:
            continue
        if "import_error" in r:
            lines.append(f"| {r['file']} | {r['scene']} | import failed | | | |")
            continue
        regen = "error" if "regen_error" in r else ("yes" if r["regen_frame_diff"] == 0 and r["regen_duration"][0] == r["regen_duration"][1] else f"no ({r['regen_duration']}, {r['regen_frame_diff']:.1%} px)")
        lines.append(f"| {r['file']} | {r['scene']} | {r['statements'] - min(r['code_statements'], r['statements'])}/{r['statements']} | {r['anims_on_objects']}/{r['anims']} | {regen} | {'yes' if r['same_ast'] else r['code_diff']} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    if len(sys.argv) == 5 and sys.argv[1] == "--one":
        sys.path.insert(0, str(ROOT))
        r = one(sys.argv[2], sys.argv[3])
        Path(sys.argv[4]).write_text(json.dumps(r))
        return 0
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "docs" / "research" / "import-fidelity.md"))
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--json", help="also write every result here")
    a = ap.parse_args()
    sys.path.insert(0, str(ROOT))
    tmp = Path(tempfile.mkdtemp(prefix="import-fidelity-"))
    jobs, meta = [], []
    for source, path in corpus(tmp):
        for scene in scenes_of(path):
            out = tmp / f"r{len(jobs)}.json"
            jobs.append((str(path), scene, str(out)))
            meta.append((source, path.name))
    print(f"{len(jobs)} scenes", file=sys.stderr)
    with concurrent.futures.ThreadPoolExecutor(a.jobs) as ex:
        results = list(ex.map(run_one, jobs))
    for r, (source, name) in zip(results, meta, strict=True):
        r["source"], r["file"] = source, name
    keyframe_stats(results)
    if a.json:
        Path(a.json).write_text(json.dumps([{k: v for k, v in r.items() if k not in ("doc", "measured")} for r in results], indent=1))
    Path(a.out).write_text(report(results, {}))
    print(a.out, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
