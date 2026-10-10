import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { AnimEntry, Catalog, CatalogEntry, Job, RunResult, SceneDoc, SceneObject, Selection, Signature, Step } from './types';

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
  previewDoc: SceneDoc | null; // uncommitted edit shown while dragging
  path: string | null;
  dirty: boolean;
  selection: Selection;
  time: number;
  frame: RunResult | null;
  timeline: RunResult | null;
  lastGoodTimeline: RunResult | null; // step timings to fall back on while the scene has an error
  catalog: Catalog | null;
  signatures: Record<string, Signature>;
  playing: boolean;
  past: SceneDoc[];
  future: SceneDoc[];
  panel: null | 'code' | 'settings' | 'export';
  snap: boolean;
  autoIntro: boolean;
  record: boolean;
  video: VideoState | null;
  showVideo: boolean;
  toast: string | null;
}

export const emptyDoc = (): SceneDoc => ({
  version: 1,
  scene: { name: 'MainScene', base: 'Scene' },
  config: { pixel_width: 1920, pixel_height: 1080, frame_rate: 60, background_color: '#000000' },
  header: '',
  objects: [],
  steps: [],
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
  lastGoodTimeline: null,
  catalog: null,
  signatures: {},
  playing: false,
  past: [],
  future: [],
  panel: null,
  snap: true,
  autoIntro: true,
  record: false,
  video: null,
  showVideo: false,
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
  } else if (state.time !== prev.time || state.previewDoc !== prev.previewDoc) {
    requestFrame();
  }
  if (state.doc.header !== prev.doc.header) loadCatalog();
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
  setState((s) => ({
    doc: next,
    dirty: true,
    past: merge ? s.past : [...s.past.slice(-199), s.doc],
    future: [],
  }));
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
  setState({ doc, path, dirty: false, past: [], future: [], selection: null, time: 0, timeline: null, lastGoodTimeline: null, frame: null });
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
  try {
    const frame = await api.run(doc, time, true, previewWidth);
    // While the scene is broken, keep showing the last good picture (dimmed by the viewport).
    if (frame.error && state.frame?.image) frame.image = state.frame.image;
    if (!frameWanted) setState({ frame }); // a newer request supersedes this one
  } catch (e) {
    toast(String(e));
  }
  frameBusy = false;
  void pumpFrames();
}

let timelineTimer: number | undefined;
let pendingJump: string | null = null;

/** After the next timeline analysis, move the playhead to the end of this step. */
export const jumpToStepEnd = (id: string) => {
  pendingJump = id;
};

function scheduleTimeline() {
  clearTimeout(timelineTimer);
  timelineTimer = window.setTimeout(async () => {
    const doc = state.doc;
    try {
      const timeline = await api.run(doc, null, false);
      if (state.doc !== doc) return;
      const patch: Partial<AppState> = { timeline };
      if (!timeline.error) patch.lastGoodTimeline = timeline;
      if (pendingJump) {
        const st = timeline.steps.find((s) => s.id === pendingJump);
        if (st) patch.time = st.end;
        pendingJump = null;
      }
      if (patch.time === undefined && !timeline.error && state.time > timeline.duration) patch.time = timeline.duration;
      setState(patch);
    } catch (e) {
      toast(String(e));
    }
  }, 120);
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
  if (!sig && expr && !sigPending.has(expr)) {
    sigPending.add(expr);
    api
      .signature(expr, state.doc.header, objectClasses(state.doc))
      .then((res) => setState((s) => ({ signatures: { ...s.signatures, [expr]: res } })))
      .catch(() => undefined)
      .finally(() => sigPending.delete(expr));
  }
  return sig;
}

// ---------------------------------------------------------------- playback

