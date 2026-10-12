import { useEffect, useRef, useState } from 'react';
import { currentActions, type Action } from '../actions';
import { FOLLOW_KINDS, geoType, graphAxes, isCoupled, isFollow, isRedraw, literal, ownsPosition, soleParam, standsAlone } from '../construct';
import { dist, dragHandle, freeShape, handlesOf, nearestOnPath, nearestOnSegment, shapeCenter, writeShape, type Shape } from '../geometry';
import { meetSnaps, type MeetSnap } from '../intersect';
import {
  addAnimation, addObject, animateParam, commitEdit, commitTransform, createLinked, deleteSelection, detachObjects, duplicateObjects, coupleObjects, uncoupleObjects, editPoints, fmt, fps,
  frameSnap, getState, previewEdit, previewTransform, requestFrame, selectedObjectIds, selectObjects, sequenceEnd, setPlaying, setPreviewWidth, setState,
  timecode, toast, toggleObjectSelection, type TransformDelta, useStore,
} from '../store';
import type { ObjInfo, Pt, SceneDoc, SceneObject, Tool } from '../types';
import { DND_TYPE, type DragPayload } from './Library';

type Box = [number, number, number, number]; // x0, y0, x1, y1 in scene units (y up)
type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | 'rot';

interface Drag {
  id: string;
  handle: Handle;
  start: [number, number];
  center: [number, number];
  box: Box;
  delta: TransformDelta;
  moved: boolean;
}

/** Dragging a defining handle (endpoint, vertex, radius, interval bound…) or a constructed object. */
interface GeoDrag {
  id: string;
  handle: string;
  start: Pt;
  moved: boolean;
  last: Pt;
}

/**
 * Something the pointer snaps to. `obj` is set when it is a point object (lines drawn between points connect to them),
 * `meet` when it is where two objects cross (the point tool places their intersection there).
 */
interface Snap {
  pt: Pt;
  kind: 'point' | 'endpoint' | 'vertex' | 'center' | 'midpoint' | 'intersection' | 'curve' | 'grid' | 'free';
  obj?: string;
  curve?: { id: string; type: 'graph' | 'circle' };
  meet?: MeetSnap;
}

interface Draft {
  tool: Tool;
  points: Snap[];
}

export const TOOLS: { tool: Tool; key: string; label: string; icon: string; hint: string }[] = [
  { tool: 'select', key: '1', label: 'Select', icon: '⬚', hint: 'Select, move and edit (1). Shift-click adds to the selection; drag on empty space to select several.' },
  { tool: 'point', key: '2', label: 'Point', icon: '•', hint: 'Point (2). Click on a graph or circle to constrain the point to it, or where two lines, circles, graphs or axes cross to place their intersection.' },
  { tool: 'line', key: '3', label: 'Segment', icon: '╱', hint: 'Segment (3): click two endpoints. Endpoints on existing points connect to them.' },
  { tool: 'arrow', key: '4', label: 'Arrow', icon: '↗', hint: 'Arrow (4): click start and end.' },
  { tool: 'circle', key: '5', label: 'Circle', icon: '◯', hint: 'Circle (5): click the center, then a point on the circle.' },
  { tool: 'rect', key: '6', label: 'Rectangle', icon: '▭', hint: 'Rectangle (6): click two opposite corners.' },
  { tool: 'polygon', key: '7', label: 'Polygon', icon: '⬠', hint: 'Polygon (7): click the vertices; click the first one, double-click or press Enter to finish.' },
];

const ENTRY_HINT: Record<Tool, string[]> = {
  select: [], point: ['x, y'], line: ['x, y of start', 'x, y of end'], arrow: ['x, y of start', 'x, y of end'],
  circle: ['x, y of center', 'radius'], rect: ['x, y of a corner', 'width, height'], polygon: ['x, y of next vertex'],
};

/** The preview video that failed to play (told once). */
let unplayable: string | null | undefined;

