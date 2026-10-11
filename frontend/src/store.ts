import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { Args, Catalog, CatalogEntry, Clip, Job, RunResult, SceneDoc, SceneObject, Selection, Signature, Track } from './types';

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
  panel: null | 'code' | 'settings' | 'export';
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
  version: 2,
  scene: { name: 'MainScene', base: 'Scene' },
  config: { pixel_width: 1920, pixel_height: 1080, frame_rate: 60, background_color: '#000000' },
  header: '',
  objects: [],
  tracks: [1, 2, 3].map((i) => ({ id: `t${i}`, name: `V${i}` })),
  clips: [],
  markers: [],
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
function scheduleTimeline() {
  clearTimeout(timelineTimer);
  timelineTimer = window.setTimeout(async () => {
    const doc = state.doc;
    try {
      const timeline = await api.run(doc, null, false);
      if (state.doc === doc) setState({ timeline });
    } catch (e) {
      toast(String(e));
    }
  }, 150);
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

export function selectClips(ids: string[]) {
  setState({ selection: ids.length ? { kind: 'clips', ids } : null });
}

export function addObject(ctor: string, pos: [number, number] | null, targetName?: string, at?: { start?: number; track?: string }, initial?: Args) {
  const entry = state.catalog?.mobjects.find((m) => m.name === ctor);
  const args: Record<string, string> = { ...initial };
  for (const [k, v] of Object.entries(entry?.starter ?? {})) args[k] = v === '@target' ? targetName ?? '' : v;
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
  const re = wordRe(obj.name);
  const rep = (s: string) => s.replace(re, newName);
  updateDoc((d) => {
    for (const o of d.objects) {
      if (o.id === id) o.name = newName;
      o.ctor = rep(o.ctor);
      o.chain = rep(o.chain);
      for (const k in o.args) o.args[k] = rep(o.args[k]);
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
  updateDoc((d) => {
    if (sel.kind === 'object') {
      const obj = d.objects.find((o) => o.id === sel.id);
      d.objects = d.objects.filter((o) => o.id !== sel.id);
      if (obj) d.clips = d.clips.filter((c) => c.target !== obj.name);
      return;
    }
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

export function duplicateObject(id: string) {
  const src = state.doc.objects.find((o) => o.id === id);
  if (!src) return;
  let newId = '';
  updateDoc((d) => {
    const copy: SceneObject = { ...structuredClone(src), id: uid('o'), name: uniqueName(d, src.name.replace(/\d+$/, '')) };
    if (copy.pos) copy.pos = [copy.pos[0] + 0.5, copy.pos[1] - 0.5];
    newId = copy.id;
    d.objects.splice(d.objects.findIndex((o) => o.id === id) + 1, 0, copy);
    const entry = state.catalog?.mobjects.find((m) => m.name === src.ctor);
    const intro = state.autoIntro ? introFor(entry, src.ctor) : null;
    const start = frameSnap(state.time);
    if (intro) d.clips.push({ id: uid('c'), kind: 'anim', track: chooseTrack(d, start, 1, { target: src.name }), start, duration: 1, cls: intro, target: copy.name, args: {} });
  });
  setState({ selection: { kind: 'object', id: newId } });
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
