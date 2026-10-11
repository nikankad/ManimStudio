"""LaTeX on this computer: finding it, and working without it.

manim draws MathTex/Tex, and the digits of DecimalNumber and Integer (measurements, value labels,
numbers on axes), with LaTeX. Without it:

* numbers are drawn with Text instead (``NUMBERS_SOURCE``, emitted into the generated scene);
* simple labels such as ``A``, ``\\theta`` or ``x^2`` become Text (``text_fallback``);
* anything else that needs LaTeX (real equations) fails with a message saying so and how to install it
  (``missing_message``), instead of manim's ``FileNotFoundError: 'latex'``.

LaTeX installed in a standard place is found even when it isn't on PATH: an app opened from the macOS
Finder doesn't see /Library/TeX/texbin or Homebrew, for example (``find_tex``).
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import sys
from pathlib import Path

TEX_CTORS = {"MathTex", "Tex", "SingleStringMathTex"}

_state: dict[str, object] = {}


def _candidates() -> list[str]:
    home = Path.home()
    if sys.platform == "win32":
        local, appdata = os.environ.get("LOCALAPPDATA", ""), os.environ.get("APPDATA", "")
        programs = [os.environ.get(k, "") for k in ("ProgramFiles", "ProgramFiles(x86)")]
        pats = [rf"{local}\Programs\MiKTeX\miktex\bin\x64", rf"{appdata}\TinyTeX\bin\windows", rf"{appdata}\TinyTeX\bin\win32",
                r"C:\texlive\*\bin\windows", r"C:\texlive\*\bin\win64", r"C:\texlive\*\bin\win32"]
        pats += [rf"{p}\MiKTeX\miktex\bin\x64" for p in programs if p]
    elif sys.platform == "darwin":
        pats = ["/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/local/texlive/*/bin/universal-darwin",
                "/usr/local/texlive/*/bin/*darwin*", f"{home}/Library/TinyTeX/bin/universal-darwin", f"{home}/Library/TinyTeX/bin/*"]
    else:
        pats = ["/usr/local/texlive/*/bin/*-linux", "/opt/texlive/*/bin/*", f"{home}/.TinyTeX/bin/*", "/usr/local/bin", "/usr/bin"]
    out = []
    for pat in pats:
        out += sorted(glob.glob(pat), reverse=True)  # newest TeX Live year first
    return out


def find_tex(refresh: bool = False) -> str | None:
    """Directory holding ``latex`` (on PATH, or in a standard install location), or None.

    When it is found outside PATH, it is added to PATH so manim (and render subprocesses) can run it.
    """
    if not refresh and "dir" in _state:
        return _state["dir"]  # type: ignore[return-value]
    exe = "latex.exe" if sys.platform == "win32" else "latex"
    found = shutil.which("latex")
    tex_dir = str(Path(found).parent) if found else None
    if tex_dir is None:
        for d in _candidates():
            if os.path.isfile(os.path.join(d, exe)):
                tex_dir = d
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                break
    _state["dir"] = tex_dir
    return tex_dir


def latex_available(refresh: bool = False) -> bool:
    return find_tex(refresh) is not None


def install_hint() -> str:
    if sys.platform == "win32":
        return "Install MiKTeX (miktex.org/download), then click “Check again”."
    if sys.platform == "darwin":
        return "Install MacTeX (tug.org/mactex) or BasicTeX (smaller), then click “Check again”."
    return "Install TeX Live (e.g. sudo apt install texlive-latex-extra dvisvgm), then click “Check again”."


def missing_message(name: str) -> str:
    return (f"{name} needs LaTeX to draw its math, and LaTeX isn't installed on this computer. {install_hint()} "
            "Text works without it, and numbers and simple labels are drawn without LaTeX meanwhile.")


# ----------------------------------------------------------------------------- simple TeX as text

_SYMBOLS = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε", "zeta": "ζ", "eta": "η",
    "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π",
    "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ", "phi": "φ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ",
    "Omega": "Ω", "circ": "°", "degree": "°", "cdot": "·", "times": "×", "div": "÷", "pm": "±", "mp": "∓", "infty": "∞",
    "le": "≤", "leq": "≤", "ge": "≥", "geq": "≥", "ne": "≠", "neq": "≠", "approx": "≈", "equiv": "≡", "to": "→",
    "rightarrow": "→", "leftarrow": "←", "Rightarrow": "⇒", "in": "∈", "partial": "∂", "nabla": "∇", "prime": "′",
    "angle": "∠", "perp": "⊥", "parallel": "∥", "triangle": "△", "ldots": "…", "dots": "…", "cdots": "⋯", "%": "%",
    "$": "$", "&": "&", "#": "#", "_": "_", "{": "{", "}": "}",
}
_SPACES = {",": " ", ";": " ", ":": " ", "!": "", " ": " ", "quad": "  ", "qquad": "    "}
_SUP = dict(zip("0123456789+-=()ni", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ"))
_SUB = dict(zip("0123456789+-=()aeoxhklmnpst", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ"))


def plain_text(tex: str) -> str | None:
    """Simple TeX (a letter, Greek letters, symbols, small sub- and superscripts) as Unicode; None if it isn't simple."""
    s = tex.strip()
    if s.startswith("$") and s.endswith("$") and len(s) > 1:
        s = s.strip("$")
    s = re.sub(r"\\(?:text|mathrm|textrm|mathit|mathbf|textbf|operatorname)\s*\{([^{}\\]*)\}", r"\1", s)

    def command(m: re.Match) -> str:
        name = m.group(1)
        if name in _SPACES:
            return _SPACES[name]
        return _SYMBOLS.get(name, m.group(0))

    s = re.sub(r"\\([A-Za-z]+|[,;:! %$&#_{}])", command, s)

    def script(m: re.Match) -> str:
        table = _SUP if m.group(1) == "^" else _SUB
        body = m.group(2) if m.group(2) is not None else m.group(3)
        if body == "°":
            return "°" if m.group(1) == "^" else m.group(0)
        if all(c in table for c in body):
            return "".join(table[c] for c in body)
        return m.group(0)

    s = re.sub(r"([\^_])(?:\{([^{}]*)\}|(.))", script, s)
    s = s.replace("{", "").replace("}", "") if re.fullmatch(r"[^\\^_]*", s) else s
    if re.search(r"[\\^_{}&]", s):
        return None
    return s


