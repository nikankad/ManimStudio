// Constructions on the editor side: classification, dependencies and copying.
// Mirrors mathengine/construct.py, which validates and compiles them.

import { renameIdentifiers } from './pyparse';
import type { Link, SceneDoc, SceneObject } from './types';

export type GeoType =
  | 'point' | 'line' | 'circle' | 'polygon' | 'graph' | 'axes' | 'numberline' | 'equation' | 'text' | 'param'
  | 'angle' | 'area' | 'riemann' | 'annotation' | 'other';

const POINT = new Set(['Dot', 'SmallDot', 'AnnotationDot', 'LabeledDot', 'Dot3D']);
const LINE = new Set(['Line', 'DashedLine', 'Arrow', 'DoubleArrow', 'Vector', 'TangentLine']);
const POLYGON = new Set(['Polygon', 'Triangle', 'Square', 'Rectangle', 'RegularPolygon', 'RoundedRectangle', 'Polygram']);
const AXES = new Set(['Axes', 'NumberPlane', 'ComplexPlane']);
const EQUATION = new Set(['MathTex', 'Tex', 'SingleStringMathTex']);
const TEXT = new Set(['Text', 'MarkupText', 'DecimalNumber', 'Integer', 'Paragraph']);

export const FOLLOW_KINDS = new Set<Link['kind']>(['attach', 'midpoint', 'on_graph', 'on_circle', 'coords', 'measure', 'intersection', 'projection']);
const KIND_TYPE: Partial<Record<Link['kind'], GeoType>> = {
  midpoint: 'point', on_graph: 'point', on_circle: 'point', coords: 'point', intersection: 'point', projection: 'point',
  segment: 'line', tangent: 'line', secant: 'line', perpendicular: 'line', parallel: 'line',
  circle2: 'circle', polygon: 'polygon', angle: 'angle', graph: 'graph', area: 'area', riemann: 'riemann', brace: 'annotation',
  highlight: 'annotation',
};

/** Names generated code defines itself (construct.RESERVED_NAMES). */
export const RESERVED_NAMES = new Set(['Constraints', 'Geometry', 'TransformTerms', 'TimedAnimations', 'TransformMatchingAbstractBase', 'np', 'self', 'constraints']);

const factory = (ctor: string) => ctor.match(/^([A-Za-z_]\w*)\.(\w+)$/);

export function geoType(o: SceneObject | undefined, doc: SceneDoc): GeoType {
  if (!o) return 'other';
  const k = o.link?.kind;
  if (k && KIND_TYPE[k]) return KIND_TYPE[k]!;
  const c = o.ctor.trim();
  if (POINT.has(c)) return 'point';
  if (LINE.has(c)) return 'line';
  if (c === 'Circle') return 'circle';
  if (POLYGON.has(c)) return 'polygon';
  if (AXES.has(c)) return 'axes';
  if (c === 'NumberLine') return 'numberline';
  if (EQUATION.has(c)) return 'equation';
  if (TEXT.has(c)) return 'text';
  if (c === 'ValueTracker') return 'param';
  if (c === 'Angle') return 'angle';
  const f = factory(c);
  if (f && (f[2] === 'plot' || f[2] === 'get_graph')) {
    const owner = doc.objects.find((x) => x.name === f[1]);
    if (owner && geoType(owner, doc) === 'axes') return 'graph';
  }
  return 'other';
}

/** Axes object a graph is plotted on. */
export function graphAxes(g: SceneObject, doc: SceneDoc): SceneObject | undefined {
  if (g.link?.kind === 'graph') return doc.objects.find((o) => o.id === (g.link as { axes: string }).axes);
  const f = factory(g.ctor.trim());
  return f ? doc.objects.find((o) => o.name === f[1]) : undefined;
}

/** Link fields that hold object ids. */
const SOURCE_KEYS = ['to', 'a', 'b', 'graph', 'circle', 'axes', 'of', 'l1', 'l2', 'target', 'bounded', 'line', 'through', 'point', 'onto'];

