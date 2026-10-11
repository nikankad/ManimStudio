// Context-sensitive "Connect" and annotation actions for the current selection.
//
// Every action builds a linked object (see construct.ts) from compatible selected objects, so the
// result stays attached to its sources while editing, animating and in the exported code.

import { geoType, graphAxes, isCoupled, type GeoType } from './construct';
import { meetPoints, MEETS, STRAIGHT } from './intersect';
import { coupleTo, createLinked, getState, selectedObjectIds, selectObjects, setState, toast, updateDoc, type LinkedSpec } from './store';
import type { Link, ObjInfo, Pt, SceneDoc, SceneObject } from './types';

export interface Action {
  id: string;
  label: string;
  group: 'Connect' | 'Couple' | 'Annotate' | 'Measure' | 'Terms';
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
  }

  if (objs.length >= 3 && all('point'))
    add({ group: 'Connect', label: 'Polygon', hint: 'Polygon through the points, in selection order.', run: make({ ctor: 'Polygon', name: 'polygon', link: { kind: 'polygon', points: objs.map((o) => o.id) } }) });

  // Couple selected objects to each other: each one that isn't coupled yet, to the others.
  if (objs.length >= 2 && objs.length <= 6)
    for (const dep of objs) if (!isCoupled(dep)) for (const c of couplings(dep, objs.filter((o) => o !== dep))) out.push(c);

  return out;
}

const round = (v: number, step = 1000) => Math.round(v * step) / step;

/** Coordinates of a scene point in an axes' units (null when the axes aren't known). */
function toCoords(axesId: string, p: Pt): Pt | null {
  const a = info(axesId)?.axes;
  if (!a) return null;
  const det = a.ux[0] * a.uy[1] - a.ux[1] * a.uy[0];
  if (Math.abs(det) < 1e-12) return null;
  const dx = p[0] - a.origin[0], dy = p[1] - a.origin[1];
  return [(dx * a.uy[1] - dy * a.uy[0]) / det, (a.ux[0] * dy - a.ux[1] * dx) / det];
}

const SHAPE_ARGS = ['*', 'side_length', 'width', 'height', 'n', 'radius', 'start_angle', 'corner_radius', 'vertex_groups'];

/**
 * Ways to couple an existing object (`dep`) to existing `srcs`, built from where things are now, so the
 * object stays put (or moves only as far as the relationship requires, e.g. onto a circle).
 */
