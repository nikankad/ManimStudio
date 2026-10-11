# Creating mathematical objects visually

> This document did not exist when the visual authoring work started; it was written alongside that work.
> It records the problem, the options considered, what was built, and what is deliberately left out.

Manim Studio (then MathEngine) already exposed every manim class with a control per constructor argument, factory methods
(`axes.plot`), ValueTrackers, a non-linear timeline and whole-object canvas transforms. What it lacked was the
way people actually build math diagrams: draw a few points, connect them, label them, put a point on a curve,
and then animate a parameter and watch everything follow. This document covers the six pieces added for that,
and the rules they share.

## Constraints that shaped the design

- **manim stays the only renderer.** Previews are manim frames and exports run the manim CLI. The editor never
  draws math itself; it only overlays handles and snapping guides on manim's frame, using geometry that the
  runtime reports (`runtime._geometry`).
- **Exported files stay standalone.** Everything a scene needs is plain manim code inside the generated `.py`.
  This includes the small helpers (`Constraints`, `Geometry`, `TransformTerms`), which are emitted only when used.
- **Python stays the escape hatch.** Every constructor argument is still Python source with its `{}` raw
  toggle, and code clips still run arbitrary code. Structured features add fields next to that source; they
  never replace it, and old projects open unchanged (format 2 → 3 is an explicit, lossless upgrade).
- **No inferred Python dependencies.** A construction's dependencies are declared, never guessed from code:
  - object ids in its `link`;
  - parameter names in its math expressions, each of which must be a ValueTracker object;
  - the owner of a factory constructor (`axes` in `axes.plot`).
- **APIs were checked against the installed manim (0.22.0):**
  - `Scene.update_to_time` runs scene updaters last.
  - `Mobject.updating_suspended` is set while an animation plays on a mobject.
  - `Line(mob, mob)` connects boundary points via `Line._pointify`.
  - `Axes.input_to_graph_point` and `ParametricFunction.underlying_function` exist.
  - `Circle.point_at_angle` exists.
  - `ValueTracker.get_value` reads `points[0, 0]`.
  - `TransformMatchingAbstractBase.get_mobject_parts` and `get_mobject_key` exist.
  - `MathTex` delimits each string argument with `\special{dvisvgm:raw <g id=…>}`.

## 1. Direct drawing and geometry editing

**Built.** Canvas tools for points, segments, arrows, circles, rectangles and polygons (keys `1`–`7`).

**What drawing produces.** Every tool produces an ordinary manim object whose *defining parameters* are plain
numbers:

| Tool      | Python                                              |
|-----------|-----------------------------------------------------|
| point     | `Dot()` + position                                  |
| segment   | `Line(start=np.array(…), end=np.array(…))`          |
| arrow     | `Arrow(start, end, buff=0)`                         |
| circle    | `Circle(radius=r)` + position                       |
| rectangle | `Rectangle(width, height)` + position (+ rotation)  |
| polygon   | `Polygon(*vertices)`                                |

`frontend/src/geometry.ts` recognises these "free shapes" (only when the arguments evaluate to numbers). It
provides handles for endpoints, vertices, radius and corners, with the opposite corner fixed. It also bakes
whole-object move, scale, stretch and rotation edits into the defining parameters instead of leaving
`.scale()` / `.rotate()` calls behind, so the shape stays editable through those parameters. Anything written
as custom Python falls back to the generic transform fields. The existing move, scale, stretch and rotate
handles are unchanged.

**Snapping.** The pointer snaps, in priority order, to:
1. point objects;
2. endpoints, vertices, centers and midpoints;
3. curves (sampled paths of graphs and circles);
4. the grid.

Snapping onto an existing point makes the new object *connect* to it: a segment between two points becomes a
`segment` link. Clicking a curve with the point tool creates a constrained point.

**Exact entry.** The entry box next to the tools takes `x, y` for the next click, a radius for a circle, or
`width, height` for a rectangle. Afterwards, the inspector's *Geometry* section edits the same values.

