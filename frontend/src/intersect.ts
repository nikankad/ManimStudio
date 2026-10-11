// Intersections on the editor side: where objects meet right now, in the order mathengine's
// Geometry.intersections uses, so an `intersection` link's `which` picks the same point the scene does.
// Lines are extended both ways (like in the scene); graphs are their sampled outline, so this is
// for snapping and counting, while the scene computes the exact points.

import { geoType, graphAxes } from './construct';
import type { ObjInfo, Pt, SceneDoc } from './types';

type AxesInfo = NonNullable<ObjInfo['axes']>;

export type Meet =
  | { kind: 'line'; a: Pt; b: Pt } // a..b is the drawn part
  | { kind: 'circle'; c: Pt; r: number }
  | { kind: 'graph'; path: Pt[]; axes: AxesInfo };

/** Object types an intersection accepts (mirrors construct.MEETS). */
export const MEETS = new Set(['line', 'circle', 'graph', 'axes', 'numberline']);
/** Object types that act as a straight line (mirrors construct.STRAIGHT); axes mean their x- or y-axis. */
export const STRAIGHT = new Set(['line', 'axes', 'numberline']);

const toAxes = (a: AxesInfo, p: Pt): Pt => {
  const dx = p[0] - a.origin[0], dy = p[1] - a.origin[1];
  const det = a.ux[0] * a.uy[1] - a.ux[1] * a.uy[0];
  if (Math.abs(det) < 1e-12) {
    const l2 = a.ux[0] ** 2 + a.ux[1] ** 2 || 1;
    return [(dx * a.ux[0] + dy * a.ux[1]) / l2, 0];
  }
  return [(dx * a.uy[1] - dy * a.uy[0]) / det, (a.ux[0] * dy - a.ux[1] * dx) / det];
};
const fromAxes = (a: AxesInfo, c: Pt): Pt => [a.origin[0] + c[0] * a.ux[0] + c[1] * a.uy[0], a.origin[1] + c[0] * a.ux[1] + c[1] * a.uy[1]];
const cross = (u: Pt, v: Pt) => u[0] * v[1] - u[1] * v[0];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];

/** An object as intersection data, from the current frame. */
export function meetShape(id: string, axis: 'x' | 'y' | undefined, doc: SceneDoc, infos: ObjInfo[]): Meet | null {
  const o = doc.objects.find((x) => x.id === id);
  const info = infos.find((x) => x.id === id);
  if (!o || !info) return null;
  const t = geoType(o, doc);
  if (t === 'axes' && info.axes) {
    const a = info.axes;
    return axis === 'y'
      ? { kind: 'line', a: fromAxes(a, [0, a.y_range[0]]), b: fromAxes(a, [0, a.y_range[1]]) }
      : { kind: 'line', a: fromAxes(a, [a.x_range[0], 0]), b: fromAxes(a, [a.x_range[1], 0]) };
  }
  if ((t === 'line' || t === 'numberline') && info.geom?.kind === 'line') return { kind: 'line', a: info.geom.start, b: info.geom.end };
  if (t === 'circle' && info.geom?.kind === 'circle') return { kind: 'circle', c: info.geom.center, r: info.geom.radius };
  if (t === 'graph' && info.path && info.path.length > 1) {
    const ax = graphAxes(o, doc);
    const axes = ax && infos.find((x) => x.id === ax.id)?.axes;
    if (axes) return { kind: 'graph', path: info.path, axes };
  }
  return null;
}

/** Every point where a and b meet, ordered like the scene's Geometry.intersections. */
export function intersections(a: Meet, b: Meet): Pt[] {
  if (a.kind === 'graph' || b.kind === 'graph') {
    const [g, other] = a.kind === 'graph' ? [a, b] : [b as Extract<Meet, { kind: 'graph' }>, a];
    return graphHits(g, other);
  }
  if (a.kind === 'line' && b.kind === 'line') return lineLine(a, b);
  if (a.kind === 'circle' && b.kind === 'circle') return circleCircle(a, b);
  return a.kind === 'line' ? lineCircle(a, b as Extract<Meet, { kind: 'circle' }>) : lineCircle(b as Extract<Meet, { kind: 'line' }>, a);
}

function lineLine(l: Extract<Meet, { kind: 'line' }>, m: Extract<Meet, { kind: 'line' }>): Pt[] {
  const d = sub(l.b, l.a), e = sub(m.b, m.a);
  const den = cross(d, e);
  if (Math.abs(den) < 1e-12 * Math.hypot(...d) * Math.hypot(...e) || !den) return [];
  const t = cross(sub(m.a, l.a), e) / den;
  return [[l.a[0] + d[0] * t, l.a[1] + d[1] * t]];
}

function lineCircle(l: Extract<Meet, { kind: 'line' }>, c: Extract<Meet, { kind: 'circle' }>): Pt[] {
  const d = sub(l.b, l.a), f = sub(l.a, c.c);
  const aa = d[0] * d[0] + d[1] * d[1];
  if (aa < 1e-18) return [];
  const bb = 2 * (f[0] * d[0] + f[1] * d[1]), cc = f[0] * f[0] + f[1] * f[1] - c.r * c.r;
  const disc = bb * bb - 4 * aa * cc, eps = 1e-12 * Math.max(1, bb * bb);
  const at = (t: number): Pt => [l.a[0] + d[0] * t, l.a[1] + d[1] * t];
  if (disc < -eps) return [];
  if (disc <= eps) return [at(-bb / (2 * aa))];
  const s = Math.sqrt(disc);
  return [at((-bb - s) / (2 * aa)), at((-bb + s) / (2 * aa))];
}

