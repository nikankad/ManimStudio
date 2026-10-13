// Keyframes, the way manim has them: an animation's end. A channel (position, scale, rotation, opacity, colour, a
// ValueTracker's value) has a keyframe at the end of every clip that changes it: `c.animate.move_to(...)`,
// `.shift(...)`, `Rotate(c, ...)`, `t.animate.set_value(...)`… Keyframes are read from those clips, and editing one
// edits that clip: only the argument of the method that sets the channel changes, in the style it was written in, so
// the code stays the user's code and reads back the same. Adding a keyframe adds a plain `.animate` clip (`Rotate`
// for rotation) that ends at the playhead.

import { closing, evalNumber, evalVector, fmtNum, splitTop } from './pyparse';
import {
  EPS, findAnim, isMeasured, landing, layout, newAnim, numSrc, placeSteps, playStep, removeIds, setAnimDuration,
  ensureDefined, isClause, waitStep, walk, type Layout,
} from './timeline';
import type { Anim, Args, RunResult, SceneDoc, SceneObject, Step } from './types';

export type Channel = 'position' | 'scale' | 'rotation' | 'opacity' | 'color' | 'stroke' | 'value';
export type KeyValue = number | [number, number] | string; // a point, a number, or colour source (`RED`, `"#ff0000"`)

export const CHANNELS: { id: Channel; label: string; unit?: string }[] = [
  { id: 'position', label: 'Position' },
  { id: 'scale', label: 'Scale', unit: '×' },
  { id: 'rotation', label: 'Rotation', unit: '°' },
  { id: 'opacity', label: 'Opacity' },
  { id: 'color', label: 'Color' },
  { id: 'stroke', label: 'Stroke' },
  { id: 'value', label: 'Value' },
];

/** The camera of a MovingCameraScene (`self.camera.frame`): keyframed like an object (its position, and its zoom as
 * a scale: 2 shows twice as much). It isn't an object of the document, so it starts at the centre at scale 1. */
export const CAMERA_NAME = 'self.camera.frame';
export const CAMERA: SceneObject = { id: 'camera', name: CAMERA_NAME, ctor: 'Camera', args: {}, pos: [0, 0], chain: '', scale: 1, rotation: 0 };
const objectNamed = (doc: SceneDoc, name: string) => doc.objects.find((o) => o.name === name) ?? (name === CAMERA_NAME ? CAMERA : undefined);
const frameWidth = (doc: SceneDoc) => (8 * (doc.config?.pixel_width || 1920)) / (doc.config?.pixel_height || 1080);

/** Chain methods that change a channel. abs: sets it; rel: changes it by an amount; other: changes it some other way (shown, not editable). */
const METHODS: Record<string, { channel: Channel; kind: 'abs' | 'rel' | 'x' | 'y' | 'other' }> = {
  move_to: { channel: 'position', kind: 'abs' },
  shift: { channel: 'position', kind: 'rel' },
  set_x: { channel: 'position', kind: 'x' },
  set_y: { channel: 'position', kind: 'y' },
  next_to: { channel: 'position', kind: 'other' },
  to_edge: { channel: 'position', kind: 'other' },
  to_corner: { channel: 'position', kind: 'other' },
  align_to: { channel: 'position', kind: 'other' },
  center: { channel: 'position', kind: 'other' },
  match_x: { channel: 'position', kind: 'other' },
  match_y: { channel: 'position', kind: 'other' },
  scale: { channel: 'scale', kind: 'rel' },
  scale_to_fit_width: { channel: 'scale', kind: 'other' },
  scale_to_fit_height: { channel: 'scale', kind: 'other' },
  set_width: { channel: 'scale', kind: 'other' },
  set_height: { channel: 'scale', kind: 'other' },
  rotate: { channel: 'rotation', kind: 'rel' },
  set_opacity: { channel: 'opacity', kind: 'abs' },
  fade: { channel: 'opacity', kind: 'other' },
  set_color: { channel: 'color', kind: 'abs' },
  set_fill: { channel: 'color', kind: 'abs' },
  set_stroke: { channel: 'color', kind: 'abs' },
  set_value: { channel: 'value', kind: 'abs' },
  increment_value: { channel: 'value', kind: 'rel' },
};

/** One call of an `.animate` chain, with where its arguments are in the chain's source. */
interface ChainCall { name: string; args: string; at: number; argStart: number; argEnd: number; end: number }

function chainCalls(src: string): ChainCall[] | null {
  const out: ChainCall[] = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    const m = src.slice(i).match(/^\.([A-Za-z_]\w*)\s*\(/);
    if (!m) return null;
    const open = i + m[0].length - 1;
    const close = closing(src, open);
    if (close < 0) return null;
    out.push({ name: m[1], args: src.slice(open + 1, close), at: i, argStart: open + 1, argEnd: close, end: close + 1 });
    i = close + 1;
  }
  return out;
}

