import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  addAnimation, addMarker, addObject, deleteMarker, selectMarker, setMarker, workArea, addStep, newObjectPos, deleteSelection, docKey, docLayout, fps, frameSnap, getState, parseTimecode,
  previewFresh, sceneCalls, wrapInBlock, selectClips, selectedObjectIds, setPlaying, setState, timecode, toast, toggleDisabled, updateDoc, useStore,
} from '../store';
import {
  canTrimStep, EPS, findAnim, findStep, landing, layout, markerTime, moveAnims, moveSteps, retime,
  type BlockSpan, type Layout, type Retime, type Span,
  estimateRuns, exprName, rules,
} from '../timeline';
import type { Anim, Marker, RunResult, SceneDoc, Step } from '../types';
import { DND_TYPE, type DragPayload } from './Library';
import { rampPath, ratePath } from './rates';
import { clipRoles, type ClipRole } from '../clipRole';
import { keys } from '../keys';
import { pref, setPref } from '../prefs';

const ROW = 46; // a track's height until it is resized
const ROW_MIN = 26;
const ROW_MAX = 240;
const HEIGHTS_KEY = 'ui.trackHeights'; // each track's height (V1, V2…), comma-separated; empty for the usual one

const TRACKS_KEY = 'ui.tracks'; // how many tracks to show at least (empty ones too)
const TRACKS = 3;
const savedTracks = () => Math.max(1, Math.min(32, Math.round(Number(pref(TRACKS_KEY))) || TRACKS));
const savedHeights = () => (pref(HEIGHTS_KEY) ?? '').split(',').map((v) => (Number(v) >= ROW_MIN && Number(v) <= ROW_MAX ? Math.round(Number(v)) : 0));
const STRIP = 24; // height of the strip for steps that aren't animations (add, remove, code…), when there are any
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
  Composition: '#4a5a6e',
};

const STEP_COLORS: Record<Step['kind'], string> = {
  play: '#34506e',
  wait: '#3a3e4a',
  code: '#6b3f78',
  add: '#3f6b4a',
  remove: '#7a4040',
  couple: '#2f7a74',
  uncouple: '#8a6a2f',
  call: '#4f5b2f',
  apply: '#5a4f7a',
  assign: '#4a5f6b',
  block: '#6b5a2f',
  end: '#6b5a2f',
};

type Drag =
  | { mode: 'anims'; ids: string[]; x0: number; y0: number; t0: number; row0: number; t: number; row: number; copy: boolean; moved: boolean }
  | { mode: 'steps'; ids: string[]; x0: number; t0: number; t: number; copy: boolean; moved: boolean; pick?: string }
  | { mode: 'trim-anim' | 'trim-step'; id: string; x0: number; dur0: number; dur: number }
  | { mode: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: string[]; band?: string }
  | { mode: 'marker'; id: string; x0: number; t0: number; t: number; moved: boolean }
  | { mode: 'range'; which: 'in' | 'out' | 'both'; x0: number; in0: number; out0: number; orig: { in: number | null; out: number | null } }
  | { mode: 'scrub' };

/**
 * Steps shown in the strip under the ruler: everything that isn't an animation group or a pause (add, remove, code,
 * couple / uncouple, scene calls), and anything disabled. Animation groups show as the band behind their clips, and
 * pauses as a block across the tracks.
 */
const inStrip = (s: Step) => s.kind !== 'block' && s.kind !== 'end' && (!!s.disabled || (s.kind !== 'play' && s.kind !== 'wait'));
/** What a clip inside a block says about its runs. */
const RUNS = (sp: Span) => sp.skipped ? '\nIt didn’t run (manim never reached it)' : sp.elsewhere ? `\nIt didn’t run in the block’s first run; it ran ${sp.iters?.length ?? 0} time${sp.iters?.length === 1 ? '' : 's'} later (the faint clips)` : sp.iters ? `\nIt runs ${sp.iters.length + 1} times: the faint clips after it are its later runs` : '';
const RULE_H = 13; // height of an updater's bar
const BLOCK_H = 17; // height of a block's bar (for, if, with…) above the strip, per nesting level

/** What a timeline drag does to the document (shown live while dragging, committed on release). */
function applyDrag(d: SceneDoc, drag: Drag, measured: RunResult | null, keep: boolean): { moved: string[]; rt?: Retime } {
  if (drag.mode === 'anims') return { moved: moveAnims(d, measured, drag.ids, drag.t, drag.row, drag.copy) };
  if (drag.mode === 'steps') return { moved: moveSteps(d, measured, drag.ids, drag.t, drag.copy) };
  if (drag.mode === 'trim-anim') return { moved: [], rt: retime(d, measured, { anim: drag.id }, drag.dur, keep) };
  if (drag.mode === 'trim-step') return { moved: [], rt: retime(d, measured, { step: drag.id }, drag.dur, keep) };
  return { moved: [] };
}

const secs = (v: number, sign = false) => `${sign && v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100) / 100)} s`;

/**
 * What a drag is about to do, in words: where the moved clips land and what happens to the beats around them, or a
 * clip's new length and whether later beats move or keep their time.
 */
function dragNote(drag: Drag, doc: SceneDoc, lay: Layout, sdoc: SceneDoc, slay: Layout, moved: string[], rt: Retime | undefined, keep: boolean): { text: string; at: number; warn?: boolean } | null {
  const later = (d: number) => (Math.abs(d) < 0.005 ? 'later beats keep their time' : `later beats move by ${secs(d, true)}`);
  if (drag.mode === 'trim-anim' || drag.mode === 'trim-step') {
    const sp = drag.mode === 'trim-anim' ? slay.anims.get(drag.id) : slay.steps.get(drag.id);
    if (!sp || !rt) return null;
    const len = sp.end - sp.start;
    const parts = [`Lasts ${secs(len)} (${secs(len - drag.dur0, true)})`];
    const r = drag.mode === 'trim-anim' ? findAnim(doc, drag.id) : undefined;
    const shared = r && !r.parent && r.step.args?.run_time !== undefined && (r.step.anims ?? []).filter((a) => !a.disabled).length > 1;
    if (shared) parts.push(`the others keep self.play’s run_time=${r!.step.args!.run_time}`);
    const hold = { shrunk: 'the pause after it gets shorter', removed: 'the pause after it is used up', grown: 'the pause after it gets longer', added: 'a pause fills the gap' }[rt.hold ?? 'shrunk'];
    parts.push(rt.hold ? `later beats keep their time: ${hold}` : later(rt.delta));
    if (rt.limit) parts.push(rt.limit);
    else if (!keep && Math.abs(rt.delta) > 0.005 && !(drag.mode === 'trim-step' && findStep(doc, drag.id)?.kind === 'wait')) parts.push('(Keep later timing takes it from a pause instead)');
    return { text: parts.join(' · '), at: sp.end, warn: !!rt.limit };
  }
  if ((drag.mode !== 'anims' && drag.mode !== 'steps') || !moved.length) return null;
  // the step the moved clips are now in, and when it starts
  const ref = drag.mode === 'anims' ? findAnim(sdoc, moved[0]) : undefined;
  const step = ref ? ref.step : findStep(sdoc, moved[0]);
  if (!step) return null;
  const start = slay.steps.get(step.id)?.start ?? 0;
  const others = ref ? (step.anims ?? []).filter((a) => !moved.includes(a.id) && !a.disabled) : [];
  const what = drag.copy ? 'Copy ' : '';
  const head = others.length ? `${what}${what ? 'starts' : 'Starts'} with ${[animLabel(others[0]).name, animLabel(others[0]).sub].filter(Boolean).join(' ')} at ${timecode(start)}` : `${what}${what ? 'plays' : 'Plays'} on its own at ${timecode(start)}`;
  // how the steps that didn't move shift: the first one after the landing, and one before it
  const skip = new Set([step.id, ...moved]);
  let after: number | undefined, before: number | undefined;
  for (const s of sdoc.timeline) {
    const a = slay.steps.get(s.id), b = lay.steps.get(s.id);
    if (!a || !b || skip.has(s.id) || s.disabled || Math.abs(a.start - b.start) < 0.005) continue;
    if (a.start >= start - EPS) after ??= a.start - b.start;
    else before ??= a.start - b.start;
  }
  const parts = [head, later(after ?? 0)];
  if (before !== undefined) parts.push(`beats after where it was move by ${secs(before, true)}`);
  return { text: parts.join(' · '), at: start };
}