function circleCircle(a: Extract<Meet, { kind: 'circle' }>, b: Extract<Meet, { kind: 'circle' }>): Pt[] {
  const v = sub(b.c, a.c), d = Math.hypot(...v);
  if (d < 1e-12 || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
  const u: Pt = [v[0] / d, v[1] / d], x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(a.r * a.r - x * x, 0));
  const mid: Pt = [a.c[0] + u[0] * x, a.c[1] + u[1] * x];
  if (h < 1e-9) return [mid];
  return [[mid[0] - u[1] * h, mid[1] + u[0] * h], [mid[0] + u[1] * h, mid[1] - u[0] * h]];
}

/** Segments of a sampled graph, without the jumps between its pieces (around discontinuities). */
function graphSegments(path: Pt[]): [Pt, Pt][] {
  const segs: [Pt, Pt][] = [];
  for (let i = 0; i + 1 < path.length; i++) segs.push([path[i], path[i + 1]]);
  const lens = segs.map(([p, q]) => Math.hypot(q[0] - p[0], q[1] - p[1])).sort((x, y) => x - y);
  const limit = Math.max(1, 8 * (lens[Math.floor(lens.length / 2)] ?? 0));
  return segs.filter(([p, q]) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= limit);
}

function graphHits(g: Extract<Meet, { kind: 'graph' }>, other: Meet): Pt[] {
  const segs = graphSegments(g.path);
  const hits: Pt[] = [];
  const along = (p: Pt, q: Pt, vp: number, vq: number) => {
    if (vp === 0) return hits.push(p);
    if (vp * vq < 0) hits.push([p[0] + (q[0] - p[0]) * (vp / (vp - vq)), p[1] + (q[1] - p[1]) * (vp / (vp - vq))]);
  };
  if (other.kind === 'line') {
    const d = sub(other.b, other.a);
    const h = (p: Pt) => cross(d, sub(p, other.a));
    for (const [p, q] of segs) along(p, q, h(p), h(q));
  } else if (other.kind === 'circle') {
    const h = (p: Pt) => Math.hypot(p[0] - other.c[0], p[1] - other.c[1]) - other.r;
    for (const [p, q] of segs) along(p, q, h(p), h(q));
  } else {
    for (const [p, q] of segs)
      for (const [r, s] of graphSegments(other.path)) {
        const d = sub(q, p), e = sub(s, r), den = cross(d, e);
        if (!den) continue;
        const t = cross(sub(r, p), e) / den, u = cross(sub(r, p), d) / den;
        if (t >= 0 && t < 1 && u >= 0 && u <= 1) hits.push([p[0] + d[0] * t, p[1] + d[1] * t]);
      }
  }
  const xs = hits.map((p) => ({ p, x: toAxes(g.axes, p)[0] })).sort((a, b) => a.x - b.x);
  const out: { p: Pt; x: number }[] = [];
  for (const h of xs) if (!out.length || h.x - out[out.length - 1].x > 1e-6) out.push(h);
  return out.map((h) => h.p);
}

/** Is p on the drawn part of a shape (lines are drawn only between their ends)? */
function drawn(m: Meet, p: Pt): boolean {
  if (m.kind !== 'line') return true;
  const d = sub(m.b, m.a), l2 = d[0] * d[0] + d[1] * d[1];
  if (!l2) return false;
  const t = ((p[0] - m.a[0]) * d[0] + (p[1] - m.a[1]) * d[1]) / l2;
  return t > -0.01 && t < 1.01;
}

/** Where two objects meet now, ordered like the scene (index = an intersection link's `which`). */
export function meetPoints(doc: SceneDoc, infos: ObjInfo[], a: string, b: string, axis?: 'x' | 'y'): Pt[] {
  const A = meetShape(a, axis, doc, infos), B = meetShape(b, axis, doc, infos);
  return A && B ? intersections(A, B) : [];
}

/** Number of points where two objects meet now. */
export const countMeets = (doc: SceneDoc, infos: ObjInfo[], a: string, b: string, axis?: 'x' | 'y') => meetPoints(doc, infos, a, b, axis).length;

export interface MeetSnap {
  pt: Pt;
  a: string;
  b: string;
  which: number;
  axis?: 'x' | 'y';
}

const cache = new WeakMap<ObjInfo[], { doc: SceneDoc; snaps: MeetSnap[] }>();

/** Visible crossings of every pair of lines, circles, graphs and axes, for the point tool. */
export function meetSnaps(doc: SceneDoc, infos: ObjInfo[]): MeetSnap[] {
  const hit = cache.get(infos);
  if (hit && hit.doc === doc) return hit.snaps;
  const items: { id: string; axis?: 'x' | 'y'; m: Meet; axes: boolean }[] = [];
  for (const info of infos) {
    if (!info.visible) continue;
    const o = doc.objects.find((x) => x.id === info.id);
    const t = o ? geoType(o, doc) : 'other';
    if (!MEETS.has(t)) continue;
    for (const axis of t === 'axes' ? (['x', 'y'] as const) : [undefined]) {
      const m = meetShape(info.id, axis, doc, infos);
      if (m) items.push({ id: info.id, axis, m, axes: t === 'axes' || t === 'numberline' });
    }
  }
  const snaps: MeetSnap[] = [];
  for (let i = 0; i < items.length && items.length <= 80; i++)
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (A.id === B.id || (A.axes && B.axes)) continue;
      const axis = A.axis ?? B.axis;
      intersections(A.m, B.m).forEach((pt, which) => {
        if (drawn(A.m, pt) && drawn(B.m, pt)) snaps.push({ pt, a: A.id, b: B.id, which, ...(axis ? { axis } : {}) });
      });
    }
  cache.set(infos, { doc, snaps });
  return snaps;
}