export interface Key {
  channel: Channel;
  anim: string; // the clip it is the end of
  call: number; // which call of its chain sets it (-1: the animation itself, as Rotate)
  method: string;
  start: number; // the clip's start and end (the keyframe)
  t: number;
  value?: KeyValue; // the channel's value at the keyframe (unknown: an expression, or not measured yet)
  editable: boolean; // its value can be set here (else its arguments can, as code: setKeyArgs)
  why?: string; // why its value can't be set here
  args: string; // the method's arguments as written (Rotate: its angle)
  relative?: boolean; // it places the object relative to something else (next_to, to_edge…): fixKey can pin it
  measuring?: boolean; // its value can be set once where it starts is measured
}

/** What a channel's value is made of before its first keyframe (the object as created). */
export function baseValue(obj: SceneObject, channel: Channel): KeyValue | undefined {
  if (channel === 'position') return obj.pos ? [obj.pos[0], obj.pos[1]] : undefined;
  if (channel === 'scale') return obj.scale ?? 1;
  if (channel === 'rotation') return obj.rotation ?? 0;
  if (channel === 'value') return evalNumber(obj.args['*'] ?? obj.args.value ?? '0') ?? undefined;
  if (channel === 'stroke') {
    const set = chainCalls(obj.chain ?? '')?.filter((c) => c.name === 'set_stroke' && widthArg(c)).pop();
    return evalNumber(set ? widthArg(set)!.src : obj.args.stroke_width ?? '') ?? undefined;
  }
  const call = chainCalls(obj.chain ?? '')?.filter((c) => METHODS[c.name]?.channel === channel && METHODS[c.name].kind === 'abs').pop();
  if (!call) return channel === 'opacity' ? undefined : obj.args.color?.trim() || undefined;
  return channel === 'opacity' ? evalNumber(splitTop(call.args)[0] ?? '') ?? undefined : colorArg(call)?.src;
}

/** The colour argument of set_color / set_fill / set_stroke: its source, and where it is in the call's arguments. */
function colorArg(call: ChainCall): { src: string; start: number; end: number } | undefined {
  const parts = splitWithSpans(call.args);
  const kw = parts.find((p) => /^color\s*=/.test(p.text));
  const pos = parts.find((p) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(p.text));
  const hit = kw ?? pos;
  if (!hit) return undefined;
  const off = kw ? hit.text.indexOf('=') + 1 : 0;
  if (hit.text.slice(off).trim() === 'None') return undefined;
  const lead = hit.text.slice(off).length - hit.text.slice(off).trimStart().length;
  return { src: hit.text.slice(off).trim(), start: hit.start + off + lead, end: hit.start + hit.text.trimEnd().length };
}

/** set_stroke's width: by keyword, else its second argument by position (set_stroke(color, width, opacity)). */
function widthArg(call: ChainCall): { src: string; start: number; end: number } | undefined {
  const parts = splitWithSpans(call.args);
  const kw = parts.find((p) => /^width\s*=/.test(p.text));
  const pos = parts.filter((p) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(p.text))[1];
  const hit = kw ?? pos;
  if (!hit) return undefined;
  const off = kw ? hit.text.indexOf('=') + 1 : 0;
  if (hit.text.slice(off).trim() === 'None') return undefined;
  const lead = hit.text.slice(off).length - hit.text.slice(off).trimStart().length;
  return { src: hit.text.slice(off).trim(), start: hit.start + off + lead, end: hit.start + hit.text.trimEnd().length };
}

/** Top-level comma-separated parts of `src`, with where each starts (leading spaces skipped). */
function splitWithSpans(src: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let pos = 0;
  for (const part of splitTop(src)) {
    const at = src.indexOf(part.trim(), pos);
    if (part.trim()) out.push({ text: part.trim(), start: at });
    pos = at + part.trim().length;
  }
  return out;
}

/** The first positional argument (or `kw=`), as source and where it is. */
function firstArg(args: string, kw?: string): { src: string; start: number; end: number } | undefined {
  const parts = splitWithSpans(args);
  const hit = (kw && parts.find((p) => new RegExp(`^${kw}\\s*=(?!=)`).test(p.text))) || parts.find((p) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(p.text));
  if (!hit) return undefined;
  const off = /^[A-Za-z_]\w*\s*=(?!=)/.test(hit.text) ? hit.text.indexOf('=') + 1 : 0;
  const rest = hit.text.slice(off);
  const lead = rest.length - rest.trimStart().length;
  return { src: rest.trim(), start: hit.start + off + lead, end: hit.start + hit.text.length };
}

const vec2 = (src: string): [number, number] | null => {
  const v = evalVector(src);
  return v ? [v[0] ?? 0, v[1] ?? 0] : null;
};