export function Viewport() {
  const doc = useStore((s) => s.doc);
  const frame = useStore((s) => s.frame);
  const selection = useStore((s) => s.selection);
  const snap = useStore((s) => s.snap);
  const record = useStore((s) => s.record);
  const video = useStore((s) => s.video);
  const showVideo = useStore((s) => s.showVideo);
  const playing = useStore((s) => s.playing);
  const time = useStore((s) => s.time);
  const tool = useStore((s) => s.tool);
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [geoDrag, setGeoDrag] = useState<GeoDrag | null>(null);
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt; base: string[] } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Snap | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  // Clicks can arrive faster than re-renders: the ref is the source of truth for the drawing in progress.
  const draftRef = useRef<Draft | null>(null);
  const setDraft = (d: Draft | null) => {
    draftRef.current = d;
    setDraftState(d);
  };
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [entry, setEntry] = useState('');
  const [dropPoint, setDropPoint] = useState<[number, number] | null>(null);

  const aspect = doc.config.pixel_width / doc.config.pixel_height;

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const w = Math.max(100, Math.min(r.width - 24, (r.height - 20) * aspect));
      setSize({ w, h: w / aspect });
      setPreviewWidth(Math.min(1920, Math.round((w * devicePixelRatio) / 160) * 160));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  useEffect(() => requestFrame(), [size.w]);
  useEffect(() => setDraft(null), [tool]);

  // Tool shortcuts (1–7), Enter finishes a polygon, Escape cancels a drawing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = TOOLS.find((x) => x.key === e.key);
      if (t) {
        setState({ tool: t.tool });
        e.preventDefault();
      } else if (e.key === 'Enter' && draft?.tool === 'polygon' && draft.points.length >= 3) {
        finishPolygon(draft.points);
        e.preventDefault();
      } else if (e.key === 'Escape' && (draft || getState().tool !== 'select')) {
        if (draft) setDraft(null);
        else setState({ tool: 'select' });
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Keep the preview video in sync with the playhead.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !showVideo) return;
    if (playing) {
      if (Math.abs(v.currentTime - getState().time) > 0.25) v.currentTime = getState().time;
      v.play().catch((err: DOMException) => {
        // the video can't play here (a codec the window lacks, a file gone): play frame by frame instead
        if (err.name === 'AbortError' || !getState().playing) return;
        if (unplayable !== video?.url) toast('The preview video can’t play here, so playback shows frames as they are drawn');
        unplayable = video?.url;
        setState({ showVideo: false });
      });
      let raf = 0;
      const loop = () => {
        if (!getState().playing) return;
        setState({ time: v.currentTime });
        if (v.ended) return setState({ playing: false });
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }
    v.pause();
  }, [playing, showVideo, video?.url]);
  useEffect(() => {
    const v = videoRef.current;
    if (v && showVideo && !playing && Math.abs(v.currentTime - time) > 0.01) v.currentTime = time;
  }, [time, playing, showVideo]);

  const cam = frame?.camera ?? { center: [0, 0] as [number, number], width: 8 * aspect, height: 8 };
  const toPx = (x: number, y: number): [number, number] => [
    ((x - cam.center[0]) / cam.width + 0.5) * size.w,
    (0.5 - (y - cam.center[1]) / cam.height) * size.h,
  ];
  const toScene = (px: number, py: number): [number, number] => [
    (px / size.w - 0.5) * cam.width + cam.center[0],
    (0.5 - py / size.h) * cam.height + cam.center[1],
  ];
  const localPoint = (e: { clientX: number; clientY: number }, el: Element) => {
    const r = el.getBoundingClientRect();
    return toScene(e.clientX - r.left, e.clientY - r.top);
  };
  const unit = cam.width / size.w; // scene units per pixel
  const snapPt = ([x, y]: [number, number]): [number, number] =>
    snap ? [Math.round(x * 4) / 4, Math.round(y * 4) / 4] : [Math.round(x * 100) / 100, Math.round(y * 100) / 100];

  const objects = frame?.objects ?? [];
  const visible = objects.filter((o) => o.visible && o.box);
  const objOf = (id: string) => doc.objects.find((o) => o.id === id);
  const infoOf = (id: string) => objects.find((o) => o.id === id);

  /** Distance from p to an object's drawn geometry (lines, curves, outlines) or box. */
  const hitDistance = (o: ObjInfo, p: Pt): number => {
    const g = o.geom;
    if (g?.kind === 'line') return dist(p, nearestOnSegment(p, g.start, g.end).pt);
    if (g?.kind === 'point') return Math.max(0, dist(p, g.center) - 0.08);
    if (g?.kind === 'circle') return Math.min(Math.abs(dist(p, g.center) - g.radius), dist(p, g.center) < g.radius ? 0.15 : Infinity);
    if (o.path && o.path.length > 1 && !g) return nearestOnPath(p, o.path)?.d ?? Infinity;
    const b = o.box!;
    const dx = Math.max(b[0] - p[0], 0, p[0] - b[2]), dy = Math.max(b[1] - p[1], 0, p[1] - b[3]);
    return Math.hypot(dx, dy);
  };
  const hitTest = (p: Pt): ObjInfo | undefined => {
    const tol = 8 * unit;
    const hits = visible.map((o) => ({ o, d: hitDistance(o, p) })).filter((h) => h.d <= tol);
    // Prefer points, then the closest outline, then the smallest box.
    hits.sort((a, b) => (a.o.geom?.kind === 'point' ? -1 : 0) - (b.o.geom?.kind === 'point' ? -1 : 0) || a.d - b.d || area(a.o.box!) - area(b.o.box!));
    return hits[0]?.o;
  };

  /** Snap to points, intersections, endpoints, vertices, centers, midpoints, curves, then the grid. */
  const snapTo = (p: Pt, exclude: Set<string> = new Set()): Snap => {
    const tol = 10 * unit;
    let best: Snap | null = null, bestD = tol;
    const consider = (s: Snap, d: number, bias = 0) => {
      if (d - bias < bestD) {
        best = s;
        bestD = d - bias;
      }
    };
    for (const o of visible) {
      if (exclude.has(o.id)) continue;
      const g = o.geom;
      const obj = objOf(o.id);
      if (g?.kind === 'point') consider({ pt: g.center, kind: 'point', obj: obj && geoType(obj, doc) === 'point' ? o.id : undefined }, dist(p, g.center), tol);
      if (g?.kind === 'line') {
        consider({ pt: g.start, kind: 'endpoint' }, dist(p, g.start), tol / 2);
        consider({ pt: g.end, kind: 'endpoint' }, dist(p, g.end), tol / 2);
        const m: Pt = [(g.start[0] + g.end[0]) / 2, (g.start[1] + g.end[1]) / 2];
        consider({ pt: m, kind: 'midpoint' }, dist(p, m), tol / 3);
      }
      if (g?.kind === 'polygon') for (const v of g.vertices) consider({ pt: v, kind: 'vertex' }, dist(p, v), tol / 2);
      if (g?.kind === 'circle') {
        consider({ pt: g.center, kind: 'center' }, dist(p, g.center), tol / 2);
        if (o.path) {
          const n = nearestOnPath(p, o.path);
          if (n) consider({ pt: n.pt, kind: 'curve', curve: { id: o.id, type: 'circle' } }, n.d);
        }
      }
      if (!g && o.path && obj && geoType(obj, doc) === 'graph') {
        const n = nearestOnPath(p, o.path);
        if (n) consider({ pt: n.pt, kind: 'curve', curve: { id: o.id, type: 'graph' } }, n.d);
      }
    }
    for (const m of meetSnaps(doc, objects)) {
      if (exclude.has(m.a) || exclude.has(m.b)) continue;
      consider({ pt: m.pt, kind: 'intersection', meet: m }, dist(p, m.pt), tol * 0.75);
    }
    if (best) return best;
    return snap ? { pt: snapPt(p), kind: 'grid' } : { pt: [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100], kind: 'free' };
  };

  const selIds = selectedObjectIds(selection);
  const selectedId = selection?.kind === 'object' ? selection.id : null;
  const selInfo = visible.find((o) => o.id === selectedId);
  const selObj = selectedId ? objOf(selectedId) : undefined;
  const timelineError = useStore((s) => s.timeline?.error);
  const error = frame?.error ?? timelineError; // a failure later in the scene shows even while the playhead is before it

  // ------------------------------------------------------------ creating shapes

  const placePoint = (s: Snap) => {
    if (s.meet) {
      const { a, b, which, axis } = s.meet;
      return void createLinked({ ctor: 'Dot', name: 'X', pos: [fmtN(s.pt[0]), fmtN(s.pt[1])], link: { kind: 'intersection', a, b, ...(which ? { which } : {}), ...(axis ? { axis } : {}) } });
    }
    if (s.curve?.type === 'graph') {
      const g = objOf(s.curve.id)!;
      const ax = graphAxes(g, doc);
      const a = ax && infoOf(ax.id)?.axes;
      const x = a ? toAxes(a, s.pt)[0] : 0;
      return void createLinked({ ctor: 'Dot', name: 'P', link: { kind: 'on_graph', graph: g.id, x: fmt(x) } });
    }
    if (s.curve?.type === 'circle') {
      const c = infoOf(s.curve.id)?.geom;
      const ang = c?.kind === 'circle' ? Math.atan2(s.pt[1] - c.center[1], s.pt[0] - c.center[0]) : 0;
      return void createLinked({ ctor: 'Dot', name: 'P', link: { kind: 'on_circle', circle: s.curve.id, angle: fmt(ang) } });
    }
    void addObject('Dot', s.pt);
  };

  const finishLine = (a: Snap, b: Snap, arrow: boolean) => {
    const ctor = arrow ? 'Arrow' : 'Line';
    if (a.obj && b.obj && a.obj !== b.obj)
      return void createLinked({ ctor, args: arrow ? { buff: '0' } : {}, name: `seg_${objOf(a.obj)!.name}${objOf(b.obj)!.name}`, link: { kind: 'segment', a: a.obj, b: b.obj } });
    if (dist(a.pt, b.pt) < 1e-3) return toast('The endpoints are the same point');
    void addObject(ctor, null, undefined, undefined, { start: fmtV(a.pt), end: fmtV(b.pt), ...(arrow ? { buff: '0' } : {}) });
  };

  const finishCircle = (c: Snap, r: Snap | number) => {
    if (typeof r !== 'number' && c.obj && r.obj && c.obj !== r.obj) return void createLinked({ ctor: 'Circle', name: 'circle', link: { kind: 'circle2', a: c.obj, b: r.obj } });
    const radius = typeof r === 'number' ? r : dist(c.pt, r.pt);
    if (radius < 1e-3) return toast('The radius is zero');
    if (c.obj) return void createLinked({ ctor: 'Circle', name: 'circle', args: { radius: fmt(radius) }, link: { kind: 'attach', to: c.obj, offset: [0, 0] } });
    void addObject('Circle', c.pt, undefined, undefined, { radius: fmt(radius) });
  };

  const finishRect = (a: Pt, b: Pt) => {
    const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    if (w < 1e-3 || h < 1e-3) return toast('The rectangle has no area');
    void addObject('Rectangle', [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], undefined, undefined, { width: fmt(w), height: fmt(h) });
  };

  function finishPolygon(pts: Snap[]) {
    setDraft(null);
    if (pts.length < 3) return;
    const ids = pts.map((p) => p.obj);
    if (ids.every(Boolean) && new Set(ids).size === ids.length) return void createLinked({ ctor: 'Polygon', name: 'polygon', link: { kind: 'polygon', points: ids as string[] } });
    void addObject('Polygon', null, undefined, undefined, { '*': pts.map((p) => fmtV(p.pt)).join(', ') });
  }

  /** Feed one click (or exact entry) to the active drawing tool. */
  const toolClick = (s: Snap, dbl = false) => {
    const draft = draftRef.current;
    const pts = [...(draft?.points ?? []), s];
    switch (tool) {
      case 'point':
        return placePoint(s);
      case 'line': case 'arrow':
        if (pts.length < 2) return setDraft({ tool, points: pts });
        setDraft(null);
        return finishLine(pts[0], pts[1], tool === 'arrow');
      case 'circle':
        if (pts.length < 2) return setDraft({ tool, points: pts });
        setDraft(null);
        return finishCircle(pts[0], pts[1]);
      case 'rect':
        if (pts.length < 2) return setDraft({ tool, points: pts });
        setDraft(null);
        return finishRect(pts[0].pt, pts[1].pt);
      case 'polygon': {
        const first = draft?.points[0];
        if (first && draft!.points.length >= 3 && (dist(first.pt, s.pt) < 10 * unit || dbl)) return finishPolygon(draft!.points);
        return setDraft({ tool, points: pts });
      }
    }
  };

  const submitEntry = () => {
    const draft = draftRef.current;
    const nums = entry.split(/[,\s]+/).filter(Boolean).map(Number);
    if (!nums.length || nums.some(Number.isNaN)) return toast('Type numbers, e.g. 1, 2');
    const step = draft?.points.length ?? 0;
    if (tool === 'circle' && step === 1) {
      setDraft(null);
      finishCircle(draft!.points[0], nums[0]);
    } else if (tool === 'rect' && step === 1 && nums.length >= 2) {
      const a = draft!.points[0].pt;
      setDraft(null);
      finishRect(a, [a[0] + nums[0], a[1] + nums[1]]);
    } else if (nums.length >= 2) {
      toolClick({ pt: [nums[0], nums[1]], kind: 'free' });
    } else return toast('Type x, y');
    setEntry('');
    (document.activeElement as HTMLElement | null)?.blur(); // back to the canvas, so tool keys work again
  };

  // ------------------------------------------------------------ whole-object transforms (existing)

  const beginDrag = (e: React.PointerEvent, info: ObjInfo, handle: Handle) => {
    e.stopPropagation();
    const svg = (e.currentTarget as Element).closest('svg')!;
    svg.setPointerCapture(e.pointerId);
    const b = info.box!;
    const center: [number, number] = info.center ?? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const o = objOf(info.id);
    // Constructed objects: moving them edits their construction (offset, parameter…) instead.
    if (handle === 'move' && o && ownsPosition(o)) {
      if (!moveTarget(o)) return toast(redrawHint(o));
      setGeoDrag({ id: info.id, handle: 'move', start: localPoint(e, svg), moved: false, last: localPoint(e, svg) });
      return;
    }
    setDrag({ id: info.id, handle, start: localPoint(e, svg), center, box: b, delta: {}, moved: false });
  };

  const computeDelta = (d: Drag, p: [number, number], shift: boolean): TransformDelta => {
    const [cx, cy] = d.center;
    if (d.handle === 'move') {
      let dx = p[0] - d.start[0], dy = p[1] - d.start[1];
      if (shift) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (snap) {
        const [sx, sy] = snapPt([cx + dx, cy + dy]);
        dx = sx - cx;
        dy = sy - cy;
      }
      return { move: [dx, dy] };
    }
    if (d.handle === 'rot') {
      const a0 = Math.atan2(d.start[1] - cy, d.start[0] - cx), a1 = Math.atan2(p[1] - cy, p[0] - cx);
      let deg = ((a1 - a0) * 180) / Math.PI;
      if (deg > 180) deg -= 360;
      if (deg < -180) deg += 360;
      if (snap || shift) deg = Math.round(deg / 15) * 15;
      return { rotate: deg };
    }
    const r2 = (v: number) => Math.max(0.02, Math.round(v * 100) / 100);
    const fx = Math.abs(p[0] - cx) / Math.max(1e-3, Math.abs(d.start[0] - cx));
    const fy = Math.abs(p[1] - cy) / Math.max(1e-3, Math.abs(d.start[1] - cy));
    if (d.handle === 'e' || d.handle === 'w') return { stretch: [r2(fx), 1] };
    if (d.handle === 'n' || d.handle === 's') return { stretch: [1, r2(fy)] };
    const f = Math.hypot(p[0] - cx, p[1] - cy) / Math.max(1e-3, Math.hypot(d.start[0] - cx, d.start[1] - cy));
    return { scale: r2(f) };
  };

  const dragBox = (d: Drag): Box => {
    const [cx, cy] = d.center;
    const [x0, y0, x1, y1] = d.box;
    const t = d.delta;
    if (t.move) return [x0 + t.move[0], y0 + t.move[1], x1 + t.move[0], y1 + t.move[1]];
    const sx = (t.scale ?? 1) * (t.stretch?.[0] ?? 1), sy = (t.scale ?? 1) * (t.stretch?.[1] ?? 1);
    return [cx + (x0 - cx) * sx, cy + (y0 - cy) * sy, cx + (x1 - cx) * sx, cy + (y1 - cy) * sy];
  };

  const deltaLabel = (d: Drag) => {
    const t = d.delta;
    if (t.move) return `(${fmt(d.center[0] + t.move[0])}, ${fmt(d.center[1] + t.move[1])})`;
    if (t.rotate !== undefined) return `${fmt(t.rotate)}°`;
    if (t.scale !== undefined) return `×${fmt(t.scale)}`;
    if (t.stretch) return `stretch ×${fmt(t.stretch[0] !== 1 ? t.stretch[0] : t.stretch[1])}`;
    return '';
  };

  // ------------------------------------------------------------ defining handles and constructed objects

  /** What moving a constructed object edits; null when it can't be dragged directly. */
  function moveTarget(o: SceneObject): string | null {
    const l = o.link!;
    if (l.kind === 'attach' || l.kind === 'measure') return l.kind === 'measure' && !l.of ? null : 'offset';
    if (l.kind === 'on_graph') return editable(l.x) ? 'x' : null;
    if (l.kind === 'on_circle') return editable(l.angle) ? 'angle' : null;
    if (l.kind === 'coords') return editable(l.x) && (editable(l.y) || geoType(objOf(l.axes), doc) === 'numberline') ? 'xy' : null;
    return null;
  }
  const editable = (src: string) => literal(src) !== null || !!soleParam(src, doc);

  function redrawHint(o: SceneObject): string {
    const l = o.link!;
    if (l.kind === 'midpoint' || l.kind === 'intersection' || l.kind === 'projection') return `${l.kind === 'midpoint' ? 'A midpoint' : l.kind === 'intersection' ? 'An intersection' : 'A foot of a perpendicular'} is placed by its sources: move them instead`;
    if (FOLLOW_KINDS.has(l.kind)) return 'This position is an expression: edit it in the inspector';
    return 'This shape is defined by its construction: drag its handles or its sources';
  }

  /**
   * Set a link expression field: a literal changes the link; a sole parameter changes that parameter.
   * With `rec` (Record mode), parameter changes are reported instead, to become animation clips.
   */
  const setExpr = (d: SceneDoc, o: SceneObject, field: string, v: number, rec: Rec): boolean => {
    const link = d.objects.find((x) => x.id === o.id)!.link as Record<string, unknown>;
    const src = String(link[field] ?? '');
    const prm = soleParam(src, d);
    const val = Math.round(v * 1000) / 1000;
    if (prm) {
      if (rec) {
        rec(prm.name, val);
        return true;
      }
      const meta = prm.param;
      const clamped = meta ? Math.min(meta.max, Math.max(meta.min, val)) : val;
      d.objects.find((x) => x.id === prm.id)!.args['*'] = String(clamped);
      return true;
    }
    if (literal(src) !== null || src.trim() === '') {
      link[field] = String(val);
      return true;
    }
    return false;
  };

  /** Apply a drag of a constructed object (or a defining handle) to a document. Returns false when nothing applies. */
  const applyGeoDrag = (d: SceneDoc, g: GeoDrag, p: Pt, rec: Rec): boolean => {
    const o = d.objects.find((x) => x.id === g.id);
    if (!o) return false;
    const delta: Pt = [p[0] - g.start[0], p[1] - g.start[1]];
    if (!o.link || standsAlone(o)) {
      // Free shape: edit the defining parameter behind the handle.
      const shape = freeShape(o);
      if (!shape) return false;
      const hs = handlesOf(shape).find((h) => h.id === g.handle);
      if (!hs) return false;
      const target = snapHandle([hs.pt[0] + delta[0], hs.pt[1] + delta[1]], o.id);
      writeShape(o, dragHandle(shape, g.handle, target));
      return true;
    }
    const l = o.link;
    if (g.handle === 'move') {
      const info = infoOf(o.id);
      if (l.kind === 'attach' || l.kind === 'measure') {
        const off = (l as { offset?: [number, number] }).offset ?? [0, 0];
        const base = original(o.id)?.link as { offset?: [number, number] } | undefined;
        const b0 = base?.offset ?? off;
        (l as { offset?: [number, number] }).offset = [Math.round((b0[0] + delta[0]) * 100) / 100, Math.round((b0[1] + delta[1]) * 100) / 100];
        return true;
      }
      if (l.kind === 'on_graph') {
        const gr = d.objects.find((x) => x.id === l.graph);
        const ax = gr && graphAxes(gr, d);
        const a = ax && infoOf(ax.id)?.axes;
        if (!a) return false;
        return setExpr(d, o, 'x', toAxes(a, p)[0], rec);
      }
      if (l.kind === 'on_circle') {
        const c = infoOf(l.circle)?.geom;
        if (c?.kind !== 'circle') return false;
        return setExpr(d, o, 'angle', Math.atan2(p[1] - c.center[1], p[0] - c.center[0]), rec);
      }
      if (l.kind === 'coords') {
        const a = infoOf(l.axes)?.axes;
        if (!a) return false;
        const [x, y] = toAxes(a, snap ? snapPt(p) : p);
        const okX = setExpr(d, o, 'x', x, rec);
        const okY = a.uy[0] || a.uy[1] ? setExpr(d, o, 'y', y, rec) : true;
        return okX || okY;
      }
      void info;
      return false;
    }
    // Handles of constructions: move a free source point, or edit an interval / x value.
    const h = g.handle;
    if (h.startsWith('src:')) {
      const src = d.objects.find((x) => x.id === h.slice(4));
      const shape = src && freeShape(src);
      if (!src || shape?.kind !== 'point') return false;
      const orig = original(src.id);
      const c0 = (orig && freeShape(orig)?.kind === 'point' ? (freeShape(orig) as { center: Pt }).center : shape.center);
      writeShape(src, { kind: 'point', center: snapHandle([c0[0] + delta[0], c0[1] + delta[1]], src.id) });
      return true;
    }
    if (h === 'a' || h === 'b' || h === 'x') {
      const gid = (l as { graph?: string }).graph;
      const gr = gid ? d.objects.find((x) => x.id === gid) : undefined;
      const ax = gr && graphAxes(gr, d);
      const a = ax && infoOf(ax.id)?.axes;
      if (!a) return false;
      let x = toAxes(a, p)[0];
      if (snap) x = Math.round(x * 4) / 4;
      return setExpr(d, o, h, x, rec);
    }
    return false;
  };

  const original = (id: string) => getState().doc.objects.find((o) => o.id === id);
  const snapHandle = (p: Pt, self: string): Pt => {
    const s = snapTo(p, new Set([self]));
    return s.pt;
  };

  /** Handles shown for the selected object: its defining parameters or its construction's inputs. */
  const geoHandles = (o: SceneObject | undefined, info: ObjInfo | undefined): { id: string; pt: Pt; title: string; kind: 'geo' | 'src' | 'bound' }[] => {
    if (!o || !info) return [];
    if (!o.link || standsAlone(o)) {
      const shape = freeShape(o);
      if (!shape || shape.kind === 'point') return [];
      const off = frameOffset(shape, info);
      return handlesOf(shape).map((h) => ({ ...h, pt: [h.pt[0] + off[0], h.pt[1] + off[1]] as Pt, kind: 'geo' as const }));
    }
    const l = o.link;
    const out: { id: string; pt: Pt; title: string; kind: 'geo' | 'src' | 'bound' }[] = [];
    const srcPoint = (id: string | undefined, title: string) => {
      const s = id && objOf(id);
      const si = id ? infoOf(id) : undefined;
      if (s && freeShape(s)?.kind === 'point' && si?.center) out.push({ id: `src:${id}`, pt: si.center, title, kind: 'src' });
    };
    if (l.kind === 'segment' || l.kind === 'circle2') {
      srcPoint(l.a, `Move ${objOf(l.a)?.name}`);
      srcPoint(l.b, `Move ${objOf(l.b)?.name}`);
    }
    if (l.kind === 'polygon') l.points.forEach((p) => srcPoint(p, `Move ${objOf(p)?.name}`));
    if (l.kind === 'perpendicular' || l.kind === 'parallel') srcPoint(l.through, `Move ${objOf(l.through)?.name}`);
    if (l.kind === 'area' || l.kind === 'riemann' || l.kind === 'tangent' || l.kind === 'secant') {
      const gr = objOf(l.graph);
      const ax = gr && graphAxes(gr, doc);
      const a = ax && infoOf(ax.id)?.axes;
      if (a) {
        const bounds: [string, string][] = l.kind === 'area' || l.kind === 'riemann' ? [['a', l.a], ['b', l.b]] : [['x', l.x]];
        for (const [f, src] of bounds) {
          const v = valueOf(src);
          if (v === null || !editable(src)) continue;
          out.push({ id: f, pt: fromAxes(a, [v, a.y_range[0]]), title: `${f} = ${src} (drag along the x-axis)`, kind: 'bound' });
        }
      }
    }
    return out;
  };

  /** Numeric value of a literal or a single parameter (at the current frame). */
  const valueOf = (src: string): number | null => {
    const lit = literal(src);
    if (lit !== null) return lit;
    const p = soleParam(src, doc);
    return p ? frame?.values?.[p.name] ?? literal(p.args['*']) : null;
  };

  // ------------------------------------------------------------ pointer handling

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button === 2) return;
    setMenu(null);
    const svg = e.currentTarget;
    const p = localPoint(e, svg);
    if (tool !== 'select') {
      svg.setPointerCapture(e.pointerId);
      return toolClick(snapTo(p), e.detail >= 2);
    }
    const hit = hitTest(p);
    if (!hit) {
      if (!e.shiftKey) setState({ selection: null });
      svg.setPointerCapture(e.pointerId);
      return setMarquee({ a: p, b: p, base: e.shiftKey ? selIds : [] });
    }
    if (e.shiftKey) return toggleObjectSelection(hit.id);
    // A second click on a selected equation picks a term.
    if (selectedId === hit.id && hit.parts?.length) {
      const part = hit.parts.find((pt) => pt.box && p[0] >= pt.box[0] - 0.05 && p[0] <= pt.box[2] + 0.05 && p[1] >= pt.box[1] - 0.05 && p[1] <= pt.box[3] + 0.05);
      if (part) {
        const cur = selection?.kind === 'object' ? selection.terms ?? [] : [];
        const terms = e.altKey || e.metaKey ? (cur.includes(part.id) ? cur.filter((t) => t !== part.id) : [...cur, part.id]) : [part.id];
        setState({ selection: { kind: 'object', id: hit.id, terms } });
        return;
      }
    }
    if (!selIds.includes(hit.id) || selIds.length > 1) selectObjects([hit.id]);
    beginDrag(e, hit, 'move');
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = localPoint(e, e.currentTarget);
    if (tool !== 'select') return setCursor(snapTo(p));
    if (marquee) {
      const box: Box = [Math.min(marquee.a[0], p[0]), Math.min(marquee.a[1], p[1]), Math.max(marquee.a[0], p[0]), Math.max(marquee.a[1], p[1])];
      const inside = visible.filter((o) => o.box![0] >= box[0] && o.box![2] <= box[2] && o.box![1] >= box[1] && o.box![3] <= box[3]).map((o) => o.id);
      selectObjects([...new Set([...marquee.base, ...inside])]);
      return setMarquee({ ...marquee, b: p });
    }
    if (geoDrag) {
      const moved = geoDrag.moved || dist(p, geoDrag.start) > 2 * unit;
      if (moved) previewEdit((d) => void applyGeoDrag(d, geoDrag, p, null));
      return setGeoDrag({ ...geoDrag, moved, last: p });
    }
    if (!drag) return setHover(hitTest(p)?.id ?? null);
    const delta = computeDelta(drag, p, e.shiftKey);
    const moved = drag.moved || Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) > 0.03;
    if (moved && JSON.stringify(delta) !== JSON.stringify(drag.delta)) previewTransform(drag.id, delta, drag.center);
    setDrag({ ...drag, delta, moved });
  };

  const onUp = () => {
    if (marquee) setMarquee(null);
    if (geoDrag) {
      if (geoDrag.moved) {
        // Record mode: parameter drags become .animate.set_value clips at the playhead.
        const recorded: [string, number][] = [];
        const scratch = structuredClone(getState().doc);
        const ok = applyGeoDrag(scratch, geoDrag, geoDrag.last, getState().record ? (name, v) => recorded.push([name, v]) : null);
        setState({ previewDoc: null });
        if (recorded.length) recorded.forEach(([name, v]) => animateParam(name, v));
        else if (getState().record && ok) toast('Only parameters can be recorded; this edit changes the starting state');
        if (ok && !recorded.length) commitEdit((d) => void applyGeoDrag(d, geoDrag, geoDrag.last, null));
      } else {
        setState({ previewDoc: null });
        // A click (no drag) on a construction's source handle selects that source object.
        if (geoDrag.handle.startsWith('src:')) selectObjects([geoDrag.handle.slice(4)]);
      }
      setGeoDrag(null);
    }
    if (drag?.moved) commitTransform(drag.id, drag.delta, drag.center);
    else if (drag) setState({ previewDoc: null });
    setDrag(null);
  };

  const startHandleDrag = (e: React.PointerEvent, id: string, handle: string) => {
    e.stopPropagation();
    const svg = (e.currentTarget as Element).closest('svg')!;
    svg.setPointerCapture(e.pointerId);
    const o = objOf(id);
    // Alt-click a polygon vertex removes it.
    if (e.altKey && o && handle.startsWith('v')) {
      const shape = freeShape(o);
      if (shape?.kind === 'polygon' && shape.vertices.length > 3) {
        commitEdit((d) => writeShape(d.objects.find((x) => x.id === id)!, { ...shape, vertices: shape.vertices.filter((_, i) => `v${i}` !== handle) }));
      }
      return;
    }
    if (getState().record && o && (!o.link || standsAlone(o))) return toast('Handles edit the starting shape; turn off Record to use them');
    const p = localPoint(e, svg);
    setGeoDrag({ id, handle, start: p, moved: false, last: p });
  };

  const onContext = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    const p = localPoint(e, e.currentTarget);
    const hit = hitTest(p);
    if (hit && !selIds.includes(hit.id)) selectObjects([hit.id]);
    if (!hit && !selIds.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  // ------------------------------------------------------------ render

  const handles = tool === 'select' ? geoHandles(selObj, selInfo) : [];
  const draftPts = draft?.points.map((s) => s.pt) ?? [];
  const live = cursor?.pt;
  const diag = frame?.diagnostics?.find((d) => d.id === selectedId && d.kind === 'object');

  return (
    <div className="monitor">
      <div className="monitor-title">
        <span className="tab-btn on">Program: {doc.scene.name}</span>
        <button className="ghost small tab-btn" title="The same scene as manim code" onClick={() => setState({ centerTab: 'code' })}>Code</button>
        {record && <span className="rec-badge">● REC</span>}
        <div className="tools" role="toolbar" aria-label="Drawing tools" data-tour="tools">
          {TOOLS.map((t) => (
            <button key={t.tool} className={`tool-btn ${tool === t.tool ? 'on' : ''}`} title={t.hint} aria-label={t.label} onClick={() => setState({ tool: t.tool })}>{t.icon}</button>
          ))}
        </div>
        {tool !== 'select' && (
          <form className="entry" onSubmit={(e) => { e.preventDefault(); submitEntry(); }}>
            <input className="field mono" value={entry} placeholder={ENTRY_HINT[tool][Math.min(draft?.points.length ?? 0, ENTRY_HINT[tool].length - 1)] ?? ''} onChange={(e) => setEntry(e.target.value)} title="Exact entry: type and press Enter" />
          </form>
        )}
        <span className="spacer" />
        {cursor && tool !== 'select' && <span className="muted small mono">{cursor.kind !== 'grid' && cursor.kind !== 'free' ? `${cursor.kind} ` : ''}({fmt(cursor.pt[0])}, {fmt(cursor.pt[1])})</span>}
        {showVideo && <span className="muted small">Smooth preview (manim render)</span>}
      </div>
      <div className="viewport" ref={wrapRef}>
        <div
          data-tour="canvas"
          className={`stage ${tool !== 'select' ? 'drawing' : ''}`}
          style={{ width: size.w, height: size.h, background: doc.config.background_color }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DND_TYPE)) return;
            e.preventDefault();
            setDropPoint(snapPt(localPoint(e, e.currentTarget)));
          }}
          onDragLeave={() => setDropPoint(null)}
          onDrop={(e) => {
            setDropPoint(null);
            const raw = e.dataTransfer.getData(DND_TYPE);
            if (!raw) return;
            e.preventDefault();
            const payload = JSON.parse(raw) as DragPayload;
            const p = localPoint(e, e.currentTarget);
            const under = hitTest(p);
            const sel = getState().doc.objects.find((o) => o.id === selectedId);
            if (payload.kind === 'mobject') addObject(payload.name, snapPt(p), under?.name ?? sel?.name);
            else {
              const target = under?.name ?? sel?.name;
              if (!target) return setState({ toast: 'Drop animations onto an object' });
              addAnimation(payload.name, target);
            }
          }}
        >
          {frame?.image && <img className={`frame ${error ? 'stale' : ''}`} src={frame.image} draggable={false} alt="" />}
          {video?.url && <video ref={videoRef} className={`frame ${showVideo ? '' : 'hidden'}`} src={video.url} preload="auto" muted playsInline />}
          <svg className="overlay" width={size.w} height={size.h} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
            onPointerLeave={() => setCursor(null)}
            onPointerCancel={() => { setState({ previewDoc: null }); setDrag(null); setGeoDrag(null); setMarquee(null); }}
            onContextMenu={onContext}
            onDoubleClick={() => tool === 'select' && (document.querySelector('.inspector .scroll') as HTMLElement | null)?.focus()}
          >
            {(drag?.moved || dropPoint || (tool !== 'select' && snap)) && <Grid toPx={toPx} cam={cam} />}
            {visible.map((o) => {
              if (selIds.includes(o.id) || o.id !== hover) return null;
              const [x0, y0] = toPx(o.box![0], o.box![3]);
              const [x1, y1] = toPx(o.box![2], o.box![1]);
              return <rect key={o.id} x={x0 - 4} y={y0 - 4} width={x1 - x0 + 8} height={y1 - y0 + 8} className="hover-box" />;
            })}
            {selIds.length > 1 && visible.filter((o) => selIds.includes(o.id)).map((o) => {
              const [x0, y0] = toPx(o.box![0], o.box![3]);
              const [x1, y1] = toPx(o.box![2], o.box![1]);
              return (
                <g key={o.id}>
                  <rect x={x0 - 4} y={y0 - 4} width={x1 - x0 + 8} height={y1 - y0 + 8} className="sel-box multi" />
                  <text x={x0 - 4} y={y0 - 8} className="box-label">{selIds.indexOf(o.id) + 1}. {o.name}</text>
                </g>
              );
            })}
            {/* Drawing tools own every click: no handles to grab while drawing. */}
            {tool === 'select' && selInfo && selIds.length === 1 && (
              selObj && isRedraw(selObj) ? (
                <ConstructedBox name={selInfo.name} box={selInfo.box!} toPx={toPx} />
              ) : (
                <Handles
                  name={selInfo.name}
                  box={drag?.id === selInfo.id ? dragBox(drag) : selInfo.box!}
                  rotation={drag?.id === selInfo.id ? drag.delta.rotate ?? 0 : 0}
                  toPx={toPx}
                  moveOnly={!!selObj && isFollow(selObj)}
                  point={selInfo.geom?.kind === 'point'}
                  onDown={(e, h) => beginDrag(e, selInfo, h)}
                />
              )
            )}
            {tool === 'select' && selInfo?.parts && selIds.length === 1 && selInfo.parts.map((pt) => {
              if (!pt.box) return null;
              const [x0, y0] = toPx(pt.box[0], pt.box[3]);
              const [x1, y1] = toPx(pt.box[2], pt.box[1]);
              const on = selection?.kind === 'object' && selection.terms?.includes(pt.id);
              return <rect key={pt.id} x={x0 - 2} y={y0 - 2} width={x1 - x0 + 4} height={y1 - y0 + 4} className={`term-box ${on ? 'on' : ''}`}><title>Click to select this term (Alt-click to add)</title></rect>;
            })}
            {handles.map((h) => {
              const [x, y] = toPx(...h.pt);
              if (h.kind === 'bound') {
                return (
                  <g key={h.id} className="bound-handle" onPointerDown={(e) => startHandleDrag(e, selInfo!.id, h.id)}>
                    <line x1={x} x2={x} y1={y} y2={y - 60} />
                    <rect x={x - 6} y={y - 6} width={12} height={12} rx={2}><title>{h.title}</title></rect>
                  </g>
                );
              }
              return (
                <circle key={h.id} cx={x} cy={y} r={6} className={`geo-handle ${h.kind}`} onPointerDown={(e) => startHandleDrag(e, selInfo!.id, h.id)}>
                  <title>{h.title}</title>
                </circle>
              );
            })}
            {drag?.moved && (
              <text className="coord" x={toPx(...drag.center)[0] + 10} y={toPx(...drag.center)[1] - 10}>
                {record ? '● ' : ''}{deltaLabel(drag)}
              </text>
            )}
            {marquee && (() => {
              const [x0, y0] = toPx(Math.min(marquee.a[0], marquee.b[0]), Math.max(marquee.a[1], marquee.b[1]));
              const [x1, y1] = toPx(Math.max(marquee.a[0], marquee.b[0]), Math.min(marquee.a[1], marquee.b[1]));
              return <rect className="canvas-marquee" x={x0} y={y0} width={x1 - x0} height={y1 - y0} />;
            })()}
            {tool !== 'select' && <DraftPreview tool={tool} pts={draftPts} live={live} toPx={toPx} />}
            {tool !== 'select' && cursor && (
              <g className={`snap-mark ${cursor.kind}`}>
                <circle cx={toPx(...cursor.pt)[0]} cy={toPx(...cursor.pt)[1]} r={cursor.obj || cursor.curve || cursor.meet ? 7 : 4} />
              </g>
            )}
            {dropPoint && (
              <g>
                <circle cx={toPx(...dropPoint)[0]} cy={toPx(...dropPoint)[1]} r={5} className="drop-dot" />
                <text className="coord" x={toPx(...dropPoint)[0] + 8} y={toPx(...dropPoint)[1] - 8}>({fmt(dropPoint[0])}, {fmt(dropPoint[1])})</text>
              </g>
            )}
          </svg>
          {menu && <CanvasMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
          {doc.objects.length === 0 && !dropPoint && tool === 'select' && (
            <div className="empty-hint">Draw with the tools above, or drag a manim object here<br /><span className="muted">or double-click one in the library (press / to search it): Circle, MathTex, Axes</span></div>
          )}
        </div>
        {(error || diag) && (
          <div className={`error-bar ${!error ? 'warn' : ''}`} onClick={() => {
            if (!error) return;
            if (error.kind === 'object' && error.id) setState({ selection: { kind: 'object', id: error.id } });
            if ((error.kind === 'step' || error.kind === 'anim') && error.id) setState({ selection: { kind: 'clips', ids: [error.id] } });
            if (error.kind === 'header') setState({ centerTab: 'code' });
          }}>
            {error ? <><b>Error</b> {error.message}</> : <><b>{diag!.level === 'error' ? 'Construction error' : 'Note'}</b> {diag!.message}</>}
          </div>
        )}
      </div>
      <Transport />
    </div>
  );
}