const changes = (d: Drag | null) =>
  !!d && (((d.mode === 'anims' || d.mode === 'steps') && d.moved) || ((d.mode === 'trim-anim' || d.mode === 'trim-step') && Math.abs(d.dur - d.dur0) > EPS));

export function Timeline() {
  const doc = useStore((s) => s.doc);
  const timeline = useStore((s) => s.timeline);
  const time = useStore((s) => s.time);
  const selection = useStore((s) => s.selection);
  const view = useStore((s) => s.view);
  const snapOn = useStore((s) => s.timelineSnap);
  const keep = useStore((s) => s.keepTiming);
  const range = useStore((s) => s.range);
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
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [heights, setHeights] = useState<number[]>(savedHeights);
  const [tracks, setTracks] = useState(savedTracks);

  const lay = docLayout(doc, timeline);
  // While dragging, the timeline shows the result of the edit: later steps move along, like a magnetic timeline.
  const shown = useMemo(() => {
    if (!changes(drag)) return { doc, lay, moved: [] as string[], rt: undefined };
    const d = structuredClone(doc);
    const { moved, rt } = applyDrag(d, drag!, timeline, keep);
    return { doc: d, lay: layout(d, timeline), moved, rt };
  }, [doc, lay, drag, timeline, keep]);
  const sdoc = shown.doc;
  const slay = shown.lay;
  const roles = useMemo(() => clipRoles(sdoc, timeline), [sdoc, timeline]);

  const { pps, start: v0 } = view;
  // ---------------------------------------------------------- track heights (drag the line under a track's name)
  const resizeTrack = (r: number, h: number, save: boolean) => setHeights((hs) => {
    const next = [...hs];
    while (next.length <= r) next.push(0);
    next[r] = h && Math.round(h) !== ROW ? Math.round(Math.max(ROW_MIN, Math.min(ROW_MAX, h))) : 0;
    while (next.length && !next[next.length - 1]) next.pop();
    if (save) setPref(HEIGHTS_KEY, next.length ? next.join(',') : null);
    return next;
  });
  const startTrackResize = (e: React.PointerEvent, r: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const y0 = e.clientY, h0 = rowH(r);
    let h = h0;
    const move = (ev: PointerEvent) => resizeTrack(r, (h = h0 + ev.clientY - y0), false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', move);
      resizeTrack(r, h, true);
    }, { once: true });
  };
  const rows = Math.max(tracks, slay.rows + (drag?.mode === 'anims' && drag.moved ? 1 : 0));
  /** Show this many tracks (at least as many as the clips use), remembered between launches. */
  const setTrackCount = (n: number) => {
    const next = Math.max(1, Math.min(32, n));
    setTracks(next);
    setPref(TRACKS_KEY, next === TRACKS ? null : String(next));
  };
  const selected = new Set(selection?.kind === 'clips' ? selection.ids : []);
  const end = slay.end;
  const x = (t: number) => (t - v0) * pps;
  // from the document, not the drag preview: the tracks mustn't jump under the pointer while dragging
  const blocksH = lay.blocks.length ? (Math.max(...lay.blocks.map((b) => b.depth)) + 1) * BLOCK_H + 2 : 0;
  const docRules = useMemo(() => rules(doc, lay), [doc, lay]);
  const rulesH = docRules.length ? (Math.max(...docRules.map((r) => r.row)) + 1) * RULE_H + 2 : 0;
  const stepsTop = RULER + blocksH + rulesH; // where the strip's own steps are
  const stripH = blocksH + rulesH + (doc.timeline.some(inStrip) ? STRIP : 0);
  const rowH = (r: number) => heights[r] || ROW;
  const tracksH = (n: number) => { let h = 0; for (let i = 0; i < n; i++) h += rowH(i); return h; };
  const rowTop = (r: number) => RULER + stripH + tracksH(r);
  const totalH = RULER + stripH + tracksH(rows) + 36; // room for + Add track

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
  /** The pointer's height in the tracks (they scroll with the timeline, so their box already includes the scroll). */
  const laneY = (clientY: number) => clientY - laneRef.current!.getBoundingClientRect().top;
  /** Whether the pointer is on the ruler, which stays at the top of the timeline while the tracks scroll under it. */
  const onRuler = (clientY: number) => clientY - bodyRef.current!.getBoundingClientRect().top < RULER;
  /** Track row under the pointer: -1 for the strip of other steps, 0… for V1… */
  const rowAt = (clientY: number) => {
    const y = laneY(clientY) - RULER;
    if (stripH && y < stripH) return -1;
    let row = 0;
    for (let top = stripH + rowH(0); top <= y; top += rowH(row)) row++;
    return row;
  };
  /** The animation group (self.play) whose band is under a point of the tracks, if any. */
  const bandAt = (t: number) => doc.timeline.find((s) => {
    if (s.kind !== 'play' || s.disabled) return false;
    const sp = lay.steps.get(s.id)!;
    return t >= sp.start && t <= sp.end;
  });

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
    const pts = [0, time, ...(doc.markers ?? []).filter((m) => !exclude.has(m.id) && !(m.anchor && exclude.has(m.anchor.id))).map((m) => markerTime(m, lay))];
    for (const [id, sp] of [...lay.steps, ...lay.anims]) if (!exclude.has(id)) pts.push(sp.start, sp.end);
    return pts;
  };
  // Times written into the code stay readable: whole frames only when zoomed far in, else round numbers.
  const grid = pps >= 900 ? 1 / fps() : pps >= 300 ? 0.05 : pps >= 60 ? 0.1 : 0.5;
  const snapTo = (v: number, exclude: Set<string>) => {
    const quant = Math.max(0, Math.round(v / grid) * grid);
    if (!snapOn) return { v: quant, guide: null };
    let best: { d: number; p: number } | null = null;
    for (const p of snapPoints(exclude)) {
      const d = p - v;
      if (Math.abs(d) * pps < SNAP_PX && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, p };
    }
    return best ? { v: best.p, guide: best.p } : { v: quant, guide: null };
  };

  // ------------------------------------------------------------ pointer handling
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === 'scrub') return setState({ time: frameSnap(timeAt(e.clientX)), showVideo: false });
      if (d.mode === 'marquee') {
        const nx = e.clientX - laneRef.current!.getBoundingClientRect().left, ny = laneY(e.clientY);
        const t0 = v0 + Math.min(d.x0, nx) / pps, t1 = v0 + Math.max(d.x0, nx) / pps;
        const y0 = Math.min(d.y0, ny), y1 = Math.max(d.y0, ny);
        const hit: string[] = [];
        const overlaps = (sp: { start: number; end: number }) => sp.start < t1 && Math.max(sp.end, sp.start + 2 / pps) > t0;
        if (stripH && y0 < RULER + stripH && y1 > RULER) for (const s of doc.timeline) if (inStrip(s) && overlaps(lay.steps.get(s.id)!)) hit.push(s.id);
        if (y1 > rowTop(0)) for (const s of doc.timeline) if (s.kind === 'wait' && !s.disabled && overlaps(lay.steps.get(s.id)!)) hit.push(s.id);
        for (const s of doc.timeline) (s.disabled ? [] : s.anims ?? []).forEach((a, i) => {
          if (rowTop(i) < y1 && rowTop(i) + rowH(i) > y0 && overlaps(lay.anims.get(a.id)!)) hit.push(a.id);
        });
        selectClips([...new Set([...d.base, ...hit])]);
        return setDrag({ ...d, x1: nx, y1: ny });
      }
      const dx = (e.clientX - d.x0) / pps;
      if (d.mode === 'range') {
        // In and Out handles (the bar between them moves both); they stay a frame apart at least
        const f = 1 / fps(), end = lay.end;
        if (d.which === 'both') {
          const shift = Math.max(-d.in0, Math.min(end - d.out0, frameSnap(dx)));
          return setState({ range: { in: frameSnap(d.in0 + shift), out: frameSnap(d.out0 + shift) } });
        }
        const { v, guide: g } = snapTo(d.which === 'in' ? d.in0 + dx : d.out0 + dx, new Set());
        setGuide(g);
        const r = getState().range;
        if (d.which === 'in') return setState({ range: { ...r, in: frameSnap(Math.max(0, Math.min(v, (r.out ?? end) - f))) } });
        return setState({ range: { ...r, out: frameSnap(Math.min(end, Math.max(v, (r.in ?? 0) + f))) } });
      }
      if (d.mode === 'marker') {
        const { v, guide: g } = snapTo(d.t0 + dx, new Set([d.id]));
        setGuide(g);
        return setDrag({ ...d, t: frameSnap(v), moved: d.moved || Math.abs(e.clientX - d.x0) > 3 });
      }
      if (d.mode === 'anims' || d.mode === 'steps') {
        const { v, guide: g } = snapTo(d.t0 + dx, new Set(d.ids));
        setGuide(g);
        const moved = d.moved || Math.abs(e.clientX - d.x0) > 3 || (d.mode === 'anims' && Math.abs(e.clientY - d.y0) > 3);
        if (d.mode === 'anims') return setDrag({ ...d, t: v, row: Math.max(0, rowAt(e.clientY)), copy: e.altKey, moved });
        return setDrag({ ...d, t: v, copy: e.altKey, moved });
      }
      const sp = d.mode === 'trim-anim' ? lay.anims.get(d.id)! : lay.steps.get(d.id)!;
      const { v, guide: g } = snapTo(sp.start + d.dur0 + dx, new Set([d.id]));
      setGuide(g);
      // the length is what the code says: a round number unless the edge snapped to something
      const dur = g !== null ? v - sp.start : Math.round((d.dur0 + dx) / grid) * grid;
      setDrag({ ...d, dur: Math.max(1 / fps(), dur) });
    };
    // Esc cancels the drag: nothing changes (a marquee puts the selection back)
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      setGuide(null);
      if (d?.mode === 'marquee') selectClips(d.base);
      if (d?.mode === 'range') setState({ range: d.orig });
    };
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      setDrag(null);
      setGuide(null);
      // a click (no drag) on the shading of an animation group selects the group; on a clip of a selected group, the clip
      if (d.mode === 'marquee' && d.band && Math.abs(d.x1 - d.x0) < 3 && Math.abs(d.y1 - d.y0) < 3) return selectClips([d.band]);
      if (d.mode === 'steps' && d.pick && !d.moved) return selectClips([d.pick]);
      if (d.mode === 'marker') {
        if (!d.moved) return selectMarker(d.id);
        // an attached marker keeps its attachment: the drag changes how far from it it is
        const l = docLayout();
        setMarker(d.id, (m) => {
          const sp = m.anchor && (l.anims.get(m.anchor.id) ?? l.steps.get(m.anchor.id));
          if (m.anchor && sp) m.anchor.offset = Math.round((d.t - (m.anchor.edge === 'end' ? sp.end : sp.start)) * 1000) / 1000;
          m.time = d.t;
        });
        return selectMarker(d.id, false);
      }
      if (!changes(d)) return;
      let ids: string[] = [];
      const { timeline: measured, keepTiming } = getState();
      updateDoc((nd) => void (ids = applyDrag(nd, d, measured, keepTiming).moved));
      if (ids.length) selectClips(ids);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', esc, true);
    };
  }, [drag?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (e: React.PointerEvent, id: string): string[] | null => {
    const multi = e.shiftKey || e.metaKey || e.ctrlKey;
    let ids = selection?.kind === 'clips' ? selection.ids : [];
    if (multi) ids = ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id];
    else if (!ids.includes(id)) ids = [id];
    selectClips(ids);
    return multi && !ids.includes(id) ? null : ids;
  };

  const onAnimDown = (e: React.PointerEvent, a: Anim, step: Step, row: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const rect0 = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (selected.has(step.id) && !e.shiftKey && !e.metaKey && !e.ctrlKey && !(rect0.right - e.clientX < 7 && rect0.width > 10)) {
      // the group is selected: dragging any of its clips moves the group (a click without dragging selects the clip)
      const ssp = lay.steps.get(step.id)!;
      const groups = (selection?.kind === 'clips' ? selection.ids : []).filter((id) => doc.timeline.some((x) => x.id === id));
      return setDrag({ mode: 'steps', ids: groups, x0: e.clientX, t0: ssp.start, t: ssp.start, copy: e.altKey, moved: false, pick: a.id });
    }
    const ids = pick(e, a.id);
    if (!ids) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sp = lay.anims.get(a.id)!;
    if (a.cls !== 'expr' && rect.right - e.clientX < 7 && rect.width > 10) return setDrag({ mode: 'trim-anim', id: a.id, x0: e.clientX, dur0: sp.end - sp.start, dur: sp.end - sp.start });
    // Only whole animations of a self.play move; selected statements and nested animations stay.
    const top = ids.filter((id) => { const r = findAnim(doc, id); return r && !r.parent; });
    if (!top.length || step.disabled) return;
    setDrag({ mode: 'anims', ids: top, x0: e.clientX, y0: e.clientY, t0: sp.start, row0: row, t: sp.start, row, copy: e.altKey, moved: false });
  };

  const onStepDown = (e: React.PointerEvent, s: Step) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const ids = pick(e, s.id);
    if (!ids) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sp = lay.steps.get(s.id)!;
    if (canTrimStep(s) && !s.disabled && rect.right - e.clientX < 7 && rect.width > 10) return setDrag({ mode: 'trim-step', id: s.id, x0: e.clientX, dur0: sp.end - sp.start, dur: sp.end - sp.start });
    const steps = ids.filter((id) => doc.timeline.some((x) => x.id === id));
    setDrag({ mode: 'steps', ids: steps, x0: e.clientX, t0: sp.start, t: sp.start, copy: e.altKey, moved: false });
  };

  const onLaneDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setMenu(null);
    const r = laneRef.current!.getBoundingClientRect();
    const y = laneY(e.clientY);
    if (onRuler(e.clientY)) {
      setPlaying(false);
      setState({ time: frameSnap(timeAt(e.clientX)), showVideo: false });
      return setDrag({ mode: 'scrub' });
    }
    const t = timeAt(e.clientX);
    const band = y >= rowTop(0) ? bandAt(t) : undefined;
    if (band) {
      const sp = lay.steps.get(band.id)!;
      const px = x(sp.end) - (e.clientX - r.left);
      if (px >= -1 && px < 7 && (sp.end - sp.start) * pps > 10) {
        selectClips([band.id]);
        return setDrag({ mode: 'trim-step', id: band.id, x0: e.clientX, dur0: sp.end - sp.start, dur: sp.end - sp.start });
      }
    }
    const base = e.shiftKey && selection?.kind === 'clips' ? selection.ids : [];
    if (!e.shiftKey) setState({ selection: null });
    setDrag({ mode: 'marquee', x0: e.clientX - r.left, y0: y, x1: e.clientX - r.left, y1: y, base, band: e.shiftKey ? undefined : band?.id });
  };
  /** Right-click on the shading of an animation group: the same menu as on a clip, for the whole group. */
  const onLaneMenu = (e: React.MouseEvent) => {
    const band = !onRuler(e.clientY) && laneY(e.clientY) >= rowTop(0) ? bandAt(timeAt(e.clientX)) : undefined;
    if (band) openMenu(e, band.id);
    else e.preventDefault();
  };

  // ------------------------------------------------------------ library drops
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    setDropAt({ t: snapTo(timeAt(e.clientX), new Set()).v, row: rowAt(e.clientY) });
  };
  const onDrop = (e: React.DragEvent) => {
    setDropAt(null);
    const raw = e.dataTransfer.getData(DND_TYPE);
    if (!raw) return;
    e.preventDefault();
    const p = JSON.parse(raw) as DragPayload;
    const at = { start: snapTo(timeAt(e.clientX), new Set()).v, row: Math.max(0, rowAt(e.clientY)) };
    const s = getState();
    const sel = s.selection?.kind === 'object' ? s.doc.objects.find((o) => o.id === (s.selection as { id: string }).id) : undefined;
    if (p.kind === 'mobject') return void addObject(p.name, newObjectPos(p.name), sel?.name, at);
    const target = sel?.name ?? s.doc.objects[s.doc.objects.length - 1]?.name;
    if (!target) return setState({ toast: 'Add an object first, then drop animations' });
    addAnimation(p.name, target, at);
    if (!sel) toast(`${p.name} animates ${target}, the newest object. Select an object first to target it, or change it in Effect Controls`);
  };
  const dropLanding = dropAt && landing(doc, lay, dropAt.t, dropAt.row >= 0);
  const area = workArea(); // (it follows `range`)
  const note = drag && changes(drag) ? dragNote(drag, doc, lay, sdoc, slay, shown.moved, shown.rt, keep) : null;

  // ------------------------------------------------------------ ruler
  const visible = laneW / pps;
  const { major, minor } = tickSteps(pps);
  const ticks: { t: number; major: boolean }[] = [];
  for (let t = Math.floor(v0 / minor) * minor; t <= v0 + visible + minor; t += minor) ticks.push({ t, major: Math.abs(t / major - Math.round(t / major)) < 1e-6 });

  // ------------------------------------------------------------ clips
  const ghost = (id: string) => shown.moved.includes(id) || ((drag?.mode === 'trim-anim' || drag?.mode === 'trim-step') && drag.id === id && changes(drag));
  const warnOf = (id: string) => diagnostics?.find((x) => x.id === id && x.kind === 'anim' && x.level !== 'info');

  const renderAnim = (a: Anim, step: Step, row: number, l: Layout) => {
    const sp = l.anims.get(a.id);
    if (!sp) return null;
    const left = x(sp.start), w = Math.max((sp.end - sp.start) * pps, 3);
    if (left + w < -40 || left > laneW + 40) return null;
    const label = animLabel(a);
    const warn = warnOf(a.id);
    const kids = a.anims ? [...flatKids(a.anims, 0)] : [];
    const role: ClipRole = roles.get(a.id) ?? 'effect';
    const curve = sp.curve ?? (step.args?.rate_func || a.args?.rate_func);
    return (
      <div
        key={a.id}
        className={`clip anim ${kids.length ? '' : role} ${selected.has(a.id) ? 'sel' : ''} ${a.disabled ? 'disabled' : ''} ${error?.id === a.id ? 'err' : ''} ${ghost(a.id) ? 'ghost' : ''} ${warn ? 'warn' : ''} ${sp.estimated ? 'estimated' : ''} ${sp.skipped || sp.elsewhere ? 'unrun' : ''}`}
        style={{ left, width: w, top: rowTop(row) + 3, height: rowH(row) - 6, ['--clip' as string]: animColor(a, catalog?.animations) }}
        title={`${label.title}\n${timecode(sp.start)} → ${timecode(sp.end)}  (${(sp.end - sp.start).toFixed(2)}s)${sp.estimated ? '\nEstimated: manim hasn’t measured it yet' : ''}${RUNS(sp)}${warn ? `\n⚠ ${warn.message}` : ''}`}
        tabIndex={0}
        role="button"
        aria-pressed={selected.has(a.id)}
        aria-label={`${label.name}${label.sub ? ` ${label.sub}` : ''}${kids.length ? '' : `, ${ROLE[role].word}`}, ${timecode(sp.start)} to ${timecode(sp.end)}`}
        onKeyDown={(e) => keySelect(e, a.id)}
        onPointerDown={(e) => onAnimDown(e, a, step, row)}
        onContextMenu={(e) => openMenu(e, a.id)}
        onDoubleClick={() => setState({ time: frameSnap(sp.end), showVideo: false })}
      >
        <div className="clip-head">
          {warn && <span className="clip-warn">!</span>}
          {kids.length ? <span className="fx">fx</span> : <span className={`fx ${role}`} title={ROLE[role].title}>{ROLE[role].badge}</span>}
          <span className="clip-name">{clipText(a).name}</span>
          {clipText(a).sub && <span className="clip-sub">{clipText(a).sub}</span>}
        </div>
        {kids.length > 0 ? (
          <div className="kids">
            {kids.map(({ a: k, depth }, i) => {
              const ks = l.anims.get(k.id);
              if (!ks) return null;
              return (
                <div key={k.id} className={`kid ${selected.has(k.id) ? 'sel' : ''} ${k.disabled ? 'disabled' : ''}`}
                  style={{ left: (ks.start - sp.start) * pps, width: Math.max(2, (ks.end - ks.start) * pps), top: (i % 2) * 12 + depth, ['--clip' as string]: animColor(k, catalog?.animations) }}
                  title={`${animLabel(k).title}\n${timecode(ks.start)} → ${timecode(ks.end)}`}
                  onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) pick(e, k.id); }}
                  onContextMenu={(e) => openMenu(e, k.id)}>
                  {animLabel(k).name}
                </div>
              );
            })}
          </div>
        ) : (
          w > 24 && rowH(row) >= 40 && (
            <svg className="rate" width={w} height={rowH(row) - 26} preserveAspectRatio="none">
              {(role === 'in' || role === 'swap') && <path className="ramp in" d={rampPath(curve, w, rowH(row) - 28)} />}
              {(role === 'out' || role === 'swap') && <path className="ramp out" d={rampPath(curve, w, rowH(row) - 28, true)} />}
              {role === 'effect' && <path d={ratePath(curve, w, rowH(row) - 28)} />}
            </svg>
          )
        )}
        {!kids.length && role === 'effect' && w > 18 && rowH(row) >= 40 && <><i className="kf start" /><i className="kf end" /></>}
      </div>
    );
  };

  // A compound statement (for, while, if, with, try…): a bar over its time, with its header and how many times it ran.
  // Its first run is laid out clip by clip; the later runs follow it, drawn faintly (they are the same clips again).
  const renderBlock = (b: BlockSpan) => {
    const left = x(b.start), w = Math.max((b.end - b.start) * pps, 6);
    if (left + w < -40 || left > laneW + 40) return null;
    const top = RULER + 1 + b.depth * BLOCK_H;
    const opener = sdoc.timeline.find((s) => s.id === b.id);
    if (!opener) return null;
    const runs = b.runs ?? (b.estimated ? estimateRuns(opener.head ?? '') : undefined);
    const repeats = (b.end - b.body) * pps;
    return (
      <Fragment key={'block' + b.id}>
        <div className={`block-col ${selected.has(b.id) ? 'sel' : ''} ${opener.disabled ? 'disabled' : ''}`}
          style={{ left, width: w, top: top + BLOCK_H, height: totalH - top - BLOCK_H - 36 }}>
          {repeats > 2 && <div className="block-repeats" style={{ left: (b.body - b.start) * pps, width: repeats }} />}
        </div>
        {b.clauses.map((c, k) => {
          const cs = sdoc.timeline.find((s) => s.id === c.id)!;
          const cl = x(c.start), cw = Math.max(((k === b.clauses.length - 1 ? b.end : c.end) - c.start) * pps, k ? 3 : 6);
          const runsHere = k === 0 ? runs : c.runs;
          const head = (cs.head ?? '').trim() || 'if True';
          const sub = runsHere === undefined ? '' : runsHere === 0 ? 'didn’t run' : `×${runsHere}${b.estimated ? '?' : ''}`;
          const label = stepLabel(cs);
          return (
            <div key={c.id} className={`clip block-bar ${k ? 'clause' : ''} ${selected.has(c.id) ? 'sel' : ''} ${opener.disabled ? 'disabled' : ''} ${runsHere === 0 ? 'unrun' : ''} ${b.estimated ? 'estimated' : ''} ${ghost(b.id) ? 'ghost' : ''}`}
              style={{ left: cl, width: cw, top, height: BLOCK_H - 2, ['--clip' as string]: STEP_COLORS.block }}
              title={`${label.title}${cs.comment ? `\n${cs.comment}` : ''}\n${timecode(c.start)} → ${timecode(k ? c.end : b.end)}${runsHere !== undefined ? `\n${runsHere === 0 ? 'Its body didn’t run' : `Its body ran ${runsHere} time${runsHere === 1 ? '' : 's'}${b.estimated ? ' (estimated: manim hasn’t measured it yet)' : ''}`}` : ''}${!k && b.body < b.end - EPS ? '\nThe first run is laid out clip by clip; the faint clips after it are the later runs' : ''}`}
              tabIndex={0} role="button" aria-pressed={selected.has(c.id)}
              aria-label={`${head}${sub ? `, ${sub}` : ''}, ${timecode(c.start)} to ${timecode(k ? c.end : b.end)}`}
              onKeyDown={(e) => keySelect(e, c.id)}
              onPointerDown={(e) => onStepDown(e, cs)}
              onContextMenu={(e) => openMenu(e, c.id)}
              onDoubleClick={() => setState({ time: frameSnap(b.end), showVideo: false })}>
              <span className="clip-name">{head}</span>{sub && <span className="clip-sub">{sub}</span>}
            </div>
          );
        })}
      </Fragment>
    );
  };
  // Later runs of a clip inside a loop: faint copies where manim ran it again (select the first run to edit them all).
  const renderIters = (a: Anim, row: number, l: Layout) => {
    const sp = l.anims.get(a.id);
    if (!sp?.iters) return [];
    return sp.iters.map((it, k) => {
      const left = x(it.start), w = Math.max((it.end - it.start) * pps, 3);
      if (left + w < -40 || left > laneW + 40) return null;
      return <div key={`${a.id}~${k}`} className="clip anim iter" aria-hidden="true" style={{ left, width: w, top: rowTop(row) + 3, height: rowH(row) - 6, ['--clip' as string]: animColor(a, catalog?.animations) }}>
        <div className="clip-head"><span className="clip-name">{clipText(a).name}</span><span className="clip-sub">run {k + 2}</span></div>
      </div>;
    });
  };
  // Statements that take no time at the same moment (k = 2, label.next_to(…), self.add(…)…) are drawn side by side,
  // in code order, so each diamond can be picked.
  const fanned = (steps: Step[], l: Layout) => {
    const at = new Map<string, number>();
    let right = -Infinity;
    for (const s of steps) {
      const sp = l.steps.get(s.id);
      if (!sp) continue;
      const w = (sp.end - sp.start) * pps;
      if (s.kind === 'wait' && !s.disabled) continue;
      if (w < 6 || s.disabled) {
        const left = Math.max(0, x(sp.start) - 7, right);
        at.set(s.id, left);
        right = left + 14;
      } else right = -Infinity;
    }
    return at;
  };
  const renderStep = (s: Step, l: Layout, fan: Map<string, number>) => {
    const sp = l.steps.get(s.id)!;
    const iters = (sp.iters ?? []).map((it, k) => {
      const instant = (it.end - it.start) * pps < 6;
      const il = x(it.start);
      if (il < -40 || il > laneW + 40) return null;
      return <div key={`${s.id}~${k}`} className={`clip step iter ${s.kind} ${instant ? 'instant' : ''}`} aria-hidden="true"
        style={{ left: instant ? il - 7 : il, width: instant ? 14 : (it.end - it.start) * pps, top: s.kind === 'wait' && !s.disabled ? rowTop(0) + 3 : stepsTop + 2, height: s.kind === 'wait' && !s.disabled ? tracksH(rows) - 6 : STRIP - 4, ['--clip' as string]: STEP_COLORS[s.kind] }} />;
    });
    return <Fragment key={s.id}>{renderStepClip(s, fan, sp)}{iters}</Fragment>;
  };
  const renderStepClip = (s: Step, fan: Map<string, number>, sp: Span) => {
    const w = (sp.end - sp.start) * pps;
    const pause = s.kind === 'wait' && !s.disabled;
    const instant = !pause && (w < 6 || !!s.disabled);
    const left = instant ? (fan.get(s.id) ?? x(sp.start) - 7) + 7 : x(sp.start);
    if (left + w < -40 || left > laneW + 40) return null;
    const label = stepLabel(s);
    const shown = stepText(s);
    const top = pause ? rowTop(0) + 3 : stepsTop + 2;
    const height = pause ? tracksH(rows) - 6 : STRIP - 4;
    return (
      <div
        key={s.id}
        className={`clip step ${s.kind} ${pause ? 'pause' : ''} ${instant ? 'instant' : ''} ${sp.skipped || sp.elsewhere ? 'unrun' : ''} ${selected.has(s.id) ? 'sel' : ''} ${s.disabled ? 'disabled' : ''} ${error?.id === s.id ? 'err' : ''} ${ghost(s.id) ? 'ghost' : ''} ${sp.estimated ? 'estimated' : ''} ${canTrimStep(s) ? '' : 'fixed'}`}
        style={{ left: instant ? Math.max(0, left - 7) : left, width: instant ? 14 : Math.max(w, 3), top, height, ['--clip' as string]: STEP_COLORS[s.kind] }}
        title={`${label.title}${s.comment ? `\n${s.comment}` : ''}\n${timecode(sp.start)} → ${timecode(sp.end)}  (${(sp.end - sp.start).toFixed(2)}s)${RUNS(sp)}${s.disabled ? '\nDisabled: left out of the code' : ''}`}
        tabIndex={0}
        role="button"
        aria-pressed={selected.has(s.id)}
        aria-label={`${shown.name}${shown.sub ? ` ${shown.sub}` : ''}, ${timecode(sp.start)} to ${timecode(sp.end)}`}
        onKeyDown={(e) => keySelect(e, s.id)}
        onPointerDown={(e) => onStepDown(e, s)}
        onContextMenu={(e) => openMenu(e, s.id)}
        onDoubleClick={() => setState({ time: frameSnap(sp.end), showVideo: false })}
      >
        {!instant && (
          <div className="clip-head">
            <span className="clip-name">{shown.name}</span>
            {shown.sub && <span className="clip-sub">{shown.sub}</span>}
          </div>
        )}
      </div>
    );
  };

  /** Tab reaches a clip and Enter selects it (Shift adds to the selection): the timeline without a mouse. */
  const keySelect = (e: React.KeyboardEvent, id: string) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
    selectClips(e.shiftKey ? [...new Set([...selected, id])] : [id]);
  };

  const openMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected.has(id)) selectClips([id]);
    setMenu({ x: e.clientX, y: e.clientY, id });
  };

  const calls = catalog ? sceneCalls(doc) : [];
  const objNames = () => selectedObjectIds().map((id) => doc.objects.find((o) => o.id === id)?.name ?? '').filter(Boolean);

  return (
    <div className="timeline" data-tour="timeline" onWheel={onWheel}>
      <div className="tl-header">
        <div className="seq-tab" title="The timeline is this scene's construct(): each statement runs when the one before it ends">{doc.scene.name}.construct()</div>
        <TimecodeInput value={time} onChange={(t) => setState({ time: t, showVideo: false })} />
        <div className="tl-tools">
          <button className={`tool ${snapOn ? 'on' : ''}`} title="Snap in timeline (S)" onClick={() => setState({ timelineSnap: !snapOn })}>
            <MagnetIcon />
          </button>
          <button className={`tool keep-timing ${keep ? 'on' : ''}`} aria-pressed={keep} aria-label="Keep later timing"
            title={keep ? 'Keep later timing is on: making a clip longer or shorter takes the time from (or gives it to) the pause right after it, so later beats keep their time' : 'Keep later timing is off: making a clip longer or shorter moves later beats along. Turn on to take the time from the pause after it instead'}
            onClick={() => setState({ keepTiming: !keep })}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 3v8M13 3v8M4 7h6M8 5l2 2-2 2" /></svg>
          </button>
          <button className="tool" title="Add marker (M)" onClick={() => addMarker()}>
            <svg width="12" height="14" viewBox="0 0 12 14"><path d="M1 1h10v8l-5 4-5-4z" fill="currentColor" /></svg>
          </button>
          <span className="sep" />
          <button className="ghost small" onClick={() => addStep('wait')} title="self.wait(1) at the playhead: a pause">+ Wait</button>
          <button className="ghost small" onClick={() => addStep('code')} title="Any manim code at the playhead">+ Code</button>
          <button className="ghost small" onClick={() => addStep('add', { targets: objNames() })} title="self.add(...) at the playhead: objects appear without an animation">+ Add</button>
          <button className="ghost small" onClick={() => addStep('remove', { targets: objNames() })} title="self.remove(...) at the playhead: objects disappear without an animation">+ Remove</button>
          <button className="ghost small" onClick={() => addStep('apply', { target: objNames()[0] })} title="Call methods on an object at the playhead (obj.next_to(…), .set_color(…)…): it changes at once, without an animation">+ Change</button>
          <button className="ghost small" onClick={() => { const sel = getState().selection; wrapInBlock(sel?.kind === 'clips' ? sel.ids : []); }} title="Repeat the selected clips in a loop (for i in range(2)), or add an empty block at the playhead. Its header can be any for, while, if, with…">+ Repeat</button>
          <button className="ghost small" onClick={() => addStep('assign')} title="Set a value at the playhead (k = 2, total += 1): a variable later steps can use">+ Value</button>
          <button className="ghost small" onClick={() => addStep('uncouple', { targets: objNames() })} title="Uncouple objects at the playhead: they stay where they are and can be animated freely">+ Uncouple</button>
          <button className="ghost small" onClick={() => addStep('couple', { targets: objNames() })} title="Couple objects again at the playhead (give it a duration to glide back into place)">+ Couple</button>
          <select className="inline scene-call" value="" title="Call another method of the scene at the playhead: sections, sounds, subcaptions, the camera (ThreeDScene)…"
            onChange={(e) => e.target.value && addStep('call', { method: e.target.value })}>
            <option value="">+ self.…</option>
            {calls.map((m) => <option key={m} value={m}>self.{m}(…)</option>)}
          </select>
        </div>
        <div className="spacer" />
        <span className="muted small mono">{timecode(end)}</span>
        <button className="ghost small" title="Zoom to fit (\)" onClick={() => zoomToFit(laneW)}>Fit</button>
      </div>

      <div className="tl-body" ref={bodyRef}>
        <div className="tl-grid" style={{ height: totalH }}>
          <div className="tl-heads">
            <div className="tl-corner" style={{ height: RULER }}>
              <span className="muted small lanes-label" title={`Animation lanes: V1 holds the first animation of each Play together group (a shaded column), V2 the second, and so on. Lanes are not drawing layers: what is drawn on top is in Scene › Drawing order.\n${doc.timeline.length} ${doc.timeline.length === 1 ? 'step' : 'steps'} in the scene`}>Animation lanes ⓘ</span>
            </div>
            {stripH > 0 && (
              <div className="track-head steps-head" style={{ height: stripH }} title="Steps that aren't animations: objects added or removed without one, code, couple / uncouple, scene calls, and anything disabled">
                <span className="th-name">Other</span>
              </div>
            )}
            {Array.from({ length: rows }, (_, r) => (
              <div key={r} className="track-head" style={{ height: rowH(r) }} title={`V${r + 1}: animation lane ${r + 1}, the ${ordinal(r + 1)} animation of each Play together group. Not a drawing layer: what is drawn on top is in Scene › Drawing order`}>
                <span className="th-name">V{r + 1}</span>
                {r === rows - 1 && r >= slay.rows && rows > 1 && (
                  <button className="x-btn th-remove" title={`Remove V${r + 1} (it is empty)`} aria-label={`Remove V${r + 1}`} onClick={() => setTrackCount(rows - 1)}>×</button>
                )}
                <div className="th-resize" role="separator" aria-orientation="horizontal" aria-label={`V${r + 1} height`} aria-valuenow={rowH(r)} aria-valuemin={ROW_MIN} aria-valuemax={ROW_MAX}
                  title={`Drag to change V${r + 1}'s height; double-click for the usual height`}
                  onPointerDown={(e) => startTrackResize(e, r)} onDoubleClick={() => resizeTrack(r, 0, true)} />
              </div>
            ))}
            <button className="track-add" title="Add an empty track below the others. A clip moved onto it plays after the animations above it in its self.play" onClick={() => setTrackCount(rows + 1)}>+ Add track</button>
          </div>

          <div className="tl-lanes" ref={laneRef} onPointerDown={onLaneDown} onContextMenu={onLaneMenu} onDragOver={onDragOver} onDragLeave={() => setDropAt(null)} onDrop={onDrop}>
            <div className="ruler" style={{ height: RULER }}>
              {ticks.map(({ t, major: mj }) => (
                <div key={t.toFixed(4)} className={`tick ${mj ? 'major' : ''}`} style={{ left: x(t) }}>
                  {mj && <span>{timecode(t)}</span>}
                </div>
              ))}
              {(sdoc.markers ?? []).map((m) => {
                const t = drag?.mode === 'marker' && drag.id === m.id ? drag.t : markerTime(m, slay);
                return [
                  m.label && <span key={m.id + 'l'} className="marker-label" style={{ left: x(t) + 7 }}>{m.label}</span>,
                  <div key={m.id} className={`marker ${m.category ?? ''} ${selection?.kind === 'marker' && selection.id === m.id ? 'sel' : ''}`} style={{ left: x(t) }}
                    role="button" tabIndex={-1} aria-label={`Marker${m.label ? ` ${m.label}` : ''} at ${timecode(t)}${m.anchor ? ', attached' : ''}`}
                    title={`${m.label || 'Marker'}${m.notes ? `\n${m.notes}` : ''}\n${markerWhere(m, sdoc)}\nClick to jump and edit it, drag to move it, Alt-click to delete`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (e.button !== 0) return;
                      if (e.altKey) return deleteMarker(m.id);
                      setDrag({ mode: 'marker', id: m.id, x0: e.clientX, t0: t, t, moved: false });
                    }}
                    onDoubleClick={() => { selectMarker(m.id); setTimeout(() => document.querySelector<HTMLInputElement>('[aria-label="Marker name"]')?.focus(), 0); }} />,
                ];
              })}
              <div className="end-mark" style={{ left: x(end) }} title="Sequence end" />
              {area.set && (
                <div className="work-area" style={{ left: x(area.start), width: Math.max(2, (area.end - area.start) * pps) }}
                  title="The range played by Play In to Out and Loop: drag it to move it, drag its ends to change In and Out"
                  onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) setDrag({ mode: 'range', which: 'both', x0: e.clientX, in0: area.start, out0: area.end, orig: range }); }}>
                  <span className="wa-handle in" role="slider" aria-label="In" aria-valuemin={0} aria-valuemax={end} aria-valuenow={area.start} aria-valuetext={timecode(area.start)}
                    onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) setDrag({ mode: 'range', which: 'in', x0: e.clientX, in0: area.start, out0: area.end, orig: range }); }} />
                  <span className="wa-handle out" role="slider" aria-label="Out" aria-valuemin={0} aria-valuemax={end} aria-valuenow={area.end} aria-valuetext={timecode(area.end)}
                    onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) setDrag({ mode: 'range', which: 'out', x0: e.clientX, in0: area.start, out0: area.end, orig: range }); }} />
                </div>
              )}
              <RenderBar left={x(0)} width={end * pps} />
            </div>
            {stripH > 0 && <div className="lane-row steps-lane" style={{ top: RULER, height: stripH }} />}
            {Array.from({ length: rows }, (_, r) => <div key={r} className="lane-row" style={{ top: rowTop(r), height: rowH(r) }} />)}
            {/* Each self.play is the shaded column behind its clips: click it to select the group (its own settings, its
                length), drag one of its clips once it is selected to move the group, drag its right edge to retime it. */}
            {sdoc.timeline.filter((s) => s.kind === 'play' && !s.disabled).map((s) => {
              const sp = slay.steps.get(s.id)!;
              const n = s.anims?.length ?? 0;
              const kw = Object.entries(s.args ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
              return (
                <div key={'band' + s.id} className={`play-band ${selected.has(s.id) ? 'sel' : ''} ${ghost(s.id) ? 'ghost' : ''}`}
                  style={{ left: x(sp.start), width: Math.max(0, (sp.end - sp.start) * pps), top: rowTop(0), height: tracksH(rows) }}
                  tabIndex={0} role="button" aria-pressed={selected.has(s.id)}
                  aria-label={`Play together: ${n} animation${n === 1 ? '' : 's'}${kw ? ` (${kw})` : ''}, ${timecode(sp.start)} to ${timecode(sp.end)}`}
                  onKeyDown={(e) => keySelect(e, s.id)}>
                  {kw && (sp.end - sp.start) * pps > 40 && <span className="band-label">{kw}</span>}
                </div>
              );
            })}
            {slay.blocks.map((b) => renderBlock(b))}
            {rules(sdoc, slay).map((r) => {
              const left = x(r.start), w = Math.max((r.end - r.start) * pps, 4);
              const sel = r.object ? selection?.kind === 'object' && selection.id === r.id : selected.has(r.id);
              return (
                <div key={'rule' + r.id + r.start} className={`rule-bar ${sel ? 'sel' : ''}`} role="button" tabIndex={0}
                  style={{ left, width: w, top: RULER + blocksH + 1 + r.row * RULE_H, height: RULE_H - 2 }}
                  title={`${r.name}${r.what === '.add_updater(…)' ? '.add_updater(…)' : ` = ${r.what}(…)`}: manim runs it on every frame, ${timecode(r.start)} → ${timecode(r.end)}`}
                  aria-label={`Updater on ${r.name}, ${timecode(r.start)} to ${timecode(r.end)}`}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (r.object) setState({ selection: { kind: 'object', id: r.id } }); else selectClips([r.id]); } }}
                  onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); if (r.object) setState({ selection: { kind: 'object', id: r.id } }); else selectClips([r.id]); }}>
                  <span>⟳ {r.name}</span>
                </div>
              );
            })}
            {(() => {
              const steps = sdoc.timeline.filter((s) => !(s.kind === 'play' && !s.disabled) && s.kind !== 'block' && s.kind !== 'end');
              const fan = fanned(steps, slay);
              return steps.map((s) => renderStep(s, slay, fan));
            })()}
            {sdoc.timeline.filter((s) => s.kind === 'play' && !s.disabled).flatMap((s) => (s.anims ?? []).flatMap((a, i) => [renderAnim(a, s, i, slay), ...renderIters(a, i, slay)]))}
            {drag?.mode === 'marquee' && (
              <div className="marquee" style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }} />
            )}
            {dropAt && dropLanding && (
              <div className="drop-ind" style={{ left: x(dropLanding.time), top: dropAt.row < 0 ? RULER : rowTop(Math.min(dropAt.row, rows - 1)), height: dropAt.row < 0 ? stripH : rowH(Math.min(dropAt.row, rows - 1)) }}
                title={dropLanding.kind === 'join' ? 'Plays with the animations of this self.play' : 'A new self.play here'} />
            )}
            {note && (
              <div className={`drag-note ${note.warn ? 'warn' : ''}`} role="status" aria-live="polite"
                style={{ left: Math.max(4, Math.min(x(note.at) + 8, laneW - 360)), top: RULER + 4 }}>{note.text}</div>
            )}
            {area.set && area.start > 0 && <div className="wa-dim" style={{ left: 0, width: Math.max(0, x(area.start)), top: RULER, height: totalH - RULER }} />}
            {area.set && <div className="wa-dim" style={{ left: Math.max(0, x(area.end)), right: 0, top: RULER, height: totalH - RULER }} />}
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