/** Rotate(obj, angle) or Rotate(obj, angle=…): the angle's source (manim's default is PI). */
function rotateAngle(a: Anim): string {
  return a.args.angle ?? (a.args['*'] ? splitTop(a.args['*'])[0]?.trim() : undefined) ?? 'PI';
}

const toDeg = (rad: number) => (rad * 180) / Math.PI;

type MeasuredClip = { from?: Record<string, unknown>; to?: Record<string, unknown>; curve?: number[] };
type Measured = Map<string, MeasuredClip>;

/** Only known endpoints are inferred without a render. Custom rate functions need manim's measurement. */
function endProgress(rate: string | undefined, curve: number[] | undefined): number | undefined {
  if (curve?.length) return curve[curve.length - 1];
  const name = (rate ?? 'smooth').trim().replace(/^rate_functions\./, '');
  if (['there_and_back', 'there_and_back_with_pause', 'wiggle'].includes(name)) return 0;
  if (['linear', 'smooth', 'smoothstep', 'smootherstep', 'rush_into', 'rush_from', 'slow_into', 'double_smooth',
    'running_start', 'lingering'].includes(name) || /^ease_(in_out|in|out)_(sine|quad|cubic|quart|quint|expo|circ|back|elastic|bounce)$/.test(name)) return 1;
  return undefined;
}

/**
 * The keyframes of `name` (an object's variable name), in time order, per channel. Values come from the code where it
 * says them (a literal), else from manim's measurement of the clip (when it is measured).
 */
