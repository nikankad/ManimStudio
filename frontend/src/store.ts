import { useSyncExternalStore } from 'react';
import { api, type AppInfo, type Recovery } from './api';
import { pref, setPref } from './prefs';
import { dependentsOf, FOLLOW_KINDS, isCoupled, isRedraw, linkSources, standsAlone, STANDALONE_KINDS, objectDeps, ownsPosition, remapLink, renameRefs, RESERVED_NAMES, sortByDependencies, wouldCycle } from './construct';
import { bakeTransform, freeShape, shapeCenter, writeShape } from './geometry';
import { anchorTo, cloneAnim, cloneStep, compoundOf, compounds, findAnim, withBlocks, findStep, forgetObjects, landing, layout, markerTime, newAnim, settleMarkers, placeAnims, placeSteps, removeIds, renameInTimeline, stepEstimate, animEstimate, walk, ensureDefined, type Layout } from './timeline';
import { setConstants } from './words';
import type { Anim, Args, Catalog, CatalogEntry, Job, Link, Marker, ObjInfo, ParamMeta, RunResult, SceneDoc, SceneObject, Selection, Signature, Step, StepKind, Template, Tool } from './types';

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
  frameAt: { doc: SceneDoc; time: number } | null; // what the frame shown was drawn for
  frameFailed: string | null; // the last frame couldn't be drawn (the backend didn't answer): why
  timeline: RunResult | null;
  catalog: Catalog | null;
  signatures: Record<string, Signature>;
  playing: boolean;
  // the work area (editor state, not part of the document): In and Out points, either may be unset
  range: { in: number | null; out: number | null };
  loop: boolean; // playback starts over at the end (of the range when there is one)
  playingRange: boolean; // playing In to Out: stops at Out
  past: SceneDoc[];
  future: SceneDoc[];
  panel: null | 'settings' | 'export' | 'graph' | 'delete' | 'insert' | 'save-construction' | 'help' | 'new-project' | 'wording';
  tour: number | null; // guided tour step
  tryThis: { played: boolean; exported: boolean } | null; // Help › Try this, the guided first animation: what has happened
  panelData: unknown; // e.g. object ids for 'delete', a template for 'insert'
  tool: Tool; // canvas drawing tool
  starters: Template[]; // built-in constructions
  library: Template[]; // the user's saved constructions (~/.mathengine/constructions.json)
  snap: boolean; // canvas snapping
  timelineSnap: boolean;
  keepTiming: boolean; // duration edits take the time from the pause after them, so later steps keep their time
  autoIntro: boolean;
  record: boolean;
  centerTab: 'program' | 'code'; // the center panel shows the canvas or the code
  view: { pps: number; start: number }; // timeline zoom (pixels/second) and left edge (seconds)
  video: VideoState | null;
  app: AppInfo | null; // this build's version and release channel
  showVideo: boolean; // playing the rendered preview video instead of live frames
  autoRender: boolean; // render a smooth preview in the background after edits
  toast: string | null;
  wording: number; // bumped when the timeline's wording changes (Change wording…, Settings), to redraw its clips
  home: boolean; // the Home screen (projects, samples) instead of the editor
  hasProject: boolean; // a project is open behind the Home screen (it can go back to it)
  restore: Recovery | null; // unsaved changes found for the project just opened: restore them or keep the saved file?
  leave: { resolve: (choice: 'save' | 'discard' | 'cancel') => void } | null; // asking what to do with unsaved changes
}