type Rec = ((param: string, value: number) => void) | null;
const fmtN = (v: number) => Math.round(v * 1000) / 1000;
const fmtV = (p: Pt) => `np.array([${fmt(p[0])}, ${fmt(p[1])}, 0])`;

/** Offset between where a free shape's arguments say it is and where it is drawn now (animations may have moved it). */
function frameOffset(shape: Shape, info: ObjInfo): Pt {
  const g = info.geom;
  let c: Pt | null = null;
  if (g?.kind === 'line') c = [(g.start[0] + g.end[0]) / 2, (g.start[1] + g.end[1]) / 2];
  else if (g?.kind === 'circle') c = g.center;
  else if (info.box) c = [(info.box[0] + info.box[2]) / 2, (info.box[1] + info.box[3]) / 2];
  if (!c || shape.kind === 'line' && g?.kind !== 'line') return [0, 0];
  const s = shapeCenter(shape);
  const off: Pt = [c[0] - s[0], c[1] - s[1]];
  return Math.hypot(off[0], off[1]) < 0.02 ? [0, 0] : off; // arrow tips etc. shift the box slightly
}

type AxesInfo = NonNullable<ObjInfo['axes']>;
/** Scene point → axes coordinates (affine inverse; number lines use x only). */
export function toAxes(a: AxesInfo, p: Pt): Pt {
  const dx = p[0] - a.origin[0], dy = p[1] - a.origin[1];
  const det = a.ux[0] * a.uy[1] - a.ux[1] * a.uy[0];
  if (Math.abs(det) < 1e-12) {
    const l2 = a.ux[0] ** 2 + a.ux[1] ** 2 || 1;
    return [(dx * a.ux[0] + dy * a.ux[1]) / l2, 0];
  }
  return [(dx * a.uy[1] - dy * a.uy[0]) / det, (a.ux[0] * dy - a.ux[1] * dx) / det];
}
export const fromAxes = (a: AxesInfo, c: Pt): Pt => [a.origin[0] + c[0] * a.ux[0] + c[1] * a.uy[0], a.origin[1] + c[0] * a.ux[1] + c[1] * a.uy[1]];

