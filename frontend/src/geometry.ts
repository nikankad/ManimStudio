// Editable geometry of free (unlinked) shapes drawn on the canvas.
//
// A shape is "free" when its defining arguments are plain numbers: Line(start, end), Circle(radius) at
// a position, Rectangle(width, height), Polygon(*vertices), Dot at a position. Its handles edit those
// arguments directly, and whole-object moves/scales/rotations are baked into them so the shape stays
// editable through its defining parameters. Anything written as custom Python falls back to the
// generic transform fields (pos / scale / stretch / rotation).

import { evalNumber, evalVector, fmtNum, splitTop } from './pyparse';
import { standsAlone } from './construct';
import type { Pt, SceneObject } from './types';

export type Shape =
  | { kind: 'point'; center: Pt }
  | { kind: 'line'; start: Pt; end: Pt }
  | { kind: 'circle'; center: Pt; r: number }
  | { kind: 'rect'; center: Pt; w: number; h: number; angle: number; square: boolean }
  | { kind: 'polygon'; vertices: Pt[] };

export const LINE_LIKE = new Set(['Line', 'DashedLine', 'Arrow', 'DoubleArrow']);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const identity = (o: SceneObject) => (o.scale ?? 1) === 1 && (o.stretch ?? [1, 1]).every((v) => v === 1) && !o.rotation;
const pt2 = (src: string | undefined, fallback: Pt | null): Pt | null => {
  if (src === undefined || src.trim() === '') return fallback;
  const v = evalVector(src);
  return v && v.length >= 2 ? [v[0], v[1]] : null;
};
export const fmtPt = (p: Pt) => `np.array([${fmtNum(p[0])}, ${fmtNum(p[1])}, 0])`;

/** Defining geometry of a free shape, or null when it isn't one (linked, custom Python, transformed…). */
export function freeShape(o: SceneObject): Shape | null {
  if (o.link && !standsAlone(o)) return null;
  const c = o.ctor.trim();
  const a = o.args;
  if (c === 'Dot' || c === 'SmallDot') {
    const center = o.pos ?? pt2(a.point, [0, 0]);
    return center ? { kind: 'point', center: [...center] as Pt } : null;
  }
  if (LINE_LIKE.has(c)) {
    if (o.pos || !identity(o)) return null;
    let s = a.start, e = a.end;
    if (a['*'] !== undefined) [s, e] = splitTop(a['*']);
    const start = pt2(s, [-1, 0]), end = pt2(e, [1, 0]);
    return start && end ? { kind: 'line', start, end } : null;
  }
  if (c === 'Circle') {
    if ((o.stretch ?? [1, 1]).some((v) => v !== 1) || a.arc_center) return null;
    const r = a.radius === undefined ? 1 : evalNumber(a.radius);
    return r === null ? null : { kind: 'circle', center: o.pos ?? [0, 0], r: r * (o.scale ?? 1) };
  }
  if (c === 'Rectangle' || c === 'Square') {
    if ((o.scale ?? 1) !== 1 || (o.stretch ?? [1, 1]).some((v) => v !== 1)) return null;
    const square = c === 'Square';
    const w = square ? (a.side_length === undefined ? 2 : evalNumber(a.side_length)) : a.width === undefined ? 4 : evalNumber(a.width);
    const h = square ? w : a.height === undefined ? 2 : evalNumber(a.height);
    return w === null || h === null ? null : { kind: 'rect', center: o.pos ?? [0, 0], w, h, angle: o.rotation ?? 0, square };
  }
  if (c === 'Polygon') {
    if (o.pos || !identity(o) || !a['*']) return null;
    const vs = splitTop(a['*']).map((s) => pt2(s, null));
    return vs.length >= 3 && vs.every(Boolean) ? { kind: 'polygon', vertices: vs as Pt[] } : null;
  }
  return null;
}

/** Write a shape back into the object's defining arguments. */
export function writeShape(o: SceneObject, s: Shape): void {
  const a = o.args;
  switch (s.kind) {
    case 'point':
      delete a.point;
      o.pos = [r3(s.center[0]), r3(s.center[1])];
      return;
    case 'line':
      delete a['*'];
      a.start = fmtPt(s.start);
      a.end = fmtPt(s.end);
      return;
    case 'circle':
      a.radius = fmtNum(Math.max(0.01, s.r));
      o.scale = undefined;
      o.pos = [r3(s.center[0]), r3(s.center[1])];
      return;
    case 'rect':
      if (s.square) a.side_length = fmtNum(Math.max(0.01, s.w));
      else {
        a.width = fmtNum(Math.max(0.01, s.w));
        a.height = fmtNum(Math.max(0.01, s.h));
      }
      o.pos = [r3(s.center[0]), r3(s.center[1])];
      o.rotation = s.angle ? r3(s.angle) : undefined;
      return;
    case 'polygon':
      a['*'] = s.vertices.map(fmtPt).join(', ');
  }
}

export interface Handle {
  id: string; // "start", "end", "r", "v0"…, "c0"… (rect corners)
  pt: Pt;
  title: string;
}

const rot = (p: Pt, deg: number): Pt => {
  const t = (deg * Math.PI) / 180;
  return [p[0] * Math.cos(t) - p[1] * Math.sin(t), p[0] * Math.sin(t) + p[1] * Math.cos(t)];
};
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const CORNERS: Pt[] = [[-1, 1], [1, 1], [1, -1], [-1, -1]];