let playRaf = 0;
export function setPlaying(playing: boolean) {
  cancelAnimationFrame(playRaf);
  const duration = state.timeline?.duration ?? 0;
  if (playing && state.time >= duration - 1e-3) setState({ time: 0 });
  setState({ playing });
  if (!playing) return;
  let last = performance.now();
  const tick = (now: number) => {
    const s = getState();
    if (!s.playing) return;
    const end = s.timeline?.duration ?? 0;
    const t = Math.min(end, s.time + (now - last) / 1000);
    last = now;
    if (!s.showVideo) setState({ time: t });
    if (t >= end && !s.showVideo) return setState({ playing: false });
    playRaf = requestAnimationFrame(tick);
  };
  playRaf = requestAnimationFrame(tick);
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

export function stepIndexAt(doc: SceneDoc, timeline: RunResult | null, t: number): number {
  // Insert after the last step that finishes at or before t.
  if (!timeline) return doc.steps.length;
  const ends = new Map(timeline.steps.map((s) => [s.id, s.end]));
  let idx = 0;
  doc.steps.forEach((s, i) => {
    const e = ends.get(s.id);
    if (e !== undefined && e <= t + 1e-6) idx = i + 1;
  });
  return idx;
}

export function insertionIndex(): number {
  const { doc, selection, timeline, time } = state;
  if (selection?.kind === 'step' || selection?.kind === 'anim') {
    const id = selection.kind === 'step' ? selection.id : selection.stepId;
    const i = doc.steps.findIndex((s) => s.id === id);
    if (i >= 0) return i + 1;
  }
  return stepIndexAt(doc, timeline, time);
}

const WRITE_LIKE = new Set(['Text', 'Tex', 'MathTex', 'MarkupText', 'Paragraph', 'Code', 'DecimalNumber', 'Integer', 'Variable', 'Title', 'BulletedList']);
const NO_INTRO = new Set(['ValueTracker', 'ComplexValueTracker']);

function introFor(entry: CatalogEntry | undefined, ctor: string): string | null {
  if (NO_INTRO.has(ctor)) return null;
  if (WRITE_LIKE.has(ctor)) return 'Write';
  if (entry && !entry.vector) return 'FadeIn';
  return 'Create';
}

export function addObject(ctor: string, pos: [number, number] | null, targetName?: string) {
  const entry = state.catalog?.mobjects.find((m) => m.name === ctor);
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry?.starter ?? {})) args[k] = v === '@target' ? targetName ?? '' : v;
  const intro = state.autoIntro ? introFor(entry, ctor) : null;
  let newId = '';
  let stepId = '';
  updateDoc((d) => {
    const name = uniqueName(d, snake(ctor.split('.').pop() || 'obj'));
    const obj: SceneObject = { id: uid('o'), name, ctor, args, pos, chain: '' };
    newId = obj.id;
    d.objects.push(obj);
    if (intro) {
      const step: Step = { id: uid('s'), kind: 'play', anims: [{ id: uid('a'), cls: intro, target: name, args: {} }] };
      stepId = step.id;
      d.steps.splice(insertionIndex(), 0, step);
    }
  });
  if (stepId) jumpToStepEnd(stepId);
  setState({ selection: { kind: 'object', id: newId } });
}

export function addAnimation(cls: string, target: string, intoStep?: string) {
  const anim: AnimEntry = { id: uid('a'), cls, target, args: {} };
  if (cls === 'animate') anim.chain = '.shift(RIGHT)';
  if (intoStep) {
    updateDoc((d) => {
      const st = d.steps.find((s) => s.id === intoStep);
      if (st?.kind === 'play') st.anims.push(anim);
    });
    setState({ selection: { kind: 'anim', stepId: intoStep, id: anim.id } });
    return;
  }
  const step: Step = { id: uid('s'), kind: 'play', anims: [anim] };
  const idx = insertionIndex();
  updateDoc((d) => void d.steps.splice(idx, 0, step));
  jumpToStepEnd(step.id);
  setState({ selection: { kind: 'anim', stepId: step.id, id: anim.id } });
}

export function addStep(kind: 'wait' | 'code' | 'add' | 'remove') {
  const id = uid('s');
  const step: Step =
    kind === 'wait' ? { id, kind, duration: '1' } : kind === 'code' ? { id, kind, code: '# any manim code, e.g.\n# self.play(Rotate(circle, PI))\n' } : { id, kind, targets: [] };
  const idx = insertionIndex();
  updateDoc((d) => void d.steps.splice(idx, 0, step));
  jumpToStepEnd(id);
  setState({ selection: { kind: 'step', id } });
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
    for (const s of d.steps) {
      if (s.kind === 'play')
        for (const a of s.anims) {
          a.target = rep(a.target);
          if (a.chain) a.chain = rep(a.chain);
          for (const k in a.args) a.args[k] = rep(a.args[k]);
        }
      else if (s.kind === 'code') s.code = rep(s.code);
      else if (s.kind === 'add' || s.kind === 'remove') s.targets = s.targets.map(rep);
    }
  });
}

