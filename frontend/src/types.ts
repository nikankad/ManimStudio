// Scene document — mirrors mathengine/codegen.py. All values are Python source strings.

export type Args = Record<string, string>;

export interface SceneObject {
  id: string;
  name: string; // Python variable name
  ctor: string; // callable expression: "Circle", "axes.plot", ...
  args: Args; // "*" holds extra positional args
  pos: [number, number] | null;
  chain: string; // e.g. ".scale(2).set_fill(BLUE, 0.5)"
}

export interface AnimEntry {
  id: string;
  cls: string; // "Create", ... or "animate"
  target: string;
  args: Args;
  chain?: string; // for cls === "animate"
}

export type Step =
  | { id: string; kind: 'play'; anims: AnimEntry[]; run_time?: string; rate_func?: string; lag_ratio?: string; args?: Args; disabled?: boolean }
  | { id: string; kind: 'wait'; duration: string; disabled?: boolean }
  | { id: string; kind: 'add' | 'remove'; targets: string[]; disabled?: boolean }
  | { id: string; kind: 'code'; code: string; label?: string; disabled?: boolean };

export interface SceneDoc {
  version: number;
  scene: { name: string; base: string };
  config: { pixel_width: number; pixel_height: number; frame_rate: number; background_color: string };
  header: string;
  objects: SceneObject[];
  steps: Step[];
}

export interface Param {
  name: string;
  label: string;
  kind: 'number' | 'bool' | 'color' | 'string' | 'vector' | 'rate_func' | 'expr';
  default: string;
  required: boolean;
  annotation: string;
  from: string;
}

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
}

export interface RunError {
  message: string;
  line: number | null;
  kind: 'object' | 'step' | 'header' | null;
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

export type Selection =
  | { kind: 'object'; id: string }
  | { kind: 'step'; id: string }
  | { kind: 'anim'; stepId: string; id: string }
  | null;
