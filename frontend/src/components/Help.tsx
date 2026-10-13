// In-app help: a searchable guide (Help center) and a guided tour of the interface.

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { getState, setState, useStore } from '../store';
import { Modal } from './Modal';
import { keys } from '../keys';
import { pref, setPref } from '../prefs';
import { startTryThis } from './TryThis';

// ---------------------------------------------------------------- guided tour

interface TourStep {
  target?: string; // CSS selector of the element to spotlight (none: centered card)
  title: string;
  body: React.ReactNode;
  before?: () => void; // prepare the UI (e.g. switch a library tab)
}

const libraryTab = (label: string) => () =>
  (Array.from(document.querySelectorAll('.library .tabs button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined)?.click();

export const TOUR: TourStep[] = [
  {
    title: 'Welcome to Manim Studio',
    body: <>Build math animations visually. Everything you see is rendered by <b>manim</b>, and every project exports as a plain manim Python file. This tour takes about a minute.</>,
  },
  {
    target: '[data-tour="library"]',
    title: 'Library',
    before: libraryTab('Objects'),
    body: <>Every manim class, searchable. Drag one onto the canvas or a timeline track, or double-click it. <b>Effects</b> holds animations, <b>Build</b> holds reusable constructions, and <b>Scene</b> lists your objects.</>,
  },
  {
    target: '[data-tour="tools"]',
    title: 'Drawing tools',
    body: <>Draw points, segments, arrows, circles, rectangles and polygons (keys <kbd>1</kbd>–<kbd>7</kbd>). The pointer snaps to existing geometry; a segment drawn between two points stays connected to them. Type exact values in the box that appears next to the tools.</>,
  },
  {
    target: '[data-tour="canvas"]',
    title: 'Canvas',
    body: <>The frame at the playhead. Drag objects to move them; drag their handles to edit endpoints, vertices, radius or size. <kbd>Shift</kbd>-click or drag a box to select several, and right-click for actions such as <i>Midpoint</i>, <i>Mark angle</i> or <i>Attach label</i>.</>,
  },
  {
    target: '[data-tour="inspector"]',
    title: 'Inspector',
    body: <>Everything about the selection: its construction (what it is built from), exact geometry, style and every manim argument. <b>Build from this</b> offers actions that fit what you selected. Every field also accepts raw Python with its <code>{'{}'}</code> toggle.</>,
  },
  {
    target: '[data-tour="graph"]',
    title: 'Graph a function',
    body: <>Type an expression such as <code>y = a*x^2 + b</code>, check the live preview, and get axes, the graph and a slider for each parameter in one step.</>,
  },
  {
    target: '[data-tour="build"]',
    title: 'Reusable constructions',
    before: libraryTab('Build'),
    body: <>Insert ready-made constructions (labeled triangle, unit circle, number line, secant to tangent), or save your own selection to reuse it in this project or any other.</>,
  },
  {
    target: '[data-tour="timeline"]',
    title: 'Timeline',
    before: libraryTab('Objects'),
    body: <>The scene, in order. Animations that play together share a shaded <b>Play together</b> column, stacked on animation lanes V1, V2… (lanes are not drawing layers; Scene › Drawing order shows what is on top); a hatched block is a pause; the next group starts when the one before ends. Click the shading to select a group, drag clips to move them, drag right edges to trim, and press <kbd>Space</kbd> to play.</>,
  },
  {
    target: '[data-tour="record"]',
    title: 'Record',
    body: <>With Record on, canvas edits become animation clips at the playhead instead of changing the starting picture. Dragging a point that is bound to a parameter records a <code>set_value</code> animation. With the playhead in a loop's first run the clip goes in its body (it runs every time); in a later run, drawn faintly, it goes after the loop. (In a narrow window Record is in the <b>Options</b> menu.)</>,
  },
  {
    target: '[data-tour="output"]',
    title: 'Code and export',
    body: <>See the generated manim code (and add your own imports or classes in the header), render a smooth preview, or export the final video.</>,
  },
  {
    target: '[data-tour="help"]',
    title: 'Help is always here',
    body: <>Open the guide any time with this button, <kbd>?</kbd> or <kbd>F1</kbd>. Each topic can take you straight to the right place.</>,
  },
];

export function startTour(step = 0) {
  setState({ panel: null, panelData: null, tour: step });
}

/** Spotlight + card for the current tour step. */
export function Tour() {
  const step = useStore((s) => s.tour);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const s = step === null ? null : TOUR[step];
  const go = (d: number) => {
    const n = (getState().tour ?? 0) + d;
    setState({ tour: n < 0 ? 0 : n >= TOUR.length ? null : n });
  };

  useLayoutEffect(() => {
    if (!s) return;
    s.before?.();
    const measure = () => {
      const el = s.target ? document.querySelector(s.target) : null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    const t = setTimeout(measure, 60); // after a tab switch re-renders
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', measure);
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState({ tour: null });
      else if (e.key === 'ArrowRight' || e.key === 'Enter') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  if (step === null || !s) return null;
  const pad = 6;
  const hole = rect && { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  // Card beside the spotlight: right of it, else left, else below/above; centered without a target.
  const cw = 340, ch = 210;
  let card: React.CSSProperties = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
  if (hole) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const top = Math.min(Math.max(12, hole.top), vh - ch - 12);
    if (hole.left + hole.width + 16 + cw < vw) card = { left: hole.left + hole.width + 16, top };
    else if (hole.left - 16 - cw > 0) card = { left: hole.left - 16 - cw, top };
    else if (hole.top + hole.height + 16 + ch < vh) card = { left: Math.min(Math.max(12, hole.left), vw - cw - 12), top: hole.top + hole.height + 16 };
    else card = { left: Math.min(Math.max(12, hole.left), vw - cw - 12), top: Math.max(12, hole.top - ch - 16) };
  }
  return (
    <div className="tour" role="dialog" aria-label={`Tour step ${step + 1} of ${TOUR.length}: ${s.title}`}>
      {hole ? <div className="tour-hole" style={hole} /> : <div className="tour-dim" />}
      <div className="tour-card" style={{ ...card, width: cw }}>
        <div className="tour-progress">{TOUR.map((_, i) => <span key={i} className={i === step ? 'on' : i < step ? 'done' : ''} />)}</div>
        <h3>{s.title}</h3>
        <p>{s.body}</p>
        <div className="row">
          <button className="ghost small" onClick={() => setState({ tour: null })}>Skip tour</button>
          <span className="spacer" />
          <span className="muted small">{step + 1} / {TOUR.length}</span>
          <button disabled={step === 0} onClick={() => go(-1)}>Back</button>
          <button className="primary" onClick={() => go(1)}>{step === TOUR.length - 1 ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- help center

interface Topic {
  id: string;
  title: string;
  keywords: string;
  body: React.ReactNode;
  actions?: { label: string; run: () => void }[];
}

const tourTo = (target: string) => () => startTour(Math.max(0, TOUR.findIndex((t) => t.target === `[data-tour="${target}"]`)));
const open = (panel: 'graph' | 'code' | 'export' | 'settings') => () => (panel === 'code' ? setState({ centerTab: 'code' }) : setState({ panel, panelData: null }));
const tool = (t: 'point' | 'line' | 'circle' | 'polygon') => () => setState({ panel: null, panelData: null, tool: t });

const TOPICS: Topic[] = [
  {
    id: 'start',
    title: 'Getting started',
    keywords: 'begin first new project basics overview',
    body: (
      <>
        <p>Manim Studio builds manim scenes visually. A project is a set of <b>objects</b> (shapes, text, graphs…) and the statements of the scene’s <code>construct()</code> that animate them, shown as clips on a timeline. The <b>Code</b> tab shows the same scene as manim code; edit either one and the other follows, or paste a whole manim file to start from it.</p>
        <ol>
          <li>Draw something with the tools above the canvas, or drag a class from the <b>Library</b> (or double-click it; press <kbd>/</kbd> to search, then <kbd>Enter</kbd> adds the top result).</li>
          <li>New objects get an intro animation (Create/Write) at the playhead, so the timeline fills up as you build.</li>
          <li>Select an object to edit it in the <b>Inspector</b>; select two to connect them.</li>
          <li>Press <kbd>Space</kbd> to play, <kbd>{keys('⌘S')}</kbd> to save, and <b>Export video</b> to render with manim; when it finishes, <b>Show in folder</b> and <b>Play</b> open the video.</li>
          <li>Unsaved changes are kept as you work. If the app closes or crashes, <b>Home</b> lists them under <b>Unsaved work</b> and opening that project offers to restore them.</li>
        </ol>
      </>
    ),
    actions: [{ label: 'Take the tour', run: () => startTour(0) }, { label: 'Try this: your first animation', run: startTryThis }],
  },
  {
    id: 'draw',
    title: 'Drawing shapes',
    keywords: 'tools point segment line arrow circle rectangle polygon snap exact entry handles vertex radius',
    body: (
      <>
        <p>Pick a tool above the canvas or press its key: <kbd>1</kbd> select, <kbd>2</kbd> point, <kbd>3</kbd> segment, <kbd>4</kbd> arrow, <kbd>5</kbd> circle, <kbd>6</kbd> rectangle, <kbd>7</kbd> polygon.</p>
        <ul>
          <li><b>Segment / arrow</b>: click the two endpoints. <b>Circle</b>: click the center, then a point on it. <b>Rectangle</b>: two opposite corners. <b>Polygon</b>: click the vertices, then click the first one again, double-click or press <kbd>Enter</kbd>.</li>
          <li>The pointer <b>snaps</b> to points, crossings, endpoints, vertices, centers, midpoints, curves and the grid (toggle the grid with <b>Snap</b> in the toolbar). With the point tool, clicking where two lines, circles, graphs or axes cross places their <b>intersection</b>, which stays on the crossing.</li>
          <li>For <b>exact values</b>, type into the box next to the tools (<code>x, y</code>, a radius, or <code>width, height</code>) and press <kbd>Enter</kbd>.</li>
          <li>After drawing, the round handles edit endpoints, vertices, the radius and corners, and <b>Geometry</b> in the inspector takes exact numbers. <kbd>Alt</kbd>-click a vertex to remove it.</li>
          <li>Press <kbd>Esc</kbd> to cancel a drawing or return to the select tool.</li>
        </ul>
      </>
    ),
    actions: [{ label: 'Try the segment tool', run: tool('line') }, { label: 'Show me the tools', run: tourTo('tools') }],
  },
  {
    id: 'connect',
    title: 'Connecting objects',
    keywords: 'connect couple uncouple pause forget relationship relationships link segment midpoint label attach angle constraint follow detach delete dependency intersection intersect perpendicular parallel altitude foot projection bisector root intercept drop axis',
    body: (
      <>
        <p>Connected objects are built from other objects and stay attached to them while you edit, animate and scrub.</p>
        <ul>
          <li>Select one or more objects (<kbd>Shift</kbd>-click, or drag a box on empty canvas). The inspector's <b>Build from this</b> section and the right-click menu list what fits: <i>Segment</i>, <i>Midpoint</i>, <i>Circle</i>, <i>Polygon</i>, <i>Mark angle</i>, <i>Attach label</i>, <i>Point on curve</i>…</li>
          <li>Drawing a segment from one existing point to another connects it to both; clicking a point onto a graph or circle constrains it there.</li>
          <li><b>Intersections</b>: select two lines, circles, graphs or axes and pick <i>Intersection</i> (one point per crossing), or click the crossing with the point tool. A graph offers <i>Mark roots</i> and <i>y-intercept</i>. Lines count as extended both ways; while the objects don't meet, the point stays where it was.</li>
          <li><b>Right angles and parallels</b>: select a point and a line for <i>Perpendicular</i>, <i>Parallel</i>, <i>Altitude</i> (dashed, from the point to the line) or <i>Foot of perpendicular</i>; a point and axes for <i>Drop to x-axis</i> / <i>Drop to y-axis</i>. A segment offers <i>Perpendicular bisector</i>. These chain: the altitudes of a triangle meet at an intersection that moves with the vertices.</li>
          <li>Drag an attached label to change its offset. Drag a constrained point to move it along its curve or circle.</li>
          <li><b>Couple existing objects</b>: select two or more objects that already exist; the <b>Couple</b> group offers what fits, built from where things are now: <i>Put P on circle</i>, <i>Pin P to axes</i>, <i>Attach label to A</i>, <i>Make line connect A and B</i>, <i>Make polygon go through A, B, C</i>… An object without a relationship also has <i>couple to</i> in its inspector.</li>
          <li>The inspector's <b>Relationship</b> section shows the sources and values. <b>Uncouple</b> pauses it: the object stays where it is and is edited or animated like any other, and the relationship is remembered. <b>Couple again</b> restores it; <b>Forget</b> removes it for good. Deleting a source asks whether to delete what was built from it or keep it as independent objects.</li>
          <li><b>Over time</b>: <i>+ Uncouple at playhead</i> / <i>+ Couple at playhead</i> (inspector, or the timeline's + Uncouple / + Couple) add clips that switch a relationship during the video. Between them the object can be moved by its own animations; give a Couple clip a duration and it glides back into place.</li>
          <li>The <b>Scene</b> tab's <b>Relationships</b> view lists every relationship with its state, what it's built from, what's built from it and its timeline switches; couple, uncouple or forget them from there.</li>
          <li>A connection controls either an object's <i>position</i> or its <i>shape</i>; animations still control color, opacity and appearance.</li>
        </ul>
      </>
    ),
    actions: [{ label: 'Show me the canvas', run: tourTo('canvas') }],
  },
  {
    id: 'graph',
    title: 'Graphs and parameters',
    keywords: 'function graph expression plot axes parameter slider valuetracker discontinuity domain definition definitions value list sum piecewise if',
    body: (
      <>
        <p>Click <b>ƒ Graph</b> and type an explicit function of <code>x</code>, such as <code>y = a*sin(b*x)</code>. You can use <code>+ − * / ^</code>, implicit multiplication (<code>2x</code>), <code>sin cos tan exp ln log sqrt abs</code> and <code>pi</code>, <code>e</code>.</p>
        <ul>
          <li>Every other letter becomes a <b>parameter</b> with a slider (value, bounds and step). Parameters are shared: graphs, points and labels using <code>a</code> all follow it.</li>
          <li>The <b>preview</b> shows exactly what will be added. Choose new or existing axes, the domain and the color.</li>
          <li>Discontinuities (like those of <code>tan(x)</code>) are found automatically, and the curve isn't drawn across them.</li>
          <li>Also: <code>if(x &lt; 0, 0, x^2)</code> for pieces, <code>sum(k, 1, n, 1/k^2)</code> and <code>prod(…)</code>, <code>mod min max atan2 round isprime</code>, and the scene's <b>definitions</b>.</li>
          <li><b>Definitions</b> (Scene inspector, nothing selected): <b>+ value</b>, <b>+ list</b> and <b>+ function</b> name things written in math, such as <code>period = 2 pi</code>, a list of numbers used as <code>ZEROS[1]</code> (counting from 1), or <code>Z(t)</code> with <i>where</i> names worked out first. Each is checked as you type. Graphs and every math field use them by name, renaming one renames its uses, and the code has them as Python above the scene.</li>
          <li><b>Text with values</b>: a parameter's <i>Show as text</i>, or <i>Show values in it</i> on any Text, puts math in braces in its words: <code>{'t = {t:2}'}</code> (2 decimals), <code>{'½ + {ZEROS[k]:3}i'}</code>. With a parameter in it, the text follows the parameter as it changes.</li>
          <li>Not supported yet: implicit equations (<code>x^2 + y^2 = 1</code>), parametric or polar curves. The builder explains what it can't read.</li>
          <li>To animate a parameter, select it and use <b>Animate to… → Add clip</b>; its sliders appear in the inspector when nothing is selected.</li>
        </ul>
      </>
    ),
    actions: [{ label: 'Open the graph builder', run: open('graph') }],
  },
  {
    id: 'annotate',
    title: 'Annotations and measurements',
    keywords: 'tangent secant shade area riemann length angle slope integral measure label brace highlight',
    body: (
      <>
        <p>Select an object to see the annotations that fit it:</p>
        <ul>
          <li>a segment: <i>Show length</i>, <i>Midpoint</i>; two lines: <i>Mark angle</i>;</li>
          <li>a graph: <i>Point on curve</i>, <i>Tangent</i>, <i>Secant</i>, <i>Shade interval</i>, <i>Riemann rectangles</i>;</li>
          <li>a shaded area: <i>Show integral (numerical)</i>; a tangent or secant: <i>Show slope</i>; an angle: <i>Show angle value</i>.</li>
        </ul>
        <p>Interval bounds and tangent points have handles on the axis you can drag. <b>Shaded regions are visual only</b>; numbers come from measurements, and the inspector says how each one is computed.</p>
      </>
    ),
  },
  {
    id: 'equations',
    title: 'Equations',
    keywords: 'mathtex latex equation term color brace transform mathlive match',
    body: (
      <>
        <p>Add a <b>MathTex</b> from the library. Edit it with the math input or the LaTeX box.</p>
        <ul>
          <li><b>Split into terms</b> makes each symbol a term. Click terms in the inspector or on the canvas to select them, then <i>Color</i>, <i>Brace</i>, <i>Label</i> or <i>Highlight</i> them. Repeated symbols are separate terms (<code>x #1</code>, <code>x #2</code>).</li>
          <li><b>Check with manim</b> compiles the equation with real LaTeX and flags terms that render nothing.</li>
          <li><b>Transform terms…</b> animates one equation into another: click a source term, then the term it becomes, or use <i>Pair identical terms</i>. This only controls how terms move; it doesn't check the math.</li>
          <li>Equations need LaTeX installed. Without it, numbers and simple labels (like <code>A</code> or <code>θ</code>) are drawn with plain text instead.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'constructions',
    title: 'Reusable constructions',
    keywords: 'template construction starter save insert library triangle unit circle number line secant tangent instance linked',
    body: (
      <>
        <p>The library's <b>Build</b> tab holds constructions you can insert at the playhead: a labeled triangle, a unit circle, a number line and a secant-to-tangent demo, plus your own.</p>
        <ul>
          <li>Select objects and choose <b>Save as construction…</b>. Whatever they are built from is included, and you choose which parameters, labels, colors and visibility switches to offer when inserting.</li>
          <li>Save to <b>this project</b> or to <b>your library</b> (shared by all your projects).</li>
          <li>Insert as an <b>independent copy</b>, or <b>linked to its template</b> so <i>Update instances</i> brings in template changes. Each instance gets its own objects.</li>
        </ul>
      </>
    ),
    actions: [{ label: 'Show me the Build tab', run: tourTo('build') }],
  },
  {
    id: 'timeline',
    title: 'Timeline and animation',
    keywords: 'timeline loop for while if else block repeat value variable updater always_redraw clip track play scrub trim marker record animate effect overlap warning order wait statement self.play construct gap ripple keep later timing hold cancel escape cue chapter narration review notes attached in out range loop work area',
    body: (
      <>
        <ul>
          <li>The timeline is the scene in order, exactly as manim runs it. Animations that play together (one <code>self.play</code>) share a shaded <b>Play together</b> column and are stacked on <b>animation lanes</b> V1, V2… (the 1st, 2nd… animation of the group; lanes are not drawing layers: <i>Scene › Drawing order</i> lists what is drawn on top); the group lasts as long as its longest animation, and the next one starts when it ends. A <b>hatched block</b> is a pause (<code>self.wait</code>). Clips read object first: <i>circle · Create</i>.</li>
          <li>Steps that aren’t animations (objects added or removed without one, code, couple / uncouple, scene calls, and anything disabled) sit in a slim <b>Other</b> strip under the ruler, shown only when the scene has some.</li>
          <li>Drag the line under a track’s name (V1, V2…) to make that track taller or shorter; double-click it for the usual height. <b>+ Add track</b> adds empty tracks; × removes the last one while it’s empty.</li>
          <li>Clips show what they do to their object, like transitions and keyframes in a video editor: <b>IN</b> ramps up as it brings the object on screen, <b>OUT</b> ramps down as it takes it off, <b>⇄</b> swaps one object for another (<code>ReplacementTransform</code>), and <b>fx</b> changes an object already there, from the keyframe ◆ at its start to the one at its end. In Effect Controls, <b>Easing</b> sets how the change is spread over time, and <b>Keyframes</b> ◀ ▶ step the playhead through the object’s animations.</li>
          <li><b>Keyframes of</b> an object has a row per property at the playhead (Position, Scale, Rotation, Opacity, Color, Stroke width; a tracker’s value). Clips that move the camera (<code>self.camera.frame.animate…</code>) have the camera’s keyframes: its position and zoom. Each keyframe is the end of a manim clip: changing its value rewrites just that argument (<code>shift(RIGHT * 2)</code> → <code>shift(RIGHT * 3)</code>), ◆ adds a clip such as <code>c.animate.scale(2)</code> or <code>Rotate(c, angle=…)</code> that ends at the playhead (or removes the keyframe there), and with no keyframes yet a value changes the object as created. A keyframe written as an expression or placed relative to something else (<code>next_to(label, RIGHT)</code>) shows its method’s arguments, edited as code; <b>Pin</b> makes a relative one <code>.move_to(…)</code> where it is now. Where the object is already animated, ◆ says why and leaves the code alone.</li>
          <li><b>+ Change</b> adds a <i>Change at once</i> step: methods called on an object at that point without animating them, such as <code>label.next_to(c, UP)</code>. Imported files get one for each such line, and keep how their code was written (chains, positional arguments, wrapping, blank lines) until you edit that statement.</li>
          <li><b>Blocks</b>: a loop, an <code>if</code> / <code>elif</code> / <code>else</code>, a <code>with</code> or a <code>try</code> is a bar in the Other strip with its header and how many times its body ran (<i>for d in dots ×5</i>, <i>didn’t run</i>). Its first run is laid out clip by clip under the bar, and the later runs follow it as faint clips, where manim ran them. Select the bar to edit the header (a <code>range(n)</code> loop gets a Repeat count), add <b>+ else</b> / <b>+ elif</b>, or <b>Unwrap</b> its steps. <b>+ Repeat</b> puts the selected clips in <code>for i in range(2)</code>. Its <b>Loop</b> menu writes it in math instead: <i>a counter</i> (<code>k</code> from <code>1</code> to <code>len(ZEROS)</code>, both ends included) or <i>each item of a list</i>. What is created in the loop (an object whose intro you add with the playhead in it, or one set to be created there) is made anew on each run, and its math fields can use the counter: a point at coordinates <code>(0.5, ZEROS[k])</code> lands on each zero in turn. Used outside its loop, the field offers <b>Create it in the loop</b>. Deleting, moving, copying or disabling a block takes the whole statement; keyframes inside one are edited by their method’s arguments.</li>
          <li><b>+ Value</b> adds a value step (<code>k = 2</code>, <code>total += k</code>): a name later steps can use, edited by name, operation and value. An animation built by an expression (<code>*[FadeOut(m) for m in dots]</code>) is a clip of its own, its code edited in Effect Controls.</li>
          <li><b>Updaters</b> (<code>add_updater</code>, <code>always_redraw</code>) are ⟳ bars over the time manim runs them, from where they are set to where they are cleared; click one to select what sets it.</li>
          <li>Click a group’s shading to select it: Effect Controls then show its animations and the settings it gives them all (<code>run_time</code>, <code>rate_func</code>…, shown in the corner of the shading when set). With the group selected, drag any of its clips to move the whole group; drag the shading’s right edge to retime it; right-click the shading to disable or delete it. <code>AnimationGroup</code>, <code>LaggedStart</code> and <code>Succession</code> show their animations inside the clip, at the times manim plays them.</li>
          <li>Drag a clip into another group’s column to play it with that group, or into a pause to start it there (the pause shrinks, and later steps move only if it doesn’t fit). Drag it up or down to change its track. The drag shows the result before you let go, and a note says where it lands (a group’s start) and how later beats move. <kbd>Alt</kbd>-drag copies; <kbd>Esc</kbd> cancels.</li>
          <li>Drag a clip’s right edge to change its <code>run_time</code>, or a pause’s right edge to change its length. Everything after it moves along, unless <b>Keep later timing</b> is on (the button next to the snap magnet): then the pause right after it gives or takes the time, so later beats keep their time. It never takes more than that pause holds. Duration in Effect Controls works the same way.</li>
          <li>Effect Controls show every argument manim takes for the selected clip: the animation’s class, object(s), duration and arguments; a <code>self.play</code>’s animations (reorder, add, group into <code>LaggedStart</code>…) and the arguments it gives them all; a <code>self.wait</code>’s options. <i>+ self.…</i> on the timeline adds any other scene method: sections, sounds, subcaptions, the 3D camera…</li>
          <li><kbd>Del</kbd> leaves the time as a pause (<code>self.wait</code>), like Premiere; <kbd>{keys('⇧Del')}</kbd> (ripple delete) closes the gap.</li>
          <li>A clip marked <b>!</b> animates an object that isn’t on screen yet (no Create, FadeIn or Add before it): manim would show it from that clip on. Effect Controls explains it.</li>
          <li>Drop an effect from the library's <b>Effects</b> tab onto an object or a track, or use <b>Animate at playhead</b> in the inspector.</li>
          <li>With <b>● Record</b> on, moving, scaling or rotating on the canvas adds <code>.animate</code> clips; dragging a point bound to a parameter records a <code>set_value</code> clip.</li>
          <li><kbd>Space</kbd> plays; <kbd>←</kbd>/<kbd>→</kbd> step frames; <kbd>↑</kbd>/<kbd>↓</kbd> jump between edit points; <kbd>M</kbd> adds a marker.</li>
          <li><b>In / Out</b>: <kbd>I</kbd> and <kbd>O</kbd> (or <code>{'{'}</code> <code>{'}'}</code> by the transport) mark a range; it shows as a bar on the ruler that you can drag. <kbd>{keys('⇧Space')}</kbd> plays In to Out and stops at Out; <b>Loop</b> ⟲ starts playback over at In. The readout by the transport gives the range’s length in seconds and frames (the frame at Out is not included). The range is for playback only: export still renders the whole scene. <kbd>{keys('⇧⌘X')}</kbd> clears it.</li>
          <li><b>Markers</b>: with a clip selected under the playhead, <kbd>M</kbd> attaches the new marker to that clip’s start or end, so it moves with the clip. Click a marker to jump there and edit it (name, kind, notes, what it is attached to); double-click to name it; drag it along the ruler; <kbd>Alt</kbd>-click deletes it. <i>Scene › Markers</i> lists them all, with search and a filter by kind (Chapter, Narration, Visual event, Review).</li>
          <li><b>Auto-render</b> renders a smooth preview in the background; when it's ready, <kbd>Space</kbd> plays it. The preview button says <i>Preview ready</i>, <i>Rendering</i>, <i>Preview out of date</i> (click to render again) or <i>Render failed · Retry</i>. The monitor says <i>Updating this frame…</i> while the picture catches up with the playhead, and offers <b>Retry</b> when a frame couldn’t be drawn.</li>
        </ul>
      </>
    ),
    actions: [{ label: 'Show me the timeline', run: tourTo('timeline') }],
  },
  {
    id: 'python',
    title: 'Python, code and export',
    keywords: 'python code export render video raw header manim file',
    body: (
      <>
        <ul>
          <li>Every field accepts Python: click <code>{'{}'}</code> next to a field to type any expression manim accepts (<code>BLUE</code>, <code>UP * 2</code>, <code>lambda x: x**2</code>).</li>
          <li><b>Code</b> steps (<i>+ Code</i> on the timeline) run any manim code inside <code>construct()</code>.</li>
          <li>The <b>&lt;/&gt; Code</b> tab is the whole scene as a manim file, and it works both ways. Edit it and the timeline, canvas and inspector follow; edit those and the code follows. Click anything on the timeline and the block of code that makes it lights up (for an animation, its whole <code>self.play</code> with the animation marked inside, and faintly where its object is made); click in the code to select the animation or object under the caret.</li>
          <li>Paste a whole manim file into it (or use <i>Open manim file…</i> on Home, or <code>manim-studio scene.py</code>) and its scene becomes the timeline. Each <code>self.play</code> becomes clips, objects are created where the code creates them, loops and ifs become blocks, values and method calls become steps, and updaters are bars; the little the timeline can't show (a nested function, a <code>match</code>…) is kept as code, so the scene runs exactly as written. Imports, helpers and custom classes stay at the top of the file, and other methods of the scene class stay in it.</li>
          <li><i>Save .py</i> writes a standalone manim file.</li>
          <li><b>Export video</b> renders with manim at the quality you choose.</li>
        </ul>
      </>
    ),
    actions: [{ label: 'Open the code view', run: open('code') }, { label: 'Export video', run: open('export') }],
  },
  {
    id: 'keys',
    title: 'Keyboard shortcuts',
    keywords: 'keys shortcuts hotkeys keyboard',
    body: (
      <table className="keys-table">
        <tbody>
          {[
            ['1 – 7', 'Drawing tools (select, point, segment, arrow, circle, rectangle, polygon)'],
            ['Enter / Esc', 'Finish a polygon / cancel drawing'],
            ['Shift-click', 'Add to the selection'],
            ['Space, J / K / L', 'Play / pause'],
            ['← / →', 'Previous / next frame (Shift: 5 frames)'],
            ['↑ / ↓', 'Previous / next edit point'],
            ['Home / End', 'Start / end of the sequence'],
            [keys('Del, ⇧Del'), 'Delete, ripple delete'],
            [keys('⌘D'), 'Duplicate selected objects'],
            [keys('⌘X / ⌘C / ⌘V'), 'Cut / copy / paste clips'],
            [keys('⌘Z / ⇧⌘Z'), 'Undo / redo'],
            [keys('⌘S / ⌘N'), 'Save / new project'],
            ['I / O', 'Set In / Out at the playhead (Shift: go to it)'],
            [keys('⇧Space · ⇧⌘X'), 'Play In to Out · clear In and Out'],
            ['M · S · = / -', 'Marker · timeline snap · zoom'],
            ['/', 'Search the library: type a name, Enter adds the top result'],
            ['? or F1', 'Open this guide'],
          ].map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}
        </tbody>
      </table>
    ),
  },
  {
    id: 'trouble',
    title: 'Troubleshooting',
    keywords: 'error problem latex missing broken construction warning slow',
    body: (
      <ul>
        <li><b>A red error bar under the canvas</b>: click it to jump to the object or clip that failed. The last good frame stays visible, dimmed.</li>
        <li><b>“Construction error” or a note on an object</b>: a source was deleted, is the wrong kind (an angle needs two lines), comes later in the scene, or the objects depend on each other in a loop. The inspector says which; pick another source, or <b>Uncouple</b> / <b>Forget</b> the relationship.</li>
        <li><b>“…is undone when the animation ends”</b> on a clip: you animated the position or shape of a connected object. Animate its source or parameter instead, or uncouple it during the clip (+ Uncouple at playhead / + Couple at playhead).</li>
        <li><b>“Needs LaTeX”</b> on an equation: install LaTeX (MiKTeX on Windows, MacTeX or BasicTeX on macOS, TeX Live on Linux), then click <b>Check again</b> in the scene panel; no restart needed. Until then, numbers and simple labels are drawn with plain text.</li>
        <li><b>The app closed before I saved</b>: open <b>Home</b> (the toolbar’s ⌂ Home button) and use <b>Restore</b> under <b>Unsaved work</b>.</li>
        <li><b>Some toolbar switches are missing</b>: in a narrow window <b>Snap</b>, <b>Auto-intro</b>, <b>Record</b> and <b>Auto-render</b> move into the <b>Options</b> menu.</li>
        <li><b>Playback is choppy</b>: live playback renders each frame; leave <b>Auto-render</b> on and play once the preview is ready.</li>
      </ul>
    ),
  },
];

/** The searchable guide. */
export function HelpPanel() {
  const initial = useStore((s) => s.panelData as string | null);
  const [topic, setTopic] = useState<string>(initial && TOPICS.some((t) => t.id === initial) ? initial : 'start');
  const [query, setQuery] = useState('');
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOPICS;
    return TOPICS.filter((t) => `${t.title} ${t.keywords}`.toLowerCase().includes(q));
  }, [query]);
  const current = TOPICS.find((t) => t.id === topic) ?? TOPICS[0];
  return (
    <Modal title="Help" wide>
      <div className="help">
        <nav className="help-nav" aria-label="Help topics">
          <input className="field" placeholder="Search help…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          {list.map((t) => (
            <button key={t.id} className={`help-topic ${t.id === current.id ? 'on' : ''}`} onClick={() => setTopic(t.id)}>{t.title}</button>
          ))}
          {list.length === 0 && <p className="muted small">No topics match.</p>}
          <div className="help-tour">
            <button className="primary" onClick={() => startTour(0)}>Take the tour</button>
          </div>
        </nav>
        <article className="help-body">
          <h2>{current.title}</h2>
          {current.body}
          {current.actions && (
            <div className="row help-actions">
              {current.actions.map((a) => <button key={a.label} onClick={a.run}>{a.label}</button>)}
            </div>
          )}
        </article>
      </div>
    </Modal>
  );
}

const WELCOME_KEY = 'mathengine.welcomed';

/** A small first-run card offering the tour. */
export function WelcomeCard() {
  const tour = useStore((s) => s.tour);
  const panel = useStore((s) => s.panel);
  const [show, setShow] = useState(() => !pref(WELCOME_KEY));
  const dismiss = () => {
    setShow(false);
    setPref(WELCOME_KEY, '1');
  };
  if (!show || tour !== null || panel) return null;
  return (
    <div className="welcome-card" role="dialog" aria-label="Welcome">
      <b>New to Manim Studio?</b>
      <p className="muted small">A one-minute tour shows where everything is, and <i>Try this</i> walks you through a first animation, from a circle to a video, without code. Both are in Help at any time.</p>
      <div className="row">
        <button className="ghost small" onClick={dismiss}>Not now</button>
        <span className="spacer" />
        <button className="ghost small" onClick={() => { dismiss(); startTryThis(); }}>Try this</button>
        <button className="primary" onClick={() => { dismiss(); startTour(0); }}>Take the tour</button>
      </div>
    </div>
  );
}