function DraftPreview({ tool, pts, live, toPx }: { tool: Tool; pts: Pt[]; live?: Pt; toPx: (x: number, y: number) => [number, number] }) {
  if (!pts.length) return null;
  const all = live ? [...pts, live] : pts;
  const px = all.map((p) => toPx(...p));
  if (tool === 'circle' && px.length >= 2) {
    const r = Math.hypot(px[1][0] - px[0][0], px[1][1] - px[0][1]);
    return <g className="draft"><circle cx={px[0][0]} cy={px[0][1]} r={r} /><line x1={px[0][0]} y1={px[0][1]} x2={px[1][0]} y2={px[1][1]} /><text className="coord" x={px[1][0] + 8} y={px[1][1] - 8}>r = {fmt(Math.hypot(all[1][0] - all[0][0], all[1][1] - all[0][1]))}</text></g>;
  }
  if (tool === 'rect' && px.length >= 2) {
    const [a, b] = px;
    return <g className="draft"><rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} /><text className="coord" x={b[0] + 8} y={b[1] - 8}>{fmt(Math.abs(all[1][0] - all[0][0]))} × {fmt(Math.abs(all[1][1] - all[0][1]))}</text></g>;
  }
  const d = px.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
  const len = all.length >= 2 ? Math.hypot(all[all.length - 1][0] - all[all.length - 2][0], all[all.length - 1][1] - all[all.length - 2][1]) : 0;
  return (
    <g className="draft">
      <path d={d} />
      {px.slice(0, pts.length).map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={3.5} />)}
      {all.length >= 2 && <text className="coord" x={px[px.length - 1][0] + 8} y={px[px.length - 1][1] - 8}>{fmt(len)}</text>}
    </g>
  );
}

function CanvasMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [onClose]);
  const s = getState();
  const ids = selectedObjectIds();
  const actions = currentActions();
  const groups = ['Couple', 'Connect', 'Measure', 'Annotate', 'Terms'] as const;
  const objs = ids.map((id) => s.doc.objects.find((o) => o.id === id)).filter(Boolean) as SceneObject[];
  const coupled = objs.filter(isCoupled).map((o) => o.id);
  const uncoupled = objs.filter((o) => o.link && !isCoupled(o)).map((o) => o.id);
  const item = (label: string, fn: () => void, hint?: string, key?: string) => (
    <div key={key ?? label} className="menu-item" title={hint} onPointerDown={(e) => { e.stopPropagation(); fn(); onClose(); }}>
      <span>{label}</span>
    </div>
  );
  return (
    <div className="menu canvas-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {groups.map((g) => {
        const list = actions.filter((a: Action) => a.group === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <div className="menu-head">{g}</div>
            {list.map((a) => item(a.label, a.run, a.hint, a.id))}
          </div>
        );
      })}
      <div className="menu-sep" />
      {item('Duplicate', () => duplicateObjects(ids), undefined, 'dup')}
      {coupled.length > 0 && item('Uncouple', () => uncoupleObjects(coupled), 'Pause the relationship: it stays where it is and can be edited freely; Couple again restores it', 'unc')}
      {uncoupled.length > 0 && item('Couple again', () => coupleObjects(uncoupled), 'Restore the paused relationship', 'cpl')}
      {objs.some((o) => o.link) && item('Forget relationship', () => detachObjects(ids), 'Make it an independent object for good (keeps its current place)', 'det')}
      {item('Save as construction…', () => setState({ panel: 'save-construction', panelData: ids }), 'Reuse these objects (with what they are built from) later', 'save')}
      {item('Delete', () => deleteSelection(), undefined, 'del')}
    </div>
  );
}

