// Scene document — mirrors mathengine/codegen.py. All values are Python source strings.

export type Args = Record<string, string>;

export interface SceneObject {
  id: string;
  name: string; // Python variable name
  ctor: string; // callable expression: "Circle", "axes.plot", ...
  args: Args; // "*" holds extra positional args
  pos: [number, number] | null;
  chain: string; // e.g. ".scale(2).set_fill(BLUE, 0.5)"
  scale?: number;
  stretch?: [number, number];
  rotation?: number; // degrees
  link?: Link; // defined by its relationship to other objects (mathengine/construct.py)
  eq?: { parts: EqPart[] }; // equation split into terms
  param?: ParamMeta; // a ValueTracker used as a named parameter
  instance?: InstanceRef; // part of an inserted construction
  after?: string; // created right after this timeline step (as in the imported code); none: at the top of construct()
  comment?: string; // comment lines written above it in the code
  eol?: string; // the comment at the end of its (last) line in the code
  chain_layout?: string[]; // how the code spread the chain: [on the line that makes it, then each line of calls after it]
  positional?: string[]; // the arguments the code passed by position, in order
  gap?: boolean; // a blank line before it in the code
  written?: Written;
}

/** Slider bounds of a parameter (a ValueTracker object; its value is args["*"]). */
export interface ParamMeta {
  min: number;
  max: number;
  step: number;
}

/** A term of an equation; ids stay stable across edits so styling and correspondences survive. */
export interface EqPart {
  id: string;
  tex: string;
  color?: string;
}

export interface InstanceRef {
  template: string; // template id
  instance: string; // id shared by all objects of one inserted instance
  local: string; // the object's id inside the template
  linked?: boolean; // regenerated when the template changes
  inputs?: Record<string, string>; // the instance's input values
  offset?: [number, number]; // where it was placed relative to the template
}

/**
 * Follow links own an object's position; redraw links own its shape. Sources are object ids; expressions are math text.
 * `off`: uncoupled: the relationship is kept but paused (the object is edited freely) until it is coupled again.
 */
export type Link = LinkSpec & { off?: boolean };
type LinkSpec =
  | { kind: 'attach'; to: string; parts?: string[]; offset: [number, number]; frozen?: boolean }
  | { kind: 'midpoint'; a: string; b?: string; frozen?: boolean }
  | { kind: 'on_graph'; graph: string; x: string; frozen?: boolean }
  | { kind: 'on_circle'; circle: string; angle: string; frozen?: boolean }
  | { kind: 'coords'; axes: string; x: string; y: string; frozen?: boolean }
  // Lines are extended both ways; an axes source means its x-axis, or its y-axis with axis: 'y'.
  | { kind: 'intersection'; a: string; b: string; which?: number; axis?: 'x' | 'y'; frozen?: boolean }
  | { kind: 'projection'; point: string; onto: string; axis?: 'x' | 'y'; frozen?: boolean }
  | { kind: 'measure'; what: 'length' | 'angle' | 'slope' | 'integral' | 'value'; of?: string; expr?: string; offset?: [number, number]; degrees?: boolean; frozen?: boolean }
  | { kind: 'segment'; a: string; b: string; mode?: 'center' | 'boundary'; frozen?: boolean }
  | { kind: 'circle2'; a: string; b: string; mode?: 'center' | 'diameter'; frozen?: boolean }
  | { kind: 'perpendicular'; line: string; through: string; mode?: 'line' | 'foot'; length?: string; axis?: 'x' | 'y'; frozen?: boolean }
  | { kind: 'parallel'; line: string; through: string; length?: string; axis?: 'x' | 'y'; frozen?: boolean }
  | { kind: 'polygon'; points: string[]; frozen?: boolean }
  | { kind: 'angle'; l1: string; l2: string; radius?: string; other?: boolean; quadrant?: [number, number]; frozen?: boolean }
  | { kind: 'graph'; axes: string; expr: string; x_min?: number; x_max?: number; discontinuities?: number[]; gap?: number; frozen?: boolean }
  | { kind: 'tangent'; graph: string; x: string; length?: string; frozen?: boolean }
  | { kind: 'secant'; graph: string; x: string; dx: string; length?: string; frozen?: boolean }
  | { kind: 'area'; graph: string; a: string; b: string; bounded?: string; frozen?: boolean }
  | { kind: 'riemann'; graph: string; a: string; b: string; dx: string; sample?: 'left' | 'right' | 'center'; bounded?: string; frozen?: boolean }
  | { kind: 'brace'; target: string; parts?: string[]; direction?: string; frozen?: boolean }
  | { kind: 'highlight'; target: string; parts?: string[]; style?: 'box' | 'background' | 'underline'; frozen?: boolean };

