import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  addAnimation, addClip, addMarker, addObject, addTrack, addTrackTo, clipDuration, deleteSelection, docKey, fps, previewFresh,
  frameSnap, getState, isLocked, parseTimecode, selectClips, sequenceEnd, setPlaying, setState, timecode, toast, trackIsFree, uid,
  selectedObjectIds, updateDoc, useStore,
} from '../store';
import type { Clip, SceneDoc } from '../types';
import { DND_TYPE, type DragPayload } from './Library';
import { ratePath } from './rates';

const ROW = 48; // track height
const RULER = 30;
const HEAD = 168; // track header width
const SNAP_PX = 8;

const CAT_COLORS: Record<string, string> = {
  Creation: '#3d7a59',
  Growing: '#4d7a37',
  Fading: '#2c6e7a',
  Transform: '#5b4a8c',
  Indication: '#8c6a26',
  Movement: '#2f5c8c',
  Rotation: '#2f5c8c',
  Numbers: '#6c4a80',
  Changing: '#6c4a80',
  Specialized: '#7a3f5c',
};

type Drag =
  | { mode: 'move'; ids: string[]; x0: number; y0: number; dt: number; drow: number; alt: boolean; moved: boolean }
  | { mode: 'trim-start' | 'trim-end'; id: string; x0: number; dt: number }
  | { mode: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: string[] }
  | { mode: 'scrub' };