_LITERAL = re.compile(r'\s*[rRuU]?(?P<q>"""|\'\'\'|"|\')(?P<body>.*)(?P=q)\s*', re.S)
# At the same font_size, manim's Text is about 1.45 times the size of TeX: scale it to match.
TEXT_SCALE = 0.69
TEXT_KWARGS = {"color", "fill_opacity", "stroke_width", "stroke_color", "fill_color", "opacity", "z_index",
               "should_center", "height", "width", "sheen_factor", "background_stroke_width", "background_stroke_color"}


def text_fallback(ctor: str, args: dict) -> tuple[str, dict] | None:
    """A Text replacement for a simple MathTex/Tex label: (ctor, args), or None if it needs LaTeX."""
    if ctor not in TEX_CTORS:
        return None
    m = _LITERAL.fullmatch(str(args.get("*", "")))
    if not m or "\n" in m.group("body"):
        return None
    body = m.group("body").encode().decode("unicode_escape") if not str(args.get("*", "")).lstrip().lower().startswith("r") else m.group("body")
    text = plain_text(body if ctor != "Tex" or "$" in body else body)
    if not text:
        return None
    out = {"*": repr(text)}
    out.update({k: v for k, v in args.items() if k in TEXT_KWARGS and str(v).strip()})
    size = str(args.get("font_size", "")).strip()
    try:
        out["font_size"] = repr(round(float(size or 48) * TEXT_SCALE, 2))
    except ValueError:
        out["font_size"] = f"({size}) * {TEXT_SCALE}"
    return "Text", out


NUMBERS_SOURCE = '''
# LaTeX isn't installed on this computer, so the parts of numbers (DecimalNumber, Integer, numbers on
# axes) are drawn with Text instead (Manim Studio). Install LaTeX to draw them with TeX again.
_me_number_parts = {}
_ME_NUMBER_TEXT = {"\\\\dots": "…", "\\\\cdots": "⋯", "^\\\\circ": "°", "^{\\\\circ}": "°", "\\\\circ": "°", "\\\\%": "%"}


def _me_number_part(self, string, mob_class=None, **kwargs):
    text = _ME_NUMBER_TEXT.get(string)
    if text is None:
        text = string.replace("\\\\text{", "").replace("\\\\mathrm{", "").replace("{", "").replace("}", "").replace("\\\\", "")
        text = text.lstrip("^") or string
    key = (text, repr(sorted(kwargs.items())))
    if key not in _me_number_parts:
        _me_number_parts[key] = Text(text, **kwargs)
    mob = _me_number_parts[key].copy()
    mob.font_size = self._font_size * 0.69  # Text is about 1.45 times the size of TeX at the same font_size
    return mob


if hasattr(DecimalNumber, "_string_to_mob"):
    DecimalNumber._string_to_mob = _me_number_part
'''
