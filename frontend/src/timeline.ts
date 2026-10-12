// The timeline is construct()'s statements in order (mathengine/timeline.py): each step is one manim statement and
// starts when the one before it ends. This module lays them out in time, Premiere-style, and turns timeline
// edits (dropping, moving and trimming clips) into edits of those statements, so the code stays plain manim.
//
// Times come from manim (RunResult: when each statement and animation ran); a step that hasn't been measured
// yet (just added) is estimated from its arguments until the next measurement arrives.

import { renameIdentifiers } from './pyparse';
import type { Anim, Args, RunResult, SceneDoc, Step } from './types';

export const EPS = 1e-6;

export interface Span {
  start: number;
  end: number;
  estimated?: boolean;
  curve?: number[]; // progress at evenly spaced times (measured by manim)
}

export interface Layout {
  steps: Map<string, Span>; // disabled steps take no time
  anims: Map<string, Span>;
  end: number;
  rows: number; // most animations in one self.play
}

const uidT = (p: string) => p + Math.random().toString(36).slice(2, 9);
const round = (v: number) => Math.round(v * 1000) / 1000;
export const numSrc = (v: number) => String(round(v));

/** A plain number written as Python source ("1.5", "2"), else undefined. */
export function literal(src: string | undefined): number | undefined {
  if (src === undefined) return undefined;
  const s = src.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return undefined;
  return Number(s);
}

/** Animations and, depth first, the animations inside compositions. */
export function* walk(anims: Anim[] | undefined): Generator<Anim> {
  for (const a of anims ?? []) {
    yield a;
    yield* walk(a.anims);
  }
}

export const isComposition = (a: Anim) => Array.isArray(a.anims);

// ---------------------------------------------------------------------------- estimates (until manim measures)

export function animEstimate(a: Anim): number {
  const rt = literal(a.args?.run_time);
  if (rt !== undefined) return rt;
  if (a.anims) {
    const kids = a.anims.filter((x) => !x.disabled).map(animEstimate);
    if (!kids.length) return 0;
    if (a.cls === 'Succession') return kids.reduce((x, y) => x + y, 0);
    const lag = literal(a.args?.lag_ratio) ?? (a.cls === 'LaggedStart' ? 0.05 : 0);
    return Math.max(...kids) * (1 + (kids.length - 1) * lag);
  }
  if (a.cls === 'Wait') return literal(a.args?.['*']) ?? 1;
  return 1;
}