export function keyframes(doc: SceneDoc, lay: Layout, measured: RunResult | null, name: string): Key[] {
  const obj = objectNamed(doc, name);
  const ms: Measured = new Map((measured?.anims ?? []).map((a) => [a.id, a as { from?: Record<string, unknown>; to?: Record<string, unknown> }]));
  const keys: Key[] = [];
  // the value each channel has after the keyframes so far (undefined: not known from the code)
  const cur: Partial<Record<Channel, KeyValue | undefined>> = {};
  for (const ch of CHANNELS) cur[ch.id] = obj ? baseValue(obj, ch.id) : undefined;
  /** The keyframes of one clip (an `.animate` or Rotate animation, or an apply step) that runs from `start` to `end`. */
  const read = (a: { id: string; cls?: string; chain?: string; args?: Args }, sp: { start: number; end: number }, m: MeasuredClip | undefined, nested: boolean, rate?: string) => {
    const state = (s: Record<string, unknown> | undefined, ch: Channel): KeyValue | undefined => {
      if (!s) return undefined;
      if (ch === 'position' && Array.isArray(s.center)) return [s.center[0] as number, s.center[1] as number];
      if (ch === 'opacity' && typeof s.opacity === 'number') return s.opacity;
      if (ch === 'value' && typeof s.value === 'number') return s.value;
      if (ch === 'stroke' && typeof s.stroke === 'number') return s.stroke;
      if (ch === 'scale' && obj === CAMERA && typeof s.width === 'number') return Number(fmtNum(s.width / frameWidth(doc)));
      if (ch === 'color' && typeof s.color === 'string') return JSON.stringify(s.color);
      return undefined;
    };
    // A measurement describes the whole clip's start, not the start of every call in its chain.
    for (const ch of CHANNELS) {
      const from = state(m?.from, ch.id);
      if (from !== undefined && (ch.id === 'position' || ch.id === 'value' || cur[ch.id] === undefined)) cur[ch.id] = from;
    }
    const start = { ...cur };
    const after = (ch: Channel) => state(m?.to, ch);
    const pending = new Map<Channel, Key>();
    const finish = () => {
      const progress = a.cls ? endProgress(rate ?? a.args?.rate_func, m?.curve) : 1;
      for (const key of pending.values()) {
        // A property has one endpoint per clip, even when several calls change it.
        if (progress !== undefined && Math.abs(progress - 1) < 1e-8) {
          if (key.channel !== 'color') key.value = after(key.channel) ?? key.value;
          if (key.channel === 'position') {
            const suffix = chainCalls(a.chain ?? '')?.slice(key.call + 1) ?? [];
            const safe = suffix.every((c) => {
              const channel = METHODS[c.name]?.channel;
              if (channel === 'stroke' || channel === 'color' || channel === 'opacity' || channel === 'value') return true;
              return ['scale', 'rotate'].includes(c.name) && !/\babout_(point|edge)\s*=|\*\*/.test(c.args);
            });
            if (!safe) {
              key.editable = false;
              key.relative = false;
              key.measuring = false;
              key.why = 'Later methods also transform its position; edit the method arguments below';
            }
          }
        } else {
          const returns = progress !== undefined && Math.abs(progress) < 1e-8;
          key.value = after(key.channel) ?? (returns ? start[key.channel] : undefined);
          key.editable = false;
          key.relative = false;
          key.measuring = progress === undefined && !m;
          key.why = returns ? 'This easing returns to the starting value; edit its target arguments below' :
            progress === undefined ? 'Measure this custom easing to find its ending value' :
              'This easing ends before or beyond its target; edit its target arguments below';
        }
        cur[key.channel] = key.value;
        keys.push(key);
      }
    };
    const push = (k: Omit<Key, 'start' | 't' | 'anim' | 'args'>, args: string) => {
      const key: Key = { ...k, args: args.trim(), anim: a.id, start: sp.start, t: sp.end };
      if (nested && key.editable) Object.assign(key, { editable: false, why: 'It is inside a group animation (LaggedStart, Succession…), so its timing is the group\'s' });
      pending.set(k.channel, key);
      cur[k.channel] = key.value;
    };
    if (a.cls === 'Rotate') {
      const deg = evalNumber(rotateAngle(a as Anim));
      const b = cur.rotation;
      push({
        channel: 'rotation', call: -1, method: 'Rotate',
        value: deg !== null && typeof b === 'number' ? b + toDeg(deg) : undefined,
        editable: deg !== null && typeof b === 'number', why: deg === null ? `The angle is an expression (${rotateAngle(a as Anim)})` : undefined,
      }, rotateAngle(a as Anim));
      finish();
      return;
    }
    const calls = chainCalls(a.chain ?? '');
    if (!calls) return;
    calls.forEach((c, i) => {
      if (c.name === 'set_stroke') {
        const w = widthArg(c);
        if (w) {
          const v = evalNumber(w.src);
          push({ channel: 'stroke', call: i, method: c.name, value: v ?? after('stroke'), editable: v !== null, why: v === null ? `The value is an expression (${w.src.slice(0, 40)})` : undefined }, c.args);
        }
        if (!colorArg(c)) return;
      }
      const info = METHODS[c.name];
      if (!info) return;
      const ch = info.channel;
      const expr = (src: string) => `The value is an expression (${src.trim().slice(0, 40)})`;
      let value: KeyValue | undefined;
      let editable = true;
      let why: string | undefined;
      let measuring = false;
      const arg = firstArg(c.args);
      if (info.kind === 'other') {
        value = after(ch);
        editable = false;
        why = `.${c.name}(…) places it relative to something else`;
      } else if (ch === 'position') {
        const p = arg ? vec2(arg.src) : null;
        const b = cur.position;
        if (info.kind === 'abs') value = p ?? after(ch);
        else if (info.kind === 'rel') value = p && Array.isArray(b) ? [b[0] + p[0], b[1] + p[1]] : after(ch);
        else {
          const n = arg ? evalNumber(arg.src) : null;
          value = n !== null && Array.isArray(b) ? (info.kind === 'x' ? [n, b[1]] : [b[0], n]) : after(ch);
        }
        if (info.kind === 'x' || info.kind === 'y' ? !arg || evalNumber(arg.src) === null : !p) [editable, why] = [false, expr(arg?.src ?? '')];
        else if (info.kind !== 'abs' && !Array.isArray(b)) [editable, why, measuring] = [false, 'Measuring where it starts…', true];
      } else if (ch === 'scale') {
        const k = arg ? evalNumber(arg.src) : null;
        const b = cur.scale;
        value = k !== null && typeof b === 'number' ? b * k : undefined;
        if (k === null) [editable, why] = [false, expr(arg?.src ?? '')];
        else if (typeof b !== 'number') [editable, why] = [false, 'An earlier scale is an expression, so its size here is not known'];
      } else if (ch === 'rotation') {
        const r = arg ? evalNumber(arg.src) : null;
        const b = cur.rotation;
        value = r !== null && typeof b === 'number' ? b + toDeg(r) : undefined;
        if (r === null) [editable, why] = [false, expr(arg?.src ?? '')];
        else if (typeof b !== 'number') [editable, why] = [false, 'An earlier rotation is an expression, so its angle here is not known'];
      } else if (ch === 'opacity') {
        const o = arg ? evalNumber(arg.src) : null;
        value = o ?? after(ch);
        if (o === null) [editable, why] = [false, expr(arg?.src ?? '')];
      } else if (ch === 'color') {
        const col = colorArg(c);
        value = col?.src ?? after(ch);
        if (!col) [editable, why] = [false, `.${c.name}(…) here doesn't set a colour`];
      } else if (ch === 'value') {
        const v = arg ? evalNumber(arg.src) : null;
        const b = cur.value;
        value = info.kind === 'abs' ? v ?? after(ch) : v !== null && typeof b === 'number' ? b + v : after(ch);
        if (v === null) [editable, why] = [false, expr(arg?.src ?? '')];
        else if (info.kind === 'rel' && typeof b !== 'number') [editable, why, measuring] = [false, 'Measuring where it starts…', true];
      }
      push({ channel: ch, call: i, method: c.name, value, editable, why, relative: info.kind === 'other' && ch === 'position', measuring }, c.args);
    });
    finish();
  };
  const stepsMeasured: Measured = new Map((measured?.steps ?? []).map((x) => [x.id, x as MeasuredClip]));
  let depth = 0; // inside a block (a loop, an if…): the keyframes there are edited by their method's arguments
  for (const s of doc.timeline) {
    const had = keys.length;
    depth += s.kind === 'block' && !isClause(s) ? 1 : s.kind === 'end' && depth > 0 ? -1 : 0;
    visit(s);
    if (depth > 0) for (const k of keys.slice(had)) if (k.editable) Object.assign(k, { editable: false, why: 'It is inside a block that can run several times (a loop, an if…): edit it by its method’s arguments' });
  }
  return keys;

  function visit(s: Step) {
    if (s.disabled) return;
    if (s.kind === 'apply') {
      // methods called on it at once: a keyframe with no time before it (a jump)
      const sp = lay.steps.get(s.id);
      if (sp && s.target === name) read({ id: s.id, chain: s.chain }, sp, isMeasured(s, measured) ? stepsMeasured.get(s.id) : undefined, false);
      return;
    }
    if (s.kind !== 'play') return;
    const stepMeasured = isMeasured(s, measured);
    for (const top of s.anims ?? []) {
      for (const a of walk([top])) {
        if (a.disabled || a.anims || a.target !== name) continue;
        const sp = lay.anims.get(a.id);
        if (!sp) continue;
        const nested = a !== top;
        if (a.cls === 'Rotate' || a.cls === 'animate') read(a, sp, stepMeasured && !nested ? ms.get(a.id) : undefined, nested, s.args?.rate_func);
      }
    }
  }
}

