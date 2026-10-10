import { useEffect, useRef, useState } from 'react';
import { addAnimation, addObject, fmt, getState, moveObject, previewMove, setPreviewWidth, requestFrame, setState, useStore } from '../store';
import type { ObjInfo } from '../types';
import { DND_TYPE, type DragPayload } from './Library';

interface Drag {
  id: string;
  start: [number, number];
  center: [number, number] | null;
  box: [number, number, number, number];
  delta: [number, number];
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
      const w = Math.max(100, Math.min(r.width - 24, (r.height - 24) * aspect));
      setSize({ w, h: w / aspect });
      const px = Math.min(1920, Math.round((w * devicePixelRatio) / 160) * 160);
      setPreviewWidth(px);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  useEffect(() => {
    requestFrame();
  }, [size.w]);

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

  const playing = useStore((s) => s.playing);
  const time = useStore((s) => s.time);
  // Keep the preview video in sync with the playhead.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !showVideo) return;
    const s = getState();
    if (playing) {
      if (Math.abs(v.currentTime - s.time) > 0.25) v.currentTime = s.time;
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

  const selectedId = selection?.kind === 'object' ? selection.id : null;
  const error = frame?.error;

  return (
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
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ id: hit.id, start: p, center: hit.center, box: hit.box!, delta: [0, 0], moved: false });
          }}
          onPointerMove={(e) => {
            const p = localPoint(e, e.currentTarget);
            if (!drag) return setHover(hitTest(p)?.id ?? null);
            let dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
            if (snap && drag.center) {
              const [sx, sy] = snapPt([drag.center[0] + dx, drag.center[1] + dy]);
              dx = sx - drag.center[0];
              dy = sy - drag.center[1];
            }
            const moved = drag.moved || Math.hypot(dx, dy) > 0.02;
            if (moved && (dx !== drag.delta[0] || dy !== drag.delta[1])) previewMove(drag.id, dx, dy, drag.center);
            setDrag({ ...drag, delta: [dx, dy], moved });
          }}
          onPointerUp={() => {
            if (drag?.moved) moveObject(drag.id, drag.delta[0], drag.delta[1], drag.center);
            setDrag(null);
          }}
          onPointerCancel={() => {
            setState({ previewDoc: null });
            setDrag(null);
          }}
        >
          {(drag?.moved || dropPoint) && <Grid toPx={toPx} cam={cam} />}
          {visible.map((o) => {
            const isSel = o.id === selectedId;
            if (!isSel && o.id !== hover) return null;
            const b = drag?.id === o.id ? shift(drag.box, drag.delta) : o.box!;
            const [x0, y0] = toPx(b[0], b[3]);
            const [x1, y1] = toPx(b[2], b[1]);
            return (
              <g key={o.id}>
                <rect x={x0 - 4} y={y0 - 4} width={x1 - x0 + 8} height={y1 - y0 + 8} className={isSel ? 'sel-box' : 'hover-box'} />
                <text x={x0 - 4} y={y0 - 8} className="box-label">{o.name}</text>
              </g>
            );
          })}
          {drag?.moved && drag.center && (
            <text className="coord" x={toPx(drag.center[0] + drag.delta[0], 0)[0] + 8} y={toPx(0, drag.center[1] + drag.delta[1])[1] - 8}>
              {record ? '● animate to ' : ''}({fmt(drag.center[0] + drag.delta[0])}, {fmt(drag.center[1] + drag.delta[1])})
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
          if (error.kind === 'step' && error.id) setState({ selection: { kind: 'step', id: error.id } });
          if (error.kind === 'header') setState({ panel: 'code' });
        }}>
          <b>Error</b> {error.message}
        </div>
      )}
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
const shift = (b: [number, number, number, number], d: [number, number]): [number, number, number, number] => [b[0] + d[0], b[1] + d[1], b[2] + d[0], b[3] + d[1]];