export function stepEstimate(s: Step): number {
  switch (s.kind) {
    case 'play': {
      const rt = literal(s.args?.run_time);
      if (rt !== undefined) return rt;
      const anims = (s.anims ?? []).filter((a) => !a.disabled);
      return anims.length ? Math.max(...anims.map(animEstimate)) : 0;
    }
    case 'wait':
      return literal(s.args?.duration) ?? (s.args?.duration ? 1 : 1);
    case 'couple':
      return s.duration ?? 0;
    case 'call':
      return literal(s.args?.duration ?? s.args?.run_time) ?? 0;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------- layout

// A measurement holds only for the steps that haven't changed since it was made. Until manim measures again, the
// others are estimated from their arguments: a trimmed clip follows the pointer, a moved one shows where it went.
const signature = (s: Step) => JSON.stringify(s, (k, v) => (k === 'comment' || k === 'label' ? undefined : v));
const measuredSigs = new WeakMap<RunResult, Map<string, string>>();

/** Whether manim's measurement still describes this step (it is unchanged since it was measured). */
export function isMeasured(s: Step, measured: RunResult | null): boolean {
  if (!measured) return false;
  if (!measured.doc) return true;
  let sigs = measuredSigs.get(measured);
  if (!sigs) measuredSigs.set(measured, (sigs = new Map(measured.doc.timeline.map((x) => [x.id, signature(x)]))));
  return sigs.get(s.id) === signature(s);
}

export function layout(doc: SceneDoc, measured: RunResult | null): Layout {
  const ms = new Map((measured?.steps ?? []).map((x) => [x.id, x]));
  const ma = new Map((measured?.anims ?? []).map((x) => [x.id, x]));
  const steps = new Map<string, Span>();
  const anims = new Map<string, Span>();
  let t = 0;
  let rows = 0;
  for (const s of doc.timeline ?? []) {
    const m = s.disabled || !isMeasured(s, measured) ? undefined : ms.get(s.id);
    const dur = s.disabled ? 0 : m ? Math.max(0, m.end - m.start) : stepEstimate(s);
    steps.set(s.id, { start: t, end: t + dur, estimated: !m && !s.disabled });
    if (s.kind === 'play') {
      rows = Math.max(rows, s.anims?.length ?? 0);
      const playRt = literal(s.args?.run_time);
      const place = (list: Anim[], base: number, sequential: boolean, top: boolean) => {
        let cursor = base;
        for (const a of list) {
          const am = !a.disabled && m ? ma.get(a.id) : undefined;
          let span: Span;
          if (am && m) span = { start: t + (am.start - m.start), end: t + (am.end - m.start), curve: am.curve };
          else {
            const d = top && playRt !== undefined && !a.disabled ? playRt : animEstimate(a);
            span = { start: cursor, end: cursor + d, estimated: true };
          }
          anims.set(a.id, span);
          if (a.anims) place(a.anims, span.start, a.cls === 'Succession', false);
          if (sequential) cursor = span.end;
        }
      };
      place(s.anims ?? [], t, false, true);
    }
    t += dur;
  }
  return { steps, anims, end: t, rows };
}

// ---------------------------------------------------------------------------- finding things

export const findStep = (doc: SceneDoc, id: string) => doc.timeline.find((s) => s.id === id);

export interface AnimRef {
  step: Step;
  anim: Anim;
  list: Anim[]; // the list containing it (the play's anims or a composition's)
  parent: Anim | null; // the composition it is in
}

export function findAnim(doc: SceneDoc, id: string): AnimRef | undefined {
  for (const step of doc.timeline) {
    if (step.kind !== 'play') continue;
    const search = (list: Anim[], parent: Anim | null): AnimRef | undefined => {
      for (const a of list) {
        if (a.id === id) return { step, anim: a, list, parent };
        const r = a.anims ? search(a.anims, a) : undefined;
        if (r) return r;
      }
      return undefined;
    };
    const r = search(step.anims ?? [], null);
    if (r) return r;
  }
  return undefined;
}

/** Object names an animation (and the animations inside it) acts on. */
export function targetsOf(a: Anim): string[] {
  const out: string[] = [];
  for (const x of walk([a])) for (const t of (x.target ?? '').split(',')) if (t.trim()) out.push(t.trim());
  return out;
}

const STRING = /([rRbBuUfF]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;

/** Every identifier a step's code reads (targets, arguments, chains, code), outside string literals. */
export function namesUsed(s: Step): Set<string> {
  const texts: string[] = [...(s.targets ?? []), s.code ?? '', ...Object.values(s.args ?? {})];
  for (const a of walk(s.anims)) texts.push(a.target ?? '', a.chain ?? '', ...Object.values(a.args ?? {}));
  return new Set(texts.flatMap((t) => t.replace(STRING, '').match(/[A-Za-z_]\w*/g) ?? []));
}

/** Names a step uses (targets of its animations, added/removed objects). */
export function stepTargets(s: Step): string[] {
  if (s.kind === 'play') return (s.anims ?? []).flatMap(targetsOf);
  return s.targets ?? [];
}

// ---------------------------------------------------------------------------- making steps

export const waitStep = (duration: number): Step => ({ id: uidT('s'), kind: 'wait', args: { duration: numSrc(duration) } });
export const playStep = (anims: Anim[], args: Args = {}): Step => ({ id: uidT('s'), kind: 'play', anims, args });
export const newAnim = (cls: string, target: string, args: Args = {}): Anim =>
  cls === 'animate' ? { id: uidT('a'), cls, target, args, chain: '.shift(RIGHT)' } : { id: uidT('a'), cls, target, args };

/** A copy with new ids (animations inside too). */
export function cloneStep(s: Step): Step {
  const c = structuredClone(s);
  c.id = uidT('s');
  for (const a of walk(c.anims)) a.id = uidT('a');
  return c;
}
export function cloneAnim(a: Anim): Anim {
  const c = structuredClone(a);
  for (const x of walk([c])) x.id = uidT('a');
  return c;
}

const isPlainWait = (s: Step | undefined): boolean =>
  !!s && s.kind === 'wait' && !s.disabled && !s.comment && literal(s.args?.duration) !== undefined && Object.keys(s.args ?? {}).length === 1;

// ---------------------------------------------------------------------------- where an edit at time t lands

export type Landing =
  | { kind: 'join'; step: string; time: number } // into this self.play (it starts with it)
  | { kind: 'split'; step: string; time: number } // into this self.wait, at `time`
  | { kind: 'before' | 'after'; step: string; time: number }
  | { kind: 'end'; time: number; gap: number }; // after everything (a wait first for the gap)

/** What placing something at time `t` does. `anim`: an animation (it can join a self.play under it). */
export function landing(doc: SceneDoc, lay: Layout, t: number, anim: boolean): Landing {
  t = Math.max(0, t);
  if (t >= lay.end - EPS) return { kind: 'end', time: Math.max(t, lay.end), gap: Math.max(0, t - lay.end) };
  for (const s of doc.timeline) {
    if (s.disabled) continue;
    const sp = lay.steps.get(s.id)!;
    if (sp.end - sp.start < EPS || t < sp.start - EPS || t >= sp.end - EPS) continue;
    if (s.kind === 'play' && anim) return { kind: 'join', step: s.id, time: sp.start };
    if (isPlainWait(s)) return { kind: 'split', step: s.id, time: t };
    return t - sp.start < sp.end - t ? { kind: 'before', step: s.id, time: sp.start } : { kind: 'after', step: s.id, time: sp.end };
  }
  return { kind: 'end', time: lay.end, gap: 0 };
}

/**
 * Insert `steps` (lasting about `length` seconds) where `land` says. Dropped into a wait, they take its place
 * from that time on, like an overwrite into a gap: what remains of the wait (and the waits right after it)
 * shrinks so later steps keep their time when there is room.
 */
export function placeSteps(d: SceneDoc, lay: Layout, land: Landing, steps: Step[], length: number) {
  const idx = land.kind === 'end' ? -1 : d.timeline.findIndex((s) => s.id === land.step);
  if (land.kind === 'end' || idx < 0) {
    const gap = land.kind === 'end' ? land.gap : 0;
    if (gap > EPS) d.timeline.push(waitStep(gap));
    d.timeline.push(...steps);
    return;
  }
  if (land.kind === 'before' || land.kind === 'join') return void d.timeline.splice(idx, 0, ...steps);
  if (land.kind === 'after') return void d.timeline.splice(idx + 1, 0, ...steps);
  // split a wait
  const w = d.timeline[idx];
  const sp = lay.steps.get(w.id) ?? { start: land.time, end: land.time };
  const before = land.time - sp.start;
  let rest = sp.end - land.time - length; // what remains of the gap after the inserted steps
  const out: Step[] = [];
  if (before > EPS) out.push({ ...w, args: { ...w.args, duration: numSrc(before) } });
  out.push(...steps);
  let next = idx + 1;
  while (rest < -EPS && isPlainWait(d.timeline[next])) {
    // the gap is too short: take the time from the waits that follow
    const nw = d.timeline[next];
    rest += literal(nw.args!.duration)!;
    next++;
    if (rest > EPS) out.push({ ...nw, args: { duration: numSrc(rest) } });
  }
  if (rest > EPS && next === idx + 1) out.push(before > EPS ? waitStep(rest) : { ...w, args: { ...w.args, duration: numSrc(rest) } });
  const replaced = d.timeline.slice(idx, next).map((x) => x.id).filter((id) => !out.some((o) => o.id === id));
  d.timeline.splice(idx, next - idx, ...out);
  for (const id of replaced) reanchor(d, id, steps[steps.length - 1]?.id);
}

/** Put animations where `land` says: into the play under it (at `row`), or a new self.play. Returns the play's id. */
export function placeAnims(d: SceneDoc, lay: Layout, land: Landing, anims: Anim[], row?: number): string {
  const target = land.kind === 'join' ? findStep(d, land.step) : undefined;
  if (target?.kind === 'play') {
    target.anims ??= [];
    const at = row === undefined ? target.anims.length : Math.max(0, Math.min(row, target.anims.length));
    target.anims.splice(at, 0, ...anims);
    return target.id;
  }
  const play = playStep(anims);
  placeSteps(d, lay, land, [play], Math.max(0, ...anims.map((a) => (lay.anims.get(a.id) ? spanLength(lay.anims.get(a.id)!) : animEstimate(a)))));
  return play.id;
}

const spanLength = (s: Span) => s.end - s.start;

// ---------------------------------------------------------------------------- removing

/**
 * Take a step out. 'lift' leaves its time as a gap (a self.wait, joined with waits next to it), like Premiere's
 * Delete; 'ripple' closes the gap. A play that loses all its animations goes the same way.
 */
export function removeStep(d: SceneDoc, lay: Layout, id: string, mode: 'lift' | 'ripple') {
  const i = d.timeline.findIndex((s) => s.id === id);
  if (i < 0) return;
  const s = d.timeline[i];
  const sp = lay.steps.get(id);
  const dur = sp ? sp.end - sp.start : 0;
  if (mode === 'ripple' || dur < EPS || s.kind === 'wait' || s.disabled) {
    d.timeline.splice(i, 1);
    reanchor(d, id, i > 0 ? d.timeline[i - 1]?.id : undefined);
    return;
  }
  // Lift: the step becomes a wait of the same length (same id, so objects made after it stay there).
  const prev = d.timeline[i - 1] as Step | undefined;
  if (prev && isPlainWait(prev)) {
    prev.args = { duration: numSrc(literal(prev.args!.duration)! + dur) };
    d.timeline.splice(i, 1);
    reanchor(d, id, prev.id);
  } else d.timeline[i] = { id, kind: 'wait', args: { duration: numSrc(dur) } };
  const k = d.timeline.findIndex((x) => x.id === (prev && isPlainWait(prev) ? prev.id : id));
  const next = d.timeline[k + 1] as Step | undefined;
  if (next && isPlainWait(next) && isPlainWait(d.timeline[k])) {
    d.timeline[k].args = { duration: numSrc(literal(d.timeline[k].args!.duration)! + literal(next.args!.duration)!) };
    d.timeline.splice(k + 1, 1);
    reanchor(d, next.id, d.timeline[k].id);
  }
}

/** Remove animations (and steps) by id; plays left without animations are removed by `mode`. */
export function removeIds(d: SceneDoc, lay: Layout, ids: Set<string>, mode: 'lift' | 'ripple') {
  const emptied: string[] = [];
  for (const s of d.timeline) {
    if (s.kind !== 'play' || ids.has(s.id)) continue;
    const before = s.anims?.length ?? 0;
    s.anims = prune(s.anims ?? [], ids);
    if (before && !s.anims.length) emptied.push(s.id);
  }
  for (const id of [...d.timeline.filter((s) => ids.has(s.id)).map((s) => s.id), ...emptied]) removeStep(d, lay, id, mode);
}

function prune(list: Anim[], ids: Set<string>): Anim[] {
  const out: Anim[] = [];
  for (const a of list) {
    if (ids.has(a.id)) continue;
    if (a.anims) {
      const had = a.anims.length;
      a.anims = prune(a.anims, ids);
      if (had && !a.anims.length) continue; // an empty composition can't play
    }
    out.push(a);
  }
  return out;
}

/** Objects created after a removed step are now created after the step before it. */
function reanchor(d: SceneDoc, gone: string, to: string | undefined) {
  for (const o of d.objects) if (o.after === gone) {
    if (to) o.after = to;
    else delete o.after;
  }
}

/**
 * Objects used by step `stepId` must exist when it runs: an object created later (after a later step, as in
 * imported code) is now created before it.
 */
export function ensureDefined(d: SceneDoc, stepId: string) {
  const i = d.timeline.findIndex((s) => s.id === stepId);
  const s = d.timeline[i];
  if (!s) return;
  // the objects it uses, and what those are built from (a moved object brings its sources along)
  const todo = [...namesUsed(s)];
  const seen = new Set<string>();
  while (todo.length) {
    const name = todo.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const o = d.objects.find((x) => x.name === name);
    if (!o?.after) continue;
    if (d.timeline.findIndex((x) => x.id === o.after) < i) continue;
    if (i > 0) o.after = d.timeline[i - 1].id;
    else delete o.after;
    const texts = [o.ctor, o.chain ?? '', ...Object.values(o.args)];
    todo.push(...texts.flatMap((t) => t.replace(STRING, '').match(/[A-Za-z_]\w*/g) ?? []));
  }
}

/**
 * After steps move, every step must still find its objects: objects created right after a moved step move with it,
 * so a step that stayed where it was may now come before an object it uses.
 */
function ensureAllDefined(d: SceneDoc) {
  for (const s of [...d.timeline]) ensureDefined(d, s.id);
}

// ---------------------------------------------------------------------------- moving and trimming

/** Move (or copy) top-level animations to time `t`, at `row` of the self.play there. Returns the ids now placed. */
export function moveAnims(d: SceneDoc, measured: RunResult | null, ids: string[], t: number, row: number | undefined, copy: boolean): string[] {
  const refs = ids.map((id) => findAnim(d, id)).filter((r): r is AnimRef => !!r && !r.parent);
  if (!refs.length) return [];
  const lay0 = layout(d, measured);
  const land0 = landing(d, lay0, t, true);
  const moving = refs.map((r) => (copy ? cloneAnim(r.anim) : r.anim));
  const sameStep = refs.every((r) => r.step.id === refs[0].step.id);
  if (!copy && sameStep && land0.kind === 'join' && land0.step === refs[0].step.id) {
    // only the order changes (the row it is drawn on)
    const s = refs[0].step;
    s.anims = s.anims!.filter((a) => !ids.includes(a.id));
    s.anims.splice(Math.max(0, Math.min(row ?? s.anims.length, s.anims.length)), 0, ...moving);
    return moving.map((a) => a.id);
  }
  // A clip keeps its length when it moves: the run_time its self.play gave it becomes its own.
  refs.forEach((r, i) => {
    const rt = r.step.args?.run_time;
    if (rt !== undefined && moving[i].args.run_time === undefined) moving[i].args = { ...moving[i].args, run_time: rt };
  });
  if (!copy) removeIds(d, lay0, new Set(refs.map((r) => r.anim.id)), 'lift');
  const lay = layout(d, measured);
  // the moved animations keep their measured length
  refs.forEach((r, i) => lay0.anims.has(r.anim.id) && lay.anims.set(moving[i].id, lay0.anims.get(r.anim.id)!));
  const playId = placeAnims(d, lay, landing(d, lay, t, true), moving, row);
  ensureDefined(d, playId);
  ensureAllDefined(d);
  return moving.map((a) => a.id);
}

/** Move (or copy) whole steps to time `t`: the old place becomes a gap, the new one takes a gap's place. */
export function moveSteps(d: SceneDoc, measured: RunResult | null, ids: string[], t: number, copy: boolean): string[] {
  const lay0 = layout(d, measured);
  const list = d.timeline.filter((s) => ids.includes(s.id));
  if (!list.length) return [];
  const length = list.reduce((acc, s) => acc + spanLength(lay0.steps.get(s.id)!), 0);
  const moving = list.map((s) => (copy ? cloneStep(s) : s));
  if (!copy) {
    // Take them out leaving gaps, but keep their objects' anchors: they move with the steps.
    const anchors = new Map(d.objects.filter((o) => o.after && ids.includes(o.after)).map((o) => [o.id, o.after!]));
    for (const s of list) {
      const i = d.timeline.indexOf(s);
      const dur = spanLength(lay0.steps.get(s.id)!);
      d.timeline.splice(i, 1, ...(dur > EPS && !s.disabled ? [waitStep(dur)] : []));
    }
    mergeWaits(d);
    for (const o of d.objects) if (anchors.has(o.id)) o.after = anchors.get(o.id);
  }
  const lay = layout(d, measured);
  placeSteps(d, lay, landing(d, lay, t, false), moving, length);
  ensureAllDefined(d);
  return moving.map((s) => s.id);
}

/** Join neighboring plain waits (the gaps left by moves). */
function mergeWaits(d: SceneDoc) {
  for (let i = d.timeline.length - 1; i > 0; i--) {
    const a = d.timeline[i - 1], b = d.timeline[i];
    if (isPlainWait(a) && isPlainWait(b)) {
      a.args = { duration: numSrc(literal(a.args!.duration)! + literal(b.args!.duration)!) };
      d.timeline.splice(i, 1);
      reanchor(d, b.id, a.id);
    }
  }
}

/**
 * Set how long an animation runs (its run_time). A run_time on the self.play applies to every animation in
 * it; to change one of several, the others keep that run_time as their own.
 */
export function setAnimDuration(d: SceneDoc, id: string, seconds: number) {
  const r = findAnim(d, id);
  if (!r) return;
  const v = numSrc(Math.max(1 / 600, seconds));
  if (!r.parent && r.step.args?.run_time !== undefined) {
    if ((r.step.anims ?? []).filter((a) => !a.disabled).length <= 1) {
      r.step.args.run_time = v;
      return;
    }
    const old = r.step.args.run_time;
    delete r.step.args.run_time;
    for (const a of r.step.anims ?? []) if (a !== r.anim && a.args.run_time === undefined) a.args.run_time = old;
  }
  r.anim.args = { ...r.anim.args, run_time: v };
}

/** Set a step's length: a wait's duration, a play's run_time (every animation in it), a couple's glide. */
export function setStepDuration(d: SceneDoc, id: string, seconds: number) {
  const s = findStep(d, id);
  if (!s) return;
  const v = numSrc(Math.max(1 / 600, seconds));
  if (s.kind === 'wait') s.args = { ...s.args, duration: v };
  else if (s.kind === 'play') s.args = { ...s.args, run_time: v };
  else if (s.kind === 'couple') s.duration = Math.max(0, round(seconds));
}

export const canTrimStep = (s: Step) => s.kind === 'wait' || s.kind === 'play' || s.kind === 'couple';

// ---------------------------------------------------------------------------- compositions

/** The list an animation is in, and where. */
function listOf(d: SceneDoc, id: string): { list: Anim[]; i: number } | undefined {
  const r = findAnim(d, id);
  return r ? { list: r.list, i: r.list.indexOf(r.anim) } : undefined;
}

/** Add an animation to a self.play (by step id) or a composition (by animation id). */
export function addChild(d: SceneDoc, parentId: string, a: Anim) {
  const step = findStep(d, parentId);
  if (step?.kind === 'play') (step.anims ??= []).push(a);
  else {
    const p = findAnim(d, parentId)?.anim;
    if (p) (p.anims ??= []).push(a);
  }
}

/** Move an animation one place earlier (-1) or later (+1) in its self.play or composition. */
export function reorder(d: SceneDoc, id: string, delta: number) {
  const at = listOf(d, id);
  if (!at) return;
  const j = at.i + delta;
  if (j < 0 || j >= at.list.length) return;
  const [a] = at.list.splice(at.i, 1);
  at.list.splice(j, 0, a);
}

/** Put animations that are side by side in one list into a composition (AnimationGroup, LaggedStart, Succession…). */
export function groupAnims(d: SceneDoc, ids: string[], cls: string): string | null {
  const first = listOf(d, ids[0]);
  if (!first || !ids.every((id) => listOf(d, id)?.list === first.list)) return null;
  const members = first.list.filter((a) => ids.includes(a.id));
  const at = Math.min(...members.map((a) => first.list.indexOf(a)));
  const group: Anim = { id: uidT('a'), cls, target: '', args: {}, anims: members };
  const rest = first.list.filter((a) => !ids.includes(a.id));
  rest.splice(at, 0, group);
  first.list.splice(0, first.list.length, ...rest);
  return group.id;
}

/** Replace a composition by its animations (its own arguments, such as lag_ratio, go with it). */
export function ungroup(d: SceneDoc, id: string) {
  const r = findAnim(d, id);
  if (!r?.anim.anims) return;
  const i = r.list.indexOf(r.anim);
  r.list.splice(i, 1, ...r.anim.anims);
}

// ---------------------------------------------------------------------------- renaming and deleting objects

/** Rename object identifiers used by the timeline. */
export function renameInTimeline(d: SceneDoc, names: Map<string, string>) {
  const rep = (s: string) => renameIdentifiers(s, names);
  for (const s of d.timeline) {
    if (s.targets) s.targets = s.targets.map(rep);
    if (s.code) s.code = rep(s.code);
    for (const k in s.args ?? {}) s.args![k] = rep(s.args![k]);
    for (const a of walk(s.anims)) {
      a.target = rep(a.target ?? '');
      if (a.chain) a.chain = rep(a.chain);
      for (const k in a.args ?? {}) a.args[k] = rep(a.args[k]);
    }
  }
}

/** Remove what animates deleted objects: their animations, and them from add/remove/couple steps. */
export function forgetObjects(d: SceneDoc, lay: Layout, names: Set<string>, ids: Set<string>) {
  const gone = new Set<string>();
  for (const s of d.timeline) {
    for (const a of walk(s.anims)) {
      const ts = targetsOf({ ...a, anims: undefined });
      if ((ts.length && ts.every((t) => names.has(t))) || (a.terms && ids.has(a.terms.to))) gone.add(a.id);
    }
    if (s.targets) {
      const had = s.targets.length;
      s.targets = s.targets.filter((t) => !names.has(t));
      if (had && !s.targets.length) gone.add(s.id);
    }
  }
  removeIds(d, lay, gone, 'lift');
}