export function Timeline() {
  const doc = useStore((s) => s.doc);
  const timeline = useStore((s) => s.timeline);
  const time = useStore((s) => s.time);
  const selection = useStore((s) => s.selection);
  const view = useStore((s) => s.view);
  const snapOn = useStore((s) => s.timelineSnap);
  const targetTrack = useStore((s) => s.targetTrack);
  const catalog = useStore((s) => s.catalog);
  const error = useStore((s) => s.frame?.error ?? s.timeline?.error);
  const diagnostics = useStore((s) => (s.timeline ?? s.frame)?.diagnostics);
  const bodyRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const [laneW, setLaneW] = useState(800);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [guide, setGuide] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ t: number; row: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; clip: Clip } | null>(null);

  const { pps, start: v0 } = view;
  const rows = [...doc.tracks].reverse(); // V1 at the bottom, like Premiere
  const selected = new Set(selection?.kind === 'clips' ? selection.ids : []);
  const end = sequenceEnd(doc, timeline);
  const x = (t: number) => (t - v0) * pps;

  useLayoutEffect(() => {
    const el = laneRef.current!;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the playhead in view while playing.
  useEffect(() => {
    const visible = laneW / pps;
    if (getState().playing && (time > v0 + visible * 0.95 || time < v0)) setView({ start: Math.max(0, time - visible * 0.1) });
  }, [time]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeAt = (clientX: number) => {
    const r = laneRef.current!.getBoundingClientRect();
    return Math.max(0, v0 + (clientX - r.left) / pps);
  };
  const rowAt = (clientY: number) => {
    const r = laneRef.current!.getBoundingClientRect();
    return Math.floor((clientY - r.top - RULER + bodyRef.current!.scrollTop) / ROW);
  };

  // ------------------------------------------------------------ zoom / scroll
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      const t = timeAt(e.clientX);
      const k = Math.exp(-e.deltaY * 0.0025);
      const npps = clamp(pps * k, 4, 4000);
      setView({ pps: npps, start: Math.max(0, t - (t - v0) * (pps / npps)) });
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey || !overflowY()) {
      setView({ start: Math.max(0, v0 + (e.deltaX || e.deltaY) / pps) });
    }
  };
  const overflowY = () => !!bodyRef.current && bodyRef.current.scrollHeight > bodyRef.current.clientHeight + 1;

  // ------------------------------------------------------------ snapping
  const snapPoints = (exclude: Set<string>) => {
    const pts = [0, time, ...(doc.markers ?? []).map((m) => m.time)];
    for (const c of doc.clips) if (!exclude.has(c.id)) pts.push(c.start, c.start + clipDuration(c, timeline));
    return pts;
  };
  const snapDt = (edges: number[], dt: number, exclude: Set<string>) => {
    const quant = (v: number) => Math.round(v * fps()) / fps();
    if (!snapOn) return { dt: quant(dt), guide: null };
    let best: { d: number; p: number } | null = null;
    for (const p of snapPoints(exclude))
      for (const e of edges) {
        const d = p - (e + dt);
        if (Math.abs(d) * pps < SNAP_PX && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, p };
      }
    return best ? { dt: dt + best.d, guide: best.p } : { dt: quant(dt), guide: null };
  };

  // ------------------------------------------------------------ pointer handling
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current!;
      if (d.mode === 'scrub') return setState({ time: frameSnap(timeAt(e.clientX)), showVideo: false });
      if (d.mode === 'marquee') {
        const r = laneRef.current!.getBoundingClientRect();
        const nx = e.clientX - r.left, ny = e.clientY - r.top + bodyRef.current!.scrollTop;
        const t0 = v0 + Math.min(d.x0, nx) / pps, t1 = v0 + Math.max(d.x0, nx) / pps;
        const r0 = Math.floor((Math.min(d.y0, ny) - RULER) / ROW), r1 = Math.floor((Math.max(d.y0, ny) - RULER) / ROW);
        const hit = doc.clips.filter((c) => {
          const ri = rows.findIndex((t) => t.id === c.track);
          return ri >= r0 && ri <= r1 && c.start < t1 && c.start + Math.max(clipDuration(c, timeline), 2 / pps) > t0;
        }).map((c) => c.id);
        selectClips([...new Set([...d.base, ...hit])]);
        return setDrag({ ...d, x1: nx, y1: ny });
      }
      const raw = (e.clientX - d.x0) / pps;
      if (d.mode === 'move') {
        const moving = doc.clips.filter((c) => d.ids.includes(c.id));
        const edges = [Math.min(...moving.map((c) => c.start)), Math.max(...moving.map((c) => c.start + clipDuration(c, timeline)))];
        const minStart = Math.min(...moving.map((c) => c.start));
        let { dt, guide: g } = snapDt(edges, raw, new Set(d.ids));
        dt = Math.max(dt, -minStart);
        const drow = Math.round((e.clientY - d.y0) / ROW);
        setGuide(g);
        return setDrag({ ...d, dt, drow, alt: e.altKey, moved: d.moved || Math.abs(e.clientX - d.x0) > 3 || Math.abs(e.clientY - d.y0) > 3 });
      }
      const c = doc.clips.find((k) => k.id === d.id)!;
      const edge = d.mode === 'trim-start' ? c.start : c.start + c.duration;
      const { dt, guide: g } = snapDt([edge], raw, new Set([c.id]));
      setGuide(g);
      setDrag({ ...d, dt });
    };
    const up = () => {
      const d = dragRef.current!;
      setDrag(null);
      setGuide(null);
      if (d.mode === 'move' && d.moved) commitMove(d);
      if (d.mode === 'trim-start' || d.mode === 'trim-end') commitTrim(d);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Row a moved clip lands on: the one it's dropped on when that's free (and unlocked), else the nearest
   * free row above it, else a new track on top (-1). The drag ghost shows exactly this.
   */
  const landingRow = (d: SceneDoc, ri: number, start: number, dur: number, ignore: Set<string>): number => {
    const free = (r: number) => !rows[r].locked && trackIsFree(d, rows[r].id, start, start + Math.max(dur, 0.05), ignore);
    for (let r = Math.min(ri, rows.length - 1); r >= 0; r--) if (free(r)) return r;
    return -1;
  };

  const trimBounds = (c: Clip) => {
    const others = doc.clips.filter((k) => k.track === c.track && k.id !== c.id);
    const prevEnd = Math.max(0, ...others.filter((k) => k.start + k.duration <= c.start + 1e-6).map((k) => k.start + k.duration));
    const nextStart = Math.min(Infinity, ...others.filter((k) => k.start >= c.start + c.duration - 1e-6).map((k) => k.start));
    return { prevEnd, nextStart };
  };

  const trimmed = (c: Clip, d: Extract<Drag, { mode: 'trim-start' | 'trim-end' }>) => {
    const { prevEnd, nextStart } = trimBounds(c);
    const minDur = 1 / fps();
    if (d.mode === 'trim-start') {
      const s = clamp(c.start + d.dt, prevEnd, c.start + c.duration - minDur);
      return { start: s, duration: c.start + c.duration - s };
    }
    const e = clamp(c.start + c.duration + d.dt, c.start + minDur, nextStart);
    return { start: c.start, duration: e - c.start };
  };

  function commitTrim(d: Extract<Drag, { mode: 'trim-start' | 'trim-end' }>) {
    if (!d.dt) return;
    const c = doc.clips.find((k) => k.id === d.id)!;
    const r = trimmed(c, d);
    updateDoc((nd) => Object.assign(nd.clips.find((k) => k.id === c.id)!, { start: round(r.start), duration: round(r.duration) }));
  }

  function commitMove(d: Extract<Drag, { mode: 'move' }>) {
    if (!d.dt && !d.drow) return;
    const newIds: string[] = [];
    updateDoc((nd) => {
      const list = nd.clips.filter((c) => d.ids.includes(c.id));
      const placed = new Set<string>();
      let newTrack: string | null = null;
      for (const orig of list) {
        const c = d.alt ? { ...structuredClone(orig), id: uid('c') } : orig;
        c.start = round(Math.max(0, orig.start + d.dt));
        const ignore = new Set([...(d.alt ? [] : list.map((k) => k.id).filter((id) => !placed.has(id)))]);
        const row = landingRow(nd, rows.findIndex((t) => t.id === orig.track) + d.drow, c.start, c.duration, ignore);
        c.track = row < 0 ? (newTrack ??= addTrackTo(nd).id) : rows[row].id;
        placed.add(orig.id);
        if (d.alt) {
          nd.clips.push(c);
          newIds.push(c.id);
        }
      }
    });
    if (newIds.length) selectClips(newIds);
  }

  const onClipDown = (e: React.PointerEvent, c: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (isLocked(doc, c)) return;
    const multi = e.shiftKey || e.metaKey || e.ctrlKey;
    let ids = selection?.kind === 'clips' ? selection.ids : [];
    if (multi) ids = ids.includes(c.id) ? ids.filter((i) => i !== c.id) : [...ids, c.id];
    else if (!ids.includes(c.id)) ids = [c.id];
    selectClips(ids);
    if (multi && !ids.includes(c.id)) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const trimmable = c.kind === 'anim' || c.kind === 'hold' || (c.kind === 'couple' && c.duration > 0);
    if (trimmable && e.clientX - rect.left < 7 && rect.width > 18) return setDrag({ mode: 'trim-start', id: c.id, x0: e.clientX, dt: 0 });
    if (trimmable && rect.right - e.clientX < 7) return setDrag({ mode: 'trim-end', id: c.id, x0: e.clientX, dt: 0 });
    setDrag({ mode: 'move', ids, x0: e.clientX, y0: e.clientY, dt: 0, drow: 0, alt: e.altKey, moved: false });
  };

  const onLaneDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setMenu(null);
    const r = laneRef.current!.getBoundingClientRect();
    const y = e.clientY - r.top + bodyRef.current!.scrollTop;
    if (y < RULER) {
      setPlaying(false);
      setState({ time: frameSnap(timeAt(e.clientX)), showVideo: false });
      return setDrag({ mode: 'scrub' });
    }
    const base = e.shiftKey && selection?.kind === 'clips' ? selection.ids : [];
    if (!e.shiftKey) setState({ selection: null });
    setDrag({ mode: 'marquee', x0: e.clientX - r.left, y0: y, x1: e.clientX - r.left, y1: y, base });
  };

  // ------------------------------------------------------------ library drops
  const dropTime = (clientX: number) => {
    const t = timeAt(clientX);
    return frameSnap(t + snapDt([t], 0, new Set()).dt);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    setDropAt({ t: dropTime(e.clientX), row: rowAt(e.clientY) });
  };
  const onDrop = (e: React.DragEvent) => {
    setDropAt(null);
    const raw = e.dataTransfer.getData(DND_TYPE);
    if (!raw) return;
    e.preventDefault();
    const p = JSON.parse(raw) as DragPayload;
    const t = dropTime(e.clientX);
    const row = rowAt(e.clientY);
    const track = rows[row]?.id;
    const s = getState();
    const sel = s.selection?.kind === 'object' ? s.doc.objects.find((o) => o.id === (s.selection as { id: string }).id) : undefined;
    if (p.kind === 'mobject') return addObject(p.name, [0, 0], sel?.name, { start: t, track });
    const target = sel?.name ?? s.doc.objects[s.doc.objects.length - 1]?.name;
    if (!target) return setState({ toast: 'Add an object first, then drop animations' });
    addAnimation(p.name, target, { start: t, track });
    if (!sel) toast(`${p.name} animates ${target}, the newest object. Select an object first to target it, or change it in Effect Controls`);
  };

  // ------------------------------------------------------------ ruler
  const visible = laneW / pps;
  const { major, minor } = tickSteps(pps);
  const ticks: { t: number; major: boolean }[] = [];
  for (let t = Math.floor(v0 / minor) * minor; t <= v0 + visible + minor; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ticks.push({ t, major: isMajor });
  }

  // ------------------------------------------------------------ layout of clips (with drag ghosts)
  const layout = (c: Clip): { start: number; dur: number; row: number; ghost?: boolean; pushed?: boolean } => {
    let start = c.start, dur = clipDuration(c, timeline), row = rows.findIndex((t) => t.id === c.track);
    if (drag?.mode === 'move' && drag.moved && drag.ids.includes(c.id) && !drag.alt) {
      start = Math.max(0, start + drag.dt);
      return { start, dur, row: landingRow(doc, row + drag.drow, start, dur, new Set(drag.ids)), ghost: true };
    }
    if ((drag?.mode === 'trim-start' || drag?.mode === 'trim-end') && drag.id === c.id) {
      const r = trimmed(c, drag);
      return { start: r.start, dur: r.duration, row, ghost: true };
    }
    // Code clips run after everything that started before them, so show where they really run.
    const ran = c.kind === 'code' ? timeline?.steps.find((m) => m.id === c.id)?.start : undefined;
    if (ran !== undefined && ran > c.start + 1 / fps()) return { start: ran, dur, row, pushed: true };
    return { start, dur, row };
  };
  const altGhosts = drag?.mode === 'move' && drag.moved && drag.alt ? doc.clips.filter((c) => drag.ids.includes(c.id)) : [];
  const altRow = (c: Clip, d: Extract<Drag, { mode: 'move' }>) =>
    landingRow(doc, rows.findIndex((t) => t.id === c.track) + d.drow, Math.max(0, c.start + d.dt), clipDuration(c, timeline), new Set());
  const newTrackRow = drag?.mode === 'move' && drag.moved && doc.clips.some((c) => drag.ids.includes(c.id) && (drag.alt ? altRow(c, drag) : layout(c).row) < 0);

  const totalH = RULER + (rows.length + (newTrackRow ? 1 : 0)) * ROW + 24;
  const rowTop = (r: number) => RULER + (r + (newTrackRow ? 1 : 0)) * ROW;

  const renderClip = (c: Clip, l: ReturnType<typeof layout>, key: string, extraClass = '') => {
    const w = Math.max(l.dur * pps, 0);
    const instant = c.kind === 'add' || c.kind === 'remove' || c.kind === 'uncouple' || (c.kind === 'couple' && !(c.duration > 0));
    const left = x(l.start);
    if (left + w < -40 || left > laneW + 40) return null;
    const color = clipColor(c, catalog?.animations);
    const label = clipLabel(c);
    const warn = diagnostics?.find((x) => x.id === c.id && x.kind === 'clip');
    return (
      <div
        key={key}
        className={`clip ${c.kind} ${instant ? 'instant' : ''} ${selected.has(c.id) ? 'sel' : ''} ${c.disabled ? 'disabled' : ''} ${error?.id === c.id ? 'err' : ''} ${l.ghost ? 'ghost' : ''} ${l.pushed ? 'pushed' : ''} ${warn && !l.ghost ? 'warn' : ''} ${extraClass}`}
        style={{ left: instant ? left - 7 : left, width: instant ? 14 : Math.max(w, 3), top: rowTop(l.row) + 3, height: ROW - 6, ['--clip' as string]: color }}
        title={`${label.title}\n${timecode(l.start)} → ${timecode(l.start + l.dur)}  (${l.dur.toFixed(2)}s)${l.pushed ? `\nPlaced at ${timecode(c.start)} but runs later: clips that start before it must finish first` : ''}${warn ? `\n⚠ ${warn.message}` : ''}`}
        onPointerDown={(e) => onClipDown(e, c)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!selected.has(c.id)) selectClips([c.id]);
          setMenu({ x: e.clientX, y: e.clientY, clip: c });
        }}
        onDoubleClick={() => setState({ time: frameSnap(c.start + clipDuration(c, timeline)), showVideo: false })}
      >
        {!instant && (
          <>
            <div className="clip-head">
              {warn && <span className="clip-warn">!</span>}
              {c.kind === 'anim' && <span className="fx">fx</span>}
              <span className="clip-name">{label.name}</span>
              {label.sub && <span className="clip-sub">{label.sub}</span>}
            </div>
            {c.kind === 'anim' && w > 24 && (
              <svg className="rate" width={w} height={ROW - 26} preserveAspectRatio="none">
                <path d={ratePath(c.args?.rate_func, w, ROW - 28)} />
              </svg>
            )}
            {c.kind === 'code' && <div className="code-peek">{(c.code ?? '').split('\n').filter((s) => s.trim() && !s.trim().startsWith('#'))[0] ?? ''}</div>}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="timeline" data-tour="timeline" tabIndex={0} aria-label="Timeline" onWheel={onWheel}
      onPointerDownCapture={(e) => {
        if (!(e.target as Element).closest('button, input, select, textarea')) e.currentTarget.focus({ preventScroll: true });
      }}>
      <div className="tl-header">
        <div className="seq-tab">{doc.scene.name}</div>
        <TimecodeInput value={time} onChange={(t) => setState({ time: t, showVideo: false })} />
        <div className="tl-tools">
          <button className={`tool ${snapOn ? 'on' : ''}`} title="Snap in timeline (S)" onClick={() => setState({ timelineSnap: !snapOn })}>
            <MagnetIcon />
          </button>
          <button className="tool" title="Add marker (M)" onClick={() => addMarker()}>
            <svg width="12" height="14" viewBox="0 0 12 14"><path d="M1 1h10v8l-5 4-5-4z" fill="currentColor" /></svg>
          </button>
          <span className="sep" />
          <button className="ghost small" onClick={() => addClip('code')} title="Raw manim code at the playhead">+ Code</button>
          <button className="ghost small" onClick={() => addClip('hold')} title="Hold (extends the scene, like self.wait)">+ Hold</button>
          <button className="ghost small" onClick={() => addClip('add')} title="self.add(...) at the playhead">+ Add</button>
          <button className="ghost small" onClick={() => addClip('remove')} title="self.remove(...) at the playhead">+ Remove</button>
          <button className="ghost small" onClick={() => addClip('uncouple', { targets: selectedObjectIds().map((id) => doc.objects.find((o) => o.id === id)?.name ?? '').filter(Boolean) })} title="Uncouple objects at the playhead: they stay where they are and can be animated freely">+ Uncouple</button>
          <button className="ghost small" onClick={() => addClip('couple', { targets: selectedObjectIds().map((id) => doc.objects.find((o) => o.id === id)?.name ?? '').filter(Boolean) })} title="Couple objects again at the playhead (give it a duration to glide back into place)">+ Couple</button>
        </div>
        <div className="spacer" />
        <span className="muted small mono">{timecode(end)}</span>
        <button className="ghost small" title="Zoom to fit (\)" onClick={() => zoomToFit(laneW)}>Fit</button>
      </div>

      <div className="tl-body" ref={bodyRef}>
        <div className="tl-grid" style={{ height: totalH }}>
          <div className="tl-heads">
            <div className="tl-corner" style={{ height: RULER }}>
              <button className="ghost small" title="Add track" onClick={addTrack}>+ Track</button>
            </div>
            {newTrackRow && <div className="track-head new" style={{ height: ROW }}>new track</div>}
            {rows.map((t) => (
              <div key={t.id} className={`track-head ${targetTrack === t.id ? 'target' : ''} ${t.hidden ? 'off' : ''}`} style={{ height: ROW }}>
                <button className={`th-btn ${t.hidden ? '' : 'on'}`} title="Toggle track output" onClick={() => updateDoc((d) => void (d.tracks.find((k) => k.id === t.id)!.hidden = !t.hidden))}>
                  {t.hidden ? <EyeOffIcon /> : <EyeIcon />}
                </button>
                <button className={`th-btn ${t.locked ? 'lock' : ''}`} title="Toggle track lock" onClick={() => updateDoc((d) => void (d.tracks.find((k) => k.id === t.id)!.locked = !t.locked))}>
                  <LockIcon open={!t.locked} />
                </button>
                <button className="th-name" title="Target this track for new clips" onClick={() => setState({ targetTrack: targetTrack === t.id ? null : t.id })}>
                  {t.name}
                </button>
                <span className="th-count">{doc.clips.filter((c) => c.track === t.id).length || ''}</span>
              </div>
            ))}
          </div>

          <div className="tl-lanes" ref={laneRef} onPointerDown={onLaneDown} onDragOver={onDragOver} onDragLeave={() => setDropAt(null)} onDrop={onDrop}>
            <div className="ruler" style={{ height: RULER }}>
              {ticks.map(({ t, major: mj }) => (
                <div key={t.toFixed(4)} className={`tick ${mj ? 'major' : ''}`} style={{ left: x(t) }}>
                  {mj && <span>{timecode(t)}</span>}
                </div>
              ))}
              {(doc.markers ?? []).map((m) => (
                <div
                  key={m.id}
                  className="marker"
                  style={{ left: x(m.time) }}
                  title="Marker: click to jump, Alt-click to delete"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.altKey) updateDoc((d) => void (d.markers = (d.markers ?? []).filter((k) => k.id !== m.id)));
                    else setState({ time: m.time, showVideo: false });
                  }}
                />
              ))}
              <div className="end-mark" style={{ left: x(end) }} title="Sequence end" />
              <RenderBar left={x(0)} width={end * pps} />
            </div>
            {rows.map((t, r) => (
              <div key={t.id} className={`lane-row ${t.locked ? 'locked' : ''} ${t.hidden ? 'off' : ''}`} style={{ top: rowTop(r), height: ROW }} />
            ))}
            {doc.clips.map((c) => renderClip(c, layout(c), c.id))}
            {altGhosts.map((c) => {
              const d = drag as Extract<Drag, { mode: 'move' }>;
              return renderClip(c, { start: Math.max(0, c.start + d.dt), dur: clipDuration(c, timeline), row: altRow(c, d), ghost: true }, 'alt' + c.id, 'copy');
            })}
            {drag?.mode === 'marquee' && (
              <div className="marquee" style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }} />
            )}
            {dropAt && dropAt.row >= 0 && dropAt.row < rows.length && (
              <div className="drop-ind" style={{ left: x(dropAt.t), top: rowTop(dropAt.row), height: ROW }} />
            )}
            {guide !== null && <div className="snap-guide" style={{ left: x(guide), height: totalH }} />}
            <div className="playhead" style={{ left: x(time), height: totalH }}>
              <div className="playhead-cap" />
            </div>
          </div>
        </div>
      </div>

      <ZoomBar laneW={laneW} end={end} />
      {menu && <ClipMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Premiere-style render bar: green = smooth preview ready, yellow = rendering, red = live frames only. */
function RenderBar({ left, width }: { left: number; width: number }) {
  const video = useStore((s) => s.video);
  const fresh = useStore((s) => previewFresh(s));
  const rendering = !fresh && !!video && (video.state === 'running' || video.state === 'queued') && video.key === docKey(getState().doc);
  return (
    <div className={`render-bar ${fresh ? 'ok' : rendering ? 'busy' : 'stale'}`} style={{ left, width }} title={fresh ? 'Preview rendered: plays smoothly' : rendering ? `Rendering preview… ${Math.round((video?.progress ?? 0) * 100)}%` : 'Not rendered: plays live (lower frame rate)'}>
      {rendering && <div className="render-progress" style={{ width: `${(video?.progress ?? 0) * 100}%` }} />}
    </div>
  );
}

function setView(patch: Partial<{ pps: number; start: number }>) {
  setState((s) => ({ view: { ...s.view, ...patch } }));
}

export function zoomToFit(laneW = 800) {
  const s = getState();
  const end = Math.max(2, sequenceEnd(s.doc, s.timeline));
  setView({ pps: clamp((laneW - 40) / end, 4, 4000), start: 0 });
}

export function zoomBy(k: number) {
  const s = getState();
  const npps = clamp(s.view.pps * k, 4, 4000);
  const t = s.time;
  setView({ pps: npps, start: Math.max(0, t - (t - s.view.start) * (s.view.pps / npps)) });
}

/** Premiere-style zoom scroll bar: drag the thumb to scroll, its ends to zoom. */
function ZoomBar({ laneW, end }: { laneW: number; end: number }) {
  const view = useStore((s) => s.view);
  const ref = useRef<HTMLDivElement>(null);
  const visible = laneW / view.pps;
  const total = Math.max(end + 5, view.start + visible, 10);
  const W = ref.current?.clientWidth ?? 600;
  const left = (view.start / total) * W;
  const width = Math.max(24, (visible / total) * W);
  const down = (e: React.PointerEvent, mode: 'pan' | 'l' | 'r') => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const s0 = view.start, vis0 = visible;
    const move = (ev: PointerEvent) => {
      const dt = ((ev.clientX - x0) / W) * total;
      if (mode === 'pan') setView({ start: Math.max(0, s0 + dt) });
      else if (mode === 'r') setView({ pps: clamp(laneW / Math.max(0.2, vis0 + dt), 4, 4000) });
      else {
        const ns = clamp(s0 + dt, 0, s0 + vis0 - 0.2);
        setView({ start: ns, pps: clamp(laneW / (s0 + vis0 - ns), 4, 4000) });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  };
  return (
    <div className="zoombar" ref={ref} style={{ marginLeft: HEAD }}>
      <div className="zb-thumb" style={{ left, width }} onPointerDown={(e) => down(e, 'pan')}>
        <span className="zb-end l" onPointerDown={(e) => down(e, 'l')} />
        <span className="zb-end r" onPointerDown={(e) => down(e, 'r')} />
      </div>
    </div>
  );
}

function ClipMenu({ x, y, clip, onClose }: { x: number; y: number; clip: Clip; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [onClose]);
  const s = getState();
  const item = (label: string, fn: () => void, hint?: string) => (
    <div className="menu-item" onPointerDown={(e) => { e.stopPropagation(); fn(); onClose(); }}>
      <span>{label}</span>
      {hint && <span className="muted">{hint}</span>}
    </div>
  );
  const ids = s.selection?.kind === 'clips' ? s.selection.ids : [clip.id];
  return (
    <div className="menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {item(clip.disabled ? 'Enable' : 'Disable', () => updateDoc((d) => d.clips.filter((c) => ids.includes(c.id)).forEach((c) => (c.disabled = !clip.disabled))), 'Shift+E')}
      {item('Delete', () => deleteSelection(), 'Del')}
      {item('Ripple Delete', () => deleteSelection(true), '⇧Del')}
      {item('Move playhead to start', () => setState({ time: frameSnap(clip.start), showVideo: false }))}
      {item('Move playhead to end', () => setState({ time: frameSnap(clip.start + clipDuration(clip, s.timeline)), showVideo: false }))}
      {clip.target && item(`Select ${clip.target}`, () => {
        const o = s.doc.objects.find((k) => k.name === clip.target);
        if (o) setState({ selection: { kind: 'object', id: o.id } });
      })}
    </div>
  );
}

function TimecodeInput({ value, onChange }: { value: number; onChange: (t: number) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null)
    return (
      <input
        className="timecode editing"
        autoFocus
        onFocus={(e) => e.target.select()}
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={() => setEditing(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const t = parseTimecode(editing);
            if (t !== null) onChange(frameSnap(t));
            setEditing(null);
          } else if (e.key === 'Escape') setEditing(null);
        }}
      />
    );
  return (
    <div className="timecode" title="Click to type a time, drag to scrub" onPointerDown={(e) => {
      const x0 = e.clientX, t0 = value;
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - x0) > 2) moved = true;
        if (moved) onChange(frameSnap(Math.max(0, t0 + (ev.clientX - x0) / 40)));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', () => {
        window.removeEventListener('pointermove', move);
        if (!moved) setEditing(timecode(value));
      }, { once: true });
    }}>
      {timecode(value)}
    </div>
  );
}

