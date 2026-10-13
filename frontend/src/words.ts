// The timeline's names for clips, in words rather than code: “title · Fade in”, “Repeat, k = 1 to 6”, “Show axes”.
// What each animation, method, statement and loop is called comes from a phrasebook (phrases.json, the defaults,
// plus what the user changed with Change wording…); a name missing from it is read from the code itself, so
// GrowFromCenter is “Grow from center” and set_fill is “set fill”. Nothing here needs the store: it is pure, for tests.

import DEFAULTS from './phrases.json';
import { parseArgs, parseChain, pyString, splitTop } from './pyparse';
import type { Anim, Step } from './types';

export type Section = 'animations' | 'methods' | 'statements' | 'blocks' | 'patterns' | 'updaters';
export const SECTIONS: Section[] = ['animations', 'methods', 'statements', 'blocks', 'patterns', 'updaters'];
export type Overrides = Partial<Record<Section, Record<string, string>>>;
type Book = Record<Section, Record<string, string>> & { lists: Record<string, Record<string, string>> };

/** One entry a clip's name uses: where it is in the phrasebook, and what it means. */
export interface PhraseKey { section: Section; key: string; what: string }
export interface Words { name: string; sub: string; keys: PhraseKey[] }

let overrides: Overrides = {};
let constants = new Set<string>(); // manim's colors and directions: RED reads “red”, but a list called ZEROS stays ZEROS

export function setOverrides(o: Overrides) {
  overrides = o ?? {};
}
export const getOverrides = () => overrides;
export function setConstants(names: Iterable<string>) {
  constants = new Set(names);
}

export function book(extra: Overrides = overrides): Book {
  const d = DEFAULTS as unknown as Book;
  const out = { lists: d.lists } as Book;
  for (const s of SECTIONS) out[s] = { ...d[s], ...(extra[s] ?? {}) };
  return out;
}

/** The default wording of an entry (null: read from the code). */
export const defaultPhrase = (section: Section, key: string): string | null => (DEFAULTS as unknown as Book)[section][key] ?? null;

// ------------------------------------------------------------------------------------------------ values in words

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** GrowFromCenter -> “Grow from center”; set_fill -> “set fill”. */
export function nameWords(name: string): string {
  const words = name.replace(/^self\./, '').replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim();
  return words.split(/\s+/).map((w, i) => (i && /^[A-Z][a-z]/.test(w) ? w.toLowerCase() : w)).join(' ');
}

/**
 * A value as it reads: “Hello” for "Hello", π for PI, 90° for 90 * DEGREES, red for RED, ZEROS[k] for the
 * ZEROS[int(k) - 1] math writes, t for t.get_value(); long code is cut short.
 */
export function pretty(value: string, b: Book = book()): string {
  let v = (value ?? '').trim();
  if (!v) return '';
  const str = pyString(v);
  if (str !== null) return `“${str}”`;
  if (b.lists.words[v]) return b.lists.words[v];
  v = v
    .replace(/\.get_value\(\)/g, '')
    .replace(/\b\w+\.i2gp\(([^()]+?),\s*(\w+)\)/g, '$2 at $1')
    .replace(/\b(\w+)\.c2p\(([^()]*)\)/g, '($2) on $1')
    .replace(/\b(\w+)\.get_center\(\)/g, '$1')
    .replace(/\b(\w+)\.get_(top|bottom|left|right|start|end)\(\)/g, '$2 of $1')
    .replace(/\bnp\.pi\b/g, 'PI')
    .replace(/\bnp\.(\w+)/g, '$1')
    .replace(/\*\*/g, '^')
    .replace(/(\w+)\[int\((.+?)\) - 1\]/g, '$1[$2]')
    .replace(/(\d+(?:\.\d+)?)\s*\*\s*DEGREES\b/g, '$1°')
    .replace(/\b([A-Z][A-Z0-9_]*)\s*\*\s*(\d+(?:\.\d+)?)\b/g, (m, c, n) => (b.lists.words[c] || constants.has(c) ? `${c} ${n}` : m))
    .replace(/\b(\d+(?:\.\d+)?)\s*\*\s*([A-Z][A-Z0-9_]*)\b/g, (m, n, c) => (b.lists.words[c] || constants.has(c) ? `${c} ${n}` : m))
    .replace(/(?<![\w.])([A-Za-z_][\w.]*)/g, (w) => b.lists.words[w] ?? (constants.has(w) ? w.toLowerCase().replace(/_/g, ' ') : w));
  return v.length > 28 ? v.slice(0, 27) + '…' : v;
}