function ConstructedBox({ name, box, toPx }: { name: string; box: Box; toPx: (x: number, y: number) => [number, number] }) {
  const [x0, y0] = toPx(box[0], box[3]);
  const [x1, y1] = toPx(box[2], box[1]);
  return (
    <g>
      <rect x={x0 - 5} y={y0 - 5} width={x1 - x0 + 10} height={y1 - y0 + 10} className="sel-box constructed" />
      <text x={x0 - 5} y={y0 - 9} className="box-label">{name} · constructed</text>
    </g>
  );
}

function Handles({ name, box, rotation, toPx, onDown, moveOnly, point }: {
  name: string;
  box: Box;
  rotation: number;
  toPx: (x: number, y: number) => [number, number];
  onDown: (e: React.PointerEvent, h: Handle) => void;
  moveOnly?: boolean;
  point?: boolean;
}) {
  const [x0, y0] = toPx(box[0], box[3]);
  const [x1, y1] = toPx(box[2], box[1]);
  const pad = 5;
  const L = x0 - pad, T = y0 - pad, R = x1 + pad, B = y1 + pad;
  const mx = (L + R) / 2, my = (T + B) / 2;
  const small = R - L < 28 || B - T < 28;
  const pts: [Handle, number, number, string][] = [
    ['nw', L, T, 'nwse-resize'], ['ne', R, T, 'nesw-resize'], ['sw', L, B, 'nesw-resize'], ['se', R, B, 'nwse-resize'],
  ];
  if (!small) pts.push(['n', mx, T, 'ns-resize'], ['s', mx, B, 'ns-resize'], ['w', L, my, 'ew-resize'], ['e', R, my, 'ew-resize']);
  const showScale = !moveOnly && !point;
  return (
    <g transform={rotation ? `rotate(${-rotation} ${mx} ${my})` : undefined}>
      <rect x={L} y={T} width={R - L} height={B - T} className="sel-box" onPointerDown={(e) => onDown(e, 'move')} />
      <text x={L} y={T - 8} className="box-label">{name}{moveOnly ? ' · attached' : ''}</text>
      {showScale && (
        <>
          <line x1={mx} y1={T} x2={mx} y2={T - 22} className="rot-stem" />
          <circle cx={mx} cy={T - 26} r={5.5} className="handle rot" onPointerDown={(e) => onDown(e, 'rot')}>
            <title>Rotate (snaps to 15°)</title>
          </circle>
          {pts.map(([h, x, y, cursor]) => (
            <rect key={h} x={x - 4.5} y={y - 4.5} width={9} height={9} className="handle" style={{ cursor }} onPointerDown={(e) => onDown(e, h)}>
              <title>{h.length === 2 ? 'Scale' : 'Stretch'}</title>
            </rect>
          ))}
        </>
      )}
    </g>
  );
}

