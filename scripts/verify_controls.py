"""Exercise every GUI control against manim.

Each parameter of every manim Mobject, Animation, chainable method and factory gets the value its
widget writes (every option of every dropdown), built one at a time. "REJECTED controls" must be 0:
those are parameters the GUI offers that manim refuses. Errors from the generic sample values
(e.g. parallel lines for TangentialArc) are reported as semantic and are expected.

Statements are exercised too: every argument of target.animate(...), self.play and self.wait, and of every other
method of each Scene class that a statement can call (self.next_section, ThreeDScene.move_camera...), run in a scene.

    .venv/bin/python scripts/verify_controls.py   # ~3 min
"""
import collections, signal, sys, traceback, warnings
warnings.filterwarnings("ignore")
import numpy as np
from mathengine import catalog as C, codegen
from mathengine.runtime import manim
m = manim()
import svgelements as se
from manim.utils import rate_functions as rf
NS = dict(vars(m)); NS.update({k: v for k, v in vars(rf).items() if not k.startswith("_")}); NS["np"] = np; NS["se"] = se

def ref(p):
    """The picker only offers objects of p["accepts"]; stand in with one of those."""
    acc = p.get("accepts") or []
    if not acc: return "Square()"
    if "FunctionGraph" in acc: return "FunctionGraph(lambda x: x)"
    for a in acc:
        if C._builds_bare(a): return f"{a}()"
    return f"{acc[0]}()"

def sample(p, star=False):
    k = p["kind"]; n = p["name"]
    if k == "mobject": return ref(p)
    if k == "mobjects": return f"{ref(p)}, {ref(p)}" if star else f"[{ref(p)}, {ref(p)}]"
    if k == "number": return "2" if p.get("int") else ("0.5" if "opacity" in n else "1.5")
    return {
        "bool": "True", "color": "RED", "string": '"abc"', "vector": "UP", "rate_func": "linear",
        "mobject": "Square()", "mobjects": "Square(), Circle()" if star else "[Square(), Circle()]",
        "range": "[0, 4, 1]", "numbers": "[1, 2, 3]", "strings": '["a", "b"]', "colors": "[RED, BLUE]",
        "colormap": '{"a": RED}', "dict": "{}", "points": "UP, LEFT, RIGHT" if star else "[UP, LEFT, RIGHT]",
        "function": p.get("template") or "lambda x: x", "matrix": "[[1, 2], [3, 4]]", "values": "1, 2, 3" if star else "[1, 2, 3]",
        "pairs": "(1, 2)" if star else "[(1, 2), (2, 3)]", "vertex": "1", "key": '"a"', "animation": "FadeIn(Square())",
        "dicts": "[{}, {}, {}]", "svgpath": 'se.Path("M 0 0 L 1 1 L 2 0")', "path": repr(IMG) if n == "filename_or_array" else None, "expr": None, "choice": None,
    }[k]

from PIL import Image
import tempfile, os
_tmp = tempfile.mkdtemp(); os.chdir(_tmp)  # manim caches text renders under ./media
IMG = os.path.join(_tmp, "sample.png"); Image.fromarray((np.random.rand(16, 16, 3) * 255).astype("uint8")).save(IMG)
class Timeout(Exception): pass
def _alarm(*_): raise Timeout()
signal.signal(signal.SIGALRM, _alarm)

timeouts = []; skipped = []; sem_msgs = collections.defaultdict(list)
BAD = ("unexpected keyword", "multiple values", "is not defined", "positional arguments but")
results = collections.Counter(); bad = []; semantic = collections.Counter(); expr_left = []
def attempt(label, code):
    signal.alarm(4)
    try:
        eval(code, NS); results["ok"] += 1
    except Timeout:
        results["timeout"] += 1; timeouts.append(label)
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        if "latex" in msg.lower() or "typst" in msg.lower() or "dvisvgm" in msg.lower():
            results["needs-latex"] += 1
        elif "_layout() got an unexpected keyword" in str(e):
            semantic["layout-specific option (partite/tree only)"] += 1
        elif isinstance(e, (TypeError, NameError)) and any(b in str(e) for b in BAD):
            bad.append((label, code[:160], msg[:200]))
        else:
            semantic[type(e).__name__] += 1
            if isinstance(e, (TypeError, ValueError, AttributeError, IndexError, AssertionError, NotImplementedError)): sem_msgs[(type(e).__name__, str(e)[:90])].append(label)
    finally:
        signal.alarm(0)