/** A condition as it reads: x ≤ 3 and not done. */
const cond = (c: string, b: Book) =>
  pretty(c.replace(/\s*==\s*/g, ' = ').replace(/\s*!=\s*/g, ' ≠ ').replace(/\s*<=\s*/g, ' ≤ ').replace(/\s*>=\s*/g, ' ≥ ').replace(/\s+%\s+/g, ' mod '), b);

// ------------------------------------------------------------------------------------------------ templates

export interface Args { pos: string[]; kw: Record<string, string>; named?: Record<string, string> }

/**
 * Fill a template. {1}: the first argument; {angle}: the one called angle; {1|angle}: whichever is given;
 * {1:side}: looked up in the list “side” (UP is “above”); {2:side=RIGHT}: RIGHT when not given. A missing value is
 * left out, with its spare space or comma.
 */
export function fill(template: string, args: Args, b: Book = book()): string {
  const out = template.replace(/\{([^{}:=]+)(?::(\w+))?(?:=([^{}]*))?\}/g, (_, alts: string, list?: string, dflt?: string) => {
    let raw: string | undefined;
    for (const a of alts.split('|').map((x) => x.trim())) {
      raw = /^\d+$/.test(a) ? args.pos[+a - 1] : args.named?.[a] ?? args.kw[a];
      if (raw !== undefined && raw !== '') break;
    }
    if (raw === undefined || raw === '') raw = dflt;
    if (raw === undefined || raw === '') return '';
    if (args.named && alts.split('|').some((a) => args.named![a.trim()] !== undefined)) return raw; // already words
    if (list) {
      const l = b.lists[list] ?? {};
      const r = raw.trim();
      if (l[r]) return l[r];
      const m = r.match(/^([A-Z][A-Z0-9_]*)\s*\*\s*(.+)$/) ?? r.match(/^(.+?)\s*\*\s*([A-Z][A-Z0-9_]*)$/)?.slice(0, 3).reverse();
      if (m && l[m[1]]) return `${l[m[1]]} ${pretty(m[2], b)}`;
    }
    return pretty(raw, b);
  });
  return out.replace(/\s+/g, ' ').replace(/\s+([,.)])/g, '$1').replace(/^[\s,]+|[\s,]+$/g, '').replace(/\(\s*\)/g, '');
}

/** An entry of the phrasebook, or the code's own name in words with its first short argument. */
function phrase(b: Book, section: Section, key: string, args: Args, fallback = nameWords(key)): string {
  const t = b[section][key];
  if (t !== undefined) return fill(t, args, b);
  const first = args.pos[0];
  return first && first.length <= 16 ? `${fallback} ${pretty(first, b)}` : fallback;
}

const argsOf = (src: string): Args => {
  const { pos, kw } = parseArgs(src);
  return { pos, kw: Object.fromEntries(kw) };
};

/** An animation's own arguments (after the object it plays on). */
function animArgs(a: Anim): Args {
  const kw: Record<string, string> = { ...a.args };
  delete kw['*'];
  const pos = (a.positional ?? []).map((p) => a.args[p] ?? '').concat(a.args['*'] ? splitTop(a.args['*']) : []);
  return { pos, kw };
}

/** A method chain in words: “scale ×0.55, to the top edge”. */
export function chainWords(chain: string, b: Book = book()): { text: string; keys: PhraseKey[] } {
  const calls = parseChain((chain ?? '').trim()) ?? [];
  const keys = calls.map((c) => ({ section: 'methods' as const, key: c.name, what: `.${c.name}(…)` }));
  return { text: calls.map((c) => phrase(b, 'methods', c.name, argsOf(c.args))).join(', '), keys };
}

// ------------------------------------------------------------------------------------------------ clips

