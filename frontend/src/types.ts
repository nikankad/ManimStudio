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

/** Follow links own an object's position; redraw links own its shape. Sources are object ids; expressions are math text. */
export type Link =
  | { kind: 'attach'; to: string; parts?: string[]; offset: [number, number]; frozen?: boolean }
  | { kind: 'midpoint'; a: string; b?: string; frozen?: boolean }
  | { kind: 'on_graph'; graph: string; x: string; frozen?: boolean }
  | { kind: 'on_circle'; circle: string; angle: string; frozen?: boolean }
  | { kind: 'coords'; axes: string; x: string; y: string; frozen?: boolean }
  | { kind: 'measure'; what: 'length' | 'angle' | 'slope' | 'integral' | 'value'; of?: string; expr?: string; offset?: [number, number]; degrees?: boolean; frozen?: boolean }
  | { kind: 'segment'; a: string; b: string; mode?: 'center' | 'boundary'; frozen?: boolean }
  | { kind: 'circle2'; a: string; b: string; mode?: 'center' | 'diameter'; frozen?: boolean }
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

/** Reusable construction: objects + clips + exposed inputs (mathengine/starters.py). */
export interface Template {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  objects: SceneObject[];
  clips: Partial<Clip>[]; // relative start, targets by template-local name
  inputs: TemplateInput[];
}

export interface TemplateInput {
  id: string;
  kind: 'param' | 'text' | 'color' | 'visible';
  label: string;
  default: string;
  targets: { object: string; key?: string }[];
}

export interface Track {
  id: string;
  name: string;
  hidden?: boolean; // track output off: clips are skipped
  locked?: boolean;
}

export type ClipKind = 'anim' | 'code' | 'hold' | 'add' | 'remove';

export interface Clip {
  id: string;
  kind: ClipKind;
  track: string;
  start: number; // seconds
  duration: number; // seconds (0 for add/remove)
  disabled?: boolean;
  // anim
  cls?: string; // "Create", ... or "animate"
  target?: string;
  args?: Args;
  chain?: string; // for cls === "animate"
  // code
  code?: string;
  label?: string;
  // add / remove
  targets?: string[];
  // TransformTerms: destination equation (object id) and term pairs [source part id, target part id]
  terms?: { to: string; pairs: [string, string][] };
}

export interface Marker {
  id: string;
  time: number;
  label?: string;
}

export interface SceneDoc {
  version: number;
  scene: { name: string; base: string };
  config: { pixel_width: number; pixel_height: number; frame_rate: number; background_color: string };
  header: string;
  objects: SceneObject[];
  tracks: Track[];
  clips: Clip[];
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
  latex: boolean;
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
}

export interface RunError {
  message: string;
  line: number | null;
  kind: 'object' | 'clip' | 'header' | null;
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
}

export interface Diagnostic {
  id: string;
  level: 'error' | 'warning';
  message: string;
  kind: 'object' | 'clip';
}

export interface RunResult {
  duration: number;
  steps: { id: string; start: number; end: number }[];
  objects: ObjInfo[];
  camera: { center: [number, number]; width: number; height: number } | null;
  plays: number;
  image: string | null;
  error: RunError | null;
  elapsed_ms: number;
  values: Record<string, number>; // ValueTracker values at this time
  diagnostics: Diagnostic[];
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
  | { kind: 'clips'; ids: string[] }
  | null;

/** Canvas tool. */
export type Tool = 'select' | 'point' | 'line' | 'arrow' | 'circle' | 'rect' | 'polygon';