/** Object ids a link refers to. */
export function linkSources(link: Link | undefined): string[] {
  if (!link) return [];
  const l = link as Record<string, unknown>;
  const out: string[] = [];
  for (const k of SOURCE_KEYS) if (typeof l[k] === 'string' && l[k]) out.push(l[k] as string);
  if (link.kind === 'polygon') out.push(...link.points);
  return out;
}

/** Math-expression fields of a link (they may name parameters). */
export const EXPR_FIELDS: Partial<Record<Link['kind'], string[]>> = {
  on_graph: ['x'], on_circle: ['angle'], coords: ['x', 'y'], measure: ['expr'], tangent: ['x', 'length'], secant: ['x', 'dx', 'length'],
  area: ['a', 'b'], riemann: ['a', 'b', 'dx'], angle: ['radius'], graph: ['expr'], perpendicular: ['length'], parallel: ['length'],
};

const words = (s: string) => s.match(/[A-Za-z_]\w*/g) ?? [];

/** Parameter names (ValueTracker objects) a link's expressions read. */
export function linkParams(link: Link | undefined, doc: SceneDoc): string[] {
  if (!link) return [];
  const trackers = new Set(doc.objects.filter((o) => o.ctor === 'ValueTracker').map((o) => o.name));
  const out = new Set<string>();
  for (const f of EXPR_FIELDS[link.kind] ?? []) {
    const v = (link as Record<string, unknown>)[f];
    if (typeof v === 'string') for (const w of words(v)) if (trackers.has(w)) out.add(w);
  }
  return [...out];
}

/** Everything an object structurally depends on: link sources, parameters and the owner of a factory constructor (axes in axes.plot). */
export function objectDeps(o: SceneObject, doc: SceneDoc): string[] {
  const ids = new Set(linkSources(o.link));
  for (const p of linkParams(o.link, doc)) {
    const t = doc.objects.find((x) => x.name === p);
    if (t) ids.add(t.id);
  }
  const f = factory(o.ctor.trim());
  if (f) {
    const owner = doc.objects.find((x) => x.name === f[1]);
    if (owner) ids.add(owner.id);
  }
  ids.delete(o.id);
  return [...ids];
}

/** Objects that (transitively) depend on any of `ids`. */
export function dependentsOf(doc: SceneDoc, ids: Iterable<string>): SceneObject[] {
  const hit = new Set(ids);
  const out: SceneObject[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of doc.objects) {
      if (hit.has(o.id)) continue;
      if (objectDeps(o, doc).some((d) => hit.has(d))) {
        hit.add(o.id);
        out.push(o);
        grew = true;
      }
    }
  }
  return out;
}

/** Would making `id` depend on `sources` create a cycle? */
export function wouldCycle(doc: SceneDoc, id: string, sources: string[]): boolean {
  if (sources.includes(id)) return true;
  const deps = new Set(dependentsOf(doc, [id]).map((o) => o.id));
  return sources.some((s) => deps.has(s));
}

/**
 * Order objects so each comes after what it depends on, moving as little as possible
 * (document order is construction order). Cycles are left in place for the backend to report.
 */
export function sortByDependencies(doc: SceneDoc): void {
  const idx = new Map(doc.objects.map((o, i) => [o.id, i]));
  const deps = new Map(doc.objects.map((o) => [o.id, objectDeps(o, doc).filter((d) => idx.has(d))]));
  const done = new Set<string>();
  const out: SceneObject[] = [];
  const pending = [...doc.objects];
  while (pending.length) {
    const i = pending.findIndex((o) => deps.get(o.id)!.every((d) => done.has(d)));
    const pick = pending.splice(i < 0 ? 0 : i, 1)[0]; // i < 0: a cycle; keep going in document order
    done.add(pick.id);
    out.push(pick);
  }
  doc.objects = out;
}

/** Rename references to objects in Python fields and link expressions (never inside string literals). */
export function renameRefs(o: SceneObject, names: Map<string, string>): void {
  if (!names.size) return;
  const rep = (s: string) => renameIdentifiers(s, names);
  o.ctor = rep(o.ctor);
  o.chain = rep(o.chain);
  for (const k in o.args) o.args[k] = rep(o.args[k]);
  if (o.link) {
    const l = o.link as Record<string, unknown>;
    for (const f of EXPR_FIELDS[o.link.kind] ?? []) if (typeof l[f] === 'string') l[f] = rep(l[f] as string);
  }
}