/** Which channels an object has: a ValueTracker has a value; anything else is drawn. */
export function channelsOf(obj: SceneObject): Channel[] {
  if (obj === CAMERA) return ['position', 'scale'];
  return obj.ctor === 'ValueTracker' || obj.ctor === 'ComplexValueTracker' ? ['value'] : ['position', 'scale', 'rotation', 'opacity', 'color', 'stroke'];
}

/** The channel's value just before time `t` (its last keyframe at or before `t`, else as created). */
export function valueBefore(keys: Key[], obj: SceneObject, channel: Channel, t: number): KeyValue | undefined {
  const k = keys.filter((x) => x.channel === channel && x.t <= t + EPS).pop();
  return k ? k.value : baseValue(obj, channel);
}

// ---------------------------------------------------------------------------- writing values as code

const num = (v: number) => fmtNum(v);

/** A point written the way `like` was: np.array([…]), […], or direction constants (`RIGHT * 2 + UP`). */
function pointSrc(p: [number, number], like: string, z = 0): string {
  const t = like.trim();
  const xs = [num(p[0]), num(p[1]), num(z)];
  if (t.startsWith('np.array(')) return `np.array([${xs.join(', ')}])`;
  if (t.startsWith('[') || t.startsWith('(')) return t.startsWith('[') ? `[${xs.join(', ')}]` : `(${xs.join(', ')})`;
  const term = (v: number, pos: string, neg: string) => {
    const r = Math.round(v * 1000) / 1000;
    if (!r) return '';
    const name = r > 0 ? pos : neg;
    return Math.abs(r) === 1 ? name : `${name} * ${num(Math.abs(r))}`;
  };
  const parts = [term(p[0], 'RIGHT', 'LEFT'), term(p[1], 'UP', 'DOWN')].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'ORIGIN';
}

/** An angle in degrees, the way manim code writes one. */
function angleSrc(deg: number, like: string): string {
  const r = Math.round(deg * 1000) / 1000;
  if (/\bPI\b|\bTAU\b/.test(like) && !/DEGREES/.test(like)) {
    for (const d of [1, 2, 3, 4, 6, 8, 12]) {
      const n = (r * d) / 180;
      if (Math.abs(n - Math.round(n)) < 1e-9 && Math.round(n) !== 0) {
        const k = Math.round(n);
        const top = k === 1 ? 'PI' : k === -1 ? '-PI' : `${k} * PI`;
        return d === 1 ? top : `${top} / ${d}`;
      }
    }
  }
  return `${num(r)} * DEGREES`;
}

const same = (a: KeyValue | undefined, b: KeyValue): boolean => {
  if (a === undefined) return false;
  if (typeof a === 'string' || typeof b === 'string') return String(a).trim() === String(b).trim();
  if (Array.isArray(a) && Array.isArray(b)) return Math.abs(a[0] - b[0]) < 5e-4 && Math.abs(a[1] - b[1]) < 5e-4;
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 5e-4;
};

const splice = (src: string, start: number, end: number, text: string) => src.slice(0, start) + text + src.slice(end);