export function handlesOf(s: Shape): Handle[] {
  switch (s.kind) {
    case 'point': return [];
    case 'line': return [{ id: 'start', pt: s.start, title: 'Start point' }, { id: 'end', pt: s.end, title: 'End point' }];
    case 'circle': return [{ id: 'r', pt: [s.center[0] + s.r, s.center[1]], title: `Radius ${fmtNum(s.r)}` }];
    case 'rect': return CORNERS.map(([sx, sy], i) => ({ id: `c${i}`, pt: add(s.center, rot([(sx * s.w) / 2, (sy * s.h) / 2], s.angle)), title: 'Corner (opposite corner stays)' }));
    case 'polygon': return s.vertices.map((v, i) => ({ id: `v${i}`, pt: v, title: `Vertex ${i + 1} (Alt-click to remove)` }));
  }
}

/** New shape after dragging handle `id` to `p`. */
export function dragHandle(s: Shape, id: string, p: Pt): Shape {
  switch (s.kind) {
    case 'line': return id === 'start' ? { ...s, start: p } : { ...s, end: p };
    case 'circle': return { ...s, r: Math.max(0.01, Math.hypot(p[0] - s.center[0], p[1] - s.center[1])) };
    case 'rect': {
      const i = Number(id.slice(1));
      const opp = add(s.center, rot([(CORNERS[(i + 2) % 4][0] * s.w) / 2, (CORNERS[(i + 2) % 4][1] * s.h) / 2], s.angle));
      const local = rot(sub(p, opp), -s.angle);
      let w = Math.abs(local[0]), h = Math.abs(local[1]);
      if (s.square) w = h = Math.max(w, h);
      const half = rot([Math.sign(local[0] || 1) * (w / 2), Math.sign(local[1] || 1) * (h / 2)], s.angle);
      return { ...s, w, h, center: add(opp, half) };
    }
    case 'polygon': return { ...s, vertices: s.vertices.map((v, k) => (`v${k}` === id ? p : v)) };
    default: return s;
  }
}

/** A whole-object canvas edit (move, scale, stretch, rotate about `pivot`) baked into the shape; null if it can't be. */
export function bakeTransform(s: Shape, t: { move?: Pt; scale?: number; stretch?: Pt; rotate?: number }, pivot: Pt): Shape | null {
  const map = (p: Pt): Pt => {
    let q = sub(p, pivot);
    if (t.stretch) q = [q[0] * t.stretch[0], q[1] * t.stretch[1]];
    if (t.scale !== undefined) q = [q[0] * t.scale, q[1] * t.scale];
    if (t.rotate) q = rot(q, t.rotate);
    q = add(q, pivot);
    return t.move ? add(q, t.move) : q;
  };
  switch (s.kind) {
    case 'point': return t.move ? { ...s, center: map(s.center) } : null; // a dot's scale/rotation are style, not geometry
    case 'line': return { ...s, start: map(s.start), end: map(s.end) };
    case 'polygon': return { ...s, vertices: s.vertices.map(map) };
    case 'circle':
      if (t.stretch || t.rotate) return null;
      return { ...s, center: t.move ? add(s.center, t.move) : s.center, r: s.r * (t.scale ?? 1) };
    case 'rect':
      if (t.move) return { ...s, center: add(s.center, t.move) };
      if (t.scale !== undefined) return { ...s, w: s.w * t.scale, h: s.h * t.scale };
      if (t.stretch && !s.square) {
        // Stretch along the screen axes: exact for an unrotated rectangle.
        if (s.angle % 180 === 0) return { ...s, w: s.w * t.stretch[0], h: s.h * t.stretch[1] };
        if (s.angle % 90 === 0) return { ...s, w: s.w * t.stretch[1], h: s.h * t.stretch[0] };
        return null;
      }
      if (t.rotate) return { ...s, angle: ((s.angle + t.rotate) % 360 + 360) % 360 };
      return null;
  }
}

/** Shape → scene-space center, for labels and pivots. */
export function shapeCenter(s: Shape): Pt {
  switch (s.kind) {
    case 'point': case 'circle': case 'rect': return s.center;
    case 'line': return [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2];
    case 'polygon': {
      const xs = s.vertices.map((v) => v[0]), ys = s.vertices.map((v) => v[1]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    }
  }
}

// ---------------------------------------------------------------- snapping helpers

export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Closest point to `p` on segment ab, and its parameter t in [0, 1]. */
export function nearestOnSegment(p: Pt, a: Pt, b: Pt): { pt: Pt; t: number } {
  const d = sub(b, a);
  const len2 = d[0] * d[0] + d[1] * d[1];
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / len2)) : 0;
  return { pt: [a[0] + d[0] * t, a[1] + d[1] * t], t };
}

/** Closest point on a polyline. */
export function nearestOnPath(p: Pt, path: Pt[]): { pt: Pt; d: number } | null {
  let best: { pt: Pt; d: number } | null = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const { pt } = nearestOnSegment(p, path[i], path[i + 1]);
    const d = dist(p, pt);
    if (!best || d < best.d) best = { pt, d };
  }
  return best;
}