export function deleteSelection() {
  const sel = state.selection;
  if (!sel) return;
  updateDoc((d) => {
    if (sel.kind === 'object') {
      const obj = d.objects.find((o) => o.id === sel.id);
      d.objects = d.objects.filter((o) => o.id !== sel.id);
      if (obj) {
        // Drop animations that targeted it; keep everything else for the user to fix.
        for (const s of d.steps) if (s.kind === 'play') s.anims = s.anims.filter((a) => a.target !== obj.name);
        d.steps = d.steps.filter((s) => s.kind !== 'play' || s.anims.length);
      }
    } else if (sel.kind === 'step') {
      d.steps = d.steps.filter((s) => s.id !== sel.id);
    } else {
      const st = d.steps.find((s) => s.id === sel.stepId);
      if (st?.kind === 'play') st.anims = st.anims.filter((a) => a.id !== sel.id);
      d.steps = d.steps.filter((s) => s.kind !== 'play' || s.anims.length);
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
    d.objects.splice(d.objects.indexOf(d.objects.find((o) => o.id === id)!) + 1, 0, copy);
    if (state.autoIntro) {
      const entry = state.catalog?.mobjects.find((m) => m.name === src.ctor);
      const intro = introFor(entry, src.ctor);
      if (intro) d.steps.splice(insertionIndex(), 0, { id: uid('s'), kind: 'play', anims: [{ id: uid('a'), cls: intro, target: copy.name, args: {} }] });
    }
  });
  setState({ selection: { kind: 'object', id: newId } });
}

export const fmt = (v: number) => String(Math.round(v * 100) / 100);

const snapV = (v: number) => (state.snap ? Math.round(v * 4) / 4 : Math.round(v * 100) / 100);

/** Show the object at its dragged position without committing (start-position drags only). */
export function previewMove(id: string, dx: number, dy: number, center: [number, number] | null) {
  if (state.record) return;
  const obj = state.doc.objects.find((o) => o.id === id);
  if (!obj) return;
  const base = obj.pos ?? center ?? [0, 0];
  const doc = structuredClone(state.doc);
  doc.objects.find((o) => o.id === id)!.pos = [snapV(base[0] + dx), snapV(base[1] + dy)];
  setState({ previewDoc: doc });
}

/** Drag result: set the object's position (or, in record mode, animate it there). */
export function moveObject(id: string, dx: number, dy: number, center: [number, number] | null) {
  setState({ previewDoc: null });
  const obj = state.doc.objects.find((o) => o.id === id);
  if (!obj) return;
  if (state.record && center) {
    const x = snapV(center[0] + dx), y = snapV(center[1] + dy);
    const chain = `.move_to(np.array([${fmt(x)}, ${fmt(y)}, 0]))`;
    // Reuse a move in the step ending at the playhead, otherwise insert a new one.
    const { timeline, time, doc } = state;
    const endingHere = timeline?.steps.find((s) => Math.abs(s.end - time) < 1e-6);
    const st = doc.steps.find((s) => s.id === endingHere?.id);
    const existing = st?.kind === 'play' ? st.anims.find((a) => a.cls === 'animate' && a.target === obj.name && a.chain?.startsWith('.move_to(')) : undefined;
    if (st && existing) {
      updateDoc((d) => {
        const s2 = d.steps.find((s) => s.id === st.id);
        if (s2?.kind === 'play') s2.anims.find((a) => a.id === existing.id)!.chain = chain;
      });
    } else {
      const step: Step = { id: uid('s'), kind: 'play', anims: [{ id: uid('a'), cls: 'animate', target: obj.name, args: {}, chain }] };
      const idx = stepIndexAt(doc, timeline, time);
      updateDoc((d) => void d.steps.splice(idx, 0, step));
      jumpToStepEnd(step.id);
    }
    return;
  }
  const base = obj.pos ?? center ?? [0, 0];
  updateDoc((d) => {
    const o = d.objects.find((x) => x.id === id)!;
    o.pos = [snapV(base[0] + dx), snapV(base[1] + dy)];
  });
}

export function docKey(doc: SceneDoc): string {
  return JSON.stringify(doc);
}
