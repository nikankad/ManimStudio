"""Definitions: the scene's named values, lists and functions, written in math (mathexpr.py) and made in the
editor (Scene › Definitions), not in Python.

A document's ``defs`` is a list of::

    {"id", "name", "kind": "value", "expr": "2 pi"}
    {"id", "name", "kind": "list", "items": ["14.134725", "21.02204", …]}
    {"id", "name", "kind": "function", "params": ["t"], "where": [{"name": "n", "expr": "floor(sqrt(t/(2pi)))"}],
     "expr": "2 sum(k, 1, n, cos(theta(t) - t ln(k))/sqrt(k))"}

They become module-level Python above the scene class (codegen.top_lines): ``ZEROS = [...]``, ``def hardy_z(t): …``.
Graphs, constructions and every math field of the editor can use them by name. Reading the code back (importer.py)
turns that Python into these definitions again while it is what they generate.
"""

from __future__ import annotations

import keyword
import re
from dataclasses import dataclass, field

from . import mathexpr

KINDS = ("value", "list", "function")
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def scope(defs: list[dict]) -> dict[str, tuple]:
    """What expressions can use: name -> ("value",) | ("list",) | ("func", number of inputs)."""
    out: dict[str, tuple] = {}
    for d in defs or []:
        name = (d.get("name") or "").strip()
        if not _IDENT.match(name):
            continue
        kind = d.get("kind")
        out[name] = ("func", len(d.get("params") or [])) if kind == "function" else ("list",) if kind == "list" else ("value",)
    return out


@dataclass
class Compiled:
    blocks: list[tuple[str, str]] = field(default_factory=list)  # (definition id, its Python), in the order written
    errors: dict[str, tuple[str, str]] = field(default_factory=dict)  # definition id -> (message, hint)
    helpers: set[str] = field(default_factory=set)

    @property
    def source(self) -> str:
        """The Python of the definitions (and the helpers they need), as written above the scene."""
        parts = [mathexpr.HELPERS[h].rstrip("\n") for h in sorted(self.helpers)] + [py for _, py in self.blocks]
        out = ""
        for k, part in enumerate(parts):
            if k:  # values one under the other; two blank lines around a function, as Python is written
                out += "\n" if not part.startswith("def ") and not parts[k - 1].startswith("def ") else "\n\n\n"
            out += part
        return out + "\n" if parts else ""


def _check_name(d: dict, taken: set[str], manim_names: set[str]) -> None:
    name = (d.get("name") or "").strip()
    if not _IDENT.match(name) or keyword.iskeyword(name):
        raise mathexpr.ExprError(f"{name or 'The name'!r} can't be a name.", "Use letters, digits and _, starting with a letter.")
    if name in mathexpr.RESERVED:
        raise mathexpr.ExprError(f"{name} is a name math expressions use already.", "Choose another name.")
    if name in taken:
        raise mathexpr.ExprError(f"There are two definitions named {name}.", "Rename one of them.")
    if name in manim_names:
        raise mathexpr.ExprError(f"{name} is a name manim uses ({name} in manim).", "Choose another name, so manim's stays usable.")


def _value(text: str, sc: dict, local: set[str], out: Compiled) -> str:
    e = mathexpr.parse(str(text), set(), allow_x=False, scope=sc, local=local)
    if e.params:
        raise mathexpr.ExprError(f"{e.params[0]!r} isn't defined.",
                                 "Definitions use numbers, other definitions and a function's own inputs. (Parameters "
                                 "belong to the scene: a function can take one as an input instead.)")
    out.helpers |= e.helpers
    return mathexpr.to_python(e.ast)