## 2. Connected objects

**Data model.** An object may carry `link`, a structured definition referring to other objects by stable `id`:

```json
{"id": "oS", "name": "seg", "ctor": "Line", "args": {"color": "BLUE"},
 "link": {"kind": "segment", "a": "oA", "b": "oB"}}
```

Kinds: `attach`, `midpoint`, `on_graph`, `on_circle`, `coords`, `intersection`, `projection`, `measure`
(these own **position**), and `segment`, `circle2`, `perpendicular`, `parallel`, `polygon`, `angle`, `graph`,
`tangent`, `secant`, `area`, `riemann`, `brace`, `highlight` (these own **shape**). The object keeps its constructor and arguments; the link supplies the
arguments it controls, which the inspector then hides.

**Keeping them correct.** Considered options:

| Option | Problem |
|---|---|
| `always_redraw(lambda: …)` per object | Replaces the mobject each frame, which fights `Create`/`.animate`. Update order follows `scene.mobjects`, so chains lag by a frame. |
| per-object `add_updater` | Same ordering lag. Updaters don't run after an animation finishes, only between frames. |
| solve in the editor and bake positions into keyframes | A second geometry engine. Wrong under arbitrary animations and code clips. |
| **scene-level solver in document order** (chosen) | Needs a small helper class in the exported file. |

The generated code creates `constraints = Constraints(self)`. Each construction is registered in document
order:

```python
seg = constraints.redraw(lambda: Line(A.get_center(), B.get_center(), color=BLUE), A, B)
constraints.follow(label, lambda m: m.move_to(A.get_center() + np.array([0.35, 0.35, 0])), A)
```

`Constraints.update()` runs as a scene updater, which runs last in `update_to_time`, after animations and
mobject updaters. It also runs from an invisible carrier mobject's updater, because after `self.play()`
finishes manim calls `update_mobjects(0)` but not scene updaters; without the carrier, constructions would
show their last-frame state instead of the final one. A test caught exactly this.

Each entry:
- is skipped while `mobject.updating_suspended` is set, so `Create`, `FadeIn` and `.animate` animate it normally;
- is only rebuilt when the raw points of its declared sources change (ValueTrackers keep their value in
  their points);
- keeps its current style when rebuilt (`new.match_style(m); m.become(new)`), so color and opacity animations
  are not overwritten.

The preview runtime doesn't sub-step for the solver, because constructions depend only on the current state,
not on `dt`. Seeking stays fast.

**Property ownership.** Animations and constructions never write the same property:
- *Follow* links own position; scale, rotation, style and the object's own constructor stay free.
- *Redraw* links own shape and position; style stays free.

An `.animate` chain calling `shift`, `move_to`, `scale` and the like on a connected object, or a geometry
animation like `Rotate` on a redrawn one, is reported as a warning on the clip, because the construction
undoes it.

**Order, validation, lifecycle:**
- *Construction order is document order.* When a link is created or edited, the editor moves objects as
  little as possible so sources come first (`sortByDependencies`). The compiler never reorders, because
  objects can also refer to each other through raw Python.
- *Validation* (`construct.plan`) reports these per object, and the rest of the scene still renders:
  - missing sources;
  - incompatible objects (an angle needs two lines; a point on a graph needs an `axes.plot` graph);
  - sources defined after the dependent;
  - dependency cycles;
  - undefined parameters;
  - reserved names.

  A broken follow link is emitted without its constraint, and a broken redraw link as an empty placeholder.
- *Deletion* asks whether to delete dependents too or detach them.
- *Detach* converts follow links and segments, perpendicular and parallel lines, circles and polygons to plain objects at their current geometry
  (taken from the rendered frame). Anything else is frozen (built once) or, if its source is being deleted,
  removed.
- *Duplication* copies a set of objects. Links inside the set are remapped to the copies; links to objects
  outside it are kept.
