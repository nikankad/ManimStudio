// Context-sensitive "Connect" and annotation actions for the current selection.
//
// Every action builds a linked object (see construct.ts) from compatible selected objects, so the
// result stays attached to its sources while editing, animating and in the exported code.

import { geoType, graphAxes, sortByDependencies, type GeoType } from './construct';
import { meetPoints, MEETS, STRAIGHT } from './intersect';
import { createLinked, getState, selectedObjectIds, selectObjects, setState, toast, updateDoc, type LinkedSpec } from './store';
import type { Link, ObjInfo, SceneDoc, SceneObject } from './types';

export interface Action {
  id: string;
  label: string;
  group: 'Connect' | 'Annotate' | 'Measure' | 'Terms';
  hint: string;
  run: () => void;
}

const MEASURE_ARGS = { '*': '0', num_decimal_places: '2', font_size: '32' };

const labelCtor = () => (getState().catalog?.latex === false ? 'Text' : 'MathTex');
const labelArgs = (text: string) => (labelCtor() === 'Text' ? { '*': JSON.stringify(text) } : { '*': `r"${text}"` });
const shortName = (o: SceneObject) => o.name.replace(/^(dot|point)_?/, '').replace(/_/g, '') || o.name;

function info(id: string): ObjInfo | undefined {
  return getState().frame?.objects.find((o) => o.id === id);
}

function graphDomain(doc: SceneDoc, g: SceneObject): [number, number] {
  if (g.link?.kind === 'graph' && g.link.x_min !== undefined && g.link.x_max !== undefined) return [g.link.x_min, g.link.x_max];
  const ax = graphAxes(g, doc);
  const r = ax ? info(ax.id)?.axes?.x_range : undefined;
  return r ?? [-3, 3];
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);
const axesName = (doc: SceneDoc, g: SceneObject) => graphAxes(g, doc)?.name ?? 'axes';

/** An x where the drawn graph is inside its axes' visible y range, right of center if possible. */
function visibleX(doc: SceneDoc, g: SceneObject): number | null {
  const path = info(g.id)?.path;
  const ax = graphAxes(g, doc);
  const a = ax ? info(ax.id)?.axes : undefined;
  if (!path?.length || !a) return null;
  const det = a.ux[0] * a.uy[1] - a.ux[1] * a.uy[0];
  if (Math.abs(det) < 1e-12) return null;
  const coords = path.map(([px, py]) => {
    const dx = px - a.origin[0], dy = py - a.origin[1];
    return [(dx * a.uy[1] - dy * a.uy[0]) / det, (a.ux[0] * dy - a.ux[1] * dx) / det];
  });
  const [y0, y1] = a.y_range, [x0, x1] = a.x_range;
  const inside = coords.filter(([x, y]) => y > y0 + (y1 - y0) * 0.1 && y < y1 - (y1 - y0) * 0.1 && x > x0 && x < x1);
  if (!inside.length) return null;
  const target = x0 + (x1 - x0) * 0.6;
  inside.sort((p, q) => Math.abs(p[0] - target) - Math.abs(q[0] - target));
  return Math.round(inside[0][0] * 4) / 4;
}

