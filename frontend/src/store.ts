import { useSyncExternalStore } from 'react';
import { api } from './api';
import { dependentsOf, isFollow, isRedraw, linkSources, objectDeps, ownsPosition, remapLink, renameRefs, RESERVED_NAMES, sortByDependencies, wouldCycle } from './construct';
import { bakeTransform, freeShape, shapeCenter, writeShape } from './geometry';
import type { Args, Catalog, CatalogEntry, Clip, Job, Link, ObjInfo, ParamMeta, RunResult, SceneDoc, SceneObject, Selection, Signature, Template, Tool, Track } from './types';

export interface VideoState {
  jobId: string | null;
  key: string; // doc fingerprint the video was rendered from
  state: Job['state'];
  progress: number;
  message: string;
  url: string | null;
}

export interface AppState {
  doc: SceneDoc;
  previewDoc: SceneDoc | null; // uncommitted edit shown while dragging on the canvas
  path: string | null;
  dirty: boolean;
  selection: Selection;
  time: number;
  frame: RunResult | null;
  timeline: RunResult | null;
  catalog: Catalog | null;
  signatures: Record<string, Signature>;
  playing: boolean;
  past: SceneDoc[];
  future: SceneDoc[];
  panel: null | 'code' | 'settings' | 'export' | 'graph' | 'delete' | 'insert' | 'save-construction';
  panelData: unknown; // e.g. object ids for 'delete', a template for 'insert'
  tool: Tool; // canvas drawing tool
  starters: Template[]; // built-in constructions
  library: Template[]; // the user's saved constructions (~/.mathengine/constructions.json)
  snap: boolean; // canvas snapping
  timelineSnap: boolean;
  autoIntro: boolean;
  record: boolean;
  targetTrack: string | null;
  view: { pps: number; start: number }; // timeline zoom (pixels/second) and left edge (seconds)
  video: VideoState | null;
  showVideo: boolean; // playing the rendered preview video instead of live frames
  autoRender: boolean; // render a smooth preview in the background after edits
  toast: string | null;
}

export const emptyDoc = (): SceneDoc => ({
  version: 3,
  scene: { name: 'MainScene', base: 'Scene' },
  config: { pixel_width: 1920, pixel_height: 1080, frame_rate: 60, background_color: '#000000' },
  header: '',
  objects: [],
  tracks: [1, 2, 3].map((i) => ({ id: `t${i}`, name: `V${i}` })),
  clips: [],
  markers: [],
  constructions: [],
});

let state: AppState = {
  doc: emptyDoc(),
  previewDoc: null,
  path: null,
  dirty: false,
  selection: null,
  time: 0,
  frame: null,
  timeline: null,
  catalog: null,
  signatures: {},
  playing: false,
  past: [],
  future: [],
  panel: null,
  panelData: null,
  tool: 'select',
  starters: [],
  library: [],
  snap: true,
  timelineSnap: true,
  autoIntro: true,
  record: false,
  targetTrack: null,
  view: { pps: 110, start: 0 },
  video: null,
  showVideo: false,
  autoRender: true,
  toast: null,
};

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getState = () => state;

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const prev = state;
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  if (state.doc !== prev.doc) {
    scheduleTimeline();
    requestFrame();
    schedulePreviewRender();
    if (state.showVideo) state = { ...state, showVideo: false };
  } else if (state.time !== prev.time || state.previewDoc !== prev.previewDoc) {
    requestFrame();
  }
  if (state.doc.header !== prev.doc.header) void loadCatalog();
  listeners.forEach((l) => l());
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

// ---------------------------------------------------------------- history

let lastCoalesce: { key: string; at: number } | null = null;

/** Mutate a copy of the document. `coalesce` merges rapid edits (e.g. typing) into one undo step. */
export function updateDoc(fn: (d: SceneDoc) => void, coalesce?: string) {
  const next = structuredClone(state.doc);
  fn(next);
  const now = Date.now();
  const merge = coalesce && lastCoalesce?.key === coalesce && now - lastCoalesce.at < 1200;
  lastCoalesce = coalesce ? { key: coalesce, at: now } : null;
  setState((s) => ({ doc: next, dirty: true, past: merge ? s.past : [...s.past.slice(-199), s.doc], future: [] }));
}

export function undo() {
  const { past, doc, future } = state;
  if (!past.length) return;
  lastCoalesce = null;
  setState({ doc: past[past.length - 1], past: past.slice(0, -1), future: [doc, ...future], dirty: true });
}

export function redo() {
  const { past, doc, future } = state;
  if (!future.length) return;
  lastCoalesce = null;
  setState({ doc: future[0], future: future.slice(1), past: [...past, doc], dirty: true });
}