- *Renames* are safe for sources, which are ids. Parameter names inside expressions are renamed along with
  the parameter. Renaming rewrites identifiers only, never string literals, so renaming `theta` leaves the
  label `r"\theta"` alone.

**Intersections, perpendiculars and feet.** These are what make dependency chains clickable: altitudes are
perpendiculars from the vertices to the opposite sides, and the orthocenter is the intersection of two of them.
- *Straight sources* are lines, number lines and axes. An axes source means its x-axis (or its y-axis with
  `axis: "y"`). Lines are always extended both ways, so two segments that don't reach each other still meet,
  and a foot of a perpendicular can lie beyond a segment's ends. Extension is what geometry needs; checking that
  a crossing is on the drawn part is the editor's job, when it offers crossings to snap to.
- *Intersection* (`a`, `b`, `which`) accepts lines, circles, graphs and axes. All crossings are computed in a
  stable order, so `which` keeps meaning the same point while the objects move: along a line from its start for
  a line and a circle, left of the line between the centers first for two circles, by x for anything with a
  graph. Graph crossings are roots of a signed distance (to a line, a circle, or the other graph on the same
  axes), found by sampling the domain and bisecting. A sign change whose midpoint isn't near zero is a jump at a
  discontinuity and is dropped, so `1/x` doesn't "cross" the x-axis at 0. Tangential touches without a sign
  change are missed.
- *No crossing*: the point keeps its last position (an intersection is the one follow link that also has a
  starting position, set to where it was created). Hiding it would take its opacity away from the animations
  that own it.
- The editor mirrors the ordering (`frontend/src/intersect.ts`) on the rendered geometry to offer crossings as
  snap targets for the point tool and to count crossings for *Intersection* and *Mark roots*. Graph outlines are
  sampled, so the editor's count can differ from the scene's in near-tangent cases; the inspector's *which* picker
  shows both.
- *Perpendicular* draws a line of a given length centered on the point, or (`mode: "foot"`) the segment from the
  point to its foot; *parallel* is centered on the point and as long as the source line unless a length is set.
  Both use the object's own line class, so a `DashedLine` altitude stays dashed. *Projection* is the foot itself;
  onto axes it drops along the other axis's direction (`axes.c2p(axes.p2c(p)[0], 0)`), which is also right for
  skewed axes.

**Dragging.**
- Moving an attached label or measurement edits its `offset`.
- Moving a point on a graph, circle or axes edits its `x`, angle or coordinates. When that value is a single
  parameter, the drag sets the parameter's starting value (clamped to its slider bounds); in Record mode it
  becomes a `.set_value` clip.
- Expressions that aren't a literal or a single parameter can't be dragged; the inspector edits them.

## 3. Expression-first graph builder

`mathengine/mathexpr.py` is a small math language: explicit functions of `x` with `+ − × ÷ ^`, implicit
multiplication (`2x`, `3(x+1)`, `a sin(x)`), the usual functions and `pi`/`e`. Glued letters such as `ax` read
as `a*x`, and the editor shows that reading. It is implemented once, in Python, and used two ways:
- **for codegen:** parameters become `name.get_value()`;
- **for the graph builder, through `/api/expr`:**
  - free parameters, with undefined ones offered as sliders;
  - the normalised reading;
  - numeric analysis.

The analysis samples the function, bisects every large jump that doesn't shrink as the interval does (so
asymptotes and steps qualify, steep continuous functions don't) and reports those as `discontinuities`. It
picks manim's `dt` gap so that each asymptote branch ends near the visible y-range. It also reports intervals
where the function is undefined. Unsupported input is explained rather than rejected generically:
- implicit equations;
- `x = …`;
- polar `r = …`;
- parametric pairs;
- inequalities;
- piecewise braces;
- factorials.