export function clipLabel(c: Clip): { name: string; sub: string; title: string } {
  switch (c.kind) {
    case 'anim':
      if (c.cls === 'animate') {
        const chain = (c.chain ?? '').split('\n').join('').trim();
        return { name: `.animate${chain.match(/^\.\w+/)?.[0] ?? ''}`, sub: c.target ?? '', title: `${c.target}.animate${chain}` };
      }
      return { name: c.cls ?? '', sub: c.target ?? '', title: `${c.cls}(${c.target})` };
    case 'code':
      return { name: c.label || 'Code', sub: '', title: c.code ?? '' };
    case 'hold':
      return { name: 'Hold', sub: '', title: 'Hold: keeps the scene running (self.wait)' };
    case 'couple':
      return { name: 'Couple', sub: (c.targets ?? []).join(', '), title: `Couple ${(c.targets ?? []).join(', ')} again${c.duration > 0 ? ', gliding back into place' : ''}` };
    case 'uncouple':
      return { name: 'Uncouple', sub: (c.targets ?? []).join(', '), title: `Uncouple ${(c.targets ?? []).join(', ')}: they stay where they are and can be animated freely` };
    default:
      return { name: c.kind, sub: (c.targets ?? []).join(', '), title: `self.${c.kind}(${(c.targets ?? []).join(', ')})` };
  }
}

