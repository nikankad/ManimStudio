import os
import shutil

import pytest

from mathengine.project import new_project


@pytest.fixture(autouse=True)
def _isolated_media(tmp_path, monkeypatch):
    # manim writes caches under ./media; keep the repo clean.
    monkeypatch.chdir(tmp_path)


def obj(id, name, ctor, **kw):
    return {"id": id, "name": name, "ctor": ctor, "args": kw.pop("args", {}), "pos": kw.pop("pos", None),
            "chain": kw.pop("chain", ""), **kw}


def doc(objects, steps=()):
    d = new_project()
    d["objects"] = list(objects)
    d["timeline"] = list(steps)
    return d


def add_all(d):
    """``self.add(...)`` of every drawn object."""
    return {"id": "s_add", "kind": "add", "targets": [o["name"] for o in d["objects"] if o["ctor"] != "ValueTracker"]}


def _args(args):
    return {k: str(v) for k, v in args.items()}


def anim(id, cls, target="", **args):
    return {"id": id, "cls": cls, "target": target, "args": _args(args)}


def animate(id, target, chain, **args):
    return {**anim(id, "animate", target, **args), "chain": chain}


def group(id, cls, *anims, **args):
    return {**anim(id, cls, "", **args), "anims": list(anims)}


def play(*anims, id=None, **args):
    """``self.play(*anims, **args)``; its id defaults to "p_" + the first animation's id."""
    return {"id": id or f"p_{anims[0]['id']}", "kind": "play", "anims": list(anims), "args": _args(args)}


def wait(duration=None, id="w"):
    return {"id": id, "kind": "wait", "args": {"duration": str(duration)} if duration is not None else {}}


def switch(id, kind, targets, duration=0):
    return {"id": id, "kind": kind, "targets": list(targets), **({"duration": duration} if duration else {})}


has_latex = shutil.which("latex") is not None and shutil.which("dvisvgm") is not None
needs_latex = pytest.mark.skipif(not has_latex, reason="LaTeX not installed")
os.environ.setdefault("MPLBACKEND", "Agg")