/** Change an object's chain, and its line of the code with it (the lines stay as the code had them). */
function spliceChain(obj: SceneObject, start: number, end: number, text: string) {
  const chain = obj.chain ?? '';
  const layout = obj.chain_layout;
  obj.chain = splice(chain, start, end, text);
  if (!layout || layout.join('') !== chain) return;
  let at = 0;
  for (let i = 0; i < layout.length; i++) {
    const last = i === layout.length - 1;
    if (start >= at && (end <= at + layout[i].length) && (start < at + layout[i].length || last)) {
      obj.chain_layout = layout.map((p, k) => (k === i ? splice(p, start - at, end - at, text) : p));
      return;
    }
    at += layout[i].length;
  }
}

/**
 * Set a keyframe's value: rewrite only the argument of the method that sets it, in the style it was written in. A
 * value it already has changes nothing. Returns why not, when it can't.
 */
export function setKeyValue(d: SceneDoc, _lay: Layout, _measured: RunResult | null, key: Key, value: KeyValue): string | null {
  if (!key.editable) return key.why ?? 'This keyframe can only be edited in the code';
  if (same(key.value, value)) return null;
  const a = clipOf(d, key.anim);
  if (!a) return 'Its clip is gone';
  if (key.method === 'Rotate' && 'cls' in a) {
    const angle = evalNumber(rotateAngle(a));
    if (angle === null || typeof key.value !== 'number' || typeof value !== 'number') return 'Its angle before this is not known';
    setAngle(a, angleSrc(toDeg(angle) + value - key.value, rotateAngle(a)));
    return null;
  }
  const chain = a.chain ?? '';
  const call = chainCalls(chain)?.[key.call];
  if (!call || call.name !== key.method) return 'The clip changed: try again';
  const info = METHODS[call.name];
  const arg = firstArg(call.args);
  const at = (span: { start: number; end: number }, text: string) => {
    a.chain = splice(chain, call.argStart + span.start, call.argStart + span.end, text);
    return null;
  };
  if (key.channel === 'color') {
    const col = colorArg(call);
    return col && typeof value === 'string' ? at(col, value.trim()) : 'Not a colour';
  }
  if (key.channel === 'stroke') {
    const w = widthArg(call);
    return w && typeof value === 'number' ? at(w, num(Math.max(0, value))) : 'Not a width';
  }
  if (!arg) return 'Its value is missing';
  if (key.channel === 'position' && Array.isArray(value)) {
    if (!Array.isArray(key.value)) return 'Where it ends is not measured yet';
    if (info.kind === 'x' || info.kind === 'y') {
      const axis = info.kind === 'x' ? 0 : 1;
      if (Math.abs(value[1 - axis] - key.value[1 - axis]) > EPS) return `This method only sets ${info.kind}; edit the other coordinate with another method`;
      const old = evalNumber(arg.src);
      return old === null ? 'Its coordinate is an expression' : at(arg, num(old + value[axis] - key.value[axis]));
    }
    const p = vec2(arg.src);
    if (!p) return 'Its point is an expression';
    return at(arg, pointSrc([p[0] + value[0] - key.value[0], p[1] + value[1] - key.value[1]], arg.src, evalVector(arg.src)?.[2] ?? 0));
  }
  if (typeof value !== 'number') return 'Not a number';
  if (key.channel === 'scale') {
    const old = evalNumber(arg.src);
    if (old === null || typeof key.value !== 'number' || !key.value) return 'Its size before this is not known';
    return at(arg, num(old * value / key.value));
  }
  if (key.channel === 'rotation') {
    const old = evalNumber(arg.src);
    if (old === null || typeof key.value !== 'number') return 'Its angle before this is not known';
    return at(arg, angleSrc(toDeg(old) + value - key.value, arg.src));
  }
  if (key.channel === 'opacity') return at(arg, num(Math.max(0, Math.min(1, value))));
  if (key.channel === 'value') {
    if (info.kind === 'abs') return at(arg, num(value));
    const old = evalNumber(arg.src);
    if (old === null || typeof key.value !== 'number') return 'Its value before this is not measured yet';
    return at(arg, num(old + value - key.value));
  }
  return 'Not editable';
}

/** Rotate's angle, where the code gives it (by keyword or first by position). */
function setAngle(a: Anim, src: string) {
  if (a.args.angle !== undefined) a.args = { ...a.args, angle: src };
  else if (a.args['*']) {
    const parts = splitTop(a.args['*']);
    parts[0] = src;
    a.args = { ...a.args, '*': parts.map((p) => p.trim()).join(', ') };
  } else a.args = { ...a.args, angle: src };
}

/**
 * Set a keyframe's method arguments as code (`g, UP, buff=0.5`; Rotate: its angle): for a keyframe whose value is an
 * expression or relative to something else, this is how it is edited. Only that call changes.
 */