function clipColor(c: Clip, anims?: { name: string; category: string }[]): string {
  if (c.kind === 'code') return '#6b3f78';
  if (c.kind === 'hold') return '#3a3e4a';
  if (c.kind === 'add') return '#3f6b4a';
  if (c.kind === 'remove') return '#7a4040';
  if (c.kind === 'couple') return '#2f7a74';
  if (c.kind === 'uncouple') return '#8a6a2f';
  if (c.cls === 'animate') return '#2f5c8c';
  const cat = anims?.find((a) => a.name === c.cls)?.category ?? '';
  if (/^(FadeOut|Uncreate|Unwrite|ShrinkToCenter|FadeOutAndShift)/.test(c.cls ?? '')) return '#7a4545';
  return CAT_COLORS[cat] ?? '#3c5a75';
}

function tickSteps(pps: number): { major: number; minor: number } {
  const steps = [1 / 60, 1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const major = steps.find((s) => s * pps >= 90) ?? 600;
  const minor = [...steps].reverse().find((s) => s < major && s * pps >= 9 && Math.abs(major / s - Math.round(major / s)) < 1e-6) ?? major;
  return { major, minor };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round = (v: number) => Math.round(v * 10000) / 10000;

// ---- icons
const MagnetIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 2v5a4 4 0 0 0 8 0V2" />
    <path d="M3 4.5h2.4M8.6 4.5H11" />
  </svg>
);
const EyeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><circle cx="7" cy="7" r="1.8" /></svg>
);
const EyeOffIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><path d="M2 12L12 2" /></svg>
);
const LockIcon = ({ open }: { open: boolean }) => (
  <svg width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="6" width="9" height="7" rx="1.2" />
    <path d={open ? 'M3.5 6V4a2.5 2.5 0 0 1 5 0' : 'M3.5 6V4a2.5 2.5 0 0 1 5 0v2'} />
  </svg>
);

