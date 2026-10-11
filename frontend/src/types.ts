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

export interface ObjInfo {
  id: string;
  name: string;
  visible: boolean;
  box: [number, number, number, number] | null; // x0, y0, x1, y1 (scene units, y up)
  center: [number, number] | null;
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

export type Selection = { kind: 'object'; id: string } | { kind: 'clips'; ids: string[] } | null;