function* flatKids(anims: Anim[], depth: number): Generator<{ a: Anim; depth: number }> {
  for (const a of anims) {
    yield { a, depth };
    if (a.anims) yield* flatKids(a.anims, depth + 1);
  }
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
  const end = Math.max(2, docLayout().end);
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

function ClipMenu({ x, y, id, onClose }: { x: number; y: number; id: string; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [onClose]);
  const s = getState();
  const lay = docLayout();
  const step = findStep(s.doc, id);
  const ref = step ? undefined : findAnim(s.doc, id);
  const item = (label: string, fn: () => void, hint?: string) => (
    <div className="menu-item" onPointerDown={(e) => { e.stopPropagation(); fn(); onClose(); }}>
      <span>{label}</span>
      {hint && <span className="muted">{hint}</span>}
    </div>
  );
  const ids = s.selection?.kind === 'clips' ? s.selection.ids : [id];
  const sp = (step ? lay.steps : lay.anims).get(id);
  const disabled = (step ?? ref?.anim)?.disabled;
  const target = ref?.anim.target;
  return (
    <div className="menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {item(disabled ? 'Enable' : 'Disable', () => toggleDisabled(ids), 'Shift+E')}
      {item('Delete (leave a gap)', () => deleteSelection(), 'Del')}
      {item('Ripple Delete', () => deleteSelection(true), keys('⇧Del'))}
      {sp && item('Move playhead to start', () => setState({ time: frameSnap(sp.start), showVideo: false }))}
      {sp && item('Move playhead to end', () => setState({ time: frameSnap(sp.end), showVideo: false }))}
      {ref && !step && item('Select the group it plays with', () => selectClips([ref.step.id]))}
      {item('Show in code', () => setState({ centerTab: 'code' }))}
      {target && s.doc.objects.some((o) => o.name === target) && item(`Select ${target}`, () => {
        const o = s.doc.objects.find((k) => k.name === target);
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

const firstLine = (code: string) => code.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';

/** How an animation reads on the timeline, and its code. */
export function animLabel(a: Anim): { name: string; sub: string; title: string } {
  if (a.cls === 'expr') return { name: exprName(a.src ?? ''), sub: (a.src ?? '').split('\n').join(' '), title: a.src ?? '' };
  if (a.cls === 'animate') {
    const chain = (a.chain ?? '').split('\n').join('').trim();
    return { name: `.animate${chain.match(/^\.\w+/)?.[0] ?? ''}`, sub: a.target, title: `${a.target}.animate${chain}` };
  }
  if (a.anims) return { name: a.cls, sub: `${a.anims.length} animation${a.anims.length === 1 ? '' : 's'}`, title: `${a.cls}(${a.anims.map((k) => animLabel(k).title).join(', ')})` };
  return { name: a.cls, sub: a.target || a.args['*'] || '', title: `${a.cls}(${[a.target, a.args['*']].filter(Boolean).join(', ')})` };
}

/** What a clip shows: the object first, then what happens to it ("circle · Create"). */
export function clipText(a: Anim): { name: string; sub: string } {
  if (a.cls === 'expr') return { name: exprName(a.src ?? ''), sub: (a.src ?? '').split('\n').join(' ') };
  if (a.anims) return { name: a.cls, sub: `${a.anims.length} animation${a.anims.length === 1 ? '' : 's'}` };
  if (a.cls === 'animate') return { name: a.target, sub: `.animate${(a.chain ?? '').split('\n').join('').trim().match(/^\.\w+/)?.[0] ?? ''}` };
  return a.target ? { name: a.target, sub: a.cls } : { name: a.cls, sub: a.args['*'] || '' };
}

/** `.next_to(…)` of `.next_to(u, UP).set_color(RED)`: the first method, for a short label. */
const firstCall = (chain: string) => {
  const names = [...chain.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]);
  return names.length ? `.${names[0]}(…)${names.length > 1 ? ` +${names.length - 1}` : ''}` : '';
};

/** What a step shows on the timeline, in plain words. */
export function stepText(s: Step): { name: string; sub: string } {
  const targets = (s.targets ?? []).join(', ');
  switch (s.kind) {
    case 'play': {
      const n = s.anims?.length ?? 0;
      return { name: 'Together', sub: `${n} animation${n === 1 ? '' : 's'}${s.disabled ? ' (disabled)' : ''}` };
    }
    case 'wait':
      return { name: 'Pause', sub: s.args?.duration ? `${s.args.duration}s` : '1s' };
    case 'add':
      return { name: 'Add', sub: targets };
    case 'remove':
      return { name: 'Remove', sub: targets };
    case 'apply':
      return { name: s.target ?? '', sub: firstCall(s.chain ?? '') };
    case 'assign':
      return { name: s.target ?? '', sub: `${s.op ?? '='} ${firstLine(s.value ?? '')}` };
    default: {
      const l = stepLabel(s);
      return { name: l.name, sub: l.sub };
    }
  }
}

/** How a statement reads on the timeline, and its code. */
export function stepLabel(s: Step): { name: string; sub: string; title: string } {
  const targets = (s.targets ?? []).join(', ');
  switch (s.kind) {
    case 'play': {
      const n = s.anims?.length ?? 0;
      const kw = Object.entries(s.args ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
      return { name: 'self.play', sub: kw || `${n} animation${n === 1 ? '' : 's'}`, title: `self.play(${(s.anims ?? []).map((a) => animLabel(a).title).join(', ')}${kw ? ', ' + kw : ''})` };
    }
    case 'wait':
      return { name: 'wait', sub: s.args?.duration ?? '', title: `self.wait(${s.args?.duration ?? ''})` };
    case 'code':
      return { name: s.label || 'code', sub: firstLine(s.code ?? ''), title: s.code ?? '' };
    case 'couple':
      return { name: 'Couple', sub: targets, title: `Couple ${targets} again${s.duration ? ', gliding back into place' : ''}` };
    case 'uncouple':
      return { name: 'Uncouple', sub: targets, title: `Uncouple ${targets}: they stay where they are and can be animated freely` };
    case 'call': {
      const kw = Object.entries(s.args ?? {}).map(([k, v]) => (k === '*' ? v : `${k}=${v}`)).join(', ');
      return { name: `self.${s.method}`, sub: kw, title: `self.${s.method}(${kw})` };
    }
    case 'apply':
      return { name: s.target ?? '', sub: firstCall(s.chain ?? ''), title: `${s.target ?? ''}${(s.chain ?? '').trim()}` };
    case 'block':
      return { name: (s.head ?? '').trim() || 'if True', sub: '', title: `${(s.head ?? '').trim() || 'if True'}:` };
    case 'end':
      return { name: 'end of block', sub: '', title: 'The end of a block: the steps after it run once it is done' };
    case 'assign':
      return { name: s.target ?? '', sub: `${s.op ?? '='} ${firstLine(s.value ?? '')}`, title: `${s.target ?? ''} ${s.op ?? '='} ${s.value ?? ''}` };
    default:
      return { name: s.kind === 'add' ? '+ add' : '− remove', sub: targets, title: `self.${s.kind}(${targets})` };
  }
}

/** How a clip shows what its animation does to its object (like transitions and keyframes in a video editor). */
const ROLE: Record<ClipRole, { badge: string; word: string; title: string }> = {
  in: { badge: 'IN', word: 'intro', title: 'Intro: brings its object on screen. The ramp shows it coming in, shaped by the easing' },
  out: { badge: 'OUT', word: 'outro', title: 'Outro: takes its object off screen' },
  swap: { badge: '⇄', word: 'swap', title: 'Swap: one object goes as another comes in (like a cross dissolve)' },
  effect: { badge: 'fx', word: 'effect', title: 'Effect: changes an object on screen, from the keyframe at its start ◆ to the one at its end ◆. The line is its easing' },
};

/** What a marker is attached to, in words. */
export function markerWhere(m: Marker, doc: SceneDoc): string {
  if (!m.anchor) return 'Stays at its time';
  const ref = findAnim(doc, m.anchor.id);
  const step = ref ? undefined : findStep(doc, m.anchor.id);
  const what = ref ? [animLabel(ref.anim).name, animLabel(ref.anim).sub].filter(Boolean).join(' ') : step ? stepLabel(step).name : 'a removed clip';
  const off = Math.abs(m.anchor.offset) < 1e-6 ? '' : ` ${m.anchor.offset > 0 ? '+' : '−'} ${Math.abs(m.anchor.offset)} s`;
  return `Attached to the ${m.anchor.edge} of ${what}${off}`;
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

function animColor(a: Anim, anims?: { name: string; category: string }[]): string {
  if (a.cls === 'animate') return '#2f5c8c';
  if (a.cls === 'expr') return CAT_COLORS[anims?.find((x) => x.name === exprName(a.src ?? ''))?.category ?? ''] ?? '#4a5a6e';
  if (a.anims) return CAT_COLORS.Composition;
  if (/^(FadeOut|Uncreate|Unwrite|ShrinkToCenter|FadeOutAndShift)/.test(a.cls)) return '#7a4545';
  return CAT_COLORS[anims?.find((x) => x.name === a.cls)?.category ?? ''] ?? '#3c5a75';
}

function tickSteps(pps: number): { major: number; minor: number } {
  const steps = [1 / 60, 1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const major = steps.find((s) => s * pps >= 90) ?? 600;
  const minor = [...steps].reverse().find((s) => s < major && s * pps >= 9 && Math.abs(major / s - Math.round(major / s)) < 1e-6) ?? major;
  return { major, minor };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ---- icons
const MagnetIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 2v5a4 4 0 0 0 8 0V2" />
    <path d="M3 4.5h2.4M8.6 4.5H11" />
  </svg>
);