def base_args(cls_name, params, anim):
    starter = dict(C.FEATURED_MOBJECTS.get(cls_name, {}))
    args = {k: v.replace("@target", "Square()") for k, v in starter.items()}
    for p in params:
        if p["required"] and p["name"] not in args and not ("*" in args and p.get("pos") == 0):
            s = sample(p, p["name"] == "*") or (p["options"][0] if p.get("options") else None)
            if s is None: return None
            args[p["name"]] = s
    return args

cat = C.build()
# 1+2: kinds and options
option_errors = []
for group, anim in (("mobjects", False), ("animations", True)):
    for e in cat[group]:
        sig = C.signature(e["name"])
        for p in sig["params"]:
            if p["kind"] == "expr": expr_left.append(f'{e["name"]}.{p["name"]}')
            for o in p.get("options", []):
                try: eval(o, NS)
                except Exception as ex: option_errors.append((e["name"], p["name"], o, str(ex)[:80]))
            if p.get("hint"):
                h = C.signature(p["hint"])
                if not h["params"]: option_errors.append((e["name"], p["name"], "hint " + p["hint"], "no params"))

# 3: construct with each control's value
for group, anim in (("mobjects", False), ("animations", True)):
    for e in cat[group]:
        name = e["name"]
        params = [p for p in C.signature(name)["params"] if p["name"] != "run_time"]
        args = base_args(name, params, anim)
        if args is None: results["skipped-class"] += 1; skipped.append(name); continue
        def expr(a):
            if anim:
                return codegen.anim_expr({"cls": name, "target": "Square()" if name not in ("TransformAnimations", "ChangeSpeed") else "FadeIn(Square())", "args": a}, 1.0)
            return f"{name}({codegen._call_args(a, before_star=codegen._leading(name))})"
        attempt(f"{name}()", expr(args))
        for p in params:
            if p["name"] in args and not p.get("options"): continue
            values = (p.get("options") or [sample(p, p["name"] == "*")])[: 6 if p["name"] == "font" else None]
            for v in values:
                if v is None: continue
                a = {**args}
                key = "*" if ("*" in a and p.get("pos") == 0 and not any(q["name"] == "*" for q in params)) else p["name"]
                a[key] = v
                attempt(f"{name}.{p['name']}={v}", expr(a))

# methods: every chainable method / factory on an instance of its class
inst_cache = {}
for e in cat["mobjects"]:
    name = e["name"]; cls = getattr(m, name)
    params = C.signature(name)["params"]
    args = base_args(name, params, False)
    if args is None: continue
    ctor = f"{name}({codegen._call_args(args, before_star=codegen._leading(name))})"
    for meth in C.methods_of(cls) + C.factories_of(cls):
        owner = next((k for k in cls.__mro__ if meth in k.__dict__), cls)
        if (owner, meth) in inst_cache: continue
        inst_cache[(owner, meth)] = 1
        msig = C.signature(f"{name}.{meth}")
        for p in msig["params"]:
            if p["kind"] == "expr": expr_left.append(f"{name}.{meth}.{p['name']}")
            for o in p.get("options", []):
                try: eval(o, NS)
                except Exception as ex: option_errors.append((f"{name}.{meth}", p["name"], o, str(ex)[:80]))
        req = {}
        for p in msig["params"]:
            if p["required"]:
                s = sample(p, p["name"] == "*") or (p["options"][0] if p.get("options") else None)
                if s is None: break
                req[p["name"]] = s
        else:
            def call(a):
                star = a.get("*"); kw = ", ".join(f"{k}={v}" for k, v in a.items() if k != "*")
                return f"({ctor}).{meth}({', '.join(x for x in (star, kw) if x)})"
            attempt(f"{name}.{meth}()", call(req))
            for p in msig["params"]:
                if p["name"] in req: continue
                for v in (p.get("options") or [sample(p, p["name"] == "*")]):
                    if v is not None: attempt(f"{name}.{meth}.{p['name']}", call({**req, p["name"]: v}))