/** An expression animation by its shape: *[FadeOut(m) for m in self.mobjects if m is not title] is “Fade out all but title”. */
function exprWords(src: string, b: Book): Words {
  const s = src.replace(/\s+/g, ' ').trim();
  const comp = s.match(/^\*?\[\s*([A-Z]\w*)\((\w+)[^\]]*?\) for (\w+) in ([\w.[\]()]+)(.*)\]$/);
  if (comp) {
    const [, cls, , , iter, rest] = comp;
    const anim = phrase(b, 'animations', cls, { pos: [], kw: {} });
    const keep = rest.match(/\bis not (\w+)/)?.[1];
    const keys: PhraseKey[] = [{ section: 'animations', key: cls, what: `${cls} animations` }];
    if (keep && iter === 'self.mobjects')
      return { name: cap(fill(b.patterns.allBut, { pos: [], kw: {}, named: { anim: anim.toLowerCase(), keep } }, b)), sub: '', keys: [...keys, { section: 'patterns', key: 'allBut', what: 'Fade out the rest' }] };
    if (iter === 'self.mobjects' && !rest.trim())
      return { name: cap(fill(b.patterns.everything, { pos: [], kw: {}, named: { anim: anim.toLowerCase() } }, b)), sub: '', keys: [...keys, { section: 'patterns', key: 'everything', what: 'Everything on screen' }] };
    return { name: cap(fill(b.patterns.each, { pos: [], kw: {}, named: { anim: anim.toLowerCase(), iter: pretty(iter, b) } }, b)), sub: '', keys: [...keys, { section: 'patterns', key: 'each', what: 'One for each item' }] };
  }
  const call = s.match(/^([A-Z]\w*)\s*\((.*)\)$/);
  if (call) {
    const parts = argsOf(call[2]);
    const target = parts.pos.shift() ?? '';
    return { name: target && /^[\w.[\]]+$/.test(target) ? target : cap(phrase(b, 'animations', call[1], parts)), sub: target && /^[\w.[\]]+$/.test(target) ? cap(phrase(b, 'animations', call[1], parts)) : '', keys: [{ section: 'animations', key: call[1], what: `${call[1]} animations` }] };
  }
  const cls = s.match(/([A-Z]\w*)\s*\(/)?.[1];
  return cls ? { name: cap(phrase(b, 'animations', cls, { pos: [], kw: {} })), sub: '', keys: [{ section: 'animations', key: cls, what: `${cls} animations` }] } : { name: b.statements.code ?? 'Code', sub: '', keys: [{ section: 'statements', key: 'code', what: 'Code' }] };
}

/** What a clip shows: its object, then what happens to it (“title”, “Fade in”). */
export function animWords(a: Anim, b: Book = book()): Words {
  if (a.cls === 'expr') return exprWords(a.src ?? '', b);
  if (a.anims) {
    const n = a.anims.length;
    return { name: cap(phrase(b, 'animations', a.cls, animArgs(a))), sub: `${n} animation${n === 1 ? '' : 's'}`, keys: [{ section: 'animations', key: a.cls, what: `${a.cls} groups` }] };
  }
  if (a.cls === 'animate') {
    const c = chainWords(a.chain ?? '', b);
    return { name: a.target, sub: cap(c.text), keys: c.keys };
  }
  const text = cap(phrase(b, 'animations', a.cls, animArgs(a)));
  const keys: PhraseKey[] = [{ section: 'animations', key: a.cls, what: `${a.cls} animations` }];
  return a.target ? { name: a.target, sub: text, keys } : { name: text, sub: '', keys };
}

const ASSIGN_OPS: Record<string, string> = { '=': 'assign', '+=': 'increase', '-=': 'decrease', '*=': 'multiply', '/=': 'divide' };

const ROLE_WORDS: Record<string, string> = { add: 'Showing objects (self.add)', remove: 'Removing objects (self.remove)', couple: 'Coupling again', uncouple: 'Uncoupling' };