/** Premiere-style transport under the program monitor. */
function Transport() {
  const time = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  const doc = useStore((s) => s.doc);
  const timeline = useStore((s) => s.timeline);
  const end = sequenceEnd(doc, timeline);
  const pts = editPoints(doc, timeline);
  const go = (t: number) => setState({ time: frameSnap(Math.max(0, Math.min(end, t))), showVideo: false });
  return (
    <div className="transport">
      <span className="tc blue">{timecode(time)}</span>
      <div className="transport-btns">
        <button className="icon" title="Go to start (Home)" onClick={() => go(0)}>⏮</button>
        <button className="icon" title="Previous edit point (↑)" onClick={() => go([...pts].reverse().find((p) => p < time - 1e-6) ?? 0)}>⇤</button>
        <button className="icon" title="Step back one frame (←)" onClick={() => go(time - 1 / fps())}>◀︎</button>
        <button className="icon play" title="Play / pause (Space)" onClick={() => setPlaying(!playing)}>{playing ? '❚❚' : '▶'}</button>
        <button className="icon" title="Step forward one frame (→)" onClick={() => go(time + 1 / fps())}>▶︎</button>
        <button className="icon" title="Next edit point (↓)" onClick={() => go(pts.find((p) => p > time + 1e-6) ?? end)}>⇥</button>
        <button className="icon" title="Go to end (End)" onClick={() => go(end)}>⏭</button>
      </div>
      <span className="tc">{timecode(end)}</span>
    </div>
  );
}

function Grid({ toPx, cam }: { toPx: (x: number, y: number) => [number, number]; cam: { center: [number, number]; width: number; height: number } }) {
  const lines = [];
  const x0 = Math.floor(cam.center[0] - cam.width / 2), x1 = Math.ceil(cam.center[0] + cam.width / 2);
  const y0 = Math.floor(cam.center[1] - cam.height / 2), y1 = Math.ceil(cam.center[1] + cam.height / 2);
  for (let x = x0; x <= x1; x++) {
    const [px] = toPx(x, 0);
    lines.push(<line key={'x' + x} x1={px} x2={px} y1={0} y2="100%" className={x === 0 ? 'grid axis' : 'grid'} />);
  }
  for (let y = y0; y <= y1; y++) {
    const [, py] = toPx(0, y);
    lines.push(<line key={'y' + y} y1={py} y2={py} x1={0} x2="100%" className={y === 0 ? 'grid axis' : 'grid'} />);
  }
  return <g>{lines}</g>;
}

const area = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1]);