export function loadDoc(doc: SceneDoc, path: string | null) {
  doc.markers ??= [];
  doc.constructions ??= [];
  setState({ video: null, showVideo: false,  doc, path, dirty: false, past: [], future: [], selection: null, time: 0, timeline: null, frame: null });
}

export function toast(msg: string) {
  setState({ toast: msg });
  setTimeout(() => getState().toast === msg && setState({ toast: null }), 4000);
}

// ---------------------------------------------------------------- backend sync

let frameBusy = false;
let frameWanted = false;
export let previewWidth = 960;
export const setPreviewWidth = (w: number) => {
  previewWidth = w;
};

export function requestFrame() {
  frameWanted = true;
  void pumpFrames();
}

async function pumpFrames() {
  if (frameBusy || !frameWanted) return;
  frameWanted = false;
  frameBusy = true;
  const doc = state.previewDoc ?? state.doc;
  const time = state.time;
  // Like Premiere's playback resolution: half-res while playing live so frames keep up.
  const width = state.playing ? Math.max(320, Math.round(previewWidth / 2)) : previewWidth;
  try {
    const frame = await api.run(doc, time, true, width);
    // While the scene is broken, keep showing the last good picture (dimmed by the viewport).
    if (frame.error && state.frame?.image) frame.image = state.frame.image;
    // Requests are sequential, so this is always the newest frame we have: show it even if
    // another one is already wanted (during playback one always is).
    const patch: Partial<AppState> = { frame };
    // After pausing a preview video, switch back to live frames once the exact frame is here.
    if (state.showVideo && !state.playing && time === state.time && doc === state.doc) patch.showVideo = false;
    setState(patch);
  } catch (e) {
    toast(String(e));
  }
  frameBusy = false;
  void pumpFrames();
}

let timelineTimer: number | undefined;
let timelineBusy = false;
let timelineWanted = false;
function scheduleTimeline() {
  clearTimeout(timelineTimer);
  timelineTimer = window.setTimeout(() => void runTimeline(), 150);
}

/** One timeline analysis at a time (each waits for manim): queued edits collapse into one request for the latest document. */
async function runTimeline() {
  if (timelineBusy) {
    timelineWanted = true;
    return;
  }
  timelineBusy = true;
  timelineWanted = false;
  const doc = state.doc;
  try {
    const timeline = await api.run(doc, null, false);
    if (state.doc === doc) setState({ timeline });
  } catch (e) {
    toast(String(e));
  }
  timelineBusy = false;
  if (timelineWanted || state.doc !== doc) void runTimeline();
}

let catalogHeader: string | null = null;
export async function loadCatalog() {
  const header = state.doc.header;
  if (catalogHeader === header) return;
  catalogHeader = header;
  try {
    const catalog = await api.catalog(header);
    setState({ catalog, signatures: {} });
  } catch (e) {
    toast(String(e));
  }
}

const sigPending = new Set<string>();
export function objectClasses(doc: SceneDoc): Record<string, string> {
  return Object.fromEntries(doc.objects.filter((o) => /^\w+$/.test(o.ctor)).map((o) => [o.name, o.ctor]));
}

export function useSignature(expr: string): Signature | undefined {
  const sig = useStore((s) => s.signatures[expr]);
  if (!sig) ensureSignature(expr);
  return sig;
}

/** Start loading a signature (outside React render-hooks rules; results land in state.signatures). */
export function ensureSignature(expr: string) {
  if (expr && !state.signatures[expr] && !sigPending.has(expr)) {
    sigPending.add(expr);
    api
      .signature(expr, state.doc.header, objectClasses(state.doc))
      .then((res) => setState((s) => ({ signatures: { ...s.signatures, [expr]: res } })))
      .catch(() => undefined)
      .finally(() => sigPending.delete(expr));
  }
}

// ---------------------------------------------------------------- time helpers

export const fps = () => state.doc.config.frame_rate || 60;
export const frameSnap = (t: number) => Math.max(0, Math.round(t * fps()) / fps());

/** Measured duration of code clips (they may contain their own self.play calls). */
export function clipDuration(c: Clip, timeline: RunResult | null): number {
  if (c.kind === 'code') {
    const m = timeline?.steps.find((s) => s.id === c.id);
    if (m) return Math.max(0.1, m.end - m.start);
  }
  return c.duration;
}

export function sequenceEnd(doc: SceneDoc, timeline: RunResult | null): number {
  const ends = doc.clips.map((c) => c.start + clipDuration(c, timeline));
  return Math.max(0, ...ends, timeline && !timeline.error ? timeline.duration : 0);
}