export type LinkKind = Link['kind'];

/** Reusable construction: objects + timeline steps + exposed inputs (mathengine/starters.py). */
export interface Template {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  objects: SceneObject[];
  timeline: Step[]; // inserted at the playhead, targets by template-local name
  inputs: TemplateInput[];
}

export interface TemplateInput {
  id: string;
  kind: 'param' | 'text' | 'color' | 'visible';
  label: string;
  default: string;
  targets: { object: string; key?: string }[];
}

/**
 * The timeline is construct()'s statements, in order (mathengine/timeline.py). Each step is one manim statement:
 * play: self.play(*anims, **args) · wait: self.wait(**args) · add / remove: self.add(*targets) · code: any Python ·
 * couple / uncouple: switch constructions · call: self.<method>(**args), any other method of the scene
 * (next_section, add_sound, move_camera…) · apply: target.method(…) · assign: target op value (k = 2, total += x).
 * block … end: a compound statement (for, while, if/elif/else, with, try…) around the steps between them; a block whose
 * head starts with elif / else / except / finally is the next clause of the open one. A step starts when the one before it ends.
 */
export type StepKind = 'play' | 'wait' | 'add' | 'remove' | 'code' | 'couple' | 'uncouple' | 'call' | 'apply' | 'assign' | 'block' | 'end';

export interface Step {
  id: string;
  kind: StepKind;
  disabled?: boolean; // left out of the code
  comment?: string; // comment lines above it in the code
  eol?: string; // the comment at the end of its (last) line in the code
  anims?: Anim[]; // play
  args?: Args; // play: self.play keyword arguments (run_time, rate_func…); wait: duration…; call: the method's arguments
  method?: string; // call: the scene method
  code?: string; // code
  label?: string; // code: name shown on the timeline
  targets?: string[]; // add / remove / couple / uncouple
  duration?: number; // couple: glide back into place over this time
  positional?: string[]; // call: the arguments the code passed by position, in order
  gap?: boolean; // a blank line before it in the code
  target?: string; // apply: the object (or part of one) its methods are called on
  chain?: string; // apply: the methods, ".next_to(u, UP).set_color(RED)"
  op?: string; // assign: "=", "+=", "-="…
  value?: string; // assign: the expression on the right
  head?: string; // block: its header without the colon, "for d in dots", "if k > 2", "else"
  written?: Written;
}

/** The code's own text of an element (its line breaks, spacing…), written as is while codegen would write `gen`. */
export interface Written {
  gen: string;
  as: string;
}

/** An animation: cls(target, **args), target.animate(**args).chain, or a composition of `anims`. */
export interface Anim {
  id: string;
  cls: string; // "Create", ... "animate", or "expr" (any other animation expression, written as `src`)
  src?: string; // cls === "expr": the expression, "*[FadeOut(m) for m in dots]"
  target: string;
  args: Args;
  chain?: string; // cls === "animate"
  anims?: Anim[]; // AnimationGroup, LaggedStart, Succession…: the child animations
  disabled?: boolean;
  positional?: string[]; // the arguments the code passed by position, in order (after the target)
  // TransformTerms: destination equation (object id) and term pairs [source part id, target part id]
  terms?: { to: string; pairs: [string, string][] };
}

export type MarkerCategory = 'chapter' | 'narration' | 'visual' | 'review';

export interface Marker {
  id: string;
  time: number; // where it is (for an attached marker: where it was last, used if what it is attached to goes away)
  label?: string;
  notes?: string;
  category?: MarkerCategory;
  // attached to the start or end of a step or an animation (by id), `offset` seconds from it: it moves along with it
  anchor?: { id: string; edge: 'start' | 'end'; offset: number };
}

export interface SceneDoc {
  version: number;
  scene: { name: string; base: string; members?: string; members_after?: string; decorators?: string }; // members: other code of the class
  config: { pixel_width: number; pixel_height: number; frame_rate: number; background_color: string };
  header: string;
  footer?: string; // module code after the scene class
  top_written?: Written; // the top of the file (imports, config, header) as the imported code had it
  objects: SceneObject[];
  timeline: Step[];
  markers?: Marker[];
  constructions?: Template[];
}

export interface Param {
  name: string;
  label: string;
  kind: ParamKind;
  default: string;
  required: boolean;
  annotation: string;
  from: string;
  options?: string[]; // choice: Python expressions to pick from
  hint?: string; // dict: class (or Class.method) whose kwargs are the keys
  template?: string; // function: starter lambda
  int?: boolean; // number: integer
  objects?: boolean; // vector: also accepts a mobject
  pos?: number; // positional index (the "*" arg fills pos 0 when the class has no *args)
  kwonly?: boolean;
  accepts?: string[]; // mobject(s): classes the referenced object must be (Angle.line1 -> Line…)
  doc?: string; // what it is and what changing it does (manim's docstrings, or Manim Studio's own words)
}