# statements: .animate(**kwargs), self.play / self.wait options, and every other scene method a statement can call
def run_scene(base, body):
    """Run ``body`` (code using ``self``) in a scene of class ``base``, without rendering."""
    with m.tempconfig({"dry_run": True, "write_to_movie": False, "disable_caching": True, "verbosity": "ERROR", "progress_bar": "none"}):
        scene = NS[base]()
        scene.setup()
        exec(body, {**NS, "self": scene})
    return True

def attempt_scene(label, base, body):
    signal.alarm(8)
    try:
        run_scene(base, body); results["ok"] += 1
    except Timeout:
        results["timeout"] += 1; timeouts.append(label)
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        if isinstance(e, (TypeError, NameError, AttributeError)) and (any(b in str(e) for b in BAD) or "has no attribute" in str(e)):
            bad.append((label, body[:160], msg[:200]))
        else:
            semantic[type(e).__name__] += 1
            sem_msgs[(type(e).__name__, str(e)[:90])].append(label)
    finally:
        signal.alarm(0)

for p in C.signature("animate")["params"]:
    for v in (p.get("options") or [sample(p)]):
        if v is not None:
            attempt_scene(f".animate.{p['name']}={v}", "Scene", f"self.play(Square().animate({p['name']}={v}).shift(UP))")
for p in C.signature("Animation")["params"] + [q for q in C.signature("Scene.play")["params"] if q["name"] != "*"]:
    for v in (p.get("options") or [sample(p)]):
        if v is not None:
            attempt_scene(f"self.play.{p['name']}={v}", "Scene", f"self.play(FadeIn(Square()), {p['name']}={v})")
for base, methods in cat["scene_methods"].items():
    if base == "SpecialThreeDScene":  # can't be built in manim itself (it never sets up a renderer)
        continue
    for meth in methods:
        if meth in ("play",):
            continue
        msig = C.signature(f"{base}.{meth}")
        req = {}
        for p in msig["params"]:
            if p["required"]:
                v = sample(p, p["name"] == "*") or (p["options"][0] if p.get("options") else None)
                if p["name"] == "sound_file": v = None
                if v is None: break
                req[p["name"]] = v
        else:
            def call(a, meth=meth, base=base):
                return f"self.{meth}({codegen._call_args(a, before_star=codegen._method_leading({'scene': {'base': base}}, meth))})"
            attempt_scene(f"{base}.{meth}()", base, call(req))
            for p in msig["params"]:
                if p["name"] in req: continue
                for v in (p.get("options") or [sample(p, p["name"] == "*")]):
                    if v is not None: attempt_scene(f"{base}.{meth}.{p['name']}={v}", base, call({**req, p["name"]: v}))

print("calls:", dict(results))
print("semantic errors from sample values (value fine for the type but not this object):", dict(semantic))
print("params still raw Python:", len(expr_left), expr_left[:10])
print("timeouts (>4s, slow to build, not rejected):", timeouts, "skipped classes:", skipped)
print("bad options/hints:", len(option_errors)); [print("  ", x) for x in option_errors[:20]]
print("REJECTED controls:", len(bad))
groups = collections.defaultdict(list)
for lab, code, msg in bad: groups[(lab.split(".")[0].split("(")[0], msg[:110])].append(lab)
for (c, msg), labs in sorted(groups.items()): print(f"  {c}: {msg}  x{len(labs)}  e.g. {labs[0]}")

print("--- TypeError/ValueError groups (most common) ---")
for (t, msg), labs in sorted(sem_msgs.items(), key=lambda kv: -len(kv[1]))[:45]:
    print(f"{len(labs):4d} {t}: {msg} | e.g. {labs[:3]}")