/** self.play(a.animate.shift(UP), Circumscribe(dot)) written as code, in words: “a move up, circle around dot”. */
function playWords(code: string, b: Book): string | null {
  const m = code.match(/^self\.play\((.*)\)$/);
  if (!m) return null;
  const parts = splitTop(m[1]).filter((p) => p && !/^\w+\s*=(?!=)/.test(p));
  const said = parts.map((p) => {
    const anim = p.match(/^([\w.[\]]+)\.animate((?:\.\w+\(.*\))+)$/);
    if (anim) return `${anim[1]} ${chainWords(anim[2], b).text}`;
    const w = exprWords(p, b);
    return [w.name, w.sub.toLowerCase()].filter(Boolean).join(' ');
  });
  return said.length ? said.join(', ') : null;
}

/** What a statement on the timeline shows. */
export function stepWords(s: Step, b: Book = book(), runs?: number): Words {
  const targets = (s.targets ?? []).join(', ');
  const st = (key: string, named: Record<string, string> = {}): string => fill(b.statements[key] ?? cap(nameWords(key)), { pos: [], kw: {}, named }, b);
  const key = (k: string, what: string): PhraseKey[] => [{ section: 'statements', key: k, what }];
  switch (s.kind) {
    case 'play': {
      const n = s.anims?.length ?? 0;
      return { name: st('play'), sub: `${n} animation${n === 1 ? '' : 's'}${s.disabled ? ' (disabled)' : ''}`, keys: key('play', 'Animations played together') };
    }
    case 'wait':
      return { name: st('wait'), sub: s.args?.duration ? `${s.args.duration}s` : '1s', keys: key('wait', 'Pauses') };
    case 'add':
    case 'remove':
    case 'couple':
    case 'uncouple':
      return { name: st(s.kind), sub: targets, keys: key(s.kind, ROLE_WORDS[s.kind]) };
    case 'apply': {
      const c = chainWords(s.chain ?? '', b);
      return { name: s.target ?? '', sub: cap(c.text), keys: c.keys };
    }
    case 'assign': {
      const value = (s.value ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
      const k = ASSIGN_OPS[s.op ?? '='] ?? 'assign';
      return { name: s.target ?? '', sub: st(k, { value: pretty(value, b) }), keys: key(k, k === 'assign' ? 'Setting a value' : `Values changed with ${s.op}`) };
    }
    case 'call': {
      const k = `self.${s.method}`;
      const args: Args = { pos: s.args?.['*'] ? splitTop(s.args['*']) : [], kw: Object.fromEntries(Object.entries(s.args ?? {}).filter(([n]) => n !== '*')) };
      return { name: cap(phrase(b, 'statements', k, args, nameWords(s.method ?? ''))), sub: '', keys: key(k, `self.${s.method}(…)`) };
    }
    case 'code': {
      const lines = (s.code ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      const note = lines.find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '');
      const code = lines.filter((l) => !l.startsWith('#'));
      return { name: s.label || note || st('code'), sub: playWords(code.join(' '), b) ?? code[0] ?? '', keys: key('code', 'Code') };
    }
    case 'end':
      return { name: st('end'), sub: '', keys: key('end', 'The end of a block') };
    case 'block':
      return blockWords(s, runs, b);
    default:
      return { name: cap(nameWords(s.kind)), sub: targets, keys: [] };
  }
}

/** A loop or condition: “Repeat, k = 1 to 6” “6 times”; “If x > 2”; “Otherwise”. */
export function blockWords(s: Step, runs?: number, b: Book = book()): Words {
  const head = (s.head ?? '').trim().replace(/:$/, '') || 'if True';
  const bl = (k: string, named: Record<string, string>) => ({ text: fill(b.blocks[k] ?? k, { pos: [], kw: {}, named }, b), keys: [{ section: 'blocks' as const, key: k, what: BLOCK_WHAT[k] ?? k }] });
  let r: { text: string; keys: PhraseKey[] };
  const rep = s.repeat;
  let m: RegExpMatchArray | null;
  if (rep && rep.each !== undefined) r = bl('each', { var: rep.var, each: rep.each });
  else if (rep) r = bl('repeat', { var: rep.var, from: rep.from ?? '1', to: rep.to ?? '1' });
  else if ((m = head.match(/^for (\w+) in range\((.*)\)$/))) {
    const ends = splitTop(m[2]);
    if (ends.length === 1 && /^\d+$/.test(ends[0])) r = bl('times', { n: ends[0] });
    else if (ends.length === 1) r = bl('repeat', { var: m[1], from: '0', to: `${pretty(ends[0], b)} − 1` });
    else if (/^-?\d+$/.test(ends[0]) && /^-?\d+$/.test(ends[1] ?? '')) r = bl('repeat', { var: m[1], from: ends[0], to: String(+ends[1] - 1) });
    else r = bl('repeat', { var: m[1], from: pretty(ends[0], b), to: `${pretty(ends[1] ?? '', b)} − 1` });
  } else if ((m = head.match(/^for (?:\w+, *)?(\w+) in enumerate\((.*)\)$/)) || (m = head.match(/^for ([\w, ]+) in (.*)$/)))
    r = bl('for', { var: m[1].trim(), iter: pretty(m[2], b) });
  else if ((m = head.match(/^(while|if|elif) (.*)$/))) r = bl(m[1], { cond: cond(m[2], b) });
  else if ((m = head.match(/^with (.*)$/))) r = bl('with', { expr: pretty(m[1], b) });
  else if ((m = head.match(/^(else|try|finally|except)\b/))) r = bl(m[1], {});
  else r = { text: head, keys: [] };
  const sub = runs === undefined ? '' : runs === 0 ? b.blocks.never : runs === 1 ? b.blocks.once : fill(b.blocks.ran, { pos: [], kw: {}, named: { n: String(runs) } }, b);
  return { name: cap(r.text), sub, keys: r.keys };
}

const BLOCK_WHAT: Record<string, string> = {
  repeat: 'Loops with a counter', each: 'Loops over a list', times: 'Loops that repeat n times', for: 'Other loops', while: 'While loops',
  if: 'Conditions', elif: 'Else-if conditions', else: 'Else', with: 'With blocks', try: 'Try blocks', except: 'Except blocks', finally: 'Finally blocks',
};

/**
 * What an updater does, from the function it is given: lambda m: m.move_to(axes.i2gp(t.get_value(), graph)) is
 * “keeps moving to graph at t”; always_redraw is “redrawn every frame”.
 */
export function updaterWords(what: string, code: string, b: Book = book()): { text: string; key: PhraseKey } {
  if (what !== '.add_updater(…)') return { text: fill(b.updaters.always_redraw, { pos: [], kw: {} }, b), key: { section: 'updaters', key: 'always_redraw', what: 'Redrawn every frame' } };
  const m = code.replace(/\s+/g, ' ').match(/^lambda (\w+)(?:, *\w+)? *: *\1\.(\w+)\((.*)\)$/);
  const call = m && parseChain(`.${m[2]}(${m[3]})`)?.length === 1 ? { name: m[2], args: m[3] } : null;
  if (call && b.updaters[call.name] !== undefined)
    return { text: fill(b.updaters[call.name], argsOf(call.args), b), key: { section: 'updaters', key: call.name, what: `Updaters that call .${call.name}(…)` } };
  return { text: fill(b.updaters.other, { pos: [], kw: {} }, b), key: { section: 'updaters', key: 'other', what: 'Other updaters' } };
}

/** The placeholders a clip's entries can use, with this clip's values: [“{1}”, “axes”]. */
export function placeholdersOf(a: Anim | null, s: Step | null): [string, string][] {
  const out: [string, string][] = [];
  const add = (args: Args) => {
    args.pos.forEach((v, i) => out.push([`{${i + 1}}`, v]));
    for (const [k, v] of Object.entries(args.kw)) out.push([`{${k}}`, v]);
  };
  if (a && a.cls === 'animate') for (const c of parseChain(a.chain ?? '') ?? []) add(argsOf(c.args));
  else if (a && a.cls !== 'expr') add(animArgs(a));
  if (s?.kind === 'apply') for (const c of parseChain(s.chain ?? '') ?? []) add(argsOf(c.args));
  if (s?.kind === 'assign') out.push(['{value}', s.value ?? '']);
  if (s?.kind === 'block') {
    if (s.repeat) {
      for (const k of ['var', 'from', 'to', 'each'] as const) if (s.repeat[k] !== undefined) out.push([`{${k}}`, String(s.repeat[k])]);
    } else out.push(['{var} {iter} {n} {cond}', (s.head ?? '').trim()]);
  }
  return out;
}