export const emptyDoc = (): SceneDoc => ({
  version: 4,
  scene: { name: 'MainScene', base: 'Scene' },
  config: { pixel_width: 1920, pixel_height: 1080, frame_rate: 60, background_color: '#000000' },
  header: '',
  objects: [],
  timeline: [],
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
  frameAt: null,
  frameFailed: null,
  timeline: null,
  catalog: null,
  signatures: {},
  playing: false,
  range: { in: null, out: null },
  loop: false,
  playingRange: false,
  past: [],
  future: [],
  panel: null,
  panelData: null,
  tool: 'select',
  tour: null,
  tryThis: null,
  starters: [],
  library: [],
  snap: true,
  timelineSnap: true,
  keepTiming: false,
  autoIntro: true,
  record: false,
  centerTab: 'program',
  view: { pps: 110, start: 0 },
  video: null,
  app: null,
  showVideo: false,
  autoRender: true,
  toast: null,
  wording: 0,
  home: false,
  hasProject: false,
  restore: null,
  leave: null,
};

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getState = () => state;

// The editor's switches are remembered between launches (prefs.json, through the backend).
const SWITCHES = ['snap', 'timelineSnap', 'keepTiming', 'loop', 'autoIntro', 'autoRender'] as const;
let applyingPrefs = false;

/** Start from the switches as they were left; call once the preferences are loaded. */
export function applyPrefs() {
  const patch: Partial<Pick<AppState, (typeof SWITCHES)[number]>> = {};
  for (const k of SWITCHES) {
    const v = pref('ui.' + k);
    if (v === '0' || v === '1') patch[k] = v === '1';
  }
  applyingPrefs = true;
  setState(patch);
  applyingPrefs = false;
}

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
  if (!applyingPrefs) for (const k of SWITCHES) if (state[k] !== prev[k]) setPref('ui.' + k, state[k] ? '1' : '0');
  if (state.doc !== prev.doc || state.dirty !== prev.dirty || state.path !== prev.path || state.hasProject !== prev.hasProject) syncRecovery();
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
  // markers attached to a step or animation move along; one whose step or animation is gone stays where it was
  const gone = next.markers?.some((m) => m.anchor) ? settleMarkers(next, docLayout(state.doc), layout(next, state.timeline)) : [];
  if (gone.length) {
    const names = gone.map((m) => (m.label ? `“${m.label}”` : 'a marker')).join(', ');
    queueMicrotask(() => toast(`${names[0].toUpperCase()}${names.slice(1)} ${gone.length === 1 ? 'was' : 'were'} attached to what was removed: ${gone.length === 1 ? 'it stays' : 'they stay'} at ${gone.map((m) => timecode(m.time)).join(', ')}`));
  }
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

/** Open a document as the current project. `recoverId` is a copy of unsaved work being restored: it stays unsaved. */
export function loadDoc(doc: SceneDoc, path: string | null, recoverId?: string) {
  doc.markers ??= [];
  doc.constructions ??= [];
  doc.timeline ??= [];
  forgetRecovery(); // whatever was open is saved or discarded by now
  if (recoverId) {
    recoveryId = recoverId;
    recoveryTouched = true;
  }
  epoch++; // answers still on their way for the project open before are dropped
  setState({ range: { in: null, out: null }, playingRange: false, video: null, showVideo: false,  doc, path, dirty: !!recoverId, past: [], future: [], selection: null, time: 0, timeline: null, frame: null, frameAt: null, frameFailed: null, home: false, hasProject: true });
}

// ---------------------------------------------------------------- unsaved-work recovery

// While the project has unsaved changes, a copy goes to the backend every few seconds (recovery.py); Home offers
// it back after a crash. Saving, or opening another project over these changes, removes the copy.

const RECOVERY_DELAY = 2500; // ms
const newRecoveryId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
let recoveryId = newRecoveryId();
/** The recovery copy of the project being edited now (Home must not offer it back as lost work). */
export const currentRecoveryId = () => recoveryId;
let recoveryTouched = false; // a copy under this id may exist on the backend
const ownRecovery = new Set<string>(); // every copy this window has written (saved or dropped since, or still current)
/** Whether a copy of unsaved work is this window's own: never offered back as work lost in an earlier session. */
export const isOwnRecovery = (id: string) => ownRecovery.has(id);
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryChain: Promise<unknown> = Promise.resolve(); // requests go in order, so a late write can't undo a clear

function syncRecovery() {
  const { dirty, hasProject } = state;
  if (dirty && hasProject) {
    recoveryTimer ??= setTimeout(() => {
      recoveryTimer = null;
      const { dirty: d, hasProject: h, path, doc } = state;
      if (!d || !h) return;
      recoveryTouched = true;
      const id = recoveryId;
      ownRecovery.add(id);
      recoveryChain = recoveryChain.then(() => api.saveRecovery(id, path, doc)).catch(() => undefined); // best effort
    }, RECOVERY_DELAY);
  } else forgetRecovery();
}

function forgetRecovery() {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  if (recoveryTouched) {
    const id = recoveryId;
    recoveryChain = recoveryChain.then(() => api.clearRecovery(id)).catch(() => undefined);
  }
  recoveryTouched = false;
  recoveryId = newRecoveryId();
}

export function toast(msg: string) {
  msg = msg.replace(/^Error: /, ''); // String(error) puts that in front of every message
  setState({ toast: msg });
  setTimeout(() => getState().toast === msg && setState({ toast: null }), 4000);
}

// ---------------------------------------------------------------- backend sync

// Each opened project is a new epoch: a frame, timeline or render asked for an earlier one never shows in this one.
let epoch = 0;
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
  const ep = epoch;
  // Like Premiere's playback resolution: half-res while playing live so frames keep up.
  const width = state.playing ? Math.max(320, Math.round(previewWidth / 2)) : previewWidth;
  try {
    const frame = await api.run(doc, time, true, width);
    if (ep !== epoch) throw new Stale();
    // While the scene is broken, keep showing the last good picture (dimmed by the viewport).
    if (frame.error && state.frame?.image) frame.image = state.frame.image;
    // Requests are sequential, so this is always the newest frame we have: show it even if
    // another one is already wanted (during playback one always is).
    const patch: Partial<AppState> = { frame, frameAt: { doc, time }, frameFailed: null };
    // After pausing a preview video, switch back to live frames once the exact frame is here.
    if (state.showVideo && !state.playing && time === state.time && doc === state.doc) patch.showVideo = false;
    setState(patch);
  } catch (e) {
    // the backend didn't answer: say so where the picture is, with Retry (requestFrame)
    if (!(e instanceof Stale) && ep === epoch) setState({ frameFailed: String(e).replace(/^Error: /, '') });
  }
  frameBusy = false;
  void pumpFrames();
}

class Stale extends Error {}