/** Point a copied object's link at copied sources (`ids`); sources outside the copy stay shared. */
export function remapLink(o: SceneObject, ids: Map<string, string>): void {
  if (!o.link) return;
  const l = o.link as Record<string, unknown>;
  for (const k of SOURCE_KEYS)
    if (typeof l[k] === 'string' && ids.has(l[k] as string)) l[k] = ids.get(l[k] as string);
  if (o.link.kind === 'polygon') o.link.points = o.link.points.map((p) => ids.get(p) ?? p);
}

export const isFollow = (o: SceneObject) => !!o.link && FOLLOW_KINDS.has(o.link.kind) && !o.link.frozen;
export const isRedraw = (o: SceneObject) => !!o.link && !FOLLOW_KINDS.has(o.link.kind) && !o.link.frozen;
/** Whether the construction decides where the object is (a value label without an anchor keeps its own position). */
export const ownsPosition = (o: SceneObject) => isRedraw(o) || (isFollow(o) && !(o.link!.kind === 'measure' && !o.link!.of));

/** Human-readable description of a link. */
export function describeLink(o: SceneObject, doc: SceneDoc): string {
  const l = o.link;
  if (!l) return '';
  const n = (id?: string) => doc.objects.find((x) => x.id === id)?.name ?? '(missing)';
  switch (l.kind) {
    case 'attach': return `attached to ${n(l.to)}${l.parts?.length ? ` (${l.parts.length} term${l.parts.length > 1 ? 's' : ''})` : ''}`;
    case 'midpoint': return l.b ? `midpoint of ${n(l.a)} and ${n(l.b)}` : `midpoint of ${n(l.a)}`;
    case 'on_graph': return `on ${n(l.graph)} at x = ${l.x}`;
    case 'on_circle': return `on ${n(l.circle)} at angle ${l.angle}`;
    case 'coords': return `at (${l.x}, ${l.y}) on ${n(l.axes)}`;
    case 'intersection': return `${ordinal(l.which ?? 0)}where ${axisName(doc, l.a, l.axis)} meets ${axisName(doc, l.b, l.axis)}`;
    case 'projection': return `foot of the perpendicular from ${n(l.point)} to ${axisName(doc, l.onto, l.axis)}`;
    case 'measure': return l.what === 'value' ? `shows ${l.expr}` : `${l.what} of ${n(l.of)}`;
    case 'segment': return `${l.mode === 'boundary' ? 'connects' : 'from'} ${n(l.a)} ${l.mode === 'boundary' ? 'and' : 'to'} ${n(l.b)}`;
    case 'circle2': return l.mode === 'diameter' ? `circle with diameter ${n(l.a)}–${n(l.b)}` : `circle centered at ${n(l.a)} through ${n(l.b)}`;
    case 'perpendicular': return l.mode === 'foot' ? `from ${n(l.through)} perpendicular to ${axisName(doc, l.line, l.axis)}` : `perpendicular to ${axisName(doc, l.line, l.axis)} through ${n(l.through)}`;
    case 'parallel': return `parallel to ${axisName(doc, l.line, l.axis)} through ${n(l.through)}`;
    case 'polygon': return `polygon through ${l.points.map(n).join(', ')}`;
    case 'angle': return `angle between ${n(l.l1)} and ${n(l.l2)}`;
    case 'graph': return `${l.expr} on ${n(l.axes)}`;
    case 'tangent': return `tangent to ${n(l.graph)} at x = ${l.x}`;
    case 'secant': return `secant of ${n(l.graph)} from x = ${l.x} to x + ${l.dx}`;
    case 'area': return `area under ${n(l.graph)} from ${l.a} to ${l.b}`;
    case 'riemann': return `Riemann rectangles under ${n(l.graph)} from ${l.a} to ${l.b}`;
    case 'brace': return `brace on ${n(l.target)}`;
    case 'highlight': return `highlight on ${n(l.target)}`;
  }
}

const ordinal = (i: number) => (i ? `intersection ${i + 1}: ` : '');