export function timecode(t: number, rate = fps()): string {
  const total = Math.round(Math.max(0, t) * rate);
  const f = total % rate;
  const s = Math.floor(total / rate);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f, String(rate - 1).length)}`;
}

/** Parse "1.5", "1:02.5", or "00:00:05:12" (frames). */
export function parseTimecode(text: string, rate = fps()): number | null {
  const s = text.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(/[:;]/).map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / rate;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// ---------------------------------------------------------------- playback

let playRaf = 0;
export function setPlaying(playing: boolean) {
  cancelAnimationFrame(playRaf);
  const duration = sequenceEnd(state.doc, state.timeline);
  if (playing && state.time >= duration - 1e-3) setState({ time: 0 });
  setState({ playing, showVideo: playing ? previewFresh() : state.showVideo });
  if (!playing) return requestFrame();
  let last = performance.now();
  const tick = (now: number) => {
    const s = getState();
    if (!s.playing) return;
    const end = sequenceEnd(s.doc, s.timeline);
    const t = Math.min(end, s.time + (now - last) / 1000);
    last = now;
    if (!s.showVideo) setState({ time: t });
    if (t >= end && !s.showVideo) return setState({ playing: false });
    playRaf = requestAnimationFrame(tick);
  };
  playRaf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- background preview renders

let renderTimer: number | undefined;
function schedulePreviewRender() {
  clearTimeout(renderTimer);
  if (state.autoRender) renderTimer = window.setTimeout(() => void renderPreview(), 1500);
}

/** The rendered preview video matches the current document and can be played. */
export function previewFresh(s: AppState = state): boolean {
  return !!s.video && s.video.state === 'done' && !!s.video.url && s.video.key === docKey(s.doc);
}

/** Render a smooth 480p preview with the manim CLI (cached per animation by manim). */
export async function renderPreview() {
  const doc = state.doc;
  const key = docKey(doc);
  const v = state.video;
  if (v && v.key === key && v.state !== 'cancelled') return; // already rendered, rendering, or failed for this exact doc
  if (!doc.clips.length) return;
  try {
    const job = await api.render(doc, 'preview');
    if (job.state === 'error' || !job.id) {
      setState({ video: { jobId: null, key, state: 'error', progress: 0, message: job.message, url: null } });
      return;
    }
    setState({ video: { jobId: job.id, key, state: job.state, progress: 0, message: job.message, url: null } });
    const id = job.id;
    const tick = async () => {
      const cur = state.video;
      if (!cur || cur.jobId !== id) return;
      try {
        const j = await api.job(id);
        const done = j.state === 'done';
        setState({ video: { ...cur, state: j.state, progress: j.progress ?? 0, message: j.message, url: done ? api.mediaUrl(id) : null } });
        if (j.state === 'running' || j.state === 'queued') setTimeout(tick, 400);
      } catch (e) {
        toast(String(e));
      }
    };
    setTimeout(tick, 300);
  } catch (e) {
    toast(String(e));
  }
}

// ---------------------------------------------------------------- document helpers

export const uid = (p: string) => p + Math.random().toString(36).slice(2, 9);

export function snake(cls: string): string {
  return cls.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

export function uniqueName(doc: SceneDoc, base: string): string {
  const taken = new Set(doc.objects.map((o) => o.name));
  base = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'obj';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(base + i)) return base + i;
}

const EPS = 1e-6;
const span = (c: Clip) => Math.max(c.duration, 0.05);

export function trackIsFree(doc: SceneDoc, trackId: string, start: number, end: number, ignore: Set<string> = new Set()): boolean {
  return !doc.clips.some((c) => c.track === trackId && !ignore.has(c.id) && c.start < end - EPS && c.start + span(c) > start + EPS);
}

/** Pick a track for a new clip: explicit → targeted track → target object's track → first free → new. */
export function chooseTrack(doc: SceneDoc, start: number, dur: number, opts: { track?: string; target?: string; ignore?: Set<string> } = {}): string {
  const end = start + Math.max(dur, 0.05);
  const free = (id: string) => !doc.tracks.find((t) => t.id === id)?.locked && trackIsFree(doc, id, start, end, opts.ignore);
  if (opts.track && free(opts.track)) return opts.track;
  if (state.targetTrack && free(state.targetTrack)) return state.targetTrack;
  if (opts.target) {
    const prev = doc.clips.filter((c) => c.target === opts.target || c.targets?.includes(opts.target!)).sort((a, b) => b.start - a.start)[0];
    if (prev && free(prev.track)) return prev.track;
  }
  const t = doc.tracks.find((tr) => free(tr.id));
  if (t) return t.id;
  return addTrackTo(doc).id;
}

export function addTrackTo(doc: SceneDoc): Track {
  const n = doc.tracks.length + 1;
  let id = `t${n}`;
  while (doc.tracks.some((t) => t.id === id)) id += '_';
  const track = { id, name: `V${n}` };
  doc.tracks.push(track);
  return track;
}

const WRITE_LIKE = new Set(['Text', 'Tex', 'MathTex', 'MarkupText', 'Paragraph', 'Code', 'DecimalNumber', 'Integer', 'Variable', 'Title', 'BulletedList']);
const NO_INTRO = new Set(['ValueTracker', 'ComplexValueTracker']);

function introFor(entry: CatalogEntry | undefined, ctor: string): string | null {
  if (NO_INTRO.has(ctor)) return null;
  if (WRITE_LIKE.has(ctor)) return 'Write';
  if (entry && !entry.vector) return 'FadeIn';
  return 'Create';
}

/** Ids of the selected objects (one or several). */
export function selectedObjectIds(sel: Selection = state.selection): string[] {
  if (sel?.kind === 'object') return [sel.id];
  if (sel?.kind === 'objects') return sel.ids;
  return [];
}

/** Select objects: one (with optional equation terms) or several. */
export function selectObjects(ids: string[], terms?: string[]) {
  setState({ selection: ids.length === 0 ? null : ids.length === 1 ? { kind: 'object', id: ids[0], terms } : { kind: 'objects', ids } });
}

/** Shift-click: add to or remove from the object selection. */
export function toggleObjectSelection(id: string) {
  const ids = selectedObjectIds();
  selectObjects(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
}

export function selectClips(ids: string[]) {
  setState({ selection: ids.length ? { kind: 'clips', ids } : null });
}

export function addObject(ctor: string, pos: [number, number] | null, targetName?: string, at?: { start?: number; track?: string }, initial?: Args): string {
  const entry = state.catalog?.mobjects.find((m) => m.name === ctor);
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry?.starter ?? {})) args[k] = v === '@target' ? targetName ?? '' : v;
  Object.assign(args, initial); // explicit arguments (drawn geometry, factory defaults) win over starters
  if (initial?.start !== undefined || initial?.end !== undefined) delete args['*'];
  const intro = state.autoIntro ? introFor(entry, ctor) : null;
  const start = frameSnap(at?.start ?? state.time);
  let newId = '';
  let end = start;
  updateDoc((d) => {
    const name = uniqueName(d, snake(ctor.split('.').pop() || 'obj'));
    const obj: SceneObject = { id: uid('o'), name, ctor, args, pos, chain: '' };
    newId = obj.id;
    d.objects.push(obj);
    if (intro) {
      d.clips.push({ id: uid('c'), kind: 'anim', track: chooseTrack(d, start, 1, { track: at?.track }), start, duration: 1, cls: intro, target: name, args: {} });
      end = start + 1;
    } else if (!NO_INTRO.has(ctor)) {
      d.clips.push({ id: uid('c'), kind: 'add', track: chooseTrack(d, start, 0, { track: at?.track }), start, duration: 0, targets: [name] });
    }
  });
  setState({ selection: { kind: 'object', id: newId }, time: end });
  return newId;
}

export function addAnimation(cls: string, target: string, at?: { start?: number; track?: string }) {
  const start = frameSnap(at?.start ?? state.time);
  const clip: Clip = { id: uid('c'), kind: 'anim', track: '', start, duration: 1, cls, target, args: {} };
  if (cls === 'animate') clip.chain = '.shift(RIGHT)';
  updateDoc((d) => {
    clip.track = chooseTrack(d, start, 1, { track: at?.track, target });
    d.clips.push(clip);
  });
  setState({ selection: { kind: 'clips', ids: [clip.id] }, time: start + 1 });
}

export function addClip(kind: 'code' | 'hold' | 'add' | 'remove', at?: { start?: number; track?: string }) {
  const start = frameSnap(at?.start ?? state.time);
  const duration = kind === 'add' || kind === 'remove' ? 0 : 1;
  const clip: Clip = { id: uid('c'), kind, track: '', start, duration };
  if (kind === 'code') clip.code = '# any manim code; every object variable is in scope\n';
  if (kind === 'add' || kind === 'remove') clip.targets = [];
  updateDoc((d) => {
    clip.track = chooseTrack(d, start, duration, { track: at?.track });
    d.clips.push(clip);
  });
  selectClips([clip.id]);
}

export function addMarker(time = state.time) {
  updateDoc((d) => {
    d.markers ??= [];
    d.markers.push({ id: uid('m'), time: frameSnap(time) });
  });
}

/** All edit points (clip starts/ends + markers), for ↑/↓ navigation and snapping. */
export function editPoints(doc: SceneDoc, timeline: RunResult | null): number[] {
  const pts = new Set<number>([0]);
  for (const c of doc.clips) {
    pts.add(c.start);
    pts.add(c.start + clipDuration(c, timeline));
  }
  for (const m of doc.markers ?? []) pts.add(m.time);
  return [...pts].sort((a, b) => a - b);
}

export function addTrack() {
  updateDoc((d) => void addTrackTo(d));
}

const wordRe = (name: string) => new RegExp(`\\b${name.replace(/[^\w]/g, '')}\\b`, 'g');

export function renameObject(id: string, newName: string) {
  const obj = state.doc.objects.find((o) => o.id === id);
  if (!obj || obj.name === newName) return;
  if (RESERVED_NAMES.has(newName)) return toast(`"${newName}" is used by the generated code`);
  const re = wordRe(obj.name);
  const rep = (s: string) => s.replace(re, newName);
  const names = new Map([[obj.name, newName]]);
  updateDoc((d) => {
    for (const o of d.objects) {
      if (o.id === id) o.name = newName;
      renameRefs(o, names); // Python fields and link expressions (parameter names); link sources are ids
    }
    for (const c of d.clips) {
      if (c.target) c.target = rep(c.target);
      if (c.chain) c.chain = rep(c.chain);
      if (c.code) c.code = rep(c.code);
      if (c.targets) c.targets = c.targets.map(rep);
      for (const k in c.args ?? {}) c.args![k] = rep(c.args![k]);
    }
  });
}

export const isLocked = (d: SceneDoc, c: Clip) => !!d.tracks.find((t) => t.id === c.track)?.locked;

export function deleteSelection(ripple = false) {
  const sel = state.selection;
  if (!sel) return;
  if (sel.kind === 'object' || sel.kind === 'objects') {
    const ids = selectedObjectIds(sel);
    const deps = dependentsOf(state.doc, ids);
    if (deps.length) return setState({ panel: 'delete', panelData: ids }); // ask: delete them too, or detach
    return deleteObjects(ids, 'cascade');
  }
  updateDoc((d) => {
    const ids = new Set(sel.ids);
    const removed = d.clips.filter((c) => ids.has(c.id) && !isLocked(d, c));
    d.clips = d.clips.filter((c) => !removed.includes(c));
    if (ripple) {
      // Close the gaps left behind across all tracks, like Premiere's ripple delete.
      for (const r of removed.sort((a, b) => b.start - a.start)) {
        const gapEnd = r.start + r.duration;
        const blocked = d.clips.some((c) => c.start < gapEnd - EPS && c.start + c.duration > r.start + EPS);
        if (blocked) continue;
        for (const c of d.clips) if (c.start >= gapEnd - EPS && !isLocked(d, c)) c.start = Math.max(0, c.start - r.duration);
      }
    }
  });
  setState({ selection: null });
}

/**
 * Remove objects. Objects built from them are either deleted too ('cascade'), or 'detach'ed:
 * converted to plain objects at their current geometry where possible (points, labels, segments,
 * circles, polygons); constructions that can't exist without their source (angles, areas, braces…)
 * are always deleted.
 */
export function deleteObjects(ids: string[], mode: 'cascade' | 'detach') {
  const frame = state.frame;
  const remove = new Set(ids);
  updateDoc((d) => {
    // Handle objects built directly from removed ones; only removals propagate further.
    for (let grew = true; grew; ) {
      grew = false;
      for (const o of d.objects) {
        if (remove.has(o.id) || !objectDeps(o, d).some((x) => remove.has(x))) continue;
        // Objects referring to a removed one through Python (axes.plot on deleted axes) can't be detached.
        if (mode === 'cascade' || !o.link || !detachInPlace(o, frame?.objects.find((i) => i.id === o.id), true)) {
          remove.add(o.id);
          grew = true;
        }
      }
    }
    const names = new Set(d.objects.filter((o) => remove.has(o.id)).map((o) => o.name));
    d.objects = d.objects.filter((o) => !remove.has(o.id));
    d.clips = d.clips.filter((c) => !names.has(c.target ?? '') && !(c.terms && remove.has(c.terms.to)));
    for (const c of d.clips) if (c.targets) c.targets = c.targets.filter((t) => !names.has(t));
  });
  setState({ selection: null, panel: null, panelData: null });
}

/**
 * Turn a constructed object into an independent one. Follow links keep the object at its current
 * position; segments, circles and polygons become plain shapes with their current geometry. Others
 * are frozen (built once from their sources, no longer updated) unless `convertOnly`, which reports
 * false so the caller can delete them.
 */
export function detachInPlace(o: SceneObject, info: ObjInfo | undefined, convertOnly = false): boolean {
  const l = o.link;
  if (!l) return true;
  const g = info?.geom;
  if (isFollow(o) || (l.frozen && l.kind in { attach: 1, midpoint: 1, on_graph: 1, on_circle: 1, coords: 1, measure: 1 })) {
    delete o.link;
    if (info?.center) o.pos = [Math.round(info.center[0] * 1000) / 1000, Math.round(info.center[1] * 1000) / 1000];
    return true;
  }
  if (l.kind === 'segment' && g?.kind === 'line') {
    delete o.link;
    writeShape(o, { kind: 'line', start: g.start, end: g.end });
    return true;
  }
  if (l.kind === 'circle2' && g?.kind === 'circle') {
    delete o.link;
    writeShape(o, { kind: 'circle', center: g.center, r: g.radius });
    return true;
  }
  if (l.kind === 'polygon' && g?.kind === 'polygon') {
    delete o.link;
    o.ctor = 'Polygon';
    writeShape(o, { kind: 'polygon', vertices: g.vertices });
    return true;
  }
  if (convertOnly) return false;
  l.frozen = true;
  return true;
}

export function detachObjects(ids: string[]) {
  const frame = state.frame;
  updateDoc((d) => {
    for (const o of d.objects) if (ids.includes(o.id)) detachInPlace(o, frame?.objects.find((i) => i.id === o.id));
  });
}

export function duplicateObject(id: string) {
  duplicateObjects([id]);
}

/**
 * Copy objects. Links between copied objects point at the copies; links to objects outside the
 * selection keep pointing at the originals (a duplicated label stays attached to the same point).
 * Free geometry is offset so the copy is visible; constructed copies follow their sources.
 */
export function duplicateObjects(ids: string[]) {
  const srcs = state.doc.objects.filter((o) => ids.includes(o.id));
  if (!srcs.length) return;
  const newIds: string[] = [];
  updateDoc((d) => {
    const idMap = new Map<string, string>();
    const nameMap = new Map<string, string>();
    const copies: SceneObject[] = [];
    for (const src of srcs) {
      const copy: SceneObject = { ...structuredClone(src), id: uid('o'), name: uniqueName(d, src.name.replace(/\d+$/, '')) };
      delete copy.instance; // a copy of part of an instance is an independent object
      idMap.set(src.id, copy.id);
      nameMap.set(src.name, copy.name);
      d.objects.push(copy); // reserve the name for the next uniqueName
      copies.push(copy);
    }
    for (const copy of copies) {
      remapLink(copy, idMap);
      renameRefs(copy, nameMap);
      if (!copy.link) {
        const shape = freeShape(copy);
        const moved = shape && bakeTransform(shape, { move: [0.5, -0.5] }, shapeCenter(shape));
        if (moved) writeShape(copy, moved);
        else if (copy.pos) copy.pos = [copy.pos[0] + 0.5, copy.pos[1] - 0.5];
      } else if (copy.link.kind === 'attach' || copy.link.kind === 'measure') {
        const off = copy.link.offset ?? [0, 0];
        copy.link.offset = [off[0] + 0.3, off[1] - 0.3];
      }
      newIds.push(copy.id);
    }
    // Copies go right after their originals, then dependencies decide the final order.
    d.objects = d.objects.filter((o) => !copies.includes(o));
    const last = Math.max(...srcs.map((s) => d.objects.findIndex((o) => o.id === s.id)));
    d.objects.splice(last + 1, 0, ...copies);
    sortByDependencies(d);
    const start = frameSnap(state.time);
    for (const copy of copies) {
      const entry = state.catalog?.mobjects.find((m) => m.name === copy.ctor);
      const intro = state.autoIntro ? introFor(entry, copy.ctor) : null;
      if (intro) d.clips.push({ id: uid('c'), kind: 'anim', track: chooseTrack(d, start, 1), start, duration: 1, cls: intro, target: copy.name, args: {} });
    }
  });
  selectObjects(newIds);
}

// ---------------------------------------------------------------- constructions

export interface LinkedSpec {
  ctor: string;
  link: Link;
  name?: string;
  args?: Args;
  pos?: [number, number] | null;
  intro?: string | null; // undefined: automatic
}

/** Add an object defined by a link (sources must already exist). Returns its id, or null if invalid. */
export function createLinked(spec: LinkedSpec, opts: { select?: boolean; time?: number } = {}): string | null {
  const id = uid('o');
  if (wouldCycle(state.doc, id, linkSources(spec.link))) {
    toast('That would make the construction depend on itself');
    return null;
  }
  const entry = state.catalog?.mobjects.find((m) => m.name === spec.ctor);
  const intro = spec.intro !== undefined ? spec.intro : state.autoIntro ? introFor(entry, spec.ctor) : null;
  const start = frameSnap(opts.time ?? state.time);
  updateDoc((d) => {
    const name = uniqueName(d, spec.name ?? snake(spec.ctor.split('.').pop() || 'obj'));
    d.objects.push({ id, name, ctor: spec.ctor, args: { ...spec.args }, pos: spec.pos ?? null, chain: '', link: spec.link });
    sortByDependencies(d);
    if (intro) d.clips.push({ id: uid('c'), kind: 'anim', track: chooseTrack(d, start, 1), start, duration: 1, cls: intro, target: name, args: {} });
    else if (spec.intro === undefined && !NO_INTRO.has(spec.ctor)) d.clips.push({ id: uid('c'), kind: 'add', track: chooseTrack(d, start, 0), start, duration: 0, targets: [name] });
  });
  if (opts.select !== false) selectObjects([id]);
  if (intro) setState({ time: start + 1 }); // like addObject: show the object once its intro has played
  return id;
}

/** Change an object's link (cycle-checked; reorders objects so sources come first). */
export function setLink(id: string, fn: (l: Link) => void, coalesce?: string) {
  const o = state.doc.objects.find((x) => x.id === id);
  if (!o?.link) return;
  const next = structuredClone(o.link);
  fn(next);
  if (wouldCycle(state.doc, id, linkSources(next))) return toast('That would make the construction depend on itself');
  updateDoc((d) => {
    d.objects.find((x) => x.id === id)!.link = next;
    sortByDependencies(d);
  }, coalesce ?? `${id}:link`);
}

/** Apply an edit to a scratch copy shown on the canvas while dragging (not committed). */
export function previewEdit(fn: (d: SceneDoc) => void) {
  const doc = structuredClone(state.doc);
  fn(doc);
  setState({ previewDoc: doc });
}

/** Commit a canvas edit. */
export function commitEdit(fn: (d: SceneDoc) => void, coalesce?: string) {
  setState({ previewDoc: null });
  updateDoc(fn, coalesce);
}

// ---------------------------------------------------------------- parameters

export const params = (doc: SceneDoc) => doc.objects.filter((o) => o.ctor === 'ValueTracker');

/** Create a parameter (a ValueTracker at the top of the scene, so everything can use it); returns its name. */
export function createParam(d: SceneDoc, name: string, value: number, meta: ParamMeta): string {
  const existing = d.objects.find((o) => o.name === name);
  if (existing) return existing.name;
  const obj: SceneObject = { id: uid('o'), name: uniqueName(d, name), ctor: 'ValueTracker', args: { '*': String(value) }, pos: null, chain: '', param: meta };
  d.objects.unshift(obj);
  return obj.name;
}

export function setParamValue(name: string, v: number) {
  updateDoc((d) => {
    const o = d.objects.find((x) => x.name === name && x.ctor === 'ValueTracker');
    if (o) o.args['*'] = String(v);
  }, `param:${name}`);
}

/** Animate a parameter to a value at the playhead (an .animate.set_value clip on the timeline). */
export function animateParam(name: string, to: number, duration = 1) {
  const start = frameSnap(state.time);
  const clip: Clip = { id: uid('c'), kind: 'anim', track: '', start, duration, cls: 'animate', target: name, args: {}, chain: `.set_value(${Math.round(to * 1000) / 1000})` };
  updateDoc((d) => {
    clip.track = chooseTrack(d, start, duration, { target: name });
    d.clips.push(clip);
  });
  setState({ selection: { kind: 'clips', ids: [clip.id] }, time: start + duration });
}

// ---------------------------------------------------------------- clipboard

let clipboard: Clip[] = [];
export function copyClips() {
  if (state.selection?.kind !== 'clips') return;
  const ids = new Set(state.selection.ids);
  clipboard = structuredClone(state.doc.clips.filter((c) => ids.has(c.id)));
  toast(`Copied ${clipboard.length} clip${clipboard.length === 1 ? '' : 's'}`);
}

export function pasteClips() {
  if (!clipboard.length) return;
  const t0 = Math.min(...clipboard.map((c) => c.start));
  const at = frameSnap(state.time);
  const ids: string[] = [];
  updateDoc((d) => {
    for (const c of clipboard) {
      const copy: Clip = { ...structuredClone(c), id: uid('c'), start: at + (c.start - t0) };
      copy.track = chooseTrack(d, copy.start, copy.duration, { track: c.track });
      d.clips.push(copy);
      ids.push(copy.id);
    }
  });
  selectClips(ids);
}

// ---------------------------------------------------------------- canvas edits

export const fmt = (v: number) => String(Math.round(v * 100) / 100);
const snapV = (v: number) => (state.snap ? Math.round(v * 4) / 4 : Math.round(v * 100) / 100);
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export interface TransformDelta {
  move?: [number, number];
  scale?: number; // multiplicative
  stretch?: [number, number]; // multiplicative
  rotate?: number; // degrees, additive
}

function applyTransform(o: SceneObject, t: TransformDelta, center: [number, number] | null) {
  // Free shapes keep their defining parameters (endpoints, vertices, radius, size) instead of a transform.
  const shape = freeShape(o);
  if (shape) {
    const baked = bakeTransform(shape, t.move ? { move: t.move } : t, shapeCenter(shape));
    if (baked) {
      if (t.move && state.snap && baked.kind !== 'polygon' && baked.kind !== 'line') {
        const c = shapeCenter(baked);
        const sc = [snapV(c[0]), snapV(c[1])] as [number, number];
        const fix = bakeTransform(baked, { move: [sc[0] - c[0], sc[1] - c[1]] }, c);
        if (fix) return writeShape(o, fix);
      }
      return writeShape(o, baked);
    }
  }
  if (isRedraw(o)) return; // the construction defines its shape and position
  if (t.move && ownsPosition(o)) return; // position comes from the construction (handled by the canvas)
  if (t.move) {
    const base = o.pos ?? center ?? [0, 0];
    o.pos = [snapV(base[0] + t.move[0]), snapV(base[1] + t.move[1])];
  }
  if (t.scale !== undefined) o.scale = round3((o.scale ?? 1) * t.scale);
  if (t.stretch) {
    const s = o.stretch ?? [1, 1];
    o.stretch = [round3(s[0] * t.stretch[0]), round3(s[1] * t.stretch[1])];
  }
  if (t.rotate) o.rotation = round3(((o.rotation ?? 0) + t.rotate) % 360);
}

/** Show a canvas drag/resize/rotate live without committing it. */
export function previewTransform(id: string, t: TransformDelta, center: [number, number] | null) {
  if (state.record) return;
  const doc = structuredClone(state.doc);
  const o = doc.objects.find((x) => x.id === id);
  if (!o) return;
  applyTransform(o, t, center);
  setState({ previewDoc: doc });
}

/** Commit a canvas edit: change the object, or in record mode add an .animate clip at the playhead. */
export function commitTransform(id: string, t: TransformDelta, center: [number, number] | null) {
  setState({ previewDoc: null });
  const obj = state.doc.objects.find((o) => o.id === id);
  if (!obj) return;
  if (!state.record) {
    updateDoc((d) => applyTransform(d.objects.find((x) => x.id === id)!, t, center));
    return;
  }
  let chain = '';
  if (t.move && center) chain = `.move_to(np.array([${fmt(snapV(center[0] + t.move[0]))}, ${fmt(snapV(center[1] + t.move[1]))}, 0]))`;
  else if (t.scale !== undefined) chain = `.scale(${round3(t.scale)})`;
  else if (t.stretch) chain = t.stretch[0] !== 1 ? `.stretch(${round3(t.stretch[0])}, 0)` : `.stretch(${round3(t.stretch[1])}, 1)`;
  else if (t.rotate) chain = `.rotate(${round3(t.rotate)} * DEGREES)`;
  if (!chain) return;
  const time = frameSnap(state.time);
  // Re-dragging right after recording a move edits that move instead of stacking another one.
  const existing = chain.startsWith('.move_to(')
    ? state.doc.clips.find((c) => c.cls === 'animate' && c.target === obj.name && c.chain?.startsWith('.move_to(') && Math.abs(c.start + c.duration - time) < 1e-3)
    : undefined;
  if (existing) {
    updateDoc((d) => void (d.clips.find((c) => c.id === existing.id)!.chain = chain));
    return;
  }
  const clip: Clip = { id: uid('c'), kind: 'anim', track: '', start: time, duration: 1, cls: 'animate', target: obj.name, args: {}, chain };
  updateDoc((d) => {
    clip.track = chooseTrack(d, time, 1, { target: obj.name });
    d.clips.push(clip);
  });
  setState({ time: time + 1 });
}

export function docKey(doc: SceneDoc): string {
  return JSON.stringify(doc);
}