def compile_defs(defs: list[dict], manim_names: set[str] | None = None) -> Compiled:
    """The definitions' Python. One that has an error is left out (its error says why)."""
    out = Compiled()
    sc = scope(defs)
    taken: set[str] = set()
    for d in defs or []:
        try:
            _check_name(d, taken, manim_names or set())
            name = d["name"].strip()
            taken.add(name)
            kind = d.get("kind")
            if kind == "value":
                py = f"{name} = {_value(d.get('expr', ''), sc, set(), out)}"
            elif kind == "list":
                items = [i for i in (d.get("items") or []) if str(i).strip()]
                py = f"{name} = [{', '.join(_value(i, sc, set(), out) for i in items)}]"
            elif kind == "function":
                params = [p.strip() for p in d.get("params") or []]
                for p in params:
                    if not _IDENT.match(p) or keyword.iskeyword(p) or p in mathexpr.RESERVED - {mathexpr.VARIABLE}:
                        raise mathexpr.ExprError(f"{p!r} can't be the name of an input.", "Use a short name such as t or n.")
                if len(set(params)) != len(params):
                    raise mathexpr.ExprError("Two inputs have the same name.")
                local = set(params)
                lines = [f"def {name}({', '.join(params)}):"]
                for w in d.get("where") or []:
                    wn = (w.get("name") or "").strip()
                    if not _IDENT.match(wn) or keyword.iskeyword(wn) or wn in mathexpr.RESERVED - {mathexpr.VARIABLE}:
                        raise mathexpr.ExprError(f"{wn or 'A where name'!r} can't be a name.")
                    lines.append(f"    {wn} = {_value(w.get('expr', ''), sc, local, out)}")
                    local.add(wn)
                lines.append(f"    return {_value(d.get('expr', ''), sc, local, out)}")
                py = "\n".join(lines)
            else:
                raise mathexpr.ExprError(f"Unknown kind of definition {kind!r}.")
            out.blocks.append((d["id"], py))
        except mathexpr.ExprError as exc:
            out.errors[d.get("id", "")] = (exc.message, exc.hint)
    return out


def manim_names() -> set[str]:
    """The names ``from manim import *`` brings in (a definition must not hide one)."""
    global _MANIM
    if _MANIM is None:
        try:
            import manim
            _MANIM = {n for n in dir(manim) if not n.startswith("_")}
        except Exception:
            _MANIM = set()
    return _MANIM


_MANIM: set[str] | None = None


def namespace(defs: list[dict]) -> dict:
    """The definitions as Python objects (to evaluate graphs and values in the editor)."""
    import numpy as np

    ns: dict = {"np": np}
    comp = compile_defs(defs)
    try:
        exec(comp.source, ns)  # our own Python, generated from parsed math (nothing here runs typed Python)
    except Exception:  # a value that can't be worked out (1/0): graphs using it show gaps
        pass
    return ns


def evaluate(defs: list[dict]) -> dict[str, dict]:
    """For the editor: each definition's error, or what it is (a value's number, a list's length, a function's
    value at 1)."""
    import numpy as np

    comp = compile_defs(defs)
    ns: dict = {"np": np}
    out: dict[str, dict] = {d["id"]: {"error": comp.errors[d["id"]][0], "hint": comp.errors[d["id"]][1]}
                            for d in defs or [] if d.get("id") in comp.errors}
    helpers = "\n\n".join(mathexpr.HELPERS[h] for h in sorted(comp.helpers))
    try:
        exec(helpers, ns)
    except Exception:
        pass
    by_id = {d["id"]: d for d in defs or []}
    for did, py in comp.blocks:
        d = by_id[did]
        try:
            exec(py, ns)
            v = ns[d["name"].strip()]
            if d.get("kind") == "value":
                out[did] = {"value": float(v)}
            elif d.get("kind") == "list":
                out[did] = {"length": len(v), "items": [float(i) for i in v][:50]}
            else:
                n = len(d.get("params") or [])
                try:
                    out[did] = {"sample": float(v(*([1.0] * n))), "at": 1.0}
                except Exception:
                    out[did] = {}
        except Exception as exc:  # 1/0, an index past the end…
            out[did] = {"error": f"{type(exc).__name__}: {exc}", "hint": ""}
    return out


def python_of(d: dict, defs: list[dict]) -> str | None:
    """The Python one definition generates (None: it has an error)."""
    comp = compile_defs(defs)
    return dict(comp.blocks).get(d.get("id"))