export function setKeyArgs(d: SceneDoc, key: Key, text: string): string | null {
  const a = clipOf(d, key.anim);
  if (!a) return 'Its clip is gone';
  const t = text.trim();
  if (t === key.args) return null;
  const one = chainCalls(`.${key.method}(${t})`);
  if (!one || one.length !== 1 || one[0].args !== t) return "Its brackets or quotes don't match";
  if (key.call < 0) {
    if (!('cls' in a) || a.cls !== 'Rotate') return 'The clip changed: try again';
    if (!t) return 'Rotate needs an angle';
    setAngle(a, t);
    return null;
  }
  const chain = a.chain ?? '';
  const call = chainCalls(chain)?.[key.call];
  if (!call || call.name !== key.method) return 'The clip changed: try again';
  a.chain = splice(chain, call.argStart, call.argEnd, t);
  return null;
}

/**
 * Pin a relative keyframe (`.next_to(g, UP)`, `.to_edge(LEFT)`…) where it puts the object now: its call becomes
 * `.move_to(…)` at that point, and the object no longer follows what it was placed by.
 */
export function fixKey(d: SceneDoc, key: Key): string | null {
  if (!key.relative) return 'It is not placed relative to something';
  if (!Array.isArray(key.value)) return 'Where it ends up is not measured yet';
  const a = clipOf(d, key.anim);
  if (!a) return 'Its clip is gone';
  const chain = a.chain ?? '';
  const call = chainCalls(chain)?.[key.call];
  if (!call || call.name !== key.method) return 'The clip changed: try again';
  a.chain = splice(chain, call.at, call.end, `.move_to(${pointSrc(key.value, '')})`);
  return null;
}

/** Remove all writers of a channel's endpoint; an empty clip keeps its time as a pause. */
export function deleteKey(d: SceneDoc, lay: Layout, key: Key): string | null {
  const a = clipOf(d, key.anim);
  if (!a) return 'Its clip is gone';
  if (key.call >= 0) {
    const calls = chainCalls(a.chain ?? '');
    const call = calls?.[key.call];
    if (!calls || !call || call.name !== key.method) return 'The clip changed: try again';
    const chain = calls.reduceRight((src, c) => {
      const writes = key.channel === 'stroke' ? c.name === 'set_stroke' && !!widthArg(c)
        : METHODS[c.name]?.channel === key.channel && (c.name !== 'set_stroke' || !!colorArg(c));
      if (!writes) return src;
      // One set_stroke call can set colour, width and opacity. None leaves
      // just this property unchanged, keeping the other arguments in place.
      if (c.name === 'set_stroke') {
        const span = (key.channel === 'stroke' ? widthArg(c) : colorArg(c))!;
        const others = splitWithSpans(c.args).filter((p) => !(p.start <= span.start && p.start + p.text.length >= span.end));
        if (others.some((p) => p.text.replace(/^[A-Za-z_]\w*\s*=(?!=)/, '').trim() !== 'None'))
          return splice(src, c.argStart + span.start, c.argStart + span.end, 'None');
      }
      return splice(src, c.at, c.end, '');
    }, a.chain ?? '').trimStart();
    if (chain) {
      a.chain = chain;
      return null;
    }
  }
  removeIds(d, lay, new Set([a.id]), 'lift');
  return null;
}

/** What holds a keyframe's method: an animation, or an apply step (methods called at once). */
function clipOf(d: SceneDoc, id: string): Anim | Step | undefined {
  const step = d.timeline.find((s) => s.id === id);
  return step?.kind === 'apply' ? step : findAnim(d, id)?.anim;
}

/** The clip a new keyframe makes: `.animate` with the method that sets the channel (Rotate for rotation). */
function keyClip(obj: SceneObject, channel: Channel, value: KeyValue, before: KeyValue | undefined): Anim | string {
  const a = newAnim('animate', obj.name);
  if (channel === 'position' && Array.isArray(value)) a.chain = `.move_to(${pointSrc(value, 'np.array(')})`;
  else if (channel === 'scale' && typeof value === 'number') {
    if (typeof before !== 'number' || !before) return 'Its size here is not known';
    a.chain = `.scale(${num(value / before)})`;
  } else if (channel === 'rotation' && typeof value === 'number') {
    if (typeof before !== 'number') return 'Its angle here is not known';
    return { ...newAnim('Rotate', obj.name), args: { angle: angleSrc(value - before, '') } };
  } else if (channel === 'opacity' && typeof value === 'number') a.chain = `.set_opacity(${num(value)})`;
  else if (channel === 'color' && typeof value === 'string') a.chain = `.set_color(${value.trim()})`;
  else if (channel === 'stroke' && typeof value === 'number') a.chain = `.set_stroke(width=${num(Math.max(0, value))})`;
  else if (channel === 'value' && typeof value === 'number') a.chain = `.set_value(${num(value)})`;
  else return 'Not a value for this';
  return a;
}