/** An axes source reads as its x- or y-axis. */
function axisName(doc: SceneDoc, id: string, axis: 'x' | 'y' | undefined): string {
  const n = doc.objects.find((x) => x.id === id)?.name ?? '(missing)';
  const o = doc.objects.find((x) => x.id === id);
  return o && geoType(o, doc) === 'axes' ? `the ${axis ?? 'x'}-axis of ${n}` : n;
}

/** Plain number or null (drags only edit literals or a single parameter). */
export function literal(src: string | undefined): number | null {
  if (src === undefined) return null;
  const s = src.trim();
  return /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? parseFloat(s) : null;
}

/** The parameter an expression is exactly (e.g. "t"), if it's a ValueTracker. */
export function soleParam(src: string | undefined, doc: SceneDoc): SceneObject | undefined {
  const s = (src ?? '').trim();
  return /^[A-Za-z_]\w*$/.test(s) ? doc.objects.find((o) => o.name === s && o.ctor === 'ValueTracker') : undefined;
}

const MEET_TYPES: GeoType[] = ['line', 'circle', 'graph', 'axes', 'numberline'];
const STRAIGHT_TYPES: GeoType[] = ['line', 'axes', 'numberline'];

/** Source fields of each link kind: [field, label, accepted types (null = any), required]. Mirrors construct.SOURCES. */
export const SOURCE_FIELDS: Record<Link['kind'], [string, string, GeoType[] | null, boolean][]> = {
  attach: [['to', 'attached to', null, true]],
  midpoint: [['a', 'of', ['point', 'line'], true], ['b', 'and', ['point'], false]],
  on_graph: [['graph', 'graph', ['graph'], true]],
  on_circle: [['circle', 'circle', ['circle'], true]],
  coords: [['axes', 'axes', ['axes', 'numberline'], true]],
  intersection: [['a', 'of', MEET_TYPES, true], ['b', 'and', MEET_TYPES, true]],
  projection: [['point', 'from', null, true], ['onto', 'onto', STRAIGHT_TYPES, true]],
  measure: [['of', 'of', null, false]],
  segment: [['a', 'from', null, true], ['b', 'to', null, true]],
  circle2: [['a', 'center / end', null, true], ['b', 'through / end', null, true]],
  perpendicular: [['line', 'to', STRAIGHT_TYPES, true], ['through', 'through', null, true]],
  parallel: [['line', 'to', STRAIGHT_TYPES, true], ['through', 'through', null, true]],
  polygon: [],
  angle: [['l1', 'line 1', ['line'], true], ['l2', 'line 2', ['line'], true]],
  graph: [['axes', 'axes', ['axes'], true]],
  tangent: [['graph', 'graph', ['graph'], true]],
  secant: [['graph', 'graph', ['graph'], true]],
  area: [['graph', 'graph', ['graph'], true], ['bounded', 'down to graph', ['graph'], false]],
  riemann: [['graph', 'graph', ['graph'], true], ['bounded', 'down to graph', ['graph'], false]],
  brace: [['target', 'on', null, true]],
  highlight: [['target', 'on', null, true]],
};

export const EXPR_LABELS: Record<string, string> = {
  x: 'x', y: 'y', angle: 'angle (rad)', expr: 'value', length: 'length', dx: 'dx', a: 'from x', b: 'to x', radius: 'radius',
};

/** Constructor arguments a link supplies itself (hidden from the argument editor). */
export const CONTROLLED_ARGS: Partial<Record<Link['kind'], string[]>> = {
  segment: ['start', 'end', '*'], circle2: ['radius', 'arc_center'], polygon: ['*'], angle: ['line1', 'line2', 'radius', 'other_angle', 'quadrant'],
  graph: ['function', 'x_range', 'discontinuities', 'dt'], tangent: ['start', 'end', '*'], secant: ['start', 'end', '*'],
  area: ['graph', 'x_range', 'bounded_graph'], riemann: ['graph', 'x_range', 'dx', 'input_sample_type', 'bounded_graph'],
  brace: ['mobject', 'direction'], highlight: ['mobject', '*'], perpendicular: ['start', 'end', '*'], parallel: ['start', 'end', '*'],
};
