import { useEffect, useRef, useState } from 'react';
import {
  addAnimation, addObject, commitTransform, editPoints, fmt, fps, frameSnap, getState, previewTransform, requestFrame, sequenceEnd,
  setPlaying, setPreviewWidth, setState, timecode, type TransformDelta, useStore,
} from '../store';
import type { ObjInfo } from '../types';
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);
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

  // Keep the preview video in sync with the playhead.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !showVideo) return;
    if (playing) {
      if (Math.abs(v.currentTime - getState().time) > 0.25) v.currentTime = getState().time;
      void v.play();
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
  const snapPt = ([x, y]: [number, number]): [number, number] =>
    snap ? [Math.round(x * 4) / 4, Math.round(y * 4) / 4] : [Math.round(x * 100) / 100, Math.round(y * 100) / 100];

  const visible = (frame?.objects ?? []).filter((o) => o.visible && o.box);
  const hitTest = (p: [number, number]): ObjInfo | undefined => {
    const pad = 0.1;
    const hits = visible.filter(({ box }) => p[0] >= box![0] - pad && p[0] <= box![2] + pad && p[1] >= box![1] - pad && p[1] <= box![3] + pad);
    hits.sort((a, b) => area(a.box!) - area(b.box!));
    return hits[0];
  };

  const selectedId = selection?.kind === 'object' ? selection.id : null;
  const selInfo = visible.find((o) => o.id === selectedId);
  const error = frame?.error;

  const beginDrag = (e: React.PointerEvent, info: ObjInfo, handle: Handle) => {
    e.stopPropagation();
    const svg = (e.currentTarget as Element).closest('svg')!;
    svg.setPointerCapture(e.pointerId);
    const b = info.box!;
    const center: [number, number] = info.center ?? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
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

  // Box shown while dragging: the start box transformed by the current delta.
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

  return (
    <div className="monitor">
      <div className="monitor-title">
        <span>Program: {doc.scene.name}</span>
        {record && <span className="rec-badge">● REC</span>}
        <span className="spacer" />
        {showVideo && <span className="muted small">Smooth preview (manim render)</span>}
      </div>
      <div className="viewport" ref={wrapRef}>
        <div
          className="stage"
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
          {showVideo && video?.url && <video ref={videoRef} className="frame" src={video.url} muted playsInline />}
          <svg
            className="overlay"
            width={size.w}
            height={size.h}
            onPointerDown={(e) => {
              const p = localPoint(e, e.currentTarget);
              const hit = hitTest(p);
              if (!hit) return setState({ selection: null });
              setState({ selection: { kind: 'object', id: hit.id } });
              beginDrag(e, hit, 'move');
            }}
            onPointerMove={(e) => {
              const p = localPoint(e, e.currentTarget);
              if (!drag) return setHover(hitTest(p)?.id ?? null);
              const delta = computeDelta(drag, p, e.shiftKey);
              const moved = drag.moved || Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) > 0.03;
              if (moved && JSON.stringify(delta) !== JSON.stringify(drag.delta)) previewTransform(drag.id, delta, drag.center);
              setDrag({ ...drag, delta, moved });
            }}
            onPointerUp={() => {
              if (drag?.moved) commitTransform(drag.id, drag.delta, drag.center);
              else setState({ previewDoc: null });
              setDrag(null);
            }}
            onPointerCancel={() => {
              setState({ previewDoc: null });
              setDrag(null);
            }}
            onDoubleClick={() => (document.querySelector('.inspector .content') as HTMLElement | null)?.focus()}
          >
            {(drag?.moved || dropPoint) && <Grid toPx={toPx} cam={cam} />}
            {visible.map((o) => {
              if (o.id === selectedId || o.id !== hover) return null;
              const [x0, y0] = toPx(o.box![0], o.box![3]);
              const [x1, y1] = toPx(o.box![2], o.box![1]);
              return <rect key={o.id} x={x0 - 4} y={y0 - 4} width={x1 - x0 + 8} height={y1 - y0 + 8} className="hover-box" />;
            })}
            {selInfo && (
              <Handles
                name={selInfo.name}
                box={drag?.id === selInfo.id ? dragBox(drag) : selInfo.box!}
                rotation={drag?.id === selInfo.id ? drag.delta.rotate ?? 0 : 0}
                toPx={toPx}
                onDown={(e, h) => beginDrag(e, selInfo, h)}
              />
            )}
            {drag?.moved && (
              <text className="coord" x={toPx(...drag.center)[0] + 10} y={toPx(...drag.center)[1] - 10}>
                {record ? '● ' : ''}{deltaLabel(drag)}
              </text>
            )}
            {dropPoint && (
              <g>
                <circle cx={toPx(...dropPoint)[0]} cy={toPx(...dropPoint)[1]} r={5} className="drop-dot" />
                <text className="coord" x={toPx(...dropPoint)[0] + 8} y={toPx(...dropPoint)[1] - 8}>({fmt(dropPoint[0])}, {fmt(dropPoint[1])})</text>
              </g>
            )}
          </svg>
          {doc.objects.length === 0 && !dropPoint && (
            <div className="empty-hint">Drag a manim object here<br /><span className="muted">e.g. Circle, MathTex, Axes</span></div>
          )}
        </div>
        {error && (
          <div className="error-bar" onClick={() => {
            if (error.kind === 'object' && error.id) setState({ selection: { kind: 'object', id: error.id } });
            if (error.kind === 'clip' && error.id) setState({ selection: { kind: 'clips', ids: [error.id] } });
            if (error.kind === 'header') setState({ panel: 'code' });
          }}>
            <b>Error</b> {error.message}
          </div>
        )}
      </div>
      <Transport />
    </div>
  );
}

function Handles({ name, box, rotation, toPx, onDown }: {
  name: string;
  box: Box;
  rotation: number;
  toPx: (x: number, y: number) => [number, number];
  onDown: (e: React.PointerEvent, h: Handle) => void;
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
  return (
    <g transform={rotation ? `rotate(${-rotation} ${mx} ${my})` : undefined}>
      <rect x={L} y={T} width={R - L} height={B - T} className="sel-box" onPointerDown={(e) => onDown(e, 'move')} />
      <text x={L} y={T - 8} className="box-label">{name}</text>
      <line x1={mx} y1={T} x2={mx} y2={T - 22} className="rot-stem" />
      <circle cx={mx} cy={T - 26} r={5.5} className="handle rot" onPointerDown={(e) => onDown(e, 'rot')}>
        <title>Rotate (snaps to 15°)</title>
      </circle>
      {pts.map(([h, x, y, cursor]) => (
        <rect key={h} x={x - 4.5} y={y - 4.5} width={9} height={9} className="handle" style={{ cursor }} onPointerDown={(e) => onDown(e, h)}>
          <title>{h.length === 2 ? 'Scale' : 'Stretch'}</title>
        </rect>
      ))}
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