function make(spec: LinkedSpec) {
  return () => void createLinked(spec);
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * A point at each place a and b meet now (lines extended both ways), each linked to its
 * intersection, so they follow the objects. Nothing meets now: one point, which appears once they do.
 */
function intersect(a: SceneObject, b: SceneObject, axis?: 'x' | 'y', name = 'X') {
  const s = getState();
  const pts = meetPoints(s.doc, s.frame?.objects ?? [], a.id, b.id, axis);
  if (!pts.length) toast('They don’t meet right now; the point will move there once they do (lines count as extended)');
  const ids: string[] = [];
  (pts.length ? pts : [null]).forEach((pt, which) => {
    const link: Link = { kind: 'intersection', a: a.id, b: b.id, ...(which ? { which } : {}), ...(axis ? { axis } : {}) };
    const id = createLinked({ ctor: 'Dot', name, pos: pt ? [r3(pt[0]), r3(pt[1])] : null, link }, { select: false });
    if (id) ids.push(id);
  });
  if (ids.length) selectObjects(ids);
}

/** The foot of the perpendicular from a point to an axis, and a dashed segment to it (both follow the point). */
function dropTo(pt: SceneObject, axes: SceneObject, axis: 'x' | 'y') {
  const foot = createLinked({ ctor: 'Dot', name: `${shortName(pt)}_${axis}`, args: { radius: '0.05' }, link: { kind: 'projection', point: pt.id, onto: axes.id, ...(axis === 'y' ? { axis } : {}) } }, { select: false });
  if (!foot) return;
  createLinked({ ctor: 'DashedLine', name: `drop_${shortName(pt)}_${axis}`, args: { stroke_opacity: '0.7' }, link: { kind: 'segment', a: pt.id, b: foot } });
}

/** Actions offered for the given objects (and selected equation terms). */
export function actionsFor(ids: string[], terms: string[] = []): Action[] {
  const doc = getState().doc;
  const objs = ids.map((id) => doc.objects.find((o) => o.id === id)).filter(Boolean) as SceneObject[];
  const types = objs.map((o) => geoType(o, doc));
  const out: Action[] = [];
  const add = (a: Omit<Action, 'id'>) => out.push({ ...a, id: `${a.group}:${a.label}` });
  const all = (t: GeoType) => types.length > 0 && types.every((x) => x === t);

  if (objs.length === 1) {
    const [o] = objs;
    const t = types[0];
    if (t === 'line') {
      add({ group: 'Measure', label: 'Show length', hint: 'A number that tracks this segment’s length (computed by manim).', run: make({ ctor: 'DecimalNumber', name: `${o.name}_length`, args: MEASURE_ARGS, link: { kind: 'measure', what: 'length', of: o.id, offset: [0, 0.4] } }) });
      add({ group: 'Connect', label: 'Midpoint', hint: 'A point that stays at the middle of this segment.', run: make({ ctor: 'Dot', name: `${o.name}_mid`, link: { kind: 'midpoint', a: o.id } }) });
      add({ group: 'Connect', label: 'Perpendicular bisector', hint: 'The midpoint and the line through it at a right angle; both follow the segment.', run: () => {
        const mid = createLinked({ ctor: 'Dot', name: `${o.name}_mid`, link: { kind: 'midpoint', a: o.id } }, { select: false });
        if (mid) createLinked({ ctor: 'Line', name: `${o.name}_bisector`, link: { kind: 'perpendicular', line: o.id, through: mid, length: '4' } });
      } });
      if (o.link?.kind === 'tangent' || o.link?.kind === 'secant')
        add({ group: 'Measure', label: 'Show slope', hint: 'The slope in the graph’s units, computed numerically.', run: make({ ctor: 'DecimalNumber', name: `${o.name}_slope`, args: MEASURE_ARGS, link: { kind: 'measure', what: 'slope', of: o.id, offset: [0.8, 0.4] } }) });
    }
    if (t === 'circle')
      add({ group: 'Connect', label: 'Point on circle', hint: 'A point constrained to the circle; drag it to change its angle.', run: make({ ctor: 'Dot', name: 'P', link: { kind: 'on_circle', circle: o.id, angle: '0' } }) });
    if (t === 'graph') {
      const [lo, hi] = graphDomain(doc, o);
      const mid = fmt(visibleX(doc, o) ?? (lo + hi) / 2 + (hi - lo) / 6);
      const a = fmt(lo + (hi - lo) * 0.3), b = fmt(lo + (hi - lo) * 0.7);
      add({ group: 'Connect', label: 'Point on curve', hint: 'A point constrained to the graph; drag it along the curve.', run: make({ ctor: 'Dot', name: 'P', link: { kind: 'on_graph', graph: o.id, x: mid } }) });
      const ax = graphAxes(o, doc);
      if (ax) {
        add({ group: 'Connect', label: 'Mark roots', hint: 'A point where the graph crosses the x-axis, for each crossing now; they follow the graph.', run: () => intersect(o, ax, undefined, 'root') });
        add({ group: 'Connect', label: 'y-intercept', hint: 'The point where the graph crosses the y-axis.', run: () => intersect(o, ax, 'y', 'y_int') });
      }
      add({ group: 'Annotate', label: 'Tangent', hint: 'Tangent line at a point of the graph (updates with it).', run: make({ ctor: 'Line', name: 'tangent', args: { color: 'YELLOW' }, link: { kind: 'tangent', graph: o.id, x: mid, length: '3' } }) });
      add({ group: 'Annotate', label: 'Secant', hint: 'Line through two points of the graph, at x and x + dx.', run: make({ ctor: 'Line', name: 'secant', args: { color: 'GREEN' }, link: { kind: 'secant', graph: o.id, x: a, dx: '1', length: '1' } }) });
      add({ group: 'Annotate', label: 'Shade interval', hint: 'Shaded region under the graph between two bounds. Visual only: no value is computed.', run: make({ ctor: `${axesName(doc, o)}.get_area`, name: 'area', args: { opacity: '0.4' }, link: { kind: 'area', graph: o.id, a, b }, intro: 'FadeIn' }) });
      add({ group: 'Annotate', label: 'Riemann rectangles', hint: 'Rectangles approximating the area between two bounds.', run: make({ ctor: `${axesName(doc, o)}.get_riemann_rectangles`, name: 'rects', link: { kind: 'riemann', graph: o.id, a, b, dx: '0.25', sample: 'left' } }) });
    }
    if (t === 'axes') {
      add({ group: 'Connect', label: 'Point at coordinates', hint: 'A point placed in this coordinate system’s units.', run: make({ ctor: 'Dot', name: 'P', link: { kind: 'coords', axes: o.id, x: '1', y: '1' } }) });
      add({ group: 'Connect', label: 'Graph a function…', hint: 'Open the graph builder for these axes.', run: () => setState({ panel: 'graph', panelData: { axes: o.id } }) });
    }
    if (t === 'numberline')
      add({ group: 'Connect', label: 'Point on number line', hint: 'A point at a value on this number line.', run: make({ ctor: 'Dot', name: 'P', link: { kind: 'coords', axes: o.id, x: '1', y: '0' } }) });
    if (t === 'angle')
      add({ group: 'Measure', label: 'Show angle value', hint: 'The angle in degrees, computed by manim.', run: make({ ctor: 'DecimalNumber', name: `${o.name}_value`, args: { ...MEASURE_ARGS, unit: 'r"^\\circ"' }, link: { kind: 'measure', what: 'angle', of: o.id, offset: [0.6, 0.3], degrees: true } }) });
    if (t === 'area' || t === 'riemann')
      add({ group: 'Measure', label: 'Show integral (numerical)', hint: 'The integral over the interval, approximated numerically (trapezoid rule). The shading itself is not a measurement.', run: make({ ctor: 'DecimalNumber', name: 'integral', args: MEASURE_ARGS, link: { kind: 'measure', what: 'integral', of: o.id, offset: [0, 0] } }) });
    if (t === 'param')
      add({ group: 'Measure', label: 'Show value', hint: 'A number label that shows this parameter.', run: make({ ctor: 'DecimalNumber', name: `${o.name}_label`, args: MEASURE_ARGS, link: { kind: 'measure', what: 'value', expr: o.name }, pos: [0, 3] }) });
    if (t === 'equation') {
      {
        // Without selected terms these apply to the whole equation ("Split into terms" is in the Equation section).
        const sel = o.eq?.parts?.length ? terms : [];
        const on = sel.length ? `${sel.length} term${sel.length > 1 ? 's' : ''}` : 'the equation';
        const withParts = (l: Link): Link => (sel.length ? ({ ...l, parts: sel } as Link) : l);
        add({ group: 'Terms', label: 'Brace', hint: `Brace under ${on} that follows it.`, run: make({ ctor: 'Brace', name: 'brace', link: withParts({ kind: 'brace', target: o.id, direction: 'DOWN' }) }) });
        add({ group: 'Terms', label: 'Label', hint: `Label attached to ${on}.`, run: make({ ctor: labelCtor(), name: 'label', args: labelArgs('\\text{label}'), link: withParts({ kind: 'attach', to: o.id, offset: [0, -0.8] }) }) });
        add({ group: 'Terms', label: 'Highlight', hint: `Box around ${on} that follows it.`, run: make({ ctor: 'SurroundingRectangle', name: 'highlight', link: withParts({ kind: 'highlight', target: o.id, style: 'box' }) }) });
        if (sel.length)
          add({ group: 'Terms', label: 'Color', hint: 'Color the selected terms (set per term, so it survives edits).', run: () => colorTerms(o.id, sel, 'YELLOW') });
      }
    }
    if (t !== 'param' && t !== 'axes' && t !== 'text' && t !== 'equation' && t !== 'annotation')
      add({ group: 'Annotate', label: 'Attach label', hint: 'A label that moves with this object; drag it to change its offset.', run: make({ ctor: labelCtor(), name: `label_${shortName(o)}`, args: labelArgs(t === 'point' ? shortName(o) : '\\text{label}'), link: { kind: 'attach', to: o.id, offset: [0.35, 0.35] } }) });
  }

  if (objs.length === 2) {
    const [a, b] = objs;
    if (all('point')) {
      add({ group: 'Connect', label: 'Segment', hint: `Line from ${a.name} to ${b.name}; it follows both points.`, run: make({ ctor: 'Line', name: `seg_${shortName(a)}${shortName(b)}`, link: { kind: 'segment', a: a.id, b: b.id } }) });
      add({ group: 'Connect', label: 'Arrow', hint: `Arrow from ${a.name} to ${b.name}.`, run: make({ ctor: 'Arrow', name: `arrow_${shortName(a)}${shortName(b)}`, args: { buff: '0' }, link: { kind: 'segment', a: a.id, b: b.id } }) });
      add({ group: 'Connect', label: 'Midpoint', hint: 'Point halfway between them.', run: make({ ctor: 'Dot', name: `mid_${shortName(a)}${shortName(b)}`, link: { kind: 'midpoint', a: a.id, b: b.id } }) });
      add({ group: 'Connect', label: `Circle (center ${a.name})`, hint: `Circle centered at ${a.name} through ${b.name}.`, run: make({ ctor: 'Circle', name: 'circle', link: { kind: 'circle2', a: a.id, b: b.id } }) });
      add({ group: 'Connect', label: 'Circle on diameter', hint: `Circle with diameter ${a.name}${b.name}.`, run: make({ ctor: 'Circle', name: 'circle', link: { kind: 'circle2', a: a.id, b: b.id, mode: 'diameter' } }) });
    } else if (all('line')) {
      add({ group: 'Annotate', label: 'Mark angle', hint: 'Angle marker between the two lines (they must meet or cross).', run: make({ ctor: 'Angle', name: 'angle', link: { kind: 'angle', l1: a.id, l2: b.id, radius: '0.5' } }) });
    } else if (all('graph')) {
      add({ group: 'Annotate', label: 'Shade between', hint: 'Region between the two graphs over an interval (visual only).', run: make({ ctor: `${axesName(getState().doc, a)}.get_area`, name: 'area', args: { opacity: '0.4' }, link: { kind: 'area', graph: a.id, bounded: b.id, a: '-1', b: '1' }, intro: 'FadeIn' }) });
    }
    if (!types.includes('param') && !types.includes('axes') && !all('point'))
      add({ group: 'Connect', label: 'Arrow between', hint: 'Arrow from one shape’s boundary to the other’s; it follows both.', run: make({ ctor: 'Arrow', name: 'connector', link: { kind: 'segment', a: a.id, b: b.id, mode: 'boundary' } }) });
    if (MEETS.has(types[0]) && MEETS.has(types[1]) && !(['axes', 'numberline'].includes(types[0]) && ['axes', 'numberline'].includes(types[1])))
      add({ group: 'Connect', label: 'Intersection', hint: 'A point where they meet (one per crossing). It follows both; lines count as extended.', run: () => intersect(a, b) });
    const pi = types.indexOf('point');
    if (pi >= 0 && STRAIGHT.has(types[1 - pi])) {
      const p = objs[pi], l = objs[1 - pi];
      if (types[1 - pi] === 'axes') {
        add({ group: 'Connect', label: 'Drop to x-axis', hint: `Dashed line from ${p.name} straight down (or up) to the x-axis, with its foot.`, run: () => dropTo(p, l, 'x') });
        add({ group: 'Connect', label: 'Drop to y-axis', hint: `Dashed line from ${p.name} across to the y-axis, with its foot.`, run: () => dropTo(p, l, 'y') });
      } else {
        add({ group: 'Connect', label: 'Perpendicular', hint: `Line through ${p.name} at a right angle to ${l.name} (extended).`, run: make({ ctor: 'Line', name: `perp_${shortName(p)}`, link: { kind: 'perpendicular', line: l.id, through: p.id, length: '4' } }) });
        add({ group: 'Connect', label: 'Parallel', hint: `Line through ${p.name} parallel to ${l.name}.`, run: make({ ctor: 'Line', name: `par_${shortName(p)}`, link: { kind: 'parallel', line: l.id, through: p.id } }) });
        add({ group: 'Connect', label: 'Altitude', hint: `Dashed segment from ${p.name} to ${l.name} at a right angle (the distance to the line).`, run: make({ ctor: 'DashedLine', name: `alt_${shortName(p)}`, link: { kind: 'perpendicular', line: l.id, through: p.id, mode: 'foot' } }) });
        add({ group: 'Connect', label: 'Foot of perpendicular', hint: `The point of ${l.name} (extended) closest to ${p.name}.`, run: make({ ctor: 'Dot', name: `foot_${shortName(p)}`, link: { kind: 'projection', point: p.id, onto: l.id } }) });
      }
    }
    const textIdx = types.findIndex((t) => t === 'text' || t === 'equation');
    if (textIdx >= 0 && types[1 - textIdx] !== 'param') {
      const label = objs[textIdx], target = objs[1 - textIdx];
      add({ group: 'Connect', label: `Attach ${label.name} to ${target.name}`, hint: 'Keep the label where it is now, relative to the object.', run: () => attachExisting(label, target) });
    }
  }

  if (objs.length >= 3 && all('point'))
    add({ group: 'Connect', label: 'Polygon', hint: 'Polygon through the points, in selection order.', run: make({ ctor: 'Polygon', name: 'polygon', link: { kind: 'polygon', points: objs.map((o) => o.id) } }) });

  return out;
}

/** Attach an existing label to another object, keeping its current offset. */
function attachExisting(label: SceneObject, target: SceneObject) {
  const li = info(label.id)?.center, ti = info(target.id)?.center;
  const offset: [number, number] = li && ti ? [Math.round((li[0] - ti[0]) * 100) / 100, Math.round((li[1] - ti[1]) * 100) / 100] : [0.4, 0.4];
  updateDoc((d) => {
    const o = d.objects.find((x) => x.id === label.id)!;
    o.link = { kind: 'attach', to: target.id, offset };
    o.pos = null;
    sortByDependencies(d);
  });
}

export function colorTerms(eqId: string, parts: string[], color: string) {
  updateDoc((d) => {
    const o = d.objects.find((x) => x.id === eqId);
    for (const p of o?.eq?.parts ?? []) if (parts.includes(p.id)) p.color = color || undefined;
  }, `${eqId}:termcolor`);
}

export const currentActions = () => {
  const s = getState();
  const ids = selectedObjectIds();
  return actionsFor(ids, s.selection?.kind === 'object' ? s.selection.terms ?? [] : []);
};
