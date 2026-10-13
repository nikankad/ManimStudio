// The timeline is construct()'s statements in order (mathengine/timeline.py): each step is one manim statement and
// starts when the one before it ends. This module lays them out in time, Premiere-style, and turns timeline
// edits (dropping, moving and trimming clips) into edits of those statements, so the code stays plain manim.
//
// Times come from manim (RunResult: when each statement and animation ran); a step that hasn't been measured
// yet (just added) is estimated from its arguments until the next measurement arrives.

import { renameIdentifiers } from './pyparse';
import type { Anim, Args, Marker, MarkerCategory, RunResult, SceneDoc, Step } from './types';

export const EPS = 1e-6;

export interface Span {
  start: number;
  end: number;
  estimated?: boolean;
  curve?: number[]; // progress at evenly spaced times (measured by manim)
  iters?: { start: number; end: number }[]; // inside a block: when it runs again (its later runs, measured)
  skipped?: boolean; // inside a block: manim measured that it didn't run (a branch not taken, a loop over nothing)
  elsewhere?: boolean; // inside a block: it didn't run in the block's first run, only in later ones (`iters`)
}

/** A compound statement on the timeline: its first run is laid out step by step, the later ones follow it. */
export interface BlockSpan {
  id: string; // the block step that opens it
  endId?: string; // its end step
  depth: number;
  start: number;
  body: number; // where its first run ends
  end: number; // where all its runs end
  runs?: number; // how many times its first clause's body ran (measured)
  estimated: boolean;
  clauses: { id: string; start: number; end: number; runs?: number }[];
}

export interface Layout {
  steps: Map<string, Span>; // disabled steps take no time
  anims: Map<string, Span>;
  end: number;
  rows: number; // most animations in one self.play
  blocks: BlockSpan[];
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
const signature = (s: Step) => JSON.stringify(s, (k, v) => (k === 'comment' || k === 'eol' || k === 'label' ? undefined : v));
const measuredSigs = new WeakMap<RunResult, Map<string, string>>();

/** Whether manim's measurement still describes this step (it is unchanged since it was measured). */
export function isMeasured(s: Step, measured: RunResult | null): boolean {
  if (!measured) return false;
  if (!measured.doc) return true;
  let sigs = measuredSigs.get(measured);
  if (!sigs) measuredSigs.set(measured, (sigs = new Map(measured.doc.timeline.map((x) => [x.id, signature(x)]))));
  return sigs.get(s.id) === signature(s);
}

// ---------------------------------------------------------------------------- blocks (for, while, if, with, try…)

const CLAUSE = /^\s*(elif|else|except|finally)\b/;

/** A block step that continues the open compound statement (elif …, else, except …, finally). */
export const isClause = (s: Step) => s.kind === 'block' && CLAUSE.test(s.head ?? '');

const FOR = /^\s*(?:async\s+)?for\s+([A-Za-z_]\w*)\s+in\b/;

/** The counter a loop step sets: its Repeat's, or the name of a `for k in …` header. */
export const loopVar = (s: Step): string | null => (s.kind !== 'block' ? null : s.repeat?.var?.trim() || FOR.exec(s.head ?? '')?.[1] || null);

/** The counters of the loops around the point right after step `id` (none: the start of construct()). Its own,
 * when it opens a loop: what is created right after it is in its body. */
export function loopsAround(steps: Step[], id: string | undefined): string[] {
  const stack: (string | null)[] = [];
  for (const s of steps) {
    if (s.kind === 'block' && !isClause(s)) stack.push(loopVar(s));
    else if (s.kind === 'end') stack.pop();
    if (s.id === id) return stack.filter((v): v is string => !!v);
  }
  return [];
}

/** For each block step opening a compound statement: its clauses and its end (undefined: not closed). */
export function compounds(steps: Step[]): Map<string, { clauses: string[]; end?: string; from: number; to: number }> {
  const out = new Map<string, { clauses: string[]; end?: string; from: number; to: number }>();
  const stack: string[] = [];
  steps.forEach((s, i) => {
    if (s.kind === 'block' && !isClause(s)) {
      stack.push(s.id);
      out.set(s.id, { clauses: [], from: i, to: steps.length - 1 });
    } else if (s.kind === 'block' && stack.length) out.get(stack[stack.length - 1])!.clauses.push(s.id);
    else if (s.kind === 'end' && stack.length) {
      const c = out.get(stack.pop()!)!;
      c.end = s.id;
      c.to = i;
    }
  });
  return out;
}

/** The compound statement a block or end step belongs to (its opener's id). */
export function compoundOf(steps: Step[], id: string): string | undefined {
  for (const [opener, c] of compounds(steps)) if (opener === id || c.end === id || c.clauses.includes(id)) return opener;
  return undefined;
}

/** How many times a loop runs, read from its header when manim hasn't measured it: range(3), [a, b, c]; else once. */
export function estimateRuns(head: string): number {
  const it = head.match(/^\s*for\s+[\s\S]+?\s+in\s+([\s\S]+)$/)?.[1]?.trim();
  if (!it) return 1;
  const r = it.match(/^range\(\s*(-?\d+)\s*(?:,\s*(-?\d+)\s*)?(?:,\s*(-?\d+)\s*)?\)$/);
  if (r) {
    const [a, b, st] = r[2] === undefined ? [0, +r[1], 1] : [+r[1], +r[2], r[3] === undefined ? 1 : +r[3]];
    return st ? Math.max(0, Math.ceil((b - a) / st)) : 1;
  }
  if (/^[[(][\s\S]*[\])]$/.test(it)) {
    const inner = it.slice(1, -1).trim();
    let depth = 0, n = inner ? 1 : 0;
    for (const ch of inner.replace(STRING, '""')) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) n++;
    }
    return inner.endsWith(',') ? n - 1 : n;
  }
  return 1;
}