export function couplings(dep: SceneObject, srcs: SceneObject[]): Action[] {
  const s = getState();
  const doc = s.doc;
  const dt = geoType(dep, doc);
  const st = srcs.map((o) => geoType(o, doc));
  const at = info(dep.id)?.center ?? dep.pos ?? null;
  const out: Action[] = [];
  const add = (label: string, hint: string, link: Link, patch?: (o: SceneObject) => void) =>
    out.push({ id: `Couple:${dep.id}:${label}`, group: 'Couple', label, hint, run: () => coupleTo(dep.id, link, patch) });
  const keepPos = (o: SceneObject) => void (o.pos = null);
  if (dt === 'param' || dt === 'axes' || st.includes('param')) return out;

  if (srcs.length === 1) {
    const [src] = srcs;
    const t = st[0];
    const si = info(src.id);
    if (dt === 'point' && t === 'circle' && si?.geom?.kind === 'circle' && at) {
      const c = si.geom.center;
      add(`Put ${dep.name} on ${src.name}`, `${dep.name} stays on the circle at its current angle; drag it along the circle.`,
        { kind: 'on_circle', circle: src.id, angle: String(round(Math.atan2(at[1] - c[1], at[0] - c[0]))) }, keepPos);
    }
    if (dt === 'point' && t === 'graph' && at) {
      const ax = graphAxes(src, doc);
      const xy = ax ? toCoords(ax.id, at) : null;
      if (xy) add(`Put ${dep.name} on ${src.name}`, `${dep.name} moves onto the curve at its current x and stays on it.`,
        { kind: 'on_graph', graph: src.id, x: String(round(xy[0], 100)) }, keepPos);
    }
    if (dt === 'point' && t === 'axes' && at) {
      const xy = toCoords(src.id, at);
      if (xy) add(`Pin ${dep.name} to ${src.name}`, `${dep.name} keeps its coordinates (${round(xy[0], 100)}, ${round(xy[1], 100)}) when the axes move or scale.`,
        { kind: 'coords', axes: src.id, x: String(round(xy[0], 100)), y: String(round(xy[1], 100)) }, keepPos);
    }
    if (dt === 'point' && t === 'line')
      add(`Make ${dep.name} the midpoint of ${src.name}`, `${dep.name} stays at the middle of the segment.`, { kind: 'midpoint', a: src.id }, keepPos);
    const sc = si?.center;
    if (sc && at) {
      const offset: [number, number] = [round(at[0] - sc[0], 100), round(at[1] - sc[1], 100)];
      add(`Attach ${dep.name} to ${src.name}`, `${dep.name} moves with ${src.name}, keeping its current offset.`, { kind: 'attach', to: src.id, offset }, keepPos);
    }
  }

  if (srcs.length === 2) {
    const [a, b] = srcs;
    if (dt === 'point' && st[0] === 'point' && st[1] === 'point')
      add(`Make ${dep.name} the midpoint of ${a.name} and ${b.name}`, `${dep.name} stays halfway between them.`, { kind: 'midpoint', a: a.id, b: b.id }, keepPos);
    if (dt === 'point' && MEETS.has(st[0]) && MEETS.has(st[1]) && !(STRAIGHT.has(st[0]) && st[0] !== 'line' && STRAIGHT.has(st[1]) && st[1] !== 'line')) {
      const pts = meetPoints(doc, s.frame?.objects ?? [], a.id, b.id);
      let which = 0;
      if (at && pts.length) pts.forEach((p, i) => { if (Math.hypot(p[0] - at[0], p[1] - at[1]) < Math.hypot(pts[which][0] - at[0], pts[which][1] - at[1])) which = i; });
      add(`Put ${dep.name} where ${a.name} and ${b.name} meet`, pts.length ? `${dep.name} moves to the nearest crossing and follows it.` : 'They don’t meet now; it moves there once they do.',
        { kind: 'intersection', a: a.id, b: b.id, ...(which ? { which } : {}) }, (o) => void (o.pos = pts[which] ? [round(pts[which][0]), round(pts[which][1])] : o.pos));
    }
    for (const [p, l] of [[a, b], [b, a]] as const) {
      const pt = geoType(p, doc), lt = geoType(l, doc);
      if (dt === 'point' && pt === 'point' && STRAIGHT.has(lt) && lt !== 'axes')
        add(`Make ${dep.name} the foot of ${p.name} on ${l.name}`, `${dep.name} stays at the point of ${l.name} closest to ${p.name}.`, { kind: 'projection', point: p.id, onto: l.id }, keepPos);
      if (dt === 'line' && pt === 'point' && lt === 'line') {
        add(`Make ${dep.name} parallel to ${l.name} through ${p.name}`, 'Its direction follows the line; it passes through the point.', { kind: 'parallel', line: l.id, through: p.id });
        add(`Make ${dep.name} perpendicular to ${l.name} through ${p.name}`, 'At a right angle to the line, through the point.', { kind: 'perpendicular', line: l.id, through: p.id, length: '4' });
      }
    }
    if (dt === 'line' && st[0] === 'point' && st[1] === 'point')
      add(`Make ${dep.name} connect ${a.name} and ${b.name}`, `Its ends follow ${a.name} and ${b.name}.`, { kind: 'segment', a: a.id, b: b.id });
    if (dt === 'circle' && st[0] === 'point' && st[1] === 'point') {
      add(`Center ${dep.name} on ${a.name} through ${b.name}`, 'Center and radius follow the two points.', { kind: 'circle2', a: a.id, b: b.id });
      add(`Make ${a.name}${b.name} a diameter of ${dep.name}`, 'The circle follows both ends of its diameter.', { kind: 'circle2', a: a.id, b: b.id, mode: 'diameter' });
    }
  }

  if (srcs.length >= 3 && dt === 'polygon' && st.every((t) => t === 'point'))
    add(`Make ${dep.name} go through ${srcs.map((o) => o.name).join(', ')}`, 'Its vertices follow the points, in selection order.',
      { kind: 'polygon', points: srcs.map((o) => o.id) }, (o) => {
        o.ctor = 'Polygon';
        for (const k of SHAPE_ARGS) delete o.args[k];
      });
  return out;
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