One step creates the parameters (ValueTrackers at the top of the scene, so everything can use them), the axes
if needed, and a `graph` link: `axes.plot(lambda x: …, x_range=…, discontinuities=…, dt=…, use_smoothing=False)`,
redrawn whenever a parameter changes. Parameters are shared by name across graphs, constrained points and
`measure` value labels, and they are animated with ordinary `.animate.set_value` clips.

## 4. Equation terms

**Splitting.** An equation can be split into *parts* with stable ids, emitted as separate `MathTex` arguments
so that `eq[i]` is the term. With manim 0.22 each string is delimited by a `\special` group in one LaTeX
compile, so parts need not be brace-balanced. A lone `}` simply renders no glyphs. The editor's *Check with
manim* (`/api/check_equation`) compiles with real LaTeX and counts glyphs per part, so such parts are flagged.

The compiler:
- never emits empty parts, which would shift indices;
- rewrites `{{` to `{ {`, which means the same in TeX but avoids manim's double-brace splitting;
- refuses `organize_left_to_right`, which reorders submobjects;
- ignores `substrings_to_isolate` and `tex_to_color_map` on split equations.

**Identity across edits.** Editing the LaTeX re-splits it, and `mergeTerms` keeps ids by longest common
subsequence. Within a changed run, edited terms keep the identity of the term at the same position, so
retyping `b` as `c` keeps its color and correspondences. Repeated symbols are distinct positional terms, shown
as `x #1` / `x #2`, so occurrences are chosen explicitly.

**Styling and transforms.** Terms are colored per part (`eq[i].set_color`), and braced, labeled or
highlighted with links whose `parts` list term ids. `TransformTerms` subclasses manim's
`TransformMatchingAbstractBase`. Parts get keys from the explicit pairs: connected pairs share a key, so
many-to-one works, and unpaired parts fade. The UI repeats on screen that this is a visual correspondence,
not a check of mathematical equivalence.

### MathLive evaluation

MathLive 0.111.1 (MIT) was evaluated as the structured input and adopted, with LaTeX always editable beside it.

- **Integration.** It's a web component (`<math-field>`), so React 19 hosts it directly. It's loaded with a
  dynamic `import()`, so its ~808 kB chunk (222 kB gzipped) loads only when an equation is edited; the main
  bundle stays ~417 kB.
- **Offline use.** By default MathLive fetches fonts relative to its script. The fonts are bundled instead
  (`import('mathlive/fonts.css')`, emitted by Vite), with `fontsDirectory = null` and
  `soundsDirectory = null`. The Chromium smoke test confirmed zero external requests.
- **LaTeX dialect.** MathLive's default output can contain MathLive-only macros (`\mleft`, `\exponentialE`,
  placeholders). The editor reads `latex-expanded` and normalises it (`normalizeLatex`) before it reaches
  MathTex, then validates it with manim's real LaTeX through *Check with manim*.
- **Compatibility.** Verified in Chromium (Playwright): no console or page errors, editing works, split terms
  render. Not verified in pywebview's other engines (WebKitGTK on Linux, WKWebView on macOS, WebView2 on
  Windows). If MathLive fails to load, the field says so and the LaTeX box remains.

## 5. Context-sensitive annotations

`frontend/src/actions.ts` derives actions from the selection's geometric types (`construct.geoType`) and
prefills compatible sources. They appear in the inspector and in the canvas right-click menu.

| Selection | Actions |
|---|---|
| segment | Show length, Midpoint, Attach label |
| two points | Segment, Arrow, Midpoint, Circle (center), Circle on diameter |
| two lines | Mark angle |
| two shapes | Arrow between boundaries |
| three or more points | Polygon |
| graph | Point on curve, Tangent, Secant, Shade interval, Riemann rectangles |
| two graphs | Shade between |
| area / Riemann | Show integral (numerical) |
| tangent / secant | Show slope |
| angle | Show angle value |
| axes / number line | Point at coordinates, Graph a function… |
| equation (or selected terms) | Brace, Label, Highlight, Color |
| text + object | Attach (keeps the current offset) |