const MAX_ITERS = 200; // later runs drawn per clip

export function layout(doc: SceneDoc, measured: RunResult | null): Layout {
  // A step inside a loop runs (and is measured) several times: the first run is where it is laid out, the
  // later ones are drawn after it. A step manim measured that never ran (a branch not taken) takes no time.
  const occ = new Map<string, NonNullable<RunResult['steps']>>();
  for (const x of measured?.steps ?? []) occ.set(x.id, [...(occ.get(x.id) ?? []), x]);
  const occA = new Map<string, NonNullable<RunResult['anims']>>();
  for (const x of measured?.anims ?? []) occA.set(x.id, [...(occA.get(x.id) ?? []), x]);
  const ms = new Map([...occ].map(([k, v]) => [k, v[0]]));
  const ma = new Map([...occA].map(([k, v]) => [k, v[0]]));
  const ran = (s: Step) => !!measured && !measured.error && isMeasured(s, measured); // its measurement is complete
  const steps = new Map<string, Span>();
  const anims = new Map<string, Span>();
  const blocks: BlockSpan[] = [];
  const shapes = compounds(doc.timeline ?? []);
  // win: when the block's first run happened (manim's time): a step whose first run is outside it (an else taken
  // only later in a loop) takes no time in the layout of the first run; all its runs are drawn faintly
  type Frame = { s: Step; block: BlockSpan; off: boolean; whole: boolean; win?: { start: number; end: number } };
  const frames: Frame[] = [];
  let shift: number | undefined; // timeline time minus manim's time, inside the outermost measured block
  const later = (id: string, list: Map<string, { start: number; end: number }[]>, all = false): Span['iters'] =>
    frames.length && shift !== undefined && (list.get(id)?.length ?? 0) > (all ? 0 : 1)
      ? list.get(id)!.slice(all ? 0 : 1, MAX_ITERS + 1).map((o) => ({ start: o.start + shift!, end: o.end + shift! }))
      : undefined;
  const entries = (id: string) => (occ.get(id) ?? []).length;
  const outside = (m: { start: number; end: number }) => {
    const win = [...frames].reverse().find((f) => f.win)?.win;
    return !!win && (m.start < win.start - EPS || m.end > win.end + EPS);
  };
  const close = (f: Frame, endStep?: Step) => {
    const b = f.block;
    b.clauses[b.clauses.length - 1].end = t;
    b.body = t;
    const mEnd = endStep && f.whole && ran(f.s) && ran(endStep) ? ms.get(endStep.id) : undefined;
    const runs = ran(f.s) ? entries(f.s.id) : undefined;
    b.runs = runs;
    for (const c of b.clauses) {
      const cs = doc.timeline.find((x) => x.id === c.id);
      if (cs && ran(cs)) c.runs = entries(c.id);
    }
    const perRun = runs && endStep && ran(endStep) ? (occ.get(endStep.id)?.length ?? 1) : 1; // nested: runs of each
    const once = t - b.start;
    const total = f.off ? 0 : mEnd ? Math.max(0, mEnd.end - mEnd.start) : once * Math.max(1, runs !== undefined ? runs / perRun : estimateRuns(f.s.head ?? ''));
    b.end = b.start + Math.max(total, f.off ? 0 : once);
    b.estimated = !mEnd && !f.off;
    steps.set(f.s.id, { start: b.start, end: b.end, estimated: b.estimated });
    t = b.end;
    if (endStep) steps.set(endStep.id, { start: t, end: t });
    if (frames.length === 0) shift = undefined;
  };
  let t = 0;
  let rows = 0;
  for (const s of doc.timeline ?? []) {
    const off = !!s.disabled || frames.some((f) => f.off);
    if (s.kind === 'block' && isClause(s) && frames.length) {
      const b = frames[frames.length - 1].block;
      b.clauses[b.clauses.length - 1].end = t;
      b.clauses.push({ id: s.id, start: t, end: t });
      steps.set(s.id, { start: t, end: t });
      continue;
    }
    if (s.kind === 'block') {
      const endId = shapes.get(s.id)?.end;
      const block: BlockSpan = { id: s.id, endId, depth: frames.length, start: t, body: t, end: t, estimated: true, clauses: [{ id: s.id, start: t, end: t }] };
      blocks.push(block);
      if (!frames.length && endId && !off && ran(s)) {
        const m = ms.get(endId);
        if (m) shift = t - m.start;
      }
      const mw = endId && !off && ran(s) ? ms.get(endId) : undefined;
      frames.push({ s, block, off, whole: true, win: mw && { start: mw.start, end: mw.end } });
      steps.set(s.id, { start: t, end: t });
      continue;
    }
    if (s.kind === 'end' && frames.length) {
      close(frames.pop()!, s);
      continue;
    }
    const m0 = off || !isMeasured(s, measured) ? undefined : ms.get(s.id);
    const elsewhere = !!m0 && outside(m0); // it runs, but not in the block's first run
    const m = elsewhere ? undefined : m0;
    const skipped = !off && !m && frames.length > 0 && ran(s) && (elsewhere || !occ.has(s.id));
    if (!m && !skipped && !off) for (const f of frames) f.whole = false;
    const dur = off || skipped ? 0 : m ? Math.max(0, m.end - m.start) : stepEstimate(s);
    steps.set(s.id, { start: t, end: t + dur, estimated: !m && !off && !skipped, skipped: (skipped && !elsewhere) || undefined, elsewhere: elsewhere || undefined, iters: m ? later(s.id, occ) : elsewhere ? later(s.id, occ, true) : undefined });
    if (s.kind === 'play') {
      rows = Math.max(rows, s.anims?.length ?? 0);
      const playRt = literal(s.args?.run_time);
      const place = (list: Anim[], base: number, sequential: boolean, top: boolean) => {
        let cursor = base;
        for (const a of list) {
          const am = !a.disabled && m ? ma.get(a.id) : undefined;
          let span: Span;
          if (skipped) span = { start: t, end: t, skipped: !elsewhere || undefined, elsewhere: elsewhere || undefined, iters: elsewhere && !a.disabled ? later(a.id, occA, true) ?? (a.cls === 'expr' ? later(s.id, occ, true) : undefined) : undefined };
          else if (am && m) span = { start: t + (am.start - m.start), end: t + (am.end - m.start), curve: am.curve, iters: later(a.id, occA) };
          // `*[FadeOut(m) for m in dots]`: animations manim makes as it runs, measured together as their self.play
          else if (m && top && a.cls === 'expr' && !a.disabled) span = { start: t, end: t + dur, iters: later(s.id, occ) };
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
  while (frames.length) close(frames.pop()!); // a block left open runs to the end
  return { steps, anims, end: t, rows, blocks };
}

// ---------------------------------------------------------------------------- per-frame rules (updaters)

/** A rule manim applies to an object on every frame, from where it is set to where it is cleared. */
export interface Rule {
  id: string; // what makes it: an object (always_redraw, or made with .add_updater) or a step (obj.add_updater(...))
  object: boolean;
  name: string;
  what: string; // "always_redraw", ".add_updater(…)"
  start: number;
  end: number;
  row: number;
}

const ADDS = /\.add_updater\s*\(/;
const CLEARS = /\.(clear_updaters|remove_updater)\s*\(/;

/** Updaters on the timeline: each from the statement that sets it to the one that clears it (or the end). */
export function rules(doc: SceneDoc, lay: Layout): Rule[] {
  const out: Rule[] = [];
  const open = new Map<string, Rule[]>();
  const begin = (r: Omit<Rule, 'end' | 'row'>) => {
    const rule = { ...r, end: lay.end, row: 0 };
    out.push(rule);
    open.set(r.name, [...(open.get(r.name) ?? []), rule]);
  };
  const made = (o: SceneDoc['objects'][number]) => (o.after ? lay.steps.get(o.after)?.end ?? 0 : 0);
  const objectsAfter = new Map<string, SceneDoc['objects']>();
  for (const o of doc.objects) objectsAfter.set(o.after ?? '', [...(objectsAfter.get(o.after ?? '') ?? []), o]);
  const objectRules = (list: SceneDoc['objects'] | undefined) => {
    for (const o of list ?? []) {
      if (o.ctor === 'always_redraw' || o.ctor === 'always') begin({ id: o.id, object: true, name: o.name, what: o.ctor, start: made(o) });
      else if (ADDS.test(o.chain ?? '')) begin({ id: o.id, object: true, name: o.name, what: '.add_updater(…)', start: made(o) });
    }
  };
  objectRules(objectsAfter.get(''));
  for (const s of doc.timeline) {
    const sp = lay.steps.get(s.id);
    if (sp && !s.disabled && s.kind === 'apply' && s.target) {
      const name = rootName(s.target);
      const chain = s.chain ?? '';
      if (CLEARS.test(chain)) {
        for (const r of open.get(name) ?? []) r.end = Math.min(r.end, sp.start);
        open.delete(name);
      }
      if (ADDS.test(chain) && !CLEARS.test(chain.slice(chain.search(ADDS)))) begin({ id: s.id, object: false, name, what: '.add_updater(…)', start: sp.start });
    }
    objectRules(objectsAfter.get(s.id));
  }
  // rows: each rule in the first one free at its start
  const ends: number[] = [];
  for (const r of out.sort((a, b) => a.start - b.start)) {
    let row = ends.findIndex((e) => e <= r.start + EPS);
    if (row < 0) row = ends.length;
    ends[row] = r.end;
    r.row = row;
  }
  return out;
}

// ---------------------------------------------------------------------------- markers

export const MARKER_CATEGORIES: { id: MarkerCategory; label: string }[] = [
  { id: 'chapter', label: 'Chapter' },
  { id: 'narration', label: 'Narration' },
  { id: 'visual', label: 'Visual event' },
  { id: 'review', label: 'Review' },
];


/** Where a marker is: at its time, or (attached) at the start or end of its step or animation plus its offset. */
export function markerTime(m: Marker, lay: Layout): number {
  const sp = m.anchor && (lay.anims.get(m.anchor.id) ?? lay.steps.get(m.anchor.id));
  if (!m.anchor || !sp) return m.time;
  return Math.max(0, (m.anchor.edge === 'end' ? sp.end : sp.start) + m.anchor.offset);
}

/** Attach to the nearer edge of this step or animation, keeping the time `t`. */
export function anchorTo(lay: Layout, id: string, t: number): Marker['anchor'] {
  const sp = lay.anims.get(id) ?? lay.steps.get(id);
  if (!sp) return undefined;
  const edge = Math.abs(t - sp.end) < Math.abs(t - sp.start) ? 'end' : 'start';
  return { id, edge, offset: round(t - sp[edge]) };
}

/**
 * After an edit: attached markers remember where they are now, and one whose step or animation is gone stays where it
 * was (`prev` is the layout before the edit). Returns the markers that were let go.
 */
export function settleMarkers(d: SceneDoc, prevLay: Layout, lay: Layout): Marker[] {
  const gone: Marker[] = [];
  for (const m of d.markers ?? []) {
    if (!m.anchor) continue;
    if (lay.anims.has(m.anchor.id) || lay.steps.has(m.anchor.id)) m.time = round(markerTime(m, lay));
    else {
      m.time = round(markerTime(m, prevLay));
      delete m.anchor;
      gone.push(m);
    }
  }
  return gone;
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

/** The animation class an expression builds ("FadeOut" of `*[FadeOut(m) for m in dots]`), else "code". */
export const exprName = (src: string) => src.match(/([A-Z]\w*)\s*\(/)?.[1] ?? 'code';

/** The class an animation is, or builds (an expression animation). */
export const animClass = (a: Anim) => (a.cls === 'expr' ? exprName(a.src ?? '') : a.cls);

/** The variable an expression starts from: `group` of `group[0].submobjects`. */
export const rootName = (expr: string) => expr.trim().match(/^[A-Za-z_]\w*/)?.[0] ?? '';

/** Every identifier a step's code reads (targets, arguments, chains, code), outside string literals. */
export function namesUsed(s: Step): Set<string> {
  const texts: string[] = [...(s.targets ?? []), s.code ?? '', s.target ?? '', s.chain ?? '', s.value ?? '', s.head ?? '', ...Object.values(s.args ?? {})];
  for (const a of walk(s.anims)) texts.push(a.target ?? '', a.chain ?? '', a.src ?? '', ...Object.values(a.args ?? {}));
  return new Set(texts.flatMap((t) => t.replace(STRING, '').match(/[A-Za-z_]\w*/g) ?? []));
}

/** Names a step uses (targets of its animations, added/removed objects). */
export function stepTargets(s: Step): string[] {
  if (s.kind === 'play') return (s.anims ?? []).flatMap(targetsOf);
  if (s.kind === 'apply') return s.target ? [rootName(s.target)] : [];
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
    if (s.kind === 'block' || s.kind === 'end') {
      // inside a block's later runs: its steps are those of the first run, so it lands after the block
      const b = lay.blocks.find((x) => x.id === s.id);
      if (b?.endId && t >= b.body - EPS && t < b.end - EPS) return { kind: 'after', step: b.endId, time: b.end };
      continue;
    }
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

/**
 * The steps a selection stands for: a block or its end, its whole compound statement (the steps in it too); a
 * clause (else, except…), that clause and its body. Blocks stay balanced whatever is removed, moved or copied.
 */
export function withBlocks(d: SceneDoc, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  for (const [opener, c] of compounds(d.timeline)) {
    const range = (from: number, to: number) => d.timeline.slice(from, to + 1).forEach((x) => out.add(x.id));
    if (out.has(opener) || (c.end && out.has(c.end))) range(c.from, c.to);
    else for (const [k, id] of c.clauses.entries()) {
      if (!out.has(id)) continue;
      const from = d.timeline.findIndex((x) => x.id === id);
      const next = c.clauses[k + 1] ?? c.end;
      range(from, next ? d.timeline.findIndex((x) => x.id === next) - 1 : c.to);
    }
  }
  return out;
}

/** Remove animations (and steps) by id; plays left without animations are removed by `mode`. */
export function removeIds(d: SceneDoc, lay: Layout, ids: Set<string>, mode: 'lift' | 'ripple') {
  if (d.timeline.some((s) => ids.has(s.id) && (s.kind === 'block' || s.kind === 'end'))) {
    ids = withBlocks(d, ids);
    // A whole compound statement goes as one step (its time left as a gap by 'lift'); a clause goes with its body.
    // (the shapes are read again for each: taking one block's steps out moves the ones after it)
    for (const opener of [...compounds(d.timeline).keys()]) {
      const c = ids.has(opener) ? compounds(d.timeline).get(opener) : undefined; // gone: it was inside one taken out
      if (!c) continue;
      for (const x of d.timeline.slice(c.from + 1, c.to + 1)) {
        ids.delete(x.id);
        reanchor(d, x.id, opener);
      }
      d.timeline.splice(c.from + 1, c.to - c.from);
    }
    const clauseIds = new Set(d.timeline.filter((x) => ids.has(x.id) && isClause(x)).map((x) => x.id));
    for (const id of clauseIds) {
      const from = d.timeline.findIndex((x) => x.id === id);
      let to = from;
      while (to + 1 < d.timeline.length && ids.has(d.timeline[to + 1].id) && !isClause(d.timeline[to + 1]) && d.timeline[to + 1].kind !== 'end') to++;
      for (const x of d.timeline.slice(from, to + 1)) {
        ids.delete(x.id);
        reanchor(d, x.id, d.timeline[from - 1]?.id);
      }
      d.timeline.splice(from, to - from + 1);
    }
  }
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
  // a clause (else, except…) can't stand on its own elsewhere: it moves with its whole statement
  ids = [...withBlocks(d, ids.map((id) => {
    const s = d.timeline.find((x) => x.id === id);
    return s && isClause(s) ? compoundOf(d.timeline, id) ?? id : id;
  }))];
  const list = d.timeline.filter((s) => ids.includes(s.id));
  if (!list.length) return [];
  // the steps inside a moving block move with it, in its time (its span covers all its runs)
  const inside = new Set<string>();
  for (const [opener, c] of compounds(d.timeline)) if (ids.includes(opener)) d.timeline.slice(c.from + 1, c.to + 1).forEach((x) => inside.add(x.id));
  const own = (s: Step) => (inside.has(s.id) ? 0 : spanLength(lay0.steps.get(s.id)!));
  const length = list.reduce((acc, s) => acc + own(s), 0);
  const moving = list.map((s) => (copy ? cloneStep(s) : s));
  if (!copy) {
    // Take them out leaving gaps, but keep their objects' anchors: they move with the steps.
    const anchors = new Map(d.objects.filter((o) => o.after && ids.includes(o.after)).map((o) => [o.id, o.after!]));
    for (const s of list) {
      const i = d.timeline.indexOf(s);
      const dur = own(s);
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
    // The group's duration overrode explicit sibling durations too.
    for (const a of r.step.anims ?? []) if (a !== r.anim) a.args.run_time = old;
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

/** What a duration edit does to the steps after it. */
export type Retime = {
  delta: number; // how much later the steps after it now start
  hold?: 'shrunk' | 'removed' | 'grown' | 'added'; // keep: what happened to the pause after it
  limit?: string; // keep: why the length was held back (there wasn't enough pause after it)
};

/**
 * Set the length of an animation (`anim`) or a step. Normally the steps after it move by the difference. With
 * `keep`, they keep their time: the plain self.wait right after it gives or takes the difference (a pause is added
 * when it gets shorter and there is none). It never lengthens past that pause: the length stops where the pause is
 * used up, and `limit` says why.
 */
export function retime(d: SceneDoc, measured: RunResult | null, target: { anim: string } | { step: string }, seconds: number, keep: boolean): Retime {
  const lay = layout(d, measured);
  const ref = 'anim' in target ? findAnim(d, target.anim) : undefined;
  const step = ref ? ref.step : 'step' in target ? findStep(d, target.step) : undefined;
  if (!step) return { delta: 0 };
  if (!ref && step.kind === 'wait') keep = false; // a pause is the hold itself: changing it moves what comes after
  const sp = lay.steps.get(step.id)!;
  const oldLen = sp.end - sp.start;
  const apply = (v: number) => (ref ? setAnimDuration(d, ref.anim.id, v) : setStepDuration(d, step.id, v));
  // the step's new length: an animation of several only lengthens its group past the longest of the others
  const lengthWith = (v: number): number => {
    if (!ref) return v;
    if (ref.parent) {
      const c = structuredClone(d);
      setAnimDuration(c, ref.anim.id, v);
      const s2 = layout(c, measured).steps.get(step.id)!;
      return s2.end - s2.start;
    }
    let others = 0;
    for (const a of step.anims ?? []) if (a !== ref.anim && !a.disabled) others = Math.max(others, (lay.anims.get(a.id)?.end ?? sp.start) - sp.start);
    return Math.max(v, others);
  };
  let delta = lengthWith(seconds) - oldLen;
  const i = d.timeline.indexOf(step);
  const later = d.timeline.slice(i + 1).filter((x) => !x.disabled);
  if (!keep || Math.abs(delta) < EPS || !later.length) {
    apply(seconds);
    return { delta: later.length ? delta : 0 };
  }
  const next = later[0];
  const hold = isPlainWait(next) ? literal(next.args!.duration)! : 0;
  const half = 0.5 / (d.config?.frame_rate || 60);
  let limit: string | undefined;
  if (delta > hold + half) {
    limit = hold > EPS
      ? `Only ${numSrc(hold)} s of pause after it to take the time from; turn off Keep later timing to move later beats instead`
      : 'No pause right after it to take the time from; turn off Keep later timing to move later beats instead';
    seconds = ref && !ref.parent ? oldLen + hold : seconds - (delta - hold);
    delta = hold;
    if (Math.abs(delta) < EPS) return { delta: 0, limit };
  }
  apply(seconds);
  const rest = hold - delta;
  if (isPlainWait(next)) {
    if (rest < half) {
      d.timeline.splice(d.timeline.indexOf(next), 1);
      reanchor(d, next.id, step.id);
      return { delta: 0, hold: 'removed', limit };
    }
    next.args = { duration: numSrc(rest) };
    return { delta: 0, hold: delta > 0 ? 'shrunk' : 'grown', limit };
  }
  d.timeline.splice(i + 1, 0, waitStep(-delta));
  return { delta: 0, hold: 'added', limit };
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
    if (s.target) s.target = rep(s.target);
    if (s.chain) s.chain = rep(s.chain);
    if (s.value) s.value = rep(s.value);
    if (s.head) s.head = rep(s.head);
    for (const k in s.args ?? {}) s.args![k] = rep(s.args![k]);
    for (const a of walk(s.anims)) {
      a.target = rep(a.target ?? '');
      if (a.chain) a.chain = rep(a.chain);
      if (a.src) a.src = rep(a.src);
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
    if (s.kind === 'apply' && names.has(rootName(s.target ?? ''))) gone.add(s.id);
    if (s.targets) {
      const had = s.targets.length;
      // a target is a name or an expression (`*dots`, `VGroup(a, b)`): one that uses a removed object goes
      s.targets = s.targets.filter((t) => !(t.replace(STRING, '').match(/[A-Za-z_]\w*/g) ?? []).some((w) => names.has(w)));
      if (had && !s.targets.length) gone.add(s.id);
    }
  }
  removeIds(d, lay, gone, 'lift');
}
