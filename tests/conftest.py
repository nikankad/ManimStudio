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


def doc(objects, clips=()):
    d = new_project()
    d["objects"] = list(objects)
    d["clips"] = list(clips)
    return d


def add_all(d, start=0):
    return {"id": "c_add", "kind": "add", "track": "t1", "start": start, "duration": 0, "targets": [o["name"] for o in d["objects"]
                                                                                           if o["ctor"] != "ValueTracker"]}


has_latex = shutil.which("latex") is not None and shutil.which("dvisvgm") is not None
needs_latex = pytest.mark.skipif(not has_latex, reason="LaTeX not installed")
os.environ.setdefault("MPLBACKEND", "Agg")