Interval bounds and a tangent's `x` get handles on the axis. Default positions are chosen where the curve is
inside the visible y-range.

Shaded regions (`get_area`, Riemann rectangles) are labelled in the UI as visual only. Numbers come from
`measure` links, and each says how it is computed:
- by manim: length, angle, slope of a plain line;
- from parameters: value;
- numerically: slopes by central differences, integrals by the trapezoid rule over 2000 intervals.

## 6. Reusable constructions

A template (`Template` in `types.ts`, built-ins in `mathengine/starters.py`) holds:
- self-contained objects whose links refer only to each other;
- their clips, with times relative to the insertion point and targets by name;
- the chosen inputs: `param` (a ValueTracker's starting value), `text` (a label), `color`, and `visible`
  (whether objects get an intro clip; hidden objects are still constructed, so things built from them keep
  working).

*Save as construction* adds everything the selection is built from. Templates are saved with the project
(`doc.constructions`) or in the user library (`~/.mathengine/constructions.json`, via `/api/constructions`).

**Instances.** Insertion always creates new ids and unique names.
- An **independent copy** has no further tie to the template.
- A **linked instance** records `instance = {template, instance, local, linked, inputs, offset}` on each
  object. *Update instances* regenerates it from the template, keeping its ids, names (so timeline clips stay
  attached), inputs and offset. *Push to template* replaces a project template with an instance's structure,
  then updates the other instances. Edits to a linked instance's internals are overwritten on the next
  update; *Unlink* makes it independent.

**Starters:**
- labeled triangle: free vertices, linked sides, attached labels;
- unit circle: θ parameter, point on circle, radius, angle mark, cos/sin projections and live values;
- number line: point at a parameter, live value label;
- secant to tangent: P and Q on a curve, secant through them, tangent at P, numerical slopes, with `h → 0`
  animated.

Each starter compiles without diagnostics and renders in the test suite.

## Integration

- **Undo/redo:** every edit goes through `updateDoc`, including links, terms, parameters, instances and
  templates saved to the project.
- **Save/load:** everything lives in the JSON document. The user library is a separate file.
- **Selection:** single or multi (`kind: 'objects'`), plus equation terms (`terms`).
- **Duplication:** links inside the copied set are remapped; links outside it are kept.
- **Animation:**
  - parameters animate with `set_value` clips;
  - constructions follow their sources during animations and scrubbing;
  - `TransformTerms` clips run through the normal timeline grouping, including `TimedAnimations` (tested).
- **UI smoke test:** `scripts/ui_smoke.py` drives the real editor in Chromium. It covers drawing, connecting
  two points, label-offset drags, undo, delete and detach, Record-mode parameter drags, the graph builder and
  its error messages, equation terms with MathLive, `TransformTerms` pairing, and saving and inserting
  constructions, including two instances of the same starter.
- **Tests:** `tests/` holds 56 pytest cases rendering with the real manim:
  - the expression language;
  - every link kind, followed during animation;
  - style animations surviving redraws;
  - every diagnostic;
  - equation terms and `TransformTerms` under LaTeX, including inside `TimedAnimations`;
  - v2 → v3 upgrade equivalence;
  - all starters;
  - an exported file rendered by the `manim` CLI.

## Not supported (yet)

- **Curves:** implicit curves, inequalities (as regions), parametric and polar curves, and piecewise functions
  in the graph builder. Use `ParametricFunction` / `ImplicitFunction` from the library instead.
- **Drag limits:** dragging expressions that aren't a literal or a single parameter (edit them in the
  inspector); animating attachment offsets (animate the source instead).
- **Arbitrary objects:** constructions on 3D objects; points on arbitrary curves other than graphs, circles,
  axes and number lines.
- **Equation editing:** splitting inside a term from the canvas (use *Split* / *Merge* in the inspector).
- **No algebra:** Manim Studio does no algebra; term correspondences are purely visual.