let timelineTimer: number | undefined;
let timelineBusy = false;
let timelineWanted = false;
/**
 * Look for LaTeX again (after the user installed it). When it's found, everything is re-run so equations
 * and numbers are drawn with TeX instead of Text.
 */
export async function recheckLatex(): Promise<boolean> {
  try {
    const res = await api.tex();
    if (state.catalog) setState({ catalog: { ...state.catalog, latex: res.latex, latex_hint: res.hint } });
    if (res.latex) {
      setState({ video: null }); // the rendered preview was drawn without LaTeX
      scheduleTimeline();
      requestFrame();
      toast('LaTeX found: equations and numbers are drawn with TeX now');
    } else toast(`LaTeX still isn't found. ${res.hint}`);
    return res.latex;
  } catch (e) {
    toast(String(e));
    return false;
  }
}

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
  const ep = epoch;
  try {
    const timeline = await api.run(doc, null, false);
    if (state.doc === doc && ep === epoch) setState({ timeline: { ...timeline, doc } });
  } catch (e) {
    if (ep === epoch) toast(String(e));
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
    setConstants([...catalog.colors, ...catalog.directions]); // RED reads “red” on the timeline
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

let layoutCache: { doc: SceneDoc; timeline: RunResult | null; lay: Layout } | null = null;

/** When each step and animation runs (measured by manim; estimated until then). */
export function docLayout(doc: SceneDoc = state.doc, timeline: RunResult | null = state.timeline): Layout {
  if (layoutCache?.doc !== doc || layoutCache.timeline !== timeline) layoutCache = { doc, timeline, lay: layout(doc, timeline) };
  return layoutCache.lay;
}

export function sequenceEnd(doc: SceneDoc, timeline: RunResult | null): number {
  return docLayout(doc, timeline).end;
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

/**
 * The work area: In to Out. Only In set: In to the end; only Out: the start to Out. `set`: either is set. Out is
 * where the range ends (the frame at Out is the first one not in it).
 */
export function workArea(s: AppState = state): { start: number; end: number; set: boolean } {
  const end = sequenceEnd(s.doc, s.timeline);
  const a = Math.min(s.range.in ?? 0, end), b = Math.min(s.range.out ?? end, end);
  return { start: a, end: Math.max(a, b), set: s.range.in !== null || s.range.out !== null };
}

/** Where playback stops (or, looping, starts over), and where it starts over. */
function playLimits(s: AppState): { from: number; to: number } {
  const r = workArea(s);
  return s.range.in !== null || s.range.out !== null ? (s.loop || s.playingRange ? { from: r.start, to: r.end } : { from: 0, to: sequenceEnd(s.doc, s.timeline) }) : { from: 0, to: r.end };
}

/**
 * Playback reached time `t`: where it is now. At the end it stops, or with Loop on starts over (at In when there is a
 * range). Shared by live playback and the preview video.
 */
export function playbackAt(t: number): { t: number; stop?: boolean; wrapped?: boolean } {
  const { from, to } = playLimits(state);
  if (t < to - 1e-6) return { t };
  if (state.loop && to - from > 1e-3) return { t: from, wrapped: true };
  return { t: to, stop: true };
}

/** Set In or Out at time `t` (the playhead): an Out before In (or an In after Out) clears the other one, and says so. */
export function setRangePoint(which: 'in' | 'out', t = state.time) {
  t = frameSnap(Math.max(0, Math.min(sequenceEnd(state.doc, state.timeline), t)));
  const range = { ...state.range, [which]: t };
  const other = which === 'in' ? 'out' : 'in';
  if (range.in !== null && range.out !== null && range.out - range.in < 1 / fps() - 1e-6) {
    range[other] = null;
    toast(which === 'in' ? 'In is at or after Out, so Out is cleared: the range now runs from In to the end' : 'Out is at or before In, so In is cleared: the range now runs from the start to Out');
  }
  setState({ range });
}

export function clearRange() {
  setState({ range: { in: null, out: null }, playingRange: false });
}

/** Play from In to Out (and stop there, unless Loop is on). */
export function playRange() {
  const r = workArea();
  if (r.end - r.start < 1e-3) return toast('The range is empty: set In (I) before Out (O)');
  setPlaying(false);
  setState({ time: r.start, playingRange: true });
  setPlaying(true, true);
}

let playRaf = 0;
export function setPlaying(playing: boolean, keepRange = false) {
  cancelAnimationFrame(playRaf);
  if (!keepRange && state.playingRange) setState({ playingRange: false });
  const duration = sequenceEnd(state.doc, state.timeline);
  if (playing && duration <= 0) return setState({ playing: false, time: 0, showVideo: false }); // nothing to play
  if (playing) {
    // from the start (of the range, when looping one) when the playhead is at the end or outside the range played
    const { from, to } = playLimits(state);
    if (state.time >= to - 1e-3 || (state.time < from - 1e-6 && (state.loop || state.playingRange))) setState({ time: from });
  }
  setState({ playing, showVideo: playing ? previewFresh() : state.showVideo });
  if (playing && state.tryThis && !state.tryThis.played) setState({ tryThis: { ...state.tryThis, played: true } });
  if (!playing) return requestFrame();
  let last = performance.now();
  const tick = (now: number) => {
    const s = getState();
    if (!s.playing) return;
    const p = playbackAt(s.time + (now - last) / 1000);
    last = now;
    if (!s.showVideo) setState({ time: p.t });
    if (p.stop && !s.showVideo) return setState({ playing: false, playingRange: false });
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
/** `retry`: render again even though rendering this exact document failed. */
export async function renderPreview(retry = false) {
  const doc = state.doc;
  const key = docKey(doc);
  const v = state.video;
  if (v && v.key === key && v.state !== 'cancelled' && !(retry && v.state === 'error')) return; // already rendered, rendering, or failed for this exact doc
  const ep = epoch;
  if (!doc.timeline.length || sequenceEnd(doc, state.timeline) <= 0) return; // nothing plays: no video to make
  try {
    const job = await api.render(doc, 'preview');
    if (ep !== epoch || docKey(state.doc) !== key) {
      // another project (or another edit) by now: nobody will show this render, so it must not keep manim busy
      if (job.id && (job.state === 'running' || job.state === 'queued')) api.cancelJob(job.id).catch(() => undefined);
      return;
    }
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

/** Where things added "at the playhead" go: time `start` (default: the playhead), `row` of the self.play there. */
export interface At {
  start?: number;
  row?: number;
}

/** Put animations on the timeline at a time (into the self.play there, or a new one); returns when they start. */
export function placeAt(d: SceneDoc, anims: Anim[], at?: At): number {
  const lay = layout(d, state.timeline);
  const land = landing(d, lay, frameSnap(at?.start ?? state.time), true);
  const id = placeAnims(d, lay, land, anims, at?.row);
  ensureDefined(d, id);
  return land.time;
}

/** Put steps on the timeline at a time; returns when they start. */
export function placeStepAt(d: SceneDoc, step: Step | Step[], at?: At): number {
  const steps = Array.isArray(step) ? step : [step];
  const lay = layout(d, state.timeline);
  const land = landing(d, lay, frameSnap(at?.start ?? state.time), false);
  placeSteps(d, lay, land, steps, steps.reduce((t, s) => t + stepEstimate(s), 0));
  for (const s of steps) ensureDefined(d, s.id);
  return land.time;
}

/** Axes, planes and number lines span the frame: they belong at the centre, and other objects sit on them. */
const fillsFrame = (ctor: string) => {
  const bases = state.catalog?.mobjects.find((m) => m.name === ctor)?.bases ?? [];
  return ['Axes', 'NumberLine'].includes(ctor) || bases.some((b) => ['CoordinateSystem', 'Axes', 'NumberLine'].includes(b));
};

const SLOTS: [number, number][] = [[0, 0], [-3, 0], [3, 0], [0, 2], [0, -2], [-3, 2], [3, 2], [-3, -2], [3, -2]];

/**
 * Where an object added from the library goes: the centre, or the first spot nobody sits on, so adding several
 * doesn't pile them up. Objects built on another one (a brace, a label…) stay at the centre; they follow their target.
 */
export function newObjectPos(ctor: string): [number, number] {
  const entry = state.catalog?.mobjects.find((m) => m.name === ctor);
  if (Object.values(entry?.starter ?? {}).includes('@target') || fillsFrame(ctor)) return [0, 0];
  const placed = state.doc.objects.filter((o) => o.pos && !fillsFrame(o.ctor));
  return SLOTS.find((s) => !placed.some((o) => Math.hypot(o.pos![0] - s[0], o.pos![1] - s[1]) < 1)) ?? [0, 0];
}

/**
 * An object whose first statement (its intro or self.add) landed in a block's body is created there too, right
 * before it: in a loop each run then makes its own, and its math can use the loop's counter.
 */
function createWhereIntroduced(d: SceneDoc, obj: SceneObject, step: string | undefined) {
  const i = d.timeline.findIndex((s) => s.id === step);
  if (i <= 0) return;
  for (const c of compounds(d.timeline).values()) if (c.from < i && i < c.to) {
    obj.after = d.timeline[i - 1].id;
    return;
  }
}

export function addObject(ctor: string, pos: [number, number] | null, targetName?: string, at?: At, initial?: Args): string {
  const entry = state.catalog?.mobjects.find((m) => m.name === ctor);
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry?.starter ?? {})) args[k] = v === '@target' ? targetName ?? '' : v;
  Object.assign(args, initial); // explicit arguments (drawn geometry, factory defaults) win over starters
  if (initial?.start !== undefined || initial?.end !== undefined) delete args['*'];
  const intro = state.autoIntro ? introFor(entry, ctor) : null;
  let newId = '';
  let end = state.time;
  updateDoc((d) => {
    const name = uniqueName(d, snake(ctor.split('.').pop() || 'obj'));
    const obj: SceneObject = { id: uid('o'), name, ctor, args, pos, chain: '' };
    newId = obj.id;
    d.objects.push(obj);
    if (intro) {
      const a = newAnim(intro, name);
      end = placeAt(d, [a], at) + animEstimate(a);
      createWhereIntroduced(d, obj, findAnim(d, a.id)?.step.id);
    } else if (!NO_INTRO.has(ctor)) {
      const add: Step = { id: uid('s'), kind: 'add', targets: [name] };
      end = placeStepAt(d, add, at);
      createWhereIntroduced(d, obj, add.id);
    }
  });
  setState({ selection: { kind: 'object', id: newId }, time: frameSnap(end) });
  return newId;
}

/** An animation of `target` at the playhead (or `at`): it joins the self.play there, or starts a new one. */
export function addAnimation(cls: string, target: string, at?: At): string {
  const a = newAnim(cls, target);
  let start = 0;
  updateDoc((d) => void (start = placeAt(d, [a], at)));
  setState({ selection: { kind: 'clips', ids: [a.id] }, time: frameSnap(start + animEstimate(a)) });
  return a.id;
}

/** A statement at the playhead (or `at`): self.wait, self.add, self.remove, code, a value, a change, or couple / uncouple. */
export function addStep(kind: Exclude<StepKind, 'play'>, at?: At & { targets?: string[]; method?: string; target?: string }): string {
  const step: Step = { id: uid('s'), kind };
  if (kind === 'code') step.code = '# any manim code; every object variable is in scope\n';
  else if (kind === 'apply') {
    step.target = at?.target ?? at?.targets?.[0] ?? state.doc.objects[0]?.name ?? '';
    step.chain = '.shift(RIGHT)';
  } else if (kind === 'assign') {
    const used = new Set([...state.doc.objects.map((o) => o.name), ...state.doc.timeline.map((s) => s.target ?? '')]);
    let n = 1;
    while (used.has(`value${n}`)) n++;
    step.target = at?.target ?? `value${n}`;
    step.op = '=';
    step.value = '1';
  } else if (kind === 'wait') step.args = { duration: '1' };
  else if (kind === 'call') {
    step.method = at?.method ?? 'next_section';
    step.args = {};
  } else step.targets = at?.targets ?? [];
  updateDoc((d) => void placeStepAt(d, step, at));
  selectClips([step.id]);
  return step.id;
}

/**
 * Put steps in a block (`for i in range(2)` by default): the selected steps (from the first to the last, whole blocks
 * included), or an empty one at the playhead. Returns the block's id.
 */
export function wrapInBlock(ids: string[], head = 'for i in range(2)'): string | null {
  const opener: Step = { id: uid('s'), kind: 'block', head };
  const end: Step = { id: uid('s'), kind: 'end' };
  const doc = state.doc;
  const steps = withBlocks(doc, ids.map((id) => (findStep(doc, id) ? id : findAnim(doc, id)?.step.id ?? '')).filter(Boolean));
  const at = doc.timeline.map((s, i) => (steps.has(s.id) ? i : -1)).filter((i) => i >= 0);
  if (!at.length) {
    updateDoc((d) => void placeStepAt(d, [opener, end]));
    selectClips([opener.id]);
    return opener.id;
  }
  let from = at[0], to = at[at.length - 1];
  // the range must hold whole blocks, and sit in one body
  const shapes = compounds(doc.timeline);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of shapes.values()) {
      const within = (i: number) => i >= from && i <= to;
      const crosses = within(c.from) !== within(c.to) || (!within(c.from) && c.clauses.some((id) => within(doc.timeline.findIndex((x) => x.id === id))));
      if (crosses) {
        [from, to] = [Math.min(from, c.from), Math.max(to, c.to)];
        grew = true;
      }
    }
  }
  updateDoc((d) => {
    d.timeline.splice(to + 1, 0, end);
    d.timeline.splice(from, 0, opener);
  });
  selectClips([opener.id]);
  return opener.id;
}

/** Take the steps out of a block (its header and end go; a clause goes with its body). */
export function unwrapBlock(id: string) {
  const opener = compoundOf(state.doc.timeline, id);
  if (!opener) return;
  updateDoc((d) => {
    const c = compounds(d.timeline).get(opener);
    if (!c) return;
    const gone = new Set([opener, ...(c.end ? [c.end] : [])]);
    // other clauses' bodies (else, except…) would run as well once unwrapped: they go with their clause
    const drop = withBlocks(d, c.clauses);
    for (const s of d.timeline) if (gone.has(s.id) || drop.has(s.id)) for (const o of d.objects) if (o.after === s.id) {
      const i = d.timeline.indexOf(s);
      const prev = d.timeline.slice(0, i).reverse().find((x) => !gone.has(x.id) && !drop.has(x.id));
      if (prev) o.after = prev.id;
      else delete o.after;
    }
    d.timeline = d.timeline.filter((s) => !gone.has(s.id) && !drop.has(s.id));
  });
  selectClips([]);
}

/** The manim Scene class the scene is built on (its methods are what a statement can call). */
export function sceneBase(doc: SceneDoc = state.doc): string {
  const names = doc.scene.base.split(',').map((b) => b.trim());
  return names.find((n) => state.catalog?.scene_methods?.[n]) ?? 'Scene';
}

/** Methods of the scene a statement can call, other than play / wait / add / remove (which have their own steps). */
export function sceneCalls(doc: SceneDoc = state.doc): string[] {
  return (state.catalog?.scene_methods?.[sceneBase(doc)] ?? []).filter((m) => !['play', 'wait', 'add', 'remove'].includes(m));
}

/** Turn steps and animations on or off (a disabled one is left out of the code). */
export function toggleDisabled(ids: string[]) {
  const doc = state.doc;
  // a block is switched on or off whole: its clauses and end stand for it
  ids = [...new Set(ids.map((id) => { const s = findStep(doc, id); return s?.kind === 'block' || s?.kind === 'end' ? compoundOf(doc.timeline, id) ?? id : id; }))];
  const first = findStep(doc, ids[0]) ?? findAnim(doc, ids[0])?.anim;
  const off = !first?.disabled;
  updateDoc((d) => {
    for (const id of ids) {
      const x = findStep(d, id) ?? findAnim(d, id)?.anim;
      if (x) x.disabled = off || undefined;
      if (x && !x.disabled) delete x.disabled;
    }
  });
}

/**
 * Add a marker at `time`. With one clip selected under it, the marker is attached to that clip (its start or end,
 * whichever is nearer) and moves with it, like a clip marker in Premiere.
 */
export function addMarker(time = state.time) {
  const t = frameSnap(time);
  const lay = docLayout();
  const sel = state.selection?.kind === 'clips' && state.selection.ids.length === 1 ? state.selection.ids[0] : undefined;
  const sp = sel && (lay.anims.get(sel) ?? lay.steps.get(sel));
  const anchor = sp && t >= sp.start - 1e-6 && t <= sp.end + 1e-6 ? anchorTo(lay, sel!, t) : undefined;
  const m: Marker = { id: uid('m'), time: t, ...(anchor ? { anchor } : {}) };
  updateDoc((d) => {
    d.markers ??= [];
    d.markers.push(m);
  });
  return m.id;
}

export function setMarker(id: string, fn: (m: Marker) => void, coalesce?: string) {
  updateDoc((d) => {
    const m = d.markers?.find((x) => x.id === id);
    if (m) fn(m);
  }, coalesce && `marker:${id}:${coalesce}`);
}

export function deleteMarker(id: string) {
  updateDoc((d) => void (d.markers = (d.markers ?? []).filter((k) => k.id !== id)));
  if (state.selection?.kind === 'marker' && state.selection.id === id) setState({ selection: null });
}

/** Select a marker (its settings show in the inspector) and move the playhead to it. */
export function selectMarker(id: string, seek = true) {
  const m = state.doc.markers?.find((x) => x.id === id);
  if (!m) return;
  setState({ selection: { kind: 'marker', id }, ...(seek ? { time: frameSnap(markerTime(m, docLayout())), showVideo: false } : {}) });
}

/** All edit points (step and animation starts and ends, markers), for ↑/↓ navigation and snapping. */
export function editPoints(doc: SceneDoc, timeline: RunResult | null): number[] {
  const lay = docLayout(doc, timeline);
  const pts = new Set<number>([0]);
  for (const sp of [...lay.steps.values(), ...lay.anims.values()]) {
    pts.add(Math.round(sp.start * 1e4) / 1e4);
    pts.add(Math.round(sp.end * 1e4) / 1e4);
  }
  for (const m of doc.markers ?? []) pts.add(Math.round(markerTime(m, lay) * 1e4) / 1e4);
  return [...pts].sort((a, b) => a - b);
}


export function renameObject(id: string, newName: string) {
  const obj = state.doc.objects.find((o) => o.id === id);
  if (!obj || obj.name === newName) return;
  if (RESERVED_NAMES.has(newName)) return toast(`"${newName}" is used by the generated code`);
  const names = new Map([[obj.name, newName]]);
  updateDoc((d) => {
    for (const o of d.objects) {
      if (o.id === id) o.name = newName;
      renameRefs(o, names); // Python fields and link expressions (parameter names); link sources are ids
    }
    renameInTimeline(d, names); // code outside string literals only
  });
}

export function deleteSelection(ripple = false) {
  const sel = state.selection;
  if (!sel) return;
  if (sel.kind === 'marker') return deleteMarker(sel.id);
  if (sel.kind === 'object' || sel.kind === 'objects') {
    const ids = selectedObjectIds(sel);
    const deps = dependentsOf(state.doc, ids, false);
    if (deps.length) return setState({ panel: 'delete', panelData: ids }); // ask: delete them too, or detach
    return deleteObjects(ids, 'cascade');
  }
  // Delete leaves the time as a gap (a self.wait), like Premiere; ripple delete closes it.
  const lay = docLayout();
  updateDoc((d) => removeIds(d, lay, new Set(sel.ids), ripple ? 'ripple' : 'lift'));
  setState({ selection: null });
}

/**
 * Remove objects. Objects built from them are either deleted too ('cascade'), or 'detach'ed:
 * converted to plain objects at their current geometry where possible (points, labels, segments,
 * circles, polygons); constructions that can't exist without their source (angles, areas, braces…)
 * are always deleted. Uncoupled objects that stand alone just forget a relationship to a removed object.
 */
export function deleteObjects(ids: string[], mode: 'cascade' | 'detach') {
  const frame = state.frame;
  const lay = docLayout();
  const remove = new Set(ids);
  updateDoc((d) => {
    // Handle objects built directly from removed ones; only removals propagate further.
    for (let grew = true; grew; ) {
      grew = false;
      for (const o of d.objects) {
        if (remove.has(o.id) || !objectDeps(o, d, false).some((x) => remove.has(x))) continue;
        // Objects referring to a removed one through Python (axes.plot on deleted axes) can't be detached.
        if (mode === 'cascade' || !o.link || !detachInPlace(o, frame?.objects.find((i) => i.id === o.id), true)) {
          remove.add(o.id);
          grew = true;
        }
      }
    }
    const names = new Set(d.objects.filter((o) => remove.has(o.id)).map((o) => o.name));
    d.objects = d.objects.filter((o) => !remove.has(o.id));
    for (const o of d.objects) if (standsAlone(o) && objectDeps(o, d).some((x) => remove.has(x))) delete o.link;
    forgetObjects(d, lay, names, remove);
  });
  setState({ selection: null, panel: null, panelData: null });
}

/**
 * Turn a constructed object into an independent one. Follow links keep the object at its current
 * position; segments, perpendicular and parallel lines, circles and polygons become plain shapes
 * with their current geometry. Others
 * are frozen (built once from their sources, no longer updated) unless `convertOnly`, which reports
 * false so the caller can delete them.
 */
export function detachInPlace(o: SceneObject, info: ObjInfo | undefined, convertOnly = false): boolean {
  const l = o.link;
  if (!l) return true;
  if (standsAlone(o) || bakeGeometry(o, info)) {
    delete o.link;
    return true;
  }
  if (convertOnly) return false;
  delete l.off;
  l.frozen = true;
  return true;
}

/**
 * Write a constructed object's current geometry (`info`, from the preview) into its own fields, so it
 * can stand alone: a position for follow kinds, ends / center and radius / vertices for shapes. False
 * when its kind can't stand alone (angles, areas, braces…) or the geometry isn't known.
 */
function bakeGeometry(o: SceneObject, info: ObjInfo | undefined): boolean {
  const l = o.link!;
  const g = info?.geom;
  if (FOLLOW_KINDS.has(l.kind)) {
    if (info?.center) o.pos = [Math.round(info.center[0] * 1000) / 1000, Math.round(info.center[1] * 1000) / 1000];
    return true;
  }
  if (['segment', 'perpendicular', 'parallel', 'tangent', 'secant'].includes(l.kind) && g?.kind === 'line') {
    writeShape(o, { kind: 'line', start: g.start, end: g.end });
    return true;
  }
  if (l.kind === 'circle2' && g?.kind === 'circle') {
    writeShape(o, { kind: 'circle', center: g.center, r: g.radius });
    return true;
  }
  if (l.kind === 'polygon' && g?.kind === 'polygon') {
    o.ctor = 'Polygon';
    writeShape(o, { kind: 'polygon', vertices: g.vertices });
    return true;
  }
  return false;
}

/**
 * Uncouple: keep each relationship but pause it. The object stays where it is and is edited like any
 * other (shapes keep their current geometry); angles, areas and the like stay as they are now (built once).
 */
export function uncoupleObjects(ids: string[]) {
  const frame = state.frame;
  const skipped: string[] = [];
  updateDoc((d) => {
    for (const o of d.objects) {
      if (!ids.includes(o.id) || !isCoupled(o)) continue;
      if (STANDALONE_KINDS.has(o.link!.kind) && !bakeGeometry(o, frame?.objects.find((i) => i.id === o.id))) skipped.push(o.name);
      else o.link!.off = true;
    }
  });
  if (skipped.length) toast(`${skipped.join(', ')}: its current shape isn't known yet (fix the preview first), so it stays coupled`);
}

/** Couple again: the paused (or frozen) relationships take over the objects' place or shape again. */
export function coupleObjects(ids: string[]) {
  const objs = state.doc.objects.filter((o) => ids.includes(o.id) && o.link && !isCoupled(o));
  const bad = objs.find((o) => objectDeps(o, state.doc).some((s) => !state.doc.objects.some((x) => x.id === s)));
  if (bad) return toast(`${bad.name} can't be coupled again: something it was built from was deleted`);
  updateDoc((d) => {
    for (const o of d.objects) {
      if (!objs.some((x) => x.id === o.id)) continue;
      delete o.link!.off;
      delete o.link!.frozen;
      clearOwnGeometry(o);
    }
    sortByDependencies(d);
  });
}

/** A coupled redraw construction defines the whole shape, so its own transforms would only be ignored. */
function clearOwnGeometry(o: SceneObject) {
  if (!o.link || FOLLOW_KINDS.has(o.link.kind)) return;
  o.pos = null;
  delete o.scale;
  delete o.stretch;
  delete o.rotation;
}

/** Couple an existing object to others: give it `link` (built from its current geometry by the caller). */
export function coupleTo(id: string, link: Link, patch?: (o: SceneObject) => void) {
  if (wouldCycle(state.doc, id, linkSources(link))) return toast('That would make the construction depend on itself');
  updateDoc((d) => {
    const o = d.objects.find((x) => x.id === id)!;
    o.link = link;
    patch?.(o);
    clearOwnGeometry(o);
    sortByDependencies(d);
  });
  selectObjects([id]);
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
      if (!copy.link || standsAlone(copy)) {
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
    const intros = copies.flatMap((copy) => {
      const entry = state.catalog?.mobjects.find((m) => m.name === copy.ctor);
      const intro = state.autoIntro ? introFor(entry, copy.ctor) : null;
      return intro ? [newAnim(intro, copy.name)] : [];
    });
    if (intros.length) placeAt(d, intros);
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
  const at = { start: opts.time };
  let end: number | null = null;
  updateDoc((d) => {
    const name = uniqueName(d, spec.name ?? snake(spec.ctor.split('.').pop() || 'obj'));
    const obj: SceneObject = { id, name, ctor: spec.ctor, args: { ...spec.args }, pos: spec.pos ?? null, chain: '', link: spec.link };
    d.objects.push(obj);
    sortByDependencies(d);
    if (intro) {
      const a = newAnim(intro, name);
      end = placeAt(d, [a], at) + animEstimate(a);
      createWhereIntroduced(d, obj, findAnim(d, a.id)?.step.id);
    } else if (spec.intro === undefined && !NO_INTRO.has(spec.ctor)) {
      const add: Step = { id: uid('s'), kind: 'add', targets: [name] };
      placeStepAt(d, add, at);
      createWhereIntroduced(d, obj, add.id);
    }
  });
  if (opts.select !== false) selectObjects([id]);
  if (end !== null) setState({ time: frameSnap(end) }); // like addObject: show the object once its intro has played
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

/** Animate a parameter to a value at the playhead (target.animate.set_value(…) on the timeline). */
/** One clip at the playhead fading out everything on screen except `keep` (objects made in loops included). */
export function fadeOutRest(keep: string[]): string {
  // the bare Mobject left out is the invisible helper that keeps constructions updated (Constraints)
  const conds = [...keep.map((k) => `m is not ${k}`), 'type(m) is not Mobject'];
  const a: Anim = { ...newAnim('expr', ''), src: `*[FadeOut(m) for m in self.mobjects if ${conds.join(' and ')}]` };
  let start = 0;
  updateDoc((d) => void (start = placeAt(d, [a])));
  setState({ selection: { kind: 'clips', ids: [a.id] }, time: frameSnap(start + animEstimate(a)) });
  return a.id;
}

/** A clip animating a parameter to `to`: a number, or Python (a math value the backend compiled). */
export function animateParam(name: string, to: number | string, duration = 1) {
  const a: Anim = { ...newAnim('animate', name), chain: `.set_value(${typeof to === 'number' ? Math.round(to * 1000) / 1000 : to})` };
  if (duration !== 1) a.args = { run_time: String(duration) };
  let start = 0;
  updateDoc((d) => void (start = placeAt(d, [a])));
  setState({ selection: { kind: 'clips', ids: [a.id] }, time: frameSnap(start + duration) });
}

// ---------------------------------------------------------------- clipboard

let clipboard: { steps: Step[]; anims: Anim[] } = { steps: [], anims: [] };
export function copyClips() {
  if (state.selection?.kind !== 'clips') return;
  const ids = withBlocks(state.doc, state.selection.ids);
  const steps = state.doc.timeline.filter((s) => ids.has(s.id));
  const anims = [...ids].map((id) => findAnim(state.doc, id)).filter((r) => r && !ids.has(r.step.id)).map((r) => r!.anim);
  clipboard = structuredClone({ steps, anims });
  const n = steps.length + anims.length;
  toast(`Copied ${n} clip${n === 1 ? '' : 's'}`);
}

/** Copy the selected clips and remove them (leaving the time as a gap, as Delete does). */
export function cutClips() {
  if (state.selection?.kind !== 'clips') return;
  const n = state.selection.ids.length;
  copyClips();
  deleteSelection();
  toast(`Cut ${n} clip${n === 1 ? '' : 's'}: Paste puts ${n === 1 ? 'it' : 'them'} back at the playhead`);
}

/** Paste at the playhead: animations into the self.play there (or a new one), statements as they were. */
export function pasteClips() {
  const { steps, anims } = clipboard;
  if (!steps.length && !anims.length) return;
  const ids: string[] = [];
  updateDoc((d) => {
    if (anims.length) {
      const copies = anims.map(cloneAnim);
      placeAt(d, copies);
      ids.push(...copies.map((a) => a.id));
    }
    if (steps.length) {
      const copies = steps.map(cloneStep);
      placeStepAt(d, copies);
      ids.push(...copies.map((s) => s.id));
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
  const lay = docLayout();
  const existing = chain.startsWith('.move_to(')
    ? state.doc.timeline.flatMap((s) => [...walk(s.anims)]).find((a) => a.cls === 'animate' && a.target === obj.name && a.chain?.startsWith('.move_to(') && Math.abs((lay.anims.get(a.id)?.end ?? -1) - time) < 1e-3)
    : undefined;
  if (existing) {
    updateDoc((d) => void (findAnim(d, existing.id)!.anim.chain = chain));
    return;
  }
  const a: Anim = { ...newAnim('animate', obj.name), chain };
  let start = time;
  updateDoc((d) => void (start = placeAt(d, [a], { start: time })));
  setState({ time: frameSnap(start + 1) });
}

export function docKey(doc: SceneDoc): string {
  return JSON.stringify(doc);
}
