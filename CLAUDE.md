# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Manim Studio (package `mathengine`, formerly MathEngine): a visual timeline editor for manim Community Edition (pinned `manim>=0.22,<0.23`). Python backend (`mathengine/`) serves a React/TypeScript frontend (`frontend/`) over localhost HTTP, shown in a pywebview window or a browser. The `mathengine` CLI/command and `.mathengine` project files are legacy aliases that must keep working.

## Commands

```bash
uv venv --python 3.12 && uv pip install -e '.[dev]'   # or pip install -e '.[dev]'
cd frontend && npm install && npm run build            # builds UI into mathengine/web (tsc --noEmit && vite build)
cd frontend && npm run dev                             # rebuild UI on change
cd frontend && npm run typecheck

pytest                                  # tests render real frames with manim; LaTeX tests skip without LaTeX
pytest tests/test_importer.py::test_name   # single test
python scripts/verify_controls.py       # run every parameter widget's value through manim; rerun after upgrading manim
python scripts/ui_smoke.py              # Playwright/Chromium UI drive (use the preinstalled Chromium; don't `playwright install`)

manim-studio --serve --port 8765        # server only; --browser opens in the default browser
manim-studio render x.manimstudio -q 1080p -o x.mp4
```

The built UI in `mathengine/web` is a build artifact: Python changes alone don't need it, but the app needs it to open.

Releases: bump `version` in `pyproject.toml`, tag `vX.Y.Z` (the workflow refuses a mismatched tag). Packaging is PyInstaller via `packaging/manim-studio.spec`; every push to `main` rebuilds the Nightly pre-release.

## Architecture

The core idea: **the project document, the timeline and the generated manim Python are one thing**. A `.manimstudio` project is JSON (objects + an ordered list of `construct()` statements, format 4); every argument is stored as Python source text, so anything manim accepts is representable. Understand these pieces together:

- `catalog.py` introspects manim's `Mobject`/`Animation` classes and method signatures to produce the library and the per-parameter form controls. Nothing manim-specific is hand-reimplemented; the frontend widgets are driven by this metadata.
- `codegen.py` (document → manim Python) and `importer.py` (manim Python → document, via `ast`) are inverses. Each timeline statement compiles to exactly one manim statement, in order, with nothing added. Code → project → code must be stable, and an imported scene must run identically to the original (`tests/test_importer.py`). Anything the importer can't model is kept as a code step. Keep both directions in sync when changing either.
- `timeline.py` models statements (`self.play`, `self.wait`, `self.add`/`remove`, code, couple switches); animations of a `self.play` start together on tracks. Times come from running the scene with manim.
- `construct.py` holds the "connected objects" system (intersections, perpendiculars, labels, angle marks, tangents, areas, equation terms…). Links store math expressions plus explicit source ids and ValueTracker parameter names, never inferred from arbitrary Python. They compile to plain manim code using a small `Constraints` helper emitted into the exported file, which re-evaluates constructions each frame and after each `self.play`.
- `mathexpr.py` turns expressions like `y = a*x^2 + b` into Python and reports unsupported input in plain words.
- `runtime.py` renders a preview frame at time t in-process by re-running `construct()` with a `play()` that skips animations, stopping at t. It replaces `CairoRenderer.play` with manim's own frame loop, so it is version-sensitive; `tests/test_native_parity.py` guards it against the pinned manim. `render.py` shells out to `manim render` for video.
- `server.py` is the HTTP API (127.0.0.1 + session token) the frontend calls; `__main__.py` is the CLI; `project.py` handles load/save and explicit lossless `upgrade` of older formats; `tex.py` locates LaTeX in standard install paths and provides the non-LaTeX `Text` fallback; `starters.py` / `samples.py` hold built-in constructions and sample projects.

When adding optional project fields (`link`, `eq.parts`, `param`, `instance`, `after`, `comment`, `scene.members`, …), older projects must still load; extend `project.upgrade` rather than breaking the format. Objects are referenced by stable id, never by name.

## Environment notes

- LaTeX is optional; without it numbers/simple labels draw with `Text`, and LaTeX-dependent tests skip.
- Update checks can be disabled with `MATHENGINE_NO_UPDATE_CHECK=1`.