export type ParamKind =
  | 'number' | 'bool' | 'color' | 'string' | 'vector' | 'rate_func' | 'expr' | 'choice' | 'mobject' | 'mobjects'
  | 'range' | 'numbers' | 'strings' | 'colors' | 'colormap' | 'dict' | 'points' | 'function' | 'path' | 'matrix'
  | 'values' | 'pairs' | 'vertex' | 'key' | 'animation' | 'dicts' | 'svgpath';

export interface CatalogEntry {
  name: string;
  kind: 'mobject' | 'animation';
  category: string;
  doc: string;
  bases: string[];
  vector: boolean;
  starter: Args;
  featured: number;
}

export interface Catalog {
  manim_version: string;
  mobjects: CatalogEntry[];
  animations: CatalogEntry[];
  colors: string[];
  color_hex: Record<string, string>;
  directions: string[];
  rate_funcs: string[];
  methods: string[];
  scene_bases: string[];
  scene_methods: Record<string, string[]>; // methods a statement can call, per Scene class
  latex: boolean;
  latex_hint?: string; // how to install LaTeX on this OS
  ffmpeg: boolean;
}

export interface Signature {
  name: string;
  params: Param[];
  doc: string;
  animation: boolean;
  vector: boolean;
  unknown?: boolean;
  methods?: string[]; // chainable methods (mobject classes)
  factories?: string[]; // methods that build a new mobject from this one (axes.plot)
  returns?: string; // mobject class this expression builds
  target?: Param & { kind: ParamKind | 'animations' | 'none' }; // animations: what they animate
}

export interface RunError {
  message: string;
  line: number | null;
  kind: 'object' | 'step' | 'anim' | 'header' | null;
  id: string | null;
  trace: string;
}

export type Pt = [number, number];

export interface ObjInfo {
  id: string;
  name: string;
  visible: boolean;
  box: [number, number, number, number] | null; // x0, y0, x1, y1 (scene units, y up)
  center: Pt | null;
  geom?: { kind: 'line'; start: Pt; end: Pt } | { kind: 'point'; center: Pt } | { kind: 'circle'; center: Pt; radius: number } | { kind: 'polygon'; vertices: Pt[] };
  path?: Pt[]; // sampled outline (graphs, circles) for snapping
  axes?: { origin: Pt; ux: Pt; uy: Pt; x_range: [number, number]; y_range: [number, number] };
  parts?: { id: string; box: [number, number, number, number] | null }[];
  layer?: number | null; // drawing order at this time: higher is drawn later (on top); null when nothing of it is on screen
}

/** An object as an animation takes it from / to it (a ValueTracker: just its value). */
export interface ObjState {
  center?: [number, number];
  width?: number;
  height?: number;
  opacity?: number;
  color?: string; // #RRGGBB
  value?: number;
}

export interface Diagnostic {
  id: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  kind: 'object' | 'anim';
}

export interface RunResult {
  duration: number;
  // when each statement runs (measured by manim), and which objects (ids) were on screen just before and after it
  steps: { id: string; start: number; end: number; before?: string[]; after?: string[]; from?: ObjState; to?: ObjState }[];
  // when manim runs each animation; curve: its progress over that time; from / to: its object then (measuring run, top-level)
  anims: { id: string; start: number; end: number; curve?: number[]; from?: ObjState; to?: ObjState }[];
  objects: ObjInfo[];
  camera: { center: [number, number]; width: number; height: number } | null;
  plays: number;
  image: string | null;
  error: RunError | null;
  elapsed_ms: number;
  values: Record<string, number>; // ValueTracker values at this time
  diagnostics: Diagnostic[];
  doc?: SceneDoc; // the document this measured (set by the editor): its timings hold only for steps unchanged since
}

export interface Job {
  id?: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress?: number;
  message: string;
  output?: string | null;
  log?: string;
  error?: RunError;
}

export type Selection =
  | { kind: 'object'; id: string; terms?: string[] } // terms: selected equation parts
  | { kind: 'objects'; ids: string[] }
  | { kind: 'clips'; ids: string[] } // timeline steps and animations (by id)
  | { kind: 'marker'; id: string }
  | null;

/** Canvas tool. */
export type Tool = 'select' | 'point' | 'line' | 'arrow' | 'circle' | 'rect' | 'polygon';