/**
 * Add a keyframe at time `t`: a clip that ends at `t`, taking the channel from where it is to `value`. Inside a
 * self.play it joins it (starting with it); inside a pause it takes up to a second of it; past the end it comes after
 * a pause. Returns the new clip's id, or why it can't.
 */
export function addKey(d: SceneDoc, measured: RunResult | null, objName: string, channel: Channel, t: number, value: KeyValue, length = 1): { id: string } | { error: string } {
  const obj = objectNamed(d, objName);
  if (!obj) return { error: 'No such object' };
  if (t <= EPS) return { error: 'A keyframe at the very start has nothing to animate from: set the value as created instead, or move the playhead later' };
  const lay = layout(d, measured);
  const keys = keyframes(d, lay, measured, objName);
  if (keys.some((k) => k.channel === channel && Math.abs(k.t - t) < EPS)) return { error: 'There is a keyframe here already' };
  const host = d.timeline.find((s) => {
    const sp = lay.steps.get(s.id);
    return !s.disabled && sp && sp.end - sp.start > EPS && sp.start < t - EPS && t <= sp.end + EPS;
  });
  const start = host ? lay.steps.get(host.id)!.start : Math.max(lay.end, t - length);
  const clip = keyClip(obj, channel, value, valueBefore(keys, obj, channel, start));
  if (typeof clip === 'string') return { error: clip };
  let playId: string;
  if (host?.kind === 'play') {
    // two animations of one object in one self.play fight over it (manim plays the last one): not that
    const busy = (host.anims ?? []).flatMap((x) => [...walk([x])]).find((x) => !x.disabled && x.target === objName);
    if (busy) return { error: `${objName} is already animated in this Play together group (${busy.cls === 'animate' ? `.animate${(busy.chain ?? '').trim().match(/^\.\w+/)?.[0] ?? ''}` : busy.cls}), and manim plays only one animation of an object at a time: edit that keyframe, or put the playhead in a pause` };
    host.anims = [...(host.anims ?? []), clip];
    setAnimDuration(d, clip.id, t - start);
    playId = host.id;
  } else if (host) {
    const land = landing(d, lay, Math.max(lay.steps.get(host.id)!.start, t - length), false);
    if (land.kind !== 'split') return { error: `A keyframe can't go inside this step (${host.kind}): move the playhead to a pause or a Play together group` };
    const play = playStep([clip], runTime(t - land.time));
    placeSteps(d, lay, land, [play], t - land.time);
    playId = play.id;
  } else {
    if (start > lay.end + EPS) d.timeline.push(waitStep(start - lay.end));
    const play = playStep([clip], runTime(t - start));
    d.timeline.push(play);
    playId = play.id;
  }
  ensureDefined(d, playId);
  return { id: clip.id };
}

const runTime = (s: number): Args => (Math.abs(s - 1) < 1e-6 ? {} : { run_time: numSrc(s) });

/** Change the value as created (no keyframes): the object's position, scale, rotation, opacity, colour or start value. */
export function setBaseValue(obj: SceneObject, channel: Channel, value: KeyValue) {
  if (channel === 'position' && Array.isArray(value)) obj.pos = [Math.round(value[0] * 1000) / 1000, Math.round(value[1] * 1000) / 1000];
  else if (channel === 'scale' && typeof value === 'number') obj.scale = Math.round(value * 1000) / 1000;
  else if (channel === 'rotation' && typeof value === 'number') obj.rotation = Math.round(value * 1000) / 1000;
  else if (channel === 'value' && typeof value === 'number') {
    // where the code gives it: ValueTracker(3) or ValueTracker(value=3) (both would pass it twice)
    const k = obj.args['*'] === undefined && obj.args.value !== undefined ? 'value' : '*';
    obj.args = { ...obj.args, [k]: num(value) };
  }
  else if (channel === 'stroke' && typeof value === 'number') {
    const call = chainCalls(obj.chain ?? '')?.filter((c) => c.name === 'set_stroke' && widthArg(c)).pop();
    const w = call && widthArg(call);
    if (call && w) spliceChain(obj, call.argStart + w.start, call.argStart + w.end, num(Math.max(0, value)));
    else obj.args = { ...obj.args, stroke_width: num(Math.max(0, value)) };
  }
  else if (channel === 'opacity' || channel === 'color') {
    const method = channel === 'opacity' ? 'set_opacity' : 'set_color';
    const text = channel === 'opacity' ? num(Number(value)) : String(value).trim();
    const chain = obj.chain ?? '';
    const call = chainCalls(chain)?.filter((c) => c.name === method).pop();
    if (call) spliceChain(obj, call.argStart, call.argEnd, text);
    else if (channel === 'color' && obj.args.color !== undefined) obj.args = { ...obj.args, color: text };
    else spliceChain(obj, chain.length, chain.length, `.${method}(${text})`);
  }
}
